/**
 * Match Point — fantasy start/sit analysis.
 *
 * Deliberately its own file, not folded into matchAnalyst.js — this
 * answers a genuinely different question (should you START this player
 * in fantasy this week) than match analysis does (who wins this game).
 * Reuses the same calibration discipline and JSON parse/repair helpers
 * from matchAnalyst.js rather than re-inventing either.
 *
 * Real inputs vs. real research, kept honestly separate:
 * - Game script (spread/total) and injury status are passed IN as
 *   already-known real data — this project already fetches both, no
 *   reason to have Claude re-research something already on file.
 * - Matchup difficulty, usage trend, and depth chart changes are
 *   genuinely researched fresh via web search — nothing in this
 *   codebase currently tracks positional defense rankings or snap/
 *   target share trends, so these have to be real research, not a
 *   lookup.
 */

const { parseClaudeJson, repairJsonViaClaude } = require('./matchAnalyst');

const ANTHROPIC_MODEL = process.env.MATCH_ANALYST_MODEL || 'claude-sonnet-5';

const JSON_VALIDITY_REMINDER = `
Your response must be syntactically valid JSON. Specifically: escape any
double-quote character that appears inside a string value as \\", escape
any apostrophe-containing contraction normally (apostrophes don't need
escaping, but a stray unescaped double-quote does), and never include a
literal line break inside a string value — write it as one continuous
line instead. Double-check your JSON is valid before finishing your
response.`;

const CALIBRATION_GUIDANCE = `
Calibration matters more than decisiveness — this is the same scale used
for match picks on this platform. Use it as the real anchor for what
each confidence range means, not just a rough feel:

- 85-100%: an overwhelming, clear-cut call. Reserve this for cases where
  multiple independent factors (matchup, usage, health, game script) all
  point the same direction — not one strong signal doing all the work.
- 65-84%: a clear, well-supported lean. This is where most real edges
  land.
- 45-64%: a genuine coin-flip start/sit decision, or the data is too
  thin to say more confidently. Most matchups with mixed signals belong
  here — this is an honest, useful signal in its own right, not hedging.
- Below 45%: you are recommending against what the surface-level
  numbers suggest. Should be rare, and only with a specific, well-
  supported reason.

If your case for 85%+ rests on a single factor, or you notice yourself
rounding up to sound more decisive than the evidence supports, bring the
number back down.`;

/**
 * Real start/sit analysis for one player's upcoming matchup. spread,
 * total, and injuryStatus are optional — pass them when known (spread/
 * total from the Match record if this player's team has one tracked;
 * injuryStatus from the existing ESPN injury fetcher), null otherwise.
 * Returns { verdict, confidence, analysis, factors } or null on failure
 * (never throws) — same contract as analyzeMatch().
 */
async function analyzeStartSit({ playerName, team, opponent, sport, spread, total, injuryStatus }) {
  const gameScriptContext = (spread != null || total != null)
    ? `Known betting market context for this game: ${spread != null ? `spread is ${spread} (team favored/underdog accordingly)` : ''}${spread != null && total != null ? ', ' : ''}${total != null ? `total is ${total} (implies expected combined scoring pace)` : ''}. Use this as real signal for likely game script — a lopsided spread changes how a team is likely to play (trailing teams lean more toward passing/higher-usage looks in most sports; leading teams often shift to a more conservative, lower-variance approach), and a high total generally means more overall production to go around.`
    : 'No betting market context available for this game — do not assume a specific game script; rely on matchup and usage research instead.';

  const injuryContext = injuryStatus
    ? `Known injury status for ${playerName}: ${injuryStatus}. Factor this in directly — a real, current designation from the injury report, not something to re-research.`
    : `No injury designation on file for ${playerName} — assume healthy unless your research turns up something specific, and say so if you find something.`;

  const systemPrompt = `
You are a sharp, research-driven fantasy sports analyst. Your job is a
single START or SIT recommendation for one player's upcoming game,
based on real research — not name recognition, not last week's box
score alone, and not just picking the more famous player.

Research, using real web search:
- Matchup difficulty: how has ${opponent} performed recently against
  players in ${playerName}'s role/position? Look for actual recent
  data (last several games), not a season-long reputation that might
  be stale.
- Usage trend: has ${playerName}'s actual usage (snaps, targets,
  touches, minutes — whatever's relevant for ${sport}) been trending up
  or down over the last several games? Usage trend predicts future
  output better than one big or bad game did.
- Depth chart / role changes: any recent change (injury to a teammate
  opening up opportunity, a new starter, a role change) that would
  meaningfully shift this player's expected involvement?

${gameScriptContext}
${injuryContext}
${CALIBRATION_GUIDANCE}

The "factors" field lists the specific things you actually checked that
meaningfully informed your verdict — do not include a factor you didn't
really look into. Each entry needs:
  - "label": a short category name (e.g. "Matchup Difficulty", "Usage
    Trend", "Injury Status", "Game Script", "Depth Chart")
  - "tag": exactly "Favors Start", "Favors Sit", or "Neutral"
  - "body": one sentence stating the specific finding

Respond with ONLY a raw JSON object, no markdown fences, no preamble, in
this exact shape:
{
  "verdict": "start" or "sit",
  "confidence": <integer 0-100>,
  "analysis": "2-4 sentence writeup citing the specific findings that drove this call",
  "factors": [ { "label": "...", "tag": "...", "body": "..." }, ... ]
}
${JSON_VALIDITY_REMINDER}
`.trim();

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
        max_tokens: 3500, // smaller than match analysis (5000) — fewer distinct research threads for one player than a full team matchup
        system: systemPrompt,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: `Start or sit ${playerName} (${team}) against ${opponent} this week?` }],
      }),
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '(could not read response body)');
      console.error(`[fantasy-analyst] Anthropic API returned ${res.status} for ${playerName}: ${errBody}`);
      return null;
    }

    const data = await res.json();
    const textBlocks = (data.content || []).filter((b) => b.type === 'text');
    if (!textBlocks.length) {
      console.error(`[fantasy-analyst] no text response from Claude for ${playerName}`);
      return null;
    }
    const finalText = textBlocks[textBlocks.length - 1].text;

    const withoutFences = finalText.replace(/```json|```/g, '').trim();
    const jsonMatch = withoutFences.match(/\{[\s\S]*\}/);
    const cleaned = jsonMatch ? jsonMatch[0] : withoutFences;

    let parsed = parseClaudeJson(cleaned);
    if (!parsed) {
      parsed = await repairJsonViaClaude(cleaned, `${playerName} start/sit`);
    }
    if (!parsed) {
      console.error(`[fantasy-analyst] failed to parse Claude's JSON for ${playerName} even after repair. Raw text: ${cleaned.slice(0, 300)}`);
      return null;
    }

    if (
      !['start', 'sit'].includes(parsed.verdict) ||
      typeof parsed.confidence !== 'number' ||
      typeof parsed.analysis !== 'string' ||
      !Array.isArray(parsed.factors)
    ) {
      console.error(`[fantasy-analyst] Claude's response missing/invalid required fields for ${playerName}: ${cleaned}`);
      return null;
    }

    return {
      verdict: parsed.verdict,
      confidence: Math.max(0, Math.min(100, Math.round(parsed.confidence))),
      analysis: parsed.analysis,
      factors: parsed.factors,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error(`[fantasy-analyst] request timed out after 90s for ${playerName} — skipping.`);
    } else {
      console.error(`[fantasy-analyst] unexpected error for ${playerName}:`, err.message);
    }
    return null;
  }
}

module.exports = { analyzeStartSit };
