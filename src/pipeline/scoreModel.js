/**
 * Match Point — model scoring engine.
 *
 * This is the computable version of the checklist described on the site:
 * several weighted factors are each scored from -1 (favors competitor B) to
 * +1 (favors competitor A), combined into a single confidence rating, and
 * turned into a pick + rationale.
 *
 * IMPORTANT: the actual weights and factor definitions here are a reasonable
 * starting structure, not a validated betting model. Before this runs for
 * real money, the weights and factor logic below should be backtested against
 * historical results and tuned — this file is the scaffolding to do that in,
 * not a finished, proven strategy.
 *
 * Each sport-specific factor function takes normalized stats (0-1 scale,
 * already computed from whatever the data provider returns) and outputs a
 * signed score. Wire your data provider's actual fields into these functions
 * in fetchMatches.js before calling scoreMatch().
 */

// Weights per sport. Sum of weights does not need to equal 1 — the raw score
// is normalized into a 0-100 confidence rating at the end.
const WEIGHTS = {
  tennis: { eloRank: 0.35, surfaceFit: 0.25, formTravel: 0.2, motivation: 0.2 },
  basketball: { efficiency: 0.35, rest: 0.25, injuries: 0.25, homeRoad: 0.15 },
  soccer: { handicapLine: 0.3, rotationRisk: 0.25, homeAwayForm: 0.25, leagueTier: 0.2 },
  baseball: { startingPitcher: 0.35, bullpenFatigue: 0.25, parkFactors: 0.2, lineMovement: 0.2 },
  football: { efficiency: 0.35, injuryReport: 0.25, restTravel: 0.2, weather: 0.2 },
};

/**
 * factors: an object whose keys match WEIGHTS[sport] and whose values are
 * signed scores from -1 (favors B) to +1 (favors A) for that factor.
 * e.g. for tennis: { eloRank: 0.6, surfaceFit: 0.3, formTravel: -0.1, motivation: 0 }
 *
 * Returns { confidence, favors, marginScore }.
 * - confidence: 0-100, how strongly the combined signal leans either direction
 * - favors: "A" | "B" | "even"
 * - marginScore: the raw weighted sum before conversion to confidence, useful for debugging
 */
function scoreMatch(sport, factors) {
  const weights = WEIGHTS[sport];
  if (!weights) throw new Error(`Unknown sport: ${sport}`);

  let weightedSum = 0;
  let weightTotal = 0;

  for (const key of Object.keys(weights)) {
    const factorScore = factors[key];
    if (typeof factorScore !== 'number') continue; // missing data for this factor — skip it
    weightedSum += factorScore * weights[key];
    weightTotal += weights[key];
  }

  if (weightTotal === 0) {
    // No usable data at all — return a neutral, low-confidence result rather
    // than a fabricated number.
    return { confidence: 50, favors: 'even', marginScore: 0 };
  }

  // Normalize to account for any missing factors, then convert the -1..+1
  // signal into a 0-100 confidence scale. abs() because confidence measures
  // strength of the lean, not direction.
  const normalized = weightedSum / weightTotal; // -1..+1
  const confidence = Math.round(50 + Math.abs(normalized) * 50); // 50..100

  const favors = normalized > 0.03 ? 'A' : normalized < -0.03 ? 'B' : 'even';

  return { confidence, favors, marginScore: normalized };
}

/**
 * Turns a scoreMatch() result into the two pick types the site sells:
 * - "model" pick: only produced when there's a real edge (confidence above threshold)
 * - "winner" pick: always produced, a straight call on every match regardless of edge
 */
function buildPicks({ sport, competitorA, competitorB, oddsA, oddsB, factors, rationale }) {
  const { confidence, favors, marginScore } = scoreMatch(sport, factors);
  const winner = favors === 'B' ? competitorB : competitorA; // "even" defaults to A as a tiebreak
  const winnerOdds = favors === 'B' ? oddsB : oddsA;

  const picks = [];

  // Winner pick: always generated.
  picks.push({
    pickType: 'winner',
    selection: `${winner} ML`,
    confidence,
    odds: winnerOdds,
    rationale,
  });

  // Model pick: only when the edge clears a real threshold, so this list
  // isn't just a duplicate of the winner picks. Threshold is intentionally
  // conservative — tune based on backtested results, not gut feel.
  const EDGE_THRESHOLD = 65;
  if (confidence >= EDGE_THRESHOLD && favors !== 'even') {
    picks.push({
      pickType: 'model',
      selection: `${winner} ML`,
      confidence,
      odds: winnerOdds,
      rationale,
    });
  }

  return picks;
}

module.exports = { scoreMatch, buildPicks, WEIGHTS };
