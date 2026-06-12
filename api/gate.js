import crypto from "crypto";
import { createRateLimiter } from "../lib/ratelimit.js";

// The only truly public endpoint (in middleware SKIP_PATHS), so this limiter is
// the brute-force throttle on the gate password. Tightest budget of the five.
const rateLimit = createRateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function hmacB64Url(secret, msg) {
  return crypto.createHmac("sha256", secret).update(msg).digest("base64url");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  const rl = rateLimit(req);
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    return res.status(429).json({ ok: false, error: "too_many_attempts", retryAfter: rl.retryAfter });
  }

  const expected = process.env.GATE_PASSWORD;
  if (!expected) {
    return res.status(500).json({ ok: false, error: "gate_not_configured" });
  }

  let body;
  try {
    if (req.body) body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    else body = JSON.parse(await readBody(req));
  } catch {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }

  const provided = String(body?.password || "");
  // Constant-time compare. timingSafeEqual requires equal-length buffers — length-check first.
  let okPw = false;
  if (provided.length === expected.length) {
    try {
      okPw = crypto.timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
    } catch { okPw = false; }
  }
  if (!okPw) {
    return res.status(401).json({ ok: false, error: "invalid_password" });
  }

  const remember = !!body.remember;
  // Remember-me = 14 days. Otherwise = 12h session-ish (short enough to feel safe on shared devices,
  // long enough to survive a coffee break without re-typing).
  const ttlMs = remember ? 14 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
  const expiry = Date.now() + ttlMs;
  const sig = hmacB64Url(expected, String(expiry));
  const token = `${expiry}.${sig}`;
  const maxAge = Math.floor(ttlMs / 1000);
  const cookie = `desolo26_gate=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
  res.setHeader("Set-Cookie", cookie);
  return res.status(200).json({ ok: true, expires: expiry, remember });
}
