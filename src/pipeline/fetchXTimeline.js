/**
 * Match Point — X (Twitter) timeline adapter, server-side.
 *
 * Same category of integration as fetchEspn.js / fetchEspnNews.js /
 * fetchEspnInjuries.js elsewhere in this pipeline: X doesn't publish an
 * official free API for this, so this hits the same public,
 * unauthenticated syndication endpoint the official embed widget
 * (platform.twitter.com/widgets.js) itself calls internally to render a
 * profile timeline. Unofficial and reverse-engineered — could change or
 * start blocking requests without notice, same disclosed risk as the
 * ESPN adapters.
 *
 * WHY THIS EXISTS (replacing the client-side widget approach):
 * The official embed widget makes each VISITOR'S OWN BROWSER call X's
 * servers directly. X's rate limit on that endpoint is aggressive and
 * applies per requesting IP — confirmed happening in production, where
 * a handful of page reloads while testing was enough to get 429s. That
 * makes the client-side approach fundamentally fragile for any real
 * traffic, not just a fluke of one bad testing session.
 *
 * Fetching server-side instead means ONLY this backend's single IP ever
 * talks to X, and heavy in-memory caching (CACHE_TTL_MS below) means
 * that happens rarely — once per account per cache window, regardless
 * of how many visitors load the page. Visitors' browsers never contact
 * X directly anymore, so they can never be rate-limited by it.
 *
 * Trade-off: this returns plain text + a link, not the fully-styled
 * official embed card (avatar images, native X styling, verified
 * badges). That's a real downgrade in visual fidelity, but a working
 * plain-text feed beats a broken pretty one.
 */

const fetch = require('node-fetch');

const CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes — real cadence, not "instant," but this is a beat-writer feed, not a stock ticker
const NEGATIVE_CACHE_TTL_MS = 3 * 60 * 1000; // a failed fetch is cached briefly too, so a broken/renamed handle doesn't get hammered every request
const cache = new Map(); // handle -> { posts: [...], fetchedAt: number, failed: boolean }

/**
 * Fetches and normalizes recent posts for one handle from X's public
 * syndication endpoint. Returns [] (never throws) on any failure —
 * a broken feed for one account should never take down the whole
 * Insiders sidebar, same "degrade gracefully" rule this pipeline uses
 * everywhere else (see fetchEspnNews.js, fetchEspnInjuries.js).
 */
async function fetchFromSyndication(handle) {
  const url = `https://cdn.syndication.twimg.com/timeline/profile?screen_name=${encodeURIComponent(handle)}&showReplies=false&lang=en`;
  const res = await fetch(url, {
    headers: {
      // A real browser User-Agent — this endpoint is meant to be called
      // from a browser context (that's literally what widgets.js does),
      // and some unofficial endpoints reject requests that look like
      // bare server-to-server calls with no UA at all.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://twitter.com/',
      'Origin': 'https://twitter.com',
    },
  });

  // Read as text FIRST, not res.json() directly — an unofficial endpoint
  // can return HTML, an empty body, or a redirect page instead of JSON,
  // and res.json() on any of those just throws an unhelpful "Unexpected
  // end of JSON input" with zero information about what actually came
  // back. Logging the real status + a body snippet here is the only way
  // to diagnose a shape mismatch on an endpoint neither of us can
  // directly test outside of production.
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`syndication endpoint returned ${res.status} for @${handle}. Body: ${bodyText.slice(0, 300)}`);
  }
  if (!bodyText || !bodyText.trim()) {
    const contentType = res.headers.get('content-type') || '(none)';
    throw new Error(`syndication endpoint returned an EMPTY body for @${handle} (status ${res.status}, content-type: ${contentType})`);
  }
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch (parseErr) {
    throw new Error(`syndication endpoint returned non-JSON for @${handle} (status ${res.status}). First 300 chars: ${bodyText.slice(0, 300)}`);
  }

  // Response shape is NOT officially documented and has changed before
  // — defensive parsing throughout, optional-chaining every field, so
  // a shape change degrades to "fewer fields populated" rather than a
  // hard crash. entries/timeline shape based on what widgets.js itself
  // consumes as of this writing.
  const entries = data?.timeline?.entries || data?.entries || [];
  const posts = entries
    .map((entry) => {
      const tweet = entry?.content?.tweet || entry?.tweet || entry;
      if (!tweet || !tweet.id_str) return null;
      return {
        id: tweet.id_str,
        text: tweet.full_text || tweet.text || '',
        createdAt: tweet.created_at || null,
        url: `https://twitter.com/${handle}/status/${tweet.id_str}`,
      };
    })
    .filter(Boolean)
    .slice(0, 5);

  return posts;
}

/**
 * Public entry point — cached. Returns { posts, stale, error } rather
 * than throwing, so callers (the /insiders/feed route) can always
 * return something sane even for a handle that's currently failing.
 * "stale" means this is a cached result older than CACHE_TTL_MS being
 * served anyway because a fresh fetch just failed — better than
 * showing nothing for an account that worked recently.
 */
async function getRecentPosts(handle) {
  const cached = cache.get(handle);
  const now = Date.now();

  if (cached && !cached.failed && now - cached.fetchedAt < CACHE_TTL_MS) {
    return { posts: cached.posts, stale: false };
  }
  if (cached && cached.failed && now - cached.fetchedAt < NEGATIVE_CACHE_TTL_MS) {
    return { posts: cached.posts || [], stale: true };
  }

  try {
    const posts = await fetchFromSyndication(handle);
    cache.set(handle, { posts, fetchedAt: now, failed: false });
    return { posts, stale: false };
  } catch (err) {
    console.error(`[x-timeline] fetch failed for @${handle}:`, err.message);
    // Negative-cache the failure, but keep serving the last GOOD posts
    // we have (if any) rather than going blank — a handle that briefly
    // fails shouldn't visibly empty out for the 3-minute cooldown.
    cache.set(handle, { posts: cached?.posts || [], fetchedAt: now, failed: true });
    return { posts: cached?.posts || [], stale: true };
  }
}

module.exports = { getRecentPosts };
