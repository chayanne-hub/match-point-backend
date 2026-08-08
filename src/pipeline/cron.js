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

/**
 * Given an existing pick and the freshly-fetched match data for this
 * cycle, returns the current price for whichever side/selection that
 * pick actually made — or null if it can't be determined (unrecognized
 * selection format, or that market's fresh price isn't available this
 * cycle). Never guesses; a missing fresh price just means the caller
 * leaves the pick's existing odds alone rather than overwriting with a
 * fabricated number.
 */
function freshOddsForPick(pick, m) {
  if (pick.market === 'moneyline') {
    if (pick.selection.startsWith(m.competitorA)) return m.oddsA;
    if (pick.selection.startsWith(m.competitorB)) return m.oddsB;
    return null;
  }
  if (pick.market === 'spread') {
    if (pick.selection.startsWith(m.competitorA)) return m.spreadOddsA;
    if (pick.selection.startsWith(m.competitorB)) return m.spreadOddsB;
    return null;
  }
  if (pick.market === 'total') {
    if (pick.selection.startsWith('Over')) return m.overOdds;
    if (pick.selection.startsWith('Under')) return m.underOdds;
    return null;
  }
  return null;
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
        // Lines move until kickoff — keep them fresh on every pull, same
        // as status/startTime already were.
        spread: m.spread,
        spreadOddsA: m.spreadOddsA,
        spreadOddsB: m.spreadOddsB,
        total: m.total,
        overOdds: m.overOdds,
        underOdds: m.underOdds,
      },
      create: {
        externalId: m.externalId,
        sportId: sportRow.id,
        league: m.league,
        competitorA: m.competitorA,
        competitorB: m.competitorB,
        startTime: m.startTime,
        status: m.status,
        spread: m.spread,
        spreadOddsA: m.spreadOddsA,
        spreadOddsB: m.spreadOddsB,
        total: m.total,
        overOdds: m.overOdds,
        underOdds: m.underOdds,
      },
    });

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
      if (m.status === 'live') {
        for (const pick of existingPicks) {
          const freshOdds = freshOddsForPick(pick, m);
          // Never overwrite with null — a book briefly pulling a line
          // (common late in a blowout) shouldn't blank out the last
          // known real price.
          if (freshOdds !== null && freshOdds !== pick.odds) {
            await db.pick.update({ where: { id: pick.id }, data: { odds: freshOdds } });
          }
        }
      }
      continue;
    }

    if (m.oddsA === null || m.oddsB === null) {
      console.warn(`[pipeline] skipping analysis for ${m.competitorA} vs ${m.competitorB} — no odds available.`);
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

    const analysis = await analyzeMatch({
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
          market: 'moneyline',
          selection: analysis.selection,
          confidence: analysis.confidence,
          odds: pickedOdds,
          rationale: analysis.analysis,
          factsUsed: factsUsedJson,
        },
      });
    }

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
  // Concurrent, not sequential — SPORTS order used to double as processing
  // order, which meant a heavy day for one sport (30 tennis matches, each
  // a real API call) could eat the entire cycle before sports later in
  // the list (baseball, football) ever got a turn. Each sport's matches
  // are independent (own DB rows, own API calls), so there's no reason
  // they need to wait on each other.
  await Promise.all(SPORTS.map((sport) => runForSport(sport)));
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
      .catch((err) => console.error('[pipeline] scheduled run failed:', err))
      .finally(() => { isRunning = false; });
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
      // Genuinely re-evaluate each cycle — weighing the live score and
      // the players' known skill/history (via the original pre-match
      // analysis as context) alongside the current odds when available.
      // Odds are real signal (fast market movement can reflect something
      // real — an injury, momentum), but reassessLiveMatch() is
      // explicitly told not to let them be the ONLY driver, and it
      // handles "not available" gracefully when there's no live market.
      const reassessment = await reassessLiveMatch({
        sport: sportSlug,
        competitorA: m.competitorA,
        competitorB: m.competitorB,
        liveScore: match.liveScore,
        oddsA: hasLiveOdds ? m.oddsA : null,
        oddsB: hasLiveOdds ? m.oddsB : null,
        priorAnalysis: existingLive.rationale,
      });

      if (reassessment) {
        // Only touch the displayed price if we actually have a fresh
        // one this cycle — otherwise leave whatever was last stored
        // (real closing/live odds) rather than guessing or nulling it
        // out, since odds is a required field on Pick.
        const updateData = {
          selection: reassessment.selection,
          confidence: reassessment.confidence,
          rationale: reassessment.analysis,
          factsUsed: JSON.stringify(reassessment.factors),
        };
        if (hasLiveOdds) {
          updateData.odds = reassessment.selection === `${m.competitorA} ML` ? m.oddsA : m.oddsB;
        }
        await db.pick.update({ where: { id: existingLive.id }, data: updateData });
      } else if (hasLiveOdds) {
        // Reassessment failed this cycle (timeout, bad response, etc.) —
        // still refresh the displayed price so it doesn't go stale, but
        // leave the judgment (selection/confidence/rationale) untouched
        // rather than guess.
        const currentOdds = existingLive.selection === `${m.competitorA} ML` ? m.oddsA : m.oddsB;
        await db.pick.update({
          where: { id: existingLive.id },
          data: { odds: currentOdds },
        });
      }
    } else {
      const analysis = await analyzeMatch({
        sport: sportSlug,
        competitorA: m.competitorA,
        competitorB: m.competitorB,
        oddsA: hasLiveOdds ? m.oddsA : null,
        oddsB: hasLiveOdds ? m.oddsB : null,
        startTime: m.startTime,
      });
      if (!analysis) continue; // try again next cycle

      // odds is a required field on Pick — if there's no live in-play
      // price, fall back to the closing line captured just before
      // kickoff (a real, genuine market price) rather than blocking
      // pick creation entirely just because no in-play market exists.
      let pickedOdds;
      if (hasLiveOdds) {
        pickedOdds = analysis.selection === `${m.competitorA} ML` ? m.oddsA : m.oddsB;
      } else if (match.closingOddsA !== null && match.closingOddsB !== null) {
        pickedOdds = analysis.selection === `${m.competitorA} ML` ? match.closingOddsA : match.closingOddsB;
      } else {
        continue; // no live odds AND no closing odds on record — genuinely nothing to store, try again next cycle
      }

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

    if (TOTAL_FORMULA_SPORTS.includes(sportSlug) && m.total !== null && hasNeededClockData) {
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
        const reassessment = await reassessLiveTotal({
          sport: sportSlug,
          competitorA: m.competitorA,
          competitorB: m.competitorB,
          total: m.total,
          liveScore: match.liveScore,
          liveProjection,
          priorAnalysis: existingLiveTotal.rationale,
        });
        if (reassessment) {
          const freshPrice = reassessment.selection.startsWith('Over') ? m.overOdds : m.underOdds;
          await db.pick.update({
            where: { id: existingLiveTotal.id },
            data: {
              selection: reassessment.selection,
              confidence: reassessment.confidence,
              rationale: reassessment.analysis,
              ...(freshPrice !== null && { odds: freshPrice }), // only touch odds if this cycle actually has a fresh price — required field, never null it out
            },
          });
        }
      } else if (liveProjection) {
        // First cycle a live projection actually exists for this match —
        // seed the live total pick from it directly rather than waiting
        // for a reassessment cycle, so it doesn't sit at whatever the
        // pregame total pick said while the game is already underway.
        // Field name differs by which module produced this (teamTotals.js
        // uses projectedFinal, tennisTotalGames.js uses projectedTotal) —
        // normalize here rather than assuming one name everywhere.
        const projectedFinalValue = liveProjection.projectedFinal !== undefined ? liveProjection.projectedFinal : liveProjection.projectedTotal;
        const seedSelection = projectedFinalValue > m.total ? `Over ${m.total}` : `Under ${m.total}`;
        const seedPrice = seedSelection.startsWith('Over') ? m.overOdds : m.underOdds;
        const paceUnit = SETS_BASED_SPORTS.includes(sportSlug) ? 'games/set' : sportSlug === 'baseball' ? 'runs/inning' : sportSlug === 'soccer' ? 'goals/min' : 'pts/min';
        if (seedPrice !== null) {
          await db.pick.create({
            data: {
              match: { connect: { id: match.id } },
              pickType: 'live',
              market: 'total',
              isLive: true,
              line: m.total,
              selection: seedSelection,
              confidence: 55, // neutral starting confidence — first real reassessment cycle refines this with actual judgment, not just the raw formula
              odds: seedPrice,
              rationale: `Seeded from the live formula: ${liveProjection.pace || liveProjection.avgGamesPerSet} ${paceUnit}, projecting a final total of ${projectedFinalValue}.`,
            },
          });
        }
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
 *
 * 3 minutes, not 45 seconds: the previous 45-second interval called
 * fetchMatches() for all 5 sports on every tick regardless of whether
 * anything was actually live — roughly 9,600+ Odds API calls/day, enough
 * to burn a 20,000-credit monthly plan in about 2 days. A picks website
 * doesn't need trading-terminal-speed polling; 3 minutes still feels live
 * to a visitor while cutting API usage by roughly 4x. Tune via
 * LIVE_PIPELINE_INTERVAL_MS if you want a different tradeoff.
 */
function startLiveScheduled() {
  const intervalMs = Number(process.env.LIVE_PIPELINE_INTERVAL_MS) || 900000; // 15 minutes — cost-conscious default pre-revenue; drop LIVE_PIPELINE_INTERVAL_MS lower once picks are actually selling
  setInterval(() => {
    updateLivePicks().catch(err => console.error('[live-pipeline] run failed:', err));
  }, intervalMs);
  console.log(`[live-pipeline] scheduled to run every ${Math.round(intervalMs / 1000)} seconds.`);
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
        ...(event.period != null && { period: event.period }),
        ...(event.clockSeconds != null && { clockSeconds: event.clockSeconds }),
        // "Q{period} {clock}" only makes sense for quarter-based sports —
        // baseball's period means inning number, not a quarter, and has
        // no countdown clock at all. Leave liveClock alone for baseball
        // rather than writing a garbled/wrong display string onto it.
        ...(QUARTER_BASED_SPORTS.includes(sportSlug) && event.period != null && event.displayClock && { liveClock: `Q${event.period} ${event.displayClock}` }),
        // Soccer: ESPN's displayClock ("72'", "45+2'") is already in the
        // right display format — no "Q{n}" prefix needed, just persist it
        // directly. This was being fetched already (parseTeamCompetition
        // captures it generically) but never actually saved before now.
        ...(COUNT_UP_CLOCK_SPORTS.includes(sportSlug) && event.displayClock && { liveClock: event.displayClock }),
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

module.exports = { runAll, startScheduled, startLiveScheduled, startEspnScheduled };
