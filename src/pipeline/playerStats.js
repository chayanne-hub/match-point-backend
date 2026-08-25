/* Warm the player statistics cache.
 *
 * The factor brief makes roughly nineteen provider calls per analysed
 * match, and most are about a PLAYER rather than the matchup — surface
 * record by year, career serve and return, break points, titles, ranking
 * trend, handedness, status. Those move weekly at most, yet were fetched
 * again for every match a player appeared in. A player in a 32-draw
 * costs five refetches of identical data across a week.
 *
 * This fills PlayerStat on a schedule instead. Three consequences:
 *
 *   - analysis stops paying provider latency on the critical path
 *   - a provider outage degrades the brief to stale-but-real data
 *     rather than to nothing, which is what happened repeatedly today
 *   - the per-match call count drops from ~19 to ~6
 *
 * Deliberately scoped to players who APPEAR ON THE BOARD, not the whole
 * top 500. Warming 1000 players nobody is betting on spends quota to
 * cache data no brief will read.
 */
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();

const {
  fetchPlayerStatus,
  fetchCareerServeReturn,
  fetchBreakPoints,
  fetchTitlesByTier,
  fetchSurfaceByYear,
  fetchRankingTrend,
  fetchStyle,
} = require('./tennisFactors.js');

const { fetchLatestRankings } = require('./fetchTennisApi.js');

/* How long a cached row stays usable.
 *
 * Rankings publish weekly and career aggregates move by fractions of a
 * percent per match, so a day is comfortably fresh. The cost of being
 * slightly stale is far lower than the cost of a brief with nothing in
 * it — which is the failure this exists to prevent. */
const STALE_AFTER_MS = Number(process.env.PLAYER_STAT_TTL_MS || 24 * 60 * 60 * 1000);

/** Players with a match on the board in the next few days. */
async function playersOnTheBoard() {
  const sport = await db.sport.findFirst({ where: { slug: 'tennis' } });
  if (!sport) return [];

  const rows = await db.match.findMany({
    where: {
      sportId: sport.id,
      status: { in: ['scheduled', 'live'] },
      startTime: { gte: new Date(Date.now() - 12 * 60 * 60 * 1000),
                   lte: new Date(Date.now() + 72 * 60 * 60 * 1000) },
    },
    select: { playerAId: true, playerBId: true, competitorA: true, competitorB: true, tour: true },
  });

  const seen = new Map();
  for (const m of rows) {
    const tour = (m.tour || 'atp').toLowerCase();
    if (m.playerAId) seen.set(`${tour}:${m.playerAId}`, { id: String(m.playerAId), tour, name: m.competitorA });
    if (m.playerBId) seen.set(`${tour}:${m.playerBId}`, { id: String(m.playerBId), tour, name: m.competitorB });
  }
  return [...seen.values()];
}

/** Fetch everything about one player and upsert it. */
async function warmOne({ id, tour, name }) {
  /* SEQUENTIAL, NOT PARALLEL.
   *
   * These seven fired at once per player. The provider refuses some of a
   * burst that size, and because failures were swallowed silently the
   * result looked like missing data rather than a throttled call — a
   * numbers table where one player had career stats and no break points
   * and the other had the exact reverse, on a match where both endpoints
   * return full data when called individually.
   *
   * Running them in sequence is slower per player and strictly more
   * reliable, which is the correct trade for a background job: nobody is
   * waiting on it, and a gap in the cache costs a whole factor. */
  const results = [];
  for (const [label, fn] of [
    ['status', () => fetchPlayerStatus(name)],
    ['careerSr', () => fetchCareerServeReturn(tour, id)],
    ['breakPoints', () => fetchBreakPoints(tour, id)],
    ['titles', () => fetchTitlesByTier(tour, id)],
    // Surface is per-match, so cache the whole year-by-year table and let
    // the brief scope it at read time.
    ['surfaceByYear', () => fetchSurfaceByYear(tour, id, null)],
    ['rankingTrend', () => fetchRankingTrend(tour, id)],
    ['style', () => fetchStyle(tour, name)],
  ]) {
    try {
      results.push(await fn());
    } catch (err) {
      console.warn(`[playerStats] ${name || id}: ${label} failed — ${err.message}`);
      results.push(null);
    }
  }
  const [status, careerSr, bp, titles, byYear, trend, style] = results;

  // Nothing came back at all — do not write an empty row that would then
  // be treated as a cache hit and suppress a real fetch later.
  if (!status && !careerSr && !bp && !titles && !byYear && !trend && !style) return false;

  const data = {
    playerId: String(id),
    tour,
    name: name || null,
    country: style?.country ?? null,
    rank: trend?.position ?? null,
    points: trend?.points ?? null,
    rankTrend: trend?.trend ?? null,
    plays: style?.plays ?? null,
    backhand: style?.backhand ?? null,
    status: status?.status ?? null,
    careerWins: careerSr?.won ?? null,
    careerMatches: careerSr?.matches ?? null,
    careerLosses: (careerSr?.matches != null && careerSr?.won != null)
      ? careerSr.matches - careerSr.won : null,
    // Falls back to the serve numbers inside match-stats when the
    // career serve/return call failed — same measures, second source.
    firstServeIn: careerSr?.firstServeIn ?? bp?.serveFallback?.firstServeIn ?? null,
    wonOnFirst: careerSr?.wonOnFirst ?? bp?.serveFallback?.wonOnFirst ?? null,
    wonOnSecond: careerSr?.wonOnSecond ?? bp?.serveFallback?.wonOnSecond ?? null,
    returnPtsWon: bp?.returnPtsWon ?? careerSr?.returnPtsWon ?? null,
    bpSaved: bp?.bpSaved ?? null,
    bpConverted: bp?.bpConverted ?? null,
    acesPerMatch: careerSr?.acesPerMatch ?? null,
    dfPerMatch: careerSr?.dfPerMatch ?? null,
    titles: titles ?? null,
    surfaceByYear: byYear ?? null,
    fetchedAt: new Date(),
  };

  await db.playerStat.upsert({
    where: { playerId_tour: { playerId: String(id), tour } },
    update: data,
    create: data,
  });
  return true;
}

/**
 * Warm the cache.
 *
 * `limit` caps a single run so a large board cannot produce a burst of
 * hundreds of calls; the rest are picked up next cycle. Stale rows are
 * refreshed before never-seen ones, so an existing player does not go
 * unrefreshed indefinitely behind a queue of new arrivals.
 */
async function warmPlayerStats({ limit = 40 } = {}) {
  const players = await playersOnTheBoard();
  if (!players.length) return { warmed: 0, skipped: 0, considered: 0 };

  const existing = await db.playerStat.findMany({
    where: { OR: players.map((p) => ({ playerId: p.id, tour: p.tour })) },
    select: { playerId: true, tour: true, fetchedAt: true,
              firstServeIn: true, careerMatches: true, bpSaved: true },
  });
  const known = new Map(existing.map((e) => [`${e.tour}:${e.playerId}`, e]));

  const now = Date.now();

  /* A PARTIAL ROW IS DUE, whatever its age.
   *
   * Freshness alone was the test, so a row written during a throttled
   * cycle — missing serve and career figures — counted as cached and
   * would not be retried for a full day. That is how 377 players ended
   * up with 205 having serve data: the gaps were locked in by the very
   * check meant to keep the cache current.
   *
   * Missing serve, career or break-point figures now makes a row due
   * immediately, so a throttled cycle is repaired by the next one. */
  const incomplete = (e) =>
    e.firstServeIn == null || e.careerMatches == null || e.bpSaved == null;

  const due = players.filter((p) => {
    const e = known.get(`${p.tour}:${p.id}`);
    if (!e) return true;
    if (incomplete(e)) return true;
    return (now - new Date(e.fetchedAt).getTime()) > STALE_AFTER_MS;
  });

  /* Incomplete rows first — they represent a player the brief will
   * silently under-report right now. Then never-cached, then merely
   * stale. */
  const rank = (p) => {
    const e = known.get(`${p.tour}:${p.id}`);
    if (e && incomplete(e)) return 0;
    if (!e) return 1;
    return 2;
  };
  due.sort((a, b) => rank(a) - rank(b));

  /* PACED, because the provider returns HTML 429 pages under load.
   *
   * Sequential calls within a player were not enough: forty players back
   * to back is still 280 requests as fast as the loop can issue them,
   * and the logs showed match-stats returning "429 Too Many Requests"
   * after three attempts. The result was 377 cached players of whom only
   * 205 had serve and career figures — 45% missing half their data,
   * which the brief then presents as absence rather than failure.
   *
   * A pause between players costs nothing that matters: this is a
   * background job, and forty players at 400ms apart is sixteen seconds
   * inside a ten-minute cycle. */
  const gapMs = Number(process.env.PLAYER_STAT_GAP_MS || 400);

  let warmed = 0, failed = 0;
  for (const p of due.slice(0, limit)) {
    try {
      if (await warmOne(p)) warmed++;
    } catch (err) {
      failed++;
      console.error(`[playerStats] ${p.name || p.id}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, gapMs));
  }

  console.log(`[playerStats] ${warmed} warmed of ${due.length} due (${players.length} on the board)`
    + (failed ? `, ${failed} failed` : ''));

  return { warmed, skipped: players.length - due.length, considered: players.length };
}

/** Read a cached row, or null when absent or too old to trust. */
async function cachedPlayerStat(tour, playerId) {
  if (!playerId) return null;
  const row = await db.playerStat.findUnique({
    where: { playerId_tour: { playerId: String(playerId), tour } },
  }).catch(() => null);
  if (!row) return null;
  if (Date.now() - new Date(row.fetchedAt).getTime() > STALE_AFTER_MS * 3) return null;
  return row;
}

function startPlayerStatWarming({ everyMs = 10 * 60 * 1000 } = {}) {
  warmPlayerStats().catch((e) => console.error(`[playerStats] initial run: ${e.message}`));
  setInterval(() => {
    warmPlayerStats().catch((e) => console.error(`[playerStats] ${e.message}`));
  }, everyMs);
  console.log(`[playerStats] warming every ${Math.round(everyMs / 60000)} minutes.`);
}

module.exports = { warmPlayerStats, cachedPlayerStat, startPlayerStatWarming };
