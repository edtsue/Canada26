const CACHE = "canada26-v2";
const SHELL = ["/gate.html", "/icon.svg", "/icon-180.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then(async (c) => {
      // Static shell assets: all middleware-skipped, so they never redirect — safe to addAll.
      await c.addAll(SHELL);
      // Force-cache the main app page up front so it's guaranteed available offline, not
      // just lazily after a successful online navigation. Tolerate failure: if the gate
      // cookie is missing (302 → /gate.html) or we're offline, skip without failing install.
      try {
        const r = await fetch("/", { credentials: "same-origin" });
        if (r && r.ok && !r.redirected && r.status === 200) await c.put("/", r.clone());
      } catch {}
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never cache API or Supabase auth/data calls — always go to network.
  if (url.pathname.startsWith("/api/") || url.hostname.endsWith(".supabase.co")) return;

  // Network-first for the HTML shell so deploys roll out without a hard refresh.
  // IMPORTANT for the auth gate: don't cache redirected responses or non-200s. If the
  // middleware redirects to /gate.html (cookie expired), we want the browser to follow
  // that redirect every time, not serve stale unlocked content from cache.
  const isShell = req.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html";
  if (isShell) {
    e.respondWith(
      fetch(req)
        .then((r) => {
          if (r && r.ok && !r.redirected && r.status === 200) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return r;
        })
        // Offline: serve the exact cached page, else the cached app root (covers /?x and
        // /index.html style navigations), else the gate as a last resort.
        .catch(() =>
          caches.match(req)
            .then((r) => r || caches.match("/"))
            .then((r) => r || caches.match("/gate.html"))
        )
    );
    return;
  }

  // Cache-first with background refresh for everything else (fonts, Tailwind CDN, Supabase JS, etc.)
  e.respondWith(
    caches.match(req).then((cached) => {
      const fetchAndCache = fetch(req).then((r) => {
        if (r && r.status === 200 && r.type !== "opaqueredirect") {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return r;
      }).catch(() => cached);
      return cached || fetchAndCache;
    })
  );
});
