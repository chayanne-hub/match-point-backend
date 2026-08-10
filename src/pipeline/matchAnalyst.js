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
// Used only for fixing a broken JSON response — the content/reasoning is
// already done at that point, so this is a cheap mechanical task, not
// real analysis. Deliberately a smaller/cheaper model than the main
// research call, same reasoning as generateRationale.js's Haiku use.
const JSON_REPAIR_MODEL = process.env.JSON_REPAIR_MODEL || 'claude-haiku-4-5-20251001';

// Reused in every prompt that asks Claude for structured JSON — the most
// common cause of parse failures in practice is natural writing habits
// (an apostrophe in "Fils' game", a literal line break in a longer
// analysis) breaking strict JSON string syntax. Repeating this
// instruction close to the schema itself (not just once at the top of a
// long prompt) measurably reduces how often that happens.
const JSON_VALIDITY_REMINDER = `
Your response must be syntactically valid JSON. Specifically: escape any
double-quote character that appears inside a string value as \\", escape
any apostrophe-containing contraction normally (apostrophes don't need
escaping, but a stray unescaped double-quote does), and never include a
literal line break inside a string value — write it as one continuous
line instead. Double-check your JSON is valid before finishing your
response.`;

/**
 * Attempts to parse Claude's JSON, with one repair pass if the raw parse
 * fails: literal control characters (a raw newline, tab, or carriage
 * return) sitting inside what's otherwise a valid JSON string are the
 * single most common real-world cause of "Unterminated string" / bad
 * JSON from an LLM — this escapes any that survived despite the prompt
 * instruction above, then retries the parse once. Returns null (never
 * throws) if both attempts fail, exactly like a normal JSON.parse
 * failure — callers already handle a null/failed parse.
 */
function parseClaudeJson(text) {
  try {
    return JSON.parse(text);
  } catch (firstErr) {
    // Escape raw control characters that appear anywhere in the text —
    // safe to do broadly here since valid JSON structural whitespace
    // (between keys/braces) tolerates this transform fine; it's only
    // needed for the invalid case where one snuck inside a string.
    const repaired = text.replace(/[\u0000-\u001F]/g, (ch) => {
      if (ch === '\n') return '\\n';
      if (ch === '\r') return '';
      if (ch === '\t') return '\\t';
      return ''; // drop other stray control characters entirely
    });
    try {
      return JSON.parse(repaired);
    } catch (secondErr) {
      return null; // caller logs using the original error for a clearer message
    }
  }
}

/**
 * Last-resort repair: sends Claude its OWN broken JSON and asks for a
 * syntax-only fix. Deliberately cheap — no web search tool, a small
 * prompt, and the fast/cheap model — since the actual research and
 * reasoning already happened in the original (expensive) call; this is
 * purely a mechanical fix, not a re-analysis. Only called when the local
 * repair in parseClaudeJson() has already failed.
 *
 * Returns the parsed object, or null if this also fails (never throws) —
 * at that point the caller gives up for this cycle, same as before, but
 * the local + Claude repair pair together should catch the large
 * majority of cases that used to be a fully wasted expensive call.
 */
async function repairJsonViaClaude(brokenText, context) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const prompt = `The following text was supposed to be a single valid JSON object but has a syntax error (extra/missing punctuation, an unescaped quote, a stray line break inside a string, etc.). Fix ONLY the syntax — do not change, add, or remove any actual content, wording, or values. Respond with ONLY the corrected JSON object, nothing else, no markdown fences.

${brokenText}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: JSON_REPAIR_MODEL,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      console.error(`[match-analyst] JSON repair call itself failed (${res.status}) for ${context}`);
      return null;
    }
    const data = await res.json();
    const text = data.content?.[0]?.text?.trim();
    if (!text) return null;

    const withoutFences = text.replace(/```json|```/g, '').trim();
    const jsonMatch = withoutFences.match(/\{[\s\S]*\}/);
    const cleaned = jsonMatch ? jsonMatch[0] : withoutFences;
    const parsed = parseClaudeJson(cleaned);
    if (parsed) {
      console.log(`[match-analyst] Claude JSON repair succeeded for ${context} — saved an otherwise-wasted analysis call.`);
    }
    return parsed;
  } catch (err) {
    console.error(`[match-analyst] JSON repair call errored for ${context}:`, err.message);
    return null;
  }
}

const SHARED_PRINCIPLES = `
Core approach: data over instinct. Look for what the market might be
under-pricing — angles a casual bettor or a lazily-set line wouldn't fully
account for. Avoid crowd bias — don't default to the more famous side just
because they're more famous. Think in probabilities, not certainties. Give a
real, differentiated confidence number — do not default to a lazy 50-55%
out of caution when the evidence actually supports a stronger or weaker lean,
but also don't force high confidence where the evidence is genuinely mixed.

Calibration matters more than decisiveness. A stated confidence of 75% is a
claim that this side wins roughly 3 times out of 4 in genuinely comparable
spots — not just "the side you like more." Be honest with yourself about
whether the evidence actually supports that claim. Use this scale as the
real anchor for what each range means, not just a rough feel:

- 85-100%: an overwhelming gap, a near-lock. Reserve this for cases where
  multiple INDEPENDENT factors genuinely converge — not one strong signal
  doing all the work while the rest are neutral or thin.
- 65-84%: a clear, well-supported favorite. This is where most genuine
  edges land — real signal, but not overwhelming.
- 45-64%: a genuine toss-up, or the data is too thin to say more. This is
  not hedging — it's an honest report of a close case, and a useful signal
  in its own right. Most matches with mixed or limited evidence belong here.
- Below 45%: you are picking against what the data or market implies. This
  should be rare and should only happen when you have a specific,
  well-supported reason to think the market or the raw numbers are wrong
  — not as a default landing spot.

If your case for 85%+ rests on a single factor, or you notice yourself
rounding up to sound more decisive than the evidence supports, that's the
signal to bring the number back down — not a reason to look for one more
supporting detail to justify it.

Research efficiently — aim for roughly 3-5 searches total, not one
exhaustive search per item in the checklist below. Some of what's asked
for (e.g. bullpen usage over the last several days, pitcher platoon
splits) is genuinely harder to find via search than other things (e.g.
injury reports, rankings) — if a specific data point isn't turning up
after a reasonable search or two, note that as a real limitation in your
analysis and move on, rather than continuing to search for it. A
timely, honest answer that says "couldn't confirm bullpen usage, so this
factor carries less weight" is far more useful than a slow one that
never finishes.
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
async function analyzeMatch({ sport, competitorA, competitorB, oddsA, oddsB, startTime, spread, spreadOddsA, spreadOddsB, total, overOdds, underOdds, pregameProjectedTotal }) {
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

  // Spread/total lines are optional — a book may not have posted them yet.
  // Only ask Claude for a view on a market that actually exists; never
  // request a pick against a line that isn't real.
  const hasSpread = spread !== null && spread !== undefined && spreadOddsA !== null && spreadOddsB !== null;
  const hasTotal = total !== null && total !== undefined && overOdds !== null && underOdds !== null;

  const spreadLineA = hasSpread ? spread : null; // signed relative to competitorA
  const spreadLineB = hasSpread ? -spread : null;
  const spreadContext = hasSpread
    ? `Current point spread: ${competitorA} ${spreadLineA > 0 ? '+' : ''}${spreadLineA} (${spreadOddsA > 0 ? '+' : ''}${spreadOddsA}), ${competitorB} ${spreadLineB > 0 ? '+' : ''}${spreadLineB} (${spreadOddsB > 0 ? '+' : ''}${spreadOddsB}) (BetMGM).`
    : 'Point spread: not available for this match yet.';
  const totalContext = hasTotal
    ? `Current total: ${total} (Over ${overOdds > 0 ? '+' : ''}${overOdds} / Under ${underOdds > 0 ? '+' : ''}${underOdds}) (BetMGM).`
    : 'Total (over/under): not available for this match yet.';

  const spreadInstructionBlock = hasSpread ? `

Also give an independent spread pick. The line is ${competitorA} ${spreadLineA > 0 ? '+' : ''}${spreadLineA} / ${competitorB} ${spreadLineB > 0 ? '+' : ''}${spreadLineB}.
"spreadPick.selection" MUST be exactly one of these two strings, verbatim:
"${competitorA} ${spreadLineA > 0 ? '+' : ''}${spreadLineA}" or "${competitorB} ${spreadLineB > 0 ? '+' : ''}${spreadLineB}".
This is a genuinely separate judgment from your moneyline pick — a team can be
the right moneyline pick and still be the wrong side of the spread (e.g. a
likely winner that you don't think wins by enough to cover), or vice versa.
Give your own honest read on the margin, not just a copy of your moneyline lean.` : '';

  // Sport-specific guidance for what actually moves a total, beyond the
  // shared formula baseline — genuinely different weighting per sport,
  // not just reworded copy.
  const TOTAL_GUIDANCE = {
    basketball: 'pace/style fit, injuries, motivation/stakes, and head-to-head history',
    football: 'weather (wind and cold suppress passing/kicking totals more than any indoor-sport factor), pace/plays-per-game (run-heavy clock-control offenses run far fewer snaps — weight this more heavily than "pace" matters in basketball), QB/O-line injuries (a backup QB or missing starting O-line pieces tends to crater a total more than a single missing skill player), and divisional/rivalry familiarity (division games often trend lower-scoring than raw stats suggest, since both defenses know the opponent well)',
    baseball: "starting pitcher quality and handedness (this often matters more than either team's overall offensive average — a strong starter can suppress a total by 2-3 runs on its own, and lefty/righty platoon splits shift things further), ballpark factors (some parks are notorious run-inflators — thin air, short fences — or suppressors; a bigger, more consistent effect here than home-court advantage in basketball), bullpen strength (a good team can still leak runs late if the bullpen is thin), and weather/wind (wind blowing out inflates totals, especially at open-air parks)",
    tennis: "hold percentage and break points (the single biggest lever — two big servers who both hold easily tend to produce longer matches in total games even at a close-looking score margin, while a match with lots of breaks can end in low-game blowouts despite feeling competitive on paper), surface (clay produces more games per set on average — longer rallies, harder to hold/close — while hard and grass tend to run shorter), and Elo gap (a big mismatch often means fewer total games — a straight-sets blowout — while a close gap often means more)",
    soccer: "xG (expected goals) over actual goals — a team can score 3 in a game they were lucky in, or 0 in a game they dominated, so xG-based averages are far more predictive than raw goals scored/conceded — home/away splits (soccer's home advantage is one of the largest in sports, bigger than in the other sports covered here), missing a key striker or starting keeper (moves a total meaningfully more than a role-player injury would in basketball), and match stakes (a dead rubber or an already-eliminated/already-through team tends to deflate scoring; a must-win tends to inflate it)",
  };
  const totalGuidance = TOTAL_GUIDANCE[sport] || 'pace/scoring-environment research relevant to this sport';

  // The unit word and the description of what avgA/avgB actually mean
  // both genuinely differ per sport — tennis's figure isn't "how many
  // games this player won," it's "the total-games figure of matches this
  // player recently played in" (a proxy for their own hold/break
  // tendencies plus recent opponent quality), which needs its own
  // sentence rather than a reused "TeamX averaged N points" template.
  const pregameBaselineText = pregameProjectedTotal ? (
    sport === 'tennis'
      ? `

A simple formula-based baseline projects the total at ${pregameProjectedTotal.projectedTotal} games
(the average of ${competitorA}'s and ${competitorB}'s own recent-match total-games figures — i.e.
how many total games matches involving each of them have produced over their last 3 matches, not
how many games either of them personally won: ${competitorA}'s matches averaged
${pregameProjectedTotal.avgA} total games, ${competitorB}'s averaged ${pregameProjectedTotal.avgB}).
Treat this as your real starting point, then adjust it up or down using the factors above — those
are layered ON TOP of the baseline, not replacements for it. Don't just default to the raw formula
number unadjusted, and don't ignore it either.`
      : sport === 'soccer'
      ? `

A simple formula-based baseline projects the total at ${pregameProjectedTotal.projectedTotal} goals.
It blends each team's own scoring with what they tend to concede (over their last 3 matches):
${competitorA} has averaged ${pregameProjectedTotal.scoredA} scored / ${pregameProjectedTotal.concededA}
conceded; ${competitorB} has averaged ${pregameProjectedTotal.scoredB} scored /
${pregameProjectedTotal.concededB} conceded. This is raw goals, not xG — treat it as your real
starting point, then adjust it up or down using the factors above (xG over raw goals especially —
a team's raw scoring average can be misleadingly high or low relative to their underlying process).
Those factors are layered ON TOP of the baseline, not replacements for it. Don't just default to the
raw formula number unadjusted, and don't ignore it either.`
      : `

A simple formula-based baseline projects the total at ${pregameProjectedTotal.projectedTotal}
${sport === 'baseball' ? 'runs' : 'points'}
(${competitorA} averaged ${pregameProjectedTotal.avgA} ${sport === 'baseball' ? 'runs' : 'points'} and
${competitorB} averaged ${pregameProjectedTotal.avgB} ${sport === 'baseball' ? 'runs' : 'points'} over
their last 3 games — this is just recent scoring average, nothing else). Treat this as your real
starting point, then adjust it up or down using the factors above — those are layered ON TOP of the
baseline, not replacements for it. Don't just default to the raw formula number unadjusted, and
don't ignore it either.`
  ) : '';

  const totalInstructionBlock = hasTotal ? `

Also give an independent total (over/under) pick. The line is ${total}.
"totalPick.selection" MUST be exactly one of these two strings, verbatim:
"Over ${total}" or "Under ${total}".
Base this on real research into ${totalGuidance} — not on which side you
picked to win, a total pick is about combined scoring, not who wins.${pregameBaselineText}` : '';

  const jsonInstruction = `
Do not narrate your process — no "I'll research this by...", no summary of
what you searched for, nothing before or after. Your final message must
contain ONLY the JSON object below and nothing else.

The "selection" field MUST be exactly one of these two strings, verbatim:
"${competitorA} ML" or "${competitorB} ML" — do not use a spread, total, or
any other format, even if your analysis discusses those. This is a straight
moneyline call: who wins.
${spreadInstructionBlock}
${totalInstructionBlock}

The "factors" field is an array of the specific things you actually
checked that meaningfully informed your MONEYLINE pick — do not include a
factor you didn't really look into. Each entry needs:
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
  "factors": [ { "label": "...", "tag": "...", "body": "..." }, ... ]${hasSpread ? `,
  "spreadPick": { "selection": "${competitorA} ${spreadLineA > 0 ? '+' : ''}${spreadLineA}" or "${competitorB} ${spreadLineB > 0 ? '+' : ''}${spreadLineB}", "confidence": <integer 0-100>, "analysis": "1-2 sentences" }` : ''}${hasTotal ? `,
  "totalPick": { "selection": "Over ${total}" or "Under ${total}", "confidence": <integer 0-100>, "analysis": "1-2 sentences" }` : ''}
}
${JSON_VALIDITY_REMINDER}
`.trim();

  const matchDescription = `${competitorA} vs ${competitorB} (${sport}), ${new Date(startTime).toISOString()}. ${oddsContext} ${spreadContext} ${totalContext}`;

  // Real research with web search can legitimately take a while, but a
  // single hung request must never be allowed to block the entire
  // sequential pipeline run indefinitely — every match after it would
  // wait forever too. Was 90s; raised to 150s after real logs showed
  // multiple baseball matches timing out on BOTH the first attempt and
  // the retry, back to back — meaning 90s was cutting off requests that
  // may well have finished successfully given a bit more room, and
  // failing twice wastes strictly MORE real spend for zero output than
  // one longer, successful call would have cost. Concurrency is still
  // capped globally (see MAX_CONCURRENT_ANALYSIS in cron.js), so a
  // slower match holding its slot longer doesn't risk the kind of
  // pile-up that caused problems before — it's a genuinely safer trade
  // now than it would have been without that cap in place.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 150000);

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
        // Was 1500 — too tight. web_search is a server-side tool, but every
        // search round's tool_use block and any narration between searches
        // still counts against this SAME output budget as the final JSON
        // answer. A match needing several search rounds could burn the
        // whole budget before ever reaching the actual analysis/factors/
        // spreadPick/totalPick — producing either a truncated, unparseable
        // JSON response or, worse, no text response at all (the two
        // dominant failure modes in production logs). Real headroom here
        // directly reduces both.
        max_tokens: 5000,
        system: `${systemPrompt}\n\n${jsonInstruction}`,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: `Analyze this match:\n\n${matchDescription}` }],
      }),
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '(could not read response body)');
      console.error(`[match-analyst] Anthropic API returned ${res.status} for ${competitorA} vs ${competitorB}: ${errBody}`);
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

    let parsed = parseClaudeJson(cleaned);
    if (!parsed) {
      parsed = await repairJsonViaClaude(cleaned, `${competitorA} vs ${competitorB} (pregame analysis)`);
    }
    if (!parsed) {
      console.error(`[match-analyst] failed to parse Claude's JSON for ${competitorA} vs ${competitorB} even after repair attempts. Raw text: ${cleaned.slice(0, 300)}`);
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

    // spreadPick/totalPick are validated separately and dropped (not
    // treated as a whole-response failure) if malformed — the moneyline
    // pick is still good and shouldn't be thrown away because Claude
    // botched a secondary field's format.
    if (hasSpread) {
      const validSpreadSelections = [
        `${competitorA} ${spreadLineA > 0 ? '+' : ''}${spreadLineA}`,
        `${competitorB} ${spreadLineB > 0 ? '+' : ''}${spreadLineB}`,
      ];
      if (
        parsed.spreadPick &&
        validSpreadSelections.includes(parsed.spreadPick.selection) &&
        typeof parsed.spreadPick.confidence === 'number' &&
        typeof parsed.spreadPick.analysis === 'string'
      ) {
        parsed.spreadPick.confidence = Math.max(0, Math.min(100, Math.round(parsed.spreadPick.confidence)));
      } else {
        if (parsed.spreadPick) console.warn(`[match-analyst] dropping malformed spreadPick for ${competitorA} vs ${competitorB}`);
        parsed.spreadPick = null;
      }
    } else {
      parsed.spreadPick = null;
    }

    if (hasTotal) {
      const validTotalSelections = [`Over ${total}`, `Under ${total}`];
      if (
        parsed.totalPick &&
        validTotalSelections.includes(parsed.totalPick.selection) &&
        typeof parsed.totalPick.confidence === 'number' &&
        typeof parsed.totalPick.analysis === 'string'
      ) {
        parsed.totalPick.confidence = Math.max(0, Math.min(100, Math.round(parsed.totalPick.confidence)));
      } else {
        if (parsed.totalPick) console.warn(`[match-analyst] dropping malformed totalPick for ${competitorA} vs ${competitorB}`);
        parsed.totalPick = null;
      }
    } else {
      parsed.totalPick = null;
    }

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
${JSON_VALIDITY_REMINDER}
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
        max_tokens: 1200, // was 800 — small margin added since this still writes a full factors array
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '(could not read response body)');
      console.error(`[match-analyst] live reassessment API returned ${res.status} for ${competitorA} vs ${competitorB}: ${errBody}`);
      return null;
    }

    const data = await res.json();
    const textBlocks = (data.content || []).filter((b) => b.type === 'text');
    if (!textBlocks.length) return null;
    const finalText = textBlocks[textBlocks.length - 1].text;

    const withoutFences = finalText.replace(/```json|```/g, '').trim();
    const jsonMatch = withoutFences.match(/\{[\s\S]*\}/);
    const cleaned = jsonMatch ? jsonMatch[0] : withoutFences;

    let parsed = parseClaudeJson(cleaned);
    if (!parsed) {
      parsed = await repairJsonViaClaude(cleaned, `${competitorA} vs ${competitorB} (live moneyline reassessment)`);
    }
    if (!parsed) {
      console.error(`[match-analyst] failed to parse live reassessment JSON for ${competitorA} vs ${competitorB} even after repair attempts. Raw text: ${cleaned.slice(0, 300)}`);
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

/**
 * Live total reassessment — parallel to reassessLiveMatch() but for the
 * total (over/under) market specifically, since the selection format and
 * grounding data are genuinely different (a live pace projection, not a
 * live score + odds).
 *
 * liveProjection is the real, computed output of
 * basketballTotals.computeLiveProjectedTotal() — this function's job is
 * to take that real number and layer real basketball judgment on top of
 * it (garbage time, a team sitting on a lead, foul trouble, a trailing
 * team pushing tempo), not to recompute the math itself.
 *
 * Returns { selection, confidence, analysis } or null on failure — same
 * never-throws contract as every other function in this file.
 */
async function reassessLiveTotal({ sport, competitorA, competitorB, total, liveScore, liveProjection, priorAnalysis }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[match-analyst] ANTHROPIC_API_KEY not set — cannot reassess live total.');
    return null;
  }

  // liveProjection's shape depends on which formula produced it — the
  // time-based one (basketball/football) has minutesElapsed/inOvertime;
  // the innings-based one (baseball) has inningsCompleted/inExtraInnings;
  // the sets-based one (tennis) has gamesCompletedSoFar/expectedRemainingSets.
  // Detect by shape rather than trusting `sport` alone, since it's the
  // caller's actual data that determines which text is honest here.
  let projectionContext;
  if (liveProjection && liveProjection.inningsCompleted !== undefined) {
    projectionContext = `Live pace formula: combined runs so far ÷ innings completed = ${liveProjection.pace} runs/inning. At that pace, projected final total = ${liveProjection.projectedFinal}${liveProjection.inExtraInnings ? ' (game is in extra innings — this projection only reflects pace through the end of regulation (9 innings), there is no fixed remaining-innings count past that)' : ` (${liveProjection.inningsRemaining} inning(s) remaining in regulation)`}.`;
  } else if (liveProjection && liveProjection.gamesCompletedSoFar !== undefined) {
    projectionContext = `Live games formula: ${liveProjection.gamesCompletedSoFar} games played so far, averaging ${liveProjection.avgGamesPerSet} games per completed set. Expected remaining sets under a NEUTRAL 50/50-per-set assumption (${liveProjection.matchFormat}): ${liveProjection.expectedRemainingSets} — this does NOT account for who's actually favored to close the match, only the mechanical odds given the current set score. Projected final total = ${liveProjection.projectedTotal} games.`;
  } else if (sport === 'soccer' && liveProjection && liveProjection.minutesElapsed !== undefined) {
    projectionContext = `Live pace formula: goals so far ÷ minutes elapsed = ${liveProjection.pace} goals/min. At that pace, projected final total = ${liveProjection.projectedFinal} (${liveProjection.minutesRemaining} minutes remaining in regulation — this does NOT predict added stoppage time, which isn't knowable in advance).`;
  } else if (liveProjection && liveProjection.minutesElapsed !== undefined) {
    projectionContext = `Live pace formula: combined score so far ÷ minutes elapsed = ${liveProjection.pace} pts/min. At that pace, projected final total = ${liveProjection.projectedFinal}${liveProjection.inOvertime ? ' (game is in overtime — this projection only reflects pace through end of regulation, there is no fixed remaining duration in OT)' : ` (${liveProjection.minutesRemaining} minutes remaining in regulation)`}.`;
  } else {
    projectionContext = 'Live pace projection: not available this cycle.';
  }

  const jsonInstruction = `
Do not narrate your process. Your final message must contain ONLY the JSON
object below and nothing else.

The "selection" field MUST be exactly one of these two strings, verbatim:
"Over ${total}" or "Under ${total}".

Respond with ONLY a raw JSON object, in this exact shape:
{
  "selection": "Over ${total}" or "Under ${total}",
  "confidence": <integer 0-100>,
  "analysis": "1-3 sentence updated read on the total given how the game is actually playing out"
}
${JSON_VALIDITY_REMINDER}
`.trim();

  const LIVE_TOTAL_GUIDANCE = {
    basketball: `The pace formula above is real math, not a guess — but real basketball
doesn't score at a perfectly constant rate. Weigh it against what you'd
actually expect given how the game is playing out: garbage-time fouling
late, a team protecting a lead by slowing pace deliberately, a shorthanded
team fading in the second half, a trailing team pushing tempo to chase a
comeback. Don't just repeat the formula's number unadjusted, and don't
ignore it either — it's real signal, layer real judgment on top of it.`,
    football: `The pace formula above is real math, but treat it with real caution —
football scoring is much lumpier than basketball's. A single possession is
worth 3-8 points instead of 2-3, and a whole quarter can go scoreless or
explode with two quick touchdowns. Pure pace math is far less reliable in
the FIRST HALF especially — weight it more heavily once you're seeing how
each offense/defense is actually performing that day (second half and
later). Layer on football-specific dynamics: two-minute-drill stretches
(end of half, end of game) spike scoring well above the game's average
pace; a team playing from well behind often abandons the run and speeds up
via more passing; a team protecting a big lead often does the opposite —
running the clock, playing conservative, slowing pace right when you might
expect it to pick up. Don't just repeat the formula's number unadjusted,
especially early in the game, and don't ignore it either once the sample
of live play is bigger.`,
    baseball: `The pace formula above is rougher than basketball's or football's — innings
aren't equal-length units of time, so runs/inning is a cruder proxy for
"pace" than points/minute is in a clock sport. The single biggest live
variable here has no basketball/football equivalent: the starter-to-bullpen
transition. If a strong starter exits and a shaky bullpen takes over (or
vice versa), the run-scoring pace can shift hard mid-game in a way pure
pace math won't see coming — check who's actually on the mound now, not
just the pregame starter. Late-inning scoring also tends to be lumpier
than mid-game — a bases-loaded walk or a bullpen implosion can swing the
total by several runs in one inning. Don't just repeat the formula's
number unadjusted, especially once a pitching change has happened.`,
    tennis: `The "expected remaining sets" figure above is a NEUTRAL 50/50-per-set
assumption — real math on the current set score and match format, but it
deliberately does NOT know who's actually favored to close the match out.
That's your job: weigh it against who's actually serving better today,
who looks fresher, and the current set score/momentum. A set that just
went to a tiebreak inflates that set's game count (7-6 = 13 games vs. a
clean 6-2 = 8) — the average-games-per-set figure above already reflects
the actual sets played, not an assumption, so trust it more than you'd
trust a similar average in a sport where set/inning length is more
uniform. Watch for live odds overreacting to a single break before the
returner has proven they can actually hold the advantage — a single
break in a long, high-hold-percentage match is weaker signal than the
market sometimes prices it as. Don't just repeat the formula's number
unadjusted, and don't ignore it either — it's real signal on the
mechanical odds, even though it doesn't know who's playing better.`,
    soccer: `The pace formula above is the shakiest of any sport's live total math —
goals are rare, lumpy events. A 0-0 game after 60 minutes doesn't mean
"no goals are coming," it just means variance hasn't broken yet. Weigh
shot volume, live xG generated, and chance quality far more heavily than
the raw goals-per-minute number — a team peppering shots and hitting the
post twice in a scoreless game is a completely different situation than a
team that hasn't threatened at all, and the pace formula can't tell those
two apart. Live-state adjustments that matter most: a team down a goal
with 15-20 minutes left tends to push numbers forward (raises live goal
probability); a team protecting a 1-0 or 2-0 lead late often sits back
and manages the clock (suppresses it); a red card is a bigger single-
event swing here than almost anything in the other sports — a team
playing a man up very often changes the rest of the match's total-goal
expectation significantly. Don't just repeat the formula's number
unadjusted — weigh the underlying game state more than the pace math.`,
  };
  const liveTotalGuidance = LIVE_TOTAL_GUIDANCE[sport] || LIVE_TOTAL_GUIDANCE.basketball;

  const prompt = `
You are re-evaluating a TOTAL (over/under) pick for a game currently IN
PROGRESS, given the live pace and how the game has actually unfolded.

Match: ${competitorA} vs ${competitorB} (${sport})
Current score: ${liveScore || 'not available'}
Total line: ${total}
${projectionContext}

Your original pre-match total analysis:
${priorAnalysis || '(not available)'}

${liveTotalGuidance}

${jsonInstruction}
`.trim();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);

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
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '(could not read response body)');
      console.error(`[match-analyst] live total reassessment API returned ${res.status} for ${competitorA} vs ${competitorB}: ${errBody}`);
      return null;
    }

    const data = await res.json();
    const textBlocks = (data.content || []).filter((b) => b.type === 'text');
    if (!textBlocks.length) return null;
    const finalText = textBlocks[textBlocks.length - 1].text;

    const withoutFences = finalText.replace(/```json|```/g, '').trim();
    const jsonMatch = withoutFences.match(/\{[\s\S]*\}/);
    const cleaned = jsonMatch ? jsonMatch[0] : withoutFences;

    let parsed = parseClaudeJson(cleaned);
    if (!parsed) {
      parsed = await repairJsonViaClaude(cleaned, `${competitorA} vs ${competitorB} (live total reassessment)`);
    }
    if (!parsed) {
      console.error(`[match-analyst] failed to parse live total JSON for ${competitorA} vs ${competitorB} even after repair attempts. Raw text: ${cleaned.slice(0, 300)}`);
      return null;
    }

    const validSelections = [`Over ${total}`, `Under ${total}`];
    if (
      !validSelections.includes(parsed.selection) ||
      typeof parsed.confidence !== 'number' ||
      typeof parsed.analysis !== 'string'
    ) {
      console.error(`[match-analyst] live total reassessment missing/invalid fields for ${competitorA} vs ${competitorB}: ${cleaned}`);
      return null;
    }

    parsed.confidence = Math.max(0, Math.min(100, Math.round(parsed.confidence)));
    return parsed;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error(`[match-analyst] live total reassessment timed out for ${competitorA} vs ${competitorB} — skipping this cycle.`);
    } else {
      console.error(`[match-analyst] live total reassessment failed for ${competitorA} vs ${competitorB}:`, err.message);
    }
    return null;
  }
}

module.exports = { analyzeMatch, reassessLiveMatch, reassessLiveTotal, parseClaudeJson, repairJsonViaClaude };
