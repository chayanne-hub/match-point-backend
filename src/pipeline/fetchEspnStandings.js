/**
 * Match Point — ESPN standings adapter.
 *
 * Same category of integration as fetchEspn.js / fetchEspnNews.js /
 * fetchEspnInjuries.js: ESPN's public, unauthenticated site API. Not
 * officially documented, could change shape without notice — parsed
 * defensively throughout, and a failure degrades to "no standings
 * shown" rather than breaking anything else.
 *
 * Used two ways:
 *   1. The League Standings view on the Rankings tab (raw standings).
 *   2. Joining each team's real season record onto the model power
 *      rankings (/api/picks/rankings).
 *
 * Tennis has no standings — ATP/WTA use tour rankings, a different
 * data shape ESPN doesn't expose the same way. getStandings('tennis')
 * returns [] honestly rather than faking something.
 */

const fetch = require('node-fetch');

// League codes per site sport slug. Soccer spans several real leagues —
// all fetched and returned as separate groups.
const LEAGUES_BY_SPORT = {
  basketball: [
    { code: 'nba', label: 'NBA', espnSport: 'basketball' },
    { code: 'wnba', label: 'WNBA', espnSport: 'basketball' },
  ],
  baseball: [{ code: 'mlb', label: 'MLB', espnSport: 'baseball' }],
  football: [{ code: 'nfl', label: 'NFL', espnSport: 'football' }],
  soccer: [
    { code: 'eng.1', label: 'Premier League', espnSport: 'soccer' },
    { code: 'esp.1', label: 'La Liga', espnSport: 'soccer' },
    { code: 'ita.1', label: 'Serie A', espnSport: 'soccer' },
    { code: 'ger.1', label: 'Bundesliga', espnSport: 'soccer' },
    { code: 'fra.1', label: 'Ligue 1', espnSport: 'soccer' },
    { code: 'usa.1', label: 'MLS', espnSport: 'soccer' },
  ],
  tennis: [], // tour rankings, not standings — see file header
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — standings change at most daily
const cache = new Map(); // sportSlug -> { groups, fetchedAt }

function statVal(stats, name) {
  const s = (stats || []).find((x) => x.name === name || x.type === name);
  return s ? s.value : null;
}

function parseEntries(entries, leagueLabel) {
  return (entries || [])
    .map((e) => {
      const name = e.team?.displayName || e.team?.name;
      if (!name) return null;
      const stats = e.stats || [];
      const wins = statVal(stats, 'wins');
      const losses = statVal(stats, 'losses');
      const ties = statVal(stats, 'ties');
      const winPct = statVal(stats, 'winPercent');
      const points = statVal(stats, 'points'); // soccer table points
      if (wins === null && losses === null) return null;
      return {
        name,
        league: leagueLabel,
        wins: wins ?? 0,
        losses: losses ?? 0,
        ties: ties ?? 0,
        winPct: winPct !== null ? Math.round(winPct * 1000) / 10 : null, // e.g. 63.4
        points: points ?? null,
        record: `${wins ?? 0}-${losses ?? 0}${ties ? `-${ties}` : ''}`,
      };
    })
    .filter(Boolean);
}

async function fetchLeagueStandings({ code, label, espnSport }) {
  const url = `https://site.api.espn.com/apis/v2/sports/${espnSport}/${code}/standings`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`ESPN standings ${code} returned ${res.status}`);
  const data = await res.json();

  // Two shapes seen in the wild: conference/division groups under
  // children[], or a flat standings.entries at the top level.
  let teams = [];
  if (Array.isArray(data.children) && data.children.length) {
    for (const child of data.children) {
      teams = teams.concat(parseEntries(child.standings?.entries, label));
    }
  } else {
    teams = parseEntries(data.standings?.entries, label);
  }

  // Sort by winPct (or points for soccer tables) descending — the order
  // a standings table is actually read in.
  teams.sort((a, b) => (b.points ?? b.winPct ?? 0) - (a.points ?? a.winPct ?? 0));
  return { league: label, code, teams };
}

/**
 * Returns [{ league, code, teams: [...] }] for a sport, cached. Failed
 * leagues are skipped (logged) rather than failing the whole sport —
 * one soccer league's endpoint hiccuping shouldn't blank all of them.
 */
async function getStandings(sportSlug) {
  const leagues = LEAGUES_BY_SPORT[sportSlug];
  if (!leagues || !leagues.length) return [];

  const cached = cache.get(sportSlug);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.groups;

  const groups = [];
  for (const lg of leagues) {
    try {
      groups.push(await fetchLeagueStandings(lg));
    } catch (err) {
      console.error(`[standings] ${lg.code} failed: ${err.message}`);
    }
  }
  if (groups.length) cache.set(sportSlug, { groups, fetchedAt: Date.now() });
  return groups;
}

/**
 * Flat name -> record lookup for joining season records onto other data
 * (the model power rankings). Keys are ESPN displayNames, which match
 * the full team names this pipeline already uses in matchups.
 */
async function getRecordMap(sportSlug) {
  const groups = await getStandings(sportSlug);
  const map = {};
  for (const g of groups) {
    for (const t of g.teams) {
      map[t.name] = { record: t.record, winPct: t.winPct, points: t.points, league: g.league };
    }
  }
  return map;
}

module.exports = { getStandings, getRecordMap };
