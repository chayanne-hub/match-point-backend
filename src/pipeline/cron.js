/**
 * Match Point — automated pipeline.
 *
 * Run standalone with `npm run pipeline`, or deploy as a scheduled job
 * (Railway cron, a Render cron job, GitHub Actions on a schedule, etc.)
 * instead of a long-running node-cron process — either works.
 *
 * What this does NOT do yet: pull the qualitative factor inputs (surface fit,
 * injury reports, weather, etc.) that scoreModel.js expects. Those need their
 * own data sources per sport (see the notes in fetchMatches.js) and their own
 * normalization into the -1..+1 factor scores scoreModel.js consumes. Right
 * now this pipeline only wires up the odds-based skeleton — matches get
 * fetched and stored, but factor scoring is stubbed with neutral placeholders
 * until real qualitative inputs are connected per sport.
 */

require('dotenv').config();
const cron = require('node-cron');
const db = require('../lib/db');
const { fetchMatches, fetchScores } = require('./fetchMatches');
const { buildPicks, MARKET_FACTOR_KEY } = require('./scoreModel');
const { fetchEspnLiveScores, matchEspnEvent } = require('./fetchEspn');
const { computeInjuryFactor, fetchEspnTeams } = require('./fetchEspnInjuries');
const { computeRestDaysFactor, computeHomeAwayFormFactor } = require('./qualitativeFactors');
const { describeFactors, generateAiRationale } = require('./generateRationale');

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

// Builds the factor set fed into scoreMatch(). The "primary" slot per sport
// (see MARKET_FACTOR_KEY in scoreModel.js) is filled with a real signal
// derived from the actual odds — how strongly the market favors one side.
// Every other qualitative factor (surface fit, injuries, weather, etc.)
// still needs its own real data source and is genuinely OMITTED (not set
// to 0) until that's connected — scoreMatch() correctly excludes missing
// factors from the weighted average, whereas setting them to 0 would count
// as a confirmed "no edge" data point and wrongly dilute the one real
// signal we do have. See the per-sport model notes for what's still needed.
// Which sports have an injuries factor slot in WEIGHTS (see scoreModel.js)
// that ESPN's per-team injury report can actually fill.
const INJURY_SPORTS = new Set(['basketball', 'football', 'baseball']);

// Maps each sport to which of its WEIGHTS keys (see scoreModel.js) the
// free/derivable factors below actually fill. Baseball has no matching
// slot for either — its four factors (startingPitcher, bullpenFatigue,
// parkFactors, lineMovement) don't correspond to rest or home/away form,
// so it's intentionally absent from both maps rather than forced in.
const REST_DAYS_KEY = { basketball: 'rest', football: 'restTravel' };
const HOME_AWAY_FORM_KEY = { basketball: 'homeRoad', soccer: 'homeAwayForm' };

async function buildFactors(sport, competitorA, competitorB, oddsA, oddsB, matchStartTime, espnTeamsCache = null) {
  const { MARKET_FACTOR_KEY, marketImpliedFactor } = require('./scoreModel');
  const factors = {};

  const marketKey = MARKET_FACTOR_KEY[sport];
  const marketSignal = marketImpliedFactor(oddsA, oddsB);
  if (marketKey && marketSignal !== null) {
    factors[marketKey] = marketSignal;
  }

  if (INJURY_SPORTS.has(sport)) {
    try {
      const injurySignal = await computeInjuryFactor(sport, competitorA, competitorB, espnTeamsCache);
      if (injurySignal !== null) {
        factors.injuries = injurySignal;
      }
    } catch (err) {
      console.error(`[factors] ${sport} injury lookup failed for ${competitorA} vs ${competitorB}:`, err.message);
      // Omit the factor on failure — never fabricate a neutral value.
    }
  }

  const restKey = REST_DAYS_KEY[sport];
  if (restKey) {
    try {
      const restSignal = await computeRestDaysFactor(sport, competitorA, competitorB, matchStartTime);
      if (restSignal !== null) {
        factors[restKey] = restSignal;
      }
    } catch (err) {
      console.error(`[factors] ${sport} rest-days lookup failed for ${competitorA} vs ${competitorB}:`, err.message);
    }
  }

  const formKey = HOME_AWAY_FORM_KEY[sport];
  if (formKey) {
    try {
      const formSignal = await computeHomeAwayFormFactor(sport, competitorA, competitorB, matchStartTime);
      if (formSignal !== null) {
        factors[formKey] = formSignal;
      }
    } catch (err) {
      console.error(`[factors] ${sport} home/away form lookup failed for ${competitorA} vs ${competitorB}:`, err.message);
    }
  }

  return factors;
}

/**
 * Builds an honest, factor-accurate rationale string — only mentions the
 * signals that actually contributed to THIS pick, never a generic claim
 * about the full model. Still a template, not real prose — that's the
 * next piece (Claude-generated analysis) to build on top of this.
 */
function buildRationale(sport, factors) {
  const parts = ['the market-implied favorite from live odds'];
  if (factors.injuries !== undefined) parts.push("each team's reported injuries");
  if (factors[REST_DAYS_KEY[sport]] !== undefined) parts.push('rest days since each team\'s last match');
  if (factors[HOME_AWAY_FORM_KEY[sport]] !== undefined) parts.push('recent home/away form');

  const connected = parts.length > 1 ? parts.join(', ') : parts[0];
  const stillMissing = 'other qualitative factors not yet connected.';
  return `Model weighted ${connected}; ${stillMissing}`;
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

  // Fetch once per run, not once per match — buildFactors reuses this for
  // every match's injury lookup instead of re-fetching the full team list.
  const espnTeamsCache = INJURY_SPORTS.has(sportSlug) ? await fetchEspnTeams(sportSlug) : null;

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

    // Other qualitative factors beyond the market signal and (for
    // basketball/football/baseball) ESPN injuries still need their own
    // data sources per sport — see the per-sport model notes.
    const factors = await buildFactors(sportSlug, m.competitorA, m.competitorB, m.oddsA, m.oddsB, m.startTime, espnTeamsCache);
    const rationale = buildRationale(sportSlug, factors);

    const picks = buildPicks({
      sport: sportSlug,
      competitorA: m.competitorA,
      competitorB: m.competitorB,
      oddsA: m.oddsA,
      oddsB: m.oddsB,
      factors,
      rationale,
    });

    let aiRationale = null;
    let aiRationaleGenerated = false;

    for (const p of picks) {
      // Skip if the book didn't actually have a price for this side —
      // odds is a required field, and a null/undefined value here means
      // there's nothing real to attach to the pick.
      if (p.odds === null || p.odds === undefined) {
        console.warn(`[pipeline] skipping pick for ${m.competitorA} vs ${m.competitorB} — no odds available.`);
        continue;
      }

      // Avoid duplicate picks for the same match + type on repeated runs.
      const already = await db.pick.findFirst({
        where: { matchId: match.id, pickType: p.pickType },
      });
      if (already) continue;

      // Generate the AI rationale once per match (not once per pick
      // type — "model" and "winner" picks on the same match share the
      // same underlying facts) and only for picks we're actually about
      // to create, never re-run on ones that already exist.
      if (!aiRationaleGenerated) {
        const marketKey = MARKET_FACTOR_KEY[sportSlug];
        const facts = describeFactors(
          sportSlug, factors, m.competitorA, m.competitorB,
          marketKey, REST_DAYS_KEY[sportSlug], HOME_AWAY_FORM_KEY[sportSlug]
        );
        aiRationale = await generateAiRationale({
          sport: sportSlug,
          competitorA: m.competitorA,
          competitorB: m.competitorB,
          selection: p.selection,
          facts,
        });
        aiRationaleGenerated = true;
      }
      const finalRationale = aiRationale || p.rationale; // fall back to the template if AI generation returned null

      await db.pick.create({
        data: {
          match: { connect: { id: match.id } },
          pickType: p.pickType,
          selection: p.selection,
          confidence: p.confidence,
          odds: p.odds,
          rationale: finalRationale,
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

    // Flag this match's picks as live so they show up on the live board.
    await db.pick.updateMany({
      where: { matchId: match.id },
      data: { isLive: true },
    });
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

  // Same per-run caching as the main pipeline — fetch once, reuse for
  // every live match in this call rather than per-match.
  const espnTeamsCache = INJURY_SPORTS.has(sportSlug) ? await fetchEspnTeams(sportSlug) : null;

  for (const m of liveMatches) {
    const match = await db.match.findUnique({ where: { externalId: m.externalId } });
    if (!match) continue; // main pipeline hasn't picked this one up yet

    const factors = await buildFactors(sportSlug, m.competitorA, m.competitorB, m.oddsA, m.oddsB, m.startTime, espnTeamsCache);
    const rationale = buildRationale(sportSlug, factors);
    const picks = buildPicks({
      sport: sportSlug,
      competitorA: m.competitorA,
      competitorB: m.competitorB,
      oddsA: m.oddsA,
      oddsB: m.oddsB,
      factors,
      rationale,
    });

    let aiRationale = null;
    let aiRationaleGenerated = false;

    for (const p of picks) {
      if (p.odds === null || p.odds === undefined) continue;

      const existing = await db.pick.findFirst({
        where: { matchId: match.id, pickType: p.pickType },
      });

      if (existing) {
        // Numeric fields refresh every cycle; rationale is deliberately
        // left untouched — it was already written (AI-generated or
        // template) at creation time, and regenerating it every 45
        // seconds would multiply the AI API cost for no real benefit.
        await db.pick.update({
          where: { id: existing.id },
          data: {
            selection: p.selection,
            confidence: p.confidence,
            odds: p.odds,
          },
        });
      } else {
        if (!aiRationaleGenerated) {
          const marketKey = MARKET_FACTOR_KEY[sportSlug];
          const facts = describeFactors(
            sportSlug, factors, m.competitorA, m.competitorB,
            marketKey, REST_DAYS_KEY[sportSlug], HOME_AWAY_FORM_KEY[sportSlug]
          );
          aiRationale = await generateAiRationale({
            sport: sportSlug,
            competitorA: m.competitorA,
            competitorB: m.competitorB,
            selection: p.selection,
            facts,
          });
          aiRationaleGenerated = true;
        }
        await db.pick.create({
          data: {
            match: { connect: { id: match.id } },
            pickType: p.pickType,
            selection: p.selection,
            confidence: p.confidence,
            odds: p.odds,
            rationale: aiRationale || p.rationale,
          },
        });
      }
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

    if (newStatus === 'live') {
      await db.pick.updateMany({
        where: { matchId: match.id },
        data: { isLive: true },
      });
    }
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
 * Only supports the "X ML" moneyline-style selections buildPicks() actually
 * produces today — if the selection format changes (spreads, totals) this
 * will need a matching parser added alongside it.
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
