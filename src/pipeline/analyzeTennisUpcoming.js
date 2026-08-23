/**
 * analyzeTennisUpcoming.js — makes Challenger and ITF matches into picks.
 *
 * WHY THIS EXISTS AS ITS OWN PASS.
 *
 * runForSport() analyses whatever fetchMatches() returns from the odds
 * provider, and reanalyzeUpcoming() re-fetches from that same provider to
 * find prices. The odds provider carries no Challenger or ITF on any plan,
 * so lower-tier matches could never obtain a price through either path —
 * they sat in the database pickless no matter how often analysis ran.
 *
 * This pass sources both halves from SportsAPI365 instead:
 *   events/upcoming/{tour}     -> what is coming up, with an event_id
 *   odds/pre-match/{event_id}  -> the opening line (works on ALL tiers)
 *
 * and hands them to the SAME analyst with the SAME parameter shape, so a
 * Challenger pick is produced by identical reasoning to a Cincinnati one.
 * Nothing here touches the existing pipeline's path.
 */

const { fetchUpcomingEvents, resolveExtendId, fetchPreMatchOdds, fetchMatchOdds } = require('./fetchTennisApi.js');
const { buildFactorBrief, renderFactorBrief } = require('./tennisFactors.js');
const { namesLikelyMatch } = require('./fetchEspn.js');
const db = require('../lib/db.js');

const ENABLED = process.env.TENNIS_UPCOMING_ANALYSIS !== 'false';

/**
 * @param analyze  analyzeMatchWithRetry, injected rather than required —
 *                 cron.js owns the concurrency slots and the retry policy,
 *                 and importing it here would create a require cycle.
 * @param blend    blendWithMarket, same reasoning.
 */
// reassessLiveMatch is injected alongside analyze/blend for the same
// reason they are: requiring matchAnalyst here would create a cycle.
async function analyzeTennisUpcoming({ analyze, blend, reassessLiveMatch, limit = 15 } = {}) {
  if (!ENABLED || typeof analyze !== 'function') return { analysed: 0, skipped: 0 };

  const sport = await db.sport.findFirst({ where: { slug: 'tennis' } });
  if (!sport) return { analysed: 0, skipped: 0 };

  /* DRIVEN BY OUR ROWS, NOT BY THE FEED.
   *
   * This used to iterate `fetchUpcomingEvents('atp'|'wta')` and look for
   * a stored row matching each event. That feed is a small extend-space
   * window (a handful at a time) and is mostly MAIN TOUR — which we no
   * longer ingest, since ESPN owns that tier now. So the loop spent its
   * whole run failing to match matches we deliberately don't store,
   * reporting "5 skipped", while 91 Challenger and ITF rows that we DO
   * hold were never even looked at.
   *
   * Inverting it fixes the mismatch: start from the lower-tier rows that
   * need a pick, and resolve each one forward to an extend id for
   * pricing. The feed is no longer the source of truth about what we
   * care about — our own board is. */

  // Only matches we already hold, that have no moneyline pick yet.
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const until = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const candidates = await db.match.findMany({
    where: {
      sportId: sport.id,
      startTime: { gte: since, lte: until },
      status: { notIn: ['final', 'postponed'] },
      skipAnalysis: false,
      picks: { none: { pickType: 'model', market: 'moneyline' } },
    },
  });
  if (!candidates.length) return { analysed: 0, skipped: 0 };

  let failed = 0;
  let analysed = 0, skipped = 0, unpriced = 0, finished = 0;

  // Nearest first: a match starting soon is the one worth a price now.
  candidates.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  /* PRICING WINDOW.
   *
   * Measured against the provider: a Challenger's opening price is
   * published about 45 MINUTES before start (Fearnley v Galarneau —
   * priced 23:15, started 00:00). Before that the match isn't in extend
   * space at all: the resolve returns an empty object.
   *
   * So asking about tomorrow's draw can't work, and every attempt burned
   * two API calls (both name orders) to learn nothing. That is what
   * "37 not yet priced" was actually counting.
   *
   * We only look at matches inside the window where a price can exist.
   * Anything further out isn't unpriceable — it's just early, and it
   * gets picked up automatically on a later cycle as it approaches. */
  // 90 min: double the observed 45-minute lead, so there is margin if
  // another tournament prices earlier, without spending 67 futile
  // lookups per match the way a 3-hour window would. Tunable if a tour
  // turns out to price further ahead.
  /* Analyse from SIX HOURS out, not 90 minutes.
   *
   * The 90-minute default existed because pre-match prices appear late
   * at Challenger and ITF level. But it also meant a member looking at
   * tomorrow's main-tour semi-finals saw an empty board for most of the
   * day, and it left no margin when a start time drifts — a match whose
   * estimate slips can go on court before the window ever opens.
   *
   * Six hours matches TENNIS_PRICE_LOOKAHEAD_H, so ingest fetches a
   * price over the same horizon the analyser is willing to act on;
   * leaving those two out of step is what makes matches sit unpriced. */
  const WINDOW_MS = Number(process.env.TENNIS_PRICE_WINDOW_MS || 6 * 60 * 60 * 1000);

  /* How far ahead we will analyse a match that ALREADY has a price.
   * Three days covers a full tournament week's published markets without
   * reaching into next month's draw. */
  const OUTER_BOUND_MS = Number(process.env.TENNIS_OUTER_BOUND_MS || 72 * 60 * 60 * 1000);
  let tooEarly = 0;

  for (const match of candidates) {
    /* ONE BAD MATCH MUST NOT END THE CYCLE.
     *
     * A single prisma.pick.create() rejection threw straight out of this
     * loop and failed the whole run — 61 matches on the slate, and the
     * ones after the bad row were never looked at. Nothing here is worth
     * sacrificing the rest of the slate for, so each match is isolated
     * and its failure logged with the players' names. */
    try {
    if (analysed >= limit) break;

    const untilStart = new Date(match.startTime).getTime() - Date.now();
    /* THE GATE IS A PRICE, NOT A CLOCK.
     *
     * A time window was the wrong test. Markets for main-tour matches
     * open far earlier than six hours out, so a clock-based cutoff held
     * back matches that were perfectly analysable — and it also left no
     * margin when a start estimate drifts, which is how a semi-final
     * went on court before its window ever opened.
     *
     * If the match has a price, it can be analysed and settled: nothing
     * about being far away makes that untrue. If it has no price there
     * is nothing to bet into, and no window width fixes that.
     *
     * The outer bound only stops us reaching into a draw weeks away that
     * happens to carry a speculative number. */
    const hasStoredPrice = match.bestOddsA !== null && match.bestOddsB !== null;
    if (!hasStoredPrice && untilStart > WINDOW_MS) { tooEarly++; continue; }
    if (untilStart > OUTER_BOUND_MS) { tooEarly++; continue; }

    /* A match already in play cannot be priced from this path.
     *
     * Pre-match odds stop existing the moment a match starts, so an ITF
     * match that went live before its price ever appeared (W15/W35 often
     * price very late, or not at all) would come back here every single
     * cycle, resolve, find no pre-match odds, and count as "not yet
     * priced" — forever, at two API calls a time, while showing
     * "Awaiting Analysis" on the board.
     *
     * They are counted separately so the log tells the truth: these are
     * not pending, they are missed. The live socket carries in-play
     * prices for matches we joined; analysing those is a different
     * product decision (a live pick, not a pre-match one) and is
     * deliberately not done here. */
    /* IN-PLAY MATCHES USE LIVE ODDS.
     *
     * Pre-match odds vanish once a match starts, so an ITF match that
     * went live before its price appeared could never be analysed and
     * sat showing "Awaiting Analysis" indefinitely.
     *
     * But the socket runner writes live prices onto the row for every
     * match it has joined, so the price IS there for in-play matches —
     * just in a different column. We use it, and tell the analyst the
     * match is under way plus the current score, so it is assessing the
     * position in front of it rather than a match that hasn't started.
     *
     * Only matches we actually hold a live price for: without one there
     * is nothing to analyse against, and that is a genuine miss. */
    const isLive = match.status === 'live' || untilStart < 0;
    const hasLiveOdds = isLive
      && typeof match.liveOddsA === 'number' && typeof match.liveOddsB === 'number';

    /* A live match without a socket price is NOT a lost cause.
     *
     * This used to bail here, on my assumption that pre-match odds stop
     * existing once a match starts. That assumption was wrong and we
     * disproved it directly: the pre-match endpoint returned a full
     * Bet365 block for an event whose status was already "Ended". The
     * opening line stays queryable.
     *
     * So a live match falls back to the opening price, which is exactly
     * what a pre-match pick would have used anyway. Nothing is skipped
     * for want of a price until every source has actually been tried. */

    /* CORE ODDS FIRST — that is where the coverage is.
     *
     * We were resolving every match into `extend` space and pricing from
     * there. Extend holds a fraction of the fixtures: measured live, 8
     * events across the whole ATP feed against ~35 lower-tier fixtures
     * we had ingested. A Cancun Challenger with a top-50 player was
     * absent 40 minutes before start.
     *
     * `upcoming/matchodds` is keyed on the CORE ids that arrive with
     * every fixture, so it covers the fixture list rather than a subset.
     * That path is tried first now; extend is only the fallback, for
     * live state and for rows ingested before we stored these ids. */
    let coreOdds = null;
    if (match.playerAId && match.playerBId && match.tournamentId &&
        match.roundId !== null && match.roundId !== undefined) {
      coreOdds = await fetchMatchOdds({
        tour: 'atp',
        player1Id: match.playerAId,
        player2Id: match.playerBId,
        tournamentId: match.tournamentId,
        roundId: match.roundId,
      }).catch(() => null);
    }

    const resolved = await resolveExtendId(match.competitorA, match.competitorB, match.startTime)
      .catch(() => null);

    // Only give up when BOTH paths are dry.
    if (!resolved && !coreOdds) { unpriced++; continue; }

    /* Close finished matches instead of retrying them forever.
     *
     * The provider reports status here. A match that has Ended cannot be
     * priced, so without this it came back every cycle, failed to find
     * odds, and inflated "not yet priced" — while staying `scheduled` on
     * the board. This is also the close-out path lower tiers never had:
     * ESPN doesn't carry Challengers, so nothing else can finalise them. */
    /* ALREADY ON COURT? THEN IT IS NOT A PRE-MATCH BET.
     *
     * startTime is an ESTIMATE in tennis — a match starts when the
     * previous one on that court ends, so the scheduled time drifts by
     * hours. A Cincinnati semi-final was in its SECOND SET while the row
     * still read `scheduled`, "starts in 1h32m". It was duly analysed as
     * a pre-match bet and published at +105: a price that no longer
     * existed, on a match already half-decided. Unbettable, and still
     * counted in the record.
     *
     * The provider knows. resolveExtendId returns the real status, and
     * this check already used it for finished matches — it simply never
     * asked about in-play ones. A match on court is promoted to live so
     * the live path (which reprices from live odds and the score) picks
     * it up on the next cycle instead. */
    /* "NotStarted" contains "started" — a substring test promoted
     * matches that had not begun. Not-started is therefore excluded
     * explicitly before the in-play test, rather than relying on the
     * in-play patterns to be mutually exclusive. */
    const rStatus = String(resolved?.status || '');
    const notStarted = /not.?started|scheduled|upcoming|postponed|cancell?ed/i.test(rStatus);
    const isDone = /ended|finished|retired|walkover/i.test(rStatus);
    const isInPlay = !notStarted && !isDone
      && /inprogress|in.?play|\blive\b|started|set\s*\d/i.test(rStatus);

    if (isInPlay) {
      if (match.status !== 'live') {
        await db.match.update({
          where: { id: match.id },
          data: { status: 'live', ...(resolved.score ? { liveScore: resolved.score } : {}) },
        }).catch(() => {});
        console.log(`[tennisUpcoming] ${match.competitorA} vs ${match.competitorB}: already in play (${resolved.status}) — promoted to live, no pre-match pick.`);
      }
      skipped++;
      continue;
    }

    if (isDone) {
      /* Record the SETS WON as home/away score, not just the string.
       *
       * gradePick() returns null unless homeScore and awayScore are set.
       * We were closing these matches with a score STRING only, so every
       * Challenger and ITF pick sat ungraded forever — invisible to the
       * archive, to "Graded Today", and to the win rate. ESPN carries no
       * lower-tier tennis, so nothing else was ever going to fill those
       * fields in.
       *
       * Sets won is the right number for a tennis moneyline: the player
       * who wins more sets wins the match, which is what the pick was on. */
      const data = { status: 'final' };
      if (resolved.score) {
        // liveScore, NOT liveSetScore — the latter is not a column on
        // Match, so this update threw. It sat inside a .catch(() => {}),
        // which meant every close-out failed SILENTLY: no final status,
        // no scores, no grading, and nothing in the logs to show for it.
        data.liveScore = resolved.score;
        data.setScore = resolved.score;

        /* Only count DECIDED sets.
         *
         * Counting "whoever is ahead" treats an unfinished set as won:
         * a retirement at 6-2, 5-3 was recorded as 2-0 when the player
         * had actually won one set and was merely leading the second.
         *
         * Usually harmless, but 6-4, 2-5 comes out 1-1 — a tie — and a
         * moneyline grader handed a tie either pushes the pick or picks
         * a winner arbitrarily. A set is won at 6 with two clear games,
         * or at 7. Anything else is still in progress. */
        let setsA = 0, setsB = 0;
        String(resolved.score).split(',').forEach((chunk) => {
          const [a, b] = chunk.trim().split('-').map(Number);
          if (isNaN(a) || isNaN(b)) return;
          const decided = (a >= 6 || b >= 6) && (Math.abs(a - b) >= 2 || a === 7 || b === 7);
          if (!decided) return;
          if (a > b) setsA++; else if (b > a) setsB++;
        });

        // The feed lists players in ITS order; `flipped` tells us whether
        // that is reversed relative to how we store the match.
        /* RETIREMENT / WALKOVER: the leader takes it.
         *
         * Decided sets alone can leave a retirement level (6-4, 2-5) or
         * scoreless (2-5 in the first set) — and a match with no result
         * never grades, so the pick silently vanishes from the record.
         *
         * When a match ends early the player ahead wins it, so the
         * unfinished set is awarded to whoever was leading. Only applied
         * when the provider says the match ended early, never to a
         * normally completed one. */
        const endedEarly = /retired|walkover|w\/o/i.test(resolved.status || '');
        if (endedEarly) {
          /* The leader wins the MATCH, not merely the unfinished set.
           *
           * Awarding just the set left 6-4, 2-5 at 1-0 — handing the
           * match to the player who took the first set while his
           * opponent was 5-2 up in the second and he was the one
           * walking off. Whoever is ahead when play stops is the one
           * who advances, so their set count is set above the other's.
           *
           * The last set in progress is the best available read on who
           * was ahead at the moment it ended. */
          const last = String(resolved.score).split(',').pop().trim().split('-').map(Number);
          const decidedLast = !isNaN(last[0]) && !isNaN(last[1]) &&
            (last[0] >= 6 || last[1] >= 6) &&
            (Math.abs(last[0] - last[1]) >= 2 || last[0] === 7 || last[1] === 7);

          if (!decidedLast && !isNaN(last[0]) && !isNaN(last[1]) && last[0] !== last[1]) {
            if (last[0] > last[1]) setsA = Math.max(setsA, setsB + 1);
            else                   setsB = Math.max(setsB, setsA + 1);
          }
        }

        if (setsA || setsB) {
          data.homeScore = flipped ? setsB : setsA;
          data.awayScore = flipped ? setsA : setsB;
        }
      }

      await db.match.update({ where: { id: match.id }, data })
        .catch((e) => console.error(`[tennisUpcoming] close-out failed for ${match.competitorA} vs ${match.competitorB}: ${e.message}`));
      finished++;
      continue;
    }

    const extendId = resolved ? resolved.id : null;

    /* The body below reads eventId, matchId and tour off `ev`. When the
       loop was driven by the feed those arrived with the payload; now we
       build the row ourselves, so every field it reads must be supplied
       here or it silently becomes undefined. matchId is unavailable on
       this path — the factor lookups degrade to null ids rather than
       splitting a string that doesn't exist. */
    const ev = {
      id: extendId,
      eventId: extendId,
      matchId: null,
      tour: (match.tourLevel === 0 || match.tourLevel === 1) ? 'atp' : 'atp',
      competitorA: match.competitorA,
      competitorB: match.competitorB,
      league: match.league || null,   // read further down for the log line
    };

    // The feed may list the players the other way round from our row.
    // Prices are per-position, so they have to be swapped with them or the
    // pick gets graded against the opponent's number.
    const flipped = namesLikelyMatch(match.competitorA, ev.competitorB) &&
                    !namesLikelyMatch(match.competitorA, ev.competitorA);

    let oddsA = null, oddsB = null;
    let priceSource = null;
    let bestOdds = null;

    if (hasLiveOdds) {
      // Already stored in OUR orientation by the socket runner, so the
      // pre-match `flipped` correction must not be applied again here.
      oddsA = match.liveOddsA;
      oddsB = match.liveOddsB;
      priceSource = 'live';
    } else if (coreOdds) {
      // Core odds are keyed on OUR competitorA/B ids, so no flip needed.
      oddsA = coreOdds.oddsA;
      oddsB = coreOdds.oddsB;
      priceSource = 'core';
      // Keep the best price across books so line shopping survives the
      // move off The Odds API, which used to populate bestOddsA/B.
      bestOdds = { a: coreOdds.bestOddsA, b: coreOdds.bestOddsB };
    } else if (extendId) {
      const priced = await fetchPreMatchOdds(extendId);
      if (priced) {
        oddsA = flipped ? priced.oddsB : priced.oddsA;
        oddsB = flipped ? priced.oddsA : priced.oddsB;
        priceSource = 'opening';
      }
    }

    /* Still no price anywhere.
     *
     * For an upcoming match that is a real "wait" — the market may open
     * shortly, and a pick made with no price cannot be blended or
     * settled against a line. For a LIVE match there is nothing left to
     * wait for, so we analyse on the score alone rather than leaving the
     * row permanently blank. reassessLiveMatch already handles null odds
     * (its oddsContext branches on it), and the resulting pick is marked
     * so it is never mistaken for a priced one. */
    if (oddsA === null || oddsB === null) {
      if (!isLive || typeof reassessLiveMatch !== 'function') { unpriced++; continue; }

      /* SCORE-ONLY NEEDS AN ACTUAL SCORE.
       *
       * "Analyse on the score alone" assumed a live match has one. A
       * match that has just started is 0-0, so this branch ran with no
       * price AND no score, and the analyst duly returned a pick whose
       * four factors were all Neutral, resting on "a marginal edge based
       * on limited general circuit familiarity" for a W15 player.
       *
       * That is a fabricated pick, not a low-confidence one. Nothing
       * about it is grounded, and it would have been graded and counted
       * in the published win rate like any other. Wait for a real score
       * instead: the next cycle is two minutes away. */
      const sc = String(match.liveScore || match.setScore || '').replace(/[^0-9]/g, '');
      const hasProgress = sc && /[1-9]/.test(sc);
      if (!hasProgress) { unpriced++; continue; }

      priceSource = 'none';
    }

    /* STRUCTURED FACTOR DATA.
     *
     * Five of the twelve factors — H2H, Surface Fit, Venue History,
     * Recent Form, Ranking — carry 55 of the 100 weight points and were
     * previously researched by web search. Search quality varied per
     * match, which made the learned weights measure the research as much
     * as the factor.
     *
     * Passed as `verifiedData`, appended to the prompt. Best-effort: if
     * the provider is down the analysis still runs on search, one notch
     * worse rather than not at all.
     */
    const brief = await buildFactorBrief({
      tour: ev.tour || 'atp',
      nameA: match.competitorA,
      nameB: match.competitorB,
      playerAId: ev.matchId ? String(ev.matchId).split('-')[0] : null,
      playerBId: ev.matchId ? String(ev.matchId).split('-')[1] : null,
      tournamentId: ev.matchId ? String(ev.matchId).split('-')[2] : null,
    }).catch(() => null);

    const verifiedData = renderFactorBrief(brief, { surface: match.surface });

    /* A live match goes to the LIVE analyst, not the pre-match one.
     *
     * These are different prompts. The pre-match analyst reasons about a
     * match that has not started; handing it in-play odds and a flag it
     * does not read would produce a confident pre-match assessment
     * quoting live prices — a wrong pick rather than a missing one.
     * reassessLiveMatch exists precisely for this and takes the score. */
    const label = `${match.competitorA} vs ${match.competitorB} (${ev.league || 'tennis'})${isLive ? ` [live/${priceSource}]` : ''}`;

    const analysis = isLive
      ? await reassessLiveMatch({
          sport: 'tennis',
          competitorA: match.competitorA,
          competitorB: match.competitorB,
          liveScore: match.liveScore || match.setScore || null,
          oddsA,
          oddsB,
          priorAnalysis: null,
        }).catch(() => null)
      : await analyze({
          sport: 'tennis',
          competitorA: match.competitorA,
          competitorB: match.competitorB,
          oddsA,
          oddsB,
          startTime: match.startTime,
          verifiedData,
        }, label);

    if (!analysis) { skipped++; continue; }

    // Same blend the main pipeline applies, so a Challenger pick's
    // confidence means exactly what a main-tour pick's does.
    const selectionIsA = String(analysis.selection).startsWith(match.competitorA);
    const blended = (priceSource !== 'none') && typeof blend === 'function'
      ? blend(analysis.confidence, oddsA, oddsB, selectionIsA)
      : null;

    if (bestOdds && (bestOdds.a !== null || bestOdds.b !== null)) {
      await db.match.update({
        where: { id: match.id },
        data: { bestOddsA: bestOdds.a, bestOddsB: bestOdds.b },
      }).catch(() => {});   // cosmetic — must never block the pick
    }

    /* NO PRICE, NO PICK.
     *
     * The block below intended to record a price-less pick with 'guess'
     * conviction and a null price. But Pick.odds is `Int`, not `Int?`,
     * so that write threw and took the whole tennis-upcoming run down
     * with it — every other match in the cycle went unanalysed too.
     *
     * The schema has the better instinct. A pick with no price cannot be
     * settled against a line, cannot produce CLV, and cannot be acted on
     * by a member: there is nothing to bet. It would still be graded and
     * counted in the published win rate, which is exactly the kind of
     * pick that makes a hit rate look better than the P&L behind it.
     *
     * Skipped and counted instead, so the number shows up in the cycle
     * log rather than vanishing. */
    const pickOdds = (oddsA === null || oddsB === null)
      ? null : (selectionIsA ? oddsA : oddsB);

    if (pickOdds === null) {
      unpriced++;
      console.warn(`[tennisUpcoming] ${match.competitorA} vs ${match.competitorB}: analysed but no price available — not recording a pick.`);
      continue;
    }

    await db.pick.create({
      data: {
        match: { connect: { id: match.id } },
        pickType: 'model',
        market: 'moneyline',
        selection: analysis.selection,
        confidence: blended ? blended.confidence : analysis.confidence,
        rawConfidence: blended ? blended.rawConfidence : analysis.confidence,
        marketProb: blended ? blended.marketProb : null,
        // Score-only picks still carry 'guess' conviction — they have a
        // price but no pre-match read behind them.
        conviction: priceSource === 'none' ? 'guess' : (analysis.conviction || 'guess'),
        odds: pickOdds,
        rationale: analysis.analysis,
        factsUsed: JSON.stringify(analysis.factors || []),
        // Stored so the closing line can be fetched at start time and
        // CLV computed against the price actually taken.
        sourceEventId: ev.eventId,
      },
    });

    analysed++;
    console.log(`[tennisUpcoming] ${match.competitorA} vs ${match.competitorB} (${ev.league}) -> ${analysis.selection} @ ${selectionIsA ? oddsA : oddsB}`);
    } catch (err) {
      failed++;
      console.error(`[tennisUpcoming] ${match.competitorA} vs ${match.competitorB}: ${err.message}`);
    }
  }

  // `failed` is appended only when non-zero: a clean cycle should not
  // carry a permanent "0 failed" that trains the eye to ignore it.
  console.log(`[tennisUpcoming] ${analysed} analysed, ${unpriced} not yet priced, ${skipped} skipped, ${finished} closed as finished, ${tooEarly} too early to price`
    + (failed ? `, ${failed} FAILED` : ''));
  return { analysed, unpriced, skipped, finished, tooEarly };
}

module.exports = { analyzeTennisUpcoming };
