/**
 * probe-endpoints.js — read the shape of the endpoints not yet wired up.
 *
 * Same discipline as probe-factors.js: their gateway returns HTTP 200 for
 * unknown routes with the real status buried in the body, so nothing here
 * trusts a status code. Content is what decides.
 *
 *   $env:TENNIS_API_KEY = "<key>"
 *   node probe-endpoints.js
 */
const KEY = process.env.TENNIS_API_KEY;
const BASE = 'https://api.sportsapi365.com/v1/tennis';

// Fill these from a CURRENT fixture before running — stale ids return
// empty bodies that look identical to unsupported endpoints.
const EVENT_ID = process.env.PROBE_EVENT_ID || '3845592';
const P1_ID    = process.env.PROBE_P1_ID    || '29932';   // Fritz
const P2_ID    = process.env.PROBE_P2_ID    || '56846';   // Nakashima
const P1_NAME  = 'Taylor Fritz';
const TOUR_NAME = process.env.PROBE_TOURNAMENT || 'cincinnati';
const YEAR     = new Date().getFullYear();

const targets = [
  // --- THE PHOTO QUESTION -------------------------------------------
  // If this returns an image URL, player imagery becomes available under
  // the existing subscription rather than scraped from a rights-holder.
  // Tennis has no teams, so "teamId" is almost certainly the player id.
  ['team-logo (player id)',   `/profile/team-logo/${P1_ID}`],
  ['player profile',          `/atp/player/profile/${P1_id_or(P1_ID)}`],
  ['profile by name',         `/profile/${encodeURIComponent(P1_NAME)}`],
  ['countries',               `/countries`],

  // --- LINE SHOPPING ON LOWER TIERS ---------------------------------
  // pre-match gives one price. This is the multi-book view, and it is the
  // only route to best-price on Challenger/ITF, which The Odds API does
  // not carry at all.
  ['odds compare (multibook)', `/extend/api/odds/compare/${EVENT_ID}`],
  ['odds summary',             `/extend/api/odds/summary/${EVENT_ID}`],
  ['odds arbitrage',           `/extend/api/odds/arbitrage/${EVENT_ID}?market_id=1`],
  ['recent odds',              `/extend/api/event/recent-odds/get/${EVENT_ID}`],

  // --- FACTORS CURRENTLY LEFT TO WEB SEARCH -------------------------
  ['surface summary',         `/atp/player/surface-summary/${P1_ID}`],
  ['h2h surface breakdown',   `/h2h/surfaceBreakdown/atp/${encodeURIComponent(P1_NAME)}`],
  ['h2h recent form',         `/h2h/recent/atp/${encodeURIComponent(P1_NAME)}`],
  ['h2h rivalries',           `/h2h/rivalries/atp/${encodeURIComponent(P1_NAME)}`],
  ['last match played',       `/h2h/last-match-played/atp/${encodeURIComponent(P1_NAME)}`],
  ['player status (injury?)', `/profile/${encodeURIComponent(P1_NAME)}/player-status`],

  // --- DRAW CONTEXT: a factor nobody else has ------------------------
  // Seeds and draws give draw-side difficulty and who is waiting in the
  // next round — the "looking ahead / trap match" read.
  ['tournament seeds',        `/tournament/atp/${TOUR_NAME}/seeds`],
  ['tournament draws',        `/tournament/atp/${TOUR_NAME}/${YEAR}/draws`],
  ['potential fixtures',      `/potential-fixtures/atp/player/${encodeURIComponent(P1_NAME)}`],

  // --- LIVE DETAIL ---------------------------------------------------
  ['event timeline',          `/extend/api/event/timeline/${EVENT_ID}`],
  ['live score',              `/extend/api/live-score/get/${EVENT_ID}`],

  // --- BENCHMARK ONLY, NOT A FACTOR (see notes below) ---------------
  ['their match prediction',  `/upcoming/match-prediction/atp/${P1_ID}/${P2_ID}`],
];

function P1_id_or(v) { return v; }

/** Structure, not content — enough to write a parser against. */
function shape(v, depth = 0) {
  const pad = '  '.repeat(depth + 1);
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}[] (empty)`;
    return `${pad}[${v.length} items] first:\n` + shape(v[0], depth + 1);
  }
  if (v && typeof v === 'object') {
    return Object.entries(v).slice(0, 16).map(([k, val]) => {
      if (val && typeof val === 'object') return `${pad}${k}:\n${shape(val, depth + 1)}`;
      const s = String(val);
      // Flag anything that looks like an image URL loudly — that is the
      // single most valuable thing this probe could turn up.
      const img = /\.(png|jpg|jpeg|webp|svg)|image|photo|logo|avatar/i.test(k + s) ? '   <-- IMAGE?' : '';
      return `${pad}${k}: ${s.length > 60 ? s.slice(0, 60) + '...' : s}${img}`;
    }).join('\n');
  }
  return `${pad}${String(v).slice(0, 80)}`;
}

(async () => {
  if (!KEY) { console.error('TENNIS_API_KEY not set'); process.exit(1); }

  for (const [label, path] of targets) {
    try {
      const res = await fetch(BASE + path, { headers: { 'X-Gravitee-Api-Key': KEY } });
      const ct = res.headers.get('content-type') || '';

      // An image endpoint may return bytes rather than JSON — that is a
      // success, not a parse failure, so check before reading as text.
      if (/^image\//.test(ct)) {
        console.log(`\n### ${label}  [${path}]\n  BINARY IMAGE — ${ct}, ${res.headers.get('content-length') || '?'} bytes`);
        continue;
      }

      const text = await res.text();
      let body;
      try { body = JSON.parse(text); }
      catch { console.log(`\n### ${label}\n  NON-JSON (${ct}): ${text.slice(0, 140)}`); continue; }

      // Status is unreliable here; the body carries the truth.
      const failed = body?.error || body?.success === false || body?.statusCode >= 400 ||
                     /not found|no odds|unauthor|forbidden|not subscribed/i.test(JSON.stringify(body).slice(0, 300));
      if (failed) { console.log(`\n### ${label}  [${path}]\n  UNAVAILABLE: ${JSON.stringify(body).slice(0, 180)}`); continue; }

      console.log(`\n### ${label}  [${path}]`);
      console.log(shape(body));
    } catch (e) {
      console.log(`\n### ${label}\n  FAILED: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 220)); // stay inside the rate limit
  }
  console.log('\n--- done ---');
})();
