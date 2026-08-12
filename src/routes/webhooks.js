const express = require('express');
const { verifyWebhookSignature, getMembership } = require('../lib/whop');
const db = require('../lib/db');

const router = express.Router();

// Whop plan id -> our internal plan key. Reverses the WHOP_PLAN_* env vars
// so an incoming webhook can be mapped back to a plan name for display.
function planKeyFromWhopPlanId(whopPlanId) {
  if (!whopPlanId) return null;
  const pairs = {
    monthly_membership: process.env.WHOP_PLAN_MONTHLY,
    season_membership: process.env.WHOP_PLAN_SEASON,
    daily_bundle: process.env.WHOP_PLAN_DAILY,
    weekly_bundle: process.env.WHOP_PLAN_WEEKLY,
  };
  return Object.keys(pairs).find((key) => pairs[key] && pairs[key] === whopPlanId) || null;
}

/**
 * Resolves the local account a Whop event belongs to, in descending order
 * of reliability:
 *
 *   1. metadata.userId — set when we created the checkout session. Exact,
 *      and independent of what email they used on Whop.
 *   2. whopUserId — an account we've already linked from a previous event.
 *   3. email — last resort. Only works if they used the same address on
 *      both, which is common but not guaranteed.
 *
 * Returns null rather than guessing. An unattributable event is logged and
 * skipped: granting access to the wrong account is far worse than a
 * membership that needs manual linking.
 */
async function resolveUser(data) {
  const metaUserId = data?.metadata?.userId || data?.plan?.metadata?.userId || null;
  if (metaUserId) {
    const byMeta = await db.user.findUnique({ where: { id: metaUserId } });
    if (byMeta) return byMeta;
    console.warn(`[webhook] metadata.userId "${metaUserId}" did not match any account.`);
  }

  const whopUserId = data?.user?.id || data?.user_id || null;
  if (whopUserId) {
    const byWhopId = await db.user.findUnique({ where: { whopUserId } });
    if (byWhopId) return byWhopId;
  }

  const email = data?.user?.email || null;
  if (email) {
    const byEmail = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (byEmail) return byEmail;
  }

  return null;
}

// Remembers the Whop user id on the account so future events resolve
// without depending on metadata or a matching email.
async function linkWhopUser(user, data) {
  const whopUserId = data?.user?.id || data?.user_id || null;
  if (!whopUserId || user.whopUserId === whopUserId) return;
  try {
    await db.user.update({ where: { id: user.id }, data: { whopUserId } });
  } catch (err) {
    // Unique constraint — this Whop account is already linked elsewhere.
    console.warn(`[webhook] could not link whopUserId ${whopUserId} to ${user.id}: ${err.message}`);
  }
}

/**
 * IMPORTANT: this route needs the *raw* body for signature verification,
 * which is why server.js mounts /webhooks before the global express.json().
 * Re-serialising parsed JSON changes byte-for-byte content and the
 * signature would never match.
 *
 * POST /webhooks/whop
 */
router.post('/whop', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    verifyWebhookSignature(req.body, req.headers);
  } catch (err) {
    console.error('[webhook] Whop signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    return res.status(400).send('Invalid JSON payload.');
  }

  // Whop sends { action, data } on v1-style webhooks and { type, data } on
  // newer ones. Accept either rather than depending on one shape.
  const action = payload.action || payload.type;
  const data = payload.data || {};

  try {
    switch (action) {
      // Access granted — a new purchase, or a renewal that revalidated a
      // lapsed membership.
      case 'membership.went_valid':
      case 'membership_went_valid':
      case 'membership.activated': {
        const user = await resolveUser(data);
        if (!user) {
          console.warn(`[webhook] ${action}: could not attribute membership ${data.id} to any account — skipping.`);
          break;
        }
        await linkWhopUser(user, data);

        // Read the membership back rather than trusting the payload for
        // the expiry — webhook bodies don't guarantee every field, and
        // this value decides how long access lasts.
        let renewalEnd = null;
        let whopPlanId = data?.plan?.id || data?.plan_id || null;
        try {
          const membership = await getMembership(data.id);
          if (membership?.renewal_period_end) renewalEnd = new Date(membership.renewal_period_end * 1000);
          else if (membership?.expires_at) renewalEnd = new Date(membership.expires_at * 1000);
          whopPlanId = membership?.plan_id || whopPlanId;
        } catch (err) {
          console.warn(`[webhook] could not re-read membership ${data.id}: ${err.message}`);
        }

        // Whop drives renewal, so this date is informational rather than
        // the gate. If we can't determine it, fall back to a month out —
        // membership.went_invalid is what actually revokes access.
        if (!renewalEnd) renewalEnd = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);

        const planKey = planKeyFromWhopPlanId(whopPlanId) || 'monthly_membership';

        await db.subscription.upsert({
          where: { userId: user.id },
          update: {
            whopMembershipId: data.id,
            whopPlanId,
            plan: planKey,
            status: 'active',
            currentPeriodEnd: renewalEnd,
          },
          create: {
            userId: user.id,
            whopMembershipId: data.id,
            whopPlanId,
            plan: planKey,
            status: 'active',
            currentPeriodEnd: renewalEnd,
          },
        });
        console.log(`[webhook] ${action}: activated ${planKey} for user ${user.id}`);
        break;
      }

      // Access revoked — cancelled, expired, refunded, or charged back.
      // Whop decides this; we just honour it.
      case 'membership.went_invalid':
      case 'membership_went_invalid':
      case 'membership.deactivated': {
        const existing = await db.subscription.findFirst({ where: { whopMembershipId: data.id } });
        if (!existing) {
          console.warn(`[webhook] ${action}: no subscription found for membership ${data.id} — nothing to revoke.`);
          break;
        }
        await db.subscription.update({
          where: { id: existing.id },
          data: { status: 'canceled', currentPeriodEnd: new Date() },
        });
        console.log(`[webhook] ${action}: revoked access for user ${existing.userId}`);
        break;
      }

      // A successful renewal payment — push the access window forward.
      case 'payment.succeeded':
      case 'payment_succeeded': {
        const membershipId = data?.membership?.id || data?.membership_id || null;
        if (!membershipId) break;
        const existing = await db.subscription.findFirst({ where: { whopMembershipId: membershipId } });
        if (!existing) break;
        try {
          const membership = await getMembership(membershipId);
          const end = membership?.renewal_period_end
            ? new Date(membership.renewal_period_end * 1000)
            : null;
          if (end) {
            await db.subscription.update({
              where: { id: existing.id },
              data: { status: 'active', currentPeriodEnd: end },
            });
          }
        } catch (err) {
          console.warn(`[webhook] payment.succeeded: could not refresh membership ${membershipId}: ${err.message}`);
        }
        break;
      }

      // Informational. Access is NOT cut here — Whop retries failed
      // payments, and membership.went_invalid is the real signal. Marking
      // past_due lets the UI warn without locking anyone out prematurely.
      case 'payment.failed':
      case 'payment_failed': {
        const membershipId = data?.membership?.id || data?.membership_id || null;
        if (!membershipId) break;
        const existing = await db.subscription.findFirst({ where: { whopMembershipId: membershipId } });
        if (existing) {
          await db.subscription.update({ where: { id: existing.id }, data: { status: 'past_due' } });
        }
        break;
      }

      default:
        // Unhandled events are fine — acknowledge so Whop doesn't retry.
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed.' });
  }
});

module.exports = router;
