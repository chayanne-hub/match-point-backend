const express = require('express');
const { createCheckout, planIdFor, availablePlans } = require('../lib/whop');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

/**
 * Prices no longer live in this file.
 *
 * Under Coinbase Commerce we had to compute the amount ourselves and
 * create a charge for it. Whop is the merchant of record — plans and
 * prices are configured in the Whop dashboard, and this backend only
 * references a plan id. Changing a price is a dashboard edit, not a
 * deploy, and there's no way for the site and the checkout page to
 * disagree about what something costs.
 */
// Only what's actually sold. The daily/weekly/season tiers were carried
// over from the Coinbase era and are no longer offered — leaving them
// here meant the API would still accept and price them even though
// nothing in the UI offers them, so anyone hitting the endpoint directly
// could buy a plan that doesn't exist as a product.
//
// single_pick stays listed deliberately: it's referenced by older links
// and is rejected with a clear 501 below rather than silently failing.
const PLAN_LABELS = {
  single_pick: 'Single Pick',
  monthly_membership: 'Monthly Membership',
};

// GET /checkout/plans — which plans are actually purchasable right now.
// A plan only counts as available once its Whop plan id is configured, so
// the frontend can't offer something that would fail at checkout.
router.get('/plans', (req, res) => {
  const plans = availablePlans().map((key) => ({ key, label: PLAN_LABELS[key] || key }));
  res.json({ plans });
});

// POST /checkout/session  { plan, pickId?, sport? }
// Returns { url } — the Whop checkout page to send the buyer to.
router.post('/session', requireAuth, async (req, res) => {
  const { plan, pickId } = req.body || {};

  if (!PLAN_LABELS[plan]) {
    return res.status(400).json({ error: `Unknown plan: ${plan}` });
  }

  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ error: 'User not found.' });

  // Single-pick purchases aren't wired to Whop yet. Whop plans are fixed
  // products; a per-pick price would mean creating a plan per pick, which
  // isn't how the platform is meant to be used. Failing loudly here is
  // better than silently charging for something else.
  if (plan === 'single_pick') {
    return res.status(501).json({
      error: 'Single-pick purchases are not available yet — choose a membership plan.',
    });
  }

  if (!planIdFor(plan)) {
    console.error(`[checkout] no Whop plan id configured for "${plan}"`);
    return res.status(503).json({ error: 'That plan is not available for purchase right now.' });
  }

  if (pickId) {
    // Not used for pricing, just a sanity check that the caller is
    // referencing something real.
    const pick = await db.pick.findUnique({ where: { id: pickId } });
    if (!pick) return res.status(404).json({ error: 'Pick not found.' });
  }

  let checkout;
  try {
    checkout = await createCheckout({
      planKey: plan,
      userId: user.id,
      redirectUrl: process.env.CHECKOUT_SUCCESS_URL,
    });
  } catch (err) {
    console.error('[checkout] Whop checkout creation failed:', err.message);
    return res.status(502).json({ error: 'Could not start checkout — please try again.' });
  }

  if (!checkout.metadataAttached) {
    // The buyer can still complete this purchase, but the webhook won't
    // carry our user id and will have to fall back to matching on Whop
    // user id or email. Worth knowing about in the logs.
    console.warn(`[checkout] proceeding without metadata for user ${user.id} — webhook will fall back to email matching.`);
  }

  // planId + sessionId are what the EMBEDDED checkout needs to mount on
  // our own page (data-whop-checkout-plan-id / -session). url is kept as
  // a fallback for anything that still wants to hand off to Whop's hosted
  // page — but the site itself never redirects.
  res.json({
    url: checkout.url,
    planId: planIdFor(plan),
    sessionId: checkout.sessionId,
    metadataAttached: checkout.metadataAttached,
  });
});

module.exports = router;
