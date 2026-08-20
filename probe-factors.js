/**
 * probe-factors.js — capture the real shape of every factor endpoint.
 *
 * Run once, paste the output back. Writing parsers against guessed shapes
 * is what produced the last several bugs; this reads the actual responses
 * first so the integration can be written correctly in one pass.
 *
 *   $env:TENNIS_API_KEY = "<key>"
 *   node probe-factors.js
 */
const KEY = process.env.TENNIS_API_KEY;
const BASE = 'https://api.sportsapi365.com/v1/tennis';

// A real, current fixture: Fritz vs Nakashima, Cincinnati, round 9.
const P1_ID = 29932, P2_ID = 56846, TOUR_ID = 21347, ROUND = 9;
const P1 = 'Taylor Fritz', P2 = 'Brandon Nakashima';
const EVENT_ID = '3845592';

const targets = [
  ['H2H stats',            `/h2h/stats/atp/${encodeURIComponent(P1)}/${encodeURIComponent(P2)}`],
  ['H2H surface split',    `/h2h/surfaceBreakdown/atp/${encodeURIComponent(P1)}`],
  ['H2H recent form',      `/h2h/recent/atp/${encodeURIComponent(P1)}`],
  ['Surface summary',      `/atp/player/surface-summary/${P1_ID}`],
  ['Tournament record',    `/atp/player/tournament-record/${P1_ID}/${TOUR_ID}`],
  ['Past matches',         `/atp/player/past-matches/${P1_ID}`],
  ['Ranking history',      `/ranking/atp/player/${P1_ID}/history`],
  ['Perf breakdown',       `/atp/player/perf-breakdown/${P1_ID}`],
  ['Odds movements',       `/extend/api/odds/biggest-movements/${EVENT_ID}?market_id=1`],
  ['Odds last-10 moves',   `/extend/api/odds/summary/movements/last-10/${EVENT_ID}`],
  ['Odds compare',         `/extend/api/odds/compare/${EVENT_ID}`],
];

/** Print structure, not full content — enough to write a parser from. */
function shape(v, depth = 0, path = '') {
  const pad = '  '.repeat(depth + 1);
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}[] (empty)`;
    return `${pad}[${v.length} items] first:\n` + shape(v[0], depth + 1);
  }
  if (v && typeof v === 'object') {
    return Object.entries(v).slice(0, 14).map(([k, val]) => {
      if (val && typeof val === 'object') return `${pad}${k}:\n${shape(val, depth + 1)}`;
      const s = String(val);
      return `${pad}${k}: ${s.length > 40 ? s.slice(0, 40) + '...' : s}`;
    }).join('\n');
  }
  return `${pad}${String(v).slice(0, 60)}`;
}

(async () => {
  if (!KEY) { console.error('TENNIS_API_KEY not set'); process.exit(1); }
  for (const [label, path] of targets) {
    try {
      const res = await fetch(BASE + path, { headers: { 'X-Gravitee-Api-Key': KEY } });
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { console.log(`\n### ${label}\n  NON-JSON: ${text.slice(0, 120)}`); continue; }

      const err = body?.error || body?.success === false || (body?.statusCode >= 400);
      if (err) { console.log(`\n### ${label}\n  ERROR: ${JSON.stringify(body).slice(0, 160)}`); continue; }

      console.log(`\n### ${label}  [${path}]`);
      console.log(shape(body));
    } catch (e) {
      console.log(`\n### ${label}\n  FAILED: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 200)); // stay well inside the rate limit
  }
  console.log('\n--- done ---');
})();
