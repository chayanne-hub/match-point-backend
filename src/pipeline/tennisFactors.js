/**
 * tennisFactors.js — structured inputs for the tennis factor list.
 *
 * Five of the twelve weighted factors — H2H (10), Surface Fit (16),
 * Venue History (5), Recent Form (14), Elo/Ranking (10) — were sourced by
 * web search: slow, inconsistent between matches, and occasionally wrong.
 * That inconsistency also broke the weight learning, which needs the same
 * quality of input every time to measure which factors actually predict.
 *
 * Every parser below is written against a captured response, not a guess.
 * Shapes are documented inline so a future change is caught by reading
 * rather than by a silent null.
 */

const { apiGet, fetchPlayerStatus } = require('./fetchTennisApi.js');

/** Court ids seen in surface-summary. 1 = Hard is the common case. */
const COURTS = { 1: 'Hard', 2: 'Clay', 3: 'Indoor Hard', 5: 'Grass' };

/** Every fetch is best-effort: a missing factor must degrade to "No data"
 *  rather than fail the whole analysis. A match analysed on eleven
 *  factors is far better than one not analysed at all. */
async function safe(fn) {
  try { return await fn(); } catch { return null; }
}

/**
 * HEAD TO HEAD.  /h2h/stats/{type}/{p1}/{p2}
 *   { matchesCount, player1:{ name, matchesWon, acesCount,
 *     doubleFaultsCount, firstServePercentage,
 *     winningOnFirstServePercentage, winningOnSecondServePercentage },
 *     player2:{...}, surfaceData:{ hard1, clay1, grass1, iHard1,
 *     hard2, clay2, grass2, iHard2, total1, total2 } }
 *
 * The `1`/`2` suffix means player1/player2, not win/loss.
 */
async function fetchH2H(tour, name1, name2) {
  const body = await safe(() => apiGet(`h2h/stats/${tour}/${encodeURIComponent(name1)}/${encodeURIComponent(name2)}`));

  /* FALL BACK TO THE PROFILE WHEN THERE ARE NO STATS.
   *
   * h2h/stats returns 404 "No stats" for pairs that HAVE met but whose
   * meetings carry no aggregated stat record — common below Challenger
   * level, where point-by-point data is not collected. That is a
   * different answer from "No such player", and treating both as "no
   * head to head" threw away a real meeting: a match card read "no prior
   * meetings found" for two players who had in fact played.
   *
   * h2h/profile carries the record itself (surfaceData totals) without
   * requiring the stat rows, so it answers "have they met, and who won"
   * even when the serve splits are unavailable. */
  if (!body || typeof body.matchesCount !== 'number') {
    const prof = await safe(() => apiGet(`h2h/profile/${tour}/${encodeURIComponent(name1)}/${encodeURIComponent(name2)}/false`));
    const sdp = prof?.surfaceData;
    if (!sdp) return null;

    const a = Number(sdp.total1), b = Number(sdp.total2);
    if (!Number.isFinite(a) || !Number.isFinite(b) || (a + b) === 0) return null;

    // Record only — no serve splits exist for these meetings, and an
    // absent line is better than a fabricated one.
    return {
      meetings: a + b,
      wonA: a,
      wonB: b,
      serveA: null,
      serveB: null,
      bySurface: {
        hard:   [Number(sdp.hard1)  || 0, Number(sdp.hard2)  || 0],
        clay:   [Number(sdp.clay1)  || 0, Number(sdp.clay2)  || 0],
        grass:  [Number(sdp.grass1) || 0, Number(sdp.grass2) || 0],
      },
      statsAvailable: false,
    };
  }

  const p1 = body.player1 || {}, p2 = body.player2 || {}, sd = body.surfaceData || {};
  return {
    meetings: body.matchesCount,
    wonA: p1.matchesWon ?? null,
    wonB: p2.matchesWon ?? null,
    serveA: {
      firstServePct: p1.firstServePercentage ?? null,
      wonFirstPct: p1.winningOnFirstServePercentage ?? null,
      wonSecondPct: p1.winningOnSecondServePercentage ?? null,
      aces: p1.acesCount ?? null,
      doubleFaults: p1.doubleFaultsCount ?? null,
    },
    serveB: {
      firstServePct: p2.firstServePercentage ?? null,
      wonFirstPct: p2.winningOnFirstServePercentage ?? null,
      wonSecondPct: p2.winningOnSecondServePercentage ?? null,
      aces: p2.acesCount ?? null,
      doubleFaults: p2.doubleFaultsCount ?? null,
    },
    bySurface: {
      hard: [sd.hard1 ?? 0, sd.hard2 ?? 0],
      indoorHard: [sd.iHard1 ?? 0, sd.iHard2 ?? 0],
      clay: [sd.clay1 ?? 0, sd.clay2 ?? 0],
      grass: [sd.grass1 ?? 0, sd.grass2 ?? 0],
    },
  };
}

/**
 * CAREER SURFACE RECORD.  /h2h/surfaceBreakdown/{type}/{player}
 *   { hard1, iHard1, clay1, grass1, hard2, iHard2, clay2, grass2,
 *     total1, total2 }
 * Here `1` = wins and `2` = losses — the opposite meaning to the same
 * suffix in h2h/stats above. Worth stating plainly because getting it
 * backwards would invert the single heaviest factor (Surface Fit, 16).
 */
async function fetchSurfaceRecord(tour, name) {
  const b = await safe(() => apiGet(`h2h/surfaceBreakdown/${tour}/${encodeURIComponent(name)}`));
  if (!b || typeof b.total1 !== 'number') return null;
  const pct = (w, l) => (w + l > 0 ? Math.round((w / (w + l)) * 100) : null);
  return {
    career: [b.total1, b.total2],
    hard: [b.hard1, b.hard2], hardPct: pct(b.hard1, b.hard2),
    indoorHard: [b.iHard1, b.iHard2], indoorHardPct: pct(b.iHard1, b.iHard2),
    clay: [b.clay1, b.clay2], clayPct: pct(b.clay1, b.clay2),
    grass: [b.grass1, b.grass2], grassPct: pct(b.grass1, b.grass2),
  };
}

/**
 * RECENT FORM.  /h2h/recent/{type}/{player}
 *   { name, count, games:[{ id, roundId, result, date, seed1, seed2,
 *     odd1, odd2, player1Id, player2Id, tournamentId }] }
 *
 * Carries the DECIMAL PRICE of each past match, which is unusual and
 * useful: it shows whether recent wins came as favourite or underdog.
 * A 7-3 run of heavy favourites is a different signal from 7-3 including
 * two upsets, and the scoreline alone can't tell them apart.
 */
async function fetchRecentForm(tour, name, playerId) {
  /* Keyed on the player ID, not the name.
   *
   * This endpoint accepts either, but load and travel context request it
   * by id — so calling it by name here missed the shared cache and fired
   * a second identical request per player. The id is also the safer key:
   * names differ in accents and word order between feeds, which is what
   * broke matching elsewhere.
   *
   * Falls back to the name when no id is stored (older rows). */
  const b = playerId
    ? await fetchRecentCached(tour, playerId)
    : await safe(() => apiGet(`h2h/recent/${tour}/${encodeURIComponent(name)}`));
  const games = Array.isArray(b?.games) ? b.games : null;
  if (!games || !games.length) return null;

  let wins = 0, losses = 0, asDogWins = 0;
  const recent = games.slice(0, 10).map((g) => {
    const isP1 = String(g.player1Id) === String(playerId);

    /* USE `isWin`, THE FIELD THE API PROVIDES.
     *
     * This re-derived the result by counting sets and orienting on
     * `player1Id === playerId`. When that id comparison failed — a null
     * id, a string/number mismatch — every match was read from the wrong
     * side, and the player came back 0-10. Both sides of a match showing
     * 0-10 is what the analyst spotted and correctly called placeholder
     * data, then discounted our brief in favour of web search.
     *
     * `isWin` is supplied relative to the QUERIED player and needs no
     * orientation at all. It was verified directly against a known
     * result (Hurkacz beat Safiullin 6-4 6-3; the feed returns
     * isWin:false on Safiullin's own list).
     *
     * Set counting stays only as a fallback for entries lacking the
     * field, and is skipped entirely when we have no id to orient with —
     * guessing an orientation is what produced the fake 0-10. */
    let won;
    if (typeof g.isWin === 'boolean') {
      won = g.isWin;
    } else if (playerId && (String(g.player1Id) === String(playerId) || String(g.player2Id) === String(playerId))) {
      const sets = String(g.result || '').replace(/\([^)]*\)/g, '').trim().split(/[,\s]+/);
      let setsP1 = 0, setsP2 = 0;
      for (const sc of sets) {
        const [a, b2] = sc.split('-').map((n) => parseInt(n, 10));
        if (Number.isFinite(a) && Number.isFinite(b2)) { if (a > b2) setsP1++; else setsP2++; }
      }
      won = isP1 ? setsP1 > setsP2 : setsP2 > setsP1;
    } else {
      // Cannot tell which side we are. Skip rather than invent a loss.
      return null;
    }

    won ? wins++ : losses++;

    const ourPrice = isP1 ? Number(g.odd1) : Number(g.odd2);
    const wasDog = Number.isFinite(ourPrice) && ourPrice > 2;
    if (won && wasDog) asDogWins++;

    return { date: g.date, result: g.result, won, price: Number.isFinite(ourPrice) ? ourPrice : null };
  });

  /* Drop unorientable entries — the map returns null for a match whose
   * side we could not determine, and those must not reach the brief as
   * blank rows. If nothing survived, report no form at all rather than
   * an empty 0-0, which reads as a real record. */
  const usable = recent.filter(Boolean);
  if (!wins && !losses) return null;

  return { last10: `${wins}-${losses}`, upsetWins: asDogWins, matches: usable, careerMatches: b.count ?? null };
}

/**
 * VENUE HISTORY.  /atp|wta/player/tournament-record/{playerId}/{tournamentId}
 *   { data:[{ year, tournamentId, tournamentName, bestRoundId,
 *     bestRound, wins, losses }] }
 * The tournamentId varies by year (an event's id changes as it is
 * renamed), so this resolves the tournament family rather than one edition.
 */
async function fetchVenueRecord(tour, playerId, tournamentId) {
  const b = await safe(() => apiGet(`${tour}/player/tournament-record/${playerId}/${tournamentId}`));
  const rows = Array.isArray(b?.data) ? b.data : null;
  if (!rows || !rows.length) return null;

  const wins = rows.reduce((n, r) => n + (r.wins || 0), 0);
  const losses = rows.reduce((n, r) => n + (r.losses || 0), 0);
  const best = rows.reduce((acc, r) => (r.bestRoundId > (acc?.bestRoundId ?? -1) ? r : acc), null);
  const recent = rows.slice(-3).map((r) => `${r.year}: ${r.wins}-${r.losses} (${r.bestRound})`);
  return { record: `${wins}-${losses}`, appearances: rows.length, best: best?.bestRound || null, recentYears: recent };
}

/**
 * RANKING TREND.  /ranking/{type}/player/{playerId}/history
 *   { player:{name,countryAcr}, change, history:[{date, position, pts}] }
 * Direction matters as much as the number — a player at 15 climbing from
 * 40 is a different proposition from one at 15 falling from 6.
 */
async function fetchRankingTrend(tour, playerId) {
  const b = await safe(() => apiGet(`ranking/${tour}/player/${playerId}/history`));
  const hist = Array.isArray(b?.history) ? b.history : null;
  if (!hist || !hist.length) return null;

  const now = hist[0];
  const older = hist[Math.min(hist.length - 1, 5)];
  const delta = (older?.position ?? now.position) - now.position; // positive = climbing
  return {
    position: now.position,
    points: now.pts,
    trend: delta > 0 ? `up ${delta}` : delta < 0 ? `down ${Math.abs(delta)}` : 'flat',
  };
}

/**
 * RECORD AGAINST RANKING TIERS.  /atp|wta/player/perf-breakdown/{playerId}
 *   { data: { "2026": { rank: { top10:{aw,al}, top50:{aw,al}, ... },
 *     level: { masters:{aw,al}, challengers:{aw,al}, ... } } } }
 *   aw = wins, al = losses.
 *
 * This is the factor the market prices worst. A player can be 25-10
 * overall and 1-8 against the top ten; the headline record hides it.
 * Only the current year is taken — the full response spans 14 years and
 * would swamp the prompt.
 */
async function fetchTierRecord(tour, playerId) {
  const b = await safe(() => apiGet(`${tour}/player/perf-breakdown/${playerId}`));
  const data = b?.data;
  if (!data || typeof data !== 'object') return null;

  const years = Object.keys(data).sort();
  const year = years[years.length - 1];
  const rank = data[year]?.rank;
  if (!rank) return null;

  const fmt = (t) => (t && (t.aw || t.al) ? `${t.aw || 0}-${t.al || 0}` : null);
  return {
    year,
    vsTop10: fmt(rank.top10),
    vsTop20: fmt(rank.top20),
    vsTop50: fmt(rank.top50),
    vsTop100: fmt(rank.top100),
  };
}

/**
 * Gather everything for one match. Fetches both players in parallel —
 * these are independent reads, and doing them in series would add
 * seconds to every analysis.
 */
/* MATCH LOAD / FATIGUE.  h2h/recent/{type}/{playerId}
 *
 * The factor the market prices worst at Challenger and ITF level, where
 * a player can be in their fourth match in five days across singles and
 * qualifying and nothing in the price reflects it.
 *
 * Two things matter and both are in the recent-match payload: how many
 * matches in the last 7 and 14 days, and how long they lasted. `stat.mt`
 * is match duration in "0000-00-00 HH:MM:SS" form — the date part is
 * padding, only the time is real.
 *
 * Minutes matter more than match count: three straight-sets wins is a
 * different week from two three-hour three-setters.
 */
function parseMatchMinutes(mt) {
  if (!mt || typeof mt !== 'string') return null;
  // "0000-00-00 01:11:47" -> 71 minutes. Take the LAST time-looking part.
  const m = mt.match(/(\d{1,2}):(\d{2}):(\d{2})\s*$/);
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  // A tennis match under 20 or over 360 minutes is a parse artefact.
  return (mins >= 20 && mins <= 360) ? mins : null;
}

/* Short-lived cache for h2h/recent.
 *
 * Recent form, match load and travel context all read the SAME endpoint
 * for the same player, so building one brief fired three identical
 * requests per side — six wasted calls a match, and this pass runs every
 * two minutes across the whole slate.
 *
 * 60 seconds is long enough to cover a single brief build (and the
 * several matches a player may appear in during one cycle) while short
 * enough that a result landing mid-cycle is picked up on the next pass.
 */
const recentCache = new Map();
const RECENT_TTL_MS = 60 * 1000;

async function fetchRecentCached(tour, playerId) {
  const key = `${tour}|${playerId}`;
  const hit = recentCache.get(key);
  if (hit && Date.now() - hit.at < RECENT_TTL_MS) return hit.body;

  let body = null;
  try {
    body = await apiGet(`h2h/recent/${tour}/${encodeURIComponent(playerId)}`);
  } catch {
    body = null;
  }
  recentCache.set(key, { body, at: Date.now() });

  // Bound the map: a long-running process would otherwise accumulate an
  // entry per player seen, forever.
  if (recentCache.size > 400) {
    const cutoff = Date.now() - RECENT_TTL_MS;
    for (const [k, v] of recentCache) if (v.at < cutoff) recentCache.delete(k);
  }
  return body;
}

async function fetchMatchLoad(tour, playerId) {
  if (!playerId) return null;
  const body = await fetchRecentCached(tour, playerId);
  const games = Array.isArray(body?.games) ? body.games : [];
  if (!games.length) return null;

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  let m7 = 0, m14 = 0, min7 = 0, min14 = 0, longest7 = 0, lastGapDays = null;

  games.forEach((g, i) => {
    if (!g.date) return;
    const age = now - new Date(g.date).getTime();
    if (age < 0) return;                       // scheduled, not played
    if (i === 0) lastGapDays = Math.floor(age / DAY);

    const mins = parseMatchMinutes(g.stat?.mt);
    if (age <= 7 * DAY)  { m7++;  if (mins) { min7 += mins; longest7 = Math.max(longest7, mins); } }
    if (age <= 14 * DAY) { m14++; if (mins) min14 += mins; }
  });

  return {
    matches7: m7, matches14: m14,
    minutes7: min7 || null, minutes14: min14 || null,
    longestMinutes7: longest7 || null,
    daysSinceLastMatch: lastGapDays,
  };
}

/* TRAVEL, CROWD, STYLE and PHYSICAL — the remaining derivable factors.
 *
 * None of these has a dedicated endpoint. All four come out of data we
 * already fetch, which is why they are worth adding: no extra API cost.
 *
 * Court speed and motivation are deliberately NOT here. Neither exists
 * in any payload, and inventing a proxy (aces-per-game as "speed",
 * round number as "motivation") would put a fabricated number in front
 * of the analyst wearing the same clothes as the measured ones.
 */
const EARTH_KM = 6371;

function haversineKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_KM * Math.asin(Math.sqrt(h)));
}

/* Rough timezone shift from longitude — 15 degrees per hour.
 * Not exact (timezones follow borders, not meridians) but the thing that
 * matters for jet lag is the size of the east-west jump, and longitude
 * captures that faithfully enough to be worth stating. */
function tzShiftHours(a, b) {
  if (!a || !b || a.lon == null || b.lon == null) return null;
  let d = (b.lon - a.lon) / 15;
  if (d > 12) d -= 24;
  if (d < -12) d += 24;
  return Math.round(d);
}

/* A retirement leaves an unfinished set in the score string: "6-4 2-5"
 * rather than a completed "6-4 6-3". Two retirements in recent matches
 * is a physical signal the price rarely reflects at lower tiers. */
function looksRetired(score) {
  if (!score) return false;
  const sets = String(score).replace(/\([^)]*\)/g, '').trim().split(/[,\s]+/);
  const last = sets[sets.length - 1];
  if (!last) return false;
  const [x, y] = last.split('-').map(Number);
  if (isNaN(x) || isNaN(y)) return false;
  const decided = (x >= 6 || y >= 6) && (Math.abs(x - y) >= 2 || x === 7 || y === 7);
  return !decided;
}

/**
 * Context derived from a player's recent matches: where they last played,
 * how far that is from here, and whether they have retired lately.
 */
async function fetchContext(tour, playerId, currentTournamentId) {
  if (!playerId) return null;
  const body = await fetchRecentCached(tour, playerId);
  const games = Array.isArray(body?.games) ? body.games : [];
  if (!games.length) return null;

  const coordOf = (g) => {
    const t = g.tournament || {};
    return (t.latitude == null || t.longitude == null)
      ? null : { lat: Number(t.latitude), lon: Number(t.longitude), country: t.countryAcr || null };
  };

  // Where this event is: taken from a previous round at the SAME
  // tournament when there is one. On a first-round match there is no
  // earlier round to read, and the factor is simply omitted.
  let here = null;
  for (const g of games) {
    if (currentTournamentId && String(g.tournamentId) === String(currentTournamentId)) {
      here = coordOf(g); if (here) break;
    }
  }

  // The last event they played somewhere ELSE.
  let previous = null;
  for (const g of games) {
    if (currentTournamentId && String(g.tournamentId) === String(currentTournamentId)) continue;
    previous = coordOf(g); if (previous) break;
  }

  const retirements = games.slice(0, 5).filter((g) => looksRetired(g.result)).length;

  return {
    hereCountry: here ? here.country : null,
    travelKm: haversineKm(previous, here),
    tzShift: tzShiftHours(previous, here),
    recentRetirements: retirements,
  };
}

/* Handedness, backhand and nationality, from the name-keyed profile.
 * Cheap and static — cached for the process lifetime since a player's
 * playing hand does not change between matches. */
const styleCache = new Map();

async function fetchStyle(tour, name) {
  if (!name) return null;
  const key = `${tour}|${name}`;
  if (styleCache.has(key)) return styleCache.get(key);

  let body;
  try {
    body = await apiGet(`profile/${encodeURIComponent(name)}`);
  } catch {
    styleCache.set(key, null);
    return null;
  }
  const info = body?.information || {};
  const out = {
    plays: info.plays || null,
    backhand: info.backhand || null,
    country: body?.country?.acronym || null,
  };
  styleCache.set(key, out);
  return out;
}

/* STYLE MATCHUP — the interaction, not two lists of attributes.
 *
 * "Styles make matches" is real in tennis for specific, mechanical
 * reasons, and the brief already carried the ingredients (handedness,
 * backhand, serve and return numbers) without ever computing how they
 * meet. Stating both players' attributes and leaving the analyst to
 * notice is why the Style card so often read "Neutral".
 *
 * Two interactions are computable from data already fetched:
 *
 * 1. HANDEDNESS EXPOSURE. A left-hander's patterns — slice serve wide on
 *    the ad court, forehand into a right-hander's backhand — are worth
 *    more against someone who has not faced one recently. At Challenger
 *    and ITF level a player can go months without meeting a leftie.
 *    Only computed when the match IS lefty/righty; a righty-righty match
 *    costs no extra calls at all.
 *
 * 2. SERVE vs RETURN. A big server against a weak returner produces
 *    matches decided almost entirely in tiebreaks. Both sides are
 *    aggregated from the per-match stat rows already present in
 *    h2h/recent — no additional requests.
 *
 * Numbers are stated, never interpreted: the brief says one player wins
 * 74% behind the first serve while the other returns at 31%, and the
 * analyst decides what that is worth.
 */
function serveReturnProfile(games, playerId) {
  let fs = 0, fsOf = 0, w1 = 0, w1Of = 0, w2 = 0, w2Of = 0, rpw = 0, rpwOf = 0, aces = 0, dfs = 0, n = 0;

  for (const g of games) {
    const st = g.stat;
    if (!st) continue;
    // The suffix follows player1Id / player2Id, so orientation is known
    // rather than guessed — the mistake that produced the fake 0-10.
    const sfx = String(st.player1Id) === String(playerId) ? '1'
              : String(st.player2Id) === String(playerId) ? '2' : null;
    if (!sfx) continue;

    const num = (k) => { const v = Number(st[`${k}${sfx}`]); return Number.isFinite(v) ? v : 0; };
    fs += num('firstServe');       fsOf += num('firstServeOf');
    w1 += num('winningOnFirstServe');  w1Of += num('winningOnFirstServeOf');
    w2 += num('winningOnSecondServe'); w2Of += num('winningOnSecondServeOf');
    rpw += num('rpw');             rpwOf += num('rpwOf');
    aces += num('aces');           dfs += num('doubleFaults');
    n++;
  }

  if (!n || !fsOf || !rpwOf) return null;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);

  return {
    matches: n,
    firstServeIn: pct(fs, fsOf),
    wonOnFirst: pct(w1, w1Of),
    wonOnSecond: pct(w2, w2Of),
    returnPtsWon: pct(rpw, rpwOf),
    acesPerMatch: Math.round((aces / n) * 10) / 10,
    dfPerMatch: Math.round((dfs / n) * 10) / 10,
  };
}

/* Is this player left-handed? `plays` reads like "Left-Handed" or
 * "Right-Handed, Two-Handed Backhand" depending on the endpoint. */
function isLefty(style) {
  return /left/i.test(String(style?.plays || ''));
}

/**
 * How many of a player's recent opponents were left-handed.
 *
 * Only called when the opponent in THIS match is a leftie, so the cost
 * is paid on the small fraction of matches where the answer matters.
 * Bounded to the last 8 opponents and served from the style cache, so
 * repeat opponents (common at ITF level) cost nothing.
 */
async function leftyExposure(tour, games, playerId, limit = 8) {
  const opponents = [];
  for (const g of games.slice(0, limit)) {
    const oppName = String(g.player1Id) === String(playerId) ? g.player2?.name : g.player1?.name;
    if (oppName) opponents.push(oppName);
  }
  if (!opponents.length) return null;

  let lefties = 0, known = 0;
  for (const name of opponents) {
    const st = await fetchStyle(tour, name);
    if (!st || !st.plays) continue;
    known++;
    if (isLefty(st)) lefties++;
  }
  if (!known) return null;
  return { lefties, of: known };
}

/* SURFACE RECORD BY YEAR, not just career.
 *
 * The brief used h2h/surfaceBreakdown, which returns career totals only.
 * player/surface-summary/{id} returns the same split BROKEN DOWN BY
 * YEAR, and the difference is the whole signal.
 *
 * Andaloro's career reads 110-58 on hard and 47-50 on clay — useful. But
 * year by year it reads 60-24 in 2025 and 14-13 in 2026, with this
 * season's damage concentrated on clay (5-8) while hard holds up (9-5).
 * A career average cannot show a player falling off, or falling off on
 * ONE surface. That is what separates "48% on clay" from "collapsing on
 * clay this season, still fine on hard".
 *
 * Returns the current season, the previous one, and career totals, so
 * the analyst can see both the level and the direction.
 */
async function fetchSurfaceByYear(tour, playerId, surfaceName) {
  if (!playerId) return null;
  const body = await safe(() => apiGet(`${tour}/player/surface-summary/${encodeURIComponent(playerId)}`));
  const rows = body?.data;
  if (!Array.isArray(rows) || !rows.length) return null;

  // Court names in this payload: Hard, Clay, Grass, I.hard, Carpet.
  const matchesSurface = (court) => {
    if (!surfaceName) return false;
    const c = String(court || '').toLowerCase();
    const want = String(surfaceName).toLowerCase();
    if (/indoor/.test(want)) return c === 'i.hard';
    if (/hard/.test(want)) return c === 'hard' || c === 'i.hard';
    if (/clay/.test(want)) return c === 'clay';
    if (/grass/.test(want)) return c === 'grass';
    return false;
  };

  const sumYear = (row) => {
    let w = 0, l = 0, sw = 0, sl = 0;
    for (const c of row.surfaces || []) {
      w += Number(c.courtWins) || 0;
      l += Number(c.courtLosses) || 0;
      if (matchesSurface(c.court)) {
        sw += Number(c.courtWins) || 0;
        sl += Number(c.courtLosses) || 0;
      }
    }
    return { year: row.year, wins: w, losses: l, surfaceWins: sw, surfaceLosses: sl };
  };

  const byYear = rows.map(sumYear).sort((a, b) => b.year - a.year);
  const current = byYear[0] || null;
  const previous = byYear[1] || null;

  let cw = 0, cl = 0, csw = 0, csl = 0;
  for (const y of byYear) {
    cw += y.wins; cl += y.losses; csw += y.surfaceWins; csl += y.surfaceLosses;
  }

  const pct = (w, l) => (w + l > 0 ? Math.round((w / (w + l)) * 100) : null);

  return {
    current, previous,
    career: { wins: cw, losses: cl, pct: pct(cw, cl) },
    careerOnSurface: { wins: csw, losses: csl, pct: pct(csw, csl) },
    currentOnSurface: current
      ? { wins: current.surfaceWins, losses: current.surfaceLosses,
          pct: pct(current.surfaceWins, current.surfaceLosses) }
      : null,
  };
}

/* CAREER SERVE AND RETURN — the whole record, not the last ten matches.
 *
 * serveReturnProfile() aggregates from h2h/recent, which caps at ten
 * matches. That is a small and noisy sample: one blowout swings a serve
 * percentage several points.
 *
 * This endpoint returns the same measures over a player's ENTIRE career
 * — 159 matches for a Challenger qualifier, hundreds for a tour regular.
 * Both are worth having: career is the stable baseline, recent is the
 * current state, and the gap between them is itself signal. A player
 * serving well below his career norm over ten matches is in a slump; the
 * career figure alone cannot show that.
 *
 * Note the path: {type}/h2h/vs-all-stats/{id}, tour FIRST. The other
 * ordering 404s.
 */
async function fetchCareerServeReturn(tour, playerId) {
  if (!playerId) return null;
  const body = await safe(() => apiGet(`${tour}/h2h/vs-all-stats/${encodeURIComponent(playerId)}`));
  const st = body?.data?.playerStats;
  if (!st || !st.statMatchesPlayed) return null;

  const pct = (a, b) => {
    const x = Number(a), y = Number(b);
    return (Number.isFinite(x) && Number.isFinite(y) && y > 0) ? Math.round((x / y) * 100) : null;
  };
  const n = Number(st.statMatchesPlayed) || 0;
  const per = (v) => (n > 0 && Number.isFinite(Number(v))) ? Math.round((Number(v) / n) * 10) / 10 : null;

  return {
    matches: n,
    won: Number(st.matchesWon) || 0,
    winPct: pct(st.matchesWon, n),
    firstServeIn: pct(st.firstServe, st.firstServeOf),
    wonOnFirst: pct(st.winningOnFirstServe, st.winningOnFirstServeOf),
    wonOnSecond: pct(st.winningOnSecondServe, st.winningOnSecondServeOf),
    returnPtsWon: pct(st.returnPtsWin ?? st.rpw, st.returnPtsWinOf ?? st.rpwOf),
    breakPtsWon: pct(st.breakPointsConverted, st.breakPointsConvertedOf),
    acesPerMatch: per(st.aces),
    dfPerMatch: per(st.doubleFaults),
  };
}

/* BREAK POINTS — the measure tennis actually turns on.
 *
 * Neither the recent nor the career serve/return line carried break
 * points, and a tennis match is decided by a handful of them: hold
 * percentage is mostly a function of saving the ones you face, and
 * winning is mostly a function of converting the ones you get.
 *
 * This endpoint splits serve and return properly, so return points won
 * is derivable here too — the vs-all-stats payload did not carry it.
 */
async function fetchBreakPoints(tour, playerId) {
  if (!playerId) return null;
  const body = await safe(() => apiGet(`${tour}/player/match-stats/${encodeURIComponent(playerId)}`));
  const d = body?.data;
  if (!d) return null;

  const pct = (a, b) => {
    const x = Number(a), y = Number(b);
    return (Number.isFinite(x) && Number.isFinite(y) && y > 0) ? Math.round((x / y) * 100) : null;
  };

  const bpS = d.breakPointsServeStats || {};
  const bpR = d.breakPointsRtnStats || {};
  const rtn = d.rtnStats || {};

  const saved = pct(bpS.breakPointSavedGm, bpS.breakPointFacedGm);
  const won = pct(bpR.breakPointWonGm, bpR.breakPointChanceGm);

  /* RETURN POINTS WON — inverted from the opponent's figures.
   *
   * rtnStats describes the OPPONENT serving against this player, not
   * this player returning. Summing its "winning" fields gives points the
   * opponent won, so reading them directly produced 59% return points
   * won for Sinner — a number no player approaches; the real elite range
   * is around 40%.
   *
   * The arithmetic identifies the fields: 27596 + 16793 = 44389, so
   * firstServeOfGm is TOTAL return points, and the winning fields are
   * the opponent's. What this player won is the remainder. */
  const rptOf = Number(rtn.firstServeOfGm) || 0;
  const oppWon = (Number(rtn.winningOnFirstServeGm) || 0) + (Number(rtn.winningOnSecondServeGm) || 0);
  const rptWon = rptOf > 0 ? (rptOf - oppWon) : 0;

  if (saved === null && won === null && !rptOf) return null;

  return {
    bpSaved: saved,
    bpSavedOf: Number(bpS.breakPointFacedGm) || 0,
    bpConverted: won,
    bpConvertedOf: Number(bpR.breakPointChanceGm) || 0,
    returnPtsWon: pct(rptWon, rptOf),
  };
}

/* TITLES BY TIER — the level a player has actually won at.
 *
 * A bare title count flattens a Grand Slam and an ITF Futures into one
 * number. This returns them separately, so "5 Slams, 10 Masters" can sit
 * against "2 Futures titles" and the gap in level is explicit rather
 * than implied by ranking alone.
 *
 * Only the meaningful tiers are kept: Futures counts are noise for a
 * tour player and clutter for everyone else.
 */
async function fetchTitlesByTier(tour, playerId) {
  if (!playerId) return null;
  const body = await safe(() => apiGet(`${tour}/player/titles/${encodeURIComponent(playerId)}`));
  const rows = body?.data;
  if (!Array.isArray(rows) || !rows.length) return null;

  const LABEL = {
    4: 'Slam', 3: 'Masters', 7: 'Tour Finals', 2: 'tour', 1: 'Challenger', 0: 'Futures',
  };
  const out = [];
  // Highest tier first, so the strongest achievement leads.
  for (const id of [4, 3, 7, 2, 1, 0]) {
    const row = rows.find((r) => Number(r.tourRankId) === id);
    const won = Number(row?.titlesWon) || 0;
    if (won > 0) out.push(`${won} ${LABEL[id]}`);
  }
  return out.length ? out.join(', ') : null;
}

/* HOW THEIR LAST MEETING ACTUALLY WENT.
 *
 * The head-to-head factor said who won and on what surface. It could not
 * say HOW — whether it was a tight three-setter decided on two break
 * points, or a straight-sets rout where one player never faced a break.
 * Those are different pieces of evidence about the same 1-0 record.
 *
 * This endpoint carries the detail: aces, first and second serve won,
 * break points faced and saved, winners, unforced errors, net play —
 * fuller than the stat block embedded in h2h/recent, which leaves
 * winners and net approaches null.
 *
 * The tournament id comes from the cached recent-match list rather than
 * a lookup, so this costs ONE call when the two have met and NOTHING
 * when they have not — which for a first meeting is the common case.
 *
 * Small sample by nature: one match. Its value is specificity, not
 * statistical weight, and the brief says so by naming the event.
 */
async function fetchLastMeetingStats(tour, playerAId, playerBId, games) {
  if (!playerAId || !playerBId || !Array.isArray(games) || !games.length) return null;

  const meeting = games.find((g) =>
    (String(g.player1Id) === String(playerAId) && String(g.player2Id) === String(playerBId)) ||
    (String(g.player1Id) === String(playerBId) && String(g.player2Id) === String(playerAId)));

  if (!meeting || !meeting.tournamentId) return null;

  const body = await safe(() => apiGet(
    `${tour}/h2h/match-stats/${meeting.tournamentId}/${encodeURIComponent(playerAId)}/${encodeURIComponent(playerBId)}`));
  const d = body?.data;
  if (!d) return null;

  const pct = (a, b) => {
    const x = Number(a), y = Number(b);
    return (Number.isFinite(x) && Number.isFinite(y) && y > 0) ? Math.round((x / y) * 100) : null;
  };

  const side = (st) => {
    if (!st) return null;
    return {
      aces: Number(st.aces) || 0,
      doubleFaults: Number(st.doubleFaults) || 0,
      wonOnFirst: pct(st.winningOnFirstServe, st.winningOnFirstServeOf),
      wonOnSecond: pct(st.winningOnSecondServe, st.winningOnSecondServeOf),
      bpFaced: Number(st.breakPointFacedGm) || 0,
      bpSaved: Number(st.breakPointSavedGm) || 0,
      bpChances: Number(st.breakPointChanceGm) || 0,
      bpWon: Number(st.breakPointWonGm) || 0,
      winners: st.winners == null ? null : Number(st.winners),
      unforced: st.unforcedErrors == null ? null : Number(st.unforcedErrors),
    };
  };

  const a = side(d.player1Stats), b = side(d.player2Stats);
  if (!a && !b) return null;

  return {
    event: meeting.tournament?.name || null,
    date: meeting.date || null,
    result: meeting.result || null,
    a, b,
  };
}

async function buildFactorBrief({ tour = 'atp', nameA, nameB, playerAId, playerBId, tournamentId, surfaceName = null }) {
  const [h2h, surfA, surfB, formA, formB, venueA, venueB, rankA, rankB, tierA, tierB, loadA, loadB, ctxA, ctxB, styleA, styleB] = await Promise.all([
    fetchH2H(tour, nameA, nameB),
    fetchSurfaceRecord(tour, nameA),
    fetchSurfaceRecord(tour, nameB),
    fetchRecentForm(tour, nameA, playerAId),
    fetchRecentForm(tour, nameB, playerBId),
    tournamentId ? fetchVenueRecord(tour, playerAId, tournamentId) : null,
    tournamentId ? fetchVenueRecord(tour, playerBId, tournamentId) : null,
    fetchRankingTrend(tour, playerAId),
    fetchRankingTrend(tour, playerBId),
    fetchTierRecord(tour, playerAId),
    fetchTierRecord(tour, playerBId),
    fetchMatchLoad(tour, playerAId),
    fetchMatchLoad(tour, playerBId),
    fetchContext(tour, playerAId, tournamentId),
    fetchContext(tour, playerBId, tournamentId),
    fetchStyle(tour, nameA),
    fetchStyle(tour, nameB),
  ]);

  /* Year-by-year surface, scoped to THIS match's surface. One call per
   * player, id-keyed, and far more informative than the career split the
   * brief used before. */
  const [byYearA, byYearB, careerSrA, careerSrB, bpA, bpB, titlesA, titlesB,
         statusA, statusB] = await Promise.all([
    fetchSurfaceByYear(tour, playerAId, surfaceName),
    fetchSurfaceByYear(tour, playerBId, surfaceName),
    fetchCareerServeReturn(tour, playerAId),
    fetchCareerServeReturn(tour, playerBId),
    fetchBreakPoints(tour, playerAId),
    fetchBreakPoints(tour, playerBId),
    fetchTitlesByTier(tour, playerAId),
    fetchTitlesByTier(tour, playerBId),
    /* Player status — the only direct source for the Injury/Physical
     * factor, which has otherwise been inferred from retirement patterns
     * in scorelines. Name-keyed, so it uses the display names. */
    fetchPlayerStatus(nameA),
    fetchPlayerStatus(nameB),
  ]);

  /* Serve/return profiles reuse the CACHED recent-match payload — the
   * stat rows are already in it, so this costs no additional requests. */
  const [recentA, recentB] = await Promise.all([
    playerAId ? fetchRecentCached(tour, playerAId) : null,
    playerBId ? fetchRecentCached(tour, playerBId) : null,
  ]);
  const gamesA = Array.isArray(recentA?.games) ? recentA.games : [];
  const gamesB = Array.isArray(recentB?.games) ? recentB.games : [];

  /* Uses gamesA, already fetched and cached — the tournament id of any
   * prior meeting is in there, so no lookup call is needed to find it. */
  const lastMeeting = await fetchLastMeetingStats(tour, playerAId, playerBId, gamesA);

  const srA = playerAId ? serveReturnProfile(gamesA, playerAId) : null;
  const srB = playerBId ? serveReturnProfile(gamesB, playerBId) : null;

  /* Handedness exposure, only where there is an asymmetry to measure.
   * A righty-righty match — the large majority — skips this entirely and
   * pays nothing. */
  const aLefty = isLefty(styleA), bLefty = isLefty(styleB);
  const [expA, expB] = await Promise.all([
    (bLefty && !aLefty && playerAId) ? leftyExposure(tour, gamesA, playerAId) : null,
    (aLefty && !bLefty && playerBId) ? leftyExposure(tour, gamesB, playerBId) : null,
  ]);

  return {
    h2h,
    playerA: { name: nameA, surface: surfA, form: formA, venue: venueA, ranking: rankA, tiers: tierA, load: loadA, ctx: ctxA, style: styleA, country: styleA ? styleA.country : null,
      serveReturn: srA, lefty: aLefty, leftyExposure: expA, byYear: byYearA, careerSr: careerSrA, breakPts: bpA, titles: titlesA, status: statusA },
    playerB: { name: nameB, surface: surfB, form: formB, venue: venueB, ranking: rankB, tiers: tierB, load: loadB, ctx: ctxB, style: styleB, country: styleB ? styleB.country : null,
      serveReturn: srB, lefty: bLefty, leftyExposure: expB, byYear: byYearB, careerSr: careerSrB, breakPts: bpB, titles: titlesB, status: statusB },
  };
}

/**
 * Render the brief as prompt text.
 *
 * Deliberately compact and factual: no interpretation, no leading
 * language. The analyst weighs these; pre-digesting them into "A looks
 * stronger" would put a judgement in the input and make the factor
 * weights unmeasurable.
 *
 * Anything missing is simply omitted rather than filled with a guess —
 * the fixed factor list already treats absent data as "No data".
 */
function renderFactorBrief(brief, { surface = null } = {}) {
  if (!brief) return '';
  const L = [];
  const A = brief.playerA, B = brief.playerB;

  if (brief.h2h && brief.h2h.meetings > 0) {
    const h = brief.h2h;
    L.push(`HEAD TO HEAD (${h.meetings} meetings): ${A.name} ${h.wonA}-${h.wonB} ${B.name}`);
    const surfLines = Object.entries(h.bySurface)
      .filter(([, v]) => v[0] + v[1] > 0)
      .map(([k, v]) => `${k} ${v[0]}-${v[1]}`);
    if (surfLines.length) L.push(`  by surface (${A.name}'s record): ${surfLines.join(', ')}`);
    /* serveA is null when the record came from the profile fallback —
     * those meetings exist but carry no stat rows. Dereferencing it
     * threw and took the whole brief down with it, which would have
     * turned "no serve splits" into "no data at all". */
    if (h.serveA && h.serveB && h.serveA.wonFirstPct != null) {
      L.push(`  serve in those meetings — ${A.name}: ${h.serveA.firstServePct}% first in, ${h.serveA.wonFirstPct}% won on first, ${h.serveA.wonSecondPct}% on second`);
      L.push(`  serve in those meetings — ${B.name}: ${h.serveB.firstServePct}% first in, ${h.serveB.wonFirstPct}% won on first, ${h.serveB.wonSecondPct}% on second`);
    }
  }

  for (const P of [A, B]) {
    const parts = [];
    if (P.ranking) parts.push(`rank ${P.ranking.position} (${P.ranking.trend}, ${P.ranking.points} pts)`);
    if (P.form) parts.push(`last 10: ${P.form.last10}${P.form.upsetWins ? `, ${P.form.upsetWins} as underdog` : ''}`);
    if (P.surface) {
      const s = P.surface;
      const rel = surface && /clay/i.test(surface) ? `clay ${s.clay[0]}-${s.clay[1]} (${s.clayPct}%)`
        : surface && /grass/i.test(surface) ? `grass ${s.grass[0]}-${s.grass[1]} (${s.grassPct}%)`
        : `hard ${s.hard[0]}-${s.hard[1]} (${s.hardPct}%)`;
      parts.push(`career ${s.career[0]}-${s.career[1]}, ${rel}`);
    }
    if (P.venue) parts.push(`at this event: ${P.venue.record} over ${P.venue.appearances} appearances, best ${P.venue.best}`);

    /* MATCH LOAD. Stated as raw counts and minutes, never as
     * "fresh" or "tired" — the analyst weighs it, and pre-judging it
     * here would bury a decision inside the input.
     *
     * Days since the last match is included because it cuts both ways:
     * one day is fatigue, but three weeks is rust, and only the analyst
     * should decide which matters for this match-up. */
    if (P.load && (P.load.matches7 || P.load.daysSinceLastMatch != null)) {
      const l = P.load;
      const bits = [];
      if (l.matches7) {
        bits.push(`${l.matches7} match${l.matches7 === 1 ? '' : 'es'} in 7 days` +
          (l.minutes7 ? ` (${l.minutes7} min on court, longest ${l.longestMinutes7})` : ''));
      }
      if (l.matches14 && l.matches14 !== l.matches7) bits.push(`${l.matches14} in 14 days`);
      if (l.daysSinceLastMatch != null) bits.push(`last played ${l.daysSinceLastMatch}d ago`);
      if (bits.length) parts.push(`workload: ${bits.join(', ')}`);
    }

    /* TRAVEL, CROWD, PHYSICAL — only stated when actually known.
     *
     * Travel needs a previous event AND this one's coordinates, which
     * means a first-round match has no travel line at all. Omitting it
     * is correct: a silent gap is honest, whereas "travel: unknown"
     * invites the analyst to reason about a number that does not exist.
     *
     * Home country is the crowd proxy — thin, but real and free. */
    if (P.ctx) {
      const c = P.ctx;
      if (c.travelKm != null && c.travelKm > 500) {
        parts.push(`travel: ${c.travelKm}km since last event` +
          (c.tzShift ? `, ${Math.abs(c.tzShift)}h timezone shift` : ''));
      }
      if (c.hereCountry && P.country && c.hereCountry === P.country) {
        parts.push('playing at home');
      }
      if (c.recentRetirements) {
        parts.push(`${c.recentRetirements} retirement${c.recentRetirements === 1 ? '' : 's'} in last 5`);
      }
    }

    /* STYLE. Handedness matters most as a mismatch — a leftie against a
     * righty who rarely faces one is a genuine edge, and the analyst can
     * only see that if both are stated. */
    if (P.style && (P.style.plays || P.style.backhand)) {
      parts.push(`style: ${[P.style.plays, P.style.backhand ? P.style.backhand + ' backhand' : null]
        .filter(Boolean).join(', ')}`);
    }

    /* Serve and return profile, aggregated from this player's recent
     * matches. Stated as plain rates so the analyst can compare one
     * player's serve against the OTHER's return — the comparison that
     * makes "styles make matches" concrete rather than a slogan. */
    /* SURFACE BY YEAR — level AND direction.
     *
     * Stated as this season, last season, and career on this surface, so
     * a player who has fallen off is visible as such rather than hidden
     * inside a career average. A season line alone would be noisy at
     * small sample sizes; the career line alone cannot show decline.
     * Both together let the analyst weigh them. */
    if (P.byYear) {
      const y = P.byYear;
      const rec = (o) => (o && (o.wins + o.losses) > 0) ? `${o.wins}-${o.losses}` : null;
      const bits = [];

      if (y.current) {
        const onSurf = rec(y.currentOnSurface);
        bits.push(`${y.current.year}: ${y.current.wins}-${y.current.losses} overall` +
          (onSurf ? `, ${onSurf} on this surface` : ''));
      }
      if (y.previous) {
        bits.push(`${y.previous.year}: ${y.previous.wins}-${y.previous.losses}`);
      }
      if (y.careerOnSurface && (y.careerOnSurface.wins + y.careerOnSurface.losses) > 0) {
        bits.push(`career on this surface ${y.careerOnSurface.wins}-${y.careerOnSurface.losses} (${y.careerOnSurface.pct}%)`);
      }
      if (bits.length) parts.push(`by year — ${bits.join('; ')}`);
    }

    if (P.serveReturn) {
      const sr = P.serveReturn;
      parts.push(`serve/return last ${sr.matches}: ${sr.firstServeIn}% first in, ` +
        `${sr.wonOnFirst}% won behind first, ${sr.wonOnSecond}% behind second, ` +
        `returns ${sr.returnPtsWon}%, ${sr.acesPerMatch} aces and ${sr.dfPerMatch} DF per match`);
    }

    /* CAREER serve/return, from the full record.
     *
     * The line above covers ten matches — enough to show current state,
     * too few to be stable. This is the same measures over a career (159
     * matches for a Challenger qualifier, hundreds for a tour regular).
     *
     * Both are stated because the GAP is the signal: a player serving
     * well below his own career norm across ten matches is in a slump,
     * and neither figure alone shows that. Only the headline rates are
     * repeated here — restating aces and double faults twice would spend
     * brief space on the least informative numbers. */
    /* BREAK POINTS — what tennis actually turns on.
     *
     * Hold percentage is mostly saving the ones you face; winning is
     * mostly converting the ones you get. Neither serve/return line
     * carried them, and a match can hinge on three or four points. */
    if (P.breakPts) {
      const b = P.breakPts;
      const bits = [];
      if (b.bpSaved != null) bits.push(`saves ${b.bpSaved}% of break points faced (${b.bpSavedOf})`);
      if (b.bpConverted != null) bits.push(`converts ${b.bpConverted}% of chances (${b.bpConvertedOf})`);
      if (b.returnPtsWon != null) bits.push(`wins ${b.returnPtsWon}% of return points`);
      if (bits.length) parts.push(`break points — ${bits.join(', ')}`);
    }

    /* Titles by TIER, not a flat count: "5 Slam, 10 Masters" against
     * "2 Futures" states the level each player has won at, which a
     * ranking alone does not. */
    if (P.titles) parts.push(`titles: ${P.titles}`);

    /* Status is stated only when it is NOT "Active".
     *
     * Both players being active is the normal case and says nothing —
     * printing it on every brief would spend space on the least
     * informative line available. An exception is worth a lot. */
    if (P.status && P.status.notable) {
      parts.push(`PLAYER STATUS: ${P.status.status}`);
    }

    if (P.careerSr) {
      const c = P.careerSr;
      parts.push(`career (${c.matches} matches, ${c.winPct}% won): ` +
        `${c.firstServeIn}% first in, ${c.wonOnFirst}% behind first, ` +
        `${c.wonOnSecond}% behind second` +
        (c.returnPtsWon != null ? `, returns ${c.returnPtsWon}%` : ''));
    }
    if (P.tiers) {
      const t = [];
      if (P.tiers.vsTop10) t.push(`top10 ${P.tiers.vsTop10}`);
      if (P.tiers.vsTop50) t.push(`top50 ${P.tiers.vsTop50}`);
      if (t.length) parts.push(`${P.tiers.year} vs ranked opposition: ${t.join(', ')}`);
    }
    if (parts.length) L.push(`${P.name.toUpperCase()}: ${parts.join(' | ')}`);
  }

  /* HOW THE LAST MEETING WENT — attached to the head to head.
   *
   * A 1-0 record reads very differently once you can see it was decided
   * on two break points rather than a rout. Stated as one line per
   * player, with the event named so the analyst can judge its age. */
  if (lastMeeting && (lastMeeting.a || lastMeeting.b)) {
    const where = [lastMeeting.event, lastMeeting.result].filter(Boolean).join(' ');
    L.push(`LAST MEETING${where ? ` (${where})` : ''}:`);

    const sideLine = (name, x) => {
      if (!x) return null;
      const bits = [];
      if (x.wonOnFirst != null) bits.push(`${x.wonOnFirst}% behind first serve`);
      if (x.wonOnSecond != null) bits.push(`${x.wonOnSecond}% behind second`);
      if (x.bpFaced) bits.push(`saved ${x.bpSaved} of ${x.bpFaced} break points`);
      if (x.bpChances) bits.push(`converted ${x.bpWon} of ${x.bpChances}`);
      if (x.aces) bits.push(`${x.aces} aces`);
      if (x.doubleFaults) bits.push(`${x.doubleFaults} double faults`);
      if (x.winners != null && x.unforced != null) bits.push(`${x.winners} winners to ${x.unforced} unforced`);
      return bits.length ? `  ${name}: ${bits.join(', ')}` : null;
    };

    const la = sideLine(A.name, lastMeeting.a);
    const lb = sideLine(B.name, lastMeeting.b);
    if (la) L.push(la);
    if (lb) L.push(lb);
  }

  /* STYLE INTERACTION — stated once, about the pairing.
   *
   * Everything above describes players separately. This is the only line
   * that describes how they MEET, which is the whole point of the
   * factor. Written only when there is a real asymmetry: a handedness
   * mismatch, or a serve/return gap wide enough to matter. Absent
   * otherwise, because "both right-handed, similar numbers" genuinely is
   * neutral and saying so adds nothing. */
  const interaction = [];

  if (A.lefty !== B.lefty) {
    const lefty = A.lefty ? A : B;
    const righty = A.lefty ? B : A;
    let line = `${lefty.name} is left-handed and ${righty.name} is not`;
    if (righty.leftyExposure) {
      line += `; ${righty.name} has faced ${righty.leftyExposure.lefties} left-hander(s) in their last ${righty.leftyExposure.of} matches`;
    }
    interaction.push(line);
  }

  /* Serve vs return, both directions. A gap is only worth stating when
   * it is large: 10 points separates a genuine mismatch from noise in
   * samples this size. */
  const srGap = (server, returner) => {
    if (!server.serveReturn || !returner.serveReturn) return null;
    const hold = server.serveReturn.wonOnFirst;
    const ret = returner.serveReturn.returnPtsWon;
    if (hold == null || ret == null) return null;
    return (hold - (100 - ret) >= 10)
      ? `${server.name} wins ${hold}% behind the first serve against ${returner.name} returning ${ret}%`
      : null;
  };
  const ab = srGap(A, B), ba = srGap(B, A);
  if (ab) interaction.push(ab);
  if (ba) interaction.push(ba);

  if (interaction.length) {
    L.push(`STYLE: ${interaction.join('. ')}.`);
  }

  /* FLAG UNEVEN COVERAGE.
   *
   * At Challenger and ITF level one player is often well documented and
   * the other barely at all. Rendered plainly, that reads as seven facts
   * about A and one about B — and the natural inference is that B is
   * unremarkable, when the truth is only that we know less about them.
   *
   * The prompt already says an absent line means unavailable, but a
   * per-player imbalance is subtler than a missing line, so it is stated
   * outright. Only when the gap is large enough to mislead. */
  const detailCount = (P) => [P.ranking, P.form, P.surface, P.venue, P.tiers,
    P.load, P.ctx, P.style].filter(Boolean).length;
  const dA = detailCount(A), dB = detailCount(B);
  if (L.length && Math.abs(dA - dB) >= 3) {
    const thin = dA < dB ? A.name : B.name;
    L.push(`NOTE: markedly less data available for ${thin}. Treat that as missing information, not as evidence against them.`);
  }

  return L.length ? `\nVERIFIED DATA (from the tennis data provider, not search):\n${L.join('\n')}\n` : '';
}

/**
 * CLOSING LINE VALUE.
 *
 * /extend/api/odds/summary/movements/last-10/{eventId}
 *   { result: { "Bet365": { "Full Time Result": [
 *       { od1, od2, odx, line, sourceAddTime }, ... ] }, "DraftKings": {...} } }
 *
 * Note this is the endpoint that actually carries movement — the
 * documented `odds/biggest-movements/{id}` returned `count: 0` on a live
 * main-tour match, so it isn't usable.
 *
 * WHY CLV MATTERS MORE THAN WIN RATE RIGHT NOW.
 *
 * Win rate needs hundreds of settled picks before it can distinguish an
 * edge from a hot streak. CLV needs dozens. If a pick's price consistently
 * shortens after it is made, the market is agreeing with it after the
 * fact — which is what having an edge looks like, and it stays visible
 * even through a losing week.
 *
 * Positive CLV with a losing record means variance. A winning record with
 * negative CLV means the wins are being bought at bad prices, which is
 * exactly the shape of a 71% record at -2.5% ROI.
 */
function decToAm(dec) {
  const d = Number(dec);
  if (!Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

async function fetchClosingLine(eventId, { preferBooks = null } = {}) {
  const body = await safe(() => apiGet(`extend/api/odds/summary/movements/last-10/${encodeURIComponent(eventId)}`));
  const byBook = body?.result;
  if (!byBook || typeof byBook !== 'object') return null;

  const order = preferBooks || (process.env.TENNIS_ODDS_BOOKS || 'Pinnacle,Bet365,DraftKings').split(',').map((b) => b.trim());
  let rows = null, book = null;
  for (const want of order) {
    const key = Object.keys(byBook).find((k) => k.toLowerCase() === want.toLowerCase());
    const market = key && byBook[key]?.['Full Time Result'];
    if (Array.isArray(market) && market.length) { rows = market; book = key; break; }
  }
  if (!rows) {
    const key = Object.keys(byBook).find((k) => Array.isArray(byBook[k]?.['Full Time Result']));
    if (!key) return null;
    rows = byBook[key]['Full Time Result']; book = key;
  }

  // Latest by timestamp is the closest thing to a closing price. The feed
  // does not guarantee ordering, so sort rather than trusting position.
  const sorted = [...rows].sort((a, b) => Number(b.sourceAddTime || 0) - Number(a.sourceAddTime || 0));
  const last = sorted[0];
  const closeA = decToAm(last.od1);
  const closeB = decToAm(last.od2);
  if (closeA === null || closeB === null) return null;

  return {
    book,
    closingA: closeA,
    closingB: closeB,
    capturedAt: last.sourceAddTime ? new Date(Number(last.sourceAddTime) * 1000) : null,
    samples: rows.length,
  };
}

/**
 * CLV in percentage points of implied probability.
 *
 * Expressed against probability rather than raw American odds because
 * -110 to -120 and +200 to +180 are very different in price terms but
 * comparable in what they say about the market moving your way.
 * Positive = the price shortened after the pick (market agreed).
 */
function clvPercent(entryOdds, closingOdds) {
  const imp = (o) => (o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100));
  if (!Number.isFinite(entryOdds) || !Number.isFinite(closingOdds)) return null;
  return Math.round((imp(closingOdds) - imp(entryOdds)) * 1000) / 10;
}

module.exports = {
  fetchClosingLine,
  clvPercent,
  buildFactorBrief,
  renderFactorBrief,
  fetchH2H,
  fetchSurfaceRecord,
  fetchRecentForm,
  fetchVenueRecord,
  fetchRankingTrend,
  fetchTierRecord,
  COURTS,
};
