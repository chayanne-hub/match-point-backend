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

const { fetchUpcomingEvents, resolveExtendId, fetchPreMatchOdds } = require('./fetchTennisApi.js');
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
  const WINDOW_MS = Number(process.env.TENNIS_PRICE_WINDOW_MS || 90 * 60 * 1000);
  let tooEarly = 0;

  for (const match of candidates) {
    if (analysed >= limit) break;

    const untilStart = new Date(match.startTime).getTime() - Date.now();
    if (untilStart > WINDOW_MS) { tooEarly++; continue; }

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

    const resolved = await resolveExtendId(match.competitorA, match.competitorB, match.startTime)
      .catch(() => null);
    if (!resolved) { unpriced++; continue; }   // not in extend space at all

    /* Close finished matches instead of retrying them forever.
     *
     * The provider reports status here. A match that has Ended cannot be
     * priced, so without this it came back every cycle, failed to find
     * odds, and inflated "not yet priced" — while staying `scheduled` on
     * the board. This is also the close-out path lower tiers never had:
     * ESPN doesn't carry Challengers, so nothing else can finalise them. */
    if (resolved.status && /ended|finished|retired|walkover/i.test(resolved.status)) {
      await db.match.update({
        where: { id: match.id },
        data: { status: 'final', ...(resolved.score ? { liveSetScore: resolved.score } : {}) },
      }).catch(() => {});
      finished++;
      continue;
    }

    const extendId = resolved.id;

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

    if (hasLiveOdds) {
      // Already stored in OUR orientation by the socket runner, so the
      // pre-match `flipped` correction must not be applied again here.
      oddsA = match.liveOddsA;
      oddsB = match.liveOddsB;
      priceSource = 'live';
    } else {
      const priced = await fetchPreMatchOdds(ev.eventId);
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
          liveScore: match.liveSetScore || match.setScore || null,
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

    await db.pick.create({
      data: {
        match: { connect: { id: match.id } },
        pickType: 'model',
        market: 'moneyline',
        selection: analysis.selection,
        confidence: blended ? blended.confidence : analysis.confidence,
        rawConfidence: blended ? blended.rawConfidence : analysis.confidence,
        marketProb: blended ? blended.marketProb : null,
        /* A score-only pick has no line to blend against or settle
           on. Recording 'guess' conviction and a null price keeps it
           honest: it shows on the board, but nothing downstream can
           mistake it for a pick taken at a real number. */
        conviction: priceSource === 'none' ? 'guess' : (analysis.conviction || 'guess'),
        odds: (oddsA === null || oddsB === null) ? null : (selectionIsA ? oddsA : oddsB),
        rationale: analysis.analysis,
        factsUsed: JSON.stringify(analysis.factors || []),
        // Stored so the closing line can be fetched at start time and
        // CLV computed against the price actually taken.
        sourceEventId: ev.eventId,
      },
    });

    analysed++;
    console.log(`[tennisUpcoming] ${match.competitorA} vs ${match.competitorB} (${ev.league}) -> ${analysis.selection} @ ${selectionIsA ? oddsA : oddsB}`);
  }

  console.log(`[tennisUpcoming] ${analysed} analysed, ${unpriced} not yet priced, ${skipped} skipped, ${finished} closed as finished, ${tooEarly} too early to price`);
  return { analysed, unpriced, skipped, finished, tooEarly };
}

module.exports = { analyzeTennisUpcoming };
