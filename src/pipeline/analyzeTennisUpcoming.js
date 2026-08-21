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
async function analyzeTennisUpcoming({ analyze, blend, limit = 15 } = {}) {
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

  let analysed = 0, skipped = 0, unpriced = 0;

  // Nearest first: a match starting soon is the one worth a price now.
  candidates.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  for (const match of candidates) {
    if (analysed >= limit) break;

    const extendId = await resolveExtendId(match.competitorA, match.competitorB, match.startTime)
      .catch(() => null);
    if (!extendId) { unpriced++; continue; }   // not in extend space = not priced yet

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

    const priced = await fetchPreMatchOdds(ev.eventId);
    if (!priced) { unpriced++; continue; }

    const oddsA = flipped ? priced.oddsB : priced.oddsA;
    const oddsB = flipped ? priced.oddsA : priced.oddsB;

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

    const analysis = await analyze({
      sport: 'tennis',
      competitorA: match.competitorA,
      competitorB: match.competitorB,
      oddsA,
      oddsB,
      startTime: match.startTime,
      verifiedData,
    }, `${match.competitorA} vs ${match.competitorB} (${ev.league || 'tennis'})`);

    if (!analysis) { skipped++; continue; }

    // Same blend the main pipeline applies, so a Challenger pick's
    // confidence means exactly what a main-tour pick's does.
    const selectionIsA = String(analysis.selection).startsWith(match.competitorA);
    const blended = typeof blend === 'function'
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
        conviction: analysis.conviction || 'guess',
        odds: selectionIsA ? oddsA : oddsB,
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

  console.log(`[tennisUpcoming] ${analysed} analysed, ${unpriced} not yet priced, ${skipped} skipped`);
  return { analysed, unpriced, skipped };
}

module.exports = { analyzeTennisUpcoming };
