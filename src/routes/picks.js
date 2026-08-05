const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');

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
  return !!sub && sub.status === 'active';
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
  const { sport } = req.query;
  const { startOfDay, endOfDay } = getTimezoneDayBounds('America/Los_Angeles');

  const where = {
    match: {
      startTime: { gte: startOfDay, lte: endOfDay },
      ...(sport ? { sport: { slug: sport } } : {}),
    },
  };

  const picks = await db.pick.findMany({
    where,
    include: { match: { include: { sport: true } } },
    orderBy: { confidence: 'desc' },
  });

  // Try to resolve the requester, but don't require auth for this endpoint.
  const userId = resolveOptionalUser(req);

  const shaped = await Promise.all(
    picks.map(async (p) => {
      const unlocked = await userHasAccess(userId, p.id);
      return {
        id: p.id,
        sport: p.match.sport.slug,
        league: p.match.league,
        matchup: `${p.match.competitorA} vs ${p.match.competitorB}`,
        startTime: p.match.startTime,
        pickType: p.pickType,
        price: p.price,
        // Redact the actual pick and confidence until purchased/subscribed
        selection: unlocked ? p.selection : null,
        confidence: unlocked ? p.confidence : null,
        rationale: unlocked ? p.rationale : null,
        odds: p.odds,
        unlocked,
      };
    })
  );

  res.json({ picks: shaped });
});

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
    include: { sport: true, picks: { where: { isLive: true } } },
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

  const results = await db.result.findMany({
    where: {
      ...(sport ? { pick: { match: { sport: { slug: sport } } } } : {}),
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
      const pick = m.picks.find((p) => p.pickType === 'model') || m.picks.find((p) => p.pickType === 'winner') || null;
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

// GET /api/picks/:id — full detail, requires purchase or active subscription
router.get('/:id', requireAuth, async (req, res) => {
  const pick = await db.pick.findUnique({
    where: { id: req.params.id },
    include: { match: { include: { sport: true } }, result: true },
  });
  if (!pick) return res.status(404).json({ error: 'Pick not found.' });

  const unlocked = await userHasAccess(req.userId, pick.id);
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
    sport: pick.match.sport.slug,
    league: pick.match.league,
    matchup: `${pick.match.competitorA} vs ${pick.match.competitorB}`,
    startTime: pick.match.startTime,
    surface: pick.match.surface,
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

  const results = await db.result.findMany({
    where: sport
      ? { pick: { match: { sport: { slug: sport } } } }
      : {},
    include: { pick: { include: { match: { include: { sport: true } } } } },
    orderBy: { settledAt: 'desc' },
    take: 100,
  });

  res.json({
    results: results.map((r) => ({
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

module.exports = router;
