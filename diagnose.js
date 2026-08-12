/**
 * Diagnose why matches aren't being analysed.
 *
 * Runs the SAME code the pipeline runs — same fetch, same normalisation,
 * same guards — and prints the decision for every match, so we stop
 * inferring the cause from side effects.
 *
 *   railway run node diagnose.js
 *
 * Read-only: fetches odds and reads the database. Creates nothing,
 * updates nothing, spends no Anthropic credit.
 */

// postgres.railway.internal only resolves INSIDE Railway. `railway run`
// executes locally with Railway's env vars, so the internal hostname
// can't be reached from here. Railway exposes a public URL for exactly
// this case — swap it in BEFORE requiring db, since PrismaClient reads
// DATABASE_URL at construction time.
if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
} else if ((process.env.DATABASE_URL || '').includes('railway.internal')) {
  console.error('\nDATABASE_URL points at railway.internal, which is unreachable from your machine.');
  console.error('Get the public URL:  railway variables --service Postgres');
  console.error('Then run:            $env:DATABASE_PUBLIC_URL="<that url>"; railway run node diagnose.js\n');
  process.exit(1);
}

const db = require('./src/lib/db');
const { fetchMatches } = require('./src/pipeline/fetchMatches');

const SPORT = process.argv[2] || 'tennis';
const MAX_CYCLE_FAILURES = 3;

function pacificDayBounds() {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = dtf.formatToParts(new Date()).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  const startOfDay = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00-07:00`);
  return { startOfDay, endOfDay: new Date(startOfDay.getTime() + 86400000) };
}

(async () => {
  console.log(`\n=== Diagnosing ${SPORT} ===\n`);

  // Prove which build is actually running. If the book fallback isn't
  // deployed, oddsBook/bookCount will be undefined on every row and that
  // alone explains everything below.
  const matches = await fetchMatches(SPORT);
  const sample = matches[0] || {};
  console.log('Build check:');
  console.log('  oddsBook field present :', Object.prototype.hasOwnProperty.call(sample, 'oddsBook'));
  console.log('  bookCount field present:', Object.prototype.hasOwnProperty.call(sample, 'bookCount'));
  if (!Object.prototype.hasOwnProperty.call(sample, 'oddsBook')) {
    console.log('  >> The bookmaker-fallback build is NOT deployed. That is the problem.\n');
  } else {
    console.log('');
  }

  const { startOfDay, endOfDay } = pacificDayBounds();
  const today = matches.filter((m) => {
    const t = new Date(m.startTime).getTime();
    return t >= startOfDay.getTime() && t < endOfDay.getTime();
  });

  console.log(`${matches.length} fetched, ${today.length} start today (Pacific)\n`);

  const tally = {};
  const note = (k) => { tally[k] = (tally[k] || 0) + 1; };

  for (const m of today) {
    const match = await db.match.findUnique({
      where: { externalId: m.externalId },
      include: { picks: { where: { pickType: { in: ['model', 'winner'] } }, take: 1 } },
    });

    const label = `${m.competitorA} vs ${m.competitorB}`.padEnd(52).slice(0, 52);
    const priced = `${m.oddsA ?? '—'}/${m.oddsB ?? '—'}`.padEnd(12);
    const book = String(m.oddsBook ?? '?').padEnd(14);
    const books = String(m.bookCount ?? '?').padStart(2);

    let verdict;
    if (!match) verdict = 'NOT IN DB — pipeline has not upserted it yet';
    else if (match.picks.length > 0) verdict = 'OK — already analysed';
    else if (match.skipAnalysis) verdict = 'BLOCKED — skipAnalysis flag is set';
    else if (m.oddsA === null || m.oddsB === null) {
      verdict = (m.bookCount ?? 0) === 0
        ? 'BLOCKED — no book anywhere prices it'
        : `BLOCKED — ${m.bookCount} book(s) returned but none usable (OUR BUG)`;
    } else if (match.analysisFailCycles >= MAX_CYCLE_FAILURES) {
      verdict = `BLOCKED — failCycles ${match.analysisFailCycles} >= ${MAX_CYCLE_FAILURES}`;
    } else {
      verdict = 'SHOULD ANALYSE — nothing is blocking it';
    }

    note(verdict.split(' — ')[0]);
    console.log(`${label} ${priced} ${book} ${books}bk  ${verdict}`);
  }

  console.log('\n=== Summary ===');
  Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));
  console.log('');
  await db.$disconnect();
})().catch(async (err) => {
  console.error('diagnose failed:', err);
  try { await db.$disconnect(); } catch {}
  process.exit(1);
});
