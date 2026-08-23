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

const { apiGet } = require('./fetchTennisApi.js');

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
  if (!body || typeof body.matchesCount !== 'number') return null;

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

async function buildFactorBrief({ tour = 'atp', nameA, nameB, playerAId, playerBId, tournamentId }) {
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

  return {
    h2h,
    playerA: { name: nameA, surface: surfA, form: formA, venue: venueA, ranking: rankA, tiers: tierA, load: loadA, ctx: ctxA, style: styleA, country: styleA ? styleA.country : null },
    playerB: { name: nameB, surface: surfB, form: formB, venue: venueB, ranking: rankB, tiers: tierB, load: loadB, ctx: ctxB, style: styleB, country: styleB ? styleB.country : null },
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
    if (h.serveA.wonFirstPct != null) {
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
    if (P.tiers) {
      const t = [];
      if (P.tiers.vsTop10) t.push(`top10 ${P.tiers.vsTop10}`);
      if (P.tiers.vsTop50) t.push(`top50 ${P.tiers.vsTop50}`);
      if (t.length) parts.push(`${P.tiers.year} vs ranked opposition: ${t.join(', ')}`);
    }
    if (parts.length) L.push(`${P.name.toUpperCase()}: ${parts.join(' | ')}`);
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
