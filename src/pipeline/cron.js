/**
 * Match Point — automated pipeline.
 *
 * Run standalone with `npm run pipeline`, or deploy as a scheduled job
 * (Railway cron, a Render cron job, GitHub Actions on a schedule, etc.)
 * instead of a long-running node-cron process — either works.
 *
 * What this does NOT do yet: pull the qualitative factor inputs (surface fit,
 * injury reports, weather, etc.) that scoreModel.js expects. Those need their
 * own data sources per sport (see the notes in fetchMatches.js) and their own
 * normalization into the -1..+1 factor scores scoreModel.js consumes. Right
 * now this pipeline only wires up the odds-based skeleton — matches get
 * fetched and stored, but factor scoring is stubbed with neutral placeholders
 * until real qualitative inputs are connected per sport.
 */

require('dotenv').config();
const cron = require('node-cron');
const db = require('../lib/db');
const { fetchMatches } = require('./fetchMatches');
const { buildPicks } = require('./scoreModel');

const SPORTS = ['tennis', 'basketball', 'soccer', 'baseball', 'football'];

async function ensureSportRows() {
  for (const slug of SPORTS) {
    await db.sport.upsert({
      where: { slug },
      update: {},
      create: { slug, name: slug[0].toUpperCase() + slug.slice(1) },
    });
  }
}

// STUB: replace with real qualitative inputs once each sport's data sources
// (see nfl-model / coe-model / bloom-model / babe-ruth-model notes) are wired
// up. Returns neutral (0) for every factor, which will keep confidence at a
// flat 50 until real data replaces this.
function getFactorsStub(sport) {
  const weights = require('./scoreModel').WEIGHTS[sport];
  const factors = {};
  for (const key of Object.keys(weights)) factors[key] = 0;
  return factors;
}

async function runForSport(sportSlug) {
  console.log(`[pipeline] fetching ${sportSlug}...`);

  let matches;
  try {
    matches = await fetchMatches(sportSlug);
  } catch (err) {
    console.error(`[pipeline] ${sportSlug} fetch failed:`, err.message);
    return;
  }

  const sportRow = await db.sport.findUnique({ where: { slug: sportSlug } });

  for (const m of matches) {
    const match = await db.match.upsert({
      where: { externalId: m.externalId },
      update: {
        status: m.status,
        startTime: m.startTime,
      },
      create: {
        externalId: m.externalId,
        sportId: sportRow.id,
        league: m.league,
        competitorA: m.competitorA,
        competitorB: m.competitorB,
        startTime: m.startTime,
        status: m.status,
      },
    });

    // TODO: replace getFactorsStub with real per-sport factor computation
    // once qualitative data sources are connected (see fetchMatches.js notes).
    const factors = getFactorsStub(sportSlug);
    const rationale = 'Model ran on odds data only — qualitative factors not yet connected.';

    const picks = buildPicks({
      sport: sportSlug,
      competitorA: m.competitorA,
      competitorB: m.competitorB,
      oddsA: m.oddsA,
      oddsB: m.oddsB,
      factors,
      rationale,
    });

    for (const p of picks) {
      // Avoid duplicate picks for the same match + type on repeated runs.
      const already = await db.pick.findFirst({
        where: { matchId: match.id, pickType: p.pickType },
      });
      if (already) continue;

      await db.pick.create({
        data: {
          matchId: match.id,
          pickType: p.pickType,
          selection: p.selection,
          confidence: p.confidence,
          odds: p.odds,
          rationale: p.rationale,
        },
      });
    }
  }

  console.log(`[pipeline] ${sportSlug}: processed ${matches.length} matches.`);
}

async function runAll() {
  await ensureSportRows();
  for (const sport of SPORTS) {
    await runForSport(sport);
  }
}

// If run directly (npm run pipeline), execute once and exit.
if (require.main === module) {
  runAll()
    .then(() => {
      console.log('[pipeline] done.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[pipeline] fatal error:', err);
      process.exit(1);
    });
}

// If imported instead, expose a scheduler you can start from server.js —
// e.g. every 15 minutes for daily matches, and a tighter interval for live
// in-play score/odds updates once that data source is connected.
function startScheduled() {
  cron.schedule('*/15 * * * *', () => {
    runAll().catch((err) => console.error('[pipeline] scheduled run failed:', err));
  });
  console.log('[pipeline] scheduled to run every 15 minutes.');
}

module.exports = { runAll, startScheduled };
