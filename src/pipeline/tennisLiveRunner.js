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
const { namesLikelyMatch } = require('./fetchEspn.js');
const { parseLiveEvent } = require('./fetchTennisApi.js');
const db = require('../lib/db.js');
const { broadcastScoreUpdate } = require('../lib/liveSocket.js');

const ENABLED = process.env.TENNIS_SOCKET_ENABLED !== 'false';

// eventId -> { unsubscribe, matchId }
const joined = new Map();

/* LIVE SNAPSHOT.
 *
 * The ingest used to ask REST (`extend/api/events/live`) which matches
 * were in play. On a valid key that endpoint returns 0 rows while the
 * socket all-feed reports InPlay matches at the same moment — verified
 * with a probe. An empty answer there means nothing is ever promoted to
 * live and nothing is ever closed out, so tennis rows sit unchanged on
 * the board. That is the same silence that made live odds look broken.
 *
 * The all-feed has the data, so we keep its latest state here and let
 * the ingest read it instead. */
let liveSnapshot = [];
let liveSnapshotAt = 0;
let pushCount = 0;
let lastPushLog = 0;

/* Watchdog: if the feed goes silent the board freezes with no error
 * anywhere, because a socket that stops pushing still looks connected.
 * This is the only thing that turns that silence into a log line. */
setInterval(() => {
  if (!liveSnapshotAt) return;
  const age = Math.round((Date.now() - liveSnapshotAt) / 1000);
  if (age > 180) console.warn(`[tennisLive] NO feed update for ${age}s — board will be stale`);
}, 60000).unref?.();

function getLiveSnapshot() {
  // Stale snapshot is worse than none: it would keep finished matches
  // looking live. Two minutes without a push means we don't know.
  if (!liveSnapshotAt || Date.now() - liveSnapshotAt > 120000) return [];
  return liveSnapshot;
}

let allUnsub = null;
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

  /* PUSH TO THE BROWSER, don't wait for the poll.
   *
   * This wrote to the database and stopped. The board's own refresh is
   * 20 seconds, so a point that turned over three times between polls
   * showed as one stale value — which is exactly what "frozen" looks
   * like from the outside, even though the data was arriving fine.
   *
   * The browser socket already exists and the terminal already listens
   * for `score_update` and applies livePoints / liveServing / odds. The
   * only missing piece was anything calling it for tennis.
   *
   * Matched on sport + matchup because that is what the client keys on;
   * the id it holds is the PICK id, not the match id. Best-effort: a
   * broadcast failure must never break the DB write above. */
  try {
    broadcastScoreUpdate({
      sport: 'tennis',
      matchup: `${match.competitorA} vs ${match.competitorB}`,
      matchStatus: data.status,
      liveScore: data.liveScore ?? match.liveScore ?? null,
      setScore: data.setScore ?? match.setScore ?? null,
      livePoints: data.livePoints,
      liveServing: data.liveServing,
      liveStateAt: data.liveStateAt,
    });
  } catch (e) {
    console.error(`[tennisLive] broadcast: ${e.message}`);
  }
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

  /* Push the price too, not just the score.
   *
   * The broadcast was added to writeScore only, so a live price reached
   * the database and then waited up to 20 seconds for the next poll to
   * carry it — and the board's merge would keep the OLD value in the
   * meantime. The price is the number people act on; it should be the
   * least delayed thing on the row, not the most. */
  const oddsA = flipped ? parsed.oddsB : parsed.oddsA;
  const oddsB = flipped ? parsed.oddsA : parsed.oddsB;
  try {
    broadcastScoreUpdate({
      sport: 'tennis',
      matchup: `${match.competitorA} vs ${match.competitorB}`,
      matchStatus: 'live',
      liveOddsA: oddsA,
      liveOddsB: oddsB,
      liveStateAt: new Date(),
    });
  } catch (e) {
    console.error(`[tennisLive] odds broadcast: ${e.message}`);
  }
}

/** Join one live event for score + odds pushes. */
async function joinEvent(ev) {
  if (joined.has(ev.id)) return;

  const target = await findMatch(ev);
  if (!target) return; // in play, but not a match we hold a pick on

  const unsubscribe = await live.subscribeEvent(ev.id, {
    onScore: (payload) => {
      writeEventDetail(payload, target).catch((e) => console.error(`[tennisLive] detail write: ${e.message}`));
    },
    onOdds: (payload) => {
      writeOdds(payload, target).catch((e) => console.error(`[tennisLive] odds write: ${e.message}`));
    },
  });

  joined.set(ev.id, { unsubscribe, matchId: target.match.id });
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

  try {
    allUnsub = await live.subscribeAllLive(async (rows) => {
      const seen = new Set();

      // Record what the feed says before doing anything with it.
      try {
        liveSnapshot = rows.map(parseLiveEvent).filter(Boolean);
        liveSnapshotAt = Date.now();
      } catch (e) {
        console.error(`[tennisLive] snapshot: ${e.message}`);
      }

      /* Instrumented because "frozen" is ambiguous from the outside.
       *
       * A board that stops updating looks the same whether the feed has
       * gone quiet or whether pushes arrive fine but none of them match
       * a row we hold. Those need opposite fixes, so the log now
       * distinguishes them: pushes counts arrivals, matched counts how
       * many found one of our rows. Silence in this line means the feed
       * stopped; matched=0 with a healthy count means name matching. */
      let matched = 0, inPlay = 0;

      for (const ev of rows) {
        if (!ev?.id) continue;
        seen.add(ev.id);

        // Cheap write first: the all-feed carries points for every match,
        // so the board stays current even for matches we haven't joined.
        const target = await findMatch(ev).catch(() => null);
        if (target) {
          matched++;
          await writeScore(ev, target).catch((e) => console.error(`[tennisLive] score write: ${e.message}`));
        }

        if (ev.status === 'InPlay') {
          inPlay++;
          await joinEvent(ev).catch((e) => console.error(`[tennisLive] join: ${e.message}`));
        }
      }

      pushCount++;
      const now = Date.now();
      if (now - lastPushLog > 60000) {   // once a minute, not per push
        console.log(`[tennisLive] feed: ${pushCount} push(es) in the last minute, ` +
          `${rows.length} event(s), ${inPlay} in play, ${matched} matched to our board, ` +
          `${joined.size} joined`);
        pushCount = 0;
        lastPushLog = now;
      }

      // Anything we're joined to that's no longer in the feed has finished.
      for (const id of [...joined.keys()]) {
        if (!seen.has(id)) { leaveEvent(id); console.log(`[tennisLive] left finished event ${id}`); }
      }
    });

    console.log('[tennisLive] runner started');
  } catch (err) {
    started = false;
    console.error(`[tennisLive] failed to start: ${err.message}`);
  }

  /* NOTE — REST discovery was added here and then removed.
   *
   * The reasoning was that the socket all-feed was unproven while
   * /extend/api/events/live was confirmed working, so discovery should
   * not depend on the socket. The probe showed the exact opposite: on a
   * valid key REST returned 0 rows while the all-feed was delivering
   * InPlay matches in the same second. Polling REST would have found
   * nothing forever, on a schedule, while looking like a safety net.
   *
   * The all-feed is the working source and stays the only one. */
}

async function stopTennisLive() {
  for (const id of [...joined.keys()]) leaveEvent(id);
  if (allUnsub) { try { allUnsub(); } catch { /* noop */ } allUnsub = null; }
  await live.disconnect();
  started = false;
}

module.exports = { startTennisLive, stopTennisLive, orientPointState, joined, getLiveSnapshot };
