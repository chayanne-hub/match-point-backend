/**
 * tennisLiveRunner.js — keeps tennis live state fed from the socket.
 *
 * This is the piece that makes point-level scores and live odds real. The
 * REST poller runs every few minutes, which is fine for sets but useless
 * for points: a "30-15" that is eight minutes old looks live and isn't.
 * The socket pushes on every point, so the board can show the score within
 * the current game honestly.
 *
 * How it works:
 *   1. Subscribe to the all-live feed to learn what is in play.
 *   2. Join each in-play match individually — that is the only way to get
 *      odds-update, which the all-feed does not carry.
 *   3. Write points, server, serve stats and live price onto the Match row,
 *      stamped with liveStateAt so the frontend can refuse to show a stale
 *      point score.
 *   4. Leave events once they finish, so we aren't subscribed to dead
 *      matches for the rest of the day.
 */

const live = require('./tennisLiveSocket.js');
const { fetchLiveEvents } = require('./fetchTennisApi.js');
const { namesLikelyMatch } = require('./fetchEspn.js');
const db = require('../lib/db.js');

const ENABLED = process.env.TENNIS_SOCKET_ENABLED !== 'false';

// eventId -> { unsubscribe, matchId }
const joined = new Map();
// eventIds already reported as unmatchable, so the warning fires once each.
const warnedNoMatch = new Set();
let allUnsub = null;
let discoveryTimer = null;
let started = false;

/** Find the Match row for a live event, by name. Ids don't cross over
 *  between providers, so names are the only join key available. */
async function findMatch(ev) {
  const sport = await db.sport.findFirst({ where: { slug: 'tennis' } });
  if (!sport) return null;

  const since = new Date(Date.now() - 8 * 60 * 60 * 1000);
  const until = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const candidates = await db.match.findMany({
    where: { sportId: sport.id, startTime: { gte: since, lte: until }, status: { not: 'final' } },
  });

  const a = ev.participant1 || ev.player1?.name;
  const b = ev.participant2 || ev.player2?.name;
  if (!a || !b) return null;

  for (const m of candidates) {
    const direct = namesLikelyMatch(m.competitorA, a) && namesLikelyMatch(m.competitorB, b);
    const cross = namesLikelyMatch(m.competitorA, b) && namesLikelyMatch(m.competitorB, a);
    if (direct || cross) return { match: m, flipped: !direct && cross };
  }
  return null;
}

/** Points arrive as "30-15" in player1-player2 order, and indicator "1,0"
 *  marks the server. If our row lists the players the other way round,
 *  both have to be inverted or every serve reading lands on the wrong
 *  player — a silent error that would point break alerts at the innocent
 *  side. */
function orientPointState(ev, flipped) {
  const pts = String(ev.points || '').split('-').map((s) => s.trim());
  const ind = String(ev.indicator || '').split(',');
  let serving = ind[0] === '1' ? 'A' : ind[1] === '1' ? 'B' : null;
  let [p1, p2] = pts;

  if (flipped) {
    [p1, p2] = [p2, p1];
    serving = serving === 'A' ? 'B' : serving === 'B' ? 'A' : null;
  }
  return { points: p1 && p2 ? `${p1}-${p2}` : null, serving };
}

async function writeScore(ev, target) {
  const { match, flipped } = target;
  const { points, serving } = orientPointState(ev, flipped);

  const data = {
    liveStateAt: new Date(),
    status: ev.status === 'InPlay' ? 'live' : match.status,
  };
  if (points) data.livePoints = points;
  if (serving) data.liveServing = serving;
  if (ev.score) { data.setScore = ev.score; data.liveScore = ev.score; }

  await db.match.update({ where: { id: match.id }, data });
}

async function writeEventDetail(payload, target) {
  const parsed = live.parseEventUpdate(payload);
  if (!parsed) return;
  const { match, flipped } = target;
  const s = parsed.stats || {};

  const a = flipped ? s.firstServeWonB : s.firstServeWonA;
  const b = flipped ? s.firstServeWonA : s.firstServeWonB;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return;

  await db.match.update({
    where: { id: match.id },
    data: { firstServeWonA: a, firstServeWonB: b, liveStateAt: new Date() },
  });
}

async function writeOdds(payload, target) {
  const parsed = live.parseOddsUpdate(payload);
  if (!parsed) return;

  // A decided match prices at 1.001 / 101. Arithmetically fine, not a
  // bettable number, and it would poison any average or alert it fed.
  if (parsed.extreme) return;

  const { match, flipped } = target;
  await db.match.update({
    where: { id: match.id },
    data: {
      liveOddsA: flipped ? parsed.oddsB : parsed.oddsA,
      liveOddsB: flipped ? parsed.oddsA : parsed.oddsB,
      liveOddsBook: parsed.bookmakerA || null,
      liveStateAt: new Date(),
    },
  });
}

/** Join one live event for score + odds pushes. */
async function joinEvent(ev) {
  if (joined.has(ev.id)) return;

  const target = await findMatch(ev);
  if (!target) {
    /* Was a bare `return`. A live match we cannot name-match produced no
     * output at all, so "the socket is delivering but nothing reaches the
     * board" and "the socket is dead" looked identical from the logs.
     * Throttled to once per event so a busy slate can't flood. */
    if (!warnedNoMatch.has(ev.id)) {
      warnedNoMatch.add(ev.id);
      console.warn(`[tennisLive] in play but not on our board: ${ev.participant1 || '?'} vs ${ev.participant2 || '?'}`);
    }
    return;
  }

  const unsubscribe = await live.subscribeEvent(ev.id, {
    onScore: (payload) => {
      writeEventDetail(payload, target).catch((e) => console.error(`[tennisLive] detail write: ${e.message}`));
    },
    onOdds: (payload) => {
      /* Joining a match and RECEIVING PRICES for it are different things,
       * and the difference is the whole question of whether this feed
       * works. Logging the first push per match makes that visible
       * without spamming every point. */
      const entry = joined.get(ev.id);
      if (entry && entry.odds === 0) {
        entry.odds = 1;
        console.log(`[tennisLive] first odds push for ${ev.participant1} vs ${ev.participant2}`);
      } else if (entry) {
        entry.odds++;
      }
      writeOdds(payload, target).catch((e) => console.error(`[tennisLive] odds write: ${e.message}`));
    },
  });

  joined.set(ev.id, { unsubscribe, matchId: target.match.id, odds: 0 });
  console.log(`[tennisLive] joined ${ev.participant1} vs ${ev.participant2} (${ev.league})`);
}

function leaveEvent(eventId) {
  const entry = joined.get(eventId);
  if (!entry) return;
  try { entry.unsubscribe(); } catch { /* socket already gone */ }
  joined.delete(eventId);
}

/**
 * Start the runner. Safe to call on boot even if the socket is
 * unreachable — every failure path logs and returns rather than throwing,
 * because a live feed must never be able to stop the server starting.
 */
async function startTennisLive() {
  if (!ENABLED || started) return;
  started = true;

  /* DISCOVERY IS REST, SUBSCRIPTION IS SOCKET.
   *
   * This previously discovered in-play matches via subscribeAllLive(),
   * which emits `join-live-events-all`. probe-socket.js tried that shape
   * twice (emits 1 and 2 of 8) and got NOTHING back; the only emit that
   * produced a response was `join-event` with a bare id (emit 3).
   *
   * So the runner's whole discovery path depended on the one subscription
   * that does not answer. The socket connected, authenticated, and then
   * waited forever for a feed that was never coming — which meant
   * joinEvent() never ran, and `join-event`, the thing that DOES work,
   * was never called for any match.
   *
   * REST /extend/api/events/live is confirmed working — applyTennisLiveState
   * has been using it all along. So: poll REST to learn what is in play,
   * then join those events over the socket for the per-point odds pushes
   * that REST cannot give. Each transport does the job it is good at. */
  const DISCOVERY_MS = Number(process.env.TENNIS_DISCOVERY_MS) || 60000;

  async function discover() {
    let events;
    try {
      events = await fetchLiveEvents();
    } catch (err) {
      console.warn(`[tennisLive] discovery poll failed: ${err.message}`);
      return;
    }

    const seen = new Set();
    for (const ev of events) {
      // parseLiveEvent normalises to liveId/competitorA/competitorB; the
      // socket wants the raw event id and the runner's helpers read
      // participant1/participant2, so present both shapes.
      const id = ev.liveId;
      if (!id) continue;
      seen.add(id);

      const shaped = {
        id,
        participant1: ev.competitorA,
        participant2: ev.competitorB,
        league: ev.league,
        status: ev.status,
        score: ev.setScore,
        points: ev.points,
        indicator: ev.indicator,
      };

      // Cheap write first, so the board stays current even for matches we
      // never manage to join.
      const target = await findMatch(shaped).catch(() => null);
      if (target) await writeScore(shaped, target).catch((e) => console.error(`[tennisLive] score write: ${e.message}`));

      if (ev.status === 'InPlay') {
        await joinEvent(shaped).catch((e) => console.error(`[tennisLive] join: ${e.message}`));
      }
    }

    for (const id of [...joined.keys()]) {
      if (!seen.has(id)) { leaveEvent(id); console.log(`[tennisLive] left finished event ${id}`); }
    }

    if (events.length) {
      console.log(`[tennisLive] discovery: ${events.length} in play, ${joined.size} joined`);
    }
  }

  try {
    await discover();
    discoveryTimer = setInterval(() => {
      discover().catch((e) => console.error(`[tennisLive] discovery: ${e.message}`));
    }, DISCOVERY_MS);
    console.log(`[tennisLive] runner started (REST discovery every ${DISCOVERY_MS / 1000}s, socket for odds)`);
  } catch (err) {
    started = false;
    console.error(`[tennisLive] failed to start: ${err.message}`);
  }
}

async function stopTennisLive() {
  if (discoveryTimer) { clearInterval(discoveryTimer); discoveryTimer = null; }
  for (const id of [...joined.keys()]) leaveEvent(id);
  if (allUnsub) { try { allUnsub(); } catch { /* noop */ } allUnsub = null; }
  await live.disconnect();
  started = false;
}

module.exports = { startTennisLive, stopTennisLive, orientPointState, joined };
