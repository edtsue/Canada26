import Anthropic from "@anthropic-ai/sdk";
import { createRateLimiter } from "../lib/ratelimit.js";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

const rateLimit = createRateLimiter({ max: 30, windowMs: 60 * 60 * 1000 });

const SYSTEM_PROMPT = `You are a local-savvy friend writing family-travel tips for a parent traveling with an 11-year-old daughter through Montréal and Québec City (June 20-25, 2026). They're on foot + public transit.

For each tip bucket:
- 🍬 TREATS: sweets, snacks, and iconic local food a kid will love — poutine, maple taffy, BeaverTails, Montréal bagels, hot chocolate, candy shops. Casual and walk-in friendly.
- 🔬 HANDS-ON: hands-on science, interactive museums, planetariums, and active outdoor things (observation wheels, the funicular, Montmorency Falls, parks) — stuff an 11-yo can DO, not just look at.
- 🧸 SHOPPING: toy stores, bookshops, board-game shops, candy emporiums (Benjo!), and fun markets. Toy + book heavy.

Return ONLY valid JSON in this shape (no markdown):
{
  "tips": [
    { "bucket": "treats" | "hands-on" | "shopping", "title": string, "body": string (1-2 sentences, vivid and specific), "address": string | null, "neighborhood": string | null, "url": string | null }
  ]
}

Return EXACTLY 3 tips per requested bucket unless the user's interest profile excludes a bucket — then skip it.

Make tips concrete: name the place, the neighborhood, what to order or look for. Avoid hedging ("might be nice"). Write like a friend texting you a tip. Keep everything kid-appropriate, walkable, and weather-aware (June can rain).

QUALITY BAR: prefer well-loved, established, kid-friendly spots (4.3+ on Google Maps or a clear local institution). Skip anything fussy or not fun for an 11-year-old.`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function tryParseJSON(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const raw = fenced ? fenced[1] : text;
  try {
    return JSON.parse(raw);
  } catch {
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s !== -1 && e !== -1) {
      try {
        return JSON.parse(raw.slice(s, e + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
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

  const { city, date, interests, context } = body || {};
  if (!city) {
    return res.status(400).json({ ok: false, error: "missing_city" });
  }

  const activeBuckets =
    Array.isArray(interests) && interests.length
      ? interests.filter((i) => ["treats", "hands-on", "shopping"].includes(i))
      : ["treats", "hands-on", "shopping"];

  const userMessage = `City: ${city}
Date: ${date || "unspecified"}
Active tip buckets: ${activeBuckets.join(", ")}
${context ? `\nWhat's already planned for that day:\n${context}` : ""}

Give me 3 tips per active bucket, tailored to a parent + an 11-year-old walking around ${city}.`;

  const client = new Anthropic({ apiKey: (process.env.CLAUDE_API || process.env.ANTHROPIC_API_KEY) });

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1800,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: userMessage }],
    });

    const textOut = resp.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const parsed = tryParseJSON(textOut);
    if (!parsed || !Array.isArray(parsed.tips)) {
      return res.status(200).json({ ok: false, error: "could_not_parse", raw: textOut.slice(0, 800) });
    }

    const tips = parsed.tips
      .filter((t) => t && activeBuckets.includes(t.bucket) && t.title && t.body)
      .map((t) => ({
        bucket: t.bucket,
        title: String(t.title).slice(0, 120),
        body: String(t.body).slice(0, 400),
        address: t.address || null,
        neighborhood: t.neighborhood || null,
        url: t.url || null,
      }));

    return res.status(200).json({ ok: true, tips });
  } catch (err) {
    const status = err?.status || 500;
    return res.status(status).json({ ok: false, error: err?.message || "anthropic_error" });
  }
}
