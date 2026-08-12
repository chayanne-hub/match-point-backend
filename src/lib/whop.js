/**
 * Match Point — Whop integration.
 *
 * Replaces Coinbase Commerce. Whop is the merchant of record: it owns
 * checkout, billing, renewals, refunds and disputes. This backend never
 * touches card data and never charges anyone — it only reacts to what
 * Whop tells it via webhooks, and reads membership state back when it
 * needs to confirm something.
 *
 * That's a real change from the Coinbase model. There, every purchase was
 * a one-off charge and "renewal" was a fresh charge granting another fixed
 * window (currentPeriodEnd), because crypto has no card-on-file. Whop does
 * genuine recurring billing, so a membership stays valid until Whop says
 * otherwise — membership.went_invalid is the signal to cut access, not an
 * expiry date we computed ourselves.
 *
 * Env vars required:
 *   WHOP_API_KEY         — company API key from the Whop dashboard (Developer tab)
 *   WHOP_WEBHOOK_SECRET  — webhook signing secret (starts "whsec_")
 *   WHOP_PLAN_<KEY>      — one plan id (plan_xxx) per sellable plan, see PLAN_ENV_KEYS
 *   CHECKOUT_SUCCESS_URL — where Whop returns the buyer after checkout
 */

const fetch = require('node-fetch');
const crypto = require('crypto');

const WHOP_API_BASE = process.env.WHOP_API_BASE_URL || 'https://api.whop.com';

if (!process.env.WHOP_API_KEY) {
  console.warn('[whop] WHOP_API_KEY is not set — checkout will fail until it is.');
}
if (!process.env.WHOP_WEBHOOK_SECRET) {
  console.warn('[whop] WHOP_WEBHOOK_SECRET is not set — webhook verification will fail until it is.');
}

// Our internal plan keys -> the env var holding that plan's Whop plan id.
// Plans and prices live in the Whop dashboard now, not in this codebase —
// that's the point of a merchant of record. Changing a price is a dashboard
// edit, not a deploy.
const PLAN_ENV_KEYS = {
  monthly_membership: 'WHOP_PLAN_MONTHLY',
  season_membership: 'WHOP_PLAN_SEASON',
  daily_bundle: 'WHOP_PLAN_DAILY',
  weekly_bundle: 'WHOP_PLAN_WEEKLY',
};

function planIdFor(planKey) {
  const envKey = PLAN_ENV_KEYS[planKey];
  if (!envKey) return null;
  return process.env[envKey] || null;
}

function availablePlans() {
  return Object.keys(PLAN_ENV_KEYS).filter((k) => !!planIdFor(k));
}

async function whopRequest(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${WHOP_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.WHOP_API_KEY}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  // Read as text first so a non-JSON error page produces a useful message
  // instead of an opaque "Unexpected end of JSON input".
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    throw new Error(`Whop ${method} ${path} returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`Whop ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return data;
}

/**
 * Creates a checkout session for a plan, carrying our own user id through
 * as metadata so the resulting webhook can be attributed to the right
 * account without relying on the buyer using the same email on Whop as
 * they did here.
 *
 * Returns { url } — where to send the buyer.
 *
 * NOTE: the checkout-session endpoint path is configurable because Whop
 * has more than one API surface (v2 REST, v5, and the SDK) and the REST
 * path has moved before. If this call 404s, the fix is the env var, not
 * a code change — and createCheckout falls back to a plain plan link
 * below so checkout still works while that's sorted out.
 */
const CHECKOUT_SESSION_PATH = process.env.WHOP_CHECKOUT_SESSION_PATH || '/api/v2/checkout_sessions';

async function createCheckout({ planKey, userId, redirectUrl }) {
  const planId = planIdFor(planKey);
  if (!planId) {
    throw new Error(`No Whop plan id configured for "${planKey}" — set ${PLAN_ENV_KEYS[planKey] || 'the plan env var'}.`);
  }

  try {
    const session = await whopRequest(CHECKOUT_SESSION_PATH, {
      method: 'POST',
      body: {
        plan_id: planId,
        // Read back in the webhook handler to link the purchase to this
        // account. Whop echoes plan/membership metadata into payment and
        // membership webhook payloads.
        metadata: { userId },
        ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
      },
    });

    const url = session.purchase_url || session.url || (session.id ? `https://whop.com/checkout/${session.id}` : null);
    if (url) return { url, sessionId: session.id || null, metadataAttached: true };
    throw new Error(`Whop checkout session response had no usable URL: ${JSON.stringify(session).slice(0, 300)}`);
  } catch (err) {
    // Fallback: send them straight to the plan's own checkout page. This
    // still completes the purchase, but WITHOUT our userId in metadata —
    // the webhook then has to fall back to matching on Whop user id or
    // email (see resolveUser in webhooks.js). Logged loudly because it's
    // a degraded path, not a normal one.
    console.error(`[whop] checkout session creation failed, falling back to a plain plan link: ${err.message}`);
    return { url: `https://whop.com/checkout/${planId}`, sessionId: null, metadataAttached: false };
  }
}

/**
 * Reads a membership back from Whop. Used to confirm state rather than
 * trusting a webhook body alone for anything consequential.
 */
async function getMembership(membershipId) {
  return whopRequest(`/v5/app/memberships/${encodeURIComponent(membershipId)}`);
}

/**
 * Verifies a webhook using the Standard Webhooks spec, which Whop follows.
 *
 * Headers: webhook-id, webhook-timestamp, webhook-signature
 * Signed content: `${id}.${timestamp}.${rawBody}`
 * Signature: base64 HMAC-SHA256 using the secret with its "whsec_" prefix
 * stripped and the remainder base64-decoded.
 *
 * rawBody MUST be the exact bytes Whop sent. Re-serialising a parsed JSON
 * object changes whitespace and key order, and the signature would never
 * match — this is why the webhook route is mounted before express.json().
 */
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function verifyWebhookSignature(rawBody, headers) {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret) throw new Error('WHOP_WEBHOOK_SECRET is not set.');

  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatureHeader = headers['webhook-signature'];
  if (!id || !timestamp || !signatureHeader) {
    throw new Error('Missing webhook-id / webhook-timestamp / webhook-signature header.');
  }

  // Replay guard — an attacker re-sending a captured request later still
  // has a valid signature, so the timestamp has to be checked separately.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_SECONDS) {
    throw new Error(`Webhook timestamp outside tolerance (${age}s).`);
  }

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${id}.${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  // The header can carry several space-separated versioned signatures
  // ("v1,<sig> v1,<sig>") during a secret rotation — any one matching is valid.
  const provided = String(signatureHeader)
    .split(' ')
    .map((part) => part.split(',').pop());

  const expectedBuf = Buffer.from(expected);
  const matched = provided.some((sig) => {
    const sigBuf = Buffer.from(sig);
    // timingSafeEqual throws on length mismatch, so guard before comparing.
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });

  if (!matched) throw new Error('Webhook signature mismatch.');
}

module.exports = {
  createCheckout,
  getMembership,
  verifyWebhookSignature,
  planIdFor,
  availablePlans,
  PLAN_ENV_KEYS,
};
