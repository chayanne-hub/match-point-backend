/**
 * Match Point — ESPN news headlines adapter.
 *
 * Same unofficial-endpoint caveat as fetchEspn.js and fetchEspnInjuries.js:
 * reverse-engineered from ESPN's own site traffic, not a licensed/documented
 * API. Could change or start blocking requests without notice.
 *
 * This deliberately does NOT reproduce article bodies — just the headline,
 * a short description ESPN itself provides in the feed, publish time, a
 * thumbnail if present, and a link back to the real article on ESPN. Full
 * article text is never fetched or stored anywhere; users click through to
 * ESPN to actually read it.
 */

const fetch = require('node-fetch');

const SITE_API_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// Same per-sport league mapping fetchEspn.js already uses for scores, kept
// consistent rather than inventing a different set of leagues for news.
const ESPN_LEAGUES = {
  tennis: ['tennis/atp', 'tennis/wta'],
  basketball: ['basketball/nba', 'basketball/wnba'],
  baseball: ['baseball/mlb'],
  football: ['football/nfl'],
  soccer: ['soccer/eng.1', 'soccer/uefa.champions'],
};

/**
 * Fetches and normalizes news headlines for one sport across its ESPN
 * sub-leagues (e.g. basketball merges NBA + WNBA). Returns a flat array,
 * newest first, deduplicated by headline (some ESPN leagues return
 * overlapping wire stories).
 */
async function fetchEspnNews(sportSlug, limit = 15) {
  const leagues = ESPN_LEAGUES[sportSlug];
  if (!leagues) {
    console.warn(`[espn-news] no ESPN league mapping for sport: ${sportSlug}`);
    return [];
  }

  const seen = new Set();
  const results = [];

  for (const league of leagues) {
    const url = `${SITE_API_BASE}/${league}/news?limit=${limit}`;
    let data;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`[espn-news] ${league} request failed: ${res.status} ${res.statusText}`);
        continue;
      }
      data = await res.json();
    } catch (err) {
      console.error(`[espn-news] ${league} fetch failed:`, err.message);
      continue;
    }

    const articles = data.articles || [];
    for (const a of articles) {
      const headline = a.headline || a.title;
      if (!headline || seen.has(headline)) continue;
      seen.add(headline);

      results.push({
        headline,
        description: a.description || null,
        link: a.links?.web?.href || null,
        published: a.published || null,
        image: a.images?.[0]?.url || null,
        league,
      });
    }
  }

  // Newest first — ESPN's own order roughly does this already, but
  // sorting explicitly across merged leagues (e.g. NBA + WNBA) keeps a
  // consistent chronological feed rather than one league's stories
  // clustered ahead of the other's.
  results.sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
  return results.slice(0, limit);
}

module.exports = { fetchEspnNews };
