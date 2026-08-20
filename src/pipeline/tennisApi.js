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
  /** Tennis has no teams — "teamId" is the player. May return bytes. */
  teamLogo:       (teamId) => request(`/profile/team-logo/${teamId}`, { ttl: TTL.STATIC, label: 'profiles.teamLogo' }),
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
  compare:    (eventId) => request(`/extend/api/odds/compare/${enc(eventId)}`, { ttl: TTL.PRICE, label: 'odds.compare' }),
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
  score:     (eventId) => request(`/extend/api/live-score/get/${enc(eventId)}`, { ttl: TTL.LIVE }),
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

/**
 * Best price across books from odds.compare(). UNVERIFIED shape — this is
 * the highest-value normaliser in the file and the first one to fix from
 * probe output. Returns null when nothing parses, so callers fall back to
 * the single pre-match price rather than showing a wrong "best" number.
 */
function bestPriceFrom(compareBody) {
  const list = rows(compareBody);
  if (!list.length) return null;

  let bestA = null, bestB = null;
  for (const r of list) {
    const book = r.bookmaker ?? r.bookmakerName ?? r.book ?? r.name ?? null;
    const d1 = Number(r.od1 ?? r.odds1 ?? r.home ?? r.player1);
    const d2 = Number(r.od2 ?? r.odds2 ?? r.away ?? r.player2);
    if (Number.isFinite(d1) && d1 > 1 && (!bestA || d1 > bestA.decimal)) bestA = { decimal: d1, book };
    if (Number.isFinite(d2) && d2 > 1 && (!bestB || d2 > bestB.decimal)) bestB = { decimal: d2, book };
  }
  if (!bestA && !bestB) return null;

  return {
    bestOddsA: bestA ? decimalToAmerican(bestA.decimal) : null,
    bestBookA: bestA ? bestA.book : null,
    bestOddsB: bestB ? decimalToAmerican(bestB.decimal) : null,
    bestBookB: bestB ? bestB.book : null,
    bookCount: list.length,
  };
}

module.exports = {
  request, rows, clearCache, TTL,
  fixtures, h2h, h2hById, players, profiles, rankings,
  tournaments, calendar, potential, upcoming, odds, reference,
  live: liveApi, search,
  decimalToAmerican, fatigueFrom, marketIndex, bestPriceFrom,
};
