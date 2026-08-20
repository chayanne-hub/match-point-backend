/**
 * probe-socket.js — v2 diagnostic.
 *
 * v1 connected but received nothing while 8 matches were in play, so the
 * subscribe emit is the suspect, not the slate. This version uses onAny()
 * to log EVERY event the server sends regardless of name, and tries each
 * documented emit shape one at a time with a gap between them — so the
 * reply can be attributed to a specific shape rather than guessed at.
 *
 * Run:  node probe-socket.js
 */
const { io } = require('socket.io-client');

const KEY = process.env.TENNIS_API_KEY;
const TOKEN_URL = process.env.TENNIS_WS_TOKEN_URL ||
  'https://api.sportsapi365.com/v1/tennis/extend/api/socket-creds/ws-token';
const HOST = process.env.TENNIS_WS_HOST || 'https://live-tennis.sportsapi365.com';

// A match confirmed InPlay from the REST live feed.
const EVENT_ID = process.env.PROBE_EVENT_ID || '3842034';        // De Jong v Budkov Kjaer
const MATCH_ID = process.env.PROBE_MATCH_ID || '59166-104215-21932-5';

(async () => {
  if (!KEY) { console.error('TENNIS_API_KEY not set'); process.exit(1); }

  const res = await fetch(TOKEN_URL, { headers: { 'X-Gravitee-Api-Key': KEY } });
  const body = await res.json();
  if (!body?.token) { console.error('no token:', JSON.stringify(body).slice(0, 200)); process.exit(1); }
  console.log('token OK\n');

  const socket = io(HOST, { auth: { token: body.token }, transports: ['websocket'], reconnection: false });

  // The important part: log everything, whatever it is called.
  socket.onAny((event, ...args) => {
    const dump = JSON.stringify(args).slice(0, 1500);
    console.log(`\n<<< EVENT "${event}"\n${dump}\n`);
  });

  socket.on('connect', () => {
    console.log('connected — trying subscribe shapes one at a time\n');

    const attempts = [
      ['join-live-events-all', 'tennis'],
      ['join-live-events-all', { sportSlug: 'tennis' }],
      ['join-event', Number(EVENT_ID)],
      ['join-event', { eventId: Number(EVENT_ID) }],
      ['join-event', String(EVENT_ID)],
      ['join-event', { eventId: String(EVENT_ID) }],
      ['join-event', { matchId: MATCH_ID }],
      ['join-event', MATCH_ID],
    ];

    attempts.forEach(([evt, payload], i) => {
      setTimeout(() => {
        console.log(`--> emit ${i + 1}/${attempts.length}: ${evt}  ${JSON.stringify(payload)}`);
        // An ack callback, in case the server answers that way rather than
        // by broadcasting a named event.
        socket.emit(evt, payload, (ack) => {
          if (ack !== undefined) console.log(`    ACK: ${JSON.stringify(ack).slice(0, 400)}`);
        });
      }, i * 3000);
    });
  });

  socket.on('connect_error', (e) => console.error('connect_error:', e?.message || e));
  socket.on('disconnect', (r) => console.log('disconnected:', r));

  setTimeout(() => {
    console.log('\n--- 75s elapsed, closing ---');
    socket.close();
    setTimeout(() => process.exit(0), 300);
  }, 75000);
})();
