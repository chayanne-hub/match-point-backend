/**
 * fetchTennisApi.js — SportsAPI365 tennis client.
 *
 * Adds the tour levels The Odds API does not carry at all: ATP Challenger
 * and ITF. Verified live against the account:
 *
 *   Auth    X-Gravitee-Api-Key header (not Bearer, not x-api-key)
 *   Base    https://api.sportsapi365.com/v1/tennis
 *   Tiers   tournament.rankId -> 0 ITF, 1 Challenger, 3 main tour
 *   Dates   /{type}/fixtures/{YYYY-MM-DD} carries real UTC timestamps.
 *           The undated /{type}/fixtures does NOT — every date comes back
 *           null there, so always use the dated form.
 *   Tours   ITF comes through type=atp even though the docs say
 *           "itf is not supported as a type value".
 *
 * IMPORTANT — the gateway returns HTTP 200 for unknown routes and puts the
 * real status in the body. Status codes are therefore meaningless here and
 * every response must be validated on its content. That is exactly the
 * silent-failure shape that had the analysis pipeline skipping every live
 * match for hours, so it is handled explicitly below.
 */

const BASE = process.env.TENNIS_API_BASE || 'https://api.sportsapi365.com/v1/tennis';
const KEY = process.env.TENNIS_API_KEY || '';
const AUTH_HEADER = process.env.TENNIS_API_AUTH_HEADER || 'X-Gravitee-Api-Key';

const RANK = { 0: 'ITF', 1: 'Challenger', 2: 'ATP Tour', 3: 'ATP Masters/Slam' };

/** Tour levels to ingest. Defaults to Challenger + main tour: ITF is
 *  opt-in because it is the tier with the least research material and the
 *  worst integrity record, not because the data is missing. */
const TOUR_LEVELS = (process.env.TENNIS_TOUR_LEVELS || '1,2,3')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));

function assertConfigured() {
  if (!KEY) throw new Error('TENNIS_API_KEY is not set');
}

/**
 * One request. Throws on a body-level error even when the transport said
 * 200 — see the gateway note above.
 */
async function apiGet(path, { timeoutMs = 12000 } = {}) {
  assertConfigured();
  const url = `${BASE}/${String(path).replace(/^\/+/, '')}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res, text;
  try {
    res = await fetch(url, { headers: { [AUTH_HEADER]: KEY }, signal: ctrl.signal });
    text = await res.text();
  } catch (err) {
    throw new Error(`[tennisApi] ${path} request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`[tennisApi] ${path} returned non-JSON: ${text.slice(0, 120)}`);
  }

  // Body-level failure, regardless of what the HTTP status claimed.
  const bodyStatus = body && (body.statusCode || body.status);
  if (body?.error === true || body?.success === false || (bodyStatus && bodyStatus >= 400)) {
    throw new Error(`[tennisApi] ${path} -> ${bodyStatus || 'error'}: ${body.message || body.code || 'unknown'}`);
  }
  if (!res.ok) throw new Error(`[tennisApi] ${path} -> HTTP ${res.status}`);

  // Some failures carry no flag and no status at all — the subscription
  // error is literally {"message":"You are not subscribed to this API."}.
  // A bare message with no payload is never a valid success response here,
  // so treat it as the failure it is rather than letting it through as data.
  const hasPayload = body && (body.data !== undefined || body.results !== undefined ||
                              Array.isArray(body) || body.success === true);
  if (!hasPayload && body?.message) {
    throw new Error(`[tennisApi] ${path} -> ${body.message}`);
  }

  return body;
}

/** Doubles rubbish up a singles board and are never analysed, so they are
 *  dropped at ingest. The feed marks a pair by joining both names with a
 *  slash and setting countryAcr to "N/A" — either signal is enough. */
function isDoubles(fx) {
  const n1 = fx?.player1?.name || '';
  const n2 = fx?.player2?.name || '';
  return n1.includes('/') || n2.includes('/') ||
         (fx?.player1?.countryAcr === 'N/A' && fx?.player2?.countryAcr === 'N/A');
}

function shapeFixture(fx, tourType) {
  const rankId = fx?.tournament?.rankId;
  return {
    sourceId: `sa365:${fx.id}`,
    externalId: fx.id,
    tour: tourType,
    startTime: fx.date ? new Date(fx.date) : null,
    competitorA: fx.player1?.name || null,
    competitorB: fx.player2?.name || null,
    countryA: fx.player1?.countryAcr || null,
    countryB: fx.player2?.countryAcr || null,
    playerAId: fx.player1Id ?? null,
    playerBId: fx.player2Id ?? null,
    league: fx.tournament?.name || null,
    tournamentId: fx.tournamentId ?? null,
    tourLevel: rankId ?? null,
    tourLevelName: RANK[rankId] || 'Unknown',
    roundId: fx.roundId ?? null,
    seedA: fx.seed1 || null,
    seedB: fx.seed2 || null,
  };
}

/**
 * Singles fixtures for one calendar day, across the tour levels enabled.
 * Pages until exhausted; `hasNextPage` drives the loop.
 */
async function fetchFixturesForDate(dateStr, { tours = ['atp', 'wta'], pageSize = 100, maxPages = 20 } = {}) {
  const out = [];
  const skipped = { doubles: 0, level: 0, noStart: 0 };

  for (const tourType of tours) {
    for (let page = 1; page <= maxPages; page++) {
      let body;
      try {
        body = await apiGet(`${tourType}/fixtures/${dateStr}?include=tournament&pageSize=${pageSize}&pageNo=${page}`);
      } catch (err) {
        // One tour failing must not take the whole day's slate with it.
        console.warn(`[tennisApi] ${tourType} ${dateStr} page ${page}: ${err.message}`);
        break;
      }

      const rows = Array.isArray(body?.data) ? body.data : [];
      for (const fx of rows) {
        if (isDoubles(fx)) { skipped.doubles++; continue; }
        if (!TOUR_LEVELS.includes(fx?.tournament?.rankId)) { skipped.level++; continue; }
        if (!fx.date) { skipped.noStart++; continue; }
        out.push(shapeFixture(fx, tourType));
      }

      if (!body?.hasNextPage || !rows.length) break;
    }
  }

  out.sort((a, b) => a.startTime - b.startTime);
  console.log(`[tennisApi] ${dateStr}: ${out.length} singles (skipped ${skipped.doubles} doubles, ${skipped.level} off-level, ${skipped.noStart} undated)`);
  return out;
}

/** Today and tomorrow in UTC, which is the window the pipeline analyses. */
async function fetchUpcomingFixtures(opts = {}) {
  const days = [0, 1].map((offset) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  });
  const all = [];
  for (const day of days) all.push(...await fetchFixturesForDate(day, opts));
  return all;
}

/**
 * Head-to-head. This is one of the twelve weighted factors and is currently
 * researched by web search, which is slow and inconsistent — a structured
 * H2H record is a straight upgrade to that factor's input.
 */
async function fetchH2H(tourType, player1, player2, { full = true } = {}) {
  const p1 = encodeURIComponent(player1);
  const p2 = encodeURIComponent(player2);
  return apiGet(`h2h/profile/${tourType}/${p1}/${p2}/${full ? 'false' : 'true'}`);
}

/**
 * PREGAME / OPENING ODDS.
 *
 * Lives under the `upcoming` group, not `extend/api` — which is why every
 * probe of /extend/api/odds/* came back empty. Takes the four ids as QUERY
 * parameters rather than a composite path segment:
 *
 *   /upcoming/matchodds/{atp|wta}
 *     ?player1Id=&player2Id=&tournamentId=&roundId=
 *
 * Response is one entry per bookmaker, confirmed live:
 *   { id_b_o: "1", k1: 1.45, k2: 2.74, ... }
 *
 *   id_b_o   bookmaker id (matches /extend/api/bookmakers/all)
 *   k1 / k2  DECIMAL moneyline for player1 / player2
 *   f1,kf1   handicap line and price; ktb/ktm over/under; k20..k03 set score
 *
 * Only the moneyline is taken here — that is what the pipeline grades on.
 */
const PREFERRED_BOOKS = (process.env.TENNIS_ODDS_BOOKS || '19,1,11,20')
  .split(',').map((s) => s.trim()).filter(Boolean); // Pinnacle, Bet365, DraftKings, Marathon

function decToAmerican(dec) {
  const d = Number(dec);
  if (!Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

/**
 * Opening moneyline for one fixture. Returns null when no book has priced
 * it — a real state for a fixture posted before the market opens, not an
 * error.
 */
async function fetchMatchOdds({ tour = 'atp', player1Id, player2Id, tournamentId, roundId }) {
  if (!player1Id || !player2Id || !tournamentId || roundId === undefined || roundId === null) return null;

  const qs = `player1Id=${player1Id}&player2Id=${player2Id}&tournamentId=${tournamentId}&roundId=${roundId}`;
  let body;
  try {
    body = await apiGet(`upcoming/matchodds/${tour}?${qs}`);
  } catch (err) {
    return null; // no price yet, or the tour/round combination isn't carried
  }

  const rows = Array.isArray(body?.odds) ? body.odds.filter(Boolean) : [];
  if (!rows.length) return null;

  // Prefer a sharp book when present. Pinnacle first: its price is the
  // best available read on true probability, which is what the blend
  // wants to weigh the model against.
  let chosen = null;
  for (const want of PREFERRED_BOOKS) {
    chosen = rows.find((r) => String(r.id_b_o) === want);
    if (chosen) break;
  }
  if (!chosen) chosen = rows[0];

  const oddsA = decToAmerican(chosen.k1);
  const oddsB = decToAmerican(chosen.k2);
  if (oddsA === null || oddsB === null) return null;

  return {
    oddsA,
    oddsB,
    decimalA: Number(chosen.k1),
    decimalB: Number(chosen.k2),
    bookmakerId: String(chosen.id_b_o),
    bookCount: rows.length,
  };
}

/** Bookmaker directory. Confirmed working; Pinnacle is id 19 and is the
 *  one worth having — a sharp reference price says whether a BetMGM line
 *  is genuinely wrong or merely slow. */
async function fetchBookmakers() {
  const body = await apiGet('extend/api/bookmakers/all');
  return Array.isArray(body?.results) ? body.results : [];
}

/**
 * LIVE EVENTS — confirmed working, and better than the ESPN feed it
 * supplements.
 *
 * ESPN gives games and sets. This gives the score WITHIN the current game
 * ("30-15") and which player is serving, via `indicator` ("1,0" = player 1
 * on serve). The DIP alert currently infers a break from a two-game lead;
 * with this it can see an actual break point as it happens.
 *
 * Note the ids here are NOT the Core API's fixture ids — a live event
 * carries its own `id` plus a composite `matchId`. Joining the two sources
 * therefore has to go through player names, which is what namesLikelyMatch
 * already does elsewhere in the pipeline.
 */
function parseLiveEvent(ev) {
  // "6-3,2-1" -> completed sets plus the set in progress.
  const sets = String(ev.score || '').split(',').map((s) => s.trim()).filter(Boolean);
  const current = sets[sets.length - 1] || '';
  const [gamesA, gamesB] = current.split('-').map((n) => parseInt(n, 10));

  // indicator "1,0" means player 1 is serving; "0,1" means player 2.
  const ind = String(ev.indicator || '').split(',');
  const serving = ind[0] === '1' ? 'A' : ind[1] === '1' ? 'B' : null;

  // points "30-15", or "40-A" for advantage.
  const [ptsA, ptsB] = String(ev.points || '').split('-').map((s) => s.trim());

  let setsWonA = 0, setsWonB = 0;
  for (const set of sets.slice(0, -1)) {
    const [a, b] = set.split('-').map((n) => parseInt(n, 10));
    if (Number.isFinite(a) && Number.isFinite(b)) { if (a > b) setsWonA++; else if (b > a) setsWonB++; }
  }

  return {
    liveId: ev.id,
    matchId: ev.matchId || null,
    competitorA: ev.participant1 || ev.player1?.name || null,
    competitorB: ev.participant2 || ev.player2?.name || null,
    league: ev.league || ev.tournament?.name || null,
    tour: ev.tourType || null,
    status: ev.status || null,
    setScore: ev.score || null,
    setsWonA,
    setsWonB,
    gamesA: Number.isFinite(gamesA) ? gamesA : null,
    gamesB: Number.isFinite(gamesB) ? gamesB : null,
    pointsA: ptsA || null,
    pointsB: ptsB || null,
    serving,
    startTime: ev.startTimestamp ? new Date(ev.startTimestamp * 1000) : null,
  };
}

/**
 * A break point against the server, detected from real point state rather
 * than inferred from the games column. This is the signal the DIP alert
 * has been approximating.
 */
function breakPointAgainst(live) {
  if (!live.serving || !live.pointsA || !live.pointsB) return null;
  const receiverPts = live.serving === 'A' ? live.pointsB : live.pointsA;
  const serverPts = live.serving === 'A' ? live.pointsA : live.pointsB;
  const atBreakPoint = receiverPts === 'A' || (receiverPts === '40' && serverPts !== '40' && serverPts !== 'A');
  return atBreakPoint ? (live.serving === 'A' ? 'B' : 'A') : null;
}

async function fetchLiveEvents() {
  const body = await apiGet('extend/api/events/live');
  const rows = Array.isArray(body?.results) ? body.results : [];
  return rows.map(parseLiveEvent);
}

/**
 * Odds. The endpoint path is NOT yet confirmed — the documented groups we
 * probed all 404'd at the body level, and the docs' own group selector
 * (Predictions / Live) has not been read. Rather than hardcode a guess,
 * the path is supplied by env and validated on first use.
 *
 * Set TENNIS_ODDS_PATH with {id} as the placeholder, e.g.
 *   TENNIS_ODDS_PATH=extend/api/events/{id}/odds
 */
async function fetchOdds(eventId) {
  const template = process.env.TENNIS_ODDS_PATH;
  if (!template) return null; // Not configured: caller keeps its existing source.
  return apiGet(template.replace('{id}', encodeURIComponent(eventId)));
}

/**
 * Path finder for the odds endpoint. Probes candidates and reports which
 * return real data, so the correct value for TENNIS_ODDS_PATH can be found
 * without another round of manual curl.
 */
async function discoverOddsPath(sampleEventId) {
  const candidates = [
    'extend/api/odds/{id}', 'extend/api/events/{id}/odds', 'extend/api/matches/{id}/odds',
    'extend/api/event/{id}/odds', 'extend/api/match/{id}/odds', 'extend/api/odds/event/{id}',
    'extend/api/odds/match/{id}', 'extend/api/live/odds/{id}', 'extend/api/prematch/odds/{id}',
    'predictions/odds/{id}', 'upcoming/matches/{id}/odds', 'stats/odds/{id}',
  ];
  const hits = [];
  for (const c of candidates) {
    const path = c.replace('{id}', sampleEventId);
    try {
      const body = await apiGet(path);
      hits.push({ path: c, sample: JSON.stringify(body).slice(0, 300) });
      console.log(`[tennisApi] ODDS HIT  ${c}`);
    } catch {
      /* expected for wrong paths */
    }
  }
  if (!hits.length) console.log('[tennisApi] no odds path found among candidates');
  return hits;
}

module.exports = {
  apiGet,
  fetchMatchOdds,
  decToAmerican,
  fetchLiveEvents,
  parseLiveEvent,
  breakPointAgainst,
  fetchFixturesForDate,
  fetchUpcomingFixtures,
  fetchH2H,
  fetchBookmakers,
  fetchOdds,
  discoverOddsPath,
  isDoubles,
  shapeFixture,
  RANK,
};
