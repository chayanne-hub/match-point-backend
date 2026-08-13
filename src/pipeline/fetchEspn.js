/**
 * Match Point — ESPN live score adapter.
 *
 * ESPN doesn't publish an official API, but their site's own scoreboard
 * endpoints are reachable and unauthenticated (community-documented at
 * e.g. https://github.com/pseudo-r/Public-ESPN-API). This is what powers
 * the fast (15s) live-score loop, replacing The Odds API's /scores
 * endpoint for in-play score data. The Odds API is still used elsewhere
 * for pre-match odds, which is what actually drives picks — this file
 * ONLY supplies scores.
 *
 * IMPORTANT: this is an unofficial, reverse-engineered endpoint. It could
 * change or start blocking requests without notice. If fetchEspnLiveScores
 * starts failing consistently, that's the first thing to suspect.
 *
 * ESPN has no shared ID with The Odds API, so matches are joined by
 * normalized team/player name + same calendar day — see matchEspnEvent().
 */

const fetch = require('node-fetch');

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// Which ESPN sport/league slugs to pull per sport. Tennis and soccer need
// multiple sub-leagues merged together; basketball has NBA + WNBA.
const ESPN_LEAGUES = {
  tennis: ['tennis/atp', 'tennis/wta'],
  basketball: ['basketball/nba', 'basketball/wnba'],
  baseball: ['baseball/mlb'],
  football: ['football/nfl'],
  soccer: ['soccer/eng.1', 'soccer/uefa.champions'], // extend as needed
};

/**
 * Strips accents/diacritics and punctuation so name comparison isn't
 * thrown off by e.g. "Novak Đoković" vs "Novak Djokovic".
 */
// ---- Name aliases ----------------------------------------------------
// ESPN and the odds provider transliterate Cyrillic and other non-Latin
// names differently: "Alexander Shevchenko" vs "Aleksandr Shevchenko",
// same player, two feeds. Every positional rule in namesLikelyMatch fails
// on those, and the match then shows up twice on the board.
//
// The obvious fix — fuzzy/edit-distance matching — is genuinely unsafe
// here. "Xiyu Wang" and "Xinyu Wang" are TWO DIFFERENT WTA players
// separated by one character. Any threshold loose enough to catch
// Alexander/Aleksandr merges them, and writing one player's live score
// onto another's match is far worse than a duplicate row.
//
// So: an explicit table instead. Precise, no false positives, and it
// grows as variants are spotted. Applied at the TOKEN level during
// normalisation, so a single entry fixes every player sharing that given
// name rather than one pair at a time. Surnames still have to match on
// their own — aliasing a first name can't merge two different people.
const TOKEN_ALIASES = {
  // Russian / Ukrainian given names
  aleksandr: 'alexander', aleksander: 'alexander', oleksandr: 'alexander', alexandre: 'alexander',
  aleksei: 'alexei', alexey: 'alexei', oleksii: 'alexei',
  sergey: 'sergei', serhii: 'sergei',
  dmitry: 'dmitri', dmytro: 'dmitri', dimitri: 'dmitri',
  nikolay: 'nikolai', nicolai: 'nikolai', mykola: 'nikolai',
  andrey: 'andrei', andriy: 'andrei',
  evgeny: 'evgeni', yevgeny: 'evgeni', evgenii: 'evgeni',
  mikhail: 'michail',
  danil: 'daniil',
  anastasiia: 'anastasia',
  viktoriia: 'viktoria', victoria: 'viktoria',
  yekaterina: 'ekaterina',
  kseniia: 'ksenia', xenia: 'ksenia',
  iuliia: 'yuliia', yulia: 'yuliia',
  // Nicknames. Feeds disagree on these the same way they disagree on
  // transliterations: the odds provider lists "Caty McNally" while ESPN
  // says "Catherine McNally", and the match then appears twice on the
  // board — once with odds, once as a schedule-only row.
  //
  // Only confirmed pairs go here. A nickname map is riskier than a
  // transliteration map because two different players really can be
  // "Alex" and "Alexander" — the surname still has to match on its own,
  // which is what keeps this safe.
  caty: 'catherine',
  cat: 'catherine',
  katie: 'katherine',
  kate: 'katherine',
  nick: 'nicholas',
  mike: 'michael',
  matt: 'matthew',
  chris: 'christopher',
  dan: 'daniel',
  danny: 'daniel',
  tom: 'thomas',
  tommy: 'thomas',
  ben: 'benjamin',
  sam: 'samuel',
  // Add more here, or without a deploy via NAME_ALIASES (see below).
};

// NAME_ALIASES env var, for fixing a mismatch in seconds without a code
// change: "variant=canonical,variant=canonical"
if (process.env.NAME_ALIASES) {
  for (const pair of process.env.NAME_ALIASES.split(',')) {
    const [variant, canonical] = pair.split('=').map((x) => (x || '').trim().toLowerCase());
    if (variant && canonical) TOKEN_ALIASES[variant] = canonical;
  }
}

function normalizeName(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accent marks
    // Latin-extended letters that do NOT decompose under NFD — accent
    // stripping leaves them intact and the punctuation strip below then
    // DELETES them, mangling the name. "Novak Đoković" became "novak
    // okovic" and never matched ESPN's "Novak Djokovic". Transliterated
    // explicitly instead. (Đ -> dj is the Serbian/Croatian convention;
    // Vietnamese uses đ -> d, a known limitation not relevant here.)
    .replace(/\u0110/g, 'Dj').replace(/\u0111/g, 'dj')  // Đ đ
    .replace(/\u00d8/g, 'O').replace(/\u00f8/g, 'o')    // Ø ø
    .replace(/\u0141/g, 'L').replace(/\u0142/g, 'l')    // Ł ł
    .replace(/\u00df/g, 'ss')                          // ß
    // Hyphens and apostrophes need OPPOSITE treatment, which is why a
    // single punctuation strip got both wrong:
    //   - Hyphen joins two given names, so it becomes a SPACE.
    //     "Elena-Gabriela Ruse" -> "elena gabriela ruse", matching ESPN's
    //     unhyphenated spelling. Stripping it produced "elenagabriela",
    //     which matched nothing and duplicated the fixture.
    //   - An apostrophe sits INSIDE one name, so it's removed.
    //     "O'Connell" -> "oconnell", matching a feed that writes
    //     "OConnell". Turning it into a space would split one surname in
    //     two and break the match instead.
    .replace(/[-–—]/g, ' ')
    .replace(/['’`]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, '')  // strip remaining punctuation
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    // Canonicalise each token through the alias table, so every
    // downstream comparison sees one spelling.
    .split(' ')
    .map((tok) => TOKEN_ALIASES[tok] || tok)
    .join(' ');
}

/**
 * True if two names likely refer to the same competitor. Tries an exact
 * normalized match first, then falls back to "last word matches" (surname
 * for players, mascot for teams) since the two providers don't always
 * format names identically.
 */
function namesLikelyMatch(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const ta = na.split(' ');
  const tb = nb.split(' ');

  // COMPOUND SURNAMES. The odds provider and ESPN frequently disagree on
  // how many surnames to print: "Daniel Merida Aguilar" vs "Daniel
  // Merida", "Alejandro Davidovich Fokina" vs "Alejandro Davidovich".
  // The old last-token-only check compared "aguilar" to "merida" and
  // failed, so those matches never joined to their ESPN event and sat
  // frozen at their opening score forever while ESPN's copy showed up
  // separately as a duplicate row. Treating one full name as a prefix
  // of the other fixes the whole class of them. Requires >= 2 shared
  // leading tokens so a bare surname can't match everyone.
  const shorter = ta.length <= tb.length ? ta : tb;
  const longer = ta.length <= tb.length ? tb : ta;
  if (shorter.length >= 2 && shorter.every((tok, i) => longer[i] === tok)) return true;

  // Reordered/dropped middle surnames ("Carlos Alcaraz Garfia" vs
  // "Carlos Garfia"): same first name AND at least one shared surname
  // token. Both conditions together keep this from matching two
  // different players who merely share a first name.
  if (ta[0] === tb[0] && ta.length > 1 && tb.length > 1) {
    const lastOfA = ta[ta.length - 1];
    const lastOfB = tb[tb.length - 1];
    const restA = new Set(ta.slice(1));
    // The shared token must be a real surname (the LAST token of one of
    // the names). Without this, any two multi-word names sharing a
    // middle word matched — "Los Angeles Angels" vs "Los Angeles
    // Dodgers" both contain "angeles", which would have merged two
    // completely different teams' scores.
    if (tb.slice(1).some((tok) => restA.has(tok) && (tok === lastOfA || tok === lastOfB))) return true;
  }

  // REVERSED NAME ORDER. ESPN and the odds provider disagree on given/
  // family name order for Chinese, Korean and Japanese players: the odds
  // feed says "Yue Yuan" and "Xiyu Wang", ESPN says "Yuan Yue" and "Wang
  // Xiyu". Every check above compares positionally, so all of them fail —
  // and the match then appears TWICE on the board: once from the odds
  // provider and once as an ESPN-only row with no odds attached.
  //
  // Comparing the token SETS catches it. Two different people having the
  // exact same name tokens in a different order isn't a realistic
  // collision, and both names must have the same number of parts.
  if (ta.length === tb.length && ta.length >= 2) {
    const sortedA = [...ta].sort().join(' ');
    const sortedB = [...tb].sort().join(' ');
    if (sortedA === sortedB) return true;
  }

  // Trailing-token match, for team short forms: "Blue Jays" is the tail of
  // "Toronto Blue Jays". Mirrors the leading-token rule above.
  if (shorter.length >= 2 && shorter.every((tok, i) => longer[longer.length - shorter.length + i] === tok)) return true;

  // CONTAINED NAME. Spanish and Portuguese compound names get truncated
  // differently by each feed, and the shared part isn't always at the
  // start or end: ESPN says "Camila Osorio" while the odds feed says
  // "Maria Camila Osorio Serrano" — the match sits in the MIDDLE, so both
  // the prefix and suffix rules above miss it and the fixture appears
  // twice on the board.
  //
  // Requires the shorter name's tokens to appear in the longer one in
  // ORDER and consecutively, and at least two of them. Consecutive rather
  // than a loose subsequence matters: "maria lopez" would otherwise match
  // "maria fernanda garcia lopez", which is a different person.
  if (shorter.length >= 2 && longer.length > shorter.length) {
    const joinedShort = shorter.join(' ');
    const joinedLong = longer.join(' ');
    if (joinedLong.includes(joinedShort)) return true;
  }

  // Bare mascot/surname fallback — ONLY when one side is a single token
  // ("Dodgers" vs "Los Angeles Dodgers").
  //
  // It used to apply to any two names sharing a last token, which merged
  // DIFFERENT PEOPLE: Xiyu Wang and Xinyu Wang are two separate WTA
  // players, and matching on "wang" alone would have written one's score
  // onto the other's match. Common surnames make that a routine
  // occurrence in tennis, not an edge case.
  const lastA = ta[ta.length - 1];
  const lastB = tb[tb.length - 1];
  if (Math.min(ta.length, tb.length) === 1) {
    return lastA === lastB && lastA.length > 2; // avoid matching on short/common words
  }
  return false;
}

// Real bug this replaced: comparing exact UTC calendar days meant any
// evening match in the US (the majority of them — prime time games,
// night matches) could fall on tomorrow's UTC date while still being
// today locally. If ESPN and The Odds API reported the event time even
// a few minutes apart near that UTC midnight boundary, the two sides
// landed on different UTC days and never matched at all — meaning that
// match's status could never update to 'live', leaving it stuck showing
// as upcoming forever, well past its actual start time. A generous
// absolute time window avoids the boundary entirely instead of trying
// to get calendar-day comparison exactly right across two providers
// that don't necessarily agree on timezone handling.
function sameCalendarDay(dateA, dateB) {
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  const HOURS_20 = 20 * 60 * 60 * 1000;
  return Math.abs(a - b) < HOURS_20;
}

/**
 * Parses one ESPN tennis competition into our normalized shape, including
 * the set-by-set score string (e.g. "6-4, 3-6, 2-1") built from linescores.
 */
function parseTennisCompetition(competition) {
  const home = competition.competitors.find((c) => c.homeAway === 'home');
  const away = competition.competitors.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;

  const homeSets = home.linescores || [];
  const awaySets = away.linescores || [];
  const setCount = Math.max(homeSets.length, awaySets.length);
  const setParts = [];
  for (let i = 0; i < setCount; i++) {
    const h = homeSets[i]?.value;
    const a = awaySets[i]?.value;
    if (h === undefined || a === undefined) continue;
    setParts.push(`${h}-${a}`);
  }

  return {
    competitorAName: home.athlete?.displayName || home.athlete?.fullName,
    competitorBName: away.athlete?.displayName || away.athlete?.fullName,
    completed: !!competition.status?.type?.completed,
    inProgress: competition.status?.type?.state === 'in',
    setScore: setParts.join(', ') || null,
    eventDate: competition.date,
    // Tennis doesn't have a single "final score" the way team sports do —
    // homeScore/awayScore here are SETS WON, for consistency with the
    // homeScore/awayScore fields other sports use.
    homeScore: homeSets.filter((s) => s.winner).length,
    awayScore: awaySets.filter((s) => s.winner).length,
  };
}

/**
 * Parses one ESPN team-sport (basketball/baseball/football/soccer)
 * competition into our normalized shape.
 */
function parseTeamCompetition(competition) {
  const home = competition.competitors.find((c) => c.homeAway === 'home');
  const away = competition.competitors.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;

  // period/clock: reverse-engineered from ESPN's scoreboard status object,
  // same unofficial-endpoint caveat as the rest of this file — status.period
  // is the quarter/period number, status.clock is seconds remaining in it,
  // status.displayClock is the "8:42"-style string shown on ESPN's own
  // site. Only meaningfully used for basketball today (see
  // basketballTotals.js) but captured generically since it's free —
  // already have the raw competition object in hand.
  const period = typeof competition.status?.period === 'number' ? competition.status.period : null;
  const clockSeconds = typeof competition.status?.clock === 'number' ? Math.round(competition.status.clock) : null;
  const displayClock = competition.status?.displayClock || null;
  // Human-readable status ESPN itself displays — "End 6th", "Top 7th",
  // "Bot 3rd" for baseball, similarly descriptive strings for other
  // sports. Baseball has no clock at all, so this (not period/clock) is
  // the real source for its live status display.
  const statusDetail = competition.status?.type?.shortDetail || competition.status?.type?.detail || null;

  // Per-period score breakdown (quarters for basketball/football, innings
  // handled separately for baseball via its own inning-status field) —
  // same linescores array tennis's parser already reads for sets, just
  // never extracted here before. Built as a "25-28, 20-21, 20-24, 22-25"
  // string, same format tennis's setScore already uses, so the same
  // parsing helpers (parseSetScore-style) work on either.
  const homeLines = home.linescores || [];
  const awayLines = away.linescores || [];
  const periodCount = Math.max(homeLines.length, awayLines.length);
  const periodParts = [];
  for (let i = 0; i < periodCount; i++) {
    const h = homeLines[i]?.value;
    const a = awayLines[i]?.value;
    if (h === undefined || a === undefined) continue;
    periodParts.push(`${h}-${a}`);
  }
  const periodScores = periodParts.length ? periodParts.join(', ') : null;

  // HITS and ERRORS — the H and E of a baseball box score. Runs alone
  // give "5-2", which is a score, not a scoreboard; R/H/E is how the
  // sport is actually read.
  //
  // ESPN puts these in two different shapes depending on the endpoint:
  // sometimes directly on the competitor, sometimes inside a statistics
  // array. Both are checked, and anything missing stays null rather than
  // rendering a fabricated zero — a real 0 errors and "we don't know"
  // must not look identical.
  const statOf = (competitor, name) => {
    if (competitor?.[name] !== undefined && competitor[name] !== null) return Number(competitor[name]);
    const fromStats = (competitor?.statistics || []).find(
      (st) => (st.name || st.abbreviation || '').toLowerCase() === name
    );
    return fromStats?.displayValue !== undefined ? Number(fromStats.displayValue) : null;
  };

  const homeHits = statOf(home, 'hits');
  const awayHits = statOf(away, 'hits');
  const homeErrors = statOf(home, 'errors');
  const awayErrors = statOf(away, 'errors');

  return {
    competitorAName: home.team?.displayName || home.team?.shortDisplayName,
    homeHits,
    awayHits,
    homeErrors,
    awayErrors,
    competitorBName: away.team?.displayName || away.team?.shortDisplayName,
    completed: !!competition.status?.type?.completed,
    inProgress: competition.status?.type?.state === 'in',
    setScore: null,
    periodScores,
    eventDate: competition.date,
    homeScore: home.score !== undefined ? Number(home.score) : null,
    awayScore: away.score !== undefined ? Number(away.score) : null,
    period,
    clockSeconds,
    displayClock,
    statusDetail,
  };
}

/**
 * Fetches and normalizes all events for one sport across its ESPN
 * sub-leagues (e.g. tennis pulls both atp and wta). Returns a flat array
 * regardless of how many leagues were merged.
 */
async function fetchEspnLiveScores(sportSlug) {
  const leagues = ESPN_LEAGUES[sportSlug];
  if (!leagues) {
    console.warn(`[espn] no ESPN league mapping for sport: ${sportSlug}`);
    return [];
  }

  const parser = sportSlug === 'tennis' ? parseTennisCompetition : parseTeamCompetition;
  const results = [];

  for (const league of leagues) {
    const url = `${ESPN_BASE}/${league}/scoreboard`;
    let data;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`[espn] ${league} request failed: ${res.status} ${res.statusText}`);
        continue;
      }
      data = await res.json();
    } catch (err) {
      console.error(`[espn] ${league} fetch failed:`, err.message);
      continue;
    }

    const events = data.events || [];
    for (const event of events) {
      // Tennis events can have multiple "groupings" (e.g. men's/women's
      // singles) each with their own competitions; team sports have one
      // competition per event.
      const competitions =
        event.groupings?.flatMap((g) => g.competitions || []) ||
        event.competitions ||
        [];

      for (const competition of competitions) {
        const parsed = parser(competition);
        if (parsed && parsed.competitorAName && parsed.competitorBName) {
          results.push(parsed);
        }
      }
    }
  }

  return results;
}

/**
 * Given one ESPN-parsed event and a list of candidate DB Match rows
 * (already pre-filtered to the same sport), finds the one that's the
 * same matchup on the same day. Returns null if no confident match.
 */
function matchEspnEvent(espnEvent, dbMatches) {
  for (const match of dbMatches) {
    if (!sameCalendarDay(espnEvent.eventDate, match.startTime)) continue;

    const straightMatch =
      namesLikelyMatch(espnEvent.competitorAName, match.competitorA) &&
      namesLikelyMatch(espnEvent.competitorBName, match.competitorB);
    const swappedMatch =
      namesLikelyMatch(espnEvent.competitorAName, match.competitorB) &&
      namesLikelyMatch(espnEvent.competitorBName, match.competitorA);

    if (straightMatch || swappedMatch) return match;
  }
  return null;
}

module.exports = {
  // exported for testing — see the name-matching test cases
  namesLikelyMatch,
  normalizeName, fetchEspnLiveScores, matchEspnEvent, normalizeName };
