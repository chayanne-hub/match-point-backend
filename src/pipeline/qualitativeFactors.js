/**
 * Match Point — free/derivable qualitative factors.
 *
 * Unlike the market-implied and injury factors, these don't need any
 * external API — they're computed entirely from our own match history,
 * which the pipeline has been persisting since the homeScore/awayScore
 * fix. No history yet for a given team means no signal yet; these
 * functions return null rather than guessing, same rule as every other
 * factor in this model.
 *
 * DELIBERATELY NOT INCLUDED: park factors and league tier. Both affect
 * total run/goal scoring, not which team is more likely to WIN — so they
 * have no real directional pull on a moneyline pick, which is the only
 * pick type this model currently produces. Including them would be
 * decorative, not real signal. Revisit if/when totals (over/under) picks
 * get added as a product.
 */

const db = require('../lib/db');

const REST_DAYS_CAP = 4; // rest advantage beyond this many extra days doesn't add more signal
const MIN_FORM_SAMPLE = 3; // need at least this many past home/away games before trusting the form factor
const FORM_LOOKBACK = 10; // how many recent home/away games to sample

/**
 * Days since a team's last completed match, or null if no prior match
 * exists in our history yet (e.g. the first time we've seen this team).
 */
async function daysSinceLastMatch(sportSlug, teamName, beforeDate) {
  const lastMatch = await db.match.findFirst({
    where: {
      sport: { slug: sportSlug },
      status: 'final',
      startTime: { lt: beforeDate },
      OR: [{ competitorA: teamName }, { competitorB: teamName }],
    },
    orderBy: { startTime: 'desc' },
  });
  if (!lastMatch) return null;
  const ms = beforeDate.getTime() - lastMatch.startTime.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

/**
 * Rest-days factor: positive favors competitorA (more rest since their
 * last match). Null if either team has no prior match on record.
 */
async function computeRestDaysFactor(sportSlug, competitorA, competitorB, matchStartTime) {
  const [restA, restB] = await Promise.all([
    daysSinceLastMatch(sportSlug, competitorA, matchStartTime),
    daysSinceLastMatch(sportSlug, competitorB, matchStartTime),
  ]);
  if (restA === null || restB === null) return null;

  const cappedA = Math.min(restA, REST_DAYS_CAP);
  const cappedB = Math.min(restB, REST_DAYS_CAP);
  const diff = cappedA - cappedB;
  return Math.max(-1, Math.min(1, diff / REST_DAYS_CAP));
}

/**
 * Win rate for a team over its last FORM_LOOKBACK games AT HOME (i.e.
 * matches where it appears as competitorA — see fetchMatches.js
 * normalizeMatch, which always maps the odds provider's home_team to
 * competitorA). Null if fewer than MIN_FORM_SAMPLE qualifying games exist.
 */
async function homeWinRate(sportSlug, teamName, beforeDate) {
  const games = await db.match.findMany({
    where: {
      sport: { slug: sportSlug },
      status: 'final',
      competitorA: teamName,
      startTime: { lt: beforeDate },
      homeScore: { not: null },
      awayScore: { not: null },
    },
    orderBy: { startTime: 'desc' },
    take: FORM_LOOKBACK,
  });
  if (games.length < MIN_FORM_SAMPLE) return null;
  const wins = games.filter((g) => g.homeScore > g.awayScore).length;
  return wins / games.length;
}

/**
 * Win rate for a team over its last FORM_LOOKBACK games AWAY (i.e.
 * matches where it appears as competitorB). Null if fewer than
 * MIN_FORM_SAMPLE qualifying games exist.
 */
async function awayWinRate(sportSlug, teamName, beforeDate) {
  const games = await db.match.findMany({
    where: {
      sport: { slug: sportSlug },
      status: 'final',
      competitorB: teamName,
      startTime: { lt: beforeDate },
      homeScore: { not: null },
      awayScore: { not: null },
    },
    orderBy: { startTime: 'desc' },
    take: FORM_LOOKBACK,
  });
  if (games.length < MIN_FORM_SAMPLE) return null;
  const wins = games.filter((g) => g.awayScore > g.homeScore).length;
  return wins / games.length;
}

/**
 * Home/away form factor: positive favors competitorA. Compares
 * competitorA's recent HOME win rate against competitorB's recent AWAY
 * win rate. Null if either side lacks enough sample yet.
 */
async function computeHomeAwayFormFactor(sportSlug, competitorA, competitorB, matchStartTime) {
  const [homeFormA, awayFormB] = await Promise.all([
    homeWinRate(sportSlug, competitorA, matchStartTime),
    awayWinRate(sportSlug, competitorB, matchStartTime),
  ]);
  if (homeFormA === null || awayFormB === null) return null;

  const diff = homeFormA - awayFormB;
  return Math.max(-1, Math.min(1, diff));
}

module.exports = { computeRestDaysFactor, computeHomeAwayFormFactor };
