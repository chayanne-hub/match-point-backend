/**
 * FACTOR WEIGHTS — derived from graded results, not assumption.
 *
 * Every pick stores the factors the analyst actually cited. Once a factor
 * has enough graded picks behind it, how those picks PERFORMED is a far
 * better guide to what it's worth than anything reasoned from first
 * principles. This measures that and feeds it back into the prompt, so
 * the model's weighting is learned from its own record.
 *
 * SHRINKAGE — the part that stops this overfitting.
 * A factor cited on 12 picks that happens to hit 83% is not a discovery,
 * it's a small sample. Each factor's measured lift over the baseline is
 * multiplied by n / (n + K): with K = 60 a factor needs ~60 graded picks
 * to earn even half the weight its raw numbers suggest, and anything
 * thinner is pulled hard toward the baseline. Without this the weights
 * would swing week to week chasing noise — the exact failure a weighting
 * model is meant to prevent.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOESN'T.
 * It measures whether picks CITING a factor outperform the overall rate.
 * That's a correlation, not a causal weight. A factor cited on nearly
 * every pick will score near the baseline no matter how much it matters,
 * because there's nothing to contrast it against. So a low computed
 * weight means "this doesn't separate good picks from bad ones in our
 * data" — not necessarily "this is unimportant". Read it that way.
 */

const db = require('../lib/db');

// Below this, a factor keeps its seed weight — not enough evidence to
// overrule the starting assumption yet.
const MIN_SAMPLE = 25;

// Shrinkage constant. Higher = more conservative, slower to move.
const SHRINKAGE_K = 60;

// Recompute at most this often; the query scans every graded result.
const CACHE_MS = 60 * 60 * 1000;

/**
 * Starting weights, used ONLY where measured data is too thin. These are
 * assumptions and are meant to be replaced by measurement — any factor
 * reaching MIN_SAMPLE stops using its seed entirely.
 */
const SEED_WEIGHTS = {
  tennis: {
    'Injury / Physical': 20,
    'Surface Fit': 16,
    'Recent Form': 14,
    'Head to Head': 10,
    'Elo / Ranking': 10,
    'Match Load / Fatigue': 8,
    'Style Matchup': 8,
    'Venue History': 5,
    'Court Speed': 4,
    'Travel / Adaptation': 3,
    'Motivation': 1,
    'Crowd / Popularity': 1,
  },
  football: {
    'Quarterback Status': 30,
    'Unit Efficiency Matchup': 18,
    'Injury / Positional Impact': 15,
    'Rest & Travel': 10,
    'Weather': 8,
    'Offensive Line': 8,
    'Situational Motivation': 6,
    'Recent Form': 5,
  },
  baseball: {
    'Starting Pitcher Matchup': 32,
    'Bullpen Status': 16,
    'Lineup & Handedness': 14,
    'Park Factors': 10,
    'Weather / Wind': 9,
    'Injury / Roster': 9,
    'Rest & Travel': 5,
    'Recent Form': 5,
  },
  basketball: {
    'Injury / Availability': 30,
    'Rest / Back-to-Back': 18,
    'Efficiency Matchup': 17,
    'Pace & Style': 13,
    'Home Court': 9,
    'Motivation / Standings': 8,
    'Recent Form': 5,
  },
  soccer: {
    'Lineup & Rotation Risk': 26,
    'Injury / Suspension': 20,
    'Fixture Congestion': 15,
    'Home Advantage': 14,
    'Style Matchup': 11,
    'Motivation / Table Position': 8,
    'Recent Form': 6,
  },
};

/**
 * LABEL CANONICALISATION.
 *
 * The analyst writes factor labels freely, so the same concept arrives as
 * "Recent Form", "Form", "Current Form", "Recent Results". Aggregated
 * literally those are four factors, none of which reaches the sample
 * threshold — so nothing gets measured, every weight silently falls back
 * to a seed, and the whole learning loop quietly does nothing while
 * appearing to work.
 *
 * Matching is on keywords rather than exact strings, so new phrasings
 * fold into an existing bucket instead of fragmenting the data. Anything
 * unmatched is kept as-is and reported, so genuinely new factors are
 * visible rather than lost.
 */
const LABEL_PATTERNS = [
  [/injur|fitness|physical|medical|retire|withdraw/i, 'Injury / Physical'],
  [/surface|clay|grass|hard court/i, 'Surface Fit'],
  [/court speed|fast court|slow court|condition/i, 'Court Speed'],
  [/form|recent result|momentum|streak/i, 'Recent Form'],
  [/head.?to.?head|h2h|previous meeting/i, 'Head to Head'],
  [/elo|rank|seed/i, 'Elo / Ranking'],
  [/fatigue|match load|workload|schedule|rest|back.?to.?back/i, 'Match Load / Fatigue'],
  [/style|matchup|game style|playing style/i, 'Style Matchup'],
  [/venue|tournament history|event history/i, 'Venue History'],
  [/travel|jet ?lag|time ?zone|altitude/i, 'Travel / Adaptation'],
  [/motivat|incentive|priorit/i, 'Motivation'],
  [/crowd|home|popular|support|atmosphere/i, 'Crowd / Popularity'],
  [/quarterback|\bqb\b/i, 'Quarterback Status'],
  [/efficien|dvoa|unit matchup/i, 'Unit Efficiency Matchup'],
  [/weather|wind|rain|temperature/i, 'Weather'],
  [/offensive line|o.?line|pressure rate/i, 'Offensive Line'],
  [/starting pitcher|pitching matchup|\bsp\b|starter/i, 'Starting Pitcher Matchup'],
  [/bullpen|relief|closer/i, 'Bullpen Status'],
  [/lineup|handed|platoon|batting order/i, 'Lineup & Handedness'],
  [/park|ballpark|stadium dimension/i, 'Park Factors'],
  [/wind/i, 'Weather / Wind'],
  [/availability|load management|scratch|questionable/i, 'Injury / Availability'],
  [/back.?to.?back|days? rest/i, 'Rest / Back-to-Back'],
  [/pace|tempo/i, 'Pace & Style'],
  [/home court|home advantage|home field/i, 'Home Court'],
  [/rotation|squad rotation|team selection|starting xi/i, 'Lineup & Rotation Risk'],
  [/suspension|red card|booking/i, 'Injury / Suspension'],
  [/congestion|midweek|fixture pile|europa|champions league schedule/i, 'Fixture Congestion'],
  [/table position|relegation|title race|standings/i, 'Motivation / Table Position'],
];

function canonicalLabel(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const label = raw.trim();
  if (!label) return null;
  for (const [pattern, canonical] of LABEL_PATTERNS) {
    if (pattern.test(label)) return canonical;
  }
  return label; // unmatched — surfaced in detail so it can be mapped
}

/**
 * THE FIXED FACTOR LIST.
 *
 * Every match is scored on exactly these, in this order, every time. No
 * freeform labels.
 *
 * This isn't tidiness — it's what makes the weights measurable. When the
 * analyst chose its own labels, "cited" was the only thing that could be
 * counted, and a factor cited on nearly every pick carries no signal at
 * all. With a fixed list, each factor reports one of three states per
 * match, and the far stronger question becomes answerable: do picks where
 * this factor was actually FOUND and pointed somewhere outperform picks
 * where it came back empty?
 *
 * A factor the analyst couldn't research is not silently dropped; it is
 * returned as "No data", which is itself a finding worth measuring.
 */
const FACTOR_LIST = {
  tennis: [
    'Injury / Physical',
    'Surface Fit',
    'Recent Form',
    'Head to Head',
    'Elo / Ranking',
    'Match Load / Fatigue',
    'Style Matchup',
    'Venue History',
    'Court Speed',
    'Travel / Adaptation',
    'Motivation',
    'Crowd / Popularity',
  ],
  football: [
    'Quarterback Status',
    'Unit Efficiency Matchup',
    'Injury / Positional Impact',
    'Rest & Travel',
    'Weather',
    'Offensive Line',
    'Situational Motivation',
    'Recent Form',
  ],
  // Baseball is the most starting-pitcher-dependent sport there is — a
  // single player decides a large share of the outcome, which is why it
  // leads here and team form trails badly.
  baseball: [
    'Starting Pitcher Matchup',
    'Bullpen Status',
    'Lineup & Handedness',
    'Park Factors',
    'Weather / Wind',
    'Injury / Roster',
    'Rest & Travel',
    'Recent Form',
  ],
  // Basketball outcomes hinge on WHO PLAYS. Load management and late
  // scratches move lines more than any efficiency metric.
  basketball: [
    'Injury / Availability',
    'Rest / Back-to-Back',
    'Efficiency Matchup',
    'Pace & Style',
    'Home Court',
    'Motivation / Standings',
    'Recent Form',
  ],
  // Soccer's decisive factor is selection: European sides rotate heavily
  // around midweek competition, and a rotated XI is a different team.
  soccer: [
    'Lineup & Rotation Risk',
    'Injury / Suspension',
    'Fixture Congestion',
    'Home Advantage',
    'Style Matchup',
    'Motivation / Table Position',
    'Recent Form',
  ],
};

const cache = new Map(); // sport -> { at, weights, detail, ... }

async function computeWeights(sport) {
  const results = await db.result.findMany({
    where: {
      outcome: { in: ['win', 'loss'] },
      pick: {
        market: 'moneyline',
        pickType: { in: ['model', 'winner'] },
        match: { sport: { slug: sport } },
      },
    },
    include: { pick: true },
  });

  const seed = SEED_WEIGHTS[sport] || {};
  if (!results.length) return { weights: seed, detail: [], source: 'seed', graded: 0 };

  const baseline = results.filter((r) => r.outcome === 'win').length / results.length;

  const tally = {};
  for (const r of results) {
    let factors = [];
    try { factors = JSON.parse(r.pick.factsUsed || '[]'); } catch { factors = []; }
    // Only count a factor when it was actually FOUND and pointed
    // somewhere. With a fixed list every factor appears on every pick, so
    // counting mere presence would give every factor an identical sample
    // and identical win rate — measuring nothing. A factor that came back
    // "No data" or "Neutral" told us nothing about this match and must
    // not earn weight from the result.
    for (const f of (Array.isArray(factors) ? factors : [])) {
      const label = canonicalLabel(f && f.label);
      if (!label) continue;
      const tag = String(f.tag || '').toLowerCase();
      const informative = tag.startsWith('favors') || tag.startsWith('favours');
      if (!informative) continue;
      tally[label] = tally[label] || { wins: 0, n: 0 };
      tally[label].n++;
      if (r.outcome === 'win') tally[label].wins++;
    }
  }

  const detail = [];
  const raw = {};

  for (const [label, t] of Object.entries(tally)) {
    const rate = t.wins / t.n;
    const reliability = t.n / (t.n + SHRINKAGE_K);
    // Shrunk lift over baseline, floored at zero: a factor performing
    // below baseline earns no weight but never a negative one — this
    // scores usefulness, not direction.
    const shrunkLift = Math.max(0, (rate - baseline) * reliability);

    detail.push({
      label,
      n: t.n,
      winRate: Math.round(rate * 100),
      baseline: Math.round(baseline * 100),
      liftPts: Math.round((rate - baseline) * 100),
      reliability: Math.round(reliability * 100) / 100,
      usedSeed: t.n < MIN_SAMPLE,
    });

    raw[label] = t.n >= MIN_SAMPLE ? shrunkLift : null; // null = fall back to seed
  }

  for (const label of Object.keys(seed)) {
    if (!(label in raw)) raw[label] = null;
  }

  const measured = Object.entries(raw).filter(([, v]) => v !== null);
  const measuredTotal = measured.reduce((s, [, v]) => s + v, 0);

  // Nothing has cleared the sample bar — keep the seeds rather than
  // inventing weights from a handful of results.
  if (!measured.length || measuredTotal <= 0) {
    return { weights: seed, detail: detail.sort((a, b) => b.n - a.n), source: 'seed', baseline: Math.round(baseline * 100), graded: results.length };
  }

  // Data ADJUSTS the starting weights rather than replacing them outright.
  //
  // Splitting 100 in direct proportion to measured lift was tried and is
  // wrong at this data volume: with only one factor showing a clear
  // positive lift it handed that factor 78 of 100 and starved everything
  // else. Weights that concentrated are brittle — one cold streak on the
  // dominant factor and the whole model swings.
  //
  // Instead each factor gets a multiplier from its own shrunk lift, and
  // that multiplier is applied to the starting weight. A factor beating
  // the baseline grows, one lagging it shrinks, and the clamp stops any
  // single measurement from taking over. As samples grow, reliability
  // rises and the multipliers do more of the work — which is the correct
  // trajectory: assumption early, measurement later.
  const SCALE = 8;      // how hard a point of shrunk lift pushes
  const MIN_MULT = 0.3; // a bad factor can lose 70% of its weight
  const MAX_MULT = 2.5; // a good one can more than double it

  const adjusted = {};
  for (const label of Object.keys(raw)) {
    const base = seed[label] ?? 3; // a factor the model invented gets a small base
    const v = raw[label];
    if (v === null) { adjusted[label] = base; continue; } // too thin to judge
    // Signed lift here, not the zero-floored version — a factor below
    // baseline must be able to LOSE weight, which is the whole point.
    const t = tally[label];
    const signedLift = (t.wins / t.n) - baseline;
    const reliability = t.n / (t.n + SHRINKAGE_K);
    const mult = Math.min(MAX_MULT, Math.max(MIN_MULT, 1 + signedLift * reliability * SCALE));
    adjusted[label] = base * mult;
  }

  const total = Object.values(adjusted).reduce((a, b) => a + b, 0) || 1;
  const weights = {};
  for (const [label, v] of Object.entries(adjusted)) {
    weights[label] = Math.max(1, Math.round((v / total) * 100));
  }

  return {
    weights,
    detail: detail.sort((a, b) => b.n - a.n),
    source: 'measured',
    baseline: Math.round(baseline * 100),
    graded: results.length,
  };
}

async function getWeights(sport) {
  const hit = cache.get(sport);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  try {
    const computed = await computeWeights(sport);
    const entry = { at: Date.now(), ...computed };
    cache.set(sport, entry);
    return entry;
  } catch (err) {
    console.warn(`[factor-weights] compute failed for ${sport}, using seeds:`, err.message);
    return { at: Date.now(), weights: SEED_WEIGHTS[sport] || {}, detail: [], source: 'seed-fallback' };
  }
}

/** Prompt text. Async, because the weights come from the database. */
async function weightGuidanceFor(sport) {
  const { weights, source, graded } = await getWeights(sport);
  if (!weights || !Object.keys(weights).length) return '';

  const lines = Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .map(([label, w]) => `  ${String(w).padStart(2)} — ${label}`)
    .join('\n');

  const provenance = source === 'measured'
    ? `Derived from ${graded} graded picks in this sport — each factor is weighted by how picks citing it actually performed.`
    : `Starting weights — not enough graded history yet to measure these.`;

  return `
FACTOR WEIGHTING. Relative weights, not probabilities: they say how much
each factor should move your confidence away from the baseline.
${provenance}

${lines}

Rules for using them:
- A high-weight factor with a clear finding justifies a confident number.
  Several low-weight factors pointing the same way do NOT — three pieces
  of weak context are still weak context, and stacking them is the most
  common way a model talks itself into a wrong pick.
- If you found nothing on the top-weighted factors, your confidence should
  sit near the baseline no matter how much low-weight colour you gathered.
- Weight is not direction. A heavily-weighted factor pointing AGAINST the
  favourite should pull your confidence down hard.
- Use these factor labels VERBATIM in your factors array. Weights are
  learned by matching labels against graded results, so an invented label
  teaches the model nothing and gets no weight next time.
`.trim();
}

module.exports = { SEED_WEIGHTS, FACTOR_LIST, getWeights, weightGuidanceFor, canonicalLabel, MIN_SAMPLE, SHRINKAGE_K };
