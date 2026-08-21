/**
 * backtest.js — where does the model actually make money?
 *
 * WHY THIS EXISTS. The record is around 71% and the equity curve is
 * negative. That combination has exactly one explanation: the model is
 * right about who wins and wrong about whether the price is worth taking.
 * A win rate cannot show you that. ROI segmented by price can.
 *
 * This replays every GRADED pick at the price actually recorded on it and
 * reports profit by segment, so the question stops being "is the model
 * good" and becomes "which picks are worth publishing".
 *
 * Reads only. Writes nothing, changes nothing.
 *
 *   node backtest.js                      # all graded picks
 *   node backtest.js --sport tennis       # one sport
 *   node backtest.js --days 30            # recent window
 *   node backtest.js --market moneyline   # default; 'all' for every market
 *   node backtest.js --stake 100          # flat stake, default 100
 */

const db = require('./src/lib/db.js');

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const SPORT  = arg('sport');
const DAYS   = Number(arg('days', 0)) || 0;
const MARKET = arg('market', 'moneyline');
const STAKE  = Number(arg('stake', 100)) || 100;

/* ------------------------------------------------------------------ *
 * MONEY
 *
 * Flat stake, not percentage — a flat-stake curve is the honest test of
 * whether the selections themselves have an edge. Staking schemes can
 * make a losing set of picks look profitable for a while, which is
 * exactly the self-deception this script exists to prevent.
 * ------------------------------------------------------------------ */
function profitOn(odds, outcome, stake = STAKE) {
  if (outcome === 'push') return 0;
  if (outcome === 'loss') return -stake;
  if (outcome !== 'win') return null;
  const o = Number(odds);
  if (!Number.isFinite(o) || o === 0) return null;
  return o > 0 ? stake * (o / 100) : stake * (100 / Math.abs(o));
}

/** American odds -> implied probability, with the vig still in it. */
function impliedProb(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o === 0) return null;
  return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
}

/* ------------------------------------------------------------------ *
 * SEGMENTS
 *
 * Price band is first because it is the suspected cause. If the model is
 * right on short favourites and those favourites do not pay enough to
 * cover the misses, this table shows it immediately.
 * ------------------------------------------------------------------ */
function priceBand(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o)) return 'unknown';
  if (o <= -300) return '1. heavy fav  (-300 or shorter)';
  if (o <= -200) return '2. big fav    (-299 to -200)';
  if (o <= -150) return '3. solid fav  (-199 to -150)';
  if (o <= -110) return '4. mild fav   (-149 to -110)';
  if (o < 110)   return '5. pick-em    (-109 to +109)';
  if (o < 200)   return '6. small dog  (+110 to +199)';
  if (o < 300)   return '7. dog        (+200 to +299)';
  return '8. big dog    (+300 or longer)';
}

const band = (v, edges, labels) => {
  if (!Number.isFinite(Number(v))) return 'unknown';
  const n = Number(v);
  for (let i = 0; i < edges.length; i++) if (n < edges[i]) return labels[i];
  return labels[labels.length - 1];
};

const confBand = (c) => band(c, [55, 60, 65, 70, 75, 80],
  ['<55%', '55-59%', '60-64%', '65-69%', '70-74%', '75-79%', '80%+']);

const clvBand = (c) => (c === null || c === undefined ? 'no CLV recorded'
  : band(c, [-2, 0, 2], ['CLV < -2 (beaten)', 'CLV -2 to 0', 'CLV 0 to +2', 'CLV > +2 (beat close)']));

/* ------------------------------------------------------------------ *
 * REPORT
 * ------------------------------------------------------------------ */
function summarise(rows) {
  let n = 0, wins = 0, losses = 0, pushes = 0, staked = 0, profit = 0;
  for (const r of rows) {
    const p = profitOn(r.odds, r.outcome);
    if (p === null) continue;
    n++;
    if (r.outcome === 'win') wins++;
    else if (r.outcome === 'loss') losses++;
    else pushes++;
    if (r.outcome !== 'push') staked += STAKE;
    profit += p;
  }
  const decided = wins + losses;
  return {
    n, wins, losses, pushes, staked, profit,
    winRate: decided ? (wins / decided) * 100 : null,
    roi: staked ? (profit / staked) * 100 : null,
  };
}

function table(title, groups, { minN = 1 } = {}) {
  const keys = [...groups.keys()].sort();
  console.log(`\n${title}`);
  console.log('-'.repeat(84));
  console.log('  segment'.padEnd(34) + 'n'.padStart(6) + 'win%'.padStart(9) +
              'profit'.padStart(13) + 'ROI'.padStart(10) + '   verdict');
  console.log('-'.repeat(84));

  for (const k of keys) {
    const s = summarise(groups.get(k));
    if (s.n < minN) continue;
    // A segment with a handful of picks tells you nothing. Say so rather
    // than letting a 3-pick 100% ROI look like a strategy.
    const thin = s.n < 25;
    const verdict = thin ? 'thin sample'
      : s.roi > 3 ? 'PROFITABLE'
      : s.roi > -1 ? 'break-even'
      : 'LOSING';
    const profitStr = (s.profit >= 0 ? '+' : '-') + '$' + Math.abs(s.profit).toFixed(0);
    const roiStr = s.roi === null ? '—' : (s.roi >= 0 ? '+' : '') + s.roi.toFixed(1) + '%';
    console.log('  ' + String(k).padEnd(32) +
      String(s.n).padStart(6) +
      (s.winRate === null ? '—' : s.winRate.toFixed(1)).padStart(9) +
      profitStr.padStart(13) +
      roiStr.padStart(10) +
      '   ' + verdict);
  }
}

function groupBy(rows, fn) {
  const m = new Map();
  for (const r of rows) {
    const k = fn(r);
    if (k === null || k === undefined) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/* ------------------------------------------------------------------ */
(async () => {
  const where = {
    result: { isNot: null },
    ...(MARKET !== 'all' ? { market: MARKET } : {}),
    ...(DAYS ? { createdAt: { gte: new Date(Date.now() - DAYS * 864e5) } } : {}),
  };

  const picks = await db.pick.findMany({
    where,
    include: { result: true, match: { include: { sport: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const rows = picks
    .filter((p) => !SPORT || p.match?.sport?.slug === SPORT)
    .map((p) => ({
      odds: p.odds,
      outcome: p.result.outcome,
      confidence: p.confidence,
      rawConfidence: p.rawConfidence,
      marketProb: p.marketProb,
      conviction: p.conviction || 'guess',
      clvPercent: p.clvPercent,
      market: p.market,
      isLive: p.isLive,
      sport: p.match?.sport?.slug || 'unknown',
      tourLevel: p.match?.tourLevel,
      league: p.match?.league,
      createdAt: p.createdAt,
    }));

  if (!rows.length) {
    console.log('No graded picks match those filters.');
    await db.$disconnect();
    return;
  }

  const all = summarise(rows);
  const filters = [SPORT && `sport=${SPORT}`, `market=${MARKET}`, DAYS && `last ${DAYS}d`]
    .filter(Boolean).join(', ');

  console.log('='.repeat(84));
  console.log(`BACKTEST — ${rows.length} graded picks (${filters})   flat $${STAKE}`);
  console.log('='.repeat(84));
  console.log(`  record        ${all.wins}-${all.losses}${all.pushes ? `-${all.pushes}` : ''}  (${all.winRate?.toFixed(1)}%)`);
  console.log(`  staked        $${all.staked.toFixed(0)}`);
  console.log(`  profit        ${all.profit >= 0 ? '+' : ''}$${all.profit.toFixed(0)}`);
  console.log(`  ROI           ${all.roi >= 0 ? '+' : ''}${all.roi?.toFixed(2)}%`);

  /* THE BREAK-EVEN COMPARISON.
   *
   * This is the number the win rate hides. At the average price taken,
   * a certain win rate is required merely to break even. Beating that is
   * the whole game; a 71% record on prices that demand 74% is a losing
   * business that looks like a winning one. */
  const probs = rows.map((r) => impliedProb(r.odds)).filter((p) => p !== null);
  if (probs.length) {
    const avgImplied = probs.reduce((a, b) => a + b, 0) / probs.length * 100;
    console.log(`\n  avg price taken implies       ${avgImplied.toFixed(1)}% (break-even win rate)`);
    console.log(`  actual win rate               ${all.winRate?.toFixed(1)}%`);
    const gap = (all.winRate || 0) - avgImplied;
    console.log(`  gap                           ${gap >= 0 ? '+' : ''}${gap.toFixed(1)} points  ` +
      (gap >= 0 ? '<- winning against the price' : '<- LOSING against the price'));
  }

  table('BY PRICE BAND  (the one that matters most)', groupBy(rows, (r) => priceBand(r.odds)));
  table('BY CONFIDENCE', groupBy(rows, (r) => confBand(r.confidence)));
  table('BY CONVICTION', groupBy(rows, (r) => r.conviction));
  table('BY SPORT', groupBy(rows, (r) => r.sport));

  const withTier = rows.filter((r) => r.tourLevel !== null && r.tourLevel !== undefined);
  if (withTier.length) {
    table('BY TOUR LEVEL (tennis)', groupBy(withTier, (r) =>
      ({ 0: 'ITF', 1: 'Challenger', 2: 'tour', 3: 'main tour' })[r.tourLevel] ?? `level ${r.tourLevel}`));
  }

  if (MARKET === 'all') table('BY MARKET', groupBy(rows, (r) => r.market));

  const withClv = rows.filter((r) => r.clvPercent !== null && r.clvPercent !== undefined);
  if (withClv.length >= 25) {
    table('BY CLV  (did the market move toward the pick?)', groupBy(withClv, (r) => clvBand(r.clvPercent)));
  } else {
    console.log(`\nBY CLV — only ${withClv.length} picks carry clvPercent, too few to read.`);
  }

  /* DID BLENDING WITH THE MARKET HELP?
   *
   * rawConfidence is the model's own probability before the market was
   * blended in. If the raw number separates winners from losers better
   * than the blended one does, the blend is destroying signal — and that
   * is a far cheaper fix than any new factor. */
  const withRaw = rows.filter((r) => Number.isFinite(r.rawConfidence) && Number.isFinite(r.marketProb));
  if (withRaw.length >= 25) {
    console.log('\nMODEL vs MARKET  (is blending helping?)');
    console.log('-'.repeat(84));
    const agree = withRaw.filter((r) => Math.abs(r.rawConfidence - r.marketProb) <= 5);
    const modelHigher = withRaw.filter((r) => r.rawConfidence - r.marketProb > 5);
    const modelLower = withRaw.filter((r) => r.marketProb - r.rawConfidence > 5);
    for (const [label, set] of [
      ['model agrees with market (±5)', agree],
      ['model MORE confident (+5)', modelHigher],
      ['model LESS confident (-5)', modelLower],
    ]) {
      const s = summarise(set);
      if (!s.n) continue;
      const profitStr = (s.profit >= 0 ? '+' : '-') + '$' + Math.abs(s.profit).toFixed(0);
      const roiStr = (s.roi >= 0 ? '+' : '') + (s.roi?.toFixed(1) ?? '—') + '%';
      console.log('  ' + label.padEnd(32) + String(s.n).padStart(6) +
        (s.winRate?.toFixed(1) ?? '—').padStart(9) +
        profitStr.padStart(13) + roiStr.padStart(10));
    }
    console.log('\n  If "model MORE confident" is the profitable row, the edge is in');
    console.log('  disagreeing with the market — and the blend is diluting it.');
  } else {
    console.log(`\nMODEL vs MARKET — only ${withRaw.length} picks carry both rawConfidence and marketProb.`);
  }

  /* WHAT WOULD FILTERING HAVE DONE?
   *
   * The actionable output. If publishing every pick loses money but some
   * filtered subset does not, that subset is the product. */
  console.log('\n' + '='.repeat(84));
  console.log('IF YOU HAD ONLY PUBLISHED...');
  console.log('='.repeat(84));
  const scenarios = [
    ['everything (today)',            () => true],
    ['nothing shorter than -200',     (r) => Number(r.odds) > -200],
    ['nothing shorter than -150',     (r) => Number(r.odds) > -150],
    ['underdogs only (+100 or more)', (r) => Number(r.odds) >= 100],
    ['conviction = strong only',      (r) => r.conviction === 'strong'],
    ['confidence 65%+',               (r) => r.confidence >= 65],
    ['confidence 65%+ AND > -200',    (r) => r.confidence >= 65 && Number(r.odds) > -200],
    ['strong AND > -150',             (r) => r.conviction === 'strong' && Number(r.odds) > -150],
  ];
  for (const [label, fn] of scenarios) {
    const s = summarise(rows.filter(fn));
    if (!s.n) { console.log('  ' + label.padEnd(34) + '     no picks'); continue; }
    const flag = s.n < 25 ? '  (thin)' : '';
    const profitStr = (s.profit >= 0 ? '+$' : '-$') + Math.abs(s.profit).toFixed(0);
    const roiStr = (s.roi >= 0 ? '+' : '') + (s.roi?.toFixed(1) ?? '—') + '%';
    console.log('  ' + label.padEnd(34) +
      String(s.n).padStart(5) + ' picks' +
      profitStr.padStart(12) + roiStr.padStart(10) + flag);
  }

  console.log('\nNote: profit is computed at the price recorded on each pick. It does');
  console.log('not include line shopping — taking the best available number would');
  console.log('move every row up, which is the point of the odds/compare work.\n');

  await db.$disconnect();
})().catch(async (err) => {
  console.error('backtest failed:', err.message);
  try { await db.$disconnect(); } catch {}
  process.exit(1);
});
