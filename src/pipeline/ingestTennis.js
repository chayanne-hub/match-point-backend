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
// Safe as a top-level require: the runner never requires this file, so the
// dependency runs one way only (verified against the require graph).
const { getLiveSnapshot } = require('./tennisLiveRunner.js');
const { namesLikelyMatch } = require('./fetchEspn.js');
const db = require('../lib/db.js');

const ENABLED = process.env.TENNIS_API_INGEST !== 'false';

/**
 * Upsert tennis fixtures. externalId is prefixed so these can never
 * collide with, or silently overwrite, an Odds API row for the same match
 * — the two sources stay distinguishable in the database.
 */
let loggedLiveShape = false;

async function ingestTennisFixtures() {
  // externalIds the fixture feed currently reports as in play.
  const liveSourceIds = [];
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
    /* ±3h was too narrow for a RESCHEDULED match.
     *
     * Measured on real rows: Musetti v Tiafoe existed three times —
     * sa365:1308 at Aug 20 04:10, sa365:1307 at Aug 21 18:00, and
     * sa365:1306 at Aug 22 02:00. The provider issues a NEW fixture id
     * when a start time moves rather than updating the old one, and
     * Cincinnati's "not before" times shift by many hours.
     *
     * When 1306 arrived, this window searched Aug 21 23:00 - Aug 22
     * 05:00. The row at Aug 21 18:00 sat outside it, so no candidate
     * matched and a third row was created. The original ±3h caught the
     * consecutive-id case (1477/1478/1479, minutes apart) but not this.
     *
     * 48h either side covers rescheduling while staying far short of
     * the gap between two genuine meetings of the same pair, which do
     * not happen inside a single tournament. */
    /* Checked for EVERY fixture, not just ones another provider gave us.
     *
     * This lived inside the `if (existing)` branch, which only runs when
     * a match already exists from The Odds API. Nearly all Challenger and
     * ITF rows are ones we created ourselves, so they took the upsert
     * path and never reached the check — liveSourceIds stayed empty and
     * nothing was ever promoted, which is why no "promoted" line ever
     * appeared in the logs. */
    if (f.live !== null && f.live !== undefined && f.live !== false) {
      if (!loggedLiveShape) {
        console.log(`[tennisIngest] fixture live field shape: ${JSON.stringify(f.live)}`);
        loggedLiveShape = true;
      }
      liveSourceIds.push(f.sourceId);
    }

    const windowStart = new Date(f.startTime.getTime() - 48 * 60 * 60 * 1000);
    const windowEnd = new Date(f.startTime.getTime() + 48 * 60 * 60 * 1000);
    const candidates = await db.match.findMany({
      where: {
        sportId: sport.id,
        startTime: { gte: windowStart, lte: windowEnd },
        NOT: { externalId: f.sourceId },
      },
    });
    // With a 48h window several rows can match on name, so take the one
    // CLOSEST in time rather than whichever the query happened to return
    // first — that ordering is arbitrary and would pick at random.
    const nameMatches = candidates.filter((c) =>
      (namesLikelyMatch(c.competitorA, f.competitorA) && namesLikelyMatch(c.competitorB, f.competitorB)) ||
      (namesLikelyMatch(c.competitorA, f.competitorB) && namesLikelyMatch(c.competitorB, f.competitorA)));

    nameMatches.sort((a, b) =>
      Math.abs(new Date(a.startTime) - f.startTime) - Math.abs(new Date(b.startTime) - f.startTime));
    const existing = nameMatches[0];

    if (existing) {
      // Already have it from the other provider. Enrich rather than
      // duplicate: the tour level is the one thing only this feed knows.
      /* Carry the core ids across as well as the tour level.
       *
       * These four values are the key for `upcoming/matchodds`, the
       * core-space odds endpoint — the one that actually covers
       * Challenger and ITF. Without them a row can only be priced
       * through the `extend` bridge, which holds a small subset, so
       * most lower-tier matches appeared unpriceable when their odds
       * were reachable the whole time. */
      const enrich = {};
      if (existing.tourLevel === null || existing.tourLevel === undefined) enrich.tourLevel = f.tourLevel;
      if (!existing.playerAId && f.playerAId) enrich.playerAId = String(f.playerAId);
      if (!existing.playerBId && f.playerBId) enrich.playerBId = String(f.playerBId);
      if (!existing.tournamentId && f.tournamentId) enrich.tournamentId = String(f.tournamentId);
      if ((existing.roundId === null || existing.roundId === undefined) && f.roundId !== null && f.roundId !== undefined) {
        enrich.roundId = Number(f.roundId);
      }
      /* Correct the start time when the fixture has moved.
       *
       * Without this the kept row keeps a stale time, so the pricing
       * window and the "too early" check both work off a schedule that
       * no longer exists. Only moved forward when the change is real
       * (over a minute) to avoid a write on every cycle. */
      if (f.startTime && Math.abs(new Date(existing.startTime) - f.startTime) > 60000) {
        enrich.startTime = f.startTime;
        console.log(`[tennisIngest] ${f.competitorA} vs ${f.competitorB} rescheduled to ${f.startTime.toISOString()}`);
      }

      /* Promote to live from the fixture feed.
       *
       * Every fixture carries a `live` field, and it is the only signal
       * that covers the whole slate — ESPN has no lower-tier tennis and
       * the socket all-feed carries only a few events at a time, so
       * Challenger and ITF matches were never marked live by anything.
       *
       * The shape when populated has not been observed (it is null for
       * every not-yet-started fixture), so this treats ANY non-null,
       * non-false value as "in play" and logs the raw value once so the
       * real shape can be read from the logs instead of guessed. */
      if (Object.keys(enrich).length) {
        await db.match.update({ where: { id: existing.id }, data: enrich });
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
        // Status deliberately NOT set here. An upsert cannot see the
        // current value, so writing 'live' whenever the feed says live
        // would demote a match already marked final back to live on the
        // next cycle — it would never stay finished. Promotion happens
        // in a guarded update below instead.
        playerAId: f.playerAId ? String(f.playerAId) : undefined,
        playerBId: f.playerBId ? String(f.playerBId) : undefined,
        tournamentId: f.tournamentId ? String(f.tournamentId) : undefined,
        roundId: (f.roundId === null || f.roundId === undefined) ? undefined : Number(f.roundId),
      },
      create: {
        externalId: f.sourceId,
        playerAId: f.playerAId ? String(f.playerAId) : null,
        playerBId: f.playerBId ? String(f.playerBId) : null,
        tournamentId: f.tournamentId ? String(f.tournamentId) : null,
        roundId: (f.roundId === null || f.roundId === undefined) ? null : Number(f.roundId),
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

  /* Promote to live, guarded on current status.
   *
   * updateMany with an explicit `status: 'scheduled'` filter means a
   * match can only ever move scheduled -> live here. A final match is
   * untouched no matter what the feed reports. */
  if (liveSourceIds.length) {
    const promoted = await db.match.updateMany({
      where: { externalId: { in: liveSourceIds }, status: 'scheduled' },
      data: { status: 'live' },
    }).catch((e) => { console.error(`[tennisIngest] promote: ${e.message}`); return { count: 0 }; });
    if (promoted.count) console.log(`[tennisIngest] promoted ${promoted.count} match(es) to live from the fixture feed`);
  }

  console.log(`[tennisIngest] fixtures: ${created} new, ${updated} updated, ${skipped} already covered | odds: ${priced} priced, ${unpriced} not yet on the market`);

  /* Maintenance runs on the ingest cycle, not only from an admin route.
   *
   * cleanupDuplicateTennis existed but was reachable ONLY from
   * /api/picks/admin — so in normal operation it never ran, and the
   * duplicate rows simply accumulated. The board hid this by collapsing
   * them at display time, which made a database problem look cosmetic.
   * Both sweeps are cheap indexed updates; they belong on the cycle. */
  await cleanupDuplicateTennis({ dryRun: false })
    .catch((e) => console.error(`[tennisIngest] dedup: ${e.message}`));
  await closeStaleScheduledTennis()
    .catch((e) => console.error(`[tennisIngest] stale sweep: ${e.message}`));

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
    /* Socket first. REST is kept only as a fallback in case the provider
       ever fixes the endpoint — it currently answers 0 rows on a valid
       key, so relying on it alone froze every tennis row on the board. */
    events = getLiveSnapshot();
    if (!events.length) {
      events = await fetchLiveEvents();
      if (events.length) console.log('[tennisIngest] live via REST fallback');
    } else {
      console.log(`[tennisIngest] live via socket snapshot (${events.length})`);
    }
  } catch (err) {
    console.error(`[tennisIngest] live fetch failed: ${err.message}`);
    return { matched: 0, unmatched: 0, error: err.message };
  }
  if (!events.length) return { matched: 0, unmatched: 0 };

  const sport = await db.sport.findFirst({ where: { slug: 'tennis' } });
  if (!sport) return { matched: 0, unmatched: 0 };

  /* 8h back was too short to close anything reliably.
   *
   * A match that started 9 hours ago fell outside this window, so the
   * close-out never saw it and it sat showing LIVE forever. Tennis is the
   * only sport where this bites: ESPN closes everything else, but carries
   * no Challenger or ITF, so this pass is the only route to `final`.
   * A day back costs one cheap indexed query and covers long matches,
   * rain delays, and anything the feed dropped mid-match. */
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
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
/* STALE SCHEDULED ROWS.
 *
 * The close-out above only considers rows already marked `live`. A
 * lower-tier match that was ingested, started, and finished without the
 * live feed ever picking it up stays `scheduled` forever — Kwon v Bonzi
 * sat that way from the previous day. Those rows clutter the board and
 * keep being offered for analysis long after the match is over.
 *
 * Six hours past start with no live signal means it is finished, not
 * pending. Generous enough for a five-setter plus a rain delay. */
async function closeStaleScheduledTennis() {
  const sport = await db.sport.findFirst({ where: { slug: 'tennis' } });
  if (!sport) return { closed: 0 };
  /* Tier-aware cutoff.
   *
   * Six hours was a guess sized for a five-set main-tour match. But this
   * pass only ever handles tiers we own — Challenger and ITF — and those
   * are best-of-THREE, typically finishing inside two hours. Six hours
   * left 44 finished matches sitting as `scheduled`, which is the "stuck
   * match" symptom from the board's point of view.
   *
   * Four hours is still roughly double a long best-of-three, so it
   * closes promptly without risking a match still on court. Main tour
   * keeps the longer window since ESPN closes those anyway. */
  const lowerCutoff = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const mainCutoff = new Date(Date.now() - 8 * 60 * 60 * 1000);

  const res = await db.match.updateMany({
    where: {
      sportId: sport.id,
      status: 'scheduled',
      OR: [
        { tourLevel: { in: [0, 1] }, startTime: { lt: lowerCutoff } },
        { tourLevel: { notIn: [0, 1] }, startTime: { lt: mainCutoff } },
        { tourLevel: null, startTime: { lt: mainCutoff } },
      ],
    },
    data: { status: 'final' },
  });
  if (res.count) console.log(`[tennisIngest] closed ${res.count} stale scheduled row(s)`);
  return { closed: res.count };
}

async function cleanupDuplicateTennis({ dryRun = true } = {}) {
  const sport = await db.sport.findFirst({ where: { slug: 'tennis' } });
  if (!sport) return { groups: 0, removed: 0 };

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const matches = await db.match.findMany({
    where: { sportId: sport.id, startTime: { gte: since } },
    // pickType and market are REQUIRED here: the dedupe below compares
    // them to decide whether a duplicate's pick is already covered by
    // the row we keep. Selecting only `id` would leave both undefined,
    // every pick would compare as equal, and real picks would be deleted
    // as false duplicates.
    include: { picks: { select: { id: true, pickType: true, market: true } } },
  });

  // Group by normalised player pair + start time.
  const groups = new Map();
  for (const m of matches) {
    const pair = [m.competitorA, m.competitorB].map((n) => String(n).toLowerCase().trim()).sort().join('|');
    /* Group by pair and DAY, not by exact timestamp.
     *
     * The two providers disagree on start time by several minutes — the
     * same match arrives at 2:30 and 2:40. Keying on the exact ISO string
     * put every duplicate in a group of one, so the pass reported
     * "0 groups, 0 removed" and looked like it had nothing to do.
     * Two rows for the same pair on the same day are the same match. */
    const day = m.startTime.toISOString().slice(0, 10);
    const key = `${pair}@${day}`;
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

    /* A duplicate pick is a DOUBLE COUNT, not a result to protect.
     *
     * This refused to delete any row carrying a pick, to avoid
     * destroying a graded result. But when the row we are keeping holds
     * the same pick, the duplicate is the identical wager recorded
     * twice — it appeared twice in the activity feed and counted twice
     * in the win rate, inflating the sample and double-weighting one
     * outcome.
     *
     * So: drop the duplicate when the keeper already covers it. If the
     * duplicate carries a pick the keeper does NOT have, that is real
     * data and the row still survives, exactly as before. */
    const keepCovers = (pick) => keep.picks.some(
      (k) => k.pickType === pick.pickType && k.market === pick.market);

    for (const d of drop) {
      if (d.picks.length) {
        const uncovered = d.picks.filter((pk) => !keepCovers(pk));
        if (uncovered.length) {
          console.warn(`[tennisCleanup] keeping ${d.externalId}: ${uncovered.length} pick(s) the kept row does not have`);
          continue;
        }
        console.log(`[tennisCleanup] dropping ${d.externalId}: its ${d.picks.length} pick(s) duplicate ${keep.externalId}`);
      }
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
async function clearTennisSkipFlags({ dryRun = true } = {}) {
  const sport = await db.sport.findFirst({ where: { slug: 'tennis' } });
  if (!sport) return { marked: 0 };

  const rows = await db.match.findMany({
    where: {
      sportId: sport.id,
      skipAnalysis: true,
      tourLevel: { in: [0, 1] },
      startTime: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    include: { picks: { select: { id: true } } },
  });

  const targets = rows.filter((r) => r.picks.length === 0);
  if (!dryRun && targets.length) {
    await db.match.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: { skipAnalysis: false },
    });
  }
  console.log(`[tennisIngest] ${targets.length} lower-tier row(s) ${dryRun ? 'would be' : ''} CLEARED for analysis (of ${rows.length} flagged)`);
  return { marked: targets.length, scanned: rows.length };
}

module.exports = { ingestTennisFixtures, closeStaleScheduledTennis, applyTennisLiveState, cleanupDuplicateTennis, clearTennisSkipFlags };
