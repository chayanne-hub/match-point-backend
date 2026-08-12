require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');

const authRoutes = require('./routes/auth');
const checkoutRoutes = require('./routes/checkout');
const webhookRoutes = require('./routes/webhooks');
const picksRoutes = require('./routes/picks');
const { startWatchdog, startReactiveOdds, startScheduled, startLiveScheduled, startEspnScheduled } = require('./pipeline/cron');
const { initLiveSocket } = require('./lib/liveSocket');

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// Whop webhooks need the RAW body for Standard Webhooks signature
// verification, so this is mounted BEFORE express.json() runs globally.
// Re-serialising parsed JSON changes byte-for-byte content and the
// signature would never match. (Previously Stripe, then Coinbase
// Commerce — same constraint each time.)
app.use('/webhooks', webhookRoutes);

app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/auth', authRoutes);
app.use('/checkout', checkoutRoutes);
app.use('/api/picks', picksRoutes);

app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

const PORT = process.env.PORT || 4000;

// Explicit http.createServer(app) instead of app.listen() directly —
// app.listen() creates its own internal HTTP server that isn't exposed
// anywhere, so there'd be no server instance to attach the WebSocket
// server to. This is the same underlying server either way, just a
// reference to it we can actually use.
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`Match Point backend listening on port ${PORT}`);
});

initLiveSocket(server);

startWatchdog();
startReactiveOdds();
startScheduled();
// Re-enabled: live reassessment now runs, meaning confidence for a live
// match will genuinely recalculate (and re-color) as the match unfolds
// — real Claude API calls, every LIVE_PIPELINE_INTERVAL_MS (currently
// 15 minutes, set in cron.js — down from the original 3-minute default
// to keep cost more reasonable), for every live match, for its full
// duration. This was disabled earlier specifically to cut this cost;
// re-enabling it is a real, deliberate, ongoing spend, not free.
startLiveScheduled();
startEspnScheduled();
