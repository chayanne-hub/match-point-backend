const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const { signToken, requireAuth } = require('../lib/auth');

const router = express.Router();

// Admin bypass — accounts on this list get treated as having a real
// active subscription everywhere the frontend checks plan status
// (hero CTA, account rail) without needing an actual Coinbase Commerce
// payment on file. Set via Railway env var, comma-separated, so this
// never requires a schema change or a manual database edit to grant or
// revoke — just update the env var and redeploy.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function isAdminEmail(email) {
  return ADMIN_EMAILS.includes((email || '').toLowerCase());
}

// POST /auth/signup  { email, password, username }
// username is shown publicly (nav, anywhere the account is referenced) —
// email is never shown on-screen, specifically so streamers/on-screen
// viewers can't be doxxed by their email leaking into a stream.
router.post('/signup', async (req, res) => {
  const { email, password, username } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!username || username.trim().length < 2) {
    return res.status(400).json({ error: 'Username must be at least 2 characters.' });
  }

  const existingEmail = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existingEmail) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const existingUsername = await db.user.findUnique({ where: { username: username.trim() } });
  if (existingUsername) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await db.user.create({
    data: { email: email.toLowerCase(), username: username.trim(), passwordHash },
  });

  const token = signToken(user);
  res.status(201).json({ token, user: { id: user.id, username: user.username } });
});

// POST /auth/login  { email, password }
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = signToken(user);
  res.json({ token, user: { id: user.id, username: user.username } });
});

// GET /auth/me — requires Authorization header, returns account + plan status.
// Deliberately does NOT include email in the response — every page's nav
// displays whatever this returns, and email must never end up on-screen.
router.get('/me', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({
    where: { id: req.userId },
    include: { subscription: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found.' });

  // Admin bypass: synthesize a real-shaped "active" subscription instead
  // of whatever's actually on file (or nothing at all). currentPeriodEnd
  // is set 100 years out rather than something like "forever" as a
  // string, so any code doing real date math on it (renewal countdowns,
  // etc.) doesn't break on an unexpected type.
  const subscriptionPayload = isAdminEmail(user.email)
    ? {
        plan: 'admin_access',
        status: 'active',
        currentPeriodEnd: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
      }
    : user.subscription
    ? {
        plan: user.subscription.plan,
        status: user.subscription.status,
        currentPeriodEnd: user.subscription.currentPeriodEnd,
      }
    : null;

  res.json({
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
    subscription: subscriptionPayload,
  });
});

// PATCH /auth/username  { username } — change username after signup
router.patch('/username', requireAuth, async (req, res) => {
  const { username } = req.body || {};
  if (!username || username.trim().length < 2) {
    return res.status(400).json({ error: 'Username must be at least 2 characters.' });
  }

  const existing = await db.user.findUnique({ where: { username: username.trim() } });
  if (existing && existing.id !== req.userId) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  const user = await db.user.update({
    where: { id: req.userId },
    data: { username: username.trim() },
  });
  res.json({ username: user.username });
});

module.exports = router;
module.exports.isAdminEmail = isAdminEmail;
