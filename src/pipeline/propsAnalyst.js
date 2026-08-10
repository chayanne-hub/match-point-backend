/**
 * Match Point — player prop confidence analysis.
 *
 * Real design decision: ONE Claude call per PLAYER, not per individual
 * prop line. A player with props typically has several markets at once
 * (points, rebounds, assists, threes, double-double) — researching their
 * matchup/usage/injury context once and producing verdicts across all
 * their available markets in that single call is far more cost-efficient
 * than a separate call per market, and the underlying research (how is
 * this player's role trending, how has the opponent defended their
 * position) is genuinely the same research regardless of which specific
 * stat is being bet on.
 *
 * Reuses the same JSON parse/repair helpers and calibration language
 * already established in matchAnalyst.js / fantasyAnalyst.js, rather
 * than inventing a third version of either.
 */

const { parseClaudeJson, repairJsonViaClaude } = require('./matchAnalyst');

const ANTHROPIC_MODEL = process.env.MATCH_ANALYST_MODEL || 'claude-sonnet-5';

const JSON_VALIDITY_REMINDER = `
Your response must be syntactically valid JSON. Specifically: escape any
double-quote character that appears inside a string value as \\", and
never include a literal line break inside a string value — write it as
one continuous line instead. Double-check your JSON is valid before
finishing your response.`;

const CALIBRATION_GUIDANCE = `
Calibration matters more than decisiveness — same scale used everywhere
else on this platform:

- 85-100%: an overwhelming, clear-cut call. Reserve this for cases where
  multiple independent factors (matchup, usage trend, recent form) all
  point the same direction.
- 65-84%: a clear, well-supported lean. Most genuine edges land here.
- 45-64%: a genuine toss-up, or the data is too thin to say more
  confidently. An honest signal in its own right, not hedging.
- Below 45%: you are leaning against what the raw numbers suggest.
  Should be rare, and only with a specific, well-supported reason.

If your case for 85%+ rests on a single factor, bring the number back
down. A real edge is rarely that clean.

Research efficiently — aim for roughly 3-5 searches total across ALL of
this player's props combined, not per prop. If a specific data point
(e.g. exact recent shot volume) isn't turning up after a reasonable
search or two, note that as a real limitation in your reasoning and
move on rather than continuing to search for it. A timely answer that
honestly notes a limitation beats a slow one that never finishes.`;

/**
 * Real analysis for one player across all their available prop lines in
 * one match. propLines is the raw array already fetched from
 * fetchPlayerProps.js (each entry: { playerName, market, line, overOdds,
 * underOdds }) filtered down to just this one player's entries.
 *
 * Returns an array of { market, line, verdict, confidence, reasoning }
 * — one entry per prop line passed in — or null on total failure (never
 * throws). A per-prop verdict can legitimately come back with low
 * confidence; that's a real result, not a failure.
 */
async function analyzePlayerProps({ playerName, team, opponent, sport, propLines }) {
  const marketList = propLines
    .map((p) => `- ${p.market.replace('player_', '').replace(/_/g, ' ')}: line ${p.line} (Over ${p.overOdds}, Under ${p.underOdds})`)
    .join('\n');

  const systemPrompt = `
You are a sharp, research-driven sports betting analyst. Your job is a
real Over/Under verdict with a real confidence score for EACH of the
following prop lines for ${playerName} (${team}) against ${opponent} —
research this player's actual context ONCE and apply it across all the
lines below, rather than treating each as unrelated.

Prop lines to evaluate:
${marketList}

Research, using real web search:
- Usage trend: has ${playerName}'s actual role (minutes, touches, shot
  attempts, target share — whatever's relevant for ${sport}) been
  trending up or down over the last several games? This is the single
  most useful thing to check — recent trend predicts near-term output
  better than a season-long average does.
- Matchup difficulty: how has ${opponent} performed recently against
  players in ${playerName}'s role? Look for real recent data, not a
  stale reputation.
- Recent form and any relevant injury/role-change context.

${CALIBRATION_GUIDANCE}

Respond with ONLY a raw JSON object, no markdown fences, no preamble, in
this exact shape:
{
  "props": [
    {
      "market": "<the market key exactly as given above, e.g. player_points>",
      "verdict": "over" or "under",
      "confidence": <integer 0-100>,
      "reasoning": "1-2 sentence real basis for this specific verdict"
    }
  ]
}
Include exactly one entry per prop line listed above, in the same order.
${JSON_VALIDITY_REMINDER}
`.trim();

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
        max_tokens: 6000, // was 4000 — a player with several prop lines needs real room for multiple verdicts + reasoning each; too tight risked truncated, malformed JSON
        system: systemPrompt,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: `Evaluate all listed prop lines for ${playerName}.` }],
      }),
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.error(`[props-analyst] Anthropic API returned ${res.status} for ${playerName}`);
      return null;
    }

    const data = await res.json();
    const textBlocks = (data.content || []).filter((b) => b.type === 'text');
    if (!textBlocks.length) {
      console.error(`[props-analyst] no text response from Claude for ${playerName}`);
      return null;
    }
    const finalText = textBlocks[textBlocks.length - 1].text;
    const withoutFences = finalText.replace(/```json|```/g, '').trim();
    const jsonMatch = withoutFences.match(/\{[\s\S]*\}/);
    const cleaned = jsonMatch ? jsonMatch[0] : withoutFences;

    let parsed = parseClaudeJson(cleaned);
    if (!parsed) parsed = await repairJsonViaClaude(cleaned, `${playerName} props`);
    if (!parsed || !Array.isArray(parsed.props)) {
      console.error(`[props-analyst] invalid/missing props array for ${playerName}: ${cleaned.slice(0, 300)}`);
      return null;
    }

    const finalResults = parsed.props
      .filter((p) => ['over', 'under'].includes(p.verdict) && typeof p.confidence === 'number')
      .map((p) => ({
        market: p.market,
        verdict: p.verdict,
        confidence: Math.max(0, Math.min(100, Math.round(p.confidence))),
        reasoning: p.reasoning || '',
      }));
    console.log(`[props-analyst] succeeded for ${playerName} — ${finalResults.length} prop(s) evaluated.`);
    return finalResults;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error(`[props-analyst] request timed out after 150s for ${playerName}`);
    } else {
      console.error(`[props-analyst] unexpected error for ${playerName}:`, err.message);
    }
    return null;
  }
}

module.exports = { analyzePlayerProps };
