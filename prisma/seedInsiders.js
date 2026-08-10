// prisma/seedInsiders.js — run once: node prisma/seedInsiders.js
// Seeds the starting curated account list for the Insiders sidebar.
// Uses upsert, so it's safe to re-run later if you add more handles
// to the list below — existing ones won't be duplicated.

const db = require('../src/lib/db'); // adjust path if you place this file elsewhere

const SEED = {
  tennis: ['ChristopherClarey', 'jon_wertheim', 'TennisTV'],
  basketball: ['wojespn', 'ShamsCharania', 'ZachLowe_NBA', 'KenniMiddleton', 'bigpodwithshaq', 'Roommates__Show', 'angelreeseshow'],
  soccer: ['FabrizioRomano', 'OptaJoe', 'MLS'],
  baseball: ['Ken_Rosenthal', 'JeffPassan', 'MLB', 'The_Oddsmaker'],
  football: ['AdamSchefter', 'RapSheet', 'FieldYates', 'Stuckey2', '_Collin1', 'The_Oddsmaker', 'vegasbedwards', 'Jonny_Reno'],
};

async function main() {
  for (const [sport, handles] of Object.entries(SEED)) {
    for (let i = 0; i < handles.length; i++) {
      await db.insiderAccount.upsert({
        where: { sport_handle: { sport, handle: handles[i] } },
        update: {},
        create: { sport, handle: handles[i], order: i },
      });
    }
  }
  console.log('Seeded insider accounts.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
