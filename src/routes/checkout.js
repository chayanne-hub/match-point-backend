const express = require('express');
const stripe = require('../lib/stripe');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

const PRICE_IDS = {
  single_pick: process.env.STRIPE_PRICE_SINGLE_PICK,
  daily_bundle: process.env.STRIPE_PRICE_DAILY_BUNDLE,
  monthly_membership: process.env.STRIPE_PRICE_MONTHLY_MEMBERSHIP,
};

// POST /checkout/session  { plan: "single_pick" | "daily_bundle" | "monthly_membership", pickId?: string }
// Requires auth so we know which user to attach the purchase/subscription to.
router.post('/session', requireAuth, async (req, res) => {
  const { plan, pickId } = req.body || {};

  const priceId = PRICE_IDS[plan];
  if (!priceId) {
    return res.status(400).json({ error: `Unknown or unconfigured plan: ${plan}` });
  }

  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ error: 'User not found.' });

  // Make sure this user has a Stripe customer record, so recurring plans and
  // one-off purchases both land under the same customer.
  let stripeCustomerId = user.stripeCustomerId;
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({ email: user.email });
    stripeCustomerId = customer.id;
    await db.user.update({ where: { id: user.id }, data: { stripeCustomerId } });
  }

  const isSubscription = plan !== 'single_pick';

  const session = await stripe.checkout.sessions.create({
    customer: stripeCustomerId,
    mode: isSubscription ? 'subscription' : 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: process.env.CHECKOUT_SUCCESS_URL,
    cancel_url: process.env.CHECKOUT_CANCEL_URL,
    metadata: {
      userId: user.id,
      plan,
      pickId: pickId || '',
    },
  });

  res.json({ url: session.url });
});

module.exports = router;
