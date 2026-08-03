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
  tennis: ['tennis_atp', 'tennis_wta'],
  basketball: ['basketball_nba', 'basketball_wnba'],
  soccer: ['soccer_epl', 'soccer_uefa_champs_league'], // add more league keys as needed
  baseball: ['baseball_mlb'],
  football: ['americanfootball_nfl'],
};

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

  const sportKeys = SPORT_KEYS[sport] || [];
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

// Normalizes one provider match object into the shape the rest of the
// pipeline expects. Rewrite this mapping for your actual provider's format.
function normalizeMatch(sport, raw) {
  const bookOdds = raw.bookmakers?.find((b) => b.key === 'betmgm');
  const h2h = bookOdds?.markets?.find((m) => m.key === 'h2h');
  const outcomes = h2h?.outcomes || [];

  return {
    externalId: raw.id,
    sport,
    league: raw.sport_title || sport.toUpperCase(),
    competitorA: raw.home_team,
    competitorB: raw.away_team,
    startTime: new Date(raw.commence_time),
    oddsA: outcomes.find((o) => o.name === raw.home_team)?.price ?? null,
    oddsB: outcomes.find((o) => o.name === raw.away_team)?.price ?? null,
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

module.exports = { fetchMatches };
