# HLD Design Simulator

Practice system-design interviews by building an architecture, estimating load, and watching a
deterministic traffic simulation show where it breaks.

* **Guided interview mode**: 10 steps from requirements to trade-off review, with hints on request.
* **Free-form lab**: drag 16 component types onto a canvas, connect them, configure them, run traffic.
  Size machines by **vCPU, RAM and disk** (capacity is calculated, with the formula shown), or type
  throughput manually. Every input has a **?** explaining it. Draw **response paths** back to the
  client to see successful responses and bandwidth.
* **Back-of-the-envelope calculator**: formulas with substituted values; estimate first, then reveal.
* **Simulation**: request flow, utilization, queues, latency, cache hits/misses, failures, rate limiting.
* **Experiments**: snapshot designs and compare before/after (throughput, latency, DB load, errors,
  cost, availability) with explanations of why a change helped and what it costs.
* **Review**: rule-based evaluation across 12 interview criteria; reference solution unlocks after an attempt.
* **10 challenges**: URL Shortener (fully tuned), Pastebin, Rate Limiter, Notification Service,
  Chat, News Feed, Video Streaming, Ride-Sharing, File Storage, Job Scheduler.

The simulation model and every assumption are documented in [MODEL.md](MODEL.md).

## Run locally

```bash
npm install
npm run dev
```

Tests (calculator + simulation engine):

```bash
npm test
```

## Deploy to Vercel

This is a static SPA, so no server or database is needed.

1. Push this `web/` folder to a GitHub repo (or set **Root Directory** to `web` if it is a subfolder).
2. Import it in Vercel. `vercel.json` sets the Vite build, `dist` output and SPA rewrites.

Or with the CLI from this folder:

```bash
npx vercel --prod
```

## Persistence

Designs, experiments, notes and challenge progress are saved in the browser's localStorage
(`src/ui/storage.ts`). Each person's data stays in their own browser. Use **⋯ → Export / Import** to
back up or move data between machines.

This fits a handful of users. If you later want shared, server-side storage, implement the
`WorkspaceStore` interface in `src/ui/storage.ts` against a Vercel Function backed by Postgres
(e.g. Neon). The UI does not need to change.

## Stack & deviations from the original brief

React 19 + TypeScript + Vite, `@xyflow/react` canvas, Tailwind CSS v4, Recharts, Vitest.

The brief suggested a Java/Spring Boot + PostgreSQL backend. It was dropped because the app must
deploy on Vercel for under 5 users: Vercel can't host a long-running Spring Boot server, and the
simulation is pure TypeScript (`src/engine/`, no React imports), so it runs instantly in the browser
and is unit-tested in isolation.

## Layout

```
src/engine/     calculator, simulator, analysis (pure TS, tested)
src/data/       challenge library
src/ui/         canvas, panels, state, storage
```
