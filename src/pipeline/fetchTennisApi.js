/**
 * fetchTennisApi.js — SportsAPI365 tennis client.
 *
 * Adds the tour levels The Odds API does not carry at all: ATP Challenger
 * and ITF. Verified live against the account:
 *
 *   Auth    X-Gravitee-Api-Key header (not Bearer, not x-api-key)
 *   Base    https://api.sportsapi365.com/v1/tennis
 *   Tiers   tournament.rankId -> 0 ITF, 1 Challenger, 3 main tour
 *   Dates   /{type}/fixtures/{YYYY-MM-DD} carries real UTC timestamps.
 *           The undated /{type}/fixtures does NOT — every date comes back
 *           null there, so always use the dated form.
 *   Tours   ITF comes through type=atp even though the docs say
 *           "itf is not supported as a type value".
 *
 * IMPORTANT — the gateway returns HTTP 200 for unknown routes and puts the
 * real status in the body. Status codes are therefore meaningless here and
 * every response must be validated on its content. That is exactly the
 * silent-failure shape that had the analysis pipeline skipping every live
 * match for hours, so it is handled explicitly below.
 */

const BASE = process.env.TENNIS_API_BASE || 'https://api.sportsapi365.com/v1/tennis';
const KEY = process.env.TENNIS_API_KEY || '';
const AUTH_HEADER = process.env.TENNIS_API_AUTH_HEADER || 'X-Gravitee-Api-Key';

const RANK = { 0: 'ITF', 1: 'Challenger', 2: 'ATP Tour', 3: 'ATP Masters/Slam' };

/** Tour levels to ingest. Defaults to Challenger + main tour: ITF is
 *  opt-in because it is the tier with the least research material and the
 *  worst integrity record, not because the data is missing. */
/* Default includes 4 — the majors. Leaving it out was half the reason
 * Grand Slams never reached the board. */
const TOUR_LEVELS = (process.env.TENNIS_TOUR_LEVELS || '0,1,2,3,4')
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));

function assertConfigured() {
  if (!KEY) throw new Error('TENNIS_API_KEY is not set');
}

/**
 * One request. Throws on a body-level error even when the transport said
 * 200 — see the gateway note above.
 */
async function apiGet(path, { timeoutMs = 12000 } = {}) {
  assertConfigured();
  const url = `${BASE}/${String(path).replace(/^\/+/, '')}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res, text;
  try {
    res = await fetch(url, { headers: { [AUTH_HEADER]: KEY }, signal: ctrl.signal });
    text = await res.text();
  } catch (err) {
    throw new Error(`[tennisApi] ${path} request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`[tennisApi] ${path} returned non-JSON: ${text.slice(0, 120)}`);
  }

  // Body-level failure, regardless of what the HTTP status claimed.
  const bodyStatus = body && (body.statusCode || body.status);
  if (body?.error === true || body?.success === false || (bodyStatus && bodyStatus >= 400)) {
    throw new Error(`[tennisApi] ${path} -> ${bodyStatus || 'error'}: ${body.message || body.code || 'unknown'}`);
  }
  if (!res.ok) throw new Error(`[tennisApi] ${path} -> HTTP ${res.status}`);

  // Some failures carry no flag and no status at all — the subscription
  // error is literally {"message":"You are not subscribed to this API."}.
  // A bare message with no payload is never a valid success response here,
  // so treat it as the failure it is rather than letting it through as data.
  const hasPayload = body && (body.data !== undefined || body.results !== undefined ||
                              Array.isArray(body) || body.success === true);
  if (!hasPayload && body?.message) {
    throw new Error(`[tennisApi] ${path} -> ${body.message}`);
  }

  return body;
}

/** Doubles rubbish up a singles board and are never analysed, so they are
 *  dropped at ingest. The feed marks a pair by joining both names with a
 *  slash and setting countryAcr to "N/A" — either signal is enough. */
function isDoubles(fx) {
  const n1 = fx?.player1?.name || '';
  const n2 = fx?.player2?.name || '';
  return n1.includes('/') || n2.includes('/') ||
         (fx?.player1?.countryAcr === 'N/A' && fx?.player2?.countryAcr === 'N/A');
}

/* TIER FROM THE TOURNAMENT NAME.
 *
 * `tournament.rankId` cannot be trusted: Cincinnati matches (Tiafoe v
 * Auger-Aliassime, Safiullin v Wawrinka) were stored as rankId 1 —
 * Challenger — which let main tour straight through a
 * TENNIS_TOUR_LEVELS=0,1 filter meant to exclude it. Since ESPN also
 * carries those matches, every one became a duplicate row, which is the
 * 7-8 duplicates the board has been collapsing all along.
 *
 * The tournament NAME is unambiguous and comes from the same payload:
 * ITF events are always coded (W15, M25), Challengers always say so.
 * Name first, rankId only as a fallback when the name says nothing. */
/* TIER FROM TOURNAMENT NAME.
 *
 * This was silently deleting the biggest events on the calendar.
 *
 * Two faults compounded. Grand Slams carry rankId 4, which was not in
 * TENNIS_TOUR_LEVELS (0,1,2,3), so Wimbledon and Roland Garros were
 * dropped as "off-level". And any tournament whose NAME matched no
 * keyword fell through to rankId — null for most main-tour stops — so
 * Metz, Chengdu, Tel Aviv and the ATP Finals disappeared too. Cincinnati
 * survived only by coincidence, because "Open" appears in its name.
 *
 * Ordered most specific first: a slam is matched by name before any
 * generic word in it can claim it.
 */
function tierFromName(name, rankId) {
  const n = String(name || '');

  // 4 — the majors and the season finals, by name rather than by a
  // rankId that is not always present.
  if (/wimbledon|roland\s*garros|french open|us open|australian open|grand\s*slam/i.test(n)) return 4;
  if (/(atp|wta)\s*finals|tour finals|world tour finals/i.test(n)) return 4;

  // 0 — ITF, matched before the generic keywords below so that
  // "W15 Cairo Open" is not mistaken for a tour-level Open.
  if (/\b[WM]\d{2,3}\b/.test(n) || /\bitf\b/i.test(n)) return 0;

  // 1 — Challenger.
  if (/challenger/i.test(n)) return 1;

  // 3 — Masters and the main-tour naming conventions.
  if (/masters|open|cup|championship|classic|international/i.test(n)) return 3;

  /* Unknown name: fall back to rankId, but NEVER to null.
   *
   * An unrecognised tournament used to become null and was then excluded
   * by the level filter — so the failure mode of "we don't recognise
   * this name" was "delete the event". For a main-tour stop with a plain
   * city name (Metz, Chengdu) that is exactly wrong. Defaulting to 3
   * means an unknown event is treated as tour level and shown; being
   * wrong that way costs a stray fixture, not a missing Grand Slam. */
  if (typeof rankId === 'number') return rankId;
  return 3;
}

function shapeFixture(fx, tourType) {
  const rankId = fx?.tournament?.rankId;
  return {
    sourceId: `sa365:${fx.id}`,
    externalId: fx.id,
    tour: tourType,
    startTime: fx.date ? new Date(fx.date) : null,
    competitorA: fx.player1?.name || null,
    competitorB: fx.player2?.name || null,
    countryA: fx.player1?.countryAcr || null,
    countryB: fx.player2?.countryAcr || null,
    playerAId: fx.player1Id ?? null,
    playerBId: fx.player2Id ?? null,
    league: fx.tournament?.name || null,
    tournamentId: fx.tournamentId ?? null,
    tourLevel: tierFromName(fx?.tournament?.name, rankId),
    tourLevelName: RANK[tierFromName(fx?.tournament?.name, rankId)] || 'Unknown',
    roundId: fx.roundId ?? null,

    /* `live` is the only complete lifecycle signal we get.
     *
     * Promotion to live came from two places, and neither covers lower
     * tiers: ESPN scores (main tour only) and the socket all-feed (a
     * handful of events at a time — it reported 4 while dozens were
     * scheduled). So Challenger and ITF matches sat on "Starting…" and
     * were never marked live at all.
     *
     * This field is on EVERY fixture in the daily list, so it covers the
     * whole slate. Shape is unknown beyond `null` when not started —
     * kept raw here and interpreted by the caller rather than guessed
     * at. */
    live: fx.live ?? null,
    timeGame: fx.timeGame ?? null,
    seedA: fx.seed1 || null,
    seedB: fx.seed2 || null,
  };
}

/**
 * Singles fixtures for one calendar day, across the tour levels enabled.
 * Pages until exhausted; `hasNextPage` drives the loop.
 */
async function fetchFixturesForDate(dateStr, { tours = ['atp', 'wta'], pageSize = 100, maxPages = 20 } = {}) {
  const out = [];
  const skipped = { doubles: 0, level: 0, noStart: 0, levelNames: new Set() };

  for (const tourType of tours) {
    for (let page = 1; page <= maxPages; page++) {
      let body;
      try {
        body = await apiGet(`${tourType}/fixtures/${dateStr}?include=tournament&pageSize=${pageSize}&pageNo=${page}`);
      } catch (err) {
        // One tour failing must not take the whole day's slate with it.
        console.warn(`[tennisApi] ${tourType} ${dateStr} page ${page}: ${err.message}`);
        break;
      }

      const rows = Array.isArray(body?.data) ? body.data : [];
      for (const fx of rows) {
        if (isDoubles(fx)) { skipped.doubles++; continue; }
        const fxTier = tierFromName(fx?.tournament?.name, fx?.tournament?.rankId);
        if (!TOUR_LEVELS.includes(fxTier)) {
          skipped.level++;
          // Record WHICH tournaments were excluded. "18 off-level" hid
          // the loss of every Grand Slam behind a bare number.
          const tn = fx?.tournament?.name;
          if (tn) skipped.levelNames.add(`${tn} (tier ${fxTier})`);
          continue;
        }
        if (!fx.date) { skipped.noStart++; continue; }
        out.push(shapeFixture(fx, tourType));
      }

      if (!body?.hasNextPage || !rows.length) break;
    }
  }

  out.sort((a, b) => a.startTime - b.startTime);
  console.log(`[tennisApi] ${dateStr}: ${out.length} singles (skipped ${skipped.doubles} doubles, ${skipped.level} off-level, ${skipped.noStart} undated)`);
  if (skipped.levelNames.size) {
    console.log(`[tennisApi] ${dateStr}: excluded tournaments: ${[...skipped.levelNames].join(', ')}`);
  }
  return out;
}

/** Today and tomorrow in UTC, which is the window the pipeline analyses. */
async function fetchUpcomingFixtures(opts = {}) {
  const days = [0, 1].map((offset) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  });
  const all = [];
  for (const day of days) all.push(...await fetchFixturesForDate(day, opts));
  return all;
}

/**
 * Head-to-head. This is one of the twelve weighted factors and is currently
 * researched by web search, which is slow and inconsistent — a structured
 * H2H record is a straight upgrade to that factor's input.
 */
async function fetchH2H(tourType, player1, player2, { full = true } = {}) {
  const p1 = encodeURIComponent(player1);
  const p2 = encodeURIComponent(player2);
  return apiGet(`h2h/profile/${tourType}/${p1}/${p2}/${full ? 'false' : 'true'}`);
}

/**
 * PREGAME / OPENING ODDS.
 *
 * Lives under the `upcoming` group, not `extend/api` — which is why every
 * probe of /extend/api/odds/* came back empty. Takes the four ids as QUERY
 * parameters rather than a composite path segment:
 *
 *   /upcoming/matchodds/{atp|wta}
 *     ?player1Id=&player2Id=&tournamentId=&roundId=
 *
 * Response is one entry per bookmaker, confirmed live:
 *   { id_b_o: "1", k1: 1.45, k2: 2.74, ... }
 *
 *   id_b_o   bookmaker id (matches /extend/api/bookmakers/all)
 *   k1 / k2  DECIMAL moneyline for player1 / player2
 *   f1,kf1   handicap line and price; ktb/ktm over/under; k20..k03 set score
 *
 * Only the moneyline is taken here — that is what the pipeline grades on.
 */
const PREFERRED_BOOKS = (process.env.TENNIS_ODDS_BOOKS || '19,1,11,20')
  .split(',').map((s) => s.trim()).filter(Boolean); // Pinnacle, Bet365, DraftKings, Marathon

function decToAmerican(dec) {
  const d = Number(dec);
  if (!Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

/**
 * Opening moneyline for one fixture. Returns null when no book has priced
 * it — a real state for a fixture posted before the market opens, not an
 * error.
 */
async function fetchMatchOdds({ tour = 'atp', player1Id, player2Id, tournamentId, roundId }) {
  if (!player1Id || !player2Id || !tournamentId || roundId === undefined || roundId === null) return null;

  const qs = `player1Id=${player1Id}&player2Id=${player2Id}&tournamentId=${tournamentId}&roundId=${roundId}`;
  let body;
  try {
    body = await apiGet(`upcoming/matchodds/${tour}?${qs}`);
  } catch (err) {
    return null; // no price yet, or the tour/round combination isn't carried
  }

  const rows = Array.isArray(body?.odds) ? body.odds.filter(Boolean) : [];
  if (!rows.length) return null;

  // Prefer a sharp book when present. Pinnacle first: its price is the
  // best available read on true probability, which is what the blend
  // wants to weigh the model against.
  let chosen = null;
  for (const want of PREFERRED_BOOKS) {
    chosen = rows.find((r) => String(r.id_b_o) === want);
    if (chosen) break;
  }
  if (!chosen) chosen = rows[0];

  const oddsA = decToAmerican(chosen.k1);
  const oddsB = decToAmerican(chosen.k2);
  if (oddsA === null || oddsB === null) return null;

  /* BEST PRICE ACROSS BOOKS.
   *
   * `chosen` is a single preferred bookmaker, used for the blend because
   * a consistent book is the cleaner probability signal. But the rest of
   * the rows were thrown away, and The Odds API used to give us
   * bestOddsA/B across books — so switching tennis to this source
   * silently ended line shopping.
   *
   * The highest decimal price is the best available: it pays the most
   * per unit staked. Reported alongside the reference book so the blend
   * keeps using one book while the member sees the best number they
   * could actually take. */
  let bestA = null, bestB = null, bestBookA = null, bestBookB = null;
  for (const r of rows) {
    const da = Number(r.k1), db = Number(r.k2);
    if (Number.isFinite(da) && da > 1 && (bestA === null || da > bestA)) { bestA = da; bestBookA = String(r.id_b_o); }
    if (Number.isFinite(db) && db > 1 && (bestB === null || db > bestB)) { bestB = db; bestBookB = String(r.id_b_o); }
  }

  return {
    oddsA,
    oddsB,
    decimalA: Number(chosen.k1),
    decimalB: Number(chosen.k2),
    bookmakerId: String(chosen.id_b_o),
    bookCount: rows.length,
    bestOddsA: bestA === null ? null : decToAmerican(bestA),
    bestOddsB: bestB === null ? null : decToAmerican(bestB),
    bestBookA,
    bestBookB,
  };
}

/**
 * UPCOMING EVENTS, priced. Keyed by `event_id` — the same id space the
 * live feed uses, NOT the composite {p1}-{p2}-{tour}-{round}. That
 * mismatch is why /extend/api/odds/match/{composite} kept returning
 * "No odds found": right group, wrong key.
 *
 *   { id: "3841355", name, participant1, participant2, league,
 *     tourType, matchId, startTimestamp, status: "Not Started" }
 */
async function fetchUpcomingEvents(tour = 'atp') {
  const body = await apiGet(`extend/api/events/upcoming/${tour}`);
  const rows = Array.isArray(body?.results) ? body.results : [];
  return rows.map((e) => ({
    eventId: String(e.id),
    matchId: e.matchId || null,
    competitorA: e.participant1 || null,
    competitorB: e.participant2 || null,
    league: e.league || null,
    tour: e.tourType || tour,
    status: e.status || null,
    startTime: e.startTimestamp ? new Date(e.startTimestamp * 1000) : null,
  })).filter((e) => e.competitorA && e.competitorB);
}

/**
 * Pre-match odds for one event. Confirmed working on Challenger AND ITF,
 * which is what makes lower-tier picks possible at all:
 *
 *   { result: { "Full Time Result": [
 *       { marketId: 1, bookmaker: "Bet365", od1: "1.180", od2: "4.500",
 *         addTime: "1787240698", line: null } ], ... } }
 *
 * od1/od2 are DECIMAL prices for participant1/participant2. Other markets
 * (Over Under, Correct Score, Match Handicap Games) come in the same
 * response and are available later — only the moneyline is taken here,
 * because that is what the pipeline grades on.
 */
/**
 * Resolve one of OUR stored rows to an extend-space event id.
 *
 * The provider runs two disjoint id spaces. Fixtures (what we ingest and
 * store as `sa365:1466`) live in core space. Odds live in extend space
 * (`3841355`). Nothing in a fixture payload carries its extend id, so a
 * stored row has no route to a price without this lookup.
 *
 * `extend/api/event/get/{p1}/{p2}/{date}` bridges the two by name. It
 * only resolves matches that exist in extend space, so a null here is a
 * real answer — that match simply isn't priced — not an error.
 */
async function resolveExtendId(competitorA, competitorB, startTime) {
  if (!competitorA || !competitorB || !startTime) return null;
  const date = new Date(startTime).toISOString().slice(0, 10);
  const p1 = encodeURIComponent(competitorA.trim());
  const p2 = encodeURIComponent(competitorB.trim());

  for (const [a, b] of [[p1, p2], [p2, p1]]) { // feed may list either side first
    let body;
    try {
      body = await apiGet(`extend/api/event/get/${a}/${b}/${date}`);
    } catch {
      continue;
    }
    const row = body?.results || body?.result || body;
    const r = Array.isArray(row) ? row[0] : row;
    if (r?.id) {
      /* Return the STATUS too, not just the id.
       *
       * This response is the only place that tells us a lower-tier match
       * has finished — it carries status "Ended" plus a final score. We
       * were throwing that away and returning a bare id, so finished
       * matches stayed `scheduled`, were re-offered for analysis every
       * cycle, found no pre-match odds (naturally — they were over), and
       * were counted as "not yet priced". That is most of the 37. */
      return { id: String(r.id), status: r.status || null, score: r.score || null };
    }
  }
  return null;
}

/**
 * Final result for a completed match, looked up by PLAYER id.
 *
 * The reason this exists: nothing else covers every tier. The fixtures
 * feed's `live` field is null even for matches that have finished (checked
 * against a completed fixture), and the extend feed holds only a handful
 * of events. With ESPN off for tennis, a Challenger or ITF match had no
 * route to a final score at all — it closed unscored and could never be
 * graded.
 *
 * `h2h/recent/{tour}/{playerId}` returns that player's recent matches
 * across ALL tiers, each with the score, both player ids and `isWin`
 * RELATIVE TO THE QUERIED PLAYER (verified: Safiullin v Djokovic reads
 * isWin false, Safiullin v Wawrinka reads isWin true). Matching on
 * opponent id avoids name matching entirely.
 *
 * Results lag — a match finished minutes ago may not be listed yet. That
 * is fine: the caller retries on later cycles.
 *
 * Returns { score, queriedPlayerWon, date } or null.
 */
/**
 * ATP/WTA rankings for one publication date.
 *
 * Quirks confirmed against the live API, all of which differ from every
 * other endpoint here:
 *   - date format is DD.MM.YYYY, not the ISO YYYY-MM-DD used elsewhere
 *   - `group` is required and must be the string "singles"
 *   - an unpublished date returns [] rather than an error, so an empty
 *     result is "no ranking that week", not a failure
 *
 * Returns the raw array, newest position first.
 */
async function fetchRankingsForDate(tour, date) {
  const d = new Date(date);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();

  let body;
  try {
    body = await apiGet(`ranking/${tour}?date=${dd}.${mm}.${yyyy}&group=singles`);
  } catch {
    return [];
  }
  return Array.isArray(body) ? body : [];
}

/**
 * The most recent PUBLISHED rankings.
 *
 * Rankings land on Mondays, but not every Monday has one — 17.08.2026
 * came back empty while 10.08.2026 was full. Asking for "this Monday"
 * would therefore show an empty table for part of each week, so we walk
 * back until we find a week that exists.
 *
 * Cached in memory: this changes once a week at most, and the page would
 * otherwise re-request 100 rows on every visit.
 */
const rankingCache = new Map();   // tour -> { at, date, rows }
const RANKING_TTL_MS = 6 * 60 * 60 * 1000;

async function fetchLatestRankings(tour, { maxWeeksBack = 6 } = {}) {
  const cached = rankingCache.get(tour);
  if (cached && Date.now() - cached.at < RANKING_TTL_MS) return cached;

  // Start from the most recent Monday, inclusive of today if it is one.
  const now = new Date();
  const day = now.getUTCDay();                 // 0 Sun .. 6 Sat
  const back = day === 0 ? 6 : day - 1;        // days since Monday
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back));

  for (let i = 0; i < maxWeeksBack; i++) {
    const probe = new Date(monday.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    const rows = await fetchRankingsForDate(tour, probe);
    if (rows.length) {
      const out = { at: Date.now(), date: probe.toISOString().slice(0, 10), rows };
      rankingCache.set(tour, out);
      return out;
    }
  }

  return { at: Date.now(), date: null, rows: [] };
}

/**
 * Everything a player profile needs, from three endpoints.
 *
 * There is no single player endpoint — `/{tour}/player/{id}` 404s. The
 * biography actually lives inside h2h/recent's player object (birthday,
 * currentRank, points, career high, prize money), which is also where
 * recent matches come from, so one call covers both.
 *
 * FIELD MEANINGS, verified against Sinner's 2024 season rather than
 * assumed from the names:
 *   aw / al            = wins / losses  (2024 total 73-6, correct)
 *   levelFinals.<lvl>.w = TITLES won at that level (2024: 3 Masters,
 *                        2 Slams — both correct)
 *   levelFinals.total   = NOT finals. It duplicates the season W-L, so
 *                        it is deliberately ignored below.
 */
/* Absolute URL for a player headshot.
 *
 * The API returns image paths like "/tennis/api2/uploads/Photo/atp/47275.jpg".
 * Those resolve under https://api.sportsapi365.com/v1 — and, unusually
 * for this API, they need NO key, so the browser can load them directly
 * rather than proxying every image through us.
 */
const IMAGE_BASE = 'https://api.sportsapi365.com/v1';

function playerImageUrl(path) {
  if (!path || typeof path !== 'string') return null;
  return path.startsWith('http') ? path : `${IMAGE_BASE}${path}`;
}

/**
 * Head-to-head between two players: both profiles plus the match-up
 * statistics accumulated across their meetings.
 *
 * Two endpoints because they carry different things — `h2h/profile` has
 * the players (career, YTD, form, images), `h2h/stats` has the serve,
 * return, tiebreak and deciding-set splits BETWEEN them specifically.
 *
 * NOTE ON THE RECORD: the two disagree. h2h/stats reports matchesWon 7
 * and 9 (16) while matchesCount says 17 and surfaceData totals 7 and 10.
 * surfaceData reconciles with matchesCount, so it is used for the
 * headline record; the discrepancy is most likely a walkover counted in
 * one place and not the other.
 */
async function fetchH2HFull(tour, id1, id2) {
  const [profile, stats] = await Promise.all([
    apiGet(`h2h/profile/${tour}/${id1}/${id2}/false`).catch(() => null),
    apiGet(`h2h/stats/${tour}/${id1}/${id2}`).catch(() => null),
  ]);
  if (!profile && !stats) return null;

  const shapePlayer = (pl) => {
    if (!pl) return null;
    return {
      id: pl.id,
      name: pl.name,
      country: pl.contryAcr || null,          // sic — misspelled at source
      countryName: pl.country || null,
      image: playerImageUrl(pl.image),
      rank: pl.currentRank ?? null,
      bestRank: pl.bestRank ?? null,
      plays: pl.plays || null,
      birthday: pl.birthday || null,
      ytd: { wins: pl.ytdWon ?? null, losses: pl.ytdLost ?? null,
             pct: pl.ytdWLPercentage ?? null, titles: pl.ytdTitles ?? null },
      career: { wins: pl.careerWin ?? null, losses: pl.careerLose ?? null,
                pct: pl.careerWLPercentage ?? null, titles: pl.totalTitles ?? null },
      // Oldest-first in the payload; reversed so the most recent match
      // reads left-to-right like every other form guide.
      form: Array.isArray(pl.recentGames) ? [...pl.recentGames].reverse() : [],
    };
  };

  const sd = profile?.surfaceData || stats?.surfaceData || {};
  const s1 = stats?.player1 || {};
  const s2 = stats?.player2 || {};

  const splits = (a, b) => ([
    { label: 'Matches won',      a: a.matchesWon,                  b: b.matchesWon },
    { label: '1st serve won',    a: a.winningOnFirstServePercentage,  b: b.winningOnFirstServePercentage, pct: true },
    { label: '2nd serve won',    a: a.winningOnSecondServePercentage, b: b.winningOnSecondServePercentage, pct: true },
    { label: 'Return pts won',   a: a.returnPtsWinPercentage,      b: b.returnPtsWinPercentage, pct: true },
    { label: 'Break pts won',    a: a.breakpointsWonPercentage,    b: b.breakpointsWonPercentage, pct: true },
    { label: 'Tiebreaks won',    a: a.tiebreakWon,                 b: b.tiebreakWon },
    { label: 'Deciding sets',    a: a.decidingSetWin,              b: b.decidingSetWin },
    { label: 'Aces',             a: a.acesCount,                   b: b.acesCount },
    { label: 'Double faults',    a: a.doubleFaultsCount,           b: b.doubleFaultsCount, lowerIsBetter: true },
    { label: 'Sets won',         a: a.setsWon,                     b: b.setsWon },
  ]);

  return {
    player1: shapePlayer(profile?.player1),
    player2: shapePlayer(profile?.player2),
    meetings: stats?.matchesCount ?? null,
    record: { p1: sd.total1 ?? null, p2: sd.total2 ?? null },
    surfaces: [
      { court: 'Hard',   p1: sd.hard1 ?? 0,  p2: sd.hard2 ?? 0 },
      { court: 'Clay',   p1: sd.clay1 ?? 0,  p2: sd.clay2 ?? 0 },
      { court: 'Grass',  p1: sd.grass1 ?? 0, p2: sd.grass2 ?? 0 },
      { court: 'Indoor', p1: sd.iHard1 ?? 0, p2: sd.iHard2 ?? 0 },
    ].filter((r) => r.p1 || r.p2),
    splits: (stats ? splits(s1, s2) : []).filter((r) =>
      r.a !== undefined && r.a !== null && r.b !== undefined && r.b !== null),
    avgMatchTime: s1.avgTime || null,
  };
}

async function fetchPlayerProfile(tour, playerId) {
  const id = encodeURIComponent(playerId);

  /* The name-keyed endpoints are a SEPARATE family from the id-keyed
   * ones, and richer in places: /profile/{name} splits backhand out as
   * its own field, /interesting gives notable rivalries with H2H
   * records, /finals/{year} lists actual titles with surface and venue.
   *
   * They key on the exact display NAME, which is why the name is looked
   * up from the id-based data first rather than passed in from our own
   * Match rows — our stored names differ in accents and word order, and
   * that mismatch is what broke matching repeatedly elsewhere. */
  const [recent, surfaces, perf, prof] = await Promise.all([
    apiGet(`h2h/recent/${tour}/${id}`).catch(() => null),
    apiGet(`${tour}/player/surface-summary/${id}`).catch(() => null),
    apiGet(`${tour}/player/perf-breakdown/${id}`).catch(() => null),
    apiGet(`${tour}/player/profile/${id}`).catch(() => null),
  ]);

  if (!recent && !surfaces && !perf && !prof) return null;

  /* Biographical detail: coach, handedness, birthplace, physique.
   *
   * NOT taken from this endpoint: `points`. It reports 3350 for Sinner
   * where the rankings feed says 13450 — a different measure entirely
   * (race points, most likely). Mixing the two would put a number on the
   * profile that contradicts the ranking table one click away.
   *
   * The social fields are scrambled at source: `twitter` holds an
   * atptour.com URL, `page` holds x.com, `instagram` holds facebook.com,
   * `facebook` holds instagram.com. Rather than trust the labels, links
   * are sorted by what the URL actually points at. */
  const info = prof?.data?.information || {};
  const socialRaw = [info.twitter, info.page, info.instagram, info.facebook, info.site]
    .filter((u) => typeof u === 'string' && u.startsWith('http'));
  const pickSocial = (re) => socialRaw.find((u) => re.test(u)) || null;

  // The bio sits on whichever side of a recent match is our player.
  let bio = null;
  const games = Array.isArray(recent?.games) ? recent.games : [];
  for (const g of games) {
    if (String(g.player1?.id) === String(playerId)) { bio = g.player1; break; }
    if (String(g.player2?.id) === String(playerId)) { bio = g.player2; break; }
  }

  /* Second round of calls, keyed on the resolved name. Only attempted
   * once we actually have a name — without one these would 404. */
  const displayName = bio?.name || recent?.name || prof?.data?.name || null;
  const thisYear = new Date().getFullYear();

  const [rivalries, finals] = displayName
    ? await Promise.all([
        apiGet(`profile/${encodeURIComponent(displayName)}/interesting`).catch(() => null),
        apiGet(`profile/${encodeURIComponent(displayName)}/finals/${thisYear}`).catch(() => null),
      ])
    : [null, null];

  const years = perf?.data || {};
  const yearKeys = Object.keys(years).sort((a, b) => Number(b) - Number(a));

  // Career totals, summed from the per-year level totals.
  let careerW = 0, careerL = 0, titles = 0, slams = 0, masters = 0;
  for (const y of yearKeys) {
    const lv = years[y]?.level?.total || {};
    careerW += Number(lv.aw || 0);
    careerL += Number(lv.al || 0);
    const f = years[y]?.levelFinals || {};
    // total is skipped on purpose — see the note above.
    for (const key of ['masters', 'tourFinals', 'mainTour', 'grandSlam', 'challengers', 'futures', 'cups']) {
      titles += Number(f[key]?.w || 0);
    }
    slams += Number(f.grandSlam?.w || 0);
    masters += Number(f.masters?.w || 0);
  }

  const currentYear = yearKeys[0];
  const cy = years[currentYear] || {};

  return {
    playerId: Number(playerId),
    name: bio?.name || recent?.name || null,
    country: bio?.countryAcr || null,
    // Headshot, from the same public path h2h/profile exposes. Built by
    // convention rather than returned here, so it is verified before use
    // on the client (a missing file falls back to initials).
    image: playerImageUrl(`/tennis/api2/uploads/Photo/${tour}/${playerId}.jpg`),
    birthday: bio?.birthday || null,
    currentRank: bio?.currentRank ?? null,
    careerHigh: bio?.ch ?? null,
    points: bio?.points ?? null,
    prize: bio?.prize ?? null,

    // From player/profile — the detail that makes this read like a
    // profile rather than a stat dump.
    status: prof?.data?.playerStatus || null,
    coach: prof?.data?.coach || info.coach || null,
    turnedPro: info.turnedPro || null,
    heightCm: info.height ? Number(info.height) : null,
    weightKg: info.weight ? Number(info.weight) : null,
    birthplace: info.birthplace || null,
    residence: info.residence || null,
    plays: info.plays || null,
    // The name-keyed profile splits this out; the id-keyed one folds it
    // into `plays` as one string.
    backhand: prof?.data?.information?.backhand || null,
    careerMoney: prof?.data?.careerMoney ?? null,
    links: {
      atp: pickSocial(/atptour\.com|wtatennis\.com/i),
      x: pickSocial(/x\.com|twitter\.com/i),
      instagram: pickSocial(/instagram\.com/i),
      facebook: pickSocial(/facebook\.com/i),
    },

    career: { wins: careerW, losses: careerL, titles, slams, masters },

    /* Notable rivalries — the H2H records against the opponents this
     * player has met most. "13-0 vs De Minaur" says more about a player
     * than another aggregate win rate does. */
    rivalries: (Array.isArray(rivalries) ? rivalries : []).slice(0, 8).map((r) => {
      const [w, l] = String(r.h2h || '').split('-').map(Number);
      return {
        opponent: r.opponent || null,
        wins: isNaN(w) ? null : w,
        losses: isNaN(l) ? null : l,
        record: r.h2h || null,
      };
    }).filter((r) => r.opponent),

    // Titles won this year, with where and on what.
    titlesThisYear: (finals?.titles || []).map((t) => ({
      name: t.name || null,
      court: t.court || null,
      country: t.country?.acronym || null,
      date: t.date || null,
    })).sort((a, b) => new Date(a.date) - new Date(b.date)),

    season: {
      year: currentYear ? Number(currentYear) : null,
      wins: Number(cy.level?.total?.aw || 0),
      losses: Number(cy.level?.total?.al || 0),
      // Record against ranked opposition — the number that separates a
      // top-10 player from someone padding a record on lower tiers.
      vsTop10: { wins: Number(cy.rank?.top10?.aw || 0), losses: Number(cy.rank?.top10?.al || 0) },
      vsTop50: { wins: Number(cy.rank?.top50?.aw || 0), losses: Number(cy.rank?.top50?.al || 0) },
    },

    surfaces: (surfaces?.data || []).map((row) => ({
      year: row.year,
      courts: (row.surfaces || []).map((c) => ({
        court: c.court, wins: c.courtWins, losses: c.courtLosses,
      })),
    })),

    recent: games.slice(0, 10).map((g) => {
      const meIsP1 = String(g.player1Id) === String(playerId);
      const opp = meIsP1 ? g.player2 : g.player1;
      return {
        date: g.date,
        opponent: opp?.name || null,
        opponentId: opp?.id ?? null,
        opponentRank: opp?.currentRank ?? null,
        score: g.result || null,
        won: g.isWin === true,
        tournament: g.tournament?.name || null,
        tier: g.tournament?.tier || null,
        // Decimal odds as they stood — useful context on the profile and
        // the only place this API surfaces a historical price.
        odds: meIsP1 ? g.odd1 : g.odd2,
      };
    }),
  };
}

async function fetchPlayerRecentResult(tour, playerId, opponentId, startTime) {
  if (!playerId || !opponentId) return null;

  let body;
  try {
    body = await apiGet(`h2h/recent/${tour}/${encodeURIComponent(playerId)}`);
  } catch {
    return null;
  }

  const games = Array.isArray(body?.games) ? body.games : [];
  if (!games.length) return null;

  const want = String(opponentId);
  const target = startTime ? new Date(startTime).getTime() : null;

  const candidates = games.filter((g) => {
    const p1 = String(g.player1Id), p2 = String(g.player2Id);
    if (p1 !== want && p2 !== want) return false;
    if (!g.result) return false;                 // not finished / no score
    if (target === null || !g.date) return true;
    // Same fixture, allowing for the feed's own date being day-precision.
    return Math.abs(new Date(g.date).getTime() - target) < 36 * 60 * 60 * 1000;
  });
  if (!candidates.length) return null;

  // Closest in time when a pair has met more than once.
  if (target !== null) {
    candidates.sort((a, b) =>
      Math.abs(new Date(a.date) - target) - Math.abs(new Date(b.date) - target));
  }
  const g = candidates[0];

  return {
    score: String(g.result),
    queriedPlayerWon: g.isWin === true,
    date: g.date || null,
  };
}

async function fetchPreMatchOdds(eventId) {
  let body;
  try {
    body = await apiGet(`extend/api/odds/pre-match/${encodeURIComponent(eventId)}`);
  } catch {
    return null; // not priced yet — a real state, not a failure
  }

  const rows = body?.result?.['Full Time Result'];
  if (!Array.isArray(rows) || !rows.length) return null;

  // Prefer a sharp book if the response carries one.
  const prefer = (process.env.TENNIS_ODDS_BOOKS || 'Pinnacle,Bet365,DraftKings')
    .split(',').map((b) => b.trim().toLowerCase());
  let chosen = null;
  for (const want of prefer) {
    chosen = rows.find((r) => String(r.bookmaker || '').toLowerCase() === want);
    if (chosen) break;
  }
  if (!chosen) chosen = rows[0];

  const oddsA = decToAmerican(chosen.od1);
  const oddsB = decToAmerican(chosen.od2);
  if (oddsA === null || oddsB === null) return null;

  return {
    oddsA,
    oddsB,
    bookmaker: chosen.bookmaker || null,
    addTime: chosen.addTime ? new Date(Number(chosen.addTime) * 1000) : null,
  };
}

/** Bookmaker directory. Confirmed working; Pinnacle is id 19 and is the
 *  one worth having — a sharp reference price says whether a BetMGM line
 *  is genuinely wrong or merely slow. */
async function fetchBookmakers() {
  const body = await apiGet('extend/api/bookmakers/all');
  return Array.isArray(body?.results) ? body.results : [];
}

/**
 * LIVE EVENTS — confirmed working, and better than the ESPN feed it
 * supplements.
 *
 * ESPN gives games and sets. This gives the score WITHIN the current game
 * ("30-15") and which player is serving, via `indicator` ("1,0" = player 1
 * on serve). The DIP alert currently infers a break from a two-game lead;
 * with this it can see an actual break point as it happens.
 *
 * Note the ids here are NOT the Core API's fixture ids — a live event
 * carries its own `id` plus a composite `matchId`. Joining the two sources
 * therefore has to go through player names, which is what namesLikelyMatch
 * already does elsewhere in the pipeline.
 */
function parseLiveEvent(ev) {
  // "6-3,2-1" -> completed sets plus the set in progress.
  const sets = String(ev.score || '').split(',').map((s) => s.trim()).filter(Boolean);
  const current = sets[sets.length - 1] || '';
  const [gamesA, gamesB] = current.split('-').map((n) => parseInt(n, 10));

  // indicator "1,0" means player 1 is serving; "0,1" means player 2.
  const ind = String(ev.indicator || '').split(',');
  const serving = ind[0] === '1' ? 'A' : ind[1] === '1' ? 'B' : null;

  // points "30-15", or "40-A" for advantage.
  const [ptsA, ptsB] = String(ev.points || '').split('-').map((s) => s.trim());

  let setsWonA = 0, setsWonB = 0;
  for (const set of sets.slice(0, -1)) {
    const [a, b] = set.split('-').map((n) => parseInt(n, 10));
    if (Number.isFinite(a) && Number.isFinite(b)) { if (a > b) setsWonA++; else if (b > a) setsWonB++; }
  }

  return {
    liveId: ev.id,
    matchId: ev.matchId || null,
    competitorA: ev.participant1 || ev.player1?.name || null,
    competitorB: ev.participant2 || ev.player2?.name || null,
    league: ev.league || ev.tournament?.name || null,
    tour: ev.tourType || null,
    status: ev.status || null,
    setScore: ev.score || null,
    setsWonA,
    setsWonB,
    gamesA: Number.isFinite(gamesA) ? gamesA : null,
    gamesB: Number.isFinite(gamesB) ? gamesB : null,
    pointsA: ptsA || null,
    pointsB: ptsB || null,
    serving,
    startTime: ev.startTimestamp ? new Date(ev.startTimestamp * 1000) : null,
  };
}

/**
 * A break point against the server, detected from real point state rather
 * than inferred from the games column. This is the signal the DIP alert
 * has been approximating.
 */
function breakPointAgainst(live) {
  if (!live.serving || !live.pointsA || !live.pointsB) return null;
  const receiverPts = live.serving === 'A' ? live.pointsB : live.pointsA;
  const serverPts = live.serving === 'A' ? live.pointsA : live.pointsB;
  const atBreakPoint = receiverPts === 'A' || (receiverPts === '40' && serverPts !== '40' && serverPts !== 'A');
  return atBreakPoint ? (live.serving === 'A' ? 'B' : 'A') : null;
}

async function fetchLiveEvents() {
  const body = await apiGet('extend/api/events/live');
  const rows = Array.isArray(body?.results) ? body.results : [];
  return rows.map(parseLiveEvent);
}

/**
 * Odds. The endpoint path is NOT yet confirmed — the documented groups we
 * probed all 404'd at the body level, and the docs' own group selector
 * (Predictions / Live) has not been read. Rather than hardcode a guess,
 * the path is supplied by env and validated on first use.
 *
 * Set TENNIS_ODDS_PATH with {id} as the placeholder, e.g.
 *   TENNIS_ODDS_PATH=extend/api/events/{id}/odds
 */
async function fetchOdds(eventId) {
  const template = process.env.TENNIS_ODDS_PATH;
  if (!template) return null; // Not configured: caller keeps its existing source.
  return apiGet(template.replace('{id}', encodeURIComponent(eventId)));
}

/**
 * Path finder for the odds endpoint. Probes candidates and reports which
 * return real data, so the correct value for TENNIS_ODDS_PATH can be found
 * without another round of manual curl.
 */
async function discoverOddsPath(sampleEventId) {
  const candidates = [
    'extend/api/odds/{id}', 'extend/api/events/{id}/odds', 'extend/api/matches/{id}/odds',
    'extend/api/event/{id}/odds', 'extend/api/match/{id}/odds', 'extend/api/odds/event/{id}',
    'extend/api/odds/match/{id}', 'extend/api/live/odds/{id}', 'extend/api/prematch/odds/{id}',
    'predictions/odds/{id}', 'upcoming/matches/{id}/odds', 'stats/odds/{id}',
  ];
  const hits = [];
  for (const c of candidates) {
    const path = c.replace('{id}', sampleEventId);
    try {
      const body = await apiGet(path);
      hits.push({ path: c, sample: JSON.stringify(body).slice(0, 300) });
      console.log(`[tennisApi] ODDS HIT  ${c}`);
    } catch {
      /* expected for wrong paths */
    }
  }
  if (!hits.length) console.log('[tennisApi] no odds path found among candidates');
  return hits;
}

module.exports = {
  fetchH2HFull,
  playerImageUrl,
  fetchPlayerProfile,
  fetchLatestRankings,
  fetchRankingsForDate,
  fetchPlayerRecentResult,
  tierFromName,
  resolveExtendId,
  apiGet,
  fetchUpcomingEvents,
  fetchPreMatchOdds,
  fetchMatchOdds,
  decToAmerican,
  fetchLiveEvents,
  parseLiveEvent,
  breakPointAgainst,
  fetchFixturesForDate,
  fetchUpcomingFixtures,
  fetchH2H,
  fetchBookmakers,
  fetchOdds,
  discoverOddsPath,
  isDoubles,
  shapeFixture,
  RANK,
};
