/**
 * Match Point — data provider adapter.
 *
 * This file is the one piece that CANNOT be finished without you picking a
 * real sports data/odds provider and getting an API key. Everything else in
 * this backend works regardless of provider; this file just needs its
 * fetchFromProvider() function rewritten to match whichever one you choose.
 *
 * Reasonable options:
 *   - The Odds API (https://the-odds-api.com) — simplest to start with, has
 *     a free tier, covers odds for most major sports/leagues.
 *   - SportsDataIO (https://sportsdata.io) — more detailed stats (injuries,
 *     box scores) alongside odds, paid.
 *   - Sportradar (https://sportradar.com) — most comprehensive, enterprise
 *     pricing, what a lot of books themselves use.
 *
 * The shape below assumes something roughly like The Odds API's response
 * format. Adjust the field mapping in normalizeMatch() to whatever your
 * chosen provider actually returns.
 */

const fetch = require('node-fetch');

const SPORT_KEYS = {
  basketball: ['basketball_nba', 'basketball_wnba'],
  // MLS added alongside EPL/Champions League specifically because both of
  // those are between seasons for weeks at a time (EPL doesn't start until
  // late August, Champions League's league phase not until September) —
  // MLS runs through October, so it keeps soccer picks flowing when the
  // European leagues are dark. Exact key confirmed against The Odds API's
  // naming convention, not directly verified in their docs — check the
  // [fetchMatches] logs after deploy; a wrong key logs a clear per-key
  // error without breaking the other soccer leagues.
  soccer: ['soccer_epl', 'soccer_uefa_champs_league', 'soccer_usa_mls'],
  baseball: ['baseball_mlb'],
  football: ['americanfootball_nfl'],
};

// Tennis is the one sport where The Odds API keys change constantly — it's
// tracked per-tournament (tennis_atp_wimbledon, tennis_atp_us_open, etc.),
// not as one stable ATP/WTA-wide key, and a key only exists while that
// tournament is actually running. So instead of a hardcoded key, ask the
// API which tennis tournaments are live right now.
const DYNAMIC_PREFIXES = {
  tennis: 'tennis_',
};

// American odds outside this range are treated as implausible and rejected
// rather than used. Sportsbooks commonly post an extreme placeholder price
// (e.g. -10000) for a few seconds right as a market transitions to
// in-play, before real trading opens — that placeholder isn't a real
// quote, and using it corrupts confidence/pick odds with garbage. No
// legitimate market price in the sports this pipeline covers gets
// anywhere near this bound, so anything beyond it is assumed suspended.
// Absolute outer bound — anything past this isn't a price any book would
// post, it's corrupt data. Deliberately far looser than the old 2000 cap:
// -10000 (decimal 1.01) is a REAL, routinely-posted in-play price when a
// player is a game from winning. The old cap treated those as garbage and
// threw away every live quote in a one-sided match, which froze live
// confidence and odds at their pregame values.
const MAX_PLAUSIBLE_ODDS = 100000;

function isPlausibleOdds(price) {
  return typeof price === 'number' && Number.isFinite(price) && Math.abs(price) <= MAX_PLAUSIBLE_ODDS && Math.abs(price) >= 100;
}

function impliedProbFromAmerican(odds) {
  return odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100);
}

/**
 * The real test for a bogus quote isn't how extreme one side is — it's
 * whether the two sides make sense TOGETHER. A genuine two-sided market's
 * implied probabilities sum to a little over 1 (the book's margin). A
 * suspended-market placeholder posts a lopsided price on one side without
 * a matching move on the other, so the sum blows out well past any real
 * margin.
 *
 * Real example this now accepts: Merida +1550 / Tien -10000 sums to ~1.05
 * — a legitimate live price on a nearly-decided match.
 * Still rejected: -10000 on BOTH sides, which sums to ~1.98.
 */
const MAX_PLAUSIBLE_OVERROUND = 1.35; // 35% margin is already far above any real book
// Lower bound is deliberately loose. Soccer h2h is a THREE-way market
// (Home/Draw/Away) and we only extract the two team prices, so the two
// sides alone legitimately sum to ~0.75-0.85 with the draw's share
// missing. An earlier 0.8 floor rejected every real EPL and MLS match.
// This bound only needs to catch genuinely incoherent quotes (two long
// prices on both sides, which sum near zero).
const MIN_PLAUSIBLE_OVERROUND = 0.5;

/**
 * allPrices, when supplied, is every outcome in the h2h market including
 * the draw for three-way sports — summing all of them gives the book's
 * true overround and works for two-way and three-way markets alike.
 * Falls back to just the two team prices if the full set isn't available.
 */
function isPlausibleMarket(oddsA, oddsB, allPrices) {
  if (!isPlausibleOdds(oddsA) || !isPlausibleOdds(oddsB)) return false;
  const prices = Array.isArray(allPrices) && allPrices.length >= 2 ? allPrices : [oddsA, oddsB];
  const sum = prices.reduce((acc, p) => acc + impliedProbFromAmerican(p), 0);
  return sum >= MIN_PLAUSIBLE_OVERROUND && sum <= MAX_PLAUSIBLE_OVERROUND;
}

// The /sports endpoint is free (doesn't cost quota) and lists every
// currently in-season sport key.
async function discoverSportKeys(prefix, baseUrl, apiKey) {
  const url = `${baseUrl}/sports?apiKey=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[fetchMatches] /sports discovery failed: ${res.status} ${res.statusText}`);
    return [];
  }
  const sports = await res.json();
  return sports.filter((s) => s.key.startsWith(prefix)).map((s) => s.key);
}

// Shared by both the odds fetch and the scores fetch — resolves which
// sport_key(s) to query for a given sport.
async function resolveSportKeys(sport, baseUrl, apiKey) {
  let sportKeys = SPORT_KEYS[sport];
  if (!sportKeys && DYNAMIC_PREFIXES[sport]) {
    sportKeys = await discoverSportKeys(DYNAMIC_PREFIXES[sport], baseUrl, apiKey);
    if (sportKeys.length === 0) {
      console.warn(`[fetchMatches] No in-season ${sport} tournaments found right now.`);
    }
  }
  return sportKeys || [];
}

// The Odds API only accepts one sport_key per request — this fetches each
// key for a sport separately and merges the results.
async function fetchFromProvider(sport) {
  const apiKey = process.env.ODDS_API_KEY;
  const baseUrl = process.env.ODDS_API_BASE_URL;

  if (!apiKey || apiKey === 'your-provider-api-key-here') {
    throw new Error(
      `[fetchMatches] No ODDS_API_KEY configured. Sign up for a data provider ` +
      `and set ODDS_API_KEY + ODDS_API_BASE_URL in .env before running the pipeline.`
    );
  }

  const sportKeys = await resolveSportKeys(sport, baseUrl, apiKey);
  let combined = [];

  for (const sportKey of sportKeys) {
    const url = `${baseUrl}/sports/${sportKey}/odds?apiKey=${apiKey}&regions=us&markets=h2h&oddsFormat=american&bookmakers=betmgm`;
    const response = await fetch(url);
    if (!response.ok) {
      // Log and skip this one key rather than failing the whole sport —
      // e.g. a league being out of season shouldn't kill tennis entirely.
      console.error(`[fetchMatches] ${sportKey} request failed: ${response.status} ${response.statusText}`);
      continue;
    }
    const data = await response.json();
    combined = combined.concat(data);
  }

  return combined;
}

/**
 * Fetches live/recent scores for a sport. The Odds API's /scores endpoint
 * gives final and in-progress scores, but NOT a game clock or period/quarter
 * — that level of detail isn't available from this provider. liveClock is
 * intentionally left for the caller to leave blank rather than fabricate.
 */
async function fetchScores(sport) {
  const apiKey = process.env.ODDS_API_KEY;
  const baseUrl = process.env.ODDS_API_BASE_URL;
  if (!apiKey || apiKey === 'your-provider-api-key-here') return [];

  const sportKeys = await resolveSportKeys(sport, baseUrl, apiKey);
  let combined = [];

  for (const sportKey of sportKeys) {
    // daysFrom=1 includes games from the last day, which covers anything
    // currently in progress or just finished.
    const url = `${baseUrl}/sports/${sportKey}/scores?apiKey=${apiKey}&daysFrom=1`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[fetchMatches] ${sportKey} scores request failed: ${response.status} ${response.statusText}`);
      continue;
    }
    const data = await response.json();
    const cutoff = Date.now() + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000;
    // Same real issue as fetchMatches() had: daysFrom only bounds how far
    // back this looks for recently-finished games, not how far forward
    // the schedule extends in the same response — a sport with no games
    // in the near future can still return its whole remaining schedule
    // here. Filter out anything more than MAX_DAYS_AHEAD out; nothing
    // that far away needs a score check anyway.
    const filtered = data.filter((g) => !g.commence_time || new Date(g.commence_time).getTime() <= cutoff);
    combined = combined.concat(
      filtered.map((g) => ({
        externalId: g.id,
        completed: !!g.completed,
        homeTeam: g.home_team,
        awayTeam: g.away_team,
        // scores is null until the game actually starts
        homeScore: g.scores?.find((s) => s.name === g.home_team)?.score ?? null,
        awayScore: g.scores?.find((s) => s.name === g.away_team)?.score ?? null,
      }))
    );
  }

  return combined;
}

// Normalizes one provider match object into the shape the rest of the
// pipeline expects. Rewrite this mapping for your actual provider's format.
function normalizeMatch(sport, raw) {
  const bookOdds = raw.bookmakers?.find((b) => b.key === 'betmgm');
  const h2h = bookOdds?.markets?.find((m) => m.key === 'h2h');
  const outcomes = h2h?.outcomes || [];

  let oddsA = outcomes.find((o) => o.name === raw.home_team)?.price ?? null;
  let oddsB = outcomes.find((o) => o.name === raw.away_team)?.price ?? null;

  // Reject the whole quote (both sides) if either price looks like a
  // suspended-market placeholder rather than a real number — a market
  // that's actually two-sided doesn't have one legitimate price and one
  // garbage one, so if either side fails the sanity check, neither side
  // can be trusted. Downstream code already treats null odds as "no
  // price available" and safely skips picks/updates rather than using it.
  // Judge the two prices TOGETHER, not each against an absolute cap. A
  // heavily one-sided in-play price is normal and real; what isn't real
  // is a pair whose implied probabilities don't add up to a sane book
  // margin. See isPlausibleMarket above.
  // Include EVERY outcome (the draw too, for soccer) so the overround is
  // computed against the book's actual full market, not a two-way slice.
  const allOutcomePrices = outcomes.map((o) => o.price).filter((p) => typeof p === 'number');
  if (oddsA !== null && oddsB !== null && !isPlausibleMarket(oddsA, oddsB, allOutcomePrices)) {
    console.warn(`[fetchMatches] rejecting implausible market for ${raw.home_team} vs ${raw.away_team}: ${oddsA} / ${oddsB} — sides don't form a coherent two-way price.`);
    oddsA = null;
    oddsB = null;
  }

  return {
    externalId: raw.id,
    sport,
    league: raw.sport_title || sport.toUpperCase(),
    competitorA: raw.home_team,
    competitorB: raw.away_team,
    startTime: new Date(raw.commence_time),
    oddsA,
    oddsB,
    status: new Date(raw.commence_time) <= new Date() ? 'live' : 'scheduled',
  };
}

/**
 * Public entry point: fetch + normalize today's matches for one sport.
 * Returns an array ready to be scored by scoreModel.js and written to the DB.
 */

// Real fix for a confirmed issue: football's odds API endpoint returns
// the ENTIRE season's schedule (all ~272 NFL games) with no built-in
// near-term filtering, most of which are weeks or months out and don't
// have odds posted yet — sportsbooks don't price a game that far in
// advance. Those get skipped safely before any real analysis cost is
// incurred (confirmed via real logs — zero football-specific
// match-analyst calls resulted), so this was never actually costing
// money, but it's genuine unnecessary overhead every single 15-minute
// cycle: creating/updating hundreds of DB rows and checking scores for
// games that can't possibly be relevant yet. Bounded to 14 days out,
// generous enough to never cut off anything actually useful for any
// sport, tight enough to eliminate the season-dump problem.
const MAX_DAYS_AHEAD = 14;

async function fetchMatches(sport) {
  const raw = await fetchFromProvider(sport);
  const cutoff = Date.now() + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000;
  const filtered = raw.filter((m) => new Date(m.commence_time).getTime() <= cutoff);
  if (filtered.length < raw.length) {
    console.log(`[fetchMatches] ${sport}: filtered ${raw.length} → ${filtered.length} matches within the next ${MAX_DAYS_AHEAD} days.`);
  }
  return filtered.map((m) => normalizeMatch(sport, m));
}

module.exports = { fetchMatches, fetchScores };
