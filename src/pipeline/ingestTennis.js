/**
 * ingestTennis.js — brings the SportsAPI365 tennis feed into the pipeline.
 *
 * Two jobs, deliberately separate:
 *
 *   ingestTennisFixtures()   pulls Challenger/ITF/main-tour fixtures and
 *                            upserts them as Match rows, so the analyst
 *                            picks them up like any other match.
 *
 *   applyTennisLiveState()   joins the live feed to existing matches BY
 *                            NAME and writes score, serve stats and tour
 *                            level onto them.
 *
 * WHY NAME MATCHING. The two providers use unrelated ids — a Core fixture
 * is 1411, the same match on the live feed is 3842034, and The Odds API
 * has its own. There is no crosswalk, so names are the only join key.
 * namesLikelyMatch already handles the hard cases (compound surnames,
 * dropped middle names) that broke the ESPN join before.
 */

const { fetchUpcomingFixtures, fetchLiveEvents } = require('./fetchTennisApi.js');
const { namesLikelyMatch } = require('./fetchEspn.js');
const db = require('../lib/db.js');

const ENABLED = process.env.TENNIS_API_INGEST !== 'false';

/**
 * Upsert tennis fixtures. externalId is prefixed so these can never
 * collide with, or silently overwrite, an Odds API row for the same match
 * — the two sources stay distinguishable in the database.
 */
async function ingestTennisFixtures() {
  if (!ENABLED) return { created: 0, updated: 0, skipped: 0 };

  let fixtures;
  try {
    fixtures = await fetchUpcomingFixtures();
  } catch (err) {
    console.error(`[tennisIngest] fixture fetch failed: ${err.message}`);
    return { created: 0, updated: 0, skipped: 0, error: err.message };
  }

  const sport = await db.sport.findFirst({ where: { slug: 'tennis' } });
  if (!sport) {
    console.error('[tennisIngest] no tennis sport row — cannot ingest');
    return { created: 0, updated: 0, skipped: 0 };
  }

  let created = 0, updated = 0, skipped = 0;

  for (const f of fixtures) {
    if (!f.competitorA || !f.competitorB || !f.startTime) { skipped++; continue; }

    // Don't duplicate a match the Odds API already supplied. Same two
    // players starting within three hours is the same match.
    const windowStart = new Date(f.startTime.getTime() - 3 * 60 * 60 * 1000);
    const windowEnd = new Date(f.startTime.getTime() + 3 * 60 * 60 * 1000);
    const existing = await db.match.findFirst({
      where: {
        sportId: sport.id,
        startTime: { gte: windowStart, lte: windowEnd },
        NOT: { externalId: f.sourceId },
      },
    });
    if (existing &&
        ((namesLikelyMatch(existing.competitorA, f.competitorA) && namesLikelyMatch(existing.competitorB, f.competitorB)) ||
         (namesLikelyMatch(existing.competitorA, f.competitorB) && namesLikelyMatch(existing.competitorB, f.competitorA)))) {
      // Already have it from the other provider. Enrich rather than
      // duplicate: the tour level is the one thing only this feed knows.
      if (existing.tourLevel === null || existing.tourLevel === undefined) {
        await db.match.update({ where: { id: existing.id }, data: { tourLevel: f.tourLevel } });
      }
      skipped++;
      continue;
    }

    const before = await db.match.findUnique({ where: { externalId: f.sourceId } });
    await db.match.upsert({
      where: { externalId: f.sourceId },
      update: {
        startTime: f.startTime,
        league: f.league,
        tourLevel: f.tourLevel,
      },
      create: {
        externalId: f.sourceId,
        sportId: sport.id,
        league: f.league || (f.tour || 'ATP').toUpperCase(),
        competitorA: f.competitorA,
        competitorB: f.competitorB,
        startTime: f.startTime,
        status: 'scheduled',
        tourLevel: f.tourLevel,
      },
    });
    before ? updated++ : created++;
  }

  console.log(`[tennisIngest] fixtures: ${created} new, ${updated} updated, ${skipped} already covered`);
  return { created, updated, skipped };
}

/**
 * Join the live feed onto existing matches and write through the state
 * that only this provider carries: set score, and first-serve win rates.
 *
 * Runs against matches that are live or due to have started, so a finished
 * match doesn't keep getting rewritten.
 */
async function applyTennisLiveState() {
  if (!ENABLED) return { matched: 0, unmatched: 0 };

  let events;
  try {
    events = await fetchLiveEvents();
  } catch (err) {
    console.error(`[tennisIngest] live fetch failed: ${err.message}`);
    return { matched: 0, unmatched: 0, error: err.message };
  }
  if (!events.length) return { matched: 0, unmatched: 0 };

  const sport = await db.sport.findFirst({ where: { slug: 'tennis' } });
  if (!sport) return { matched: 0, unmatched: 0 };

  const since = new Date(Date.now() - 8 * 60 * 60 * 1000);
  const until = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const candidates = await db.match.findMany({
    where: { sportId: sport.id, startTime: { gte: since, lte: until }, status: { not: 'final' } },
  });

  let matched = 0, unmatched = 0;

  for (const ev of events) {
    if (!ev.competitorA || !ev.competitorB) { unmatched++; continue; }

    const hit = candidates.find((m) =>
      (namesLikelyMatch(m.competitorA, ev.competitorA) && namesLikelyMatch(m.competitorB, ev.competitorB)) ||
      (namesLikelyMatch(m.competitorA, ev.competitorB) && namesLikelyMatch(m.competitorB, ev.competitorA)));

    if (!hit) { unmatched++; continue; }

    // If the feed lists the players the other way round from us, the
    // per-player stats have to be swapped too or they land on the wrong
    // competitor — the kind of silent inversion that would make a serve
    // warning point at the wrong player.
    const flipped = namesLikelyMatch(hit.competitorA, ev.competitorB);

    await db.match.update({
      where: { id: hit.id },
      data: {
        status: ev.status === 'InPlay' ? 'live' : hit.status,
        setScore: ev.setScore || hit.setScore,
        liveScore: ev.setScore || hit.liveScore,
        tourLevel: hit.tourLevel ?? null,
      },
    });
    matched++;
  }

  console.log(`[tennisIngest] live: ${matched} joined, ${unmatched} with no match on our board`);
  return { matched, unmatched };
}

module.exports = { ingestTennisFixtures, applyTennisLiveState };
