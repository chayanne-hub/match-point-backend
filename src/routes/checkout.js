const express = require('express');
const { createCharge } = require('../lib/coinbaseCommerce');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

// Fixed prices for plans that aren't tied to one specific pick. Single-pick
// purchases use that individual pick's own `price` field instead (set per
// pick on the Pick model, defaults to 900 = $9).
const PLAN_PRICES_CENTS = {
  daily_bundle: 2500,
  weekly_bundle: 2500,
  monthly_membership: 9900,
  season_membership: 60000,
};

const PLAN_LABELS = {
  single_pick: 'Single Pick',
  daily_bundle: 'Daily Bundle',
  weekly_bundle: 'Weekly Bundle',
  monthly_membership: 'Monthly Membership',
  season_membership: 'Season Membership',
};

// POST /checkout/session  { plan, pickId?, sport? }
// Requires auth so we know which user to attach the purchase/subscription to.
router.post('/session', requireAuth, async (req, res) => {
  const { plan, pickId, sport } = req.body || {};

  if (!PLAN_LABELS[plan]) {
    return res.status(400).json({ error: `Unknown plan: ${plan}` });
  }

  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ error: 'User not found.' });

  let amountCents;
  if (plan === 'single_pick') {
    if (!pickId) return res.status(400).json({ error: 'pickId is required for single_pick.' });
    const pick = await db.pick.findUnique({ where: { id: pickId } });
    if (!pick) return res.status(404).json({ error: 'Pick not found.' });
    amountCents = pick.price;
  } else {
    amountCents = PLAN_PRICES_CENTS[plan];
    if (!amountCents) return res.status(400).json({ error: `No price configured for plan: ${plan}` });
  }

  let charge;
  try {
    charge = await createCharge({
      name: `Match Point — ${PLAN_LABELS[plan]}`,
      description: sport ? `${PLAN_LABELS[plan]} (${sport})` : PLAN_LABELS[plan],
      amountCents,
      metadata: {
        userId: user.id,
        plan,
        pickId: pickId || '',
      },
      redirectUrl: process.env.CHECKOUT_SUCCESS_URL,
      cancelUrl: process.env.CHECKOUT_CANCEL_URL,
    });
  } catch (err) {
    console.error('[checkout] Coinbase Commerce charge creation failed:', err.message);
    return res.status(502).json({ error: 'Could not start checkout — please try again.' });
  }

  res.json({ url: charge.hosted_url });
});

module.exports = router;
