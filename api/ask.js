import Anthropic from "@anthropic-ai/sdk";
import { createRateLimiter } from "../lib/ratelimit.js";

// Haiku 4.5 is the right tier for chat-style trip Q&A: fast, cheap, and world-knowledge
// is more than enough for "kid-friendly poutine near Old Montréal" / "what to do if it
// rains in Québec City" asks. Override via env if the deployer wants a beefier model.
const MODEL = process.env.ANTHROPIC_MODEL || process.env.ASK_MODEL || "claude-haiku-4-5-20251001";

const rateLimit = createRateLimiter({ max: 60, windowMs: 60 * 60 * 1000 });

// Static persona/style block — first cache breakpoint. Rarely changes.
const PERSONA_AND_STYLE = `You are a friendly, fast travel concierge embedded in a family trip-planner app. The trip is a parent traveling with an 11-year-old daughter through Montréal and Québec City (June 20–25, 2026: 3 nights in Montréal, a VIA Rail train on June 23, then 2 nights in Québec City). They're on foot + public transit, staying central in each city.

The user's actual itinerary, confirmed bookings, outstanding bookings, and profile are provided in the next system block — use them. Don't invent dates, hotels, or train times that aren't there.

Profile baseline:
- Parent + an 11-year-old who loves toy & book shopping, sweets/treats, hands-on science museums, and things you can't see in NYC (e.g. Montréal's Underground City, Québec's funicular and old town).
- Favor walkable, kid-friendly, weather-aware picks — June can bring rain, so keep an indoor backup ready.
- Both cities are bilingual; default to English but a little French is welcome.
- Avoid: anything not appropriate or fun for a kid, long fancy tasting menus, generic tourist traps.

QUALITY BAR: For any restaurant, café, treat, or market recommendation, prefer well-loved, established, kid-friendly spots (think 4.3+ on Google Maps or a clear local institution). If a place is divisive or fussy for kids, suggest a better-fitting alternative.

Style:
- Be concrete: specific place names, the métro stop or walking time, and the kid angle.
- Be concise. Bullets when you have 3+ items; a short paragraph otherwise.
- Don't hedge. Don't repeat the question. Don't ask follow-ups unless truly needed to answer.
- If asked for tips, give 3-5 places max with one-line reasoning each.
- Reference the user's actual plan when relevant ("you're already near X on Day Y, so add Z nearby").
- Output is plain text (basic Markdown OK for bullets/bold/links/code, no top-level headers).`;

// Server-side formatter: turns the client state snapshot into a model-friendly Markdown block.
// Kept terse on purpose — verbose context slows generation and dilutes attention.
function formatTripContext(s) {
  if (!s) return "";
  const lines = [];
  if (Array.isArray(s.trip) && s.trip.length) {
    lines.push("# ITINERARY");
    for (const d of s.trip) {
      lines.push(`\n## Day ${d.day} · ${d.weekday || ""} ${d.date} · ${d.city}${d.sleep ? ` · 🛏 ${d.sleep}` : ""}`);
      if (d.am) lines.push(`AM: ${d.am}`);
      if (d.pm) lines.push(`PM: ${d.pm}`);
      if (d.transit) lines.push(`Transit: ${d.transit}`);
      if (Array.isArray(d.destinations) && d.destinations.length) {
        lines.push("Places: " + d.destinations.map((p) => p.name + (p.note ? ` (${p.note.slice(0, 80)})` : "")).join("; "));
      }
      if (d.soloTip && d.soloTip.title) {
        lines.push(`Family tip [${d.soloTip.bucket || "tip"}]: ${d.soloTip.title} — ${d.soloTip.body || ""}`);
      }
    }
  }
  if (Array.isArray(s.bookings) && s.bookings.length) {
    lines.push("\n# CONFIRMED BOOKINGS");
    for (const b of s.bookings) {
      const parts = [];
      if (b.kind) parts.push(`[${b.kind}]`);
      if (b.day != null) parts.push(`Day ${b.day}`);
      if (b.title) parts.push(b.title);
      if (b.vendor) parts.push(b.vendor);
      if (b.date) parts.push(`${b.date}${b.time ? " " + b.time : ""}`);
      if (b.endDate) parts.push(`→ ${b.endDate}${b.endTime ? " " + b.endTime : ""}`);
      if (b.confirmation) parts.push(`conf: ${b.confirmation}`);
      if (b.address) parts.push(`📍 ${b.address}`);
      lines.push("- " + parts.join(" · "));
    }
  }
  if (s.outstanding) {
    const o = s.outstanding;
    const any = (o.hotels?.length || o.trains?.length || o.timed?.length || o.reservations?.length);
    if (any) {
      lines.push("\n# NOT YET BOOKED");
      if (o.hotels?.length) lines.push("Hotels: " + o.hotels.join("; "));
      if (o.trains?.length) lines.push("Trains: " + o.trains.join("; "));
      if (o.timed?.length) lines.push("Timed entries: " + o.timed.join("; "));
      if (o.reservations?.length) lines.push("Reservations: " + o.reservations.join("; "));
    }
  }
  if (s.profile) {
    lines.push("\n# TRAVELER PROFILE");
    if (Array.isArray(s.profile.interests) && s.profile.interests.length) {
      lines.push("Interests: " + s.profile.interests.join(", "));
    }
    if (s.profile.bookingStyle) lines.push(s.profile.bookingStyle);
    if (s.profile.notes) lines.push(s.profile.notes);
  }
  return lines.join("\n");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
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

  // messages: full chat-style array (multi-turn).
  // today:    optional { day, city, date } — current Today-tab context.
  // appState: optional { trip, bookings, outstanding, profile } — full planner snapshot.
  const { messages, today, appState } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: "missing_messages" });
  }

  const contextLine = today && today.city
    ? `[Today in the app: Day ${today.day} · ${today.city}${today.date ? ` · ${today.date}` : ""}]\n`
    : `[Today in the app: pre-trip prep]\n`;

  const apiMessages = messages.map((m, i) => {
    if (i === 0 && m.role === "user") {
      return { role: "user", content: contextLine + (m.content || "") };
    }
    return { role: m.role, content: m.content || "" };
  });

  // Two cache breakpoints: persona (very stable) + trip context (changes only when the user
  // edits their plan or uploads a new booking). Anthropic uses the longest matching prefix,
  // so unchanged sessions get full cache hits.
  const tripContextText = formatTripContext(appState);
  const systemBlocks = [
    { type: "text", text: PERSONA_AND_STYLE, cache_control: { type: "ephemeral" } },
  ];
  if (tripContextText) {
    systemBlocks.push({ type: "text", text: tripContextText, cache_control: { type: "ephemeral" } });
  }

  const client = new Anthropic({ apiKey: (process.env.CLAUDE_API || process.env.ANTHROPIC_API_KEY) });

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: systemBlocks,
      messages: apiMessages,
    });
    const message = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return res.status(200).json({ ok: true, message });
  } catch (err) {
    const status = err?.status || 500;
    return res.status(status).json({ ok: false, error: err?.message || "anthropic_error" });
  }
}
