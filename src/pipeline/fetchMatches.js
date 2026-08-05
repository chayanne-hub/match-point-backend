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
  soccer: ['soccer_epl', 'soccer_uefa_champs_league'], // add more league keys as needed
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
const MAX_PLAUSIBLE_ODDS = 2000;

function isPlausibleOdds(price) {
  return typeof price === 'number' && Math.abs(price) <= MAX_PLAUSIBLE_ODDS;
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
    combined = combined.concat(
      data.map((g) => ({
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
  if (oddsA !== null && !isPlausibleOdds(oddsA)) {
    console.warn(`[fetchMatches] rejecting implausible odds for ${raw.home_team} vs ${raw.away_team}: ${oddsA} / ${oddsB} — likely a suspended-market placeholder.`);
    oddsA = null;
    oddsB = null;
  } else if (oddsB !== null && !isPlausibleOdds(oddsB)) {
    console.warn(`[fetchMatches] rejecting implausible odds for ${raw.home_team} vs ${raw.away_team}: ${oddsA} / ${oddsB} — likely a suspended-market placeholder.`);
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
async function fetchMatches(sport) {
  const raw = await fetchFromProvider(sport);
  return raw.map((m) => normalizeMatch(sport, m));
}

module.exports = { fetchMatches, fetchScores };
