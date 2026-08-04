/**
 * Match Point — ESPN injury report adapter.
 *
 * Same unofficial-endpoint caveat as fetchEspn.js: this is reverse-engineered
 * from ESPN's own site traffic, not a licensed/documented API. Could change
 * or start blocking requests without notice.
 *
 * Two ESPN endpoints are involved:
 *   1. .../teams — lists every team in a league with its ESPN team ID.
 *      Used to resolve our own competitorA/competitorB names to ESPN IDs,
 *      since there's no shared ID between our DB and ESPN.
 *   2. sports.core.api.espn.com/.../teams/{id}/injuries — per-team injury
 *      report. This is a DIFFERENT ESPN subdomain than the scores/teams
 *      endpoints (sports.core.api.espn.com, not site.api.espn.com).
 *
 * This only covers team sports (basketball, football, baseball) — tennis
 * doesn't have a team-based injury report the same way, and soccer's ESPN
 * injury coverage hasn't been confirmed, so it's not wired in yet.
 */

const fetch = require('node-fetch');

const SITE_API_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const CORE_API_BASE = 'https://sports.core.api.espn.com/v2/sports';

// Which ESPN sport/league path(s) to use per sport. Basketball merges NBA
// and WNBA, matching the pattern from fetchEspn.js.
const ESPN_LEAGUES = {
  basketball: [
    { sport: 'basketball', league: 'nba' },
    { sport: 'basketball', league: 'wnba' },
  ],
  football: [{ sport: 'football', league: 'nfl' }],
  baseball: [{ sport: 'baseball', league: 'mlb' }],
};

function normalizeName(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function namesLikelyMatch(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const lastA = na.split(' ').pop();
  const lastB = nb.split(' ').pop();
  return lastA === lastB && lastA.length > 2;
}

/**
 * Fetches every team (with ESPN ID) across all leagues configured for a
 * sport. Cheap call, safe to re-fetch each pipeline run rather than cache
 * long-term — team lists don't change often but this avoids a second
 * moving part (cache invalidation) for a low-cost endpoint.
 */
async function fetchEspnTeams(sportSlug) {
  const leagues = ESPN_LEAGUES[sportSlug];
  if (!leagues) return [];

  const allTeams = [];
  for (const { sport, league } of leagues) {
    const url = `${SITE_API_BASE}/${sport}/${league}/teams?limit=100`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`[espn-injuries] ${league} teams request failed: ${res.status}`);
        continue;
      }
      const data = await res.json();
      const teams = data.sports?.[0]?.leagues?.[0]?.teams || [];
      for (const t of teams) {
        allTeams.push({
          id: t.team.id,
          league,
          displayName: t.team.displayName,
          shortDisplayName: t.team.shortDisplayName,
        });
      }
    } catch (err) {
      console.error(`[espn-injuries] ${league} teams fetch failed:`, err.message);
    }
  }
  return allTeams;
}

function findTeamId(teamName, espnTeams) {
  const match = espnTeams.find(
    (t) => namesLikelyMatch(teamName, t.displayName) || namesLikelyMatch(teamName, t.shortDisplayName)
  );
  return match || null;
}

/**
 * Fetches the injury report for one team. Returns a count of players
 * listed as "Out" — the one status that's unambiguous across sports and
 * doesn't require judging severity of "questionable"/"day-to-day" labels,
 * which vary in meaning by sport and reporter.
 */
async function fetchTeamInjuryCount(sport, league, teamId) {
  const url = `${CORE_API_BASE}/${sport}/leagues/${league}/teams/${teamId}/injuries`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.items || [];

    let outCount = 0;
    for (const item of items) {
      // Core API injury items are often references requiring a second
      // fetch for full detail; some responses inline the status instead.
      // Handle both shapes defensively.
      const status = item.status || item.type?.description || item.injuryStatus;
      if (typeof status === 'string' && status.toLowerCase().includes('out')) {
        outCount++;
      }
    }
    return outCount;
  } catch (err) {
    console.error(`[espn-injuries] team ${teamId} injuries fetch failed:`, err.message);
    return null;
  }
}

/**
 * Public entry point. Given a sport and the two competitor names as they
 * appear in our own DB, returns a -1..+1 factor (positive favors
 * competitorA, i.e. competitorB has more players out) or null if either
 * team couldn't be matched/fetched — callers should omit the factor
 * entirely on null, per the existing "don't fabricate a neutral 0" rule
 * used throughout scoreModel.js.
 */
async function computeInjuryFactor(sportSlug, competitorA, competitorB) {
  const leagueConfig = ESPN_LEAGUES[sportSlug];
  if (!leagueConfig) return null;

  const espnTeams = await fetchEspnTeams(sportSlug);
  const teamA = findTeamId(competitorA, espnTeams);
  const teamB = findTeamId(competitorB, espnTeams);
  if (!teamA || !teamB) return null;

  const sportPath = leagueConfig[0].sport; // 'basketball' | 'football' | 'baseball'
  const [outA, outB] = await Promise.all([
    fetchTeamInjuryCount(sportPath, teamA.league, teamA.id),
    fetchTeamInjuryCount(sportPath, teamB.league, teamB.id),
  ]);
  if (outA === null || outB === null) return null;

  // Each additional "Out" player shifts the factor by 0.15, capped at
  // +/-1. Arbitrary but reasonable starting weight — worth tuning once
  // there's enough graded history to backtest against, same caveat as
  // every other weight in scoreModel.js.
  const raw = (outB - outA) * 0.15;
  return Math.max(-1, Math.min(1, raw));
}

module.exports = { computeInjuryFactor, fetchEspnTeams, normalizeName };
