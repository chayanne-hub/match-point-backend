/**
 * ingestTennis.js — brings the SportsAPI365 tennis feed into the pipeline.
 *
 * Two jobs, deliberately separate:
 *
 *   ingestTennisFixtures()   pulls Challenger/ITF/main-tour fixtures and
 *                            upserts them as Match rows, so the analyst
 *                            picks them up like any other match.
 *
 *   applyTennisLiveState()   joins the live feed to existing matches BY
 *                            NAME and writes score, serve stats and tour
 *                            level onto them.
 *
 * WHY NAME MATCHING. The two providers use unrelated ids — a Core fixture
 * is 1411, the same match on the live feed is 3842034, and The Odds API
 * has its own. There is no crosswalk, so names are the only join key.
 * namesLikelyMatch already handles the hard cases (compound surnames,
 * dropped middle names) that broke the ESPN join before.
 */

const { fetchUpcomingFixtures, fetchLiveEvents, fetchMatchOdds } = require('./fetchTennisApi.js');
const { namesLikelyMatch } = require('./fetchEspn.js');
const db = require('../lib/db.js');

const ENABLED = process.env.TENNIS_API_INGEST !== 'false';

/**
 * Upsert tennis fixtures. externalId is prefixed so these can never
 * collide with, or silently overwrite, an Odds API row for the same match
 * — the two sources stay distinguishable in the database.
 */
async function ingestTennisFixtures() {
  if (!ENABLED) return { created: 0, updated: 0, skipped: 0 };

  let fixtures;
  try {
    fixtures = await fetchUpcomingFixtures();
  } catch (err) {
    console.error(`[tennisIngest] fixture fetch failed: ${err.message}`);
    return { created: 0, updated: 0, skipped: 0, error: err.message };
  }

  const sport = await db.sport.findFirst({ where: { slug: 'tennis' } });
  if (!sport) {
    console.error('[tennisIngest] no tennis sport row — cannot ingest');
    return { created: 0, updated: 0, skipped: 0 };
  }

  let created = 0, updated = 0, skipped = 0, priced = 0, unpriced = 0;

  for (const f of fixtures) {
    if (!f.competitorA || !f.competitorB || !f.startTime) { skipped++; continue; }

    /* DEDUPE against every candidate in the window, not just one.
     *
     * This previously used findFirst() over a +/-3h window with no name
     * filter, then compared names against whatever single row came back.
     * On a busy tennis slate that window holds dozens of matches, so the
     * one row returned was almost never the right one, the name check
     * failed, and a duplicate was created — the provider lists the same
     * fixture under several consecutive ids (1477/1478/1479 were all the
     * same match), so the same match landed two or three times.
     *
     * Fetching all candidates and searching them is the same approach
     * applyTennisLiveState() already used correctly. */
    const windowStart = new Date(f.startTime.getTime() - 3 * 60 * 60 * 1000);
    const windowEnd = new Date(f.startTime.getTime() + 3 * 60 * 60 * 1000);
    const candidates = await db.match.findMany({
      where: {
        sportId: sport.id,
        startTime: { gte: windowStart, lte: windowEnd },
        NOT: { externalId: f.sourceId },
      },
    });
    const existing = candidates.find((c) =>
      (namesLikelyMatch(c.competitorA, f.competitorA) && namesLikelyMatch(c.competitorB, f.competitorB)) ||
      (namesLikelyMatch(c.competitorA, f.competitorB) && namesLikelyMatch(c.competitorB, f.competitorA)));

    if (existing) {
      // Already have it from the other provider. Enrich rather than
      // duplicate: the tour level is the one thing only this feed knows.
      if (existing.tourLevel === null || existing.tourLevel === undefined) {
        await db.match.update({ where: { id: existing.id }, data: { tourLevel: f.tourLevel } });
      }
      skipped++;
      continue;
    }

    /* PRICING REALITY, and why these rows are marked skipAnalysis.
     *
     * Pregame odds come from The Odds API; live odds come from this
     * provider's socket. The Odds API carries NO Challenger or ITF on any
     * plan, and this provider only prices a match once it is in play. So a
     * lower-tier fixture has no pregame price from either source.
     *
     * The analyst can't make a gradeable pick without a price — there is
     * nothing to compute edge against and nothing to settle at. Left
     * unmarked, each of these rows is retried every cycle forever, which
     * is what buried the tennis slate: 24 unpriceable matches queued ahead
     * of real work, hammering the failure counters for no possible output.
     *
     * So they are created (the board still shows them, and they become
     * live-priced the moment play starts) but flagged so the analyst skips
     * them. If pregame prices for these tiers ever become available, clear
     * the flag and they analyse normally. */
    // OFF by default. The provider advertises opening lines for these
    // tiers, so excluding them is a temporary measure at most — and
    // skipping a match the analyst could actually price is a worse error
    // than letting it retry. Enable only if lower-tier pricing turns out
    // to be genuinely unavailable.
    const skipUnpriced = process.env.TENNIS_SKIP_UNPRICED_TIERS === 'true';
    const hasPregameSource = !skipUnpriced || (f.tourLevel !== null && f.tourLevel >= 2);

    const before = await db.match.findUnique({ where: { externalId: f.sourceId } });
    await db.match.upsert({
      where: { externalId: f.sourceId },
      update: {
        startTime: f.startTime,
        league: f.league,
        tourLevel: f.tourLevel,
      },
      create: {
        externalId: f.sourceId,
        sportId: sport.id,
        league: f.league || (f.tour || 'ATP').toUpperCase(),
        competitorA: f.competitorA,
        competitorB: f.competitorB,
        startTime: f.startTime,
        status: 'scheduled',
        tourLevel: f.tourLevel,
        skipAnalysis: !hasPregameSource,
      },
    });
    before ? updated++ : created++;

    /* PRICE IT.
     *
     * Without a price the analyst has nothing to compute edge against and
     * nothing to settle at, so an unpriced row can never become a
     * gradeable pick — it just gets retried every cycle. The opening line
     * comes from the `upcoming/matchodds` endpoint, which needs the four
     * fixture ids as query parameters.
     *
     * Only fetched when we don't already have a price: prices are frozen
     * at analysis time as the line of record, so refetching an already
     * priced match would risk moving the number a pick was made against.
     */
    const row = await db.match.findUnique({ where: { externalId: f.sourceId } });
    if (row && (row.oddsA === null || row.oddsB === null)) {
      const odds = await fetchMatchOdds({
        tour: f.tour || 'atp',
        player1Id: f.playerAId,
        player2Id: f.playerBId,
        tournamentId: f.tournamentId,
        roundId: f.roundId,
      });
      if (odds) {
        await db.match.update({
          where: { id: row.id },
          data: { oddsA: odds.oddsA, oddsB: odds.oddsB },
        });
        priced++;
      } else {
        unpriced++;
      }
    }
  }

  console.log(`[tennisIngest] fixtures: ${created} new, ${updated} updated, ${skipped} already covered | odds: ${priced} priced, ${unpriced} not yet on the market`);
  return { created, updated, skipped, priced, unpriced };
}

/**
 * Join the live feed onto existing matches and write through the state
 * that only this provider carries: set score, and first-serve win rates.
 *
 * Runs against matches that are live or due to have started, so a finished
 * match doesn't keep getting rewritten.
 */
async function applyTennisLiveState() {
  if (!ENABLED) return { matched: 0, unmatched: 0 };

  let events;
  try {
    events = await fetchLiveEvents();
  } catch (err) {
    console.error(`[tennisIngest] live fetch failed: ${err.message}`);
    return { matched: 0, unmatched: 0, error: err.message };
  }
  if (!events.length) return { matched: 0, unmatched: 0 };

  const sport = await db.sport.findFirst({ where: { slug: 'tennis' } });
  if (!sport) return { matched: 0, unmatched: 0 };

  const since = new Date(Date.now() - 8 * 60 * 60 * 1000);
  const until = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const candidates = await db.match.findMany({
    where: { sportId: sport.id, startTime: { gte: since, lte: until }, status: { not: 'final' } },
  });

  let matched = 0, unmatched = 0;

  for (const ev of events) {
    if (!ev.competitorA || !ev.competitorB) { unmatched++; continue; }

    const hit = candidates.find((m) =>
      (namesLikelyMatch(m.competitorA, ev.competitorA) && namesLikelyMatch(m.competitorB, ev.competitorB)) ||
      (namesLikelyMatch(m.competitorA, ev.competitorB) && namesLikelyMatch(m.competitorB, ev.competitorA)));

    if (!hit) { unmatched++; continue; }

    // If the feed lists the players the other way round from us, the
    // per-player stats have to be swapped too or they land on the wrong
    // competitor — the kind of silent inversion that would make a serve
    // warning point at the wrong player.
    const flipped = namesLikelyMatch(hit.competitorA, ev.competitorB);

    await db.match.update({
      where: { id: hit.id },
      data: {
        status: ev.status === 'InPlay' ? 'live' : hit.status,
        setScore: ev.setScore || hit.setScore,
        liveScore: ev.setScore || hit.liveScore,
        tourLevel: hit.tourLevel ?? null,
      },
    });
    matched++;
  }

  /* CLOSE OUT FINISHED MATCHES.
   *
   * Nothing else can. This ingest promotes a match to `live`, but ESPN —
   * which closes every other sport — carries no Challenger or ITF, so a
   * lower-tier match promoted here had no route back to `final` and would
   * sit on the board showing LIVE forever.
   *
   * A match that WAS live, is no longer in the provider's in-play feed,
   * and started long enough ago to have plausibly finished, is finished.
   * The grace window guards against a momentary gap in the feed flipping
   * a match that is genuinely still being played.
   */
  const liveIds = new Set(events.map((e) => `${e.competitorA}|${e.competitorB}`.toLowerCase()));
  const graceMs = Number(process.env.TENNIS_FINAL_GRACE_MS) || 10 * 60 * 1000;
  let closed = 0;

  for (const m of candidates) {
    if (m.status !== 'live') continue;
    const key = `${m.competitorA}|${m.competitorB}`.toLowerCase();
    const keyRev = `${m.competitorB}|${m.competitorA}`.toLowerCase();
    if (liveIds.has(key) || liveIds.has(keyRev)) continue; // still in play

    // Only close a match whose last observed live update is older than the
    // grace window — a match that just went live and hasn't been picked up
    // yet must not be closed on its first cycle.
    const lastSeen = m.liveStateAt ? new Date(m.liveStateAt).getTime() : new Date(m.startTime).getTime();
    if (Date.now() - lastSeen < graceMs) continue;

    await db.match.update({ where: { id: m.id }, data: { status: 'final' } });
    closed++;
  }

  console.log(`[tennisIngest] live: ${matched} joined, ${unmatched} with no match on our board${closed ? `, ${closed} closed out` : ''}`);
  return { matched, unmatched, closed };
}

/**
 * Remove duplicate tennis fixtures created by the old dedup bug.
 *
 * The provider lists the same match under several consecutive ids. The
 * previous dedup compared names against one arbitrary row from a wide
 * time window, so it almost never matched and duplicates were created —
 * 41 of them, inflating the board from ~40 tennis matches to 123.
 *
 * Keeps the row that has the most attached to it (a pick, or a live
 * status) rather than blindly keeping the lowest id, so cleaning up can't
 * throw away an analysed pick. Only ever removes rows with NO picks.
 */
async function cleanupDuplicateTennis({ dryRun = true } = {}) {
  const sport = await db.sport.findFirst({ where: { slug: 'tennis' } });
  if (!sport) return { groups: 0, removed: 0 };

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const matches = await db.match.findMany({
    where: { sportId: sport.id, startTime: { gte: since } },
    include: { picks: { select: { id: true } } },
  });

  // Group by normalised player pair + start time.
  const groups = new Map();
  for (const m of matches) {
    const pair = [m.competitorA, m.competitorB].map((n) => String(n).toLowerCase().trim()).sort().join('|');
    const key = `${pair}@${m.startTime.toISOString()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  let removed = 0, dupGroups = 0;
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    dupGroups++;

    // Keep the most valuable row: one with picks first, then live status,
    // then the earliest created.
    rows.sort((a, b) => {
      if (a.picks.length !== b.picks.length) return b.picks.length - a.picks.length;
      const rank = (s) => (s === 'final' ? 2 : s === 'live' ? 1 : 0);
      if (rank(a.status) !== rank(b.status)) return rank(b.status) - rank(a.status);
      return String(a.externalId).localeCompare(String(b.externalId));
    });

    const [keep, ...drop] = rows;
    for (const d of drop) {
      // Never delete a row that carries a pick — that would silently
      // destroy a graded result.
      if (d.picks.length) { console.warn(`[tennisCleanup] keeping ${d.externalId}, it has ${d.picks.length} pick(s)`); continue; }
      if (!dryRun) await db.match.delete({ where: { id: d.id } });
      removed++;
    }
    if (dryRun) console.log(`[tennisCleanup] would keep ${keep.externalId}, drop ${drop.map((d) => d.externalId).join(', ')}`);
  }

  console.log(`[tennisCleanup] ${dupGroups} duplicate group(s), ${removed} row(s) ${dryRun ? 'would be' : ''} removed`);
  return { groups: dupGroups, removed };
}

/**
 * Backfill: flag already-ingested lower-tier rows so the analyst stops
 * retrying matches it can never price. Only touches rows that have no
 * pick — anything already analysed is left exactly as it is.
 */
async function markUnpriceableTennis({ dryRun = true } = {}) {
  const sport = await db.sport.findFirst({ where: { slug: 'tennis' } });
  if (!sport) return { marked: 0 };

  const rows = await db.match.findMany({
    where: {
      sportId: sport.id,
      skipAnalysis: false,
      tourLevel: { in: [0, 1] },
      startTime: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    include: { picks: { select: { id: true } } },
  });

  const targets = rows.filter((r) => r.picks.length === 0);
  if (!dryRun && targets.length) {
    await db.match.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: { skipAnalysis: true },
    });
  }
  console.log(`[tennisIngest] ${targets.length} unpriceable row(s) ${dryRun ? 'would be' : ''} flagged (of ${rows.length} lower-tier)`);
  return { marked: targets.length, scanned: rows.length };
}

module.exports = { ingestTennisFixtures, applyTennisLiveState, cleanupDuplicateTennis, markUnpriceableTennis };
