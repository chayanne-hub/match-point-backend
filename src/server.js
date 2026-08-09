require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');

const authRoutes = require('./routes/auth');
const checkoutRoutes = require('./routes/checkout');
const webhookRoutes = require('./routes/webhooks');
const picksRoutes = require('./routes/picks');
const { startScheduled, startLiveScheduled, startEspnScheduled } = require('./pipeline/cron');
const { initLiveSocket } = require('./lib/liveSocket');

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// Stripe webhooks need the raw body for signature verification, so this is
// mounted BEFORE express.json() runs globally.
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

startScheduled();
// startLiveScheduled() is intentionally NOT started. It ran Claude
// reassessment (real API calls, with a real ongoing cost) for every live
// match every few minutes for the match's whole duration — the single
// biggest driver of daily API spend. Replaced with a scoreboard-only
// approach: the free ESPN score poller (startEspnScheduled, below) keeps
// live scores current, and the frontend shows those scores under "Live
// Now" alongside the ORIGINAL pregame pick (confidence/rationale/factors,
// paid for once, never re-analyzed). No live confidence number that
// changes during the match anymore — a deliberate trade against cost,
// not an oversight. Re-enable by uncommenting the line below if that
// trade-off changes.
// startLiveScheduled();
startEspnScheduled();
