import Anthropic from "@anthropic-ai/sdk";
import { createRateLimiter } from "../lib/ratelimit.js";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

const rateLimit = createRateLimiter({ max: 40, windowMs: 60 * 60 * 1000 });
const MAX_TURNS = 6; // hard cap on assistant turns; on turn 6 the tool call is forced

const SYSTEM_PROMPT = `You help a parent (traveling with an 11-year-old daughter) revise a 6-day Montréal + Québec City trip (June 20-25, 2026), ending with a flight home from Québec City (YQB) on Day 6 / 2026-06-25.

The trip already has curated, kid-friendly content per day. The user wants to change starting from a specific day. Your job: gather just enough information through focused questions, then produce a replacement plan for the affected days.

## Hard constraints
- The trip stays Jun 20 – Jun 25 (6 days). You CANNOT add or remove days. Only the day's city/title/prose/destinations within those fixed dates.
- Days 1–3 (Jun 20–22) are in Montréal; Day 4 (Jun 23) is the VIA Rail train Montréal → Québec City; Days 5–6 (Jun 24–25) are in Québec City. Keep the train on Day 4 and keep them in Québec City for the last two nights unless they explicitly ask otherwise.
- Day 6 (Jun 25) is the flight home from Québec City. Do not change Day 6's departure.

## Conversation rules
- Be concise. One short question per turn. Never ramble.
- First question: ALWAYS establish cascade scope. Ask whether they want to change just the one day, or replan from that day onward through the rest of the trip.
- Total questions: 3-5 maximum. On turn ${MAX_TURNS} you MUST call the present_plan tool regardless of remaining ambiguity — make best-judgment calls.
- Keep the family in mind: a parent + an 11-year-old who loves toy & book shops, sweets/treats, hands-on science museums, and things you can't see in NYC. Favor walkable, kid-friendly, weather-aware picks (June can rain). Everything must be appropriate and fun for an 11-year-old.

## When you have enough info
Call the \`present_plan\` tool. Populate every field for every changed day:
- city, flag (single emoji), title (short human label), phase (one of montreal/quebec/departure — pick the closest match).
- am, pm: 2-3 sentence prose blocks matching the existing voice (specific places, the kid angle, the vibe).
- transit: 1-2 sentence transit guidance (métro / walk / funicular / VIA Rail).
- sleep: hotel hint or "to book" if not specified.
- destinations: 4-6 entries with name, url (real website if known, else omit), note (1-2 sentence why-go with a kid angle).
- soloTip: { bucket: 'treats' | 'hands-on' | 'shopping', title, body }.

For days within the cascade where the CITY stays the same as the curated plan, omit them from the output (we'll keep the curated version). Only include days whose city/title/prose you're actually rewriting.

Return ONLY the tool call when you present_plan — no accompanying text.`;

const PRESENT_PLAN_TOOL = {
  name: "present_plan",
  description: "Present the replanned days to the user for review.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "1-2 sentence summary of what's changing." },
      cascade_explanation: { type: "string", description: "How far the cascade goes and why." },
      days: {
        type: "array",
        items: {
          type: "object",
          properties: {
            day: { type: "number" },
            city: { type: "string" },
            flag: { type: "string" },
            phase: { type: "string", enum: ["montreal", "quebec", "departure"] },
            title: { type: "string" },
            am: { type: "string" },
            pm: { type: "string" },
            transit: { type: "string" },
            sleep: { type: "string" },
            destinations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  url: { type: "string" },
                  note: { type: "string" }
                },
                required: ["name", "note"]
              }
            },
            soloTip: {
              type: "object",
              properties: {
                bucket: { type: "string", enum: ["treats", "hands-on", "shopping"] },
                title: { type: "string" },
                body: { type: "string" }
              },
              required: ["bucket", "title", "body"]
            }
          },
          required: ["day", "city", "title", "am", "pm", "transit", "sleep"]
        }
      }
    },
    required: ["summary", "days"]
  }
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function buildTripContext(trip, fromDay) {
  if (!Array.isArray(trip) || !trip.length) return "Trip data unavailable.";
  const lines = trip.map(d => {
    const marker = d.day >= fromDay ? "▶" : " ";
    return `${marker} Day ${d.day} (${d.date}, ${d.weekday}): ${d.city} — ${d.title}`;
  });
  return `Current itinerary (▶ = from the change-point onward):\n${lines.join("\n")}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  const rl = rateLimit(req);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    return res.status(429).json({ ok: false, error: "rate_limited", retryAfter: rl.retryAfter });
  }
  if (!(process.env.CLAUDE_API || process.env.ANTHROPIC_API_KEY)) {
    return res.status(500).json({ ok: false, error: "missing_api_key" });
  }

  let body;
  try {
    if (req.body) {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } else {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    }
  } catch {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }

  const { messages, fromDayNumber, trip } = body || {};
  if (!Array.isArray(messages) || typeof fromDayNumber !== "number") {
    return res.status(400).json({ ok: false, error: "missing_fields" });
  }
  if (fromDayNumber < 4) {
    return res.status(400).json({ ok: false, error: "montreal_days_locked" });
  }

  // Count assistant turns so we can force the tool call when we hit the cap.
  const assistantTurns = messages.filter(m => m.role === "assistant").length;
  const forceTool = assistantTurns >= MAX_TURNS - 1;

  const tripContext = buildTripContext(trip, fromDayNumber);
  const systemBlocks = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: `${tripContext}\n\nThe user wants to change starting from Day ${fromDayNumber}.${forceTool ? "\n\nYou have reached the question limit. Call present_plan now with best-judgment defaults; do not ask more questions." : ""}` },
  ];

  const client = new Anthropic({ apiKey: (process.env.CLAUDE_API || process.env.ANTHROPIC_API_KEY) });
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 3000,
      system: systemBlocks,
      tools: [PRESENT_PLAN_TOOL],
      tool_choice: forceTool ? { type: "tool", name: "present_plan" } : { type: "auto" },
      messages,
    });

    // Walk the response content for either a text question or a present_plan tool_use.
    let text = "";
    let plan = null;
    for (const block of resp.content) {
      if (block.type === "text") text += (text ? "\n" : "") + block.text;
      if (block.type === "tool_use" && block.name === "present_plan") plan = block.input;
    }
    if (plan) {
      return res.status(200).json({ ok: true, complete: true, plan });
    }
    return res.status(200).json({ ok: true, complete: false, message: text || "(no response)" });
  } catch (err) {
    const status = err?.status || 500;
    return res.status(status).json({ ok: false, error: err?.message || "anthropic_error" });
  }
}
