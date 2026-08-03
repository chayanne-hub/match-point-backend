const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

// Whether a user is entitled to see the full detail of a given pick —
// either they bought it individually, or they have an active subscription.
async function userHasAccess(userId, pickId) {
  if (!userId) return false;

  const purchased = await db.purchasedPick.findUnique({
    where: { userId_pickId: { userId, pickId } },
  });
  if (purchased) return true;

  const sub = await db.subscription.findUnique({ where: { userId } });
  return !!sub && sub.status === 'active';
}

// GET /api/picks/today?sport=tennis
// Public: returns picks with confidence/selection redacted unless the
// requester is authenticated and entitled. Attach Authorization header to
// unlock full detail.
router.get('/today', async (req, res) => {
  const { sport } = req.query;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

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
  let userId = null;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try {
      const { requireAuth: _ } = require('../lib/auth'); // eslint-disable-line
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET || 'dev-secret');
      userId = payload.userId;
    } catch (_) {
      // invalid/missing token — treat as anonymous
    }
  }

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

  res.json({
    matches: matches.map((m) => ({
      id: m.id,
      sport: m.sport.slug,
      league: m.league,
      matchup: `${m.competitorA} vs ${m.competitorB}`,
      liveScore: m.liveScore,
      liveClock: m.liveClock,
      picks: m.picks.map((p) => ({
        id: p.id,
        selection: p.selection,
        confidence: p.confidence,
        odds: p.odds,
        price: p.price,
      })),
    })),
  });
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
      selection: r.pick.selection,
      confidence: r.pick.confidence,
      outcome: r.outcome,
    })),
  });
});

module.exports = router;
