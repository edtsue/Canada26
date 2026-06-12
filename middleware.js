// Vercel Edge Middleware: gates every HTML response on a signed cookie.
// Without a valid cookie, GET /  → 302 to /gate.html, any /api/* (except /api/gate) → 401 JSON.

export const config = {
  // Match everything; we skip per-path inside the handler so it's easy to maintain.
  matcher: "/:path*",
};

const SKIP_PATHS = new Set([
  "/api/gate",
  "/gate.html",
  "/icon.svg",
  "/icon-180.png",
  "/manifest.webmanifest",
  "/sw.js",
  "/favicon.ico",
]);

export default async function middleware(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (SKIP_PATHS.has(path)) return;

  const secret = process.env.GATE_PASSWORD;
  // Fail safe: if the env var isn't configured, leave the app open. Logged so the
  // operator can spot it. Better than locking everyone out of a misconfigured deploy.
  if (!secret) {
    console.warn("GATE_PASSWORD not set — gate is disabled");
    return;
  }

  const cookieHeader = request.headers.get("cookie") || "";
  const token = parseCookie(cookieHeader, "desolo26_gate");
  if (await verifyToken(token, secret)) return;

  // Unauthed. APIs → JSON 401. Pages → redirect to the gate form.
  if (path.startsWith("/api/")) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return Response.redirect(new URL("/gate.html", url), 302);
}

function parseCookie(header, name) {
  const parts = header.split(";");
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    const k = p.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(p.slice(eq + 1).trim());
  }
  return null;
}

async function verifyToken(token, secret) {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expiryStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expiry = parseInt(expiryStr, 10);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;
  const expected = await hmacB64Url(secret, expiryStr);
  // Constant-time string compare to avoid trivial timing oracles.
  return constantTimeEq(sig, expected);
}

function constantTimeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmacB64Url(secret, msg) {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
