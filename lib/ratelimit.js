// Shared in-memory per-IP rate limiter for the API functions.
//
// Scope note: this is a PER-INSTANCE limiter. Vercel runs multiple warm
// instances and cold-starts reset the Map, so the effective ceiling is
// roughly (max × warm-instance count). That's intentional and proportionate
// here — the Claude endpoints sit behind the cookie gate, and /api/gate's
// real brute-force defense is GATE_PASSWORD entropy, not this counter.
//
// Two things this fixes over the old copy-pasted version:
//   1. IP source — keys on `x-real-ip` (set by Vercel's proxy, not client-
//      spoofable) instead of the leftmost x-forwarded-for value, which any
//      client can forge to mint a "new IP" per request and evade the limit.
//   2. Memory — sweeps stale IPs so the Map can't grow unbounded on a long-
//      lived warm instance.

// Pull the client IP from the most trustworthy source available.
// On Vercel Node functions `x-real-ip` is the proxy-determined client IP and
// cannot be overridden by the caller. We fall back to x-forwarded-for and the
// socket only for local dev / non-Vercel environments.
export function clientIp(req) {
  const h = req.headers || {};
  const real = first(h["x-real-ip"]);
  if (real) return real.trim();
  // Fallback only: leftmost XFF is spoofable, but better than nothing off-platform.
  const xff = first(h["x-forwarded-for"]);
  if (xff) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

// Create an isolated limiter. Each call owns its own Map, so endpoints with
// different limits never share or conflate counts.
//   createRateLimiter({ max: 20, windowMs: 3600_000 })
// Returns a function `(req) => ({ ok, retryAfter })` matching the old shape,
// so existing call sites keep working unchanged.
export function createRateLimiter({ max, windowMs }) {
  const hitsByIp = new Map();
  let callsSinceSweep = 0;

  return function rateLimit(req) {
    const ip = clientIp(req);
    const now = Date.now();

    // Opportunistic global sweep: every 256 calls, drop IPs whose most recent
    // hit has aged out of the window. Keeps memory bounded without paying an
    // O(n) cost on every request.
    if (++callsSinceSweep >= 256) {
      callsSinceSweep = 0;
      for (const [k, ts] of hitsByIp) {
        if (!ts.length || now - ts[ts.length - 1] >= windowMs) hitsByIp.delete(k);
      }
    }

    const hits = (hitsByIp.get(ip) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      return { ok: false, retryAfter: Math.ceil((hits[0] + windowMs - now) / 1000) };
    }
    hits.push(now);
    hitsByIp.set(ip, hits);
    return { ok: true };
  };
}
