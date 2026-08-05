/**
 * Match Point — independent match analysis via Claude.
 *
 * This REPLACES the previous approach (compute confidence as a function of
 * betting odds, then have Claude describe that number afterward) with real
 * independent research: Claude gets a sport-specific brief on what actually
 * matters for that sport, uses its own web search to check it, and returns
 * its own pick + confidence + reasoning — free to disagree with the market
 * entirely, the same way a genuine handicapper would.
 *
 * Ported from the Smart Money Bot's matchAnalyst.js, adapted two ways:
 *   1. No named data sources with unclear/restrictive commercial licensing
 *      (the original hard-coded tennisabstract.com, which is explicitly
 *      non-commercial-licensed — a real problem for a paid product like
 *      this one). Claude is told WHAT to look for, not WHICH exact site to
 *      pull it from, and uses its own judgment on where to look.
 *   2. Selection is constrained to a plain "<competitor> ML" moneyline
 *      call, since that's the only format the grading/stats pipeline knows
 *      how to parse. Claude's reasoning can still discuss spread/total-
 *      level nuance in the analysis text — only the structured field is
 *      constrained.
 */

const fetch = require('node-fetch');

const ANTHROPIC_MODEL = process.env.MATCH_ANALYST_MODEL || 'claude-sonnet-5';

const SHARED_PRINCIPLES = `
Core approach: data over instinct. Look for what the market might be
under-pricing — angles a casual bettor or a lazily-set line wouldn't fully
account for. Avoid crowd bias — don't default to the more famous side just
because they're more famous. Think in probabilities, not certainties. Give a
real, differentiated confidence number — do not default to a lazy 50-55%
out of caution when the evidence actually supports a stronger or weaker lean,
but also don't force high confidence where the evidence is genuinely mixed.
`.trim();

const SPORT_PROCESS = {
  tennis: `
Tennis-specific process:
- Research each player's current ranking, recent form (last few results,
  not just ranking), and — most importantly — how they perform specifically
  on the surface this match is being played on. A player's overall ranking
  can hide a big surface-specific gap.
- Check recent match load and travel: back-to-back tournaments, long
  travel between events, and whether either player is coming off a long
  match or a walkover/retirement.
- Consider a playing-style matchup where relevant (e.g. a flat, aggressive
  hard-court hitter vs. a grinding clay-court retriever) — style matchups
  can matter as much as raw ranking gap.
- Consider motivation/level mismatch — a higher-ranked player might be
  treating a lower-tier event without full focus, or nursing an injury
  through it.
- Check the current moneyline price for this match as one data point
  (context on what the market already thinks), but your confidence should
  come from your own research, not from the price itself.
`.trim(),

  basketball: `
Basketball-specific process (NBA & WNBA):
- Research real per-possession offensive/defensive efficiency and pace for
  both teams, not just win-loss record — record alone hides a lot of noise
  from blowouts vs. close games.
- Check the most current injury report you can find — a scratched starter
  reported shortly before tip matters far more than any season-long trend.
- Check schedule fatigue specifically: back-to-backs, 3-games-in-4-nights,
  and long road trips with time-zone changes all measurably affect
  performance.
- Check stylistic matchups: pace mismatch, three-point volume mismatch,
  rebounding mismatch — not just "who's the better team" in the abstract.
- Check motivation explicitly: teams resting starters, already clinched or
  eliminated, or in a tanking spot — this affects true probability more
  than lines always adjust for, especially late in a season.
- WNBA-specific: smaller rosters and sample sizes mean a single injury or
  rest day swings true probability more than in the NBA — weight injury
  news more heavily than you would for an NBA game.
- Check the current moneyline price for this match as one data point, but
  your confidence should come from your own research, not from the price.
`.trim(),

  soccer: `
Soccer-specific process (any league/tier, not just top divisions):
- Research team strength using something more informative than table
  position or recent W/L alone — underlying performance quality (chances
  created/conceded, not just results) tends to be more predictive than
  results in a small recent sample.
- Check confirmed or strongly-rumored lineups as close to kickoff as you
  can find — squads rotate heavily for cup competitions and congested
  schedules.
- Check home/away form splits specifically, not just overall form — the
  gap between a team's home and away performance is often larger than
  casual bettors assume.
- Check situational stakes explicitly: relegation battles, European
  qualification races, dead rubbers (nothing left to play for), and
  cup-vs-league prioritization when a team has a bigger match coming up.
- For lower-tier/smaller leagues specifically: available data and market
  liquidity are genuinely thinner than top divisions — reflect that
  honestly in your confidence rather than presenting false precision.
- Check the current moneyline price for this match as one data point, but
  your confidence should come from your own research, not from the price.
`.trim(),

  baseball: `
Baseball-specific process (MLB):
- Research the starting pitcher matchup in real detail: recent form,
  velocity trend, and — where you can find it — how each pitcher's
  performance splits by opposing batter handedness (L/R), since an
  overall stat line can mask a real platoon split.
- Check bullpen fatigue: has either team's high-leverage relief corps been
  heavily used over the last several days? A taxed bullpen changes true
  win probability even behind a strong starter.
- Check park factors (some parks meaningfully favor hitters or pitchers)
  and weather where relevant — wind direction/speed at outdoor parks
  measurably affects total runs and home run likelihood.
- Check situational motivation (a team in a playoff race vs. one that's
  eliminated or resting regulars) and same-day lineup construction.
- IMPORTANT calibration note: MLB has much higher game-to-game variance
  than tennis or basketball — even a genuinely great team loses close to
  40% of its games, and single-game outcomes are noisier than the true
  talent gap suggests. Don't force tennis-level confidence onto baseball
  picks just because the underlying edge feels similar; a well-supported
  baseball edge often deserves real but more moderate confidence than the
  same-strength case would in a lower-variance sport. Still commit to
  genuine differentiation — don't default to 50-55% out of caution — but
  calibrate against baseball's actual variance.
- Check the current moneyline price for this match as one data point, but
  your confidence should come from your own research, not from the price.
`.trim(),

  football: `
NFL-specific process:
- Check quarterback status above all else — a backup QB is the single
  biggest line-mover in football, and injury news timing (especially
  Friday/Saturday reports) can lag what's actually happening.
- Check rest and travel: short weeks (Thursday games), bye-week timing,
  and cross-country travel (especially West-to-East early kickoffs) have
  measurable effects.
- Check situational motivation: playoff seeding implications, division
  rivalries, "trap game" spots before a bigger opponent, and any team that
  may be resting starters or is effectively out of contention.
- Check weather for outdoor games — wind in particular suppresses passing
  and total points more than temperature does.
- Check matchup-specific efficiency metrics where you can find them (e.g.
  offensive/defensive efficiency splits, pressure rate vs. offensive line
  performance) rather than just season record or point differential.
- Check the current moneyline price for this match as one data point, but
  your confidence should come from your own research, not from the price.
`.trim(),
};

function buildSystemPrompt(sport) {
  const process = SPORT_PROCESS[sport];
  if (!process) return null;

  return `
You are an experienced sports betting analyst doing independent handicapping
research for one specific match. You have web search available — use it to
research real, current information about this match before forming a view.

${SHARED_PRINCIPLES}

${process}
`.trim();
}

/**
 * Runs real independent research on one match via Claude + web search, and
 * returns a pick, confidence, written analysis, and a structured factor
 * breakdown (for the pick-detail page's "how this was graded" section).
 *
 * Returns null (never throws) on any failure — callers should have a
 * fallback plan (e.g. skip creating a pick this cycle) rather than crash
 * the pipeline over one bad match.
 */
async function analyzeMatch({ sport, competitorA, competitorB, oddsA, oddsB, startTime }) {
  const systemPrompt = buildSystemPrompt(sport);
  if (!systemPrompt) {
    console.error(`[match-analyst] no process defined for sport: ${sport}`);
    return null;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[match-analyst] ANTHROPIC_API_KEY not set — cannot run independent analysis.');
    return null;
  }

  const oddsContext = (oddsA !== null && oddsB !== null)
    ? `Current moneyline price: ${competitorA} ${oddsA > 0 ? '+' + oddsA : oddsA}, ${competitorB} ${oddsB > 0 ? '+' + oddsB : oddsB} (BetMGM).`
    : 'Current moneyline price: not available.';

  const jsonInstruction = `
Do not narrate your process — no "I'll research this by...", no summary of
what you searched for, nothing before or after. Your final message must
contain ONLY the JSON object below and nothing else.

The "selection" field MUST be exactly one of these two strings, verbatim:
"${competitorA} ML" or "${competitorB} ML" — do not use a spread, total, or
any other format, even if your analysis discusses those. This is a straight
moneyline call: who wins.

The "factors" field is an array of the specific things you actually
checked that meaningfully informed this pick — do not include a factor you
didn't really look into. Each entry needs:
  - "label": a short category name (e.g. "Recent Form", "Injury Report",
    "Surface Fit", "Rest & Travel", "Matchup Style")
  - "tag": exactly "Favors ${competitorA}", "Favors ${competitorB}", or
    "Neutral"
  - "body": one sentence stating the specific finding

Respond with ONLY a raw JSON object, no markdown fences, no preamble, in
this exact shape:
{
  "selection": "${competitorA} ML" or "${competitorB} ML",
  "confidence": <integer 0-100>,
  "analysis": "2-4 sentence writeup citing the specific findings that drove this pick",
  "factors": [ { "label": "...", "tag": "...", "body": "..." }, ... ]
}
`.trim();

  const matchDescription = `${competitorA} vs ${competitorB} (${sport}), ${new Date(startTime).toISOString()}. ${oddsContext}`;

  // Real research with web search can legitimately take a while, but a
  // single hung request must never be allowed to block the entire
  // sequential pipeline run indefinitely — every match after it would
  // wait forever too. 90s is generous for a multi-search-round-trip
  // research call while still guaranteeing forward progress.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        system: `${systemPrompt}\n\n${jsonInstruction}`,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: `Analyze this match:\n\n${matchDescription}` }],
      }),
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.error(`[match-analyst] Anthropic API returned ${res.status} for ${competitorA} vs ${competitorB}`);
      return null;
    }

    const data = await res.json();

    // Claude often narrates around tool use ("I'll research this by
    // searching for..."), so the response can contain multiple text
    // blocks — the LAST one is the final answer, after any search tool
    // calls have completed.
    const textBlocks = (data.content || []).filter((b) => b.type === 'text');
    if (!textBlocks.length) {
      console.error(`[match-analyst] no text response from Claude for ${competitorA} vs ${competitorB}`);
      return null;
    }
    const finalText = textBlocks[textBlocks.length - 1].text;

    const withoutFences = finalText.replace(/```json|```/g, '').trim();
    const jsonMatch = withoutFences.match(/\{[\s\S]*\}/);
    const cleaned = jsonMatch ? jsonMatch[0] : withoutFences;

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error(`[match-analyst] failed to parse Claude's JSON for ${competitorA} vs ${competitorB}: ${err.message}`);
      return null;
    }

    const validSelections = [`${competitorA} ML`, `${competitorB} ML`];
    if (
      !validSelections.includes(parsed.selection) ||
      typeof parsed.confidence !== 'number' ||
      typeof parsed.analysis !== 'string' ||
      !Array.isArray(parsed.factors)
    ) {
      console.error(`[match-analyst] Claude's response missing/invalid required fields for ${competitorA} vs ${competitorB}: ${cleaned}`);
      return null;
    }

    parsed.confidence = Math.max(0, Math.min(100, Math.round(parsed.confidence)));
    return parsed;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error(`[match-analyst] request timed out after 90s for ${competitorA} vs ${competitorB} — skipping this cycle.`);
    } else {
      console.error(`[match-analyst] request failed for ${competitorA} vs ${competitorB}:`, err.message);
    }
    return null;
  }
}

/**
 * Periodically re-evaluates a LIVE match given how it's actually playing
 * out. Deliberately different from analyzeMatch(): no web search tool
 * (this runs repeatedly for every live match, so it needs to be fast and
 * cheap — a full research call every cycle would be neither), and it's
 * explicitly told to weigh the live score and the players' known
 * skill/history alongside the current odds, never let odds alone drive
 * the number. Current odds ARE included as real signal (fast market
 * movement can reflect real information — an injury visible on court,
 * fatigue, momentum) — the instruction is against over-relying on them,
 * not against using them at all.
 *
 * Returns the same shape as analyzeMatch(): { selection, confidence,
 * analysis, factors }. Returns null (never throws) on failure.
 */
async function reassessLiveMatch({ sport, competitorA, competitorB, liveScore, oddsA, oddsB, priorAnalysis }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[match-analyst] ANTHROPIC_API_KEY not set — cannot reassess live match.');
    return null;
  }

  const oddsContext = (oddsA !== null && oddsB !== null)
    ? `Current live moneyline price: ${competitorA} ${oddsA > 0 ? '+' + oddsA : oddsA}, ${competitorB} ${oddsB > 0 ? '+' + oddsB : oddsB} (BetMGM).`
    : 'Current live moneyline price: not available.';

  const jsonInstruction = `
Do not narrate your process. Your final message must contain ONLY the JSON
object below and nothing else.

The "selection" field MUST be exactly one of these two strings, verbatim:
"${competitorA} ML" or "${competitorB} ML".

The "factors" field is an array of the specific things that actually
informed this updated read. Each entry needs "label" (short category, e.g.
"Live Score", "Momentum", "Current Odds", "Pre-Match Scouting"), "tag"
(exactly "Favors ${competitorA}", "Favors ${competitorB}", or "Neutral"),
and "body" (one sentence).

Respond with ONLY a raw JSON object, in this exact shape:
{
  "selection": "${competitorA} ML" or "${competitorB} ML",
  "confidence": <integer 0-100>,
  "analysis": "1-3 sentence updated read given how the match is actually going",
  "factors": [ { "label": "...", "tag": "...", "body": "..." }, ... ]
}
`.trim();

  const prompt = `
You are re-evaluating a match that's currently IN PROGRESS, given both your
original pre-match scouting and how the match has actually unfolded so far.

Match: ${competitorA} vs ${competitorB} (${sport})
Current score: ${liveScore || 'not available'}
${oddsContext}

Your original pre-match analysis:
${priorAnalysis || '(not available)'}

Give an updated read on who wins from here. Weigh the live score and each
player's known skill/tendencies/history (from your original scouting)
together with the current odds — the odds ARE real signal (fast market
movement can reflect something real happening, like an injury or a
momentum shift), but do not let them be the ONLY thing driving your
number. Odds alone can move quickly and don't always reflect the full
picture. Commit to a real, differentiated confidence number based on your
actual judgment of the match state.

${jsonInstruction}
`.trim();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000); // shorter than analyzeMatch()'s 90s — no search tool, should resolve faster

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.error(`[match-analyst] live reassessment API returned ${res.status} for ${competitorA} vs ${competitorB}`);
      return null;
    }

    const data = await res.json();
    const textBlocks = (data.content || []).filter((b) => b.type === 'text');
    if (!textBlocks.length) return null;
    const finalText = textBlocks[textBlocks.length - 1].text;

    const withoutFences = finalText.replace(/```json|```/g, '').trim();
    const jsonMatch = withoutFences.match(/\{[\s\S]*\}/);
    const cleaned = jsonMatch ? jsonMatch[0] : withoutFences;

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error(`[match-analyst] failed to parse live reassessment JSON for ${competitorA} vs ${competitorB}: ${err.message}`);
      return null;
    }

    const validSelections = [`${competitorA} ML`, `${competitorB} ML`];
    if (
      !validSelections.includes(parsed.selection) ||
      typeof parsed.confidence !== 'number' ||
      typeof parsed.analysis !== 'string' ||
      !Array.isArray(parsed.factors)
    ) {
      console.error(`[match-analyst] live reassessment missing/invalid fields for ${competitorA} vs ${competitorB}: ${cleaned}`);
      return null;
    }

    parsed.confidence = Math.max(0, Math.min(100, Math.round(parsed.confidence)));
    return parsed;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error(`[match-analyst] live reassessment timed out for ${competitorA} vs ${competitorB} — skipping this cycle.`);
    } else {
      console.error(`[match-analyst] live reassessment failed for ${competitorA} vs ${competitorB}:`, err.message);
    }
    return null;
  }
}

module.exports = { analyzeMatch, reassessLiveMatch };
