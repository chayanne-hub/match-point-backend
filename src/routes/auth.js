const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const { signToken, requireAuth } = require('../lib/auth');

const router = express.Router();

// POST /auth/signup  { email, password }
router.post('/signup', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const existing = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await db.user.create({
    data: { email: email.toLowerCase(), passwordHash },
  });

  const token = signToken(user);
  res.status(201).json({ token, user: { id: user.id, email: user.email } });
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
  res.json({ token, user: { id: user.id, email: user.email } });
});

// GET /auth/me — requires Authorization header, returns account + plan status
router.get('/me', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({
    where: { id: req.userId },
    include: { subscription: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found.' });

  res.json({
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
    subscription: user.subscription
      ? {
          plan: user.subscription.plan,
          status: user.subscription.status,
          currentPeriodEnd: user.subscription.currentPeriodEnd,
        }
      : null,
  });
});

module.exports = router;
