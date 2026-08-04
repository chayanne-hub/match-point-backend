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
function normalizeName(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accent marks
    .replace(/[^a-zA-Z0-9\s]/g, '')  // strip punctuation
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
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

  const lastA = na.split(' ').pop();
  const lastB = nb.split(' ').pop();
  return lastA === lastB && lastA.length > 2; // avoid matching on short/common words
}

function sameCalendarDay(dateA, dateB) {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
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

  return {
    competitorAName: home.team?.displayName || home.team?.shortDisplayName,
    competitorBName: away.team?.displayName || away.team?.shortDisplayName,
    completed: !!competition.status?.type?.completed,
    inProgress: competition.status?.type?.state === 'in',
    setScore: null,
    eventDate: competition.date,
    homeScore: home.score !== undefined ? Number(home.score) : null,
    awayScore: away.score !== undefined ? Number(away.score) : null,
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

module.exports = { fetchEspnLiveScores, matchEspnEvent, normalizeName };
