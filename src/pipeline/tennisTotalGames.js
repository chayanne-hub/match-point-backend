/**
 * Match Point — tennis total-games formula.
 *
 * Structurally distinct from teamTotals.js's basketball/football/baseball
 * formulas in two real ways:
 *
 *   1. PREGAME is an AVERAGE, not a sum. A tennis match's "total games"
 *      figure already reflects both players combined — so summing each
 *      player's own recent-match-total average would double count.
 *      Averaging the two gives the right baseline.
 *
 *   2. LIVE has no time-based or discrete-unit clock — sets aren't fixed
 *      length. "Expected remaining sets" depends on the match format
 *      (best-of-3 vs best-of-5) and the current set score, computed here
 *      as a neutral (50/50-per-set) expected value — real math, but
 *      explicitly NOT accounting for who's actually favored to close it.
 *      That judgment belongs to matchAnalyst.js's prompt, not this file.
 */

const db = require('../lib/db');

const LOOKBACK_MATCHES = 3;

/**
 * Parses a setScore string like "6-4, 3-6, 7-6" (the format
 * fetchEspn.js's parseTennisCompetition builds) into an array of
 * { gamesA, gamesB } per set, in chronological order. Tolerant of extra
 * whitespace; skips any segment that doesn't cleanly parse as two
 * integers rather than guessing.
 */
function parseSetScore(setScoreString) {
  if (!setScoreString) return [];
  return setScoreString
    .split(',')
    .map((part) => part.trim())
    .map((part) => {
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (!m) return null;
      return { gamesA: parseInt(m[1], 10), gamesB: parseInt(m[2], 10) };
    })
    .filter(Boolean);
}

/**
 * Total games across an entire match (both players combined, every set).
 * Returns null if setScore is missing/unparseable — never fabricates a
 * number from a match with no usable record.
 */
function totalGamesFromSetScore(setScoreString) {
  const sets = parseSetScore(setScoreString);
  if (!sets.length) return null;
  return sets.reduce((sum, s) => sum + s.gamesA + s.gamesB, 0);
}

/**
 * A player's average TOTAL-GAMES figure (both players combined) across
 * their last LOOKBACK_MATCHES completed matches — a proxy for "how many
 * games do matches involving this player tend to produce" (their own
 * hold/break tendencies and recent opponent quality baked in), NOT how
 * many games they personally won. Returns null if fewer than
 * LOOKBACK_MATCHES matches with a parseable setScore exist yet.
 */
async function avgTotalGamesForPlayer(playerName, beforeDate) {
  const matches = await db.match.findMany({
    where: {
      status: 'final',
      sport: { slug: 'tennis' },
      OR: [{ competitorA: playerName }, { competitorB: playerName }],
      startTime: { lt: beforeDate },
      setScore: { not: null },
    },
    orderBy: { startTime: 'desc' },
    take: LOOKBACK_MATCHES * 2, // fetch extra in case some have unparseable setScore
  });

  const totals = matches
    .map((m) => totalGamesFromSetScore(m.setScore))
    .filter((t) => t !== null)
    .slice(0, LOOKBACK_MATCHES);

  if (totals.length < LOOKBACK_MATCHES) return null;
  return totals.reduce((sum, t) => sum + t, 0) / totals.length;
}

/**
 * Pregame projected total games: AVERAGE (not sum) of the two players'
 * own recent-match-total averages — see file header for why this is an
 * average, not a sum. Returns null if either player lacks 3 matches of
 * usable history yet.
 */
async function computePregameProjectedTotalGames(competitorA, competitorB, matchStartTime) {
  const [avgA, avgB] = await Promise.all([
    avgTotalGamesForPlayer(competitorA, matchStartTime),
    avgTotalGamesForPlayer(competitorB, matchStartTime),
  ]);
  if (avgA === null || avgB === null) return null;

  return {
    projectedTotal: Math.round(((avgA + avgB) / 2) * 10) / 10,
    avgA: Math.round(avgA * 10) / 10,
    avgB: Math.round(avgB * 10) / 10,
  };
}

// Best-of-5 is used in ATP majors (and Davis Cup); everything else (all of
// WTA, ATP non-majors) is best-of-3. There's no structured "is this a
// major" field available from the current data source — this is a
// keyword heuristic against the league/tournament string, disclosed as
// such rather than silently assumed. WTA is checked first since it's
// never best-of-5 regardless of tournament name overlap.
const GRAND_SLAM_KEYWORDS = ['wimbledon', 'us open', 'french open', 'roland garros', 'australian open', 'davis cup'];
function detectMatchFormat(league) {
  const l = (league || '').toLowerCase();
  if (l.includes('wta')) return 'bo3';
  return GRAND_SLAM_KEYWORDS.some((k) => l.includes(k)) ? 'bo5' : 'bo3';
}

/**
 * Expected remaining sets under a NEUTRAL 50/50-per-set assumption —
 * real combinatorial math (recursive expected value over the small
 * best-of-3/best-of-5 state space), but explicitly not informed by who's
 * actually favored to win the next set. That's real signal this
 * function deliberately doesn't have — matchAnalyst.js's prompt is where
 * "who's likely to close it" judgment gets layered on top.
 */
function expectedRemainingSets(format, setsWonA, setsWonB) {
  const setsToWin = format === 'bo5' ? 3 : 2;
  if (setsWonA >= setsToWin || setsWonB >= setsToWin) return 0;

  const memo = new Map();
  function E(a, b) {
    if (a >= setsToWin || b >= setsToWin) return 0;
    const key = `${a},${b}`;
    if (memo.has(key)) return memo.get(key);
    const val = 1 + 0.5 * E(a + 1, b) + 0.5 * E(a, b + 1);
    memo.set(key, val);
    return val;
  }
  return Math.round(E(setsWonA, setsWonB) * 100) / 100;
}

/**
 * Live projected total games: games completed so far (every set shown in
 * the live setScore, including a partial in-progress set) plus average
 * games-per-COMPLETED-set times expected remaining sets. The average
 * deliberately excludes a trailing in-progress set — including a
 * shallow partial set would understate the per-set rate, and the user's
 * own guidance is explicit about weighting from ACTUAL completed sets
 * (a set that went to a 7-6 tiebreak should pull the average up, not get
 * diluted by an unfinished set sitting at 2-1).
 *
 * setsWonA/setsWonB should come from the match's real recorded set wins
 * (Match.homeScore/awayScore for tennis, per fetchEspn.js's convention).
 * Returns null if no sets have completed yet — no real per-set rate to
 * project from.
 */
function computeLiveProjectedTotalGames({ liveSetScore, league, setsWonA, setsWonB }) {
  const sets = parseSetScore(liveSetScore);
  if (!sets.length) return null;

  const completedSetsCount = setsWonA + setsWonB;
  if (completedSetsCount === 0) return null;

  const gamesCompletedSoFar = sets.reduce((sum, s) => sum + s.gamesA + s.gamesB, 0);
  const completedSets = sets.slice(0, completedSetsCount);
  const completedGamesSum = completedSets.reduce((sum, s) => sum + s.gamesA + s.gamesB, 0);
  const avgGamesPerSet = completedGamesSum / completedSetsCount;

  const format = detectMatchFormat(league);
  const remaining = expectedRemainingSets(format, setsWonA, setsWonB);
  const projectedTotal = gamesCompletedSoFar + avgGamesPerSet * remaining;

  return {
    gamesCompletedSoFar,
    avgGamesPerSet: Math.round(avgGamesPerSet * 100) / 100,
    expectedRemainingSets: remaining,
    matchFormat: format,
    projectedTotal: Math.round(projectedTotal * 10) / 10,
  };
}

module.exports = {
  computePregameProjectedTotalGames,
  computeLiveProjectedTotalGames,
  parseSetScore,
  totalGamesFromSetScore,
  detectMatchFormat,
  expectedRemainingSets,
};
