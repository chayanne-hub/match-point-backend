/**
 * Match Point — automated pipeline.
 *
 * Run standalone with `npm run pipeline`, or deploy as a scheduled job
 * (Railway cron, a Render cron job, GitHub Actions on a schedule, etc.)
 * instead of a long-running node-cron process — either works.
 *
 * Pick creation runs on real independent research via matchAnalyst.js —
 * Claude does its own web-search-backed handicapping per match, per sport,
 * rather than confidence being derived mathematically from the betting
 * odds. See matchAnalyst.js for the full explanation of that change.
 */

require('dotenv').config();
const cron = require('node-cron');
const db = require('../lib/db');
const { fetchMatches, fetchScores } = require('./fetchMatches');
const { fetchEspnLiveScores, matchEspnEvent } = require('./fetchEspn');
const { analyzeMatch } = require('./matchAnalyst');

// Confidence bar a pick needs to clear to also be sold as a "model" pick
// (a genuine-edge call) on top of the always-present "winner" pick (a
// straight who-wins call on every match, regardless of edge size).
const MODEL_PICK_THRESHOLD = 65;

const SPORTS = ['tennis', 'basketball', 'soccer', 'baseball', 'football'];

async function ensureSportRows() {
  for (const slug of SPORTS) {
    await db.sport.upsert({
      where: { slug },
      update: {},
      create: { slug, name: slug[0].toUpperCase() + slug.slice(1) },
    });
  }
}

async function runForSport(sportSlug) {
  console.log(`[pipeline] fetching ${sportSlug}...`);

  let matches;
  try {
    matches = await fetchMatches(sportSlug);
  } catch (err) {
    console.error(`[pipeline] ${sportSlug} fetch failed:`, err.message);
    return;
  }

  const sportRow = await db.sport.findUnique({ where: { slug: sportSlug } });

  for (const m of matches) {
    const match = await db.match.upsert({
      where: { externalId: m.externalId },
      update: {
        status: m.status,
        startTime: m.startTime,
      },
      create: {
        externalId: m.externalId,
        sportId: sportRow.id,
        league: m.league,
        competitorA: m.competitorA,
        competitorB: m.competitorB,
        startTime: m.startTime,
        status: m.status,
      },
    });

    // Skip entirely if picks already exist for this match — analyzeMatch()
    // is a real research call (web search + reasoning), not a cheap
    // formula, so it only ever runs once per match, at creation.
    const alreadyHasPicks = await db.pick.findFirst({
      where: { matchId: match.id, pickType: { in: ['model', 'winner'] } },
    });
    if (alreadyHasPicks) continue;

    if (m.oddsA === null || m.oddsB === null) {
      console.warn(`[pipeline] skipping analysis for ${m.competitorA} vs ${m.competitorB} — no odds available.`);
      continue;
    }

    const analysis = await analyzeMatch({
      sport: sportSlug,
      competitorA: m.competitorA,
      competitorB: m.competitorB,
      oddsA: m.oddsA,
      oddsB: m.oddsB,
      startTime: m.startTime,
    });
    if (!analysis) {
      console.warn(`[pipeline] no analysis returned for ${m.competitorA} vs ${m.competitorB} — skipping pick creation this cycle.`);
      continue;
    }

    // The pick's own odds are whichever side Claude actually picked —
    // not always oddsA.
    const pickedOdds = analysis.selection === `${m.competitorA} ML` ? m.oddsA : m.oddsB;
    const factsUsedJson = JSON.stringify(analysis.factors);

    // Every match gets a "winner" pick — a straight who-wins call. Only
    // picks clearing MODEL_PICK_THRESHOLD also get sold as a "model"
    // pick (a genuine-edge call), same selection/confidence/analysis,
    // just a second sellable product on top.
    const pickTypesToCreate = analysis.confidence >= MODEL_PICK_THRESHOLD
      ? ['winner', 'model']
      : ['winner'];

    for (const pickType of pickTypesToCreate) {
      await db.pick.create({
        data: {
          match: { connect: { id: match.id } },
          pickType,
          selection: analysis.selection,
          confidence: analysis.confidence,
          odds: pickedOdds,
          rationale: analysis.analysis,
          factsUsed: factsUsedJson,
        },
      });
    }
  }

  console.log(`[pipeline] ${sportSlug}: processed ${matches.length} matches.`);

  await updateLiveScores(sportSlug, sportRow.id);
}

/**
 * Pulls current scores for a sport, updates any in-progress or just-finished
 * matches, and flags their picks as "live" once a match actually starts —
 * that's what makes them show up on the live picks board.
 */
async function updateLiveScores(sportSlug, sportId) {
  let scores;
  try {
    scores = await fetchScores(sportSlug);
  } catch (err) {
    console.error(`[pipeline] ${sportSlug} scores fetch failed:`, err.message);
    return;
  }

  for (const s of scores) {
    const match = await db.match.findUnique({ where: { externalId: s.externalId } });
    if (!match) continue; // haven't seen this match in the odds pull yet

    // scores are null until the game actually kicks off
    const hasStarted = s.homeScore !== null && s.awayScore !== null;

    if (s.completed) {
      // Persist the FINAL score before marking it final — this is what
      // recent-form/rest-day/park-factor style qualitative factors will
      // later query against. Previously this just flipped status and
      // discarded the result entirely.
      await db.match.update({
        where: { id: match.id },
        data: {
          status: 'final',
          ...(hasStarted && {
            homeScore: Number(s.homeScore),
            awayScore: Number(s.awayScore),
            liveScore: `${s.homeScore} - ${s.awayScore}`,
          }),
        },
      });
      continue;
    }

    if (!hasStarted) continue;

    await db.match.update({
      where: { id: match.id },
      data: {
        status: 'live',
        homeScore: Number(s.homeScore),
        awayScore: Number(s.awayScore),
        liveScore: `${s.homeScore} - ${s.awayScore}`,
        // liveClock intentionally left alone — The Odds API doesn't provide
        // period/quarter/clock data, so we don't fabricate one.
      },
    });

    // NOTE: we no longer flag the match's pre-match "model"/"winner"
    // picks as isLive here. That flag now belongs exclusively to the
    // dedicated pickType:'live' record created by updateLivePicksForSport
    // — the original picks must stay untouched once created, since they're
    // the frozen prediction Today's Picks/the archive/stats grade against.
  }

  if (scores.length > 0) {
    console.log(`[pipeline] ${sportSlug}: checked ${scores.length} score(s).`);
  }
}

async function runAll() {
  await ensureSportRows();
  for (const sport of SPORTS) {
    await runForSport(sport);
  }
}

// If run directly (npm run pipeline), execute once and exit.
if (require.main === module) {
  runAll()
    .then(() => {
      console.log('[pipeline] done.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[pipeline] fatal error:', err);
      process.exit(1);
    });
}

// If imported instead, expose a scheduler you can start from server.js —
// e.g. every 15 minutes for daily matches, and a tighter interval for live
// in-play score/odds updates once that data source is connected.
function startScheduled() {
  cron.schedule('*/15 * * * *', () => {
    runAll().catch((err) => console.error('[pipeline] scheduled run failed:', err));
  });
  console.log('[pipeline] scheduled to run every 15 minutes.');
}

/**
 * Fast loop: re-scores picks for matches that are currently live.
 * Runs far more often than the main pipeline so the live picks board's
 * confidence numbers actually move as the market re-prices the match
 * during play. Unlike the main pick-creation loop, this UPDATES existing
 * picks instead of skipping them once they exist.
 */
async function updateLivePicksForSport(sportSlug) {
  let matches;
  try {
    matches = await fetchMatches(sportSlug);
  } catch (err) {
    console.error(`[live-pipeline] ${sportSlug} fetch failed:`, err.message);
    return;
  }

  // Continuously track the most recent pre-match odds for matches that
  // haven't gone live yet. Whatever this holds right before the match
  // actually starts becomes our closing-line snapshot. This runs over
  // ALL fetched matches (not just live ones) because odds providers
  // commonly stop returning pre-match odds the moment a game goes
  // in-play — waiting to snapshot at "live" would frequently catch
  // nothing, since the match may already be missing odds by then.
  for (const m of matches) {
    if (m.oddsA === null || m.oddsB === null) continue;
    const dbMatch = await db.match.findUnique({ where: { externalId: m.externalId } });
    if (!dbMatch || dbMatch.status !== 'scheduled') continue; // already live/final — line is closed
    await db.match.update({
      where: { id: dbMatch.id },
      data: { closingOddsA: m.oddsA, closingOddsB: m.oddsB },
    });
  }

  const liveMatches = matches.filter(m => m.status === 'in_progress' || m.status === 'live');
  if (liveMatches.length === 0) return;

  for (const m of liveMatches) {
    const match = await db.match.findUnique({ where: { externalId: m.externalId } });
    if (!match) continue; // main pipeline hasn't picked this one up yet

    if (m.oddsA === null || m.oddsB === null) continue;

    // The live board tracks exactly ONE evolving pick per match, kept
    // entirely separate from the pre-match "model"/"winner" picks — those
    // are the frozen prediction that Today's Picks, the archive, and all
    // stats read from, and must NEVER be touched once a match goes live.
    const existingLive = await db.pick.findFirst({
      where: { matchId: match.id, pickType: 'live' },
    });

    if (existingLive) {
      // Only the DISPLAYED PRICE refreshes each cycle — a legitimate
      // "here's the current line" number, not a judgment call. Selection
      // and confidence are deliberately frozen at whatever the initial
      // research concluded: re-running a full web-search analysis every
      // 45 seconds would be far too slow/expensive, but silently
      // re-deriving confidence from live market movement instead would
      // just reintroduce the exact "confidence comes from the odds, not
      // real analysis" problem this whole architecture change was meant
      // to fix.
      const currentOdds = existingLive.selection === `${m.competitorA} ML` ? m.oddsA : m.oddsB;
      await db.pick.update({
        where: { id: existingLive.id },
        data: { odds: currentOdds },
      });
    } else {
      const analysis = await analyzeMatch({
        sport: sportSlug,
        competitorA: m.competitorA,
        competitorB: m.competitorB,
        oddsA: m.oddsA,
        oddsB: m.oddsB,
        startTime: m.startTime,
      });
      if (!analysis) continue; // try again next cycle

      const pickedOdds = analysis.selection === `${m.competitorA} ML` ? m.oddsA : m.oddsB;
      await db.pick.create({
        data: {
          match: { connect: { id: match.id } },
          pickType: 'live',
          isLive: true,
          selection: analysis.selection,
          confidence: analysis.confidence,
          odds: pickedOdds,
          rationale: analysis.analysis,
          factsUsed: JSON.stringify(analysis.factors),
        },
      });
    }
  }

  console.log(`[live-pipeline] ${sportSlug}: refreshed ${liveMatches.length} live match(es).`);
}

async function updateLivePicks() {
  for (const sport of SPORTS) {
    await updateLivePicksForSport(sport);
  }
}

/**
 * Starts the fast live-picks loop. Uses setInterval rather than
 * node-cron, since node-cron only guarantees minute-level granularity —
 * we need real sub-minute control here.
 */
function startLiveScheduled() {
  setInterval(() => {
    updateLivePicks().catch(err => console.error('[live-pipeline] run failed:', err));
  }, 45000); // every 45 seconds — real refresh, safe on API credits
  console.log('[live-pipeline] scheduled to run every 45 seconds.');
}

/**
 * Fast ESPN-sourced score loop. Free and unauthenticated, so this can run
 * much more often than the Odds-API-based updateLiveScores() above without
 * worrying about API credits. Only updates scores (homeScore/awayScore/
 * liveScore/setScore/status) — odds and picks are untouched, since ESPN
 * doesn't provide betting odds. Matches ESPN events to DB rows by
 * normalized name + same day (see fetchEspn.js) since the two providers
 * don't share an ID.
 */
async function updateEspnScoresForSport(sportSlug) {
  const sportRow = await db.sport.findUnique({ where: { slug: sportSlug } });
  if (!sportRow) return;

  // Only bother matching against matches that are still relevant —
  // scheduled for today or already live. Finished matches don't need
  // further score updates from this loop.
  const candidateMatches = await db.match.findMany({
    where: {
      sportId: sportRow.id,
      status: { in: ['scheduled', 'live'] },
    },
  });
  if (candidateMatches.length === 0) return;

  let espnEvents;
  try {
    espnEvents = await fetchEspnLiveScores(sportSlug);
  } catch (err) {
    console.error(`[espn-pipeline] ${sportSlug} fetch failed:`, err.message);
    return;
  }

  let updated = 0;
  for (const event of espnEvents) {
    const match = matchEspnEvent(event, candidateMatches);
    if (!match) continue;

    const newStatus = event.completed ? 'final' : event.inProgress ? 'live' : match.status;

    await db.match.update({
      where: { id: match.id },
      data: {
        status: newStatus,
        homeScore: event.homeScore,
        awayScore: event.awayScore,
        liveScore: `${event.homeScore} - ${event.awayScore}`,
        ...(event.setScore && { setScore: event.setScore }),
      },
    });

    // NOTE: no longer flagging the match's pre-match picks as isLive here
    // — see the matching note in updateLiveScores(). The dedicated
    // pickType:'live' record (created separately by
    // updateLivePicksForSport) is what actually powers the live board now.
    updated++;
  }

  if (updated > 0) {
    console.log(`[espn-pipeline] ${sportSlug}: updated ${updated} match(es) from ESPN.`);
  }
}

async function updateEspnScores() {
  for (const sport of SPORTS) {
    await updateEspnScoresForSport(sport);
  }
}

/**
 * Grading — Track Record support.
 *
 * Determines win/loss/push for one pick against its now-finished match.
 * Only supports the "X ML" moneyline-style selections analyzeMatch() is
 * constrained to produce today — if the selection format ever changes
 * (spreads, totals) this will need a matching parser added alongside it.
 *
 * A tied final score (soccer draws being the realistic case, since ML has
 * no draw option in the model) is graded as a push rather than forced into
 * a win/loss — nobody actually won that match outright.
 */
function gradePick(match, pick) {
  if (match.homeScore === null || match.awayScore === null) return null;

  const pickedName = pick.selection.replace(/\s*ML$/, '').trim();
  let pickedSide = null;
  if (pickedName === match.competitorA) pickedSide = 'A';
  else if (pickedName === match.competitorB) pickedSide = 'B';
  if (!pickedSide) return null; // unrecognized selection format — skip, don't guess

  if (match.homeScore === match.awayScore) return 'push';

  const actualWinnerSide = match.homeScore > match.awayScore ? 'A' : 'B';
  return pickedSide === actualWinnerSide ? 'win' : 'loss';
}

/**
 * Scans for picks on finished matches that don't have a Result yet, grades
 * them, and writes the outcome. This is what actually populates Track
 * Record — without this, homeScore/awayScore can be perfectly correct and
 * the stats would still show placeholders forever.
 */
async function gradeFinishedMatches() {
  const ungraded = await db.pick.findMany({
    where: {
      result: null,
      match: { status: 'final' },
      // Only the frozen pre-match "model"/"winner" picks get graded into
      // the permanent track record. The pickType:'live' record is a
      // different product (evolves during play) — grading it the same
      // way would mean judging a call that kept changing as the outcome
      // became apparent, which isn't a real prediction.
      pickType: { in: ['model', 'winner'] },
    },
    include: { match: true },
  });

  let graded = 0;
  for (const pick of ungraded) {
    const outcome = gradePick(pick.match, pick);
    if (!outcome) continue;

    await db.result.create({
      data: { pickId: pick.id, outcome },
    });
    graded++;
  }

  if (graded > 0) {
    console.log(`[grading] graded ${graded} pick(s).`);
  }
}

/**
 * Starts the fast ESPN score loop at 15-second intervals. This is the
 * primary source of live score freshness — the Odds-API-based
 * updateLiveScores() still runs every 15 minutes as part of the main
 * pipeline as a fallback, but ESPN being free lets us poll much faster.
 */
function startEspnScheduled() {
  setInterval(() => {
    updateEspnScores()
      .then(() => gradeFinishedMatches())
      .catch(err => console.error('[espn-pipeline] run failed:', err));
  }, 15000); // every 15 seconds
  console.log('[espn-pipeline] scheduled to run every 15 seconds.');
}

module.exports = { runAll, startScheduled, startLiveScheduled, startEspnScheduled };
