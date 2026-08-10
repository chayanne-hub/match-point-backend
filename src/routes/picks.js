const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { fetchEspnNews } = require('../pipeline/fetchEspnNews');
const { getHealthSnapshot } = require('../lib/healthStats');
const { isAdminEmail } = require('./auth');
const { fetchBasketballPlayerProps } = require('../pipeline/fetchPlayerProps');
const { analyzePlayerProps } = require('../pipeline/propsAnalyst');
const { fetchEspnLiveScores, matchEspnEvent } = require('../pipeline/fetchEspn');
const { analyzeStartSit } = require('../pipeline/fantasyAnalyst');
const { triggerManualRun, triggerManualRunTomorrow } = require('../pipeline/cron');

const router = express.Router();

// Computes the UTC instant corresponding to midnight in a given IANA
// timezone, for a given reference date. Used to make "today's picks" roll
// over at midnight Pacific Time rather than server-local time (Railway
// runs in UTC, which would otherwise flip the slate ~4-5pm PT, showing
// tomorrow's matches while it's still evening on the West Coast).
// This correctly handles Daylight Saving Time since the offset is derived
// from the actual date via Intl, not hardcoded.
function getTimezoneDayBounds(timeZone, referenceDate = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(referenceDate).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});

  // What UTC instant would produce this wall-clock time in the target zone.
  const asIfUTC = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  const offsetMs = asIfUTC - referenceDate.getTime();

  // Shift "now" by that offset to get the target zone's current wall-clock
  // date, then find real-UTC midnight for that date by reversing the shift.
  const shifted = new Date(referenceDate.getTime() + offsetMs);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  const startOfDay = new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - offsetMs);
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);

  return { startOfDay, endOfDay };
}

// Whether a user is entitled to see the full detail of a given pick —
// either they bought it individually, or they have an active subscription.
async function userHasAccess(userId, pickId) {
  if (!userId) return false;

  // Admin accounts see everything unlocked — for internal QA/testing the
  // full site without having to actually purchase every pick.
  const user = await db.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
  if (user?.isAdmin) return true;

  const purchased = await db.purchasedPick.findUnique({
    where: { userId_pickId: { userId, pickId } },
  });
  if (purchased) return true;

  const sub = await db.subscription.findUnique({ where: { userId } });
  // Must check expiration explicitly — Coinbase Commerce has no
  // subscription lifecycle events (unlike Stripe's customer.subscription.*
  // webhooks), so nothing ever flips status away from 'active' on its own.
  // Without this check, one payment would grant access forever.
  return !!sub && sub.status === 'active' && sub.currentPeriodEnd > new Date();
}

// Resolves the requester from an optional Authorization header without
// requiring one — used on public endpoints that still want to show unlocked
// detail to logged-in, entitled users.
function resolveOptionalUser(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET || 'dev-secret');
    return payload.userId;
  } catch (_) {
    return null; // invalid/expired token — treat as anonymous
  }
}

// GET /api/picks/today?sport=tennis
// Public: returns picks with confidence/selection redacted unless the
// requester is authenticated and entitled. Attach Authorization header to
// unlock full detail. "Today" rolls over at midnight Pacific Time.
router.get('/today', async (req, res) => {
  const { sport, markets } = req.query;
  const { startOfDay, endOfDay } = getTimezoneDayBounds('America/Los_Angeles');

  // Try to resolve the requester, but don't require auth for this endpoint.
  const userId = resolveOptionalUser(req);

  // ?markets=all (Parlay Builder) doesn't need the Upcoming Matches
  // feature at all — keeps its original simple pick-only query,
  // unchanged, no extra load added there.
  if (markets === 'all') {
    const picks = await db.pick.findMany({
      where: {
        pickType: { in: ['model', 'winner'] },
        match: {
          startTime: { gte: startOfDay, lte: endOfDay },
          ...(sport ? { sport: { slug: sport } } : {}),
        },
      },
      include: { match: { include: { sport: true } } },
      orderBy: { confidence: 'desc' },
    });
    const shaped = await Promise.all(picks.map((p) => shapePick(p, userId)));
    return res.json({ picks: shaped });
  }

  // Default moneyline mode: ONE query on Match (with its picks included),
  // not two separate queries against Pick and Match — this endpoint
  // already polls every 20 seconds from the frontend, so doubling its
  // query count (as an earlier version of this endpoint briefly did) is
  // real, meaningful added database load, not a rounding error. Splitting
  // the single result set into "has a real pick" vs "doesn't yet" happens
  // in JS below instead of via a second round-trip to the database.
  const matches = await db.match.findMany({
    where: {
      startTime: { gte: startOfDay, lte: endOfDay },
      status: { in: ['scheduled', 'live'] },
      skipAnalysis: false,
      ...(sport ? { sport: { slug: sport } } : {}),
    },
    include: {
      sport: true,
      picks: { where: { pickType: { in: ['model', 'winner', 'live'] }, market: { in: ['moneyline'] } } },
    },
  });

  const shaped = [];
  for (const m of matches) {
    const pregamePicks = m.picks.filter((pk) => pk.pickType !== 'live');
    if (pregamePicks.length > 0) {
      // One representative pick per match, not every tier — 'winner' and
      // 'model' are two deliberate product tiers on the SAME underlying
      // analysis (every match gets a 'winner' pick; confident ones also
      // get a 'model' pick), not duplicates. Showing both here would
      // display every analyzed match twice. Prefer 'model' when it
      // exists (the more complete product), same fallback pattern
      // already used elsewhere in this file.
      const p = pregamePicks.find((pk) => pk.pickType === 'model') || pregamePicks[0];
      // Real fix: live reassessment (cron.js, updateLivePicksForSport)
      // has been computing an updated selection/confidence/rationale
      // every 15 minutes this whole time, writing it to a SEPARATE
      // pickType:'live' record — deliberately kept apart from the
      // frozen pregame pick so stats/grading never touch it. But
      // nothing ever displayed that live record; the frontend showed
      // the frozen pregame value even while a match was live, making
      // confidence look permanently static. When a match is actually
      // live and a live-reassessed record exists, use ITS
      // selection/confidence/rationale for display — analyzedAt still
      // reflects the ORIGINAL pregame analysis time (that's real
      // information, not something to overwrite), only the live
      // judgment itself is swapped in.
      const liveOverride = m.status === 'live' ? m.picks.find((pk) => pk.pickType === 'live') : null;
      const displayPick = liveOverride ? { ...p, selection: liveOverride.selection, confidence: liveOverride.confidence, rationale: liveOverride.rationale, odds: liveOverride.odds } : p;
      shaped.push(await shapePick({ ...displayPick, match: m }, userId));
    } else {
      shaped.push(shapeUnanalyzedMatch(m));
    }
  }

  // EXPERIMENTAL — real test, not a permanent architecture change yet.
  // Pulls ESPN's own schedule directly and surfaces any event that has
  // NO corresponding Match row at all (not even an unanalyzed one) —
  // this catches real gaps in the odds provider's coverage, like tennis
  // doubles (which that provider doesn't seem to carry at all) or a
  // specific singles match that provider simply never returned despite
  // being real and priced on a real sportsbook (confirmed happening for
  // at least one real match today). These entries have no odds and
  // never will via the normal pipeline — reusing matchEspnEvent() here
  // for the INVERSE of its normal purpose: finding ESPN events that
  // DON'T match anything we already have, not events that do.
  if (sport && !markets) {
    try {
      const espnEvents = await fetchEspnLiveScores(sport);
      const alreadyKnown = matches; // same list already fetched above — both picked and unanalyzed matches
      const espnOnlyRaw = espnEvents.filter((ev) =>
        !matchEspnEvent(ev, alreadyKnown) &&
        !ev.completed &&
        // Future-round bracket slots ESPN lists before the actual
        // players are determined — not a real, bettable matchup yet.
        // Confirmed happening in production (15+ of these in one
        // response) rather than a hypothetical edge case.
        ev.competitorAName !== 'TBD' && ev.competitorBName !== 'TBD'
      );
      // De-dupe by matchup+time — confirmed happening in production
      // (several real matches, like Naomi Osaka vs Elena Rybakina,
      // appearing twice) — likely ESPN listing the same event under more
      // than one grouping/league query.
      const seenEspnKeys = new Set();
      const espnOnly = espnOnlyRaw.filter((ev) => {
        const key = `${ev.competitorAName}|${ev.competitorBName}|${ev.eventDate}`;
        if (seenEspnKeys.has(key)) return false;
        seenEspnKeys.add(key);
        return true;
      });
      espnOnly.forEach((ev, i) => {
        shaped.push({
          id: `espn-only-${sport}-${i}-${new Date(ev.eventDate).getTime()}`,
          sport,
          league: 'ESPN Schedule', // real tournament/league name isn't available from this parsing path
          matchup: `${ev.competitorAName} vs ${ev.competitorBName}`,
          startTime: ev.eventDate,
          pickType: 'pending',
          market: 'moneyline',
          line: null, price: null, selection: null, confidence: null, rationale: null, odds: null,
          spread: null, spreadOddsA: null, spreadOddsB: null, total: null, overOdds: null, underOdds: null,
          matchStatus: ev.inProgress ? 'live' : 'scheduled',
          analyzedAt: null,
          liveScore: null, setScore: ev.setScore || null, periodScores: null, period: null, clockSeconds: null, liveClock: null,
          unlocked: false,
          hasPick: false,
          espnOnly: true, // real flag — no odds provider will ever price this via the normal pipeline; distinct from a normal "waiting on analysis" entry
        });
      });
    } catch (err) {
      console.error(`[today] ESPN supplemental fetch failed for ${sport}:`, err.message);
      // Fails silently into just not adding supplemental entries — the
      // normal picks/unanalyzed matches above are unaffected either way.
    }
  }

  shaped.sort((a, b) => (b.confidence || -1) - (a.confidence || -1));

  res.json({ picks: shaped });
});

// Shapes one real Pick row (with its match already attached) into the
// public-facing shape /today returns. Pulled out of the route handler so
// both the markets=all path and the default path can share it.
async function shapePick(p, userId) {
  const unlocked = await userHasAccess(userId, p.id);
  return {
    id: p.id,
    sport: p.match.sport.slug,
    league: p.match.league,
    matchup: `${p.match.competitorA} vs ${p.match.competitorB}`,
    startTime: p.match.startTime,
    pickType: p.pickType,
    market: p.market, // 'moneyline' | 'spread' | 'total' — callers that opted into ?markets=all need this to tell picks apart
    line: p.line, // the spread/total number this specific pick was made against, null for moneyline
    price: p.price,
    // Redact the actual pick and confidence until purchased/subscribed
    selection: unlocked ? p.selection : null,
    confidence: unlocked ? p.confidence : null,
    rationale: unlocked ? p.rationale : null,
    odds: p.odds,
    // Raw market lines, not model analysis — shown to everyone, same
    // as odds above. Null whenever a book hasn't posted that market
    // yet, never a fabricated number.
    spread: p.match.spread,
    spreadOddsA: p.match.spreadOddsA,
    spreadOddsB: p.match.spreadOddsB,
    total: p.match.total,
    overOdds: p.match.overOdds,
    underOdds: p.match.underOdds,
    // Real live status, sourced from the free ESPN score poller — not
    // the (now-removed) paid live-reassessment loop. matchStatus is
    // 'scheduled' | 'live' | 'final'; the rest are only meaningful
    // once live, and null otherwise.
    matchStatus: p.match.status,
    analyzedAt: p.createdAt, // when the model actually ran on this match — confidence is frozen from this moment on
    liveScore: p.match.liveScore,
    setScore: p.match.setScore, // tennis only — "6-4, 3-6, 2-1" style, for the real set-by-set display
    periodScores: p.match.periodScores, // basketball/football — "25-28, 20-21, 20-24, 22-25" style
    period: p.match.period,
    clockSeconds: p.match.clockSeconds,
    liveClock: p.match.liveClock,
    unlocked,
    hasPick: true,
  };
}

// Shapes a real match that doesn't have a pick yet — genuinely free
// schedule data, no pick-specific fields fabricated.
function shapeUnanalyzedMatch(m) {
  return {
    id: m.id,
    sport: m.sport.slug,
    league: m.league,
    matchup: `${m.competitorA} vs ${m.competitorB}`,
    startTime: m.startTime,
    pickType: 'pending',
    market: 'moneyline',
    line: null,
    price: null,
    selection: null,
    confidence: null,
    rationale: null,
    odds: null,
    spread: m.spread,
    spreadOddsA: m.spreadOddsA,
    spreadOddsB: m.spreadOddsB,
    total: m.total,
    overOdds: m.overOdds,
    underOdds: m.underOdds,
    matchStatus: m.status,
    analyzedAt: null,
    liveScore: m.liveScore,
    setScore: m.setScore,
    periodScores: m.periodScores,
    period: m.period,
    clockSeconds: m.clockSeconds,
    liveClock: m.liveClock,
    unlocked: false,
    hasPick: false,
  };
}

// GET /api/picks/live?sport=all
// Selection is locked until purchased/subscribed. Confidence is shown to
// everyone as a teaser — it's the hook that gets people to buy — so it is
// NOT redacted here, unlike /today.
router.get('/live', async (req, res) => {
  const { sport } = req.query;
  const where = {
    status: 'live',
    ...(sport && sport !== 'all' ? { sport: { slug: sport } } : {}),
  };

  const matches = await db.match.findMany({
    where,
    include: { sport: true, picks: { where: { pickType: 'live' } } },
  });

  const userId = resolveOptionalUser(req);

  const shaped = await Promise.all(
    matches.map(async (m) => ({
      id: m.id,
      sport: m.sport.slug,
      league: m.league,
      matchup: `${m.competitorA} vs ${m.competitorB}`,
      liveScore: m.liveScore,
      liveClock: m.liveClock,
      picks: await Promise.all(
        m.picks.map(async (p) => {
          const unlocked = await userHasAccess(userId, p.id);
          return {
            id: p.id,
            selection: unlocked ? p.selection : null,
            confidence: p.confidence,
            odds: p.odds,
            price: p.price,
            unlocked,
          };
        })
      ),
    }))
  );

  res.json({ matches: shaped });
});

// GET /api/picks/stats?sport=tennis — Track Record numbers: win rate, ROI,
// ROI vs. BetMGM's closing line, and matches analyzed/day, ALL-TIME. Public
// — this is marketing-facing proof, not account data.
//
// All-time rather than a rolling window on purpose: with a young, growing
// sample, a 30-day window actually SHRINKS your effective sample as picks
// age out of it, which is backwards — bigger sample size should only make
// the number more trustworthy over time, not less. Pick-selling services
// that publish a real track record report it since inception for the same
// reason.
//
// NOTE ON EMPTY RESULTS: until matches actually finish and get graded (see
// gradeFinishedMatches() in cron.js), this will legitimately return nulls —
// that's not a bug, it's just no settled history existing yet.
router.get('/stats', async (req, res) => {
  const { sport } = req.query;

  // Excludes picks whose recorded odds fall outside a plausible range —
  // these are corrupted rows from before the suspended-market-placeholder
  // fix in fetchMatches.js (e.g. -10000 odds captured during a book's
  // brief in-play market suspension, not a real price). The pick and its
  // result stay in the database untouched; they're just excluded from
  // these public-facing win-rate/ROI calculations so one bad price snapshot
  // doesn't distort the whole track record.
  //
  // Also restricted to pickType: 'model' — every match that clears the
  // confidence threshold gets BOTH a "model" and a "winner" pick (same
  // selection/confidence/outcome, two separate sellable products). Counting
  // both here would double-count every one of those matches. "Model" is
  // the genuine high-conviction product; "winner" exists for every match
  // regardless of edge, so including it would pad the sample with picks
  // that were never claimed to have real value.
  const results = await db.result.findMany({
    where: {
      pick: {
        pickType: 'model',
        market: 'moneyline', // spread/total picks are also pickType:'model' now —
                              // excluded here so they don't get mixed into the
                              // published moneyline track record. Worth its own
                              // stats endpoint later if spread/total picks need
                              // their own published win rate.
        odds: { gte: -2000, lte: 2000 },
        ...(sport ? { match: { sport: { slug: sport } } } : {}),
      },
    },
    include: { pick: { include: { match: true } } },
  });

  const decided = results.filter((r) => r.outcome !== 'push');
  const wins = decided.filter((r) => r.outcome === 'win').length;
  const losses = decided.filter((r) => r.outcome === 'loss').length;
  const winRate = decided.length > 0 ? Math.round((wins / decided.length) * 1000) / 10 : null;

  // Flat $100-stake profit for one American-odds outcome.
  function profitFor(americanOdds, won) {
    if (!won) return -100;
    return americanOdds > 0 ? americanOdds : (10000 / Math.abs(americanOdds));
  }

  let roi = null;
  if (decided.length > 0) {
    const totalProfit = decided.reduce(
      (sum, r) => sum + profitFor(r.pick.odds, r.outcome === 'win'),
      0
    );
    roi = Math.round((totalProfit / (decided.length * 100)) * 1000) / 10;
  }

  // ROI vs. close: for picks where we captured a closing line, compare
  // actual ROI (at the odds when the pick was made) against what ROI
  // would have been at the closing line instead. Positive means the
  // pick's early number beat where the market ended up — the standard
  // "beating the closing line" edge metric.
  const withClosing = decided.filter((r) => {
    const m = r.pick.match;
    return m.closingOddsA !== null && m.closingOddsB !== null;
  });

  let roiVsClose = null;
  if (withClosing.length > 0) {
    let entryTotal = 0;
    let closeTotal = 0;
    for (const r of withClosing) {
      const m = r.pick.match;
      const won = r.outcome === 'win';
      entryTotal += profitFor(r.pick.odds, won);

      const pickedName = r.pick.selection.replace(/\s*ML$/, '').trim();
      const closingOdds = pickedName === m.competitorA ? m.closingOddsA : m.closingOddsB;
      closeTotal += profitFor(closingOdds, won);
    }
    const entryRoi = entryTotal / (withClosing.length * 100);
    const closeRoi = closeTotal / (withClosing.length * 100);
    roiVsClose = Math.round((entryRoi - closeRoi) * 1000) / 10;
  }

  // matches/day: distinct matches with a pick, averaged over the time
  // since the FIRST pick was created — a genuine all-time daily pace,
  // not diluted by a fixed window.
  const allPicks = await db.pick.findMany({
    where: sport ? { match: { sport: { slug: sport } } } : {},
    distinct: ['matchId'],
    select: { matchId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  let matchesPerDay = null;
  if (allPicks.length > 0) {
    const earliestCreatedAt = allPicks[0].createdAt;
    const daysElapsed = Math.max(1, Math.ceil((Date.now() - earliestCreatedAt.getTime()) / (24 * 60 * 60 * 1000)));
    matchesPerDay = Math.round(allPicks.length / daysElapsed);
  }

  const winRows = decided.filter((r) => r.outcome === 'win');
  const avgConfidenceWins = winRows.length > 0
    ? Math.round(winRows.reduce((sum, r) => sum + r.pick.confidence, 0) / winRows.length)
    : null;

  res.json({
    winRate,
    roi,
    roiVsClose,
    matchesPerDay,
    sampleSize: decided.length,
    picksLogged: decided.length,
    avgConfidenceWins,
  });
});

// GET /api/picks/matches-today?sport=tennis — full slate with both sides'
// odds, for the "All Matches" board. Uses closingOddsA/closingOddsB as the
// "current" odds for each side — that field is continuously updated by the
// live-picks loop for every scheduled match (see cron.js), so it's the
// closest thing we have to a live both-sides odds snapshot pre-kickoff.
// The picked side is only ever revealed when the pick is actually unlocked
// — showing which side the model picked for free (even via a highlight
// box with no text) would leak the selection the paywall exists to gate.
router.get('/matches-today', async (req, res) => {
  const { sport } = req.query;
  const { startOfDay, endOfDay } = getTimezoneDayBounds('America/Los_Angeles');

  const matches = await db.match.findMany({
    where: {
      startTime: { gte: startOfDay, lte: endOfDay },
      ...(sport ? { sport: { slug: sport } } : {}),
    },
    include: { sport: true, picks: true },
    orderBy: { startTime: 'asc' },
  });

  const userId = resolveOptionalUser(req);

  const shaped = await Promise.all(
    matches.map(async (m) => {
      const pick = m.picks.find((p) => p.pickType === 'model' && p.market === 'moneyline') || m.picks.find((p) => p.pickType === 'winner' && p.market === 'moneyline') || null;
      const unlocked = pick ? await userHasAccess(userId, pick.id) : false;

      let pickedSide = null;
      if (pick && unlocked) {
        const pickedName = pick.selection.replace(/\s*ML$/, '').trim();
        if (pickedName === m.competitorA) pickedSide = 'A';
        else if (pickedName === m.competitorB) pickedSide = 'B';
      }

      return {
        id: m.id,
        sport: m.sport.slug,
        league: m.league,
        competitorA: m.competitorA,
        competitorB: m.competitorB,
        startTime: m.startTime,
        surface: m.surface,
        oddsA: m.closingOddsA,
        oddsB: m.closingOddsB,
        spread: m.spread,
        spreadOddsA: m.spreadOddsA,
        spreadOddsB: m.spreadOddsB,
        total: m.total,
        overOdds: m.overOdds,
        underOdds: m.underOdds,
        pick: pick
          ? {
              id: pick.id,
              pickType: pick.pickType,
              price: pick.price,
              unlocked,
              pickedSide, // 'A' | 'B' | null — null whenever locked or no pick exists
            }
          : null,
      };
    })
  );

  res.json({ matches: shaped });
});

// GET /api/picks/news?sport=tennis — real ESPN headlines, public (not
// proprietary model output, no reason to gate it). Fetched live on each
// request rather than cached/persisted — news doesn't need model analysis
// or a pipeline schedule, just a pass-through to a real source.
//
// IMPORTANT: this must be registered before GET /:id below — Express
// matches routes in registration order, and /news is a single path
// segment just like :id, so whichever is registered first wins the
// match. Registering it after /:id (a real bug this once had) meant
// every request here got swallowed by the pick-lookup route instead,
// returning "Pick not found" for a lookup on a pick literally named
// "news" — a confusing error with nothing to do with the real cause.
router.get('/news', async (req, res) => {
  const { sport } = req.query;
  if (!sport) {
    return res.status(400).json({ error: 'sport query param is required.' });
  }
  try {
    const articles = await fetchEspnNews(sport);
    res.json({ articles });
  } catch (err) {
    console.error('[picks] /news failed:', err.message);
    res.status(502).json({ error: 'Could not fetch news right now.' });
  }
});

// GET /api/picks/:id — full detail, requires purchase or active subscription
router.get('/:id', async (req, res) => {
  const pick = await db.pick.findUnique({
    where: { id: req.params.id },
    include: { match: { include: { sport: true } }, result: true },
  });
  if (!pick) return res.status(404).json({ error: 'Pick not found.' });

  // Once a pick is settled (the match is over and it's been graded),
  // there's no competitive value left to protect by hiding it — the
  // whole point of a public results archive is to prove the track record,
  // which doesn't work if clicking into a past result just hits a
  // paywall. Only still-upcoming picks require a purchase/subscription.
  const isSettled = pick.result !== null;
  const userId = resolveOptionalUser(req);
  const unlocked = isSettled || (await userHasAccess(userId, pick.id));

  if (!unlocked) {
    return res.status(402).json({ error: 'This pick has not been purchased or unlocked by a subscription.' });
  }

  let factsUsed = [];
  try {
    factsUsed = pick.factsUsed ? JSON.parse(pick.factsUsed) : [];
  } catch (e) {
    factsUsed = []; // malformed/legacy row — degrade gracefully rather than error the whole request
  }

  res.json({
    id: pick.id,
    matchId: pick.matchId,
    sport: pick.match.sport.slug,
    league: pick.match.league,
    matchup: `${pick.match.competitorA} vs ${pick.match.competitorB}`,
    competitorA: pick.match.competitorA,
    competitorB: pick.match.competitorB,
    startTime: pick.match.startTime,
    surface: pick.match.surface,
    matchStatus: pick.match.status,
    analyzedAt: pick.createdAt,
    homeScore: pick.match.homeScore,
    awayScore: pick.match.awayScore,
    setScore: pick.match.setScore, // tennis only
    spread: pick.match.spread,
    spreadOddsA: pick.match.spreadOddsA,
    spreadOddsB: pick.match.spreadOddsB,
    total: pick.match.total,
    overOdds: pick.match.overOdds,
    underOdds: pick.match.underOdds,
    selection: pick.selection,
    confidence: pick.confidence,
    odds: pick.odds,
    rationale: pick.rationale,
    factsUsed,
    result: pick.result ? pick.result.outcome : null,
  });
});

// GET /api/results?sport=tennis — settled picks archive (public)
router.get('/archive/results', async (req, res) => {
  const { sport } = req.query;

  // Same exclusions as /stats — see the comment there. Keeps corrupted
  // -10000-style placeholder-odds rows out of the public archive without
  // deleting the underlying data, and restricts to pickType: 'model' so
  // matches that clear the confidence threshold (and therefore get both a
  // "model" and a "winner" pick) don't show up twice in the archive.
  const results = await db.result.findMany({
    where: {
      pick: {
        pickType: 'model',
        market: 'moneyline', // keep spread/total picks out of the moneyline archive — same reasoning as /stats
        odds: { gte: -2000, lte: 2000 },
        ...(sport ? { match: { sport: { slug: sport } } } : {}),
      },
    },
    include: { pick: { include: { match: { include: { sport: true } } } } },
    orderBy: { settledAt: 'desc' },
    take: 100,
  });

  res.json({
    results: results.map((r) => ({
      id: r.pick.id,
      date: r.settledAt,
      matchup: `${r.pick.match.competitorA} vs ${r.pick.match.competitorB}`,
      sport: r.pick.match.sport.slug,
      league: r.pick.match.league,
      pickType: r.pick.pickType,
      selection: r.pick.selection,
      confidence: r.pick.confidence,
      odds: r.pick.odds,
      outcome: r.outcome,
    })),
  });
});

// GET /api/picks/admin/health — pipeline status at a glance: last
// successful run per sport, ESPN poll error counts, analysis retry/
// failure counts, recent errors. Gated behind requireAuth AND the same
// admin email check the /auth/me bypass uses — this reveals internal
// operational detail (error messages, run timing) that shouldn't be
// public, even to a paying non-admin subscriber.
router.get('/admin/health', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  res.json(getHealthSnapshot());
});

// GET /api/picks/admin/pending — real matches that exist (already
// fetched/upserted by the pipeline) but don't have a real pick yet.
// Deliberately NOT a fake "pending" Pick row — that would risk leaking
// into stats/grading logic if a filter was ever missed somewhere. This
// is a genuinely separate, read-only view straight off Match, showing
// exactly what's waiting or stuck (including the real cross-cycle
// failure count) without touching the pick system at all.
router.get('/admin/pending', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { startOfDay, endOfDay } = getTimezoneDayBounds('America/Los_Angeles');
  const matches = await db.match.findMany({
    where: {
      startTime: { gte: startOfDay, lt: endOfDay },
      status: { in: ['scheduled', 'live'] },
      skipAnalysis: false,
    },
    include: {
      sport: true,
      picks: { where: { pickType: { in: ['model', 'winner'] } }, take: 1 },
    },
    orderBy: { startTime: 'asc' },
  });

  const pending = matches
    .filter((m) => m.picks.length === 0)
    .map((m) => ({
      id: m.id,
      sport: m.sport.slug,
      matchup: `${m.competitorA} vs ${m.competitorB}`,
      league: m.league,
      startTime: m.startTime,
      status: m.status,
      hasOdds: m.oddsA !== null && m.oddsB !== null,
      analysisFailCycles: m.analysisFailCycles,
    }));

  res.json({ pending });
});

// GET /api/picks/admin/player-props?matchId=X — real raw prop lines for
// one basketball match, fetched on-demand (not automatically, not for
// every match) given the per-event API cost. Admin-only, same reasoning
// as /admin/health: this is a "coming soon" feature under real
// construction, not something to expose to paying subscribers yet —
// especially since there's no analysis or grading behind it at all,
// just raw lines.
router.get('/admin/player-props', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { matchId } = req.query;
  if (!matchId) {
    return res.status(400).json({ error: 'matchId query param is required.' });
  }

  const match = await db.match.findUnique({ where: { id: matchId } });
  if (!match) {
    return res.status(404).json({ error: 'Match not found.' });
  }

  const props = await fetchBasketballPlayerProps(match);
  res.json({
    matchup: `${match.competitorA} vs ${match.competitorB}`,
    league: match.league,
    props,
  });
});

// Real concurrency cap for props analysis — this runs automatically for
// every player the moment the Props & Fantasy tab opens (per explicit
// product decision), which means a match with several players showing
// props could otherwise fire many simultaneous Claude calls at once.
// Same defensive pattern as the pregame pipeline's MAX_CONCURRENT_ANALYSIS
// in cron.js, scoped separately here since this is a distinct, on-demand
// feature rather than the scheduled pipeline.
const MAX_CONCURRENT_PROPS_ANALYSIS = 3;
let activePropsAnalysisCount = 0;
const propsAnalysisQueue = [];

function acquirePropsAnalysisSlot() {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (activePropsAnalysisCount < MAX_CONCURRENT_PROPS_ANALYSIS) {
        activePropsAnalysisCount++;
        resolve();
      } else {
        propsAnalysisQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

function releasePropsAnalysisSlot() {
  activePropsAnalysisCount--;
  const next = propsAnalysisQueue.shift();
  if (next) next();
}

// POST /api/picks/admin/analyze-props — real confidence-scored verdicts
// for one player's full set of prop lines, in a single call. Body:
// { playerName, team, opponent, sport, propLines: [...] } — propLines
// comes straight from the raw /admin/player-props response, grouped by
// player on the frontend. Admin-only, real cost per call (one Claude
// request covering all of this player's markets at once — see
// propsAnalyst.js for why it's structured this way).
router.post('/admin/analyze-props', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { playerName, team, opponent, sport, propLines, matchId } = req.body || {};
  if (!playerName || !team || !opponent || !matchId || !Array.isArray(propLines) || propLines.length === 0) {
    return res.status(400).json({ error: 'playerName, team, opponent, matchId, and a non-empty propLines array are required.' });
  }

  await acquirePropsAnalysisSlot();
  try {
    const results = await analyzePlayerProps({ playerName, team, opponent, sport: sport || 'basketball', propLines });
    if (!results) {
      return res.status(502).json({ error: 'Analysis failed — check server logs for the specific cause.' });
    }

    // Persisted BEFORE attempting to respond — real fix for results
    // getting lost when Railway's proxy kills the connection on a
    // longer call. Even if res.json() below never reaches the browser,
    // this data is already safely saved and fetchable via
    // /admin/player-prop-analyses.
    await db.playerPropAnalysis.createMany({
      data: results.map((r) => ({
        matchId,
        playerName,
        market: r.market,
        line: (propLines.find((p) => p.market === r.market) || {}).line ?? null,
        verdict: r.verdict,
        confidence: r.confidence,
        reasoning: r.reasoning,
      })),
    });

    res.json({ playerName, props: results });
  } finally {
    releasePropsAnalysisSlot();
  }
});

// GET /api/picks/admin/player-prop-analyses?matchId=X — real fallback
// for the case above: if the triggering POST's connection died before
// the response arrived, the analysis still completed and was saved.
// The frontend polls this after a failed/timed-out request to check
// whether the work actually succeeded server-side before giving up.
router.get('/admin/player-prop-analyses', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { matchId } = req.query;
  if (!matchId) {
    return res.status(400).json({ error: 'matchId query param is required.' });
  }

  const rows = await db.playerPropAnalysis.findMany({
    where: { matchId },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    analyses: rows.map((r) => ({
      playerName: r.playerName,
      market: r.market,
      line: r.line,
      verdict: r.verdict,
      confidence: r.confidence,
      reasoning: r.reasoning,
      createdAt: r.createdAt,
    })),
  });
});

// POST /api/picks/admin/start-sit — real fantasy start/sit analysis,
// admin-only, on-demand (this is a real Claude research call, same cost
// shape as match analysis — not something to trigger automatically for
// every player in a league). Body: { playerName, team, opponent, sport,
// spread?, total?, injuryStatus? }. spread/total/injuryStatus are
// optional real context — pass them when known, omit when not; the
// analysis is honest about working with less context either way.
router.post('/admin/start-sit', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { playerName, team, opponent, sport, spread, total, injuryStatus } = req.body || {};
  if (!playerName || !team || !opponent || !sport) {
    return res.status(400).json({ error: 'playerName, team, opponent, and sport are required.' });
  }

  const result = await analyzeStartSit({ playerName, team, opponent, sport, spread, total, injuryStatus });
  if (!result) {
    return res.status(502).json({ error: 'Analysis failed — check server logs for the specific cause.' });
  }

  const saved = await db.startSitAdvice.create({
    data: {
      playerName,
      team,
      opponent,
      sport,
      verdict: result.verdict,
      confidence: result.confidence,
      rationale: result.analysis,
      factsUsed: JSON.stringify(result.factors),
    },
  });

  res.json({
    id: saved.id,
    playerName,
    team,
    opponent,
    sport,
    verdict: result.verdict,
    confidence: result.confidence,
    analysis: result.analysis,
    factors: result.factors,
  });
});

// GET /api/picks/admin/start-sit/recent — the last 20 saved start/sit
// analyses, so the admin doesn't have to re-run one to see it again.
router.get('/admin/start-sit/recent', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const recent = await db.startSitAdvice.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  res.json({
    advice: recent.map((a) => ({
      id: a.id,
      playerName: a.playerName,
      team: a.team,
      opponent: a.opponent,
      sport: a.sport,
      verdict: a.verdict,
      confidence: a.confidence,
      analysis: a.rationale,
      factors: JSON.parse(a.factsUsed || '[]'),
      createdAt: a.createdAt,
    })),
  });
});

// POST /api/picks/admin/run-pipeline — manually trigger the pregame
// pipeline right now instead of waiting up to 15 minutes for the next
// scheduled cycle. Real use case: recovering after a period where
// Anthropic balance hit zero and matches got silently skipped. Fires
// the run and returns immediately (a full 5-sport cycle with real
// analysis calls can take several minutes) rather than holding the
// request open — check the Health tab a bit after to see whether
// matches actually got processed.
router.post('/admin/run-pipeline', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const result = await triggerManualRun();
  res.json(result);
});

// POST /api/picks/admin/run-pipeline-tomorrow — same as above, but
// filtered to tomorrow's matches only. Real use case: right after
// "Skip Today's Backlog," kick off tomorrow's slate immediately rather
// than waiting for the scheduled cycle to naturally reach it.
router.post('/admin/run-pipeline-tomorrow', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const result = await triggerManualRunTomorrow();
  res.json(result);
});

// POST /api/picks/admin/skip-today-backlog — bulk-marks every one of
// today's matches that doesn't yet have a real pick as skipAnalysis,
// so the pipeline stops re-attempting them and moves straight to
// tomorrow's matches. Real use case: after a balance-outage window left
// a pile of today's matches un-analyzed — letting the pipeline "catch
// up" on all of them risks the exact overload (many concurrent long
// calls, real spend, zero picks) that caused the problem in the first
// place. This just draws a line under today and starts clean.
router.post('/admin/skip-today-backlog', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { startOfDay, endOfDay } = getTimezoneDayBounds('America/Los_Angeles');

  const todaysMatches = await db.match.findMany({
    where: { startTime: { gte: startOfDay, lt: endOfDay }, skipAnalysis: false },
    include: { picks: { where: { pickType: { in: ['model', 'winner'] } } } },
  });

  const toSkip = todaysMatches.filter((m) => m.picks.length === 0);

  await db.match.updateMany({
    where: { id: { in: toSkip.map((m) => m.id) } },
    data: { skipAnalysis: true },
  });

  res.json({ skipped: toSkip.length, totalToday: todaysMatches.length });
});

// ---------------------------------------------------------------------------
// Insiders — curated X/Twitter accounts for the frontend's left-side
// Insiders sidebar. This does NOT call the X API — the account list is
// just stored here; the actual tweets are rendered client-side via X's
// free embed widget (platform.twitter.com/widgets.js). So this has zero
// ongoing API cost, same as everything else the sidebar does.
// ---------------------------------------------------------------------------

const INSIDER_SPORTS = ['tennis', 'basketball', 'soccer', 'baseball', 'football'];

// GET /api/picks/insiders — public. Grouped by sport, ordered. This is
// what the sidebar itself fetches on page load.
router.get('/insiders', async (req, res) => {
  try {
    const rows = await db.insiderAccount.findMany({
      orderBy: [{ sport: 'asc' }, { order: 'asc' }],
    });
    const grouped = {};
    INSIDER_SPORTS.forEach((s) => { grouped[s] = []; });
    rows.forEach((r) => {
      if (!grouped[r.sport]) grouped[r.sport] = [];
      grouped[r.sport].push(r.handle);
    });
    res.json(grouped);
  } catch (err) {
    console.error('[insiders] GET /insiders failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/picks/admin/insiders — admin-only, full rows (with IDs) for
// the management UI in the Health tab.
router.get('/admin/insiders', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const accounts = await db.insiderAccount.findMany({
    orderBy: [{ sport: 'asc' }, { order: 'asc' }],
  });
  res.json({ accounts });
});

// POST /api/picks/admin/insiders  { handle, sport } — admin-only.
router.post('/admin/insiders', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { handle, sport } = req.body || {};
  if (!handle || !sport) {
    return res.status(400).json({ error: 'handle and sport are required.' });
  }
  if (!INSIDER_SPORTS.includes(sport)) {
    return res.status(400).json({ error: `Unknown sport: ${sport}` });
  }

  const cleanHandle = handle.trim().replace(/^@/, '');
  if (!cleanHandle) {
    return res.status(400).json({ error: 'handle cannot be empty.' });
  }

  try {
    const existingCount = await db.insiderAccount.count({ where: { sport } });
    const account = await db.insiderAccount.create({
      data: { sport, handle: cleanHandle, order: existingCount },
    });
    res.json({ account });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'That handle is already tracked for this sport.' });
    }
    console.error('[insiders] POST /admin/insiders failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/picks/admin/insiders/:id — admin-only.
router.delete('/admin/insiders/:id', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  try {
    await db.insiderAccount.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (err) {
    console.error('[insiders] DELETE /admin/insiders failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
