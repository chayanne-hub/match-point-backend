/**
 * tennisApi.js — full SportsAPI365 client.
 *
 * Covers every endpoint worth wiring (sections 1–8 of the endpoint map).
 * Deliberately excluded: match-prediction (their model, kept as a
 * benchmark only — see logBenchmark below), and the duplicate/dead routes.
 *
 * THREE THINGS THIS API DOES THAT BREAK NAIVE CLIENTS
 *
 * 1. The gateway returns HTTP 200 for unknown routes, with the real status
 *    buried in the body. `res.ok` is meaningless here. Every response is
 *    validated on CONTENT.
 * 2. The same data is exposed name-keyed, id-keyed and type-scoped. Mixing
 *    schemes is how you end up with two code paths that disagree about who
 *    a player is. Each group below states which scheme it uses.
 * 3. Rate limits bite at slate scale. A per-match endpoint on a 120-match
 *    slate is 120 requests a cycle, so caching is not an optimisation
 *    here, it is the difference between working and not.
 *
 * PARSERS: where a response shape has been confirmed against a real
 * payload it is normalised. Where it has NOT, the raw body is returned and
 * the function is marked UNVERIFIED. Run probe-endpoints.js and fill those
 * in rather than guessing — guessing at shapes is what caused the last
 * several bugs in this pipeline.
 */

const KEY = process.env.TENNIS_API_KEY || '';
const BASE = process.env.TENNIS_API_BASE || 'https://api.sportsapi365.com/v1/tennis';

/* ------------------------------------------------------------------ *
 * CACHE — keyed by volatility, not by endpoint.
 *
 * A player's career surface record does not change between two matches on
 * the same day; a price changes constantly. Tiers rather than per-call
 * TTLs so a new endpoint can't accidentally be added with no caching.
 * ------------------------------------------------------------------ */
const TTL = {
  STATIC: 24 * 60 * 60 * 1000, // reference tables, countries, courts, rounds
  DAILY:   6 * 60 * 60 * 1000, // rankings, calendars, draws, seeds
  PLAYER:  3 * 60 * 60 * 1000, // form, H2H, surface records
  SLATE:   15 * 60 * 1000,     // fixtures, upcoming
  PRICE:   45 * 1000,          // odds
  LIVE:    0,                  // never cached
};

const cache = new Map(); // path -> { at, ttl, body }

function cacheGet(path) {
  const hit = cache.get(path);
  if (!hit) return undefined;
  if (hit.ttl === 0 || Date.now() - hit.at > hit.ttl) { cache.delete(path); return undefined; }
  return hit.body;
}

function cacheSet(path, body, ttl) {
  if (ttl === 0) return;
  // Bounded so a long-running process can't grow this without limit.
  if (cache.size > 4000) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 800);
    for (const [k] of oldest) cache.delete(k);
  }
  cache.set(path, { at: Date.now(), ttl, body });
}

function clearCache() { cache.clear(); }

/* ------------------------------------------------------------------ *
 * CONCURRENCY — a plain semaphore.
 *
 * Without this, a Promise.all over a full slate opens 120 sockets at once
 * and the provider starts refusing. Also serialises retries so a wobble
 * doesn't turn into a stampede.
 * ------------------------------------------------------------------ */
const MAX_INFLIGHT = Number(process.env.TENNIS_API_CONCURRENCY) || 4;
let inflight = 0;
const queue = [];

function acquire() {
  if (inflight < MAX_INFLIGHT) { inflight++; return Promise.resolve(); }
  return new Promise((resolve) => queue.push(resolve));
}
function release() {
  inflight--;
  const next = queue.shift();
  if (next) { inflight++; next(); }
}

/* Requests already in flight for the same path share one promise, so a
 * slate where twenty matches need the same tournament draw makes one
 * call, not twenty. */
const pending = new Map();

/* ------------------------------------------------------------------ *
 * VALIDATION — content, never status.
 * ------------------------------------------------------------------ */
const FAILURE_TEXT = /not found|no odds found|unauthor|forbidden|not subscribed|invalid|no data|does not exist/i;

function looksFailed(body) {
  if (body === null || body === undefined) return true;
  if (body.error || body.success === false) return true;
  if (typeof body.statusCode === 'number' && body.statusCode >= 400) return true;
  if (typeof body.message === 'string' && FAILURE_TEXT.test(body.message)) return true;
  // A bare string body is always an error message on this API.
  if (typeof body === 'string') return true;
  return false;
}

/** True when a successful response simply has nothing in it — an empty
 *  slate is not an error and must not be retried. */
function isEmpty(body) {
  if (Array.isArray(body)) return body.length === 0;
  if (body && typeof body === 'object') {
    const rows = body.results ?? body.data ?? body.items;
    if (Array.isArray(rows)) return rows.length === 0;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * CORE REQUEST
 * ------------------------------------------------------------------ */
async function request(path, { ttl = TTL.PLAYER, retries = 1, label = '' } = {}) {
  if (!KEY) throw new Error('TENNIS_API_KEY is not set');

  const cached = cacheGet(path);
  if (cached !== undefined) return cached;

  if (pending.has(path)) return pending.get(path);

  const run = (async () => {
    await acquire();
    try {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const res = await fetch(BASE + path, {
            headers: { 'X-Gravitee-Api-Key': KEY, Accept: 'application/json' },
          });

          const ct = res.headers.get('content-type') || '';
          // Image routes return bytes. That is a success, not a parse error.
          if (/^image\//.test(ct)) {
            const out = { __binary: true, contentType: ct, url: BASE + path };
            cacheSet(path, out, TTL.STATIC);
            return out;
          }

          const text = await res.text();
          let body;
          try { body = JSON.parse(text); }
          catch {
            // Non-JSON on a JSON API is a gateway error page.
            if (attempt < retries) { await sleep(400 * (attempt + 1)); continue; }
            return null;
          }

          if (looksFailed(body)) {
            // Do NOT retry a semantic failure — "no odds found" will say
            // the same thing on the second call and just burn quota.
            return null;
          }

          cacheSet(path, body, ttl);
          return body;
        } catch (err) {
          // Network-level only. Worth one retry.
          if (attempt < retries) { await sleep(400 * (attempt + 1)); continue; }
          console.warn(`[tennisApi] ${label || path} failed: ${err.message}`);
          return null;
        }
      }
      return null;
    } finally {
      release();
      pending.delete(path);
    }
  })();

  pending.set(path, run);
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

/** Rows out of whatever envelope this particular endpoint chose. */
function rows(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  const r = body.results ?? body.data ?? body.items ?? body.fixtures ?? body.events;
  return Array.isArray(r) ? r : [];
}

/* ================================================================== *
 * SECTION 1 + 2 — FIXTURES
 * Scheme: id-keyed. `type` is 'atp' | 'wta'.
 * NOTE: the UNDATED /fixtures returns null start times. Do not use it.
 * ================================================================== */
const fixtures = {
  /** CONFIRMED shape — dated fixtures carry real UTC start times. */
  byDate: (type, date, { page = 1, pageSize = 100 } = {}) =>
    request(`/${type}/fixtures/${date}?include=tournament&pageSize=${pageSize}&pageNo=${page}`,
      { ttl: TTL.SLATE, label: 'fixtures.byDate' }),

  /** A real calendar view — the board is today+tomorrow only. */
  byRange: (type, start, end) =>
    request(`/${type}/fixtures/${start}/${end}`, { ttl: TTL.SLATE, label: 'fixtures.byRange' }),

  /** Tournament page: one event, whole draw. */
  byTournament: (type, tournamentId) =>
    request(`/${type}/fixtures/tournament/${tournamentId}`, { ttl: TTL.SLATE }),

  /** SCHEDULING LOAD factor — what else this player is playing this week. */
  byPlayer: (type, playerId) =>
    request(`/${type}/fixtures/player/${playerId}`, { ttl: TTL.PLAYER }),

  /** Next meeting between two players. */
  h2h: (type, p1Id, p2Id) =>
    request(`/${type}/fixtures/h2h/${p1Id}/${p2Id}`, { ttl: TTL.PLAYER }),
};

/* ================================================================== *
 * SECTION 2 — H2H
 * Two schemes exist. `h2hById` is type-scoped and id-keyed;
 * `h2h` is global and NAME-keyed. Pick one per call site and stay on it.
 * ================================================================== */
const h2hById = {
  stats:      (type, p1, p2) => request(`/${type}/h2h/stats/${enc(p1)}/${enc(p2)}`, { ttl: TTL.PLAYER }),
  matches:    (type, p1, p2) => request(`/${type}/h2h/matches/${enc(p1)}/${enc(p2)}`, { ttl: TTL.PLAYER }),
  /** How they do against the whole field — the baseline H2H reads against. */
  vsAll:      (type, player) => request(`/${type}/h2h/vs-all-stats/${enc(player)}`, { ttl: TTL.PLAYER }),
  /** H2H at THIS venue specifically. */
  atVenue:    (type, tournamentId, p1, p2) =>
    request(`/${type}/h2h/match-stats/${tournamentId}/${enc(p1)}/${enc(p2)}`, { ttl: TTL.PLAYER }),
};

const h2h = {
  /** CONFIRMED — already used by buildFactorBrief. */
  profile:    (type, p1, p2, limit = 10) =>
    request(`/h2h/profile/${type}/${enc(p1)}/${enc(p2)}/${limit}`, { ttl: TTL.PLAYER, label: 'h2h.profile' }),
  stats:      (type, p1, p2) => request(`/h2h/stats/${type}/${enc(p1)}/${enc(p2)}`, { ttl: TTL.PLAYER }),
  history:    (type, p1, p2) => request(`/h2h/history/${type}/${enc(p1)}/${enc(p2)}`, { ttl: TTL.PLAYER }),
  upcoming:   (type, p1, p2) => request(`/h2h/upcoming/${type}/${enc(p1)}/${enc(p2)}`, { ttl: TTL.SLATE }),
  /** RECENT FORM factor. */
  recent:     (type, player) => request(`/h2h/recent/${type}/${enc(player)}`, { ttl: TTL.PLAYER }),
  recentStats:(type, player) => request(`/h2h/recent-stats/${type}/${enc(player)}`, { ttl: TTL.PLAYER }),
  /** SURFACE FIT factor. */
  surfaceBreakdown: (type, player) => request(`/h2h/surfaceBreakdown/${type}/${enc(player)}`, { ttl: TTL.PLAYER }),
  breakdown:  (type, player) => request(`/h2h/breakdown/${type}/${enc(player)}`, { ttl: TTL.PLAYER }),
  /** Rivalry page content. */
  rivalries:  (type, player) => request(`/h2h/rivalries/${type}/${enc(player)}`, { ttl: TTL.DAILY }),
};

/* ================================================================== *
 * SECTION 2 + 3 + 6 — PLAYERS
 * Scheme: id-keyed, type-scoped.
 * ================================================================== */
const players = {
  list:    (type) => request(`/${type}/player`, { ttl: TTL.STATIC, label: 'players.list' }),
  /** Card identity block AND a real factor: handedness drives lefty matchups. */
  profile: (type, id) => request(`/${type}/player/profile/${id}`, { ttl: TTL.STATIC }),
  /** SURFACE FIT factor — career record by surface. */
  surfaceSummary: (type, id) => request(`/${type}/player/surface-summary/${id}`, { ttl: TTL.PLAYER }),
  /** CONFIRMED — already used. */
  perfBreakdown:  (type, id) => request(`/${type}/player/perf-breakdown/${id}`, { ttl: TTL.PLAYER, label: 'players.perfBreakdown' }),
  /** CONFIRMED — already used. VENUE HISTORY factor. */
  tournamentRecord: (type, playerId, tournamentId) =>
    request(`/${type}/player/tournament-record/${playerId}/${tournamentId}`, { ttl: TTL.PLAYER }),
  /** FATIGUE factor — see fatigueFrom() below. */
  pastMatches:  (type, id) => request(`/${type}/player/past-matches/${id}`, { ttl: TTL.PLAYER }),
  matchStats:   (type, id) => request(`/${type}/player/match-stats/${id}`, { ttl: TTL.PLAYER }),
  /** CLOSING RECORD — finals win rate is a distinct skill. */
  titles:  (type, id) => request(`/${type}/player/titles/${id}`, { ttl: TTL.DAILY }),
  finals:  (type, id) => request(`/${type}/player/finals/${id}`, { ttl: TTL.DAILY }),
  /** Match-preview copy. Their typo, not ours. */
  interestingH2h: (type, id) => request(`/${type}/player/intersting-h2h/${id}`, { ttl: TTL.DAILY }),
};

/* Name-keyed equivalents. Use ONLY when you hold a name and no id — do
 * not mix the two schemes inside one factor. */
const profiles = {
  get:            (name) => request(`/profile/${enc(name)}`, { ttl: TTL.STATIC }),
  /** AVAILABILITY factor — the highest-value item in the whole map if this
   *  carries injury/withdrawal. A live pick on a withdrawn player is the
   *  worst failure mode the board has. */
  status:         (name) => request(`/profile/${enc(name)}/player-status`, { ttl: TTL.SLATE, label: 'profiles.status' }),
  statistics:     (name) => request(`/profile/${enc(name)}/statistics`, { ttl: TTL.PLAYER }),
  surfaceSummary: (name) => request(`/profile/${enc(name)}/surface-summary`, { ttl: TTL.PLAYER }),
  breakdown:      (name) => request(`/profile/${enc(name)}/breakdown`, { ttl: TTL.PLAYER }),
  matchesPlayed:  (name) => request(`/profile/${enc(name)}/matches-played`, { ttl: TTL.PLAYER }),
  upcoming:       (name) => request(`/profile/${enc(name)}/upcoming`, { ttl: TTL.SLATE }),
  interesting:    (name) => request(`/profile/${enc(name)}/interesting`, { ttl: TTL.DAILY }),
  finals:         (name, year) => request(`/profile/${enc(name)}/finals/${year}`, { ttl: TTL.DAILY }),
  matchStat:      (name, year) => request(`/profile/${enc(name)}/match-stat/${year}`, { ttl: TTL.DAILY }),
  filters:        (name) => request(`/profile/${enc(name)}/filters`, { ttl: TTL.STATIC }),
  /** Name -> id resolution. This is how you STOP being name-keyed. */
  search:         (name, type) => request(`/profile/search/${enc(name)}/${type}`, { ttl: TTL.STATIC }),
  /* teamLogo removed — returns 500 on every player id. Player imagery
   * comes from profiles.get().image instead (see playerImages below). */
};

/* ================================================================== *
 * SECTION 3 + 7 — RANKINGS
 * ================================================================== */
const rankings = {
  singles: (type) => request(`/${type}/ranking/singles`, { ttl: TTL.DAILY, label: 'rankings.singles' }),
  all:     (type) => request(`/ranking/${type}`, { ttl: TTL.DAILY }),
  top:     (type) => request(`/ranking/${type}/top`, { ttl: TTL.DAILY }),
  /** Autocomplete source. */
  top500Names: (type) => request(`/ranking/${type}/top500-names`, { ttl: TTL.STATIC }),
  /** CONFIRMED — already used. Trajectory beats a static rank. */
  playerHistory: (type, playerId) =>
    request(`/ranking/${type}/player/${playerId}/history`, { ttl: TTL.DAILY, label: 'rankings.playerHistory' }),
  filters: (type) => request(`/ranking/${type}/filters`, { ttl: TTL.STATIC }),
};

/* ================================================================== *
 * SECTION 3 + 7 — TOURNAMENTS, DRAWS, SEEDS
 * The novel-factor section. Draw data is what nobody else models.
 * ================================================================== */
const tournaments = {
  get:      (type, name) => request(`/tournament/${type}/${enc(name)}`, { ttl: TTL.DAILY }),
  byYear:   (type, name, year) => request(`/tournament/${type}/${enc(name)}/${year}`, { ttl: TTL.DAILY }),
  /** DRAW DIFFICULTY factor. */
  draws:    (type, name, year) => request(`/tournament/${type}/${enc(name)}/${year}/draws`, { ttl: TTL.DAILY, label: 'tournaments.draws' }),
  /** SEEDING GAP factor — an unseeded player who should be seeded is
   *  systematically underpriced. */
  seeds:    (type, name, year) => (year
    ? request(`/tournament/${type}/${enc(name)}/${year}/seeds`, { ttl: TTL.DAILY })
    : request(`/tournament/${type}/${enc(name)}/seeds`, { ttl: TTL.DAILY })),
  /** Ranking points at stake — motivation signal, and good copy. */
  points:   (type, name, year) => request(`/tournament/${type}/${enc(name)}/${year}/points`, { ttl: TTL.DAILY }),
  /** VENUE AFFINITY — repeat winners at a specific event. */
  mostVictories: (type, name) => request(`/tournament/${type}/${enc(name)}/most-victories`, { ttl: TTL.STATIC }),
  pastChampions: (type, name, year) => request(`/tournament/${type}/${enc(name)}/${year}/past-champions`, { ttl: TTL.STATIC }),
  /** Conditions context: surface, indoor/outdoor, altitude. */
  info:     (type, seasonId) => request(`/${type}/tournament/info/${seasonId}`, { ttl: TTL.DAILY }),
  seasons:  (type, seasonId) => request(`/${type}/tournament/seasons/${seasonId}`, { ttl: TTL.STATIC }),
  /** Completed results — the backtest corpus. */
  results:  (type, seasonId) => request(`/${type}/tournament/results/${seasonId}`, { ttl: TTL.DAILY }),
  calendar: (type, year) => request(`/${type}/tournament/calendar/${year}`, { ttl: TTL.STATIC }),
};

const calendar = {
  byYear:  (type, year) => request(`/calendar/${type}/${year}`, { ttl: TTL.STATIC }),
  filters: (type) => request(`/calendar/${type}/filters`, { ttl: TTL.STATIC }),
  grandSlamChampions: (type) => request(`/calendar/${type}/grand-slam-champions`, { ttl: TTL.STATIC }),
};

/* ================================================================== *
 * SECTION 3 — POTENTIAL FIXTURES (lookahead / trap match)
 * ================================================================== */
const potential = {
  all:           (type) => request(`/potential-fixtures/${type}`, { ttl: TTL.DAILY }),
  activePlayers: (type) => request(`/potential-fixtures/${type}/active-players`, { ttl: TTL.DAILY }),
  /** LOOKAHEAD factor — a big name waiting next round is real in tennis. */
  forPlayer:     (type, player) => request(`/potential-fixtures/${type}/player/${enc(player)}`, { ttl: TTL.DAILY }),
  forTournament: (type, tournament) => request(`/potential-fixtures/${type}/tournament/${enc(tournament)}`, { ttl: TTL.DAILY }),
};

/* ================================================================== *
 * SECTION 7 — UPCOMING
 * ================================================================== */
const upcoming = {
  matches:     () => request(`/upcoming/matches`, { ttl: TTL.SLATE }),
  matchesByType: (type) => request(`/upcoming/matches/${type}`, { ttl: TTL.SLATE }),
  /** CONFIRMED — already used by ingestTennis as fetchMatchOdds. */
  matchOdds:   (type, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/upcoming/matchodds/${type}${q ? `?${q}` : ''}`, { ttl: TTL.PRICE, label: 'upcoming.matchOdds' });
  },
  /** "Match of the day" — the honest fix for a board where 120 fixtures
   *  all look equally important. */
  topToday:    (tnType) => request(`/upcoming/top-tennis-matches-today/${tnType}`, { ttl: TTL.SLATE }),
  filters:     (type) => (type
    ? request(`/upcoming/filters/${type}`, { ttl: TTL.STATIC })
    : request(`/upcoming/filters`, { ttl: TTL.STATIC })),
};

/* ================================================================== *
 * SECTION 4 — ODDS AND LINE SHOPPING
 * The section that touches the actual problem: ~71% and losing money
 * means the constraint is price, not accuracy.
 * ================================================================== */
const odds = {
  /** CONFIRMED — already used. */
  preMatch:   (eventId) => request(`/extend/api/odds/pre-match/${enc(eventId)}`, { ttl: TTL.PRICE, label: 'odds.preMatch' }),
  /** THE ONE THAT MATTERS. Best price across books, and the only route to
   *  line shopping on Challenger/ITF — tiers The Odds API does not carry
   *  at all, where the site currently promises best-price and can't
   *  deliver it. */
  /* market_id is REQUIRED and must be numeric — without it the gateway
   * returns 400 "Required market id & must be numeric value". 1 = Full
   * Time Result (moneyline). */
  compare:    (eventId, marketId = 1) =>
    request(`/extend/api/odds/compare/${enc(eventId)}?market_id=${marketId}`, { ttl: TTL.PRICE, label: 'odds.compare' }),
  /** Cheaper than compare when you only need the range. */
  summary:    (eventId) => request(`/extend/api/odds/summary/${enc(eventId)}`, { ttl: TTL.PRICE }),
  /** CONFIRMED — already used. */
  last10Movements: (eventId) => request(`/extend/api/odds/summary/movements/last-10/${enc(eventId)}`, { ttl: TTL.PRICE }),
  /** Steam detection. */
  biggestMovements: (eventId, marketId = 1) =>
    request(`/extend/api/odds/biggest-movements/${enc(eventId)}?market_id=${marketId}`, { ttl: TTL.PRICE }),
  recent:     (eventId) => request(`/extend/api/event/recent-odds/get/${enc(eventId)}`, { ttl: TTL.PRICE }),
  /** True arbs are rare. Treat a hit as a DATA-QUALITY ALARM first: it
   *  usually means one book is stale or a parse is wrong. */
  arbitrage:  (eventId, marketId = 1) =>
    request(`/extend/api/odds/arbitrage/${enc(eventId)}?market_id=${marketId}`, { ttl: TTL.PRICE }),
};

const reference = {
  /** Market id -> name. The socket parser currently keys off the literal
   *  string 'Full Time Result'; this is what makes that robust. */
  markets:    () => request(`/extend/api/markets/all`, { ttl: TTL.STATIC, label: 'reference.markets' }),
  bookmakers: () => request(`/extend/api/bookmakers/all`, { ttl: TTL.STATIC }),
  countries:  () => request(`/countries`, { ttl: TTL.STATIC }),
  courts:     () => request(`/court`, { ttl: TTL.STATIC }),
  rounds:     () => request(`/round`, { ttl: TTL.STATIC }),
  rankingRef: () => request(`/ranking`, { ttl: TTL.STATIC }),
};

/* ================================================================== *
 * SECTION 5 — LIVE
 * ================================================================== */
const liveApi = {
  /** POLL GUARD. Call this first; if zero, skip the full live fetch. */
  count:     () => request(`/extend/api/events/live/count`, { ttl: TTL.LIVE, label: 'live.count' }),
  /** CONFIRMED — already used. */
  events:    () => request(`/extend/api/events/live`, { ttl: TTL.LIVE, label: 'live.events' }),
  /* live-score/get removed — the gateway reports ROUTE_NOT_FOUND. Live
   * score comes from events/live and the socket. */
  /** REST fallback for the socket timeline — matters given how long the
   *  socket took to work. */
  timeline:  (eventId) => request(`/extend/api/event/timeline/${enc(eventId)}`, { ttl: TTL.LIVE }),
  pbp:       (eventId, set, game) => request(`/extend/api/event/pbp/${enc(eventId)}/${set}/${game}`, { ttl: TTL.LIVE }),
  pbpByIds:  (p1Id, p2Id, tourId, roundId) =>
    request(`/extend/api/event/pbp/${p1Id}/${p2Id}/${tourId}/${roundId}`, { ttl: TTL.LIVE }),
  upcomingEvents: (tour) => request(`/extend/api/events/upcoming/${tour}`, { ttl: TTL.SLATE, label: 'live.upcomingEvents' }),
  /** THE ID CROSSWALK. ingestTennis.js currently joins providers by name
   *  via namesLikelyMatch, which has already produced duplicate fixtures.
   *  This resolves a real eventId from two names plus a date — strictly
   *  more reliable. Resolve once, store it, stop fuzzy matching. */
  resolveEvent: (p1, p2, date) =>
    request(`/extend/api/event/get/${enc(p1)}/${enc(p2)}/${date}`, { ttl: TTL.SLATE, label: 'live.resolveEvent' }),
};

/* ================================================================== *
 * SECTION 7 — SEARCH
 * ================================================================== */
const search = {
  query:      (q) => request(`/search/${enc(q)}`, { ttl: TTL.DAILY }),
  byCategory: (q, category) => request(`/search/${enc(q)}/${category}`, { ttl: TTL.DAILY }),
};

/* ================================================================== *
 * NORMALISERS
 *
 * Only for shapes CONFIRMED against a real payload. Everything else is
 * left raw on purpose — a normaliser written against a guessed shape
 * silently produces nulls, which is worse than no normaliser at all
 * because it looks like it works.
 * ================================================================== */

/** Decimal to American, matching the rest of the pipeline. */
function decimalToAmerican(dec) {
  const d = Number(dec);
  if (!Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

/**
 * FATIGUE, from players.pastMatches().
 *
 * UNVERIFIED shape — tries the field names this API uses elsewhere and
 * returns null rather than a wrong number if none match. In Challenger and
 * ITF a player may play singles and doubles the same day, which is exactly
 * where this signal is worth most and where nobody prices it.
 */
function fatigueFrom(pastMatchesBody, { hours = 72 } = {}) {
  const list = rows(pastMatchesBody);
  if (!list.length) return null;

  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  let matches = 0, sets = 0, minutes = 0, dated = 0;

  for (const m of list) {
    const raw = m.date ?? m.matchDate ?? m.startTime ?? m.playedAt;
    const t = raw ? new Date(raw).getTime() : NaN;
    if (!Number.isFinite(t)) continue;
    dated++;
    if (t < cutoff) continue;
    matches++;
    const dur = Number(m.duration ?? m.minutes ?? m.matchDuration);
    if (Number.isFinite(dur)) minutes += dur;
    const score = String(m.score ?? m.result ?? '');
    const setCount = (score.match(/\d+\s*-\s*\d+/g) || []).length;
    sets += setCount;
  }

  // No parseable dates means the shape guess was wrong. Say so rather
  // than reporting a confident zero.
  if (!dated) return null;
  return { matches, sets, minutes: minutes || null, windowHours: hours };
}

/**
 * Market name -> id map from reference.markets(). Lets the socket parser
 * stop depending on the literal string 'Full Time Result'.
 * UNVERIFIED shape.
 */
function marketIndex(marketsBody) {
  const list = rows(marketsBody);
  const byName = new Map(), byId = new Map();
  for (const m of list) {
    const id = m.id ?? m.market_id ?? m.marketId;
    const name = m.name ?? m.market ?? m.title;
    if (id != null && name) { byName.set(String(name).toLowerCase(), id); byId.set(String(id), name); }
  }
  return { byName, byId, size: list.length };
}

/* ==================================================================
 * CONFIRMED PARSERS — written against real captured payloads.
 * ================================================================== */

/**
 * PLAYER IMAGERY. profiles.get(name) returns relative paths:
 *   image:        /tennis/api2/uploads/Photo/atp/29932.jpg
 *   image_p_name: /tennis/api2/uploads/Photo/atp_name/taylor_fritz.jpg
 *
 * This is the answer to the card-photo problem: imagery served by the
 * provider under the existing subscription, rather than hotlinked from a
 * rights-holder's CDN.
 *
 * The host is NOT in the payload. Set TENNIS_MEDIA_BASE once you have
 * confirmed which host serves these; the default is the API host.
 */
const MEDIA_BASE = process.env.TENNIS_MEDIA_BASE || 'https://api.sportsapi365.com';

function playerImages(profileBody) {
  const b = profileBody?.data || profileBody;
  if (!b) return null;
  const abs = (p) => (!p ? null : /^https?:\/\//.test(p) ? p : MEDIA_BASE + p);
  const photo = abs(b.image);
  const byName = abs(b.image_p_name);
  if (!photo && !byName) return null;
  return { photo, photoByName: byName, name: b.name || null };
}

/**
 * IDENTITY + a real factor. `plays` carries handedness and backhand:
 * "Right-Handed, Two-Handed Backhand". Lefty matchups are a genuine
 * tennis edge and nothing in the pipeline currently models them.
 */
function playerIdentity(profileBody) {
  const b = profileBody?.data || profileBody;
  if (!b) return null;
  const info = b.information || {};
  const plays = String(info.plays || '');
  const born = b.birthday ? new Date(b.birthday) : null;
  return {
    id: b.id ?? info.id ?? null,
    name: b.name || null,
    country: b.countryAcr || b.country?.acronym || null,
    countryName: b.country?.name || null,
    rank: Number.isFinite(Number(b.currentRank)) ? Number(b.currentRank) : null,
    points: Number(b.points) || null,
    ageYears: born ? Math.floor((Date.now() - born.getTime()) / 31557600000) : null,
    heightCm: Number(info.height) || null,
    turnedPro: Number(info.turnedPro) || null,
    // `false || null` collapses to null, which would report every
    // right-hander as unknown handedness. Ternary, not ||.
    leftHanded: plays ? /left/i.test(plays) : null,
    oneHandedBackhand: plays ? /one-handed/i.test(plays) : null,
    status: b.playerStatus || info.playerStatus || null,
  };
}

/**
 * BEST PRICE. odds.arbitrage() already computes this server-side and
 * returns it pre-resolved, which is cheaper and less error-prone than
 * scanning compare() ourselves:
 *
 *   result: { arbitrage, margin, bestOdds: {
 *     outcome1: { bookmakerId, bookmaker, odds },
 *     outcome2: { ... } }, bookmakersChecked }
 *
 * NOTE ON COVERAGE: bookmakersChecked came back as 2 (Bet365,
 * DraftKings). This provider is NOT a forty-book feed. See the margin
 * field — it doubles as a data-quality signal: a margin below 1.0 means
 * a genuine arb, which in practice usually means one book is stale.
 */
function bestPriceFrom(arbitrageBody) {
  const r = arbitrageBody?.result || arbitrageBody;
  const best = r?.bestOdds;
  if (!best) return null;
  const a = best.outcome1, b = best.outcome2;
  if (!a && !b) return null;
  return {
    bestOddsA: a ? decimalToAmerican(a.odds) : null,
    bestBookA: a ? a.bookmaker || null : null,
    bestOddsB: b ? decimalToAmerican(b.odds) : null,
    bestBookB: b ? b.bookmaker || null : null,
    margin: Number(r.margin) || null,
    isArb: r.arbitrage === true,
    bookCount: Number(r.bookmakersChecked) || null,
  };
}

/**
 * LINE MOVEMENT PER BOOK, from odds.summary().
 *
 *   result: { "Bet365": { "Full Time Result": {
 *       start: { od1, od2, sourceAddTime },
 *       end:   { od1, od2, sourceAddTime } } } }
 *
 * Bookmaker first, then market — note this is INVERTED relative to
 * odds.recent(), which nests market first. Getting the two the wrong way
 * round yields empty results rather than an error, so they are separate
 * functions on purpose.
 */
function lineMovementFrom(summaryBody, market = 'Full Time Result') {
  const result = summaryBody?.result || summaryBody;
  if (!result || typeof result !== 'object') return null;

  const books = [];
  for (const [book, markets] of Object.entries(result)) {
    const m = markets?.[market];
    if (!m) continue;
    const s1 = Number(m.start?.od1), e1 = Number(m.end?.od1);
    const s2 = Number(m.start?.od2), e2 = Number(m.end?.od2);
    if (!Number.isFinite(e1) || !Number.isFinite(e2)) continue;
    books.push({
      book,
      openA: Number.isFinite(s1) ? decimalToAmerican(s1) : null,
      openB: Number.isFinite(s2) ? decimalToAmerican(s2) : null,
      currentA: decimalToAmerican(e1),
      currentB: decimalToAmerican(e2),
      movedA: Number.isFinite(s1) ? +(e1 - s1).toFixed(3) : null,
      movedB: Number.isFinite(s2) ? +(e2 - s2).toFixed(3) : null,
      updatedAt: m.end?.sourceAddTime ? new Date(m.end.sourceAddTime * 1000) : null,
    });
  }
  return books.length ? books : null;
}

/** Best price from odds.recent() — market first, THEN bookmaker. */
function bestPriceFromRecent(recentBody, market = 'Full Time Result') {
  const byMarket = recentBody?.result || recentBody;
  const books = byMarket?.[market];
  if (!books || typeof books !== 'object') return null;

  let bestA = null, bestB = null, n = 0;
  for (const [book, o] of Object.entries(books)) {
    n++;
    const d1 = Number(o.od1), d2 = Number(o.od2);
    if (Number.isFinite(d1) && d1 > 1 && (!bestA || d1 > bestA.d)) bestA = { d: d1, book };
    if (Number.isFinite(d2) && d2 > 1 && (!bestB || d2 > bestB.d)) bestB = { d: d2, book };
  }
  if (!bestA && !bestB) return null;
  return {
    bestOddsA: bestA ? decimalToAmerican(bestA.d) : null,
    bestBookA: bestA?.book || null,
    bestOddsB: bestB ? decimalToAmerican(bestB.d) : null,
    bestBookB: bestB?.book || null,
    bookCount: n,
  };
}

/**
 * SURFACE FIT, from players.surfaceSummary().
 *   data: [{ year, surfaces: [{ courtId, court, courtWins, courtLosses }] }]
 * Fourteen years came back for Fritz; recent years are what matter, so
 * this windows rather than using the career total.
 */
function surfaceRecordFrom(surfaceBody, { surface, years = 3 } = {}) {
  const list = rows(surfaceBody);
  if (!list.length) return null;
  const cutoff = new Date().getFullYear() - years;
  const totals = new Map();

  for (const y of list) {
    if (Number(y.year) < cutoff) continue;
    for (const s of (y.surfaces || [])) {
      const key = String(s.court || s.courtId);
      const cur = totals.get(key) || { court: s.court, wins: 0, losses: 0 };
      cur.wins += Number(s.courtWins) || 0;
      cur.losses += Number(s.courtLosses) || 0;
      totals.set(key, cur);
    }
  }
  const out = [...totals.values()].map((t) => ({
    ...t,
    played: t.wins + t.losses,
    winRate: t.wins + t.losses ? +(t.wins / (t.wins + t.losses) * 100).toFixed(1) : null,
  }));
  if (!out.length) return null;
  if (surface) {
    const hit = out.find((o) => String(o.court).toLowerCase() === String(surface).toLowerCase());
    return hit || null;
  }
  return out;
}

/**
 * CAREER SURFACE SPLIT, from h2h.surfaceBreakdown().
 * Flat counters, "1" = wins and "2" = losses:
 *   hard1/hard2, iHard1/iHard2, clay1/clay2, grass1/grass2, total1/total2
 */
function surfaceSplitFrom(breakdownBody) {
  const b = breakdownBody?.data || breakdownBody;
  if (!b || typeof b !== 'object') return null;
  const pair = (w, l) => {
    const wins = Number(b[w]), losses = Number(b[l]);
    if (!Number.isFinite(wins) || !Number.isFinite(losses)) return null;
    const played = wins + losses;
    return { wins, losses, played, winRate: played ? +(wins / played * 100).toFixed(1) : null };
  };
  const out = {
    hard: pair('hard1', 'hard2'),
    indoorHard: pair('iHard1', 'iHard2'),
    clay: pair('clay1', 'clay2'),
    grass: pair('grass1', 'grass2'),
    overall: pair('total1', 'total2'),
  };
  return out.overall ? out : null;
}

/**
 * RECENT FORM, from h2h.recent().
 *   games: [{ id, roundId, result, date, seed1, seed2, odd1, odd2,
 *             player1Id, player2Id, tournamentId, draw }]
 *
 * These rows carry the PRICE the match traded at (odd1/odd2). That makes
 * this a backtest corpus with odds attached, not just a form list — which
 * is what the equity curve work actually needs.
 */
function recentFormFrom(recentBody, playerId) {
  const b = recentBody?.data || recentBody;
  const games = Array.isArray(b?.games) ? b.games : rows(b);
  if (!games.length) return null;

  const pid = playerId != null ? String(playerId) : null;
  let wins = 0, losses = 0;
  const matches = games.map((g) => {
    const isP1 = pid ? String(g.player1Id) === pid : true;
    // "6-4 6-3" is written from player1's perspective.
    const sets = String(g.result || '').trim().split(/\s+/);
    let s1 = 0, s2 = 0;
    for (const s of sets) {
      const m = s.match(/^(\d+)-(\d+)/);
      if (!m) continue;
      if (Number(m[1]) > Number(m[2])) s1++; else s2++;
    }
    const p1Won = s1 > s2;
    const won = isP1 ? p1Won : !p1Won;
    won ? wins++ : losses++;
    return {
      date: g.date ? new Date(g.date) : null,
      won,
      score: g.result || null,
      seed: isP1 ? g.seed1 : g.seed2,
      opponentSeed: isP1 ? g.seed2 : g.seed1,
      priceTaken: isP1 ? decimalToAmerican(g.odd1) : decimalToAmerican(g.odd2),
      wasFavourite: Number(isP1 ? g.odd1 : g.odd2) < Number(isP1 ? g.odd2 : g.odd1),
      tournamentId: g.tournamentId || null,
    };
  });

  return {
    played: matches.length,
    wins, losses,
    winRate: matches.length ? +(wins / matches.length * 100).toFixed(1) : null,
    careerMatches: Number(b?.count) || null,
    matches,
  };
}

/**
 * SEEDING GAP, from tournaments.seeds(). Bare array: [{ player, seed }].
 * An unseeded player whose ranking merits a seed is systematically
 * underpriced — that comparison is the factor, not the seed itself.
 */
function seedsFrom(seedsBody) {
  const list = rows(seedsBody);
  if (!list.length) return null;
  const byName = new Map();
  for (const s of list) {
    if (!s.player) continue;
    byName.set(String(s.player).toLowerCase(), Number(s.seed) || null);
  }
  return { byName, count: byName.size, seedOf: (n) => byName.get(String(n).toLowerCase()) ?? null };
}

/**
 * DRAW, from tournaments.draws().
 *   { singles: [...], qualifying: [...], doubles: [...] }
 * Rows carry result, date, seeds, draw position and sometimes odds.
 * Qualifying rows are how you tell a qualifier from a direct entrant —
 * three extra matches in the legs before the main draw even starts.
 */
function drawFrom(drawsBody, { includeDoubles = false } = {}) {
  if (!drawsBody || typeof drawsBody !== 'object') return null;
  const singles = Array.isArray(drawsBody.singles) ? drawsBody.singles : [];
  const qualifying = Array.isArray(drawsBody.qualifying) ? drawsBody.qualifying : [];
  if (!singles.length && !qualifying.length) return null;

  const qualifiers = new Set();
  for (const q of qualifying) {
    if (q.player1Id) qualifiers.add(String(q.player1Id));
    if (q.player2Id) qualifiers.add(String(q.player2Id));
  }
  return {
    singles, qualifying,
    doubles: includeDoubles && Array.isArray(drawsBody.doubles) ? drawsBody.doubles : undefined,
    /** Came through qualifying — extra matches in the legs. */
    cameThroughQualifying: (playerId) => qualifiers.has(String(playerId)),
    matchesPlayedHere: (playerId) => {
      const id = String(playerId);
      return [...singles, ...qualifying]
        .filter((m) => String(m.player1Id) === id || String(m.player2Id) === id).length;
    },
  };
}

/**
 * LOOKAHEAD / TRAP MATCH, from potential.forPlayer().
 *   data: [{ id, name, date, tourRank,
 *            matches: [{ round, roundName, draw, player1, player2 }] }]
 * The projected path, including the final. A big name waiting two rounds
 * out is a real motivational factor in tennis and nobody prices it.
 */
function lookaheadFrom(potentialBody, playerName) {
  const list = rows(potentialBody);
  if (!list.length) return null;
  const me = String(playerName || '').toLowerCase();

  const path = [];
  for (const t of list) {
    for (const m of (t.matches || [])) {
      const p1 = String(m.player1 || '').toLowerCase();
      const p2 = String(m.player2 || '').toLowerCase();
      if (me && p1 !== me && p2 !== me) continue;
      path.push({
        tournament: t.name || null,
        round: m.round ?? null,
        roundName: m.roundName || null,
        opponent: me ? (p1 === me ? m.player2 : m.player1) : null,
      });
    }
  }
  if (!path.length) return null;
  path.sort((a, b) => (a.round ?? 99) - (b.round ?? 99));
  return { path, nextOpponent: path[0]?.opponent || null, projectedRounds: path.length };
}

module.exports = {
  request, rows, clearCache, TTL,
  fixtures, h2h, h2hById, players, profiles, rankings,
  tournaments, calendar, potential, upcoming, odds, reference,
  live: liveApi, search,
  decimalToAmerican, fatigueFrom, marketIndex,
  // confirmed against real payloads
  playerImages, playerIdentity, bestPriceFrom, bestPriceFromRecent,
  lineMovementFrom, surfaceRecordFrom, surfaceSplitFrom, recentFormFrom,
  seedsFrom, drawFrom, lookaheadFrom, MEDIA_BASE,
};
