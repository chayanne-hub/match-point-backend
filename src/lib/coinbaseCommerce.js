/**
 * Match Point — Coinbase Commerce integration.
 *
 * Replaces Stripe entirely. Coinbase Commerce has no native subscription
 * concept — every payment (single pick, bundle, or membership) is a single
 * "charge." Recurring plans are modeled on our side as a fresh charge each
 * billing period (see webhooks.js for how currentPeriodEnd gets computed),
 * not automatic billing — there's no card-on-file equivalent for crypto.
 *
 * API docs: https://docs.cdp.coinbase.com/commerce-onchain/docs/
 */

const fetch = require('node-fetch');
const crypto = require('crypto');

const COMMERCE_API_BASE = 'https://api.commerce.coinbase.com';

if (!process.env.COINBASE_COMMERCE_API_KEY) {
  console.warn('[coinbase-commerce] COINBASE_COMMERCE_API_KEY is not set — payment routes will fail until it is.');
}
if (!process.env.COINBASE_COMMERCE_WEBHOOK_SECRET) {
  console.warn('[coinbase-commerce] COINBASE_COMMERCE_WEBHOOK_SECRET is not set — webhook verification will fail until it is.');
}

/**
 * Creates a Coinbase Commerce charge and returns the hosted checkout page
 * to redirect the customer to. metadata carries userId/plan/pickId through
 * to the webhook the same way Stripe's Checkout Session metadata did.
 */
async function createCharge({ name, description, amountCents, metadata, redirectUrl, cancelUrl }) {
  const res = await fetch(`${COMMERCE_API_BASE}/charges`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CC-Api-Key': process.env.COINBASE_COMMERCE_API_KEY,
      'X-CC-Version': '2018-03-22',
    },
    body: JSON.stringify({
      name,
      description,
      pricing_type: 'fixed_price',
      local_price: {
        amount: (amountCents / 100).toFixed(2),
        currency: 'USD',
      },
      metadata,
      redirect_url: redirectUrl,
      cancel_url: cancelUrl,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Coinbase Commerce charge creation failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.data; // { id, code, hosted_url, metadata, ... }
}

/**
 * Verifies the webhook signature Coinbase Commerce sends in the
 * X-CC-Webhook-Signature header. rawBody MUST be the raw, unparsed request
 * body (a Buffer) — HMAC verification requires the exact bytes Coinbase
 * signed, not a re-serialized JSON object (which can differ in whitespace/
 * key order and would make the signature never match).
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!process.env.COINBASE_COMMERCE_WEBHOOK_SECRET) {
    throw new Error('COINBASE_COMMERCE_WEBHOOK_SECRET is not set.');
  }
  if (!signatureHeader) {
    throw new Error('Missing X-CC-Webhook-Signature header.');
  }

  const expected = crypto
    .createHmac('sha256', process.env.COINBASE_COMMERCE_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  if (expected !== signatureHeader) {
    throw new Error('Webhook signature mismatch.');
  }
}

module.exports = { createCharge, verifyWebhookSignature };
