/**
 * Match Point — AI-generated pick rationale.
 *
 * Turns the factors buildFactors() computed into a short, natural-language
 * explanation, instead of the generic template sentence. Two-step process:
 *   1. describeFactors() — deterministically turns each factor's numeric
 *      value into a plain-English fact. This is the important safety
 *      layer: Claude only ever sees facts we've already verified are true
 *      (real odds, real injury counts, real rest-day differences), never
 *      raw numbers it has to interpret or could misread.
 *   2. generateAiRationale() — asks Claude to write 1-2 sentences using
 *      ONLY those facts. The prompt explicitly forbids inventing any
 *      statistic, name, or detail not provided.
 *
 * Generated ONCE per pick, at creation time — not regenerated on every
 * live refresh, to keep API cost bounded. See cron.js call sites.
 *
 * Falls back to the existing template rationale (buildRationale in
 * cron.js) if ANTHROPIC_API_KEY isn't set or the API call fails for any
 * reason — a pick should never end up with no rationale at all.
 */

const fetch = require('node-fetch');

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'; // cheap/fast — this is short templated writing, not deep reasoning

/**
 * Converts the factors object into an array of plain-English facts,
 * given which competitor is which and which sport-specific WEIGHTS key
 * maps to which computation (passed in by cron.js, which already tracks
 * this precisely — see REST_DAYS_KEY / HOME_AWAY_FORM_KEY there).
 *
 * IMPORTANT: descriptions are built from WHICH FUNCTION computed the
 * value, never from the WEIGHTS key name itself — some of those key
 * names (e.g. tennis's "eloRank") are historical/internal labels that
 * don't accurately describe what's actually being measured (market-
 * implied odds, not real Elo data). Mislabeling here would make Claude
 * write something factually wrong even while "only using given facts."
 */
/**
 * Converts the factors object into an array of {label, tag, body} rows —
 * one per factor that actually contributed — given which competitor is
 * which and which sport-specific WEIGHTS key maps to which computation
 * (passed in by cron.js, which already tracks this precisely — see
 * REST_DAYS_KEY / HOME_AWAY_FORM_KEY there).
 *
 * "label" is a plain, honest name for the SOURCE of the signal — e.g.
 * "Betting Market" rather than a sport-specific WEIGHTS key name like
 * tennis's internal "eloRank", which is a historical label that doesn't
 * accurately describe what's actually being measured (market-implied
 * odds, not real Elo data). Mislabeling here would make the detail page
 * display something factually wrong even while showing real numbers.
 *
 * "tag" is "Favors <competitor>" or "Neutral", derived from the factor's
 * sign — matches the visual pattern of a labeled factor breakdown, but
 * every row here is grounded in something actually computed, never
 * fabricated to fill out a fixed set of categories.
 */
function describeFactors(sport, factors, competitorA, competitorB, marketKey, restKey, formKey) {
  const rows = [];

  if (marketKey && factors[marketKey] !== undefined) {
    const val = factors[marketKey];
    const tag = Math.abs(val) < 0.05 ? 'Neutral' : `Favors ${val > 0 ? competitorA : competitorB}`;
    const strength = Math.abs(val) > 0.5 ? 'strongly' : 'slightly';
    rows.push({
      label: 'Betting Market',
      tag,
      body: tag === 'Neutral'
        ? 'Current betting odds imply a roughly even matchup.'
        : `Current betting odds ${strength} favor ${val > 0 ? competitorA : competitorB}.`,
    });
  }

  if (factors.injuries !== undefined) {
    const val = factors.injuries;
    const tag = Math.abs(val) < 0.05 ? 'Neutral' : `Favors ${val > 0 ? competitorA : competitorB}`;
    rows.push({
      label: 'Injuries',
      tag,
      body: tag === 'Neutral'
        ? "Both sides' injury reports are comparable — no material edge here."
        : `ESPN's injury report lists more players out for ${val > 0 ? competitorB : competitorA} than for ${val > 0 ? competitorA : competitorB}.`,
    });
  }

  if (restKey && factors[restKey] !== undefined) {
    const val = factors[restKey];
    const tag = Math.abs(val) < 0.1 ? 'Neutral' : `Favors ${val > 0 ? competitorA : competitorB}`;
    rows.push({
      label: 'Rest Days',
      tag,
      body: tag === 'Neutral'
        ? 'Both teams are on comparable rest since their last match.'
        : `${val > 0 ? competitorA : competitorB} has had more days of rest since their last match.`,
    });
  }

  if (formKey && factors[formKey] !== undefined) {
    const val = factors[formKey];
    const tag = Math.abs(val) < 0.1 ? 'Neutral' : `Favors ${val > 0 ? competitorA : competitorB}`;
    rows.push({
      label: 'Home/Away Form',
      tag,
      body: tag === 'Neutral'
        ? "Recent home and away form is comparable between the two sides."
        : val > 0
          ? `${competitorA}'s recent home record has been stronger than ${competitorB}'s recent away record.`
          : `${competitorB}'s recent away record has been stronger than ${competitorA}'s recent home record.`,
    });
  }

  return rows;
}

/**
 * Asks Claude to write a short rationale from the given fact rows only.
 * Neutral rows are excluded from the prompt — they don't add reasoning
 * value to written analysis, even though they still display on the
 * detail page for transparency. Returns null (never throws) on any
 * failure — callers should fall back to the template rationale.
 */
async function generateAiRationale({ sport, competitorA, competitorB, selection, factRows }) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const usableFacts = factRows.filter((r) => r.tag !== 'Neutral').map((r) => r.body);
  if (usableFacts.length === 0) return null; // nothing grounded to write from

  const prompt = `You write short, factual betting-analysis notes for a sports picks website called Match Point.

Match: ${competitorA} vs ${competitorB} (${sport})
Model's pick: ${selection}

Known facts behind this pick (these are the ONLY facts you may reference — do not add any statistic, injury, name, or detail not listed here):
${usableFacts.map((f) => `- ${f}`).join('\n')}

Write exactly one or two sentences explaining the edge, using only the facts above. Plain, direct tone — no hype, no exclamation points, no mention of a confidence percentage. Do not restate the pick itself, just the reasoning behind it.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      console.error(`[ai-rationale] Anthropic API returned ${res.status}`);
      return null;
    }
    const data = await res.json();
    const text = data.content?.[0]?.text?.trim();
    return text || null;
  } catch (err) {
    console.error('[ai-rationale] generation failed:', err.message);
    return null;
  }
}

module.exports = { describeFactors, generateAiRationale };
