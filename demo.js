const { scoreMatch, buildPicks } = require('./src/pipeline/scoreModel');

function line() { console.log('-'.repeat(70)); }

console.log('MATCH POINT — MODEL SCORING ENGINE DEMO');
console.log('(Running the real src/pipeline/scoreModel.js, no mocks)\n');

// Scenario 1: the Alvarez/Kowalski example from the site copy —
// hard-court Elo edge + surface mismatch + short turnaround, all favoring A
line();
console.log('SCENARIO 1: Tennis — clear edge on multiple factors');
line();
const s1 = buildPicks({
  sport: 'tennis',
  competitorA: 'Alvarez',
  competitorB: 'Kowalski',
  oddsA: -142,
  oddsB: 120,
  factors: {
    eloRank: 0.55,       // Alvarez rated higher on hard courts
    surfaceFit: 0.7,     // Alvarez hard-court specialist, Kowalski clay-leaning
    formTravel: 0.4,     // Kowalski short turnaround off a clay swing
    motivation: 0,       // both treating it at full weight — neutral
  },
  rationale: 'Hard-court Elo edge plus a surface and turnaround mismatch.',
});
console.log(JSON.stringify(s1, null, 2));

// Scenario 2: a close, low-confidence match — small lean, no real edge
line();
console.log('SCENARIO 2: Basketball — no clear edge, should stay near a coinflip');
line();
const s2 = buildPicks({
  sport: 'basketball',
  competitorA: 'Ridgeline',
  competitorB: 'Portside',
  oddsA: -110,
  oddsB: -110,
  factors: {
    efficiency: 0.05,
    rest: -0.03,
    injuries: 0,
    homeRoad: 0.02,
  },
  rationale: 'Even matchup on every factor — no real signal either direction.',
});
console.log(JSON.stringify(s2, null, 2));
console.log(`\n-> Note: only ${s2.length} pick(s) generated (winner pick only —`);
console.log('   confidence is below the 65 edge threshold, so no model pick fires).');

// Scenario 3: strongly favors the underdog (competitor B) — checks the
// "favors B" branch and that odds attach to the correct side
line();
console.log('SCENARIO 3: Soccer — model likes the away side despite the market');
line();
const s3 = buildPicks({
  sport: 'soccer',
  competitorA: 'Harborview',
  competitorB: 'Dalton FC',
  oddsA: -135,
  oddsB: 320,
  factors: {
    handicapLine: -0.5,      // line overvalues Harborview
    rotationRisk: -0.3,      // Harborview rotating squad, midweek fixture
    homeAwayForm: -0.2,      // Dalton strong on the road this season
    leagueTier: 0,
  },
  rationale: 'Handicap line overvalues the favorite given rotation and away form.',
});
console.log(JSON.stringify(s3, null, 2));

// Scenario 4: missing data for some factors — confirms partial data still
// produces a sane result instead of crashing
line();
console.log('SCENARIO 4: Baseball — partial data (2 of 4 factors missing)');
line();
const s4 = scoreMatch('baseball', {
  startingPitcher: 0.6,
  bullpenFatigue: 0.4,
  // parkFactors and lineMovement intentionally omitted
});
console.log(JSON.stringify(s4, null, 2));

line();
console.log('All 4 scenarios ran against the real scoring function in scoreModel.js.');
