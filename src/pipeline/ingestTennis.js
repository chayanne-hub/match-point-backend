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

const { fetchUpcomingFixtures, fetchLiveEvents, fetchMatchOdds, resolveExtendId, fetchPlayerRecentResult } = require('./fetchTennisApi.js');
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
      /* Tour ('atp'/'wta'). Every player and h2h endpoint is tour-scoped,
       * so losing this meant every WTA lookup queried the men's index and
       * came back empty. */
      if (!existing.tour && f.tour) enrich.tour = String(f.tour).toLowerCase();
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

      /* PRICE EXISTING ROWS TOO.
       *
       * This branch used to `continue` straight past the odds fetch
       * further down, so only a fixture seen for the FIRST time ever got
       * a price. Every row ingested on an earlier cycle came back as
       * "already covered", skipped pricing, and stayed unpriced forever —
       * which is why the board read "0 analysed, N not yet priced" every
       * cycle with 57 covered fixtures sitting there.
       *
       * Tennis prices appear late (often under an hour before start, and
       * later still at ITF level), so the fixture is nearly always
       * created BEFORE its price exists. Pricing only on first sight is
       * therefore pricing at exactly the moment the odds are least
       * likely to be available. */
      /* Bounded by start time, or this costs a call per covered fixture
       * per cycle — 57 rows every 15 minutes, nearly all of them for
       * matches hours away whose price does not exist yet. Six hours is
       * comfortably wider than the window in which tennis prices
       * actually appear, and env-tunable if that proves wrong. */
      const hoursOut = (new Date(existing.startTime).getTime() - Date.now()) / 3600000;
      /* Look 48 hours ahead, not 6.
       *
       * The analyser now acts on any match that HAS a price, so pricing
       * is the thing that decides when a match becomes analysable. A
       * 6-hour lookahead therefore reimposed the very cutoff we just
       * removed: no price would exist earlier, so nothing could be
       * analysed earlier either. Main-tour markets open days out. */
      const priceLookaheadH = Number(process.env.TENNIS_PRICE_LOOKAHEAD_H || 48);
      const worthPricing = hoursOut > -2 && hoursOut < priceLookaheadH;

      /* bestOddsA/bestOddsB — there is NO `oddsA` column on Match.
       *
       * This read `existing.oddsA === null`, which for a column that
       * does not exist is `undefined === null` — FALSE. So the guard
       * never passed, pricing never ran, and the cycle reported
       * "0 priced, 0 not yet on the market" every time while 76 rows sat
       * unpriced. A misspelled column fails silently on read and only
       * throws on write, which is why this looked like "no odds
       * available" rather than a bug. */
      if (worthPricing && (existing.bestOddsA === null || existing.bestOddsB === null)) {
        const odds = await fetchMatchOdds({
          tour: f.tour || 'atp',
          player1Id: f.playerAId ?? existing.playerAId,
          player2Id: f.playerBId ?? existing.playerBId,
          tournamentId: f.tournamentId ?? existing.tournamentId,
          roundId: f.roundId ?? existing.roundId,
        }).catch(() => null);

        if (odds && odds.oddsA !== null && odds.oddsB !== null) {
          await db.match.update({
            where: { id: existing.id },
            // fetchMatchOdds returns oddsA/oddsB (the API's field names);
            // they are stored in bestOddsA/bestOddsB, which is what the
            // analyser reads.
            data: {
              bestOddsA: odds.bestOddsA ?? odds.oddsA,
              bestOddsB: odds.bestOddsB ?? odds.oddsB,
              ...(odds.bestBookA ? { bestBookA: odds.bestBookA } : {}),
              ...(odds.bestBookB ? { bestBookB: odds.bestBookB } : {}),
            },
          });
          priced++;
        } else {
          unpriced++;
        }
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
        tour: f.tour ? String(f.tour).toLowerCase() : undefined,
        roundId: (f.roundId === null || f.roundId === undefined) ? undefined : Number(f.roundId),
      },
      create: {
        externalId: f.sourceId,
        playerAId: f.playerAId ? String(f.playerAId) : null,
        playerBId: f.playerBId ? String(f.playerBId) : null,
        tournamentId: f.tournamentId ? String(f.tournamentId) : null,
        tour: f.tour ? String(f.tour).toLowerCase() : null,
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
    if (row && (row.bestOddsA === null || row.bestOddsB === null)) {
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
          data: {
            bestOddsA: odds.bestOddsA ?? odds.oddsA,
            bestOddsB: odds.bestOddsB ?? odds.oddsB,
            ...(odds.bestBookA ? { bestBookA: odds.bestBookA } : {}),
            ...(odds.bestBookB ? { bestBookB: odds.bestBookB } : {}),
          },
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

  /* Ask the provider about anything the socket feed did not cover. */
  const started = await promoteStartedMatches().catch((e) => {
    console.error(`[tennisIngest] promote sweep: ${e.message}`);
    return { promoted: 0, checked: 0 };
  });
  if (started.checked) {
    console.log(`[tennisIngest] start check: ${started.promoted} moved to live of ${started.checked} checked`);
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

/* Sets won from a score string, shared by both close-out paths.
 *
 * Lived only inside analyzeTennisUpcoming. The stale sweep needed the
 * identical rules — decided sets only, leader takes an early ending — and
 * two copies would have drifted the moment either changed.
 */
function setsWonFromScore(score, status) {
  if (!score) return null;
  let a = 0, b = 0;
  /* Two feeds, two separators.
   *
   * The extend endpoint returns "6-2,6-3" while h2h/recent returns
   * "6-3 6-4" with spaces and tiebreak detail like "7-6(6)". Splitting
   * on commas alone silently produced ONE set from a space-separated
   * score, which would have graded matches on a single set.
   *
   * Split on either, and strip the tiebreak parenthetical — "7-6(6)"
   * is a 7-6 set; the tiebreak points do not affect who won it. */
  String(score).replace(/\([^)]*\)/g, '').split(/[,\s]+/).forEach((chunk) => {
    const [x, y] = chunk.trim().split('-').map(Number);
    if (isNaN(x) || isNaN(y)) return;
    const decided = (x >= 6 || y >= 6) && (Math.abs(x - y) >= 2 || x === 7 || y === 7);
    if (!decided) return;
    if (x > y) a++; else if (y > x) b++;
  });

  if (/retired|walkover|w\/o/i.test(status || '')) {
    const last = String(score).split(',').pop().trim().split('-').map(Number);
    const lastDecided = !isNaN(last[0]) && !isNaN(last[1]) &&
      (last[0] >= 6 || last[1] >= 6) &&
      (Math.abs(last[0] - last[1]) >= 2 || last[0] === 7 || last[1] === 7);
    if (!lastDecided && !isNaN(last[0]) && !isNaN(last[1]) && last[0] !== last[1]) {
      if (last[0] > last[1]) a = Math.max(a, b + 1); else b = Math.max(b, a + 1);
    }
  }

  return (a || b) ? { a, b } : null;
}

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
  /* THE RESULT DECIDES, NOT A TIMER.
   *
   * These cutoffs were 4h and 8h past start, so a match that finished in
   * 70 minutes stayed in "Match Analyzed" for another three hours —
   * advertised as upcoming while the result was already published.
   *
   * The h2h lookup tells us definitively whether a match is over, so we
   * start ASKING once a match is plausibly finished rather than waiting
   * out a worst-case duration. 45 minutes is shorter than any real
   * completed match, so a lookup that returns a score at that point is
   * reporting a genuine result, not a match in progress.
   *
   * Nothing is closed without a result until the 12h backstop below, so
   * asking early is cheap and cannot close a live match early. */
  const lowerCutoff = new Date(Date.now() - 45 * 60 * 1000);
  const mainCutoff = new Date(Date.now() - 45 * 60 * 1000);

  /* TRY FOR A REAL RESULT BEFORE CLOSING.
   *
   * This used to write `status: 'final'` and nothing else. gradePick()
   * returns null without homeScore/awayScore, so every match closed this
   * way could never be graded — it left the board, left the record, and
   * counted for nothing. ESPN used to cover that for main tour; with
   * ESPN off for tennis, this pass is the last stop for any match the
   * extend feed does not carry.
   *
   * So: resolve each stale row first and write the score when we get
   * one. Anything still unresolved is closed anyway (a match hours past
   * its start is not pending), but counted separately and logged — an
   * ungraded match should be a visible number, not a silent hole in the
   * win rate. */
  const stale = await db.match.findMany({
    where: {
      sportId: sport.id,
      /* Also revisit FINAL rows that were closed without a score.
       *
       * The sweep only looked at scheduled and live rows, so a match
       * closed unscored — by the 12h backstop, or by an earlier version
       * of this code — was never looked at again. Its pick could never
       * grade, and it vanished from the record silently: final on the
       * board, absent from the win rate.
       *
       * Results publish late, so a row unresolvable an hour ago is often
       * resolvable now. Bounded to the last 48h; past that the feed has
       * moved on and the match is genuinely lost. */
      OR: [
        { status: { in: ['scheduled', 'live'] } },
        { status: 'final', homeScore: null,
          startTime: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) } },
      ],
      // Both tiers now share the same 45-minute threshold, so this is a
      // single condition rather than an OR that would clash with the
      // status OR above.
      startTime: { lt: lowerCutoff },
    },
    select: { id: true, competitorA: true, competitorB: true, startTime: true,
              playerAId: true, playerBId: true, status: true },
  });
  if (!stale.length) return { closed: 0, scored: 0, unscored: 0 };

  let scored = 0, unscored = 0;

  for (const m of stale) {
    const data = { status: 'final' };

    /* PLAYER LOOKUP FIRST — it is the only all-tier result source.
     *
     * h2h/recent covers Challenger, ITF and main tour alike and matches
     * on player id rather than name. The extend resolve is kept as a
     * fallback for rows without stored player ids. */
    let byPlayer = null;
    if (m.playerAId && m.playerBId) {
      byPlayer = await fetchPlayerRecentResult('atp', m.playerAId, m.playerBId, m.startTime)
        .catch(() => null);
      if (!byPlayer) {
        // Some draws are filed under wta; try the other tour before giving up.
        byPlayer = await fetchPlayerRecentResult('wta', m.playerAId, m.playerBId, m.startTime)
          .catch(() => null);
      }
    }

    if (byPlayer && byPlayer.score) {
      const sets = setsWonFromScore(byPlayer.score, null);
      data.setScore = byPlayer.score;
      data.liveScore = byPlayer.score;

      /* isWin is authoritative and relative to the player we queried,
       * which is competitorA. Derive the scoreline from it rather than
       * from set counting: a retirement can leave the winner with fewer
       * completed sets, and this field states the outcome outright. */
      if (sets) {
        const aWon = byPlayer.queriedPlayerWon;
        let hi = Math.max(sets.a, sets.b), lo = Math.min(sets.a, sets.b);
        // A retirement can leave completed sets level (6-4 2-5 -> 1-1).
        // gradeMoneyline cannot resolve a tie, and isWin already tells us
        // who advanced, so the winner is given the higher number.
        if (hi === lo) hi = lo + 1;
        data.homeScore = aWon ? hi : lo;
        data.awayScore = aWon ? lo : hi;
      } else {
        data.homeScore = byPlayer.queriedPlayerWon ? 1 : 0;
        data.awayScore = byPlayer.queriedPlayerWon ? 0 : 1;
      }
      scored++;
    } else {
      let resolved = null;
      try {
        resolved = await resolveExtendId(m.competitorA, m.competitorB, m.startTime);
      } catch { /* treated as unresolved below */ }

      if (resolved && resolved.score) {
        const sets = setsWonFromScore(resolved.score, resolved.status);
        if (sets) {
          data.setScore = resolved.score;
          data.liveScore = resolved.score;
          data.homeScore = sets.a;
          data.awayScore = sets.b;
          scored++;
        }
      }
    }

    if (data.homeScore === undefined) {
      unscored++;
      // Already final and still unresolvable — nothing to do but leave it.
      if (m.status === 'final') continue;

      /* Retry, but not forever.
       *
       * Results lag by minutes, so leaving a match open lets the next
       * cycle try again — that part is right. With no limit, though, a
       * match whose result never arrives stays `scheduled` permanently
       * and sits in "Match Analyzed" long after it finished. That is
       * exactly what happened to Safiullin and Royer.
       *
       * So retry for 12 hours, then close it anyway. An ungraded
       * finished match is a small hole in the record; a completed match
       * advertised on the board as upcoming is a visible lie about what
       * the product is showing. */
      const age = Date.now() - new Date(m.startTime).getTime();
      if (age < 12 * 60 * 60 * 1000) continue;

      console.warn(`[tennisIngest] closing ${m.competitorA} vs ${m.competitorB} with no result after 12h — it cannot be graded`);
    }

    await db.match.update({ where: { id: m.id }, data })
      .catch((e) => console.error(`[tennisIngest] stale close ${m.competitorA}: ${e.message}`));
  }

  console.log(`[tennisIngest] stale sweep: ${scored} closed with a final score, ${unscored} still unresolved (left open, will retry)`);
  return { closed: stale.length, scored, unscored };
}

/* PROMOTE MATCHES THAT HAVE ACTUALLY STARTED.
 *
 * ESPN used to do this job: it reported when a match went in-play, the
 * row moved scheduled -> live, and the pick moved from "Analyzed" to
 * "Live Now". With ESPN off for tennis, the only remaining promoter is
 * the socket snapshot — and that feed carries a partial set. It had the
 * ITF matches and never Cincinnati, so a main-tour pick sat in
 * "Analyzed" through the entire match and jumped straight to a result.
 *
 * startTime cannot be trusted for this either: in tennis it is an
 * estimate, since a match starts when the previous one on that court
 * ends. A semi-final was in its second set while its row still read
 * "starts in 1h32m".
 *
 * So this asks the provider. Deliberately narrow: only matches that
 * carry a pick (the ones a member is watching), only those already
 * plausibly underway, and capped per cycle so it cannot become a large
 * recurring API cost.
 */
async function promoteStartedMatches({ limit = 12 } = {}) {
  const sport = await db.sport.findFirst({ where: { slug: 'tennis' } });
  if (!sport) return { promoted: 0, checked: 0 };

  const now = Date.now();
  const candidates = await db.match.findMany({
    where: {
      sportId: sport.id,
      status: 'scheduled',
      /* DO NOT TRUST startTime TO DECIDE WHO TO CHECK.
       *
       * This window was `-6h to +30min`, which is circular: the sweep
       * exists because start times drift, but it was filtered BY the
       * drifted value. A match listed as starting in two hours that is
       * actually in its third set fell outside the window, so the one
       * mechanism able to notice never looked at it.
       *
       * Tennis start times are estimates — a match begins when the
       * previous one on that court ends — so the estimate can sit hours
       * either side of reality. The upper bound is therefore generous.
       * The real cost control is elsewhere: only matches that carry a
       * pick, and a hard cap per cycle. */
      startTime: { gte: new Date(now - 8 * 60 * 60 * 1000), lte: new Date(now + 6 * 60 * 60 * 1000) },
      picks: { some: {} },
    },
    select: { id: true, competitorA: true, competitorB: true, startTime: true },
    orderBy: { startTime: 'asc' },
    take: limit,
  }).catch(() => []);

  if (!candidates.length) return { promoted: 0, checked: 0 };

  let promoted = 0;
  for (const m of candidates) {
    const resolved = await resolveExtendId(m.competitorA, m.competitorB, m.startTime)
      .catch(() => null);
    if (!resolved || !resolved.status) continue;

    const st = String(resolved.status);
    const notStarted = /not.?started|scheduled|upcoming|postponed|cancell?ed/i.test(st);
    const isDone = /ended|finished|retired|walkover/i.test(st);
    // Finished matches are left alone: the stale sweep closes those with
    // a score, and promoting a finished match to live would put it back
    // on the board as though it were still being played.
    if (notStarted || isDone) continue;

    await db.match.update({
      where: { id: m.id },
      data: { status: 'live', ...(resolved.score ? { liveScore: resolved.score } : {}) },
    }).catch(() => {});
    promoted++;
    console.log(`[tennisIngest] ${m.competitorA} vs ${m.competitorB} is under way (${st}) — moved to live`);
  }

  return { promoted, checked: candidates.length };
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
      try {
        if (d.picks.length) {
          const uncovered = d.picks.filter((pk) => !keepCovers(pk));
          if (uncovered.length) {
            console.warn(`[tennisCleanup] keeping ${d.externalId}: ${uncovered.length} pick(s) the kept row does not have`);
            continue;
          }
          console.log(`[tennisCleanup] dropping ${d.externalId}: its ${d.picks.length} pick(s) duplicate ${keep.externalId}`);
        }

        if (!dryRun) {
          /* Delete children first — Match uses RESTRICT, not CASCADE.
           *
           * Dropping a duplicate that carries picks means removing its
           * Result rows, then its Picks, then the Match. Calling
           * match.delete() directly throws "violates RESTRICT setting of
           * foreign key constraint Pick_matchId_fkey" — which aborted
           * the entire dedupe pass every cycle, so nothing was removed
           * while the log line above claimed it was dropping them. */
          const pickIds = d.picks.map((pk) => pk.id);
          if (pickIds.length) {
            await db.result.deleteMany({ where: { pickId: { in: pickIds } } });
            await db.pick.deleteMany({ where: { id: { in: pickIds } } });
          }
          await db.match.delete({ where: { id: d.id } });
        }
        removed++;
      } catch (e) {
        // One bad row must not stop the rest of the pass — that is how a
        // single constraint error blocked every other cleanup this cycle.
        console.error(`[tennisCleanup] could not drop ${d.externalId}: ${e.message}`);
      }
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

module.exports = {
  promoteStartedMatches, ingestTennisFixtures, closeStaleScheduledTennis, applyTennisLiveState, cleanupDuplicateTennis, clearTennisSkipFlags };
