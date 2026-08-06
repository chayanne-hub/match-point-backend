const express = require('express');
const { verifyWebhookSignature } = require('../lib/coinbaseCommerce');
const db = require('../lib/db');

const router = express.Router();

// How long each plan's access period lasts once paid. Coinbase Commerce has
// no auto-renewal, so this just controls when currentPeriodEnd lands —
// access lapses automatically at that point unless the user pays again.
// season_membership's 180 days is an approximation (roughly a football
// season) — adjust to match the actual season length if it drifts.
const PLAN_DURATION_DAYS = {
  daily_bundle: 1,
  weekly_bundle: 7,
  monthly_membership: 30,
  season_membership: 180,
};

// IMPORTANT: this route must receive the *raw* request body (not JSON-parsed)
// for signature verification to work. That's wired up in server.js — this
// route needs to be mounted before the global express.json() middleware
// runs on it, same as the old Stripe webhook was.
//
// POST /webhooks/coinbase
router.post('/coinbase', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-cc-webhook-signature'];

  try {
    verifyWebhookSignature(req.body, signature);
  } catch (err) {
    console.error('[webhook] Coinbase Commerce signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    return res.status(400).send('Invalid JSON payload.');
  }

  const event = payload.event;

  try {
    if (event.type === 'charge:confirmed') {
      const charge = event.data;
      const { userId, plan, pickId } = charge.metadata || {};

      if (!userId || !plan) {
        console.warn('[webhook] charge:confirmed missing userId/plan in metadata, skipping. code=', charge.code);
        return res.json({ received: true });
      }

      if (plan === 'single_pick' && pickId) {
        const pick = await db.pick.findUnique({ where: { id: pickId } });
        if (pick) {
          await db.purchasedPick.upsert({
            where: { userId_pickId: { userId, pickId } },
            update: {},
            create: { userId, pickId, pricePaid: pick.price },
          });
        }
      } else if (PLAN_DURATION_DAYS[plan]) {
        const durationDays = PLAN_DURATION_DAYS[plan];
        const currentPeriodEnd = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);

        await db.subscription.upsert({
          where: { userId },
          update: {
            lastChargeCode: charge.code,
            plan,
            status: 'active',
            currentPeriodEnd,
          },
          create: {
            userId,
            lastChargeCode: charge.code,
            plan,
            status: 'active',
            currentPeriodEnd,
          },
        });
      }
    }

    // charge:failed / charge:delayed / charge:pending are informational —
    // access is only ever granted on a confirmed payment, so no DB action
    // is needed for these.

    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed.' });
  }
});

module.exports = router;
