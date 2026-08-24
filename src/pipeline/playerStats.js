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
  const [status, careerSr, bp, titles, byYear, trend, style] = await Promise.all([
    fetchPlayerStatus(name).catch(() => null),
    fetchCareerServeReturn(tour, id).catch(() => null),
    fetchBreakPoints(tour, id).catch(() => null),
    fetchTitlesByTier(tour, id).catch(() => null),
    // Surface is per-match, so cache the whole year-by-year table and let
    // the brief scope it at read time.
    fetchSurfaceByYear(tour, id, null).catch(() => null),
    fetchRankingTrend(tour, id).catch(() => null),
    fetchStyle(tour, name).catch(() => null),
  ]);

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
    firstServeIn: careerSr?.firstServeIn ?? null,
    wonOnFirst: careerSr?.wonOnFirst ?? null,
    wonOnSecond: careerSr?.wonOnSecond ?? null,
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
    select: { playerId: true, tour: true, fetchedAt: true },
  });
  const freshness = new Map(existing.map((e) => [`${e.tour}:${e.playerId}`, e.fetchedAt]));

  const now = Date.now();
  const due = players.filter((p) => {
    const at = freshness.get(`${p.tour}:${p.id}`);
    return !at || (now - new Date(at).getTime()) > STALE_AFTER_MS;
  });

  // Stale-but-known first, then players never cached.
  due.sort((a, b) => {
    const aAt = freshness.get(`${a.tour}:${a.id}`);
    const bAt = freshness.get(`${b.tour}:${b.id}`);
    if (aAt && !bAt) return -1;
    if (!aAt && bAt) return 1;
    return 0;
  });

  let warmed = 0, failed = 0;
  for (const p of due.slice(0, limit)) {
    try {
      if (await warmOne(p)) warmed++;
    } catch (err) {
      failed++;
      console.error(`[playerStats] ${p.name || p.id}: ${err.message}`);
    }
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
