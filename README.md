# Match Point Backend

Auth, Stripe billing, and the sports data/model pipeline behind the Match
Point frontend pages. This is real, runnable code — but it needs your own
infrastructure and API keys to actually go live. Nothing here is deployed or
running anywhere yet.

## What's in here

```
prisma/schema.prisma   Database schema (users, subscriptions, matches, picks, results)
src/server.js          Express app entry point
src/routes/auth.js     Signup / login / current-user
src/routes/checkout.js Stripe Checkout session creation
src/routes/webhooks.js Stripe webhook handler (payments -> database)
src/routes/picks.js    API the frontend calls for today's/live picks + archive
src/pipeline/fetchMatches.js  Sports data provider adapter (NEEDS a real API key)
src/pipeline/scoreModel.js    The model's scoring logic (needs backtesting/tuning)
src/pipeline/cron.js          Ties fetch + score + database together, runs on a schedule
```

## Before this can go live, you need

1. **A Postgres database.** Railway, Render, Supabase, and Neon all have free
   or cheap tiers to start on.
2. **A Stripe account**, in live mode, with your business verified. Create
   three Products/Prices in the Stripe dashboard (single pick, daily/weekly
   bundle, monthly/season membership) and put their price IDs in `.env`.
   Note: sports-picks businesses can get extra scrutiny from Stripe's
   underwriting since it's gambling-adjacent — worth confirming your account
   is approved before building further on top of it.
3. **A sports data/odds provider API key.** `fetchMatches.js` is written
   against a generic odds-API shape — you'll need to sign up for one (The
   Odds API is the simplest to start with) and adjust the field mapping in
   that file to match what they actually return.
4. **Hosting** for this backend — Railway, Render, and Fly.io all work fine
   for a small Node/Express app like this.
5. **Real Terms of Service and Privacy Policy**, and a look at whether
   selling sports predictions is restricted in any states you'll operate in.
   This isn't legal advice — worth a real conversation with a lawyer given
   the gambling-adjacent nature of the business.

## Local setup

```bash
npm install
cp .env.example .env
# fill in .env with real values

npx prisma migrate dev --name init
npm run dev          # starts the API server on :4000
npm run pipeline      # runs the data pipeline once, manually
```

## What's real vs. what's a placeholder

**Real and complete:**
- Auth (signup/login/JWT), password hashing
- Database schema for users, subscriptions, matches, picks, results
- Stripe Checkout session creation for both one-off picks and subscriptions
- Stripe webhook handling that reconciles payments into the database
- API endpoints the frontend needs (today's picks, live picks, pick detail
  gated by purchase/subscription, results archive)
- The model's scoring *structure* — weighted factors combining into a 0-100
  confidence rating, split into Model's Picks vs. Winner Picks

**Placeholder — needs your input to finish:**
- `fetchMatches.js` — wired for a generic odds API shape, not a real
  provider. Needs your actual API key and field mapping.
- The qualitative factors that feed `scoreModel.js` (surface fit, injury
  reports, weather, etc.) — the pipeline currently stubs these at neutral
  (0) for every match, so confidence will sit flat at 50 until real
  per-sport data sources are connected to compute them.
- The model's weights (`WEIGHTS` in `scoreModel.js`) are a reasonable
  starting structure, not a backtested strategy. Before this runs for real
  money, they should be validated against historical results.
- Live in-play score/odds updates — the schema supports it (`liveScore`,
  `liveClock` on `Match`), but the pipeline only polls pre-game odds right
  now. A live poller would need a provider that supports in-play data.

## Connecting the frontend

The HTML pages built earlier (`match-point.html`, `all-matches.html`,
`live-picks.html`, `checkout.html`, `account.html`, etc.) currently use
hardcoded sample data and `localStorage`-free in-memory state. To connect
them to this backend: replace the hardcoded arrays in each page's `<script>`
with `fetch()` calls to this API's endpoints (`/api/picks/today`,
`/api/picks/live`, `/checkout/session`, `/auth/login`, etc.), and store the
JWT from login in memory (not localStorage, since these are static files with
no build step — a small session-handling script would need to be added).
