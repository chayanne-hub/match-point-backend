/**
 * probe-live-odds.js — settle what the tennis socket actually sends.
 *
 * Every previous probe listened for event names we had GUESSED from the
 * docs. If the server uses a different name, that probe reports silence
 * and silence looks identical to "no matches in play". This one uses
 * socket.onAny(), so it captures whatever the server emits regardless of
 * what it is called. If nothing appears here, nothing is being sent.
 *
 * Run from the backend repo root:
 *
 *   $env:TENNIS_API_KEY="<key>"
 *   $env:TENNIS_WS_TOKEN_URL="https://api.sportsapi365.com/v1/tennis/extend/api/socket-creds/ws-token"
 *   node probe-live-odds.js
 *
 * Runs 90s then prints a verdict.
 */

const https = require('https');
const { io } = require('socket.io-client');

const KEY = process.env.TENNIS_API_KEY || '';
const TOKEN_URL = process.env.TENNIS_WS_TOKEN_URL ||
  'https://api.sportsapi365.com/v1/tennis/extend/api/socket-creds/ws-token';
const HOST = process.env.TENNIS_WS_HOST || 'https://live-tennis.sportsapi365.com';
const RUN_MS = Number(process.env.PROBE_MS || 90000);

if (!KEY) { console.error('TENNIS_API_KEY not set'); process.exit(1); }

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'X-Gravitee-Api-Key': KEY } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

const seenEvents = new Map();   // event name -> count
const samples = new Map();      // event name -> first payload
let oddsPayload = null;

function note(name, args) {
  seenEvents.set(name, (seenEvents.get(name) || 0) + 1);
  if (!samples.has(name)) samples.set(name, args[0]);
  const s = JSON.stringify(args[0] || '');
  if (/od1|odds|price/i.test(name) || /od1|bookmaker/i.test(s)) {
    if (!oddsPayload) oddsPayload = { name, payload: args[0] };
  }
}

(async () => {
  // 1. REST: what is actually in play right now? Establishes the baseline —
  //    without it, socket silence is ambiguous.
  console.log('--- REST live events ---');
  let liveIds = [];
  try {
    const r = await get('https://api.sportsapi365.com/v1/tennis/extend/api/events/live');
    let body; try { body = JSON.parse(r.body); } catch { body = null; }
    const rows = (body && (body.result || body.data || body)) || [];
    const arr = Array.isArray(rows) ? rows : [];
    liveIds = arr.filter((e) => e && e.id).map((e) => ({ id: e.id, status: e.status,
      name: `${e.participant1 || e.player1 || '?'} v ${e.participant2 || e.player2 || '?'}` }));
    console.log(`  ${arr.length} row(s); ${liveIds.filter((e) => e.status === 'InPlay').length} InPlay`);
    liveIds.slice(0, 6).forEach((e) => console.log(`   id=${e.id}  ${e.status}  ${e.name}`));
  } catch (e) { console.log('  REST failed:', e.message); }

  // 2. Token
  console.log('\n--- ws token ---');
  const t = await get(TOKEN_URL);
  let token = null;
  try {
    const j = JSON.parse(t.body);
    token = j.token || j.result?.token || j.data?.token || null;
  } catch { /* fallthrough */ }
  console.log('  status', t.status, '| token', token ? 'received' : 'MISSING → ' + t.body.slice(0, 160));
  if (!token) process.exit(1);

  // 3. Connect and capture EVERYTHING
  console.log('\n--- socket ---');
  const socket = io(HOST, { auth: { token }, transports: ['websocket'] });

  const joinedIds = new Set();

  socket.onAny((name, ...args) => {
    note(name, args);

    /* Dump EVERY argument for odds pushes.
     *
     * The payload we captured carries no eventId, so with five matches
     * joined on one socket there is nothing to attribute a price to.
     * But Socket.IO handlers can receive several arguments and the first
     * probe only printed args[0] — the id may simply be in the second.
     * This prints the full argument list so we know which. */
    if (/odds/i.test(name)) {
      console.log(`  <= ${name}: ${args.length} argument(s)`);
      args.forEach((a, i) => console.log(`       arg[${i}]: ${JSON.stringify(a)}`));
      return;
    }

    if (seenEvents.get(name) <= 2) {
      console.log(`  <= ${name}: ${JSON.stringify(args[0] || '').slice(0, 220)}`);
    }

    /* JOIN FROM THE ALL-FEED.
     *
     * The first run joined from REST /extend/api/events/live, which
     * returned 0 rows on a valid key while the socket all-feed was
     * delivering InPlay matches at the same moment. Joining from a
     * source that reports nothing means joining nothing — so the probe
     * could never have seen an odds push regardless of whether odds
     * work. The all-feed is the source with proven data, so joins come
     * from there. */
    if (name === 'live-events-all-update') {
      const rows = Array.isArray(args[0]) ? args[0] : (args[0]?.results || []);
      /* Join exactly ONE match.
       *
       * With five joined, every odds push is ambiguous. With one, any
       * price that arrives can only belong to that match — which tells
       * us whether attribution is possible at all via one socket per
       * event. */
      const limitOne = process.env.PROBE_JOIN_ALL !== 'true';
      for (const ev of rows) {
        if (!ev?.id || ev.status !== 'InPlay' || joinedIds.has(ev.id)) continue;
        if (limitOne && joinedIds.size >= 1) break;
        joinedIds.add(ev.id);
        socket.emit('join-event', ev.id);
        console.log(`  => join-event ${ev.id}  ${ev.name || ''}  (ONLY this one)`);
      }
    }
  });

  socket.on('connect', () => {
    console.log('  connected', socket.id);

    // Try the all-feed in both documented shapes.
    ['join-live-events-all', 'join-all-events', 'join-live-all'].forEach((ev) => {
      socket.emit(ev, 'tennis');
      socket.emit(ev, { sportSlug: 'tennis' });
    });

    // Join the matches REST says are live, in both shapes.
    const inplay = liveIds.filter((e) => e.status === 'InPlay').slice(0, 6);
    inplay.forEach((e) => {
      socket.emit('join-event', e.id);
      socket.emit('join-event', { eventId: e.id });
    });
    console.log(`  emitted joins for ${inplay.length} InPlay event(s)`);
  });

  socket.on('connect_error', (e) => console.log('  connect_error:', e.message));
  socket.on('disconnect', (r) => console.log('  disconnected:', r));

  setTimeout(() => {
    console.log('\n================ VERDICT ================');
    if (!seenEvents.size) {
      console.log('NOTHING received. The connection opened but the server sent no events.');
      console.log('Given REST showed ' + liveIds.filter((e) => e.status === 'InPlay').length +
                  ' InPlay match(es), the subscribe emit is not being accepted.');
      console.log('Next: ask the provider for the exact join payload for your plan.');
    } else {
      console.log('Events received:');
      for (const [n, c] of seenEvents) console.log(`  ${n} x${c}`);
      console.log(`\nJoined ${joinedIds.size} event(s) from the all-feed.`);
      if (oddsPayload) {
        console.log('\nODDS FOUND on event: ' + oddsPayload.name);
        console.log(JSON.stringify(oddsPayload.payload, null, 2).slice(0, 900));
        console.log('\n→ Use this event name and shape in tennisLiveSocket.js.');
      } else {
        console.log('\nScores/updates arrive but NO odds payload appeared.');
        console.log('Live odds may not be included on this plan — worth confirming with them.');
      }
    }
    process.exit(0);
  }, RUN_MS);
})();
