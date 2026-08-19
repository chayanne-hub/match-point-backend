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
const { broadcastScoreUpdate } = require('../lib/liveSocket');
const { registerHeartbeat, beat, startWatchdog } = require('../lib/watchdog');
const { recordPregameRun, recordEspnPoll, recordAnalysisRetry, recordAnalysisFailure, recordError, recordLiveCycleStart, recordLiveCycleComplete, recordLiveOverlapSkip } = require('../lib/healthStats');

const MAX_CONCURRENT_ANALYSIS = 3;
let activeAnalysisCount = 0;
const analysisWaitQueue = [];

function acquireAnalysisSlot() {
  return new Promise((resolve) => {
    if (activeAnalysisCount >= MAX_CONCURRENT_ANALYSIS) {
      console.log(`[pipeline] concurrency cap reached (${MAX_CONCURRENT_ANALYSIS} in flight) — queueing rather than piling on more load.`);
    }
    const tryAcquire = () => {
      if (activeAnalysisCount < MAX_CONCURRENT_ANALYSIS) {
        activeAnalysisCount++;
        resolve();
      } else {
        analysisWaitQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

function releaseAnalysisSlot() {
  activeAnalysisCount--;
  const next = analysisWaitQueue.shift();
  if (next) next();
}

async function analyzeMatchWithRetry(params, context) {
  // Held across BOTH the first attempt and the retry — a failing match
  // occupies one slot for its whole up-to-180-second lifetime rather
  // than releasing and re-queueing between attempts, which keeps the
  // total concurrent load genuinely capped, not just capped per-attempt.
  await acquireAnalysisSlot();
  try {
    let result = await analyzeMatch(params);
    if (result) return result;
    console.warn(`[match-analyst] first attempt failed for ${context} — retrying once before giving up.`);
    recordAnalysisRetry();
    result = await analyzeMatch(params);
    if (!result) {
      console.error(`[match-analyst] retry also failed for ${context} — skipping this cycle.`);
      recordAnalysisFailure(context);
    }
    return result;
  } finally {
    releaseAnalysisSlot();
  }
}
const { fetchMatches, fetchScores } = require('./fetchMatches');
const { fetchEspnLiveScores, matchEspnEvent } = require('./fetchEspn');
const { analyzeMatch, reassessLiveMatch, reassessLiveTotal } = require('./matchAnalyst');
const { computePregameProjectedTotal, computeLiveProjectedTotal, computeLiveProjectedTotalByInnings } = require('./teamTotals');
const { computePregameProjectedTotalGames, computeLiveProjectedTotalGames } = require('./tennisTotalGames');
const { computePregameProjectedTotalGoals, computeLiveProjectedTotalGoals, parseElapsedMinutesFromDisplayClock } = require('./soccerGoalsTotal');

// Confidence bar a pick needs to clear to also be sold as a "model" pick
// (a genuine-edge call) on top of the always-present "winner" pick (a
// straight who-wins call on every match, regardless of edge size).
const MODEL_PICK_THRESHOLD = 65;

const SPORTS = ['tennis', 'basketball', 'soccer', 'baseball', 'football'];

// Sports with a real, computed pregame/live total formula.
const TOTAL_FORMULA_SPORTS = ['basketball', 'football', 'baseball', 'tennis', 'soccer'];

// Of those, which actually have quarters/periods with a countdown clock
// (as opposed to baseball's innings or tennis's sets, both discrete units
// with no clock at all) — used to decide whether the "Q{period} {clock}"
// liveClock display format is valid for a given sport.
const QUARTER_BASED_SPORTS = ['basketball', 'football'];

// Tennis's live-total formula is sets-based, not innings-based — needs
// its own branch (match format + set score) rather than treating it as
// a variant of either the quarter-clock or innings model.
const SETS_BASED_SPORTS = ['tennis'];

// Soccer runs on a real clock, but COUNTS UP with variable stoppage time
// — the opposite convention from basketball/football's countdown clock.
// Needs its own branch: ESPN's displayClock string ("72'", "45+2'") is
// parsed directly rather than reused through the countdown-clock math.
const COUNT_UP_CLOCK_SPORTS = ['soccer'];

async function ensureSportRows() {
  for (const slug of SPORTS) {
    await db.sport.upsert({
      where: { slug },
      update: {},
      create: { slug, name: slug[0].toUpperCase() + slug.slice(1) },
    });
  }
}

// (freshOddsForPick removed — it existed only to rewrite pregame pick
// prices with live odds, which corrupted the entry price used for
// grading. Live prices live on the live pick instead.)

// Same timezone day-boundary logic picks.js already uses for "today's"
// picks — duplicated here rather than shared across a routes/pipeline
// import boundary, kept small and self-contained.
function getPacificDayBounds(daysFromNow = 0) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const reference = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  const parts = dtf.formatToParts(reference).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const startOfDay = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00-07:00`); // -07:00 covers PDT; close enough for a day-window filter, not exact-instant grading
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  return { startOfDay, endOfDay };
}

async function runForSport(sportSlug, dayFilter = null) {
  console.log(`[pipeline] fetching ${sportSlug}...`);

  let matches;
  try {
    matches = await fetchMatches(sportSlug);
  } catch (err) {
    console.error(`[pipeline] ${sportSlug} fetch failed:`, err.message);
    return;
  }

  // Optional day filter — used by the admin "Run Pipeline for Tomorrow"
  // action specifically, so it only touches tomorrow's matches and
  // never re-processes today's (which may be deliberately skipped via
  // skipAnalysis, or already handled). Normal scheduled runs pass no
  // filter and behave exactly as before.
  if (dayFilter === 'tomorrow') {
    const { startOfDay, endOfDay } = getPacificDayBounds(1);
    matches = matches.filter((m) => {
      const t = new Date(m.startTime).getTime();
      return t >= startOfDay.getTime() && t < endOfDay.getTime();
    });
    console.log(`[pipeline] ${sportSlug}: filtered to ${matches.length} match(es) starting tomorrow.`);
  } else {
    // TODAY ONLY. fetchMatches() returns everything within MAX_DAYS_AHEAD
    // (14 days) so that schedule data and market lines stay fresh, but
    // ANALYSIS is a paid research call and must not run days early:
    //
    //   - it's real money spent on a match that may not even be relevant
    //     yet, and books reprice heavily between now and kickoff;
    //   - the analysis is frozen once written (never re-run), so a pick
    //     produced 5 days out is what the customer sees at game time,
    //     built on stale team news;
    //   - matches from other days then leak into today's board.
    //
    // Anything beyond today is still upserted as schedule/odds data by
    // the loop below on a later day — it just doesn't get analyzed until
    // the day it's actually played.
    const { startOfDay, endOfDay } = getPacificDayBounds(0);
    const before = matches.length;
    matches = matches.filter((m) => {
      const t = new Date(m.startTime).getTime();
      return t >= startOfDay.getTime() && t < endOfDay.getTime();
    });
    if (before !== matches.length) {
      console.log(`[pipeline] ${sportSlug}: ${before} -> ${matches.length} match(es) after restricting to today (Pacific).`);
    }
  }

  const sportRow = await db.sport.findUnique({ where: { slug: sportSlug } });

  for (const m of matches) {
   // One match must never be able to abort the whole sport's run. A
   // single bad row throwing here used to take down every remaining
   // match in this sport for the cycle — the same failure mode that
   // silently froze the live pipeline (see updateLivePicksForSport).
   // Isolated so a bad row costs one row, and says so in the logs.
   try {
    // Real fix for a confirmed bug: startTime used to get unconditionally
    // overwritten with whatever the odds provider currently reports on
    // EVERY cycle, forever — including for matches that already have a
    // real pick and should be treated as a fixed, committed point in
    // time. If the provider ever re-reports a drifting/refreshed
    // timestamp for a stale listing (confirmed happening for at least
    // one real match), the match would perpetually look "not yet
    // started" no matter how many actual days passed, since its
    // recorded start time kept chasing the current moment. Once a match
    // has a real pick, its startTime is now frozen — same "commit once,
    // never drift" philosophy already applied to confidence/analysis.
    // Market prices (spread/total) still update freely either way,
    // since those legitimately change pregame.
    const existingMatch = await db.match.findUnique({
      where: { externalId: m.externalId },
    });

    // START TIME: update it, but not blindly.
    //
    // Freezing it entirely once a pick existed stopped the drift bug, but
    // broke something more common — tennis matches are scheduled "not
    // before" a session time and routinely slip when the court's previous
    // match overruns. Those are real reschedules and the board was showing
    // stale times for the rest of the day.
    //
    // The distinction that matters isn't "has a pick", it's whether the
    // time keeps being pushed. A genuine delay moves once or twice and
    // settles; the drift pathology pushes forever so the match never
    // arrives. Counting pushes catches the second without blocking the
    // first. A match that's already live or final is frozen outright —
    // its start time is history at that point, not a schedule.
    const MAX_START_TIME_PUSHES = 6;
    const prevStart = existingMatch ? new Date(existingMatch.startTime).getTime() : null;
    const nextStart = new Date(m.startTime).getTime();
    const alreadyUnderway = existingMatch && ['live', 'in_progress', 'final'].includes(existingMatch.status);
    const pushes = existingMatch?.startTimePushes ?? 0;

    let startTimeUpdate = {};
    if (!existingMatch) {
      startTimeUpdate = {}; // create path sets it below
    } else if (alreadyUnderway) {
      // no-op: a started match's time is a fact, not a plan
    } else if (nextStart <= prevStart) {
      // Moved earlier or unchanged — never the drift pathology, always safe.
      startTimeUpdate = { startTime: m.startTime };
    } else if (pushes < MAX_START_TIME_PUSHES) {
      startTimeUpdate = { startTime: m.startTime, startTimePushes: pushes + 1 };
      const mins = Math.round((nextStart - prevStart) / 60000);
      if (mins >= 5) {
        console.log(`[pipeline] ${m.competitorA} vs ${m.competitorB}: start pushed ${mins}m later (${pushes + 1}/${MAX_START_TIME_PUSHES}).`);
      }
    } else if (pushes === MAX_START_TIME_PUSHES) {
      console.warn(`[pipeline] ${m.competitorA} vs ${m.competitorB}: start time pushed ${pushes} times — freezing it, provider timestamp looks like it's drifting.`);
      startTimeUpdate = { startTimePushes: pushes + 1 }; // record the freeze once, then stop logging
    }

    const match = await db.match.upsert({
      where: { externalId: m.externalId },
      update: {
        // Never let the odds provider's schedule-derived guess overwrite
        // ESPN's observed state. Promotion to live/final comes from the
        // score poller; this side only ever moves a match that's still
        // genuinely scheduled.
        ...(existingMatch && ['live', 'in_progress', 'final'].includes(existingMatch.status)
          ? {}
          : { status: m.status }),
        ...startTimeUpdate,
        // Lines move until kickoff — keep them fresh on every pull, same
        // as status/startTime already were.
        spread: m.spread,
        spreadOddsA: m.spreadOddsA,
        spreadOddsB: m.spreadOddsB,
        total: m.total,
        overOdds: m.overOdds,
        underOdds: m.underOdds,
        // Best price across all books — refreshed every pull like the
        // rest of the market data. Display only; BetMGM remains the line
        // of record for grading.
        sportKey: m.sportKey ?? null,
        bestOddsA: m.bestOddsA ?? null,
        bestOddsB: m.bestOddsB ?? null,
        bestBookA: m.bestBookA ?? null,
        bestBookB: m.bestBookB ?? null,
      },
      create: {
        externalId: m.externalId,
        sportId: sportRow.id,
        league: m.league,
        competitorA: m.competitorA,
        competitorB: m.competitorB,
        startTime: m.startTime,
        status: m.status,
        sportKey: m.sportKey ?? null,
        bestOddsA: m.bestOddsA ?? null,
        bestOddsB: m.bestOddsB ?? null,
        bestBookA: m.bestBookA ?? null,
        bestBookB: m.bestBookB ?? null,
        spread: m.spread,
        spreadOddsA: m.spreadOddsA,
        spreadOddsB: m.spreadOddsB,
        total: m.total,
        overOdds: m.overOdds,
        underOdds: m.underOdds,
      },
    });

    // Deliberately skipped — e.g. bulk-marked via the admin "skip
    // today's backlog" action after a balance-outage window, so the
    // pipeline doesn't keep re-attempting a pile of matches that would
    // otherwise all queue up and risk the same overload that caused
    // real spend with zero picks in the first place. Checked before
    // anything else — no DB lookups for existing picks, no analysis,
    // nothing.
    // Append a price snapshot rather than only overwriting the current
    // value. This is what makes timing guidance possible at all — you
    // can't say "this is a good number right now" without knowing what
    // the number has been. Only written when there's a real price to
    // record, and only pre-kickoff, since that's the window a bettor can
    // still act in.
    if ((m.bestOddsA != null || m.oddsA != null) && match.status !== 'final') {
      try {
        await db.oddsSnapshot.create({
          data: {
            matchId: match.id,
            bestOddsA: m.bestOddsA ?? null,
            bestOddsB: m.bestOddsB ?? null,
            bestBookA: m.bestBookA ?? null,
            bestBookB: m.bestBookB ?? null,
            bookOddsA: m.oddsA ?? null,
            bookOddsB: m.oddsB ?? null,
          },
        });
      } catch (err) {
        // Never let history-keeping break the pipeline that produces picks.
        console.warn(`[pipeline] odds snapshot failed for ${m.competitorA} vs ${m.competitorB}: ${err.message}`);
      }
    }

    if (match.skipAnalysis) continue;

    // Real fix for a confirmed bug: a match that consistently fails (for
    // whatever underlying reason — a genuinely hard research case, a
    // recurring API hiccup specific to that matchup) had NO limit on how
    // many separate 15-minute cycles it could be re-attempted across.
    // Real logs showed the same match fully failing (both attempt AND
    // retry exhausted) in one cycle, then getting hit again from scratch
    // 15+ minutes later, repeatedly — every cycle burning a full paid
    // attempt+retry for zero output, for hours, until the match started.
    // Capped at 3 full cycle-level failures — after that, stop
    // automatically retrying and surface it as a real, visible failure
    // (recordAnalysisFailure) rather than silently keep spending on it.
    const MAX_CYCLE_FAILURES = 3;
    if (match.analysisFailCycles >= MAX_CYCLE_FAILURES) continue;

    // Skip re-analysis entirely if picks already exist for this match —
    // analyzeMatch() is a real research call (web search + reasoning),
    // not a cheap formula, so it only ever runs once per match, at
    // creation. The confidence/selection/rationale it produced stay
    // frozen forever (no paid live reassessment, see server.js).
    //
    // The ODDS shown alongside that frozen pick are a different thing —
    // just a market price, not model output — and there's no reason
    // they should also stay frozen at the pregame number once a match
    // goes live. fetchMatches() already returns fresh in-play odds for
    // live games on every cycle (The Odds API's /odds endpoint serves
    // both pre-game and in-play prices from the same request you're
    // already making) — this was being fetched and silently discarded
    // for any match that already had a pick. Zero additional API calls
    // either way; this just stops throwing away data already paid for.
    const existingPicks = await db.pick.findMany({
      where: { matchId: match.id, pickType: { in: ['model', 'winner'] } },
    });
    if (existingPicks.length > 0) {
      // A PREGAME pick's odds are the price the call was made at. They are
      // never rewritten.
      //
      // This block used to overwrite them with live in-play prices while a
      // match was running, which broke two things at once:
      //
      //  1. GRADING. pick.odds is what profit is computed from. A pick
      //     taken at -150 that got rewritten to +1900 during a blowout was
      //     then graded at +1900 — a price nobody could have taken. Every
      //     ROI figure and the whole equity curve inherited that.
      //  2. THE BOARD. Confidence stays frozen at the pregame value (as it
      //     should — it's research, not a market read), so a row ended up
      //     showing 62% confidence next to 20.00 odds: two numbers from
      //     different moments, sitting side by side as if they agreed.
      //
      // Live prices belong on the separate live pick, which is created and
      // updated by the live pipeline and carries its own confidence
      // derived from those same prices. If a sport isn't covered by
      // LIVE_ODDS_SPORTS it simply has no live pick, and the board shows
      // the pregame call unchanged — which is honest.
      continue;
    }

    if (m.oddsA === null || m.oddsB === null) {
      // Say WHICH kind of "no odds" this is. Zero books means the market
      // genuinely doesn't exist anywhere (common for tennis qualifying
      // draws, which most US books don't price). Books present but no
      // usable price means our own selection logic failed to find a
      // complete two-way market — a bug on our side, not the provider's.
      if ((m.bookCount ?? 0) === 0) {
        console.log(`[pipeline] skipping ${m.competitorA} vs ${m.competitorB} — no book anywhere prices this match (0 bookmakers returned).`);
      } else {
        console.warn(`[pipeline] skipping ${m.competitorA} vs ${m.competitorB} — ${m.bookCount} book(s) returned but none had a complete two-way h2h market. This is our side, not the provider's.`);
      }
      continue;
    }

    // Basketball + football: a real, computed baseline (avg points scored
    // over each team's last 3 games) to ground the total pick, on top of
    // which matchAnalyst.js layers real sport-specific judgment. Null for
    // any other sport, or if either team/player lacks 3 games of history
    // yet. Tennis and soccer each use their own module — tennis averages
    // the two players' figures rather than summing them, and soccer
    // blends each team's own scoring with what they tend to concede (see
    // tennisTotalGames.js / soccerGoalsTotal.js headers for why).
    let pregameProjectedTotal = null;
    if (SETS_BASED_SPORTS.includes(sportSlug)) {
      pregameProjectedTotal = await computePregameProjectedTotalGames(m.competitorA, m.competitorB, m.startTime);
    } else if (sportSlug === 'soccer') {
      pregameProjectedTotal = await computePregameProjectedTotalGoals(m.competitorA, m.competitorB, m.startTime);
    } else if (TOTAL_FORMULA_SPORTS.includes(sportSlug)) {
      pregameProjectedTotal = await computePregameProjectedTotal(sportSlug, m.competitorA, m.competitorB, m.startTime);
    }

    const analysis = await analyzeMatchWithRetry({
      sport: sportSlug,
      competitorA: m.competitorA,
      competitorB: m.competitorB,
      oddsA: m.oddsA,
      oddsB: m.oddsB,
      startTime: m.startTime,
      spread: m.spread,
      spreadOddsA: m.spreadOddsA,
      spreadOddsB: m.spreadOddsB,
      total: m.total,
      overOdds: m.overOdds,
      underOdds: m.underOdds,
      pregameProjectedTotal,
      // Tells the analyst this is an NFL PRESEASON game, where
      // regular-season reasoning (standings, playoff seeding, division
      // rivalry) is wrong and playing-time intent is what matters.
      sportKey: m.sportKey,
    }, `${m.competitorA} vs ${m.competitorB} (pregame)`);
    if (!analysis) {
      // Only count this against the MATCH if analysis is demonstrably
      // working right now — i.e. something else succeeded this run. When
      // every call is failing the cause is systemic (no API credit, an
      // outage, a bad key), and blaming individual matches for it
      // permanently blacklists the entire slate: three failed cycles and
      // that match is never analysed again, even after the real problem
      // is fixed. That is exactly what happened while analysis funding
      // was off.
      if (analysisSuccessesThisRun === 0) {
        console.warn(`[pipeline] analysis failed for ${m.competitorA} vs ${m.competitorB}, but nothing has succeeded this run — treating as a systemic failure, not counting it against the match.`);
        continue;
      }
      const newFailCount = match.analysisFailCycles + 1;
      await db.match.update({ where: { id: match.id }, data: { analysisFailCycles: newFailCount } });
      if (newFailCount >= MAX_CYCLE_FAILURES) {
        console.error(`[pipeline] ${m.competitorA} vs ${m.competitorB} has now failed ${newFailCount} full cycles — no longer auto-retrying, marking as a real failure.`);
        recordAnalysisFailure(`${m.competitorA} vs ${m.competitorB} — exceeded ${MAX_CYCLE_FAILURES} cross-cycle failures`);
      } else {
        console.warn(`[pipeline] no analysis returned for ${m.competitorA} vs ${m.competitorB} — skipping pick creation this cycle (${newFailCount}/${MAX_CYCLE_FAILURES} cycle failures so far).`);
      }
      continue;
    }

    // The pick's own odds are whichever side Claude actually picked —
    // not always oddsA.
    const pickedOdds = analysis.selection === `${m.competitorA} ML` ? m.oddsA : m.oddsB;
    const factsUsedJson = JSON.stringify(analysis.factors);

    // ONE pick per match. This used to write TWO identical rows whenever
    // confidence cleared MODEL_PICK_THRESHOLD — same selection, same
    // confidence, same odds, same rationale, same factors — differing
    // only in pickType ('winner' and 'model'), as two sellable tiers of
    // the same call.
    //
    // That duplication forced every stats query to filter to 'model'
    // alone just to avoid counting one match twice, which in turn made
    // the published win rate and streak silently ignore every match
    // BELOW the threshold (those only ever got a 'winner' row). The
    // headline numbers were computed on a favourable subset while the
    // site displayed and sold all of them.
    //
    // Conviction is already fully expressed by the confidence value
    // itself — MODEL_PICK_THRESHOLD still marks where a genuine edge
    // starts, it just no longer needs a duplicate row to say so.
    analysisSuccessesThisRun++;

    await db.pick.create({
      data: {
        match: { connect: { id: match.id } },
        pickType: 'model',
        market: 'moneyline',
        selection: analysis.selection,
        confidence: analysis.confidence,
        conviction: analysis.conviction || 'guess',
        odds: pickedOdds,
        rationale: analysis.analysis,
        factsUsed: factsUsedJson,
      },
    });

    // Spread pick — a separate market/product from moneyline, only
    // created when Claude actually returned one (i.e. a real line
    // existed and its response validated). No "winner" tier for these
    // markets yet — that concept (always-sold baseline pick) hasn't been
    // extended here; every spread/total pick created is a "model" pick.
    if (analysis.spreadPick) {
      await db.pick.create({
        data: {
          match: { connect: { id: match.id } },
          pickType: 'model',
          market: 'spread',
          line: m.spread,
          selection: analysis.spreadPick.selection,
          confidence: analysis.spreadPick.confidence,
          odds: analysis.spreadPick.selection === `${m.competitorA} ${m.spread > 0 ? '+' : ''}${m.spread}` ? m.spreadOddsA : m.spreadOddsB,
          rationale: analysis.spreadPick.analysis,
          factsUsed: JSON.stringify(analysis.spreadPick.factors || []),
        },
      });
    }

    // Total pick — same treatment.
    if (analysis.totalPick) {
      await db.pick.create({
        data: {
          match: { connect: { id: match.id } },
          pickType: 'model',
          market: 'total',
          line: m.total,
          selection: analysis.totalPick.selection,
          confidence: analysis.totalPick.confidence,
          odds: analysis.totalPick.selection.startsWith('Over') ? m.overOdds : m.underOdds,
          rationale: analysis.totalPick.analysis,
          factsUsed: JSON.stringify(analysis.totalPick.factors || []),
        },
      });
    }
   } catch (err) {
     console.error(`[pipeline] ${sportSlug}: skipping ${m.competitorA} vs ${m.competitorB} — ${err.message}`);
     recordError(`${sportSlug} ${m.competitorA} vs ${m.competitorB}: ${err.message}`);
   }
  }

  console.log(`[pipeline] ${sportSlug}: processed ${matches.length} matches.`);
  recordPregameRun(sportSlug, matches.length);

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

// Successful analyses in the current run. Used to tell a match-specific
// failure apart from a systemic one — see the failure handler in
// runForSport.
let analysisSuccessesThisRun = 0;

async function clearStaleFailureCounters() {
  try {
    // TODAY AND TOMORROW. This used to clear only today's window, which
    // left tomorrow's matches permanently blacklisted: they hit the
    // failure cap during an outage, nothing ever reset them, and the
    // manual "run for tomorrow" then skipped every one. Confirmed in
    // production — 15 of 29 of tomorrow's tennis matches were stuck at
    // failCycles 3 while the other 14 analysed normally.
    //
    // Both days are cleared regardless of which run is executing, because
    // a counter set during an outage says nothing about the match.
    const { startOfDay } = getPacificDayBounds(0);
    const { endOfDay: endOfTomorrow } = getPacificDayBounds(1);
    const cleared = await db.match.updateMany({
      where: {
        startTime: { gte: startOfDay, lte: endOfTomorrow },
        analysisFailCycles: { gt: 0 },
        status: { in: ['scheduled', 'live', 'in_progress'] },
        picks: { none: { pickType: { in: ['model', 'winner'] } } },
      },
      data: { analysisFailCycles: 0 },
    });
    if (cleared.count > 0) {
      console.log(`[pipeline] cleared failure counters on ${cleared.count} unanalysed match(es) — they'll be retried this run.`);
    }
  } catch (err) {
    console.warn('[pipeline] could not clear failure counters:', err.message);
  }
}

/**
 * Re-analyse matches that already have a pick — used after a change to
 * the analysis process (a new factor list, new weighting) so the queue
 * reflects the current model rather than a mix of old and new.
 *
 * STRICTLY UPCOMING ONLY. A match that has started or been graded is
 * never touched:
 *   - Rewriting a pick on a graded match would change the pick the track
 *     record was computed from, after the outcome is known. That silently
 *     rewrites history and makes every published number meaningless.
 *   - A match already in play can't be bet at the analysed price anyway.
 *
 * The old pick is only deleted once the new analysis has returned, so a
 * failure leaves the existing pick intact rather than blanking the board.
 */
async function reanalyzeUpcoming(sportSlug, { limit = 50, dryRun = true, mode = 'existing' } = {}) {
  // 'all' — the board's default filter. Previously this fell back to
  // tennis, so a button pressed with no sport filter silently ignored
  // every other sport and reported nothing to do.
  if (sportSlug === 'all' || !sportSlug) {
    const parts = [];
    for (const sp of SPORTS) {
      parts.push(await reanalyzeUpcoming(sp, { limit, dryRun, mode }));
    }
    return {
      sport: 'all',
      wouldReanalyse: parts.reduce((n, p) => n + (p.wouldReanalyse || 0), 0),
      estimatedCalls: parts.reduce((n, p) => n + (p.estimatedCalls || 0), 0),
      reanalysed: parts.reduce((n, p) => n + (p.reanalysed || 0), 0),
      failed: parts.reduce((n, p) => n + (p.failed || 0), 0),
      matches: parts.flatMap((p) => p.matches || []).slice(0, 20),
      bySport: parts,
    };
  }

  const sportRow = await db.sport.findUnique({ where: { slug: sportSlug } });
  if (!sportRow) return { sport: sportSlug, error: 'unknown sport' };

  // mode 'missing'  — matches sitting in Upcoming with NO pick at all.
  //                   These are the ones the scheduled run couldn't do:
  //                   no price at the time, or an outage blacklisted them.
  // mode 'existing' — matches that already have a pick, re-run against
  //                   the current process.
  const pickFilter = mode === 'missing'
    ? { none: { pickType: { in: ['model', 'winner'] }, market: 'moneyline' } }
    : {
        some: { pickType: { in: ['model', 'winner'] }, market: 'moneyline' },
        none: { result: { isNot: null } }, // never a graded match
      };

  // Bound to the SAME window the board shows: today plus tomorrow.
  //
  // Without this the count came from every upcoming analysed match in the
  // database, including fixtures days out that were analysed before the
  // today-only rule existed and never appear on screen. The button then
  // offered to re-run 70 when the column showed 44 — technically true,
  // but it should act on what you're looking at, and the difference is
  // real money.
  const { endOfDay: endOfTomorrow } = getPacificDayBounds(1);

  const candidates = await db.match.findMany({
    where: {
      sportId: sportRow.id,
      status: 'scheduled',
      startTime: { gt: new Date(), lte: endOfTomorrow },
      skipAnalysis: false,
      picks: pickFilter,
    },
    include: { picks: { where: { pickType: { in: ['model', 'winner', 'live'] } } } },
    orderBy: { startTime: 'asc' },
    take: limit,
  });

  if (dryRun) {
    return {
      sport: sportSlug,
      wouldReanalyse: candidates.length,
      estimatedCalls: candidates.length,
      matches: candidates.slice(0, 20).map((m) => `${m.competitorA} vs ${m.competitorB}`),
      note: 'dryRun — nothing changed. Re-run with dryRun:false to execute.',
    };
  }

  let done = 0, failed = 0;
  for (const match of candidates) {
    try {
      const fresh = await fetchMatches(sportSlug);
      const m = fresh.find((x) => x.externalId === match.externalId);
      if (!m || m.oddsA === null || m.oddsB === null) { failed++; continue; }

      const analysis = await analyzeMatchWithRetry({
        sport: sportSlug,
        competitorA: m.competitorA,
        competitorB: m.competitorB,
        oddsA: m.oddsA,
        oddsB: m.oddsB,
        startTime: m.startTime,
        spread: m.spread,
        spreadOddsA: m.spreadOddsA,
        spreadOddsB: m.spreadOddsB,
        total: m.total,
        overOdds: m.overOdds,
        underOdds: m.underOdds,
        sportKey: m.sportKey,
      }, `${m.competitorA} vs ${m.competitorB} (reanalyse)`);

      if (!analysis) { failed++; continue; }

      // A forced run should not be blocked next cycle by a counter left
      // over from whatever originally stopped this match.
      if (match.analysisFailCycles > 0) {
        await db.match.update({ where: { id: match.id }, data: { analysisFailCycles: 0 } }).catch(() => {});
      }

      const pickedOdds = analysis.selection.startsWith(m.competitorA) ? m.oddsA : m.oddsB;

      // Replace only AFTER a successful analysis.
      await db.pick.deleteMany({
        where: { matchId: match.id, pickType: { in: ['model', 'winner'] } },
      });
      await db.pick.create({
        data: {
          match: { connect: { id: match.id } },
          pickType: 'model',
          market: 'moneyline',
          selection: analysis.selection,
          confidence: analysis.confidence,
          conviction: analysis.conviction || 'guess',
          odds: pickedOdds,
          rationale: analysis.analysis,
          factsUsed: JSON.stringify(analysis.factors || []),
        },
      });
      done++;
      console.log(`[reanalyse] ${m.competitorA} vs ${m.competitorB} -> ${analysis.selection} ${analysis.confidence}% (${analysis.conviction})`);
    } catch (err) {
      failed++;
      console.warn(`[reanalyse] ${match.competitorA} vs ${match.competitorB} failed: ${err.message}`);
    }
  }

  return { sport: sportSlug, reanalysed: done, failed, considered: candidates.length };
}

async function runAll() {
  analysisSuccessesThisRun = 0;

  // Clear failure counters on matches that are still upcoming and still
  // have no pick. Those counters exist to stop hammering one genuinely
  // broken match — but they're permanent, so any outage (no API credit,
  // a bad key, a provider hiccup) silently blacklists the whole slate
  // forever. A process start is a sensible "try again" boundary: the
  // per-cycle cap still applies within a run, so the retry cost stays
  // bounded, but a fixed outage no longer leaves matches unanalysable.
  await clearStaleFailureCounters();
  await ensureSportRows();
  // Concurrent, not sequential — SPORTS order used to double as processing
  // order, which meant a heavy day for one sport (30 tennis matches, each
  // a real API call) could eat the entire cycle before sports later in
  // the list (baseball, football) ever got a turn. Each sport's matches
  // are independent (own DB rows, own API calls), so there's no reason
  // they need to wait on each other.
  // .catch per sport, not a bare Promise.all: Promise.all rejects as soon
  // as ANY sport throws, abandoning the others mid-flight. One sport's
  // provider hiccup shouldn't cost the whole slate a cycle.
  await Promise.all(
    SPORTS.map((sport) =>
      runForSport(sport).catch((err) => {
        console.error(`[pipeline] ${sport} run failed:`, err.message);
        recordError(`${sport} pipeline run failed: ${err.message}`);
      })
    )
  );
}

async function runAllTomorrow() {
  await ensureSportRows();
  // Same reset as the daily run. Without this a manual "run for tomorrow"
  // silently skipped every match still carrying an outage-era failure
  // counter — which is exactly what happened.
  await clearStaleFailureCounters();
  await Promise.all(
    SPORTS.map((sport) =>
      runForSport(sport, 'tomorrow').catch((err) => {
        console.error(`[pipeline] ${sport} tomorrow-run failed:`, err.message);
        recordError(`${sport} tomorrow run failed: ${err.message}`);
      })
    )
  );
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
//
// isRunning guards against overlapping runs. With enough new matches in
// one cycle (a busy tennis day especially — real API calls with web
// search per match add up fast), a single runAll() can take longer than
// the 15-minute schedule itself. Without this guard, node-cron fires a
// new run anyway, stacking on top of the one still in progress — and
// since SPORTS is processed in strict order (tennis, basketball, soccer,
// baseball, football), sports later in that list can end up perpetually
// starved as each new overlapping run restarts from tennis. A skipped
// cycle here just means the next one 15 minutes later picks up where
// things stand — never a lost match, since alreadyHasPicks still governs
// what actually needs analysis.
let isRunning = false;

function startScheduled() {
  cron.schedule('*/15 * * * *', () => {
    if (isRunning) {
      console.warn('[pipeline] previous run still in progress — skipping this cycle to avoid stacking.');
      return;
    }
    isRunning = true;
    runAll()
      .then(() => beat('Pregame analysis'))
      .catch((err) => console.error('[pipeline] scheduled run failed:', err))
      .finally(() => { isRunning = false; });
  });
  registerHeartbeat('Pregame analysis', 15 * 60 * 1000);
  console.log('[pipeline] scheduled to run every 15 minutes.');

  // Run once shortly after boot. cron.schedule only fires on the quarter
  // hour, so a deploy landing at :16 meant no analysis until :30 — and
  // deploying again before then reset the clock, so on a day with
  // frequent deploys the pregame pipeline could go hours without ever
  // completing a cycle. That's exactly how the board ends up showing
  // "0 analyzed" with every row stuck on AWAITING ANALYSIS while the
  // historical stats look perfectly healthy.
  //
  // Safe to run on every start: the existing-picks guard in runForSport
  // skips any match that already has a pick, so this can never pay for
  // the same analysis twice. The 25s delay lets the DB pool and the
  // first ESPN poll settle first.
  setTimeout(() => {
    if (isRunning) return;
    isRunning = true;
    console.log('[pipeline] running initial cycle on startup.');
    runAll()
      .then(() => beat('Pregame analysis'))
      .catch((err) => console.error('[pipeline] startup run failed:', err))
      .finally(() => { isRunning = false; });
  }, 25000);
}

/**
 * Manual trigger for an admin "Run Pipeline Now" button — real use case
 * is recovering after a balance-ran-out window instead of waiting up to
 * 15 minutes for the next scheduled cycle. Shares the SAME isRunning
 * guard as the scheduled runs, so a manual trigger can never stack on
 * top of one already in progress (scheduled or manual) — it just
 * returns { started: false } if something's already running, rather
 * than kicking off a second overlapping run.
 */
async function triggerManualRun() {
  if (isRunning) {
    return { started: false, reason: 'A pipeline run is already in progress.' };
  }
  isRunning = true;
  runAll()
    .catch((err) => console.error('[pipeline] manually-triggered run failed:', err))
    .finally(() => { isRunning = false; });
  return { started: true };
}

/**
 * Same as triggerManualRun, but scoped to tomorrow's matches only —
 * real use case: kicking off tomorrow's slate fresh right after using
 * "Skip Today's Backlog", without waiting for tomorrow to actually
 * arrive on the clock or touching anything from today. Shares the same
 * isRunning guard, so it can't overlap with a normal scheduled run or
 * another manual trigger either.
 */
async function triggerManualRunTomorrow() {
  if (isRunning) {
    return { started: false, reason: 'A pipeline run is already in progress.' };
  }
  isRunning = true;
  runAllTomorrow()
    .catch((err) => console.error('[pipeline] manually-triggered tomorrow run failed:', err))
    .finally(() => { isRunning = false; });
  return { started: true };
}

/**
 * Fast loop: re-scores picks for matches that are currently live.
 * Runs far more often than the main pipeline so the live picks board's
 * confidence numbers actually move as the market re-prices the match
 * during play. Unlike the main pick-creation loop, this UPDATES existing
 * picks instead of skipping them once they exist.
 */
// Tracks the last time each live-total pick actually got a real Claude
// reassessment call, independent of how often the outer live loop
// itself runs (see LIVE_TOTAL_REASSESS_INTERVAL_MS below, inside
// updateLivePicksForSport) — in-memory only, resets on redeploy, which
// is fine since a fresh reassessment on restart is harmless.
const lastTotalReassessAt = new Map();

// FAVOURITE DOWN — the alert for the strategy of backing the model's
// favourite once they drop a set and the price lengthens.
//
// Three conditions, all required:
//   1. The pregame pick was a FAVOURITE (negative odds). A dog going
//      further behind is not this trade.
//   2. They are now BEHIND — a set down in tennis, trailing on score
//      elsewhere. Price drift alone isn't enough; the alert is about the
//      market overreacting to a specific event.
//   3. The live price is materially longer than the pregame entry.
//
// Fires once per match per band so a long match can't spam. Sent to
// Surfaced on the board itself — the row highlights and flashes.
// Tennis distress signals, derived from the set score alone.
//
// No serve data is needed for any of these, which matters because ESPN's
// scoreboard doesn't carry first-serve percentage or break points — only
// games and sets.
//
// The break detection is exact rather than a guess: in tennis a player
// leading a set by TWO OR MORE GAMES must have broken serve at least
// once, because holding alone can never produce more than a one-game
// lead. So "4-2" is proof of a break without knowing who served.
/**
 * Market-implied lean, as a signed factor from -1 to +1.
 *
 * Converts both American prices to implied probabilities, strips the
 * bookmaker's overround so they sum to 1, and returns how far the market
 * leans toward side A: +1 is a certainty on A, -1 a certainty on B, 0 a
 * true coin flip. Live confidence is derived from this, which is why
 * every live match was skipped while it was missing.
 *
 * Returns null when either price is absent or implausible, so a bad quote
 * leaves the existing confidence untouched rather than overwriting it
 * with a number derived from garbage.
 */
function marketImpliedFactor(oddsA, oddsB) {
  if (typeof oddsA !== 'number' || typeof oddsB !== 'number') return null;
  if (!Number.isFinite(oddsA) || !Number.isFinite(oddsB)) return null;

  const implied = (o) => {
    if (o === 0) return null;
    return o > 0 ? 100 / (o + 100) : -o / (-o + 100);
  };

  const pA = implied(oddsA);
  const pB = implied(oddsB);
  if (pA === null || pB === null) return null;

  const total = pA + pB;
  if (!(total > 0)) return null;

  // De-vig: normalise so the two sides sum to 1 before comparing them.
  const fairA = pA / total;
  return Math.max(-1, Math.min(1, (fairA - 0.5) * 2));
}

function tennisSignals(setScore, oursIsA) {
  if (!setScore || typeof setScore !== 'string') return [];
  const sets = setScore.split(',').map((x) => x.trim()).filter(Boolean)
    .map((sc) => {
      const [a, b] = sc.split('-').map((n) => parseInt(n, 10));
      return Number.isFinite(a) && Number.isFinite(b) ? { ours: oursIsA ? a : b, theirs: oursIsA ? b : a } : null;
    })
    .filter(Boolean);
  if (!sets.length) return [];

  const signals = [];
  const setIsOver = (s) => (s.ours >= 6 || s.theirs >= 6) && Math.abs(s.ours - s.theirs) >= 2
    || s.ours === 7 || s.theirs === 7; // 7-5 and 7-6 both close a set

  // Opening set — the single biggest live-price mover in tennis.
  const first = sets[0];
  if (setIsOver(first) && first.theirs > first.ours) signals.push('lost the opening set');

  // Sets won so far.
  const setsWonOurs = sets.filter((s) => setIsOver(s) && s.ours > s.theirs).length;
  const setsWonTheirs = sets.filter((s) => setIsOver(s) && s.theirs > s.ours).length;
  if (setsWonTheirs > setsWonOurs) signals.push(`down ${setsWonTheirs}-${setsWonOurs} on sets`);

  // Current set, if one is in progress.
  const current = sets[sets.length - 1];
  if (!setIsOver(current)) {
    const gap = current.theirs - current.ours;
    if (gap >= 2) {
      const setNo = sets.length;
      signals.push(`broken in set ${setNo} (${current.ours}-${current.theirs})`);
    }
  }
  return signals;
}

const favouriteDownAlerted = new Map(); // matchId -> highest band already sent

async function maybeAlertFavouriteDown({ match, m, existingLive, lockedSideIsA, lockedOdds }) {
  try {
    const pregame = await db.pick.findFirst({
      where: { matchId: match.id, market: 'moneyline', pickType: { in: ['model', 'winner'] } },
      orderBy: { createdAt: 'asc' },
    });
    if (!pregame || typeof pregame.odds !== 'number' || pregame.odds >= 0) return; // favourites only
    if (pregame.selection !== existingLive.selection) return; // sides disagree — say nothing

    // WHAT went wrong, not just that something did. For tennis these come
    // from the set score; other sports fall back to the running score.
    const signals = tennisSignals(match.setScore, lockedSideIsA);

    const ourScore = lockedSideIsA ? match.homeScore : match.awayScore;
    const theirScore = lockedSideIsA ? match.awayScore : match.homeScore;
    const behindOnScore = ourScore != null && theirScore != null && ourScore < theirScore;

    // A tennis signal is enough on its own — being broken early in set one
    // moves the price well before the set count changes, which is exactly
    // the window worth acting in. Non-tennis still needs a scoreline.
    if (!signals.length && !behindOnScore) return;

    // Price improvement, in profit per $100 staked — the only measure of
    // "better odds" that means anything across the +/- boundary.
    const profitPer100 = (o) => (o > 0 ? o : (100 / Math.abs(o)) * 100);
    const gainPct = Math.round(((profitPer100(lockedOdds) - profitPer100(pregame.odds)) / profitPer100(pregame.odds)) * 100);
    if (gainPct < 25) return;

    const band = gainPct >= 100 ? 100 : gainPct >= 50 ? 50 : 25;
    if ((favouriteDownAlerted.get(match.id) || 0) >= band) return;
    favouriteDownAlerted.set(match.id, band);

    const fmt = (o) => (o > 0 ? `+${o}` : `${o}`);
    const what = signals.length
      ? signals.join(' · ')
      : `trailing ${ourScore}-${theirScore}`;

    console.log(`[favourite-down] ${match.competitorA} vs ${match.competitorB}: ${pregame.selection} — ${what} — ${fmt(pregame.odds)} -> ${fmt(lockedOdds)} (+${gainPct}%)`);

    // No outbound delivery. This signal now lives on the board itself —
    // the row highlights and flashes — which reaches every user rather
    // than only whoever configured a webhook. The log line above is for
    // debugging, not notification.
  } catch (err) {
    // Never let an alert break the live pipeline.
    console.warn('[favourite-down] check failed:', err.message);
  }
}

async function updateLivePicksForSport(sportSlug, onlyKeys) {
  // Live odds are a paid, per-sport decision — see LIVE_ODDS_SPORTS.
  if (!LIVE_ODDS_SPORTS.includes(sportSlug)) return 0;
  // A database check before an API call. The live loop used to fetch odds
  // for all five sports on every cycle regardless of whether any of them
  // had a match in progress — paying for football odds at 4am when the
  // NFL hasn't played in months. Every skipped sport here is a credit
  // saved with zero loss of information.
  const liveDbMatches = await db.match.findMany({
    where: { sport: { slug: sportSlug }, status: { in: ['live', 'in_progress'] } },
    select: { externalId: true },
  });
  if (liveDbMatches.length === 0) return 0;
  const liveExternalIds = new Set(liveDbMatches.map((r) => r.externalId));

  let matches;
  try {
    // onlyKeys targets a single tournament when a scoring event named one.
    matches = await fetchMatches(sportSlug, onlyKeys);
  } catch (err) {
    console.error(`[live-pipeline] ${sportSlug} fetch failed:`, err.message);
    return 0;
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

  // Filter on the DATABASE's status, not the provider's.
  //
  // This was `m.status`, which is the odds provider's own guess — and
  // that guess was just changed to never say "live", because the provider
  // only knows when a match was SCHEDULED to start, not whether it
  // actually did. ESPN determines live state and writes it to the
  // database. So this filter silently matched nothing every cycle and the
  // live confidence meter stopped moving entirely: a regression from the
  // ESPN-authority change, not a new problem with odds.
  const liveMatches = matches.filter((m) => liveExternalIds.has(m.externalId));
  if (liveMatches.length === 0) return 0;

  for (const m of liveMatches) {
   // One match's failure must never abort the whole sport's live run.
   // A single tennis match with a malformed live-total write used to
   // throw here and kill the entire cycle — every OTHER match's
   // moneyline odds and confidence silently stopped updating as a
   // result, with only one line in the logs to show for it. Isolate
   // per match so one bad row costs one row.
   try {
    const match = await db.match.findUnique({ where: { externalId: m.externalId } });
    if (!match) continue; // main pipeline hasn't picked this one up yet

    // Live odds are helpful context, not a requirement — plenty of books
    // don't offer an in-play market for every match/sport at all (not a
    // brief suspension, a genuine absence for that match's whole live
    // duration). The judgment itself is driven by score + scouting, so a
    // missing live price should never block the pick from existing.
    const hasLiveOdds = m.oddsA !== null && m.oddsB !== null;

    // The live board tracks exactly ONE evolving MONEYLINE pick per match
    // (market scoped explicitly now that live total picks also exist with
    // the same pickType), kept entirely separate from the pre-match
    // "model"/"winner" picks — those are the frozen prediction that
    // Today's Picks, the archive, and all stats read from, and must NEVER
    // be touched once a match goes live.
    const existingLive = await db.pick.findFirst({
      where: { matchId: match.id, pickType: 'live', market: 'moneyline' },
    });

    if (existingLive) {
      // Product decision: the PICK itself is locked the moment it's
      // first set live — only confidence and the displayed price move
      // after that, using real live-odds movement, never a fresh Claude
      // call. This is deliberately NOT the same math as the pregame/
      // create-new-pick path below, which always reports confidence for
      // whichever side the market currently favors (so it never drops
      // below 50). Once locked, confidence needs to be able to honestly
      // fall below 50% — that's the real signal that the market has
      // turned against the pick you're actually showing, not something
      // to hide by silently flipping the selection to match.
      // SELF-HEAL: live picks created before the inherit-from-pregame fix
      // may hold the market's side rather than the model's. The update
      // path below deliberately never changes selection, so those rows
      // would stay wrong for the rest of the match. Correct them once,
      // here, against the frozen pregame pick.
      const pregameForCheck = await db.pick.findFirst({
        where: { matchId: match.id, pickType: { in: ['model', 'winner'] }, market: 'moneyline' },
        orderBy: { createdAt: 'asc' },
      });
      if (pregameForCheck && pregameForCheck.selection !== existingLive.selection) {
        console.warn(`[live-pipeline] correcting live pick side for ${m.competitorA} vs ${m.competitorB}: "${existingLive.selection}" -> "${pregameForCheck.selection}" (must match the frozen pregame pick).`);
        await db.pick.update({
          where: { id: existingLive.id },
          data: { selection: pregameForCheck.selection },
        });
        existingLive.selection = pregameForCheck.selection; // so the confidence math below uses the corrected side
      }

      if (hasLiveOdds) {
        const lockedSideIsA = existingLive.selection === `${m.competitorA} ML`;
        const normalized = marketImpliedFactor(m.oddsA, m.oddsB); // -1..+1, positive favors A
        if (normalized !== null) {
          const signedForLockedSide = lockedSideIsA ? normalized : -normalized;
          const confidence = Math.max(0, Math.min(100, Math.round(50 + signedForLockedSide * 50)));
          const lockedOdds = lockedSideIsA ? m.oddsA : m.oddsB;
          await db.pick.update({
            where: { id: existingLive.id },
            data: { confidence, odds: lockedOdds }, // selection intentionally untouched — locked
          });

          await maybeAlertFavouriteDown({ match, m, existingLive, lockedSideIsA, lockedOdds });
        }
      }
      // No live odds this cycle — leave confidence/odds exactly as they
      // are. Never guess a number with nothing real to derive it from,
      // same rule this whole pipeline follows everywhere else.
    } else {
      // A match's FIRST live pick. The side is INHERITED from the frozen
      // pregame pick — never re-derived from the market.
      //
      // This used to pick whichever side the market currently favored,
      // which produced a real contradiction on screen: the model's
      // researched pregame pick (say Rybakina) stayed in the detail
      // drawer while the live row flipped to Osaka the moment she won a
      // set and the market moved. Two different picks for one match.
      //
      // The live record exists to track what the MODEL'S pick is worth
      // right now, not to restate who the market likes. If the market
      // turns against the pick, that has to show as falling confidence
      // and a longer price — which is exactly the better-price signal
      // this product is built around — not as a silent switch to the
      // other side.
      const pregamePick = await db.pick.findFirst({
        where: { matchId: match.id, pickType: { in: ['model', 'winner'] }, market: 'moneyline' },
        orderBy: { createdAt: 'asc' },
      });

      const sourceOddsA = hasLiveOdds ? m.oddsA : match.closingOddsA;
      const sourceOddsB = hasLiveOdds ? m.oddsB : match.closingOddsB;
      if (sourceOddsA === null || sourceOddsB === null) continue; // genuinely nothing to derive a number from yet — try again next cycle once odds exist

      const normalized = marketImpliedFactor(sourceOddsA, sourceOddsB); // -1..+1, positive favors A
      if (normalized === null) continue;

      let selection;
      let sideIsA;
      if (pregamePick) {
        selection = pregamePick.selection;              // locked to the model's real call
        sideIsA = selection === `${m.competitorA} ML`;
      } else {
        // No pregame analysis ever ran for this match (rare). Nothing to
        // inherit, so fall back to the market — but this is the ONLY
        // case where the market chooses the side.
        sideIsA = normalized >= 0;
        selection = sideIsA ? `${m.competitorA} ML` : `${m.competitorB} ML`;
      }

      // Confidence is signed for the side we actually hold, so it can
      // honestly fall below 50% when the market has turned against the
      // pick — same rule the locked-update branch above uses.
      const signedForSide = sideIsA ? normalized : -normalized;
      const confidence = Math.max(0, Math.min(100, Math.round(50 + signedForSide * 50)));

      await db.pick.create({
        data: {
          match: { connect: { id: match.id } },
          pickType: 'live',
          isLive: true,
          selection,
          confidence,
          odds: sideIsA ? sourceOddsA : sourceOddsB,
          rationale: 'Live confidence tracks the current market price of the model\'s pregame pick — the pick itself never changes once the match starts.',
          factsUsed: JSON.stringify([]),
        },
      });
    }

    // Basketball + football + baseball: a separate evolving TOTAL pick,
    // tracked in parallel with the moneyline one above using the real
    // pace formula as grounding. Quarter-based sports need period+clock
    // data; baseball only needs the current inning (no clock exists);
    // soccer needs a parseable liveClock string (its count-up clock,
    // captured separately from the countdown-clock sports' period/clock).
    // Never fabricates a projection when the needed data isn't there yet.
    const hasNeededClockData = SETS_BASED_SPORTS.includes(sportSlug)
      ? match.setScore != null && match.homeScore != null && match.awayScore != null // tennis: needs live set score + sets won by each side
      : COUNT_UP_CLOCK_SPORTS.includes(sportSlug)
        ? parseElapsedMinutesFromDisplayClock(match.liveClock) !== null
        : QUARTER_BASED_SPORTS.includes(sportSlug)
          ? match.period != null && match.clockSeconds != null
          : match.period != null; // baseball: just needs the inning number

    // Totals live on the DATABASE match row (populated by the main
    // pipeline, which fetches the spreads/totals markets). fetchMatches()
    // here only requests markets=h2h, so m.total / m.overOdds /
    // m.underOdds are ALWAYS undefined — the old `m.total !== null` gate
    // passed on undefined and let this whole block run on missing data,
    // producing `selection: "Under undefined"` and a create with no odds.
    // Prisma rejected it, which threw and aborted the ENTIRE live run —
    // taking the moneyline odds updates down with it every cycle.
    const liveTotalLine = match.total;
    const liveOverOdds = match.overOdds;
    const liveUnderOdds = match.underOdds;
    if (TOTAL_FORMULA_SPORTS.includes(sportSlug) && liveTotalLine != null && hasNeededClockData) {
      const combinedScoreSoFar = (match.homeScore || 0) + (match.awayScore || 0);
      let liveProjection;
      if (SETS_BASED_SPORTS.includes(sportSlug)) {
        liveProjection = computeLiveProjectedTotalGames({
          liveSetScore: match.setScore,
          league: match.league,
          setsWonA: match.homeScore,
          setsWonB: match.awayScore,
        });
      } else if (QUARTER_BASED_SPORTS.includes(sportSlug)) {
        liveProjection = computeLiveProjectedTotal({
          sport: sportSlug,
          league: match.league,
          combinedScoreSoFar,
          period: match.period,
          clockSecondsRemaining: match.clockSeconds,
        });
      } else if (COUNT_UP_CLOCK_SPORTS.includes(sportSlug)) {
        liveProjection = computeLiveProjectedTotalGoals({
          goalsSoFar: combinedScoreSoFar,
          minutesElapsed: parseElapsedMinutesFromDisplayClock(match.liveClock),
        });
      } else {
        liveProjection = computeLiveProjectedTotalByInnings({
          combinedRunsSoFar: combinedScoreSoFar,
          currentInning: match.period,
        });
      }

      const existingLiveTotal = await db.pick.findFirst({
        where: { matchId: match.id, pickType: 'live', market: 'total' },
      });

      if (existingLiveTotal) {
        // Real cost gate, independent of LIVE_PIPELINE_INTERVAL_MS.
        // This Claude call used to inherit whatever cadence the outer
        // live loop ran at — fine back when that loop itself was 15
        // minutes, but now that Live Now's odds-based confidence needs
        // a much faster loop (2 min), letting this Claude call ride
        // along unthrottled would multiply its cost by ~7.5x with no
        // one having actually decided that. This keeps its own slower,
        // separately-configurable minimum spacing regardless of how
        // often the outer loop ticks.
        const lastReassessedAt = lastTotalReassessAt.get(existingLiveTotal.id) || 0;
        const totalReassessIntervalMs = Number(process.env.LIVE_TOTAL_REASSESS_INTERVAL_MS) || 900000; // 15 min default — matches the original combined-loop cadence this is now decoupled from
        if (Date.now() - lastReassessedAt >= totalReassessIntervalMs) {
          const reassessment = await reassessLiveTotal({
            sport: sportSlug,
            competitorA: m.competitorA,
            competitorB: m.competitorB,
            total: liveTotalLine,
            liveScore: match.liveScore,
            liveProjection,
            priorAnalysis: existingLiveTotal.rationale,
          });
          lastTotalReassessAt.set(existingLiveTotal.id, Date.now());
          if (reassessment) {
            const freshPrice = reassessment.selection.startsWith('Over') ? liveOverOdds : liveUnderOdds;
            await db.pick.update({
              where: { id: existingLiveTotal.id },
              data: {
                selection: reassessment.selection,
                confidence: reassessment.confidence,
                rationale: reassessment.analysis,
                ...(freshPrice != null && { odds: freshPrice }), // only touch odds if this cycle actually has a fresh price — required field, never null it out
              },
            });
          }
        }
        // Gate not yet cleared — skip the Claude call entirely this
        // cycle, leave the existing live-total pick exactly as it was.
      } else if (liveProjection) {
        // First cycle a live projection actually exists for this match —
        // seed the live total pick from it directly rather than waiting
        // for a reassessment cycle, so it doesn't sit at whatever the
        // pregame total pick said while the game is already underway.
        // Field name differs by which module produced this (teamTotals.js
        // uses projectedFinal, tennisTotalGames.js uses projectedTotal) —
        // normalize here rather than assuming one name everywhere.
        const projectedFinalValue = liveProjection.projectedFinal !== undefined ? liveProjection.projectedFinal : liveProjection.projectedTotal;
        const seedSelection = projectedFinalValue > liveTotalLine ? `Over ${liveTotalLine}` : `Under ${liveTotalLine}`;
        const seedPrice = seedSelection.startsWith('Over') ? liveOverOdds : liveUnderOdds;
        const paceUnit = SETS_BASED_SPORTS.includes(sportSlug) ? 'games/set' : sportSlug === 'baseball' ? 'runs/inning' : sportSlug === 'soccer' ? 'goals/min' : 'pts/min';
        if (seedPrice != null) { // != null catches undefined too — a missing price must never reach Prisma as a required Int
          await db.pick.create({
            data: {
              match: { connect: { id: match.id } },
              pickType: 'live',
              market: 'total',
              isLive: true,
              line: liveTotalLine,
              selection: seedSelection,
              confidence: 55, // neutral starting confidence — first real reassessment cycle refines this with actual judgment, not just the raw formula
              odds: seedPrice,
              rationale: `Seeded from the live formula: ${liveProjection.pace || liveProjection.avgGamesPerSet} ${paceUnit}, projecting a final total of ${projectedFinalValue}.`,
            },
          });
        }
      }
    }
   } catch (err) {
     console.error(`[live-pipeline] ${sportSlug}: skipping ${m.competitorA} vs ${m.competitorB} — ${err.message}`);
   }
  }

  console.log(`[live-pipeline] ${sportSlug}: refreshed ${liveMatches.length} live match(es).`);
  return liveMatches.length;
}

async function updateLivePicks() {
  recordLiveCycleStart();
  let totalReassessed = 0;
  for (const sport of SPORTS) {
    totalReassessed += (await updateLivePicksForSport(sport)) || 0;
  }
  recordLiveCycleComplete(totalReassessed);
}

/**
 * Starts the fast live-picks loop. Uses setInterval rather than
 * node-cron, since node-cron only guarantees minute-level granularity —
 * we need real sub-minute control here.
 *
 * 3 minutes, not 45 seconds: the previous 45-second interval called
 * fetchMatches() for all 5 sports on every tick regardless of whether
 * anything was actually live — roughly 9,600+ Odds API calls/day, enough
 * to burn a 20,000-credit monthly plan in about 2 days. A picks website
 * doesn't need trading-terminal-speed polling; 3 minutes still feels live
 * to a visitor while cutting API usage by roughly 4x. Tune via
 * LIVE_PIPELINE_INTERVAL_MS if you want a different tradeoff.
 */
// Same class of bug as the main pipeline's overlap guard, just never
// applied here. A busy live slate (e.g. 26+ simultaneous live tennis
// matches during a tournament) processed strictly sequentially at up to
// ~45s each can genuinely take longer than the 15-minute interval to
// finish one cycle — meaning the next scheduled run fires while the
// previous one is still grinding through the match list, and without
// this guard, they'd stack: every stacked run reassesses the SAME live
// matches redundantly, real duplicate paid calls, with no relationship
// to backlog/reload timing at all.
let liveIsRunning = false;

// ---- Event-driven live odds ------------------------------------------
// Sports flagged by a real scoring event, with a per-sport cooldown so a
// burst of points can't turn into a burst of paid API calls. The baseline
// interval loop still runs underneath this to catch drift with no scoring.
// Which sports pay for LIVE odds. Pregame analysis still covers every
// sport; this is only about in-play price refreshes, which are the
// expensive part. Tennis is the launch focus: its lines move hardest (a
// single break can swing a price 200 points), which is exactly the
// volatility the "wait for a better number" thesis needs.
const LIVE_ODDS_SPORTS = (process.env.LIVE_ODDS_SPORTS || 'tennis')
  .split(',').map((x) => x.trim()).filter(Boolean);

// Dirty set is keyed by TOURNAMENT, not sport. Tennis runs several events
// at once under separate API keys, so a break at Cincinnati should buy
// Cincinnati's odds and nothing else.
const oddsDirty = new Map(); // sportSlug -> Set(sportKey)
const lastReactiveFetch = new Map(); // sportKey (or sportSlug) -> timestamp

function markOddsDirty(sportSlug, sportKey) {
  if (!LIVE_ODDS_SPORTS.includes(sportSlug)) return; // not paying for live odds here
  if (!oddsDirty.has(sportSlug)) oddsDirty.set(sportSlug, new Set());
  if (sportKey) oddsDirty.get(sportSlug).add(sportKey);
  else oddsDirty.get(sportSlug).add('*'); // unknown tournament — refresh the sport
}

// How soon after a scoring event we're willing to pay for fresh odds.
// Books need a few seconds to reprice anyway, so firing instantly would
// often just buy the stale number.
const REACTIVE_COOLDOWN_MS = Number(process.env.LIVE_REACTIVE_COOLDOWN_MS) || 45000;

async function processDirtySports() {
  if (liveIsRunning) return; // never overlap the scheduled cycle
  const now = Date.now();

  // Cooldown is per TOURNAMENT key, so a busy event can't starve a
  // quieter one running at the same time.
  const work = [];
  for (const [sportSlug, keys] of oddsDirty.entries()) {
    const dueKeys = [...keys].filter((k) => now - (lastReactiveFetch.get(k) || 0) >= REACTIVE_COOLDOWN_MS);
    if (dueKeys.length) work.push([sportSlug, dueKeys]);
  }
  if (!work.length) return;

  liveIsRunning = true;
  try {
    for (const [sportSlug, dueKeys] of work) {
      dueKeys.forEach((k) => {
        oddsDirty.get(sportSlug).delete(k);
        lastReactiveFetch.set(k, now);
      });
      const targeted = dueKeys.filter((k) => k !== '*');
      try {
        const updated = await updateLivePicksForSport(sportSlug, targeted.length ? targeted : null);
        if (updated > 0) {
          console.log(`[live-reactive] ${sportSlug}: refreshed ${targeted.length ? targeted.join(', ') : 'all keys'} after a scoring event.`);
        }
      } catch (err) {
        console.error(`[live-reactive] ${sportSlug} failed: ${err.message}`);
      }
    }
    beat('Live odds');
  } finally {
    liveIsRunning = false;
  }
}

function startReactiveOdds() {
  // Checked often; actual fetches are gated by the cooldown above, so
  // this interval costs nothing on its own.
  setInterval(() => { processDirtySports().catch(() => {}); }, 10000);
  console.log(`[live-reactive] watching for scoring events (cooldown ${Math.round(REACTIVE_COOLDOWN_MS / 1000)}s per sport).`);
}

function startLiveScheduled() {
  const intervalMs = Number(process.env.LIVE_PIPELINE_INTERVAL_MS) || 900000; // 15 minutes — cost-conscious default pre-revenue; drop LIVE_PIPELINE_INTERVAL_MS lower once picks are actually selling
  setInterval(() => {
    if (liveIsRunning) {
      console.warn('[live-pipeline] previous run still in progress — skipping this cycle to avoid stacking on the same live matches.');
      recordLiveOverlapSkip();
      return;
    }
    liveIsRunning = true;
    updateLivePicks()
      .then(() => beat('Live odds'))
      .catch(err => console.error('[live-pipeline] run failed:', err))
      .finally(() => { liveIsRunning = false; });
  }, intervalMs);
  registerHeartbeat('Live odds', intervalMs);
  console.log(`[live-pipeline] scheduled to run every ${Math.round(intervalMs / 1000)} seconds.`);

  // setInterval doesn't fire until a FULL interval has elapsed, so every
  // deploy/restart left live odds and confidence frozen for one whole
  // cycle (15 minutes on the default) with nothing in the logs to explain
  // it — which looked exactly like "live odds are broken." Kick one run
  // off shortly after boot so a restart costs seconds of staleness, not
  // minutes. The short delay lets the DB pool and the first ESPN poll
  // settle first; the same liveIsRunning guard prevents it from
  // overlapping the scheduled cycle.
  setTimeout(() => {
    if (liveIsRunning) return;
    liveIsRunning = true;
    console.log('[live-pipeline] running initial cycle on startup.');
    updateLivePicks()
      .then(() => beat('Live odds'))
      .catch(err => console.error('[live-pipeline] startup run failed:', err))
      .finally(() => { liveIsRunning = false; });
  }, 20000);
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
    recordEspnPoll(sportSlug, true);
  } catch (err) {
    console.error(`[espn-pipeline] ${sportSlug} fetch failed:`, err.message);
    recordEspnPoll(sportSlug, false);
    return;
  }

  let updated = 0;
  for (const event of espnEvents) {
    const match = matchEspnEvent(event, candidateMatches);
    if (!match) continue;

    const newStatus = event.completed ? 'final' : event.inProgress ? 'live' : match.status;

    // ONE canonical live-clock string, computed here and used for BOTH the
    // database write and the WebSocket broadcast. These used to be derived
    // separately and disagreed: the DB stored "Q3 8:42" for quarter sports
    // while the broadcast pushed a bare "8:42", so the displayed clock
    // visibly changed format depending on whether it arrived by socket or
    // by the 20-second poll.
    //   - Quarter sports: "Q{period} {clock}"
    //   - Count-up clock (soccer): ESPN's displayClock is already correct
    //   - Baseball: no clock at all; ESPN's own "Top 7th"/"End 6th" status
    //     is the real source of truth
    let newLiveClock = null;
    if (QUARTER_BASED_SPORTS.includes(sportSlug) && event.period != null && event.displayClock) {
      newLiveClock = `Q${event.period} ${event.displayClock}`;
    } else if (COUNT_UP_CLOCK_SPORTS.includes(sportSlug) && event.displayClock) {
      newLiveClock = event.displayClock;
    } else if (sportSlug === 'baseball' && event.statusDetail) {
      newLiveClock = event.statusDetail;
    }

    await db.match.update({
      where: { id: match.id },
      data: {
        status: newStatus,
        homeScore: event.homeScore,
        awayScore: event.awayScore,
        liveScore: `${event.homeScore} - ${event.awayScore}`,
        ...(event.setScore && { setScore: event.setScore }),
        ...(event.periodScores && { periodScores: event.periodScores }),
        // R/H/E for baseball. Written whenever ESPN reports them; null
        // stays null so an unknown value never renders as a real zero.
        ...(event.homeHits !== null && event.homeHits !== undefined && { homeHits: event.homeHits }),
        ...(event.awayHits !== null && event.awayHits !== undefined && { awayHits: event.awayHits }),
        ...(event.homeErrors !== null && event.homeErrors !== undefined && { homeErrors: event.homeErrors }),
        ...(event.awayErrors !== null && event.awayErrors !== undefined && { awayErrors: event.awayErrors }),
        ...(event.period != null && { period: event.period }),
        ...(event.clockSeconds != null && { clockSeconds: event.clockSeconds }),
        ...(newLiveClock !== null && { liveClock: newLiveClock }),
      },
    });

    // Push to any connected WebSocket clients — but only if something
    // actually changed. ESPN gets polled every 15s regardless of whether
    // the score moved; broadcasting unconditionally would flood clients
    // with no-op messages every cycle for every match, live or not.
    const liveScoreStr = `${event.homeScore} - ${event.awayScore}`;
    // Previously this only compared status and the aggregate score string,
    // which missed most real in-play movement:
    //   - TENNIS: homeScore/awayScore are SETS WON, so every game inside a
    //     set ("6-4, 3-2" -> "6-4, 4-2") changed setScore while the score
    //     string stayed identical — nothing was ever pushed mid-set.
    //   - BASEBALL: "Top 7th" -> "Bot 7th" moves with no runs scoring.
    //   - BASKETBALL/FOOTBALL: the game clock and quarter breakdown move
    //     constantly between scoring plays.
    // Now any real change to the fields we actually display triggers a push.
    const somethingChanged =
      match.status !== newStatus ||
      match.liveScore !== liveScoreStr ||
      (event.setScore && match.setScore !== event.setScore) ||
      (event.periodScores && match.periodScores !== event.periodScores) ||
      (newLiveClock !== null && match.liveClock !== newLiveClock) ||
      (event.period != null && match.period !== event.period);

    if (somethingChanged) {
      // A scoring event is exactly when the price moves — a break of
      // serve, a goal, a run. ESPN polling is free and already runs every
      // 15 seconds, so it makes a far better trigger than a clock: we buy
      // odds when something happened, not on a timer that's either too
      // slow to catch the swing or too fast to afford.
      markOddsDirty(sportSlug, match.sportKey);
      broadcastScoreUpdate({
        matchId: match.id,
        sport: sportSlug,
        matchup: `${match.competitorA} vs ${match.competitorB}`,
        matchStatus: newStatus,
        liveScore: liveScoreStr,
        liveClock: newLiveClock, // same string the DB now stores — no more format mismatch
        period: event.period ?? null,
        setScore: event.setScore || null,
        periodScores: event.periodScores || null,
      });
    }

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
 * Dispatches by pick.market — "moneyline" (the original, unchanged
 * logic), "spread", or "total".
 *
 * A tied final score (soccer draws being the realistic case, since ML has
 * no draw option in the model) is graded as a push rather than forced into
 * a win/loss — nobody actually won that match outright.
 */
function gradeMoneyline(match, pick) {
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
 * Spread grading: pick.selection is "<competitor> <signed line>", e.g.
 * "Celtics -4.5" or "Warriors +4.5". pick.line holds the same number the
 * selection references, captured at pick-creation time (the market's
 * current line can move before settlement — this is what the pick was
 * actually made against). Uses the picked competitor's OWN margin (their
 * score minus the opponent's) plus their own signed line — this formula
 * is symmetric whether the pick was the favorite or the underdog, so no
 * separate branch is needed for each case.
 */
function gradeSpread(match, pick) {
  if (pick.line === null || pick.line === undefined) return null;

  const isA = pick.selection.startsWith(match.competitorA);
  const isB = pick.selection.startsWith(match.competitorB);
  if (!isA && !isB) return null; // unrecognized selection format

  const ownMargin = isA
    ? match.homeScore - match.awayScore
    : match.awayScore - match.homeScore;

  const result = ownMargin + pick.line;
  if (result === 0) return 'push';
  return result > 0 ? 'win' : 'loss';
}

/**
 * Total grading: pick.selection is "Over <line>" or "Under <line>".
 * pick.line holds the line the pick was made against.
 */
function gradeTotal(match, pick) {
  if (pick.line === null || pick.line === undefined) return null;

  const actualTotal = match.homeScore + match.awayScore;
  const isOver = pick.selection.startsWith('Over');
  const isUnder = pick.selection.startsWith('Under');
  if (!isOver && !isUnder) return null; // unrecognized selection format

  if (actualTotal === pick.line) return 'push';
  const wentOver = actualTotal > pick.line;
  return (isOver && wentOver) || (isUnder && !wentOver) ? 'win' : 'loss';
}

function gradePick(match, pick) {
  if (match.homeScore === null || match.awayScore === null) return null;

  if (pick.market === 'spread') return gradeSpread(match, pick);
  if (pick.market === 'total') return gradeTotal(match, pick);
  return gradeMoneyline(match, pick); // default/legacy rows with no market set
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

module.exports = { runAll, reanalyzeUpcoming, startWatchdog, startReactiveOdds, startScheduled, startLiveScheduled, startEspnScheduled, triggerManualRun, triggerManualRunTomorrow };
