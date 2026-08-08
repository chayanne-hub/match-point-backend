/**
 * Match Point — team-sport total-points formula.
 *
 * Two genuinely computable projections, not model judgment, shared across
 * any sport with a countdown game clock (basketball, football today):
 *
 * PREGAME: Projected total = TeamA's avg points scored (last 3 games)
 *          + TeamB's avg points scored (last 3 games).
 *
 * LIVE:    Pace = combined score so far ÷ minutes elapsed.
 *          Projected final = combined score so far + (pace × minutes remaining).
 *
 * Both are meant to be a starting BASELINE, not the final answer — real
 * judgment (the sport-specific qualitative layers) applies on top in
 * matchAnalyst.js's prompt. This file only computes the math; it never
 * decides a pick on its own.
 *
 * Reliability differs meaningfully by sport — basketball scores in small,
 * frequent increments (pace math is fairly stable even early); football
 * scores in lumpy 3-8 point bursts with real scoreless stretches, so the
 * live formula is far less trustworthy in the first half. That calibration
 * note lives in matchAnalyst.js's prompt, not here — this file just does
 * the arithmetic honestly for whichever sport asks.
 */

const db = require('../lib/db');

const LOOKBACK_GAMES = 3;

// Quarter length in minutes and overtime length in minutes, per sport +
// league. Football's OT length here (10 min) is the NFL regular-season
// rule — playoff OT runs a full 15-minute period instead, and there's
// added nuance around both teams getting a possession under the current
// rules. Not modeled precisely; a reasonable approximation, same spirit
// as other simplifications already in this pipeline (e.g. season
// membership's 180-day approximation in webhooks.js).
const GAME_CONFIG = {
  basketball: {
    NBA: { quarterLength: 12, otLength: 5 },
    WNBA: { quarterLength: 10, otLength: 5 },
  },
  football: {
    NFL: { quarterLength: 15, otLength: 10 },
  },
};
const REGULATION_PERIODS = 4; // both sports run 4 quarters

function configFor(sport, league) {
  const sportConfig = GAME_CONFIG[sport];
  if (!sportConfig) return null;
  const key = (league || '').toUpperCase();
  return sportConfig[key] || Object.values(sportConfig)[0]; // fall back to that sport's first/default league config
}

/**
 * A team's own scored points across their last LOOKBACK_GAMES completed
 * games in a given sport, regardless of whether they were competitorA or
 * competitorB in each one. Scoped by sport so a name collision across
 * sports (rare, but not impossible) can't cross-contaminate the average.
 * Returns null if fewer than LOOKBACK_GAMES exist yet — no partial-sample
 * guessing, same rule as every other factor in this pipeline.
 */
async function avgPointsScored(sport, teamName, beforeDate) {
  const games = await db.match.findMany({
    where: {
      status: 'final',
      sport: { slug: sport },
      OR: [{ competitorA: teamName }, { competitorB: teamName }],
      startTime: { lt: beforeDate },
      homeScore: { not: null },
      awayScore: { not: null },
    },
    orderBy: { startTime: 'desc' },
    take: LOOKBACK_GAMES,
  });
  if (games.length < LOOKBACK_GAMES) return null;

  const scores = games.map((g) => (g.competitorA === teamName ? g.homeScore : g.awayScore));
  const avg = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  return avg;
}

/**
 * Pregame projected total: sum of each team's own average points scored
 * over their last 3 games. Returns null if either team lacks 3 games of
 * history yet (e.g. start of a new season) — never fabricates a number
 * from a partial sample.
 */
async function computePregameProjectedTotal(sport, competitorA, competitorB, matchStartTime) {
  const [avgA, avgB] = await Promise.all([
    avgPointsScored(sport, competitorA, matchStartTime),
    avgPointsScored(sport, competitorB, matchStartTime),
  ]);
  if (avgA === null || avgB === null) return null;

  return {
    projectedTotal: Math.round((avgA + avgB) * 10) / 10,
    avgA: Math.round(avgA * 10) / 10,
    avgB: Math.round(avgB * 10) / 10,
  };
}

/**
 * Converts a period + seconds-remaining-in-period into total minutes
 * elapsed in the game so far. Handles overtime (periods beyond
 * REGULATION_PERIODS use that sport's OT length instead of the
 * regulation quarter length).
 */
function minutesElapsed(sport, league, period, clockSecondsRemaining) {
  if (period == null || clockSecondsRemaining == null) return null;
  const cfg = configFor(sport, league);
  if (!cfg) return null;
  const clockMinutesRemaining = clockSecondsRemaining / 60;

  if (period <= REGULATION_PERIODS) {
    const completedPeriods = period - 1;
    return completedPeriods * cfg.quarterLength + (cfg.quarterLength - clockMinutesRemaining);
  }

  const completedOtPeriods = period - REGULATION_PERIODS - 1;
  const regulationElapsed = REGULATION_PERIODS * cfg.quarterLength;
  const otElapsed = completedOtPeriods * cfg.otLength + (cfg.otLength - clockMinutesRemaining);
  return regulationElapsed + otElapsed;
}

/**
 * Live projected total: combined score so far, plus (pace × minutes
 * remaining in regulation). "Minutes remaining" is only well-defined
 * through the end of regulation — once a game is in overtime, there's no
 * fixed remaining duration, so this returns the regulation-based
 * projection with an `inOvertime` flag rather than pretending there's a
 * fixed endpoint.
 *
 * Returns null if minutes elapsed is 0 or unavailable — pace is undefined
 * with no time elapsed, not zero.
 */
function computeLiveProjectedTotal({ sport, league, combinedScoreSoFar, period, clockSecondsRemaining }) {
  const elapsed = minutesElapsed(sport, league, period, clockSecondsRemaining);
  if (elapsed === null || elapsed <= 0) return null;

  const cfg = configFor(sport, league);
  const regulationLength = REGULATION_PERIODS * cfg.quarterLength;
  const inOvertime = period > REGULATION_PERIODS;

  const pace = combinedScoreSoFar / elapsed; // points per minute
  const minutesRemaining = inOvertime ? 0 : Math.max(0, regulationLength - elapsed);
  const projectedFinal = combinedScoreSoFar + pace * minutesRemaining;

  return {
    pace: Math.round(pace * 100) / 100,
    minutesElapsed: Math.round(elapsed * 10) / 10,
    minutesRemaining: Math.round(minutesRemaining * 10) / 10,
    projectedFinal: Math.round(projectedFinal * 10) / 10,
    inOvertime,
  };
}

module.exports = { computePregameProjectedTotal, computeLiveProjectedTotal, computeLiveProjectedTotalByInnings, minutesElapsed };

/**
 * Innings-based live projection — baseball's live formula, structurally
 * different from the time-based one above since baseball has no
 * countdown clock, just discrete innings. Deliberately a separate
 * function rather than forcing baseball through the minutes-based one:
 * the units genuinely don't convert (an inning isn't a fixed number of
 * minutes), so pretending otherwise would be worse than acknowledging
 * they need different math.
 *
 * currentInning is the inning ESPN currently reports (1-9+). This
 * function treats the CURRENT inning as still in progress and only
 * counts fully-completed innings — i.e. inningsCompleted = currentInning
 * - 1. That's a real simplification (it doesn't know whether you're in
 * the top or bottom half, or how many outs), same spirit as the
 * overtime-length approximations elsewhere in this file: honestly
 * disclosed, not hidden.
 *
 * totalInnings defaults to 9 (regulation). Past that, there's no fixed
 * remaining-innings count the same way basketball/football's overtime
 * has no fixed remaining minutes — flagged via inExtraInnings rather than
 * projecting a false endpoint.
 *
 * Returns null if fewer than 1 inning has completed yet — pace is
 * undefined with no innings played, not zero.
 */
function computeLiveProjectedTotalByInnings({ combinedRunsSoFar, currentInning, totalInnings = 9 }) {
  if (currentInning == null) return null;
  const inningsCompleted = currentInning - 1;
  if (inningsCompleted <= 0) return null;

  const inExtraInnings = inningsCompleted >= totalInnings;
  const pace = combinedRunsSoFar / inningsCompleted; // runs per inning
  const inningsRemaining = inExtraInnings ? 0 : totalInnings - inningsCompleted;
  const projectedFinal = combinedRunsSoFar + pace * inningsRemaining;

  return {
    pace: Math.round(pace * 100) / 100,
    inningsCompleted,
    inningsRemaining,
    projectedFinal: Math.round(projectedFinal * 10) / 10,
    inExtraInnings,
  };
}
