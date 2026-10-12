# FMPI Engine — Financial Market Pressure Index

A dynamically calibrated momentum-pressure engine for the **NSE F&O universe, NIFTY and SENSEX**, built on genuine Upstox market data. FMPI is a bounded 0–100 pressure score with adaptive zones, turning-point detection, and continuation-vs-exhaustion classification — computed **only** on 5-minute and 10-minute candles.

> FMPI measures pressure, not probability. A high reading can persist through a strong uptrend and a low reading through a downtrend. Nothing here is a trade recommendation.

---

## Deploy to Render (one click, no migration step)

1. Push this repository to GitHub/GitLab.
2. In Render: **New → Blueprint → select the repo → Apply**.

`render.yaml` provisions everything:

| Resource | What it does |
|---|---|
| `fmpi-db` | Managed PostgreSQL (free plan, Singapore region) |
| `fmpi-engine` | Next.js web service, `npm ci && npm run build` → `npm run start` |
| `DATABASE_URL` | Injected automatically from the database |
| `/api/health` | Health check — also bootstraps the schema on first hit |

**No `drizzle-kit push` is needed.** The app creates its own tables idempotently (`src/db/bootstrap.ts`, all `CREATE TABLE IF NOT EXISTS`) the first time it touches the database, so a fresh deploy is self-healing. SSL is selected by host and can be overridden with `DATABASE_SSL`.

### Render database troubleshooting

If the UI reports a query failure after a deploy:

1. Open `https://YOUR-SERVICE.onrender.com/api/health`.
2. Inspect `database.status`, `database.host`, `database.ssl`, and the sanitized `database.error`.
3. In Render → web service → **Environment**, `DATABASE_URL` should be a database reference (`fromDatabase.connectionString`), not a manually copied old URL.
4. The web service and database must use the **same region**. The Blueprint sets both to Singapore.
5. Internal Render hosts look like `dpg-…-a` and must use `DATABASE_SSL=false`; external hosts ending `-postgres.render.com` require `DATABASE_SSL=true`.
6. Redeploy after correcting environment values.

PostgreSQL is a cache/audit/session store, **not the market-data source**. If it is unavailable, the app now opens a 30-second DB circuit breaker and continues loading genuine Upstox instruments and candles directly. `/api/health` remains HTTP 200 with `degraded: true` so Render does not restart-loop a usable market-data service. Daily login persistence and candle caching resume automatically when PostgreSQL recovers.

### Optional environment variables

| Key | Effect if absent |
|---|---|
| `UPSTOX_ACCESS_TOKEN` | Fallback only — normally you sign in from the UI. Without any token, Options Positioning (15% weight) is reported **MISSING** and its weight is renormalised |
| `FMPI_ADMIN_PASSCODE` | Sign-in/sign-out endpoints are unprotected. **Set this if the service is public** |
| `PGPOOL_MAX` | Defaults to 8 connections (blueprint sets 5 for the free tier) |

Candle, instrument-master and futures-OI data come from Upstox endpoints that need **no authentication**, so the deployment works out of the box.

---

## Daily Upstox sign-in

Upstox access tokens are day-scoped — every token dies at **03:30 IST** the next morning. The **LOGIN** button at the top-left of the header handles the daily refresh:

1. Click the button (it shows `SIGN IN`, your name, `EXPIRING`, or `EXPIRED`).
2. Paste the day's access token → **VERIFY & SAVE**.

What happens:

- The token is checked against the live Upstox **profile endpoint** before anything is stored — an invalid token is rejected and never saved.
- A valid token is persisted in Postgres, so it survives restarts and redeploys.
- The raw token is **never** returned to the browser; status responses carry only a masked form (`eyJ0••••.sig`).
- The header chip shows remaining validity and flips to `EXPIRED` after 03:30 IST, so you know when to re-authenticate.
- Signing in immediately reloads the series and activates **Options Positioning**; signing out removes the stored token.

Set `FMPI_ADMIN_PASSCODE` on any publicly reachable deployment — the dialog then requires it for both sign-in and sign-out.

### Other hosts

A multi-stage `Dockerfile` is included for Fly.io / Railway / Cloud Run / plain Docker. Only `DATABASE_URL` is required.

---

## Local development

```bash
npm install
cp .env.example .env     # point DATABASE_URL at your Postgres
npm run dev              # http://localhost:3000
```

Useful commands:

```bash
npm run build            # production build
npx vitest run           # 32 engine/unit tests
npx drizzle-kit push     # optional explicit schema push (not required)
```

---

## API (v1)

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/fmpi?instrument=NIFTY&tf=5m&sessions=14` | Full series: candles, FMPI points, dynamic zones, turning points, per-component evidence |
| `GET /api/v1/universe?q=reli` | Live F&O universe from the Upstox instrument master |
| `POST /api/v1/universe` | Force a universe re-sync |
| `GET /api/v1/scan?tf=5m` | Background momentum scanner (progressive coverage) |
| `GET/POST/DELETE /api/v1/auth/upstox` | Masked session status · verify & store a daily token · sign out |
| `GET /api/v1/top-movers?tf=5m&limit=10` | Top buying / selling pressure stocks ranked by FMPI |
| `POST /api/v1/replay` | No-repaint validator: prefix recomputation vs full series |
| `GET /api/health` | Liveness + schema bootstrap |

---

## How FMPI is computed

**Composite** — six direction-aware components, each normalised to `[-1, +1]`:

| Component | Weight | Unavailable when |
|---|---:|---|
| Price pressure & candle structure | 30% | never (core input) |
| Volume participation | 20% | exchange reports no volume (indices) |
| Futures positioning (price/OI/basis) | 20% | no aligned futures snapshot |
| Options positioning | 15% | no authenticated Upstox session |
| Support/resistance & price structure | 10% | warm-up |
| Acceleration & persistence | 5% | warm-up |

`C = Σwᵢsᵢ / Σwᵢ(available) × (0.55 + 0.45·coverage)` → `100·logistic(k·C)` blended 75/25 with the rolling percentile of `C` → causal EMA (α 0.30 for 5M, 0.26 for 10M). Missing components are renormalised and surfaced in the UI — **never replaced with zeros**.

**Dynamic zones** — rolling quantiles (q05/q15/q40/q60/q85/q95) over the instrument's own 240 most recent FMPI observations on that timeframe, EMA-stabilised and monotonically clamped. No fixed RSI-style 30/70 levels; live numeric ranges are displayed beside the chart.

**Turning points** — local extrema requiring 3 confirmation bars, a 3.2-point noise floor and 5.5-point prominence. Candidates render hollow; confirmation timestamps are never backdated.

**States** — 14 states spanning acceleration, continuation, momentum, exhaustion, reversal watch, neutral/choppy, transition, conflicting timeframes and insufficient data. Reversal watch requires corroborating divergence: an extreme reading alone never produces one.

---

## Data integrity guarantees

- 5M and 10M series are fetched natively on their own exchange grids (09:15 IST anchored) — never derived from one another.
- The still-forming candle is flagged `provisional` / **LIVE** and visually dashed.
- Price panel shows **spot** candles; the linked futures contract is drawn as a separate amber overlay with its basis, so the two are never confused.
- `POST /api/v1/replay` proves no repainting: recomputing on a prefix reproduces every historical value, zone boundary and state exactly (`maxValueDiff = 0`).
- Instruments with insufficient history show *warming up* rather than a fabricated number.

---

## Tests

```bash
npx vitest run
```

32 tests cover the math primitives, exchange session grid, component classification (long buildup / short buildup / short covering / long unwinding, missing-OI handling), composite bounds, prefix-invariance (no repaint), dynamic zone ordering, confirmation delay, and the rule that extreme FMPI never flips to the opposite-side state.
