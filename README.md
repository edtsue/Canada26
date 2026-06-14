# Canada26 — Montréal & Québec City family trip hub

A phone-first, single-file web app for a parent + 11-year-old trip:
**New York → Montréal → Québec City → home** (Jun 20–25, 2026).

- Day-by-day itinerary + color-coded calendar
- City guides: toy & book shops, treats, hands-on museums, walking routes
- Notes: packing & pre-trip checklists, time-critical bookings, French phrases
- Live weather per city, offline PWA, password gate
- **Claude AI** features: 🤖 Ask concierge, ✨ More tips, and "Change plan from here"

## Stack
- `index.html` — the entire app (vanilla JS, Tailwind CDN, Supabase JS CDN). State in `localStorage` (`CANADA26_TRIP_HUB`), optionally synced to Supabase.
- `api/ask.js`, `api/tips.js`, `api/replan.js` — Claude serverless functions.
- `api/gate.js` + `middleware.js` + `lib/ratelimit.js` — shared-password gate + rate limiting.
- `gate.html`, `sw.js`, `manifest.webmanifest`, icons — PWA shell.

## Deploy (GitHub → Vercel)
Push to `main` = prod. Set these env vars in the Vercel dashboard:

| Env var | Used by | Notes |
|---|---|---|
| `CLAUDE_API` | ask / tips / replan | Anthropic API key (also accepts `ANTHROPIC_API_KEY`) |
| `GATE_PASSWORD` | gate / middleware | Shared password for the app |

Models: chat = `claude-haiku-4-5`, tips/replan = `claude-sonnet-4-6` (override via `ANTHROPIC_MODEL`).

## Supabase note
Cloud sync (magic-link) is wired to a dedicated **`canada_trip_state`** table in the
shared `dxrqgnvnkwffnhyzngii` project — RLS-locked to `user_id == auth.uid()`, so it
never collides with the Berlin app's `trip_state`. The app also works fully offline on
`localStorage` (`CANADA26_TRIP_HUB`); sign in only when you want cross-device sync.

*Repurposed from DEsolo26 for a NYC → Montréal → Québec City family trip.*
