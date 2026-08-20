/**
 * tennisLiveSocket.js — SportsAPI365 live tennis socket (Node/backend).
 *
 * This is where the odds actually live. Every REST odds path returned
 * "No odds found for this match" — including main-tour Cincinnati — because
 * live prices are PUSHED over Socket.IO rather than served over REST. The
 * REST route exists and validates ids; it just isn't the odds source.
 *
 * Included on Mega and above. Not available on Ultra.
 *
 * Two subscription modes:
 *   - join-live-events-all : one feed of every in-play match for the sport
 *   - join-event           : per-match score AND odds updates
 *
 * The all-matches feed carries scores only, so anything needing prices has
 * to join per event. We therefore join the all-feed to discover what is in
 * play, then join individual events for the matches we hold picks on.
 */

const TOKEN_URL = process.env.TENNIS_WS_TOKEN_URL ||
  'https://api.sportsapi365.com/v1/tennis/v1/tennis/extend/api/socket-creds/ws-token';
const SOCKET_HOST = process.env.TENNIS_WS_HOST || 'https://live-tennis.sportsapi365.com';
const KEY = process.env.TENNIS_API_KEY || '';

let io = null;
try {
  ({ io } = require('socket.io-client'));
} catch {
  // Dependency missing: the caller degrades to REST rather than crashing
  // the whole pipeline on boot.
  console.warn('[tennisLive] socket.io-client not installed — live socket disabled');
}

async function getWsToken() {
  if (!KEY) throw new Error('TENNIS_API_KEY is not set');
  const res = await fetch(TOKEN_URL, {
    method: 'GET',
    headers: { 'X-Gravitee-Api-Key': KEY, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`[tennisLive] token request failed: ${res.status}`);
  const body = await res.json();
  const token = body?.token;
  if (!token) throw new Error('[tennisLive] token missing from response');
  return token;
}

let socketPromise = null;
let refreshing = false;

/** Single shared connection. A second caller reuses the first's promise
 *  rather than opening a duplicate socket. */
async function connect() {
  if (!io) return null;
  if (socketPromise) return socketPromise;

  socketPromise = (async () => {
    const token = await getWsToken();
    const socket = io(SOCKET_HOST, {
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30000,
    });

    socket.on('connect', () => console.log('[tennisLive] connected'));

    socket.on('disconnect', (reason) => {
      console.warn(`[tennisLive] disconnected: ${reason}`);
      // Drop the cached promise so the next call reconnects with a fresh
      // token rather than reusing a dead socket.
      socketPromise = null;
    });

    socket.on('connect_error', async (err) => {
      const msg = err?.message || String(err);
      if (msg === 'TOKEN_EXPIRED' && !refreshing) {
        try {
          refreshing = true;
          console.log('[tennisLive] token expired, refreshing');
          socket.auth = { token: await getWsToken() };
          socket.connect();
        } catch (e) {
          console.error(`[tennisLive] token refresh failed: ${e.message}`);
        } finally {
          refreshing = false;
        }
      } else {
        console.error(`[tennisLive] connect error: ${msg}`);
      }
    });

    return socket;
  })().catch((err) => {
    socketPromise = null;
    throw err;
  });

  return socketPromise;
}

/**
 * Their own docs disagree with their sample code on the emit payload: the
 * events table says `eventId: number`, the React example sends
 * `{ eventId: 123456 }`. Sending both shapes costs nothing and means we
 * don't silently subscribe to nothing if we picked the wrong one.
 */
function emitBoth(socket, event, key, value) {
  // The probe settled this: a BARE value on join-event is what the server
  // answers (emit 3 of 8 produced both odds-update and event-update; the
  // object forms that follow it produced nothing new). Their React sample
  // sends `{ eventId }`, which appears to be wrong. Both are still sent —
  // it costs one frame and protects against them changing their mind.
  socket.emit(event, value);
  socket.emit(event, { [key]: value });
}

/**
 * Subscribe to every in-play tennis match. onUpdate receives the full
 * updated list each time — the feed sends state, not diffs.
 */
async function subscribeAllLive(onUpdate) {
  const socket = await connect();
  if (!socket) return () => {};

  const handler = (payload) => {
    const rows = Array.isArray(payload) ? payload : (payload?.results || []);
    try { onUpdate(rows); } catch (e) { console.error(`[tennisLive] handler threw: ${e.message}`); }
  };

  socket.on('live-events-all-update', handler);
  emitBoth(socket, 'join-live-events-all', 'sportSlug', 'tennis');

  return () => {
    socket.off('live-events-all-update', handler);
    emitBoth(socket, 'leave-live-events-all', 'sportSlug', 'tennis');
  };
}

/**
 * Subscribe to one match for BOTH score and odds. Only join while the
 * match is actually InPlay — their docs are explicit about that, and
 * joining finished events wastes the connection.
 *
 * Returns an unsubscribe function; always call it on cleanup or the
 * server keeps streaming a match nobody is watching.
 */
async function subscribeEvent(eventId, { onScore, onOdds } = {}) {
  const socket = await connect();
  if (!socket) return () => {};

  const scoreHandler = (data) => {
    if (!onScore) return;
    try { onScore(data); } catch (e) { console.error(`[tennisLive] score handler: ${e.message}`); }
  };
  const oddsHandler = (data) => {
    if (!onOdds) return;
    try { onOdds(data); } catch (e) { console.error(`[tennisLive] odds handler: ${e.message}`); }
  };

  socket.on('event-update', scoreHandler);
  socket.on('odds-update', oddsHandler);
  emitBoth(socket, 'join-event', 'eventId', eventId);

  return () => {
    socket.off('event-update', scoreHandler);
    socket.off('odds-update', oddsHandler);
    emitBoth(socket, 'leave-event', 'eventId', eventId);
  };
}

/** Decimal to American, so socket prices match the rest of the pipeline. */
function decimalToAmerican(dec) {
  const d = Number(dec);
  if (!Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

/**
 * Parse an odds-update payload. Confirmed shape, captured live:
 *
 *   { results: { "Full Time Result": {
 *       od1: "1.001", od1Bookmaker: "Bet365",
 *       od2: "101",   od2Bookmaker: "Bet365",
 *       odx: "0",     odxBookmaker: "Bet365",
 *       line: null, updatedAt: 1787248114 } } }
 *
 * Markets are keyed by NAME, not by the numeric id from markets/all. od1
 * and od2 are DECIMAL prices as strings for player 1 and player 2; odx is
 * the draw and is always "0" in tennis.
 */
function parseOddsUpdate(payload) {
  const results = payload?.results || payload;
  if (!results || typeof results !== 'object') return null;

  const market = results['Full Time Result'] || results['Match Winner'] || results['Moneyline'];
  if (!market) return null;

  const dec1 = Number(market.od1);
  const dec2 = Number(market.od2);
  if (!Number.isFinite(dec1) || !Number.isFinite(dec2) || dec1 <= 1 || dec2 <= 1) return null;

  const oddsA = decimalToAmerican(dec1);
  const oddsB = decimalToAmerican(dec2);

  // A decimal of 1.001 converts to -100000. That is arithmetically right
  // for a match already effectively decided, but it is not a price anyone
  // can bet and it would wreck any average it entered. Flagged rather than
  // dropped, so the caller decides.
  const extreme = dec1 <= 1.02 || dec2 <= 1.02 || dec1 >= 50 || dec2 >= 50;

  return {
    oddsA,
    oddsB,
    decimalA: dec1,
    decimalB: dec2,
    bookmakerA: market.od1Bookmaker || null,
    bookmakerB: market.od2Bookmaker || null,
    extreme,
    updatedAt: market.updatedAt ? new Date(market.updatedAt * 1000) : new Date(),
  };
}

/**
 * Parse an event-update payload — the richest thing this feed gives us.
 *
 *   timeline: [{ id, text: "Game 8 - Jesper De Jong - breaks to 30" }, ...]
 *   stats: { aces: ["3","4"], double_faults: ["3","1"],
 *            win_1st_serve: ["81","56"], break_point_conversions: ["50","0"] }
 *
 * The timeline states breaks EXPLICITLY. Until now the DIP alert inferred
 * a break from a two-game lead, which is a guess; this is the fact. And
 * win_1st_serve is the serve-quality signal that ESPN's feed never carried.
 */
function parseEventUpdate(payload) {
  if (!payload) return null;

  const timeline = Array.isArray(payload.timeline) ? payload.timeline : [];
  const games = timeline.map((t) => {
    const text = String(t?.text || '');
    // "Game 8 - Jesper De Jong - breaks to 30"
    const m = text.match(/^Game\s+(\d+)\s*-\s*(.+?)\s*-\s*(breaks|holds)\s+to\s+(\w+)$/i);
    if (!m) return { raw: text };
    return {
      game: Number(m[1]),
      player: m[2].trim(),
      broke: m[3].toLowerCase() === 'breaks',
      to: m[4].toLowerCase(),
      raw: text,
    };
  });

  const breaks = games.filter((g) => g.broke);
  const st = payload.stats || {};
  const pair = (arr) => (Array.isArray(arr) && arr.length >= 2
    ? [Number(arr[0]), Number(arr[1])].map((n) => (Number.isFinite(n) ? n : null))
    : [null, null]);

  const [acesA, acesB] = pair(st.aces);
  const [dfA, dfB] = pair(st.double_faults);
  const [srvA, srvB] = pair(st.win_1st_serve);
  const [bpA, bpB] = pair(st.break_point_conversions);

  return {
    eventId: payload.eventId || payload.id || null,
    status: payload.status || null,
    competitorA: payload.participant1 || payload.player1?.name || null,
    competitorB: payload.participant2 || payload.player2?.name || null,
    games,
    breaks,
    lastGame: games[games.length - 1] || null,
    // Who was broken most recently, and by implication who is in trouble.
    lastBreakBy: breaks.length ? breaks[breaks.length - 1].player : null,
    stats: {
      acesA, acesB,
      doubleFaultsA: dfA, doubleFaultsB: dfB,
      firstServeWonA: srvA, firstServeWonB: srvB,
      breakPointConversionA: bpA, breakPointConversionB: bpB,
    },
  };
}

/**
 * Serve collapse: a player's first-serve win rate falling well below their
 * opponent's is the physical tell behind most in-match reversals — the
 * thing that shows up before the scoreline moves.
 */
function serveWarning(parsed, { gap = 20 } = {}) {
  const { firstServeWonA: a, firstServeWonB: b } = parsed?.stats || {};
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a - b >= gap) return { struggling: 'B', a, b };
  if (b - a >= gap) return { struggling: 'A', a, b };
  return null;
}

async function disconnect() {
  if (!socketPromise) return;
  try {
    const socket = await socketPromise;
    socket.close();
  } catch { /* already gone */ }
  socketPromise = null;
}

module.exports = {
  connect,
  parseEventUpdate,
  serveWarning,
  subscribeAllLive,
  subscribeEvent,
  parseOddsUpdate,
  decimalToAmerican,
  disconnect,
  getWsToken,
};
