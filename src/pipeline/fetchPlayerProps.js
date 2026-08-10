/**
 * Match Point — player props fetcher. Basketball only for now (NBA/WNBA),
 * deliberately scoped down from "all sports" — see the reasoning in
 * cron.js where this gets called. Raw lines only; no Claude analysis
 * and no grading yet. That's the next phase, once this is confirmed
 * working against the real account's actual API tier.
 *
 * IMPORTANT — confirmed via The Odds API's own docs, not assumed:
 * - Player props require the Business plan tier. A Pro-tier key gets a
 *   403 on this endpoint specifically, even though the rest of your
 *   integration (moneyline/spread/totals) works fine on lower tiers.
 *   If ODDS_API_KEY doesn't have props access, every call here will
 *   fail — check your actual plan on the-odds-api.com before assuming
 *   this is broken code.
 * - Unlike the bulk /sports/{sportKey}/odds endpoint used everywhere
 *   else in this codebase, props require the per-EVENT endpoint
 *   (/sports/{sportKey}/events/{eventId}/odds) — one real API call per
 *   match, not one call covering the whole day's slate. Real quota
 *   cost that scales with how many matches you fetch props for.
 */

const fetch = require('node-fetch');

// NBA and WNBA share the same 8 real market keys (confirmed via The
// Odds API's docs) — points, rebounds, assists, points+rebounds+
// assists combined, threes, blocks, steals, double-double.
const BASKETBALL_PROP_MARKETS = [
  'player_points',
  'player_rebounds',
  'player_assists',
  'player_points_rebounds_assists',
  'player_threes',
  'player_blocks',
  'player_steals',
  'player_double_double',
];

// league (as stored on Match, from The Odds API's own sport_title field)
// -> the specific sportKey the per-event endpoint needs. Not the same
// as the generic "basketball" sport slug used elsewhere in this codebase.
const LEAGUE_TO_SPORT_KEY = {
  NBA: 'basketball_nba',
  WNBA: 'basketball_wnba',
};

/**
 * Fetches raw player prop lines for one match. Returns a flat array of
 * { playerName, market, line, overOdds, underOdds, bookmaker } — real
 * lines only, no picks, no analysis. Returns [] (not an error) if props
 * genuinely aren't available for this match yet, which is normal and
 * common — books don't post every prop market for every game.
 */
async function fetchBasketballPlayerProps(match) {
  const sportKey = LEAGUE_TO_SPORT_KEY[match.league];
  if (!sportKey) {
    console.warn(`[player-props] unrecognized basketball league "${match.league}" for ${match.competitorA} vs ${match.competitorB} — skipping.`);
    return [];
  }

  const apiKey = process.env.ODDS_API_KEY;
  const baseUrl = process.env.ODDS_API_BASE_URL || 'https://api.the-odds-api.com/v4';
  const marketsParam = BASKETBALL_PROP_MARKETS.join(',');
  // Real fix: this used to hard-restrict to bookmakers=betmgm specifically.
  // If The Odds API's aggregated coverage of BetMGM has ANY gap for a
  // given match (even though BetMGM's own site has the props — confirmed
  // happening for a real WNBA match), that restriction meant getting
  // nothing back at all, even when other books had the same props
  // available. No longer restricting to one specific book — takes
  // whichever bookmaker is actually present in the response.
  const url = `${baseUrl}/sports/${sportKey}/events/${match.externalId}/odds?apiKey=${apiKey}&regions=us&markets=${marketsParam}&oddsFormat=american`;

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error(`[player-props] fetch failed for ${match.competitorA} vs ${match.competitorB}:`, err.message);
    return [];
  }

  if (res.status === 403) {
    console.error(`[player-props] 403 from The Odds API — your key likely doesn't have player-props access (requires Business tier). Check your plan at the-odds-api.com.`);
    return [];
  }
  if (!res.ok) {
    console.error(`[player-props] request failed for ${match.competitorA} vs ${match.competitorB}: ${res.status} ${res.statusText}`);
    return [];
  }

  const data = await res.json();
  // Real diagnostic logging — previously this silently returned [] with
  // zero trace of WHY, which made a real bug (see above) look identical
  // to genuinely "no props posted yet." Now the actual response shape
  // gets logged whenever there's nothing usable, so this is diagnosable
  // from Railway's logs instead of guessed at blind.
  if (!data.bookmakers || data.bookmakers.length === 0) {
    console.warn(`[player-props] ${match.competitorA} vs ${match.competitorB}: API returned zero bookmakers for this event. Full response: ${JSON.stringify(data).slice(0, 500)}`);
    return [];
  }
  const bookmaker = data.bookmakers.find((b) => b.markets && b.markets.length > 0) || data.bookmakers[0];
  if (!bookmaker || !bookmaker.markets || bookmaker.markets.length === 0) {
    console.warn(`[player-props] ${match.competitorA} vs ${match.competitorB}: bookmaker(s) present (${data.bookmakers.map(b => b.key).join(', ')}) but none had usable markets.`);
    return [];
  }
  console.log(`[player-props] ${match.competitorA} vs ${match.competitorB}: using bookmaker "${bookmaker.key}", ${bookmaker.markets.length} market(s).`);

  const results = [];
  for (const market of bookmaker.markets || []) {
    // Each outcome pair is Over/Under for one player at one line —
    // group by player+point to combine the two sides into one row.
    const byPlayer = {};
    for (const outcome of market.outcomes || []) {
      const key = `${outcome.description}|${outcome.point}`;
      if (!byPlayer[key]) {
        byPlayer[key] = { playerName: outcome.description, market: market.key, line: outcome.point, overOdds: null, underOdds: null };
      }
      if (outcome.name === 'Over') byPlayer[key].overOdds = outcome.price;
      else if (outcome.name === 'Under') byPlayer[key].underOdds = outcome.price;
    }
    results.push(...Object.values(byPlayer));
  }

  return results;
}

module.exports = { fetchBasketballPlayerProps, BASKETBALL_PROP_MARKETS };
