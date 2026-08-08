/**
 * Match Point — soccer total-goals formula.
 *
 * Structurally distinct from every other sport's total formula so far:
 *
 * PREGAME blends each team's own scoring with what they tend to CONCEDE,
 * not just their own average — defense matters proportionally more when
 * a single goal can be the whole game. Two cross-matchup estimates,
 * averaged:
 *   estimate1 = TeamA's avg goals scored + TeamB's avg goals conceded
 *   estimate2 = TeamB's avg goals scored + TeamA's avg goals conceded
 *   projected = (estimate1 + estimate2) / 2
 *
 * LIVE runs on a real clock (unlike baseball/tennis), but the clock
 * counts UP with variable, not-known-in-advance stoppage time — the
 * opposite convention from basketball/football's countdown clock. ESPN's
 * soccer displayClock is typically a string like "72'" or "45+2'"
 * (elapsed + stoppage), parsed directly here rather than reusing
 * teamTotals.js's remaining-time math, which assumes the wrong direction
 * for this sport.
 */

const db = require('../lib/db');

const LOOKBACK_MATCHES = 3;
const REGULATION_MINUTES = 90; // 2x45 — doesn't account for knockout-tie extra time, a real scope limitation, not silently assumed away

/**
 * A team's own average goals SCORED across their last LOOKBACK_MATCHES
 * completed matches. Returns null if fewer than LOOKBACK_MATCHES exist.
 */
async function avgGoalsScored(teamName, beforeDate) {
  const games = await db.match.findMany({
    where: {
      status: 'final',
      sport: { slug: 'soccer' },
      OR: [{ competitorA: teamName }, { competitorB: teamName }],
      startTime: { lt: beforeDate },
      homeScore: { not: null },
      awayScore: { not: null },
    },
    orderBy: { startTime: 'desc' },
    take: LOOKBACK_MATCHES,
  });
  if (games.length < LOOKBACK_MATCHES) return null;

  const scores = games.map((g) => (g.competitorA === teamName ? g.homeScore : g.awayScore));
  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

/**
 * A team's own average goals CONCEDED across their last LOOKBACK_MATCHES
 * completed matches — i.e. the OPPONENT's score in each of those
 * matches. Returns null if fewer than LOOKBACK_MATCHES exist.
 */
async function avgGoalsConceded(teamName, beforeDate) {
  const games = await db.match.findMany({
    where: {
      status: 'final',
      sport: { slug: 'soccer' },
      OR: [{ competitorA: teamName }, { competitorB: teamName }],
      startTime: { lt: beforeDate },
      homeScore: { not: null },
      awayScore: { not: null },
    },
    orderBy: { startTime: 'desc' },
    take: LOOKBACK_MATCHES,
  });
  if (games.length < LOOKBACK_MATCHES) return null;

  // Conceded = the OTHER side's score in each match this team played.
  const conceded = games.map((g) => (g.competitorA === teamName ? g.awayScore : g.homeScore));
  return conceded.reduce((sum, c) => sum + c, 0) / conceded.length;
}

/**
 * Pregame projected total goals — see file header for the blended
 * scored/conceded formula. Returns null if either team lacks 3 matches
 * of history yet.
 */
async function computePregameProjectedTotalGoals(competitorA, competitorB, matchStartTime) {
  const [scoredA, concededA, scoredB, concededB] = await Promise.all([
    avgGoalsScored(competitorA, matchStartTime),
    avgGoalsConceded(competitorA, matchStartTime),
    avgGoalsScored(competitorB, matchStartTime),
    avgGoalsConceded(competitorB, matchStartTime),
  ]);
  if (scoredA === null || concededA === null || scoredB === null || concededB === null) return null;

  const estimate1 = scoredA + concededB;
  const estimate2 = scoredB + concededA;
  const projectedTotal = (estimate1 + estimate2) / 2;

  return {
    projectedTotal: Math.round(projectedTotal * 10) / 10,
    scoredA: Math.round(scoredA * 10) / 10,
    concededA: Math.round(concededA * 10) / 10,
    scoredB: Math.round(scoredB * 10) / 10,
    concededB: Math.round(concededB * 10) / 10,
  };
}

/**
 * Parses ESPN's soccer displayClock format ("72'", "45+2'", "90+3'")
 * into total elapsed minutes (stoppage time added in). Reverse-engineered
 * against ESPN's typical soccer display convention — same unverified-
 * unofficial-API caveat as the rest of this pipeline's ESPN integration.
 * Returns null if the string doesn't match the expected shape rather
 * than guessing.
 */
function parseElapsedMinutesFromDisplayClock(displayClock) {
  if (!displayClock) return null;
  const m = displayClock.match(/^(\d+)(?:\+(\d+))?'?$/);
  if (!m) return null;
  const base = parseInt(m[1], 10);
  const stoppage = m[2] ? parseInt(m[2], 10) : 0;
  return base + stoppage;
}

/**
 * Live projected total goals: goals so far + (pace × minutes remaining).
 * "Minutes remaining" is a simple regulation-based estimate (90 minus
 * elapsed) — it does NOT attempt to predict how much stoppage time will
 * be added at the end of either half, since that's genuinely unknowable
 * in advance. That uncertainty is disclosed via the prompt, not hidden.
 *
 * Returns null if minutes elapsed is 0 or unavailable — pace is
 * undefined with no time elapsed, not zero.
 */
function computeLiveProjectedTotalGoals({ goalsSoFar, minutesElapsed }) {
  if (minutesElapsed === null || minutesElapsed === undefined || minutesElapsed <= 0) return null;

  const pace = goalsSoFar / minutesElapsed;
  const minutesRemaining = Math.max(0, REGULATION_MINUTES - minutesElapsed);
  const projectedFinal = goalsSoFar + pace * minutesRemaining;

  return {
    pace: Math.round(pace * 1000) / 1000, // goals/min is a small number — more precision than the other sports' pace figures
    minutesElapsed,
    minutesRemaining,
    projectedFinal: Math.round(projectedFinal * 10) / 10,
  };
}

module.exports = {
  computePregameProjectedTotalGoals,
  computeLiveProjectedTotalGoals,
  parseElapsedMinutesFromDisplayClock,
};
