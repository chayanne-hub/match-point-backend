const db = require('./db');

/**
 * ENTITLEMENT — the single answer to "may this account see picks?"
 *
 * Every read path asks this and nothing else. It is deliberately the only
 * place that knows the rule, because the previous arrangement — a
 * Subscription row that webhooks kept faithfully up to date and no route
 * that ever read it — meant access was governed by whatever each page
 * happened to check.
 *
 * Two conditions, both required:
 *
 *   status must be live      — 'canceled' and 'incomplete' are out.
 *   currentPeriodEnd ahead   — the date check is what makes a MISSED
 *                              webhook fail closed. Whop's
 *                              membership.went_invalid is the fast path,
 *                              not the only path: if that delivery is
 *                              ever dropped, the window still runs out on
 *                              its own and access ends. Trusting the
 *                              webhook alone means one lost POST equals
 *                              permanent free access.
 */

// 'past_due' is honoured on purpose. It means they HAVE paid before and
// Whop is retrying a renewal card — cutting them off mid-retry punishes
// people whose card simply expired. It is not a way to reach the product
// without ever paying: a brand-new account has no Subscription row at
// all, so it fails on the first check, not this one.
const LIVE_STATUSES = new Set(['active', 'past_due']);

async function getEntitlement(userId) {
  if (!userId) return { entitled: false, reason: 'not_signed_in' };

  const sub = await db.subscription.findUnique({ where: { userId } });

  // No row at all — signed up, never started a trial or paid.
  if (!sub) return { entitled: false, reason: 'no_subscription' };

  if (!LIVE_STATUSES.has(sub.status)) {
    return { entitled: false, reason: sub.status === 'canceled' ? 'canceled' : 'incomplete' };
  }

  if (!sub.currentPeriodEnd || sub.currentPeriodEnd.getTime() <= Date.now()) {
    return { entitled: false, reason: 'expired' };
  }

  return {
    entitled: true,
    plan: sub.plan,
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd,
    // True while Whop retries a renewal charge. The terminal can warn
    // without locking anyone out.
    inGrace: sub.status === 'past_due',
  };
}

/**
 * Route guard. 402 rather than 403 on purpose: "you are who you say you
 * are, there is simply nothing paid for here." It gives the frontend one
 * unambiguous status to branch on when deciding to send someone to
 * checkout, and it can't be confused with an expired token.
 */
function requireAccess(req, res, next) {
  const userId = req.user && req.user.id;
  if (!userId) return res.status(401).json({ error: 'Sign in to continue.' });

  getEntitlement(userId)
    .then((ent) => {
      if (ent.entitled) {
        req.entitlement = ent;
        return next();
      }
      res.status(402).json({
        error: 'This needs an active membership.',
        reason: ent.reason,
        checkoutUrl: '/checkout.html',
      });
    })
    .catch(next);
}

/**
 * For endpoints that serve both sides of the wall — the board renders for
 * everyone, but only members get selections. Attaches req.entitlement and
 * always continues, so the route can decide what to withhold.
 *
 * Use this ONLY where the unentitled response genuinely omits the pick.
 * Sending the selection and hiding it in CSS is not a wall.
 */
function attachEntitlement(req, res, next) {
  const userId = req.user && req.user.id;
  if (!userId) {
    req.entitlement = { entitled: false, reason: 'not_signed_in' };
    return next();
  }
  getEntitlement(userId)
    .then((ent) => { req.entitlement = ent; next(); })
    .catch(next);
}

module.exports = { getEntitlement, requireAccess, attachEntitlement };
