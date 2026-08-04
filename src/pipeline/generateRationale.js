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
function describeFactors(sport, factors, competitorA, competitorB, marketKey, restKey, formKey) {
  const facts = [];

  if (marketKey && factors[marketKey] !== undefined) {
    const val = factors[marketKey];
    const favored = val > 0 ? competitorA : competitorB;
    const strength = Math.abs(val) > 0.5 ? 'strongly' : 'slightly';
    facts.push(`Current betting odds ${strength} favor ${favored}.`);
  }

  if (factors.injuries !== undefined) {
    const val = factors.injuries;
    if (Math.abs(val) > 0.05) {
      const healthier = val > 0 ? competitorA : competitorB;
      const bangedUp = val > 0 ? competitorB : competitorA;
      facts.push(`ESPN's injury report lists more players out for ${bangedUp} than for ${healthier}.`);
    }
  }

  if (restKey && factors[restKey] !== undefined) {
    const val = factors[restKey];
    if (Math.abs(val) > 0.1) {
      const restedTeam = val > 0 ? competitorA : competitorB;
      facts.push(`${restedTeam} has had more days of rest since their last match.`);
    }
  }

  if (formKey && factors[formKey] !== undefined) {
    const val = factors[formKey];
    if (Math.abs(val) > 0.1) {
      const strongerSide = val > 0 ? `${competitorA}'s home` : `${competitorB}'s away`;
      facts.push(`${strongerSide} record has been stronger recently than the other side's corresponding record.`);
    }
  }

  return facts;
}

/**
 * Asks Claude to write a short rationale from the given facts only.
 * Returns null (never throws) on any failure — callers should fall back
 * to the template rationale.
 */
async function generateAiRationale({ sport, competitorA, competitorB, selection, facts }) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (facts.length === 0) return null; // nothing grounded to write from

  const prompt = `You write short, factual betting-analysis notes for a sports picks website called Match Point.

Match: ${competitorA} vs ${competitorB} (${sport})
Model's pick: ${selection}

Known facts behind this pick (these are the ONLY facts you may reference — do not add any statistic, injury, name, or detail not listed here):
${facts.map((f) => `- ${f}`).join('\n')}

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
