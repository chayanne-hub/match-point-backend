/**
 * Match Point — live score WebSocket push.
 *
 * This is the actual "terminal" mechanic: instead of the frontend polling
 * every 20 seconds and hoping something changed, the backend pushes a
 * message the instant a match's score/status actually updates — which
 * happens on the existing ESPN poll cycle (every 15s), just now
 * broadcast immediately instead of sitting until the next frontend poll.
 *
 * Deliberately scoped to SCORE data only, not picks/confidence/odds —
 * those only change once per 15-minute pipeline cycle (or not at all,
 * since live reassessment was cut for cost), so pushing them over a
 * persistent connection has little value over the existing poll. Score
 * data is genuinely high-frequency; that's the one thing worth a real
 * push channel.
 *
 * Attaches to the SAME HTTP server Express already runs on — Railway
 * exposes one port, so this can't be a separate server/port.
 */

const WebSocket = require('ws');

let wss = null;

function initLiveSocket(httpServer) {
  wss = new WebSocket.Server({ server: httpServer, path: '/live' });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.send(JSON.stringify({ type: 'connected' }));
  });

  // Heartbeat: drop dead connections (network drop, phone locked, etc.)
  // rather than silently accumulating zombie sockets that never receive
  // anything and never get cleaned up.
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));

  console.log('[live-socket] WebSocket server attached at /live');
}

/**
 * Broadcasts a real score/status update to every connected client. Safe
 * to call even if initLiveSocket() hasn't run yet or no clients are
 * connected — just a no-op in that case, never throws.
 */
function broadcastScoreUpdate(matchData) {
  if (!wss) return;
  const payload = JSON.stringify({ type: 'score_update', ...matchData });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

module.exports = { initLiveSocket, broadcastScoreUpdate };
