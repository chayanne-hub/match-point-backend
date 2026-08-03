const express = require('express');
const stripe = require('../lib/stripe');
const db = require('../lib/db');

const router = express.Router();

// IMPORTANT: this route must receive the *raw* request body (not JSON-parsed)
// for Stripe's signature verification to work. That's wired up in server.js —
// this route is mounted before the global express.json() middleware runs on it.
//
// POST /webhooks/stripe
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { userId, plan, pickId } = session.metadata || {};
        if (!userId) break;

        if (plan === 'single_pick' && pickId) {
          const pick = await db.pick.findUnique({ where: { id: pickId } });
          if (pick) {
            await db.purchasedPick.upsert({
              where: { userId_pickId: { userId, pickId } },
              update: {},
              create: { userId, pickId, pricePaid: pick.price },
            });
          }
        } else if (session.subscription) {
          // Subscription plans get fully reconciled on customer.subscription.*
          // events below, but we stash it here too in case that event lags.
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          await db.subscription.upsert({
            where: { userId },
            update: {
              stripeSubscriptionId: sub.id,
              plan,
              status: sub.status,
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
            },
            create: {
              userId,
              stripeSubscriptionId: sub.id,
              plan,
              status: sub.status,
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
            },
          });
        }
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const existing = await db.subscription.findUnique({
          where: { stripeSubscriptionId: sub.id },
        });
        if (existing) {
          await db.subscription.update({
            where: { stripeSubscriptionId: sub.id },
            data: {
              status: sub.status,
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
            },
          });
        }
        break;
      }

      default:
        // Unhandled event types are fine to ignore.
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed.' });
  }
});

module.exports = router;
