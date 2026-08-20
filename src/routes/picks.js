const express = require('express');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { fetchEspnNews } = require('../pipeline/fetchEspnNews');
const { getRecentPosts } = require('../pipeline/fetchXTimeline');
const { getStandings, getRecordMap } = require('../pipeline/fetchEspnStandings');
const { fetchMatches } = require('../pipeline/fetchMatches');
const { reanalyzeUpcoming } = require('../pipeline/cron');
const { getWeights, canonicalLabel } = require('../pipeline/factorWeights');
const { namesLikelyMatch } = require('../pipeline/fetchEspn');
const { getHealthSnapshot } = require('../lib/healthStats');
const { isAdminEmail } = require('./auth');
const { fetchBasketballPlayerProps } = require('../pipeline/fetchPlayerProps');
const { analyzePlayerProps } = require('../pipeline/propsAnalyst');
const { fetchEspnLiveScores, matchEspnEvent } = require('../pipeline/fetchEspn');
const { analyzeStartSit } = require('../pipeline/fantasyAnalyst');
const { triggerManualRun, triggerManualRunTomorrow } = require('../pipeline/cron');

const router = express.Router();

// Sports still in development, excluded from the PUBLISHED record.
//
// Not deleted — excluded. Deleting results to make a track record look
// better is the one thing that would undermine a product whose whole
// pitch is published accuracy, and it also destroys the baseline you need
// to tell whether a model change actually helped.
//
// These sports still get analysed, still get graded, and still appear in
// the Win Rate Tracker's per-sport table (clearly marked). They just
// don't feed the headline win rate, the streak, or the equity curve.
//
// Set DEVELOPING_SPORTS in the environment to change the list without a
// deploy; empty string re-includes everything.
const DEVELOPING_SPORTS = (process.env.DEVELOPING_SPORTS ?? 'football,soccer')
  .split(',').map((x) => x.trim()).filter(Boolean);

function developingSportsFilter(includeDeveloping) {
  if (includeDeveloping || DEVELOPING_SPORTS.length === 0) return {};
  return { match: { sport: { slug: { notIn: DEVELOPING_SPORTS } } } };
}

// One graded result per MATCH.
//
// Historically a single call was written as TWO Pick rows — 'winner' and
// 'model' — with identical selection/confidence/odds whenever it cleared
// the edge threshold. Picks below the threshold got only a 'winner' row.
// That's why stats used to filter to pickType:'model': it was the only
// way to avoid counting one match twice. The side effect was that every
// below-threshold match vanished from the published win rate and streak,
// so those numbers described a favourable subset of what the site
// actually sold.
//
// New picks are written once (pickType 'model'), but the historical rows
// still exist, so every read path takes BOTH types and de-duplicates per
// match here — preferring 'model' where a legacy pair exists. Same match,
// counted exactly once, nothing dropped.
function dedupeResultsByMatch(results) {
  const byMatch = new Map();
  for (const r of results) {
    const key = r.pick.matchId;
    const existing = byMatch.get(key);
    if (!existing || (existing.pick.pickType !== 'model' && r.pick.pickType === 'model')) {
      byMatch.set(key, r);
    }
  }
  return [...byMatch.values()];
}

// Computes the UTC instant corresponding to midnight in a given IANA
// timezone, for a given reference date. Used to make "today's picks" roll
// over at midnight Pacific Time rather than server-local time (Railway
// runs in UTC, which would otherwise flip the slate ~4-5pm PT, showing
// tomorrow's matches while it's still evening on the West Coast).
// This correctly handles Daylight Saving Time since the offset is derived
// from the actual date via Intl, not hardcoded.
function getTimezoneDayBounds(timeZone, referenceDate = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(referenceDate).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});

  // What UTC instant would produce this wall-clock time in the target zone.
  const asIfUTC = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  const offsetMs = asIfUTC - referenceDate.getTime();

  // Shift "now" by that offset to get the target zone's current wall-clock
  // date, then find real-UTC midnight for that date by reversing the shift.
  const shifted = new Date(referenceDate.getTime() + offsetMs);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  const startOfDay = new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - offsetMs);
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);

  return { startOfDay, endOfDay };
}

// Whether a user is entitled to see the full detail of a given pick —
// either they bought it individually, or they have an active subscription.
async function userHasAccess(userId, pickId) {
  if (!userId) return false;

  // Admin accounts see everything unlocked — for internal QA/testing the
  // full site without having to actually purchase every pick.
  const user = await db.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
  if (user?.isAdmin) return true;

  const purchased = await db.purchasedPick.findUnique({
    where: { userId_pickId: { userId, pickId } },
  });
  if (purchased) return true;

  const sub = await db.subscription.findUnique({ where: { userId } });
  // Must check expiration explicitly — Coinbase Commerce has no
  // subscription lifecycle events (unlike Stripe's customer.subscription.*
  // webhooks), so nothing ever flips status away from 'active' on its own.
  // Without this check, one payment would grant access forever.
  // 'canceling' still has access. Someone who cancels a weekly plan on
  // day 2 paid for the week and keeps the week — the flag only stops the
  // renewal. currentPeriodEnd is what actually ends access, and Whop
  // fires membership.went_invalid at that point to close it out.
  // Requiring 'active' alone would have revoked access the instant they
  // hit cancel, which is both wrong and the fastest route to a chargeback.
  return !!sub && ['active', 'canceling'].includes(sub.status) && sub.currentPeriodEnd > new Date();
}

// Resolves the requester from an optional Authorization header without
// requiring one — used on public endpoints that still want to show unlocked
// detail to logged-in, entitled users.
function resolveOptionalUser(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET || 'dev-secret');
    return payload.userId;
  } catch (_) {
    return null; // invalid/expired token — treat as anonymous
  }
}

// GET /api/picks/today?sport=tennis
// Public: returns picks with confidence/selection redacted unless the
// requester is authenticated and entitled. Attach Authorization header to
// unlock full detail. "Today" rolls over at midnight Pacific Time.
router.get('/today', async (req, res) => {
  const { sport, markets } = req.query;
  const { startOfDay, endOfDay } = getTimezoneDayBounds('America/Los_Angeles');

  // Try to resolve the requester, but don't require auth for this endpoint.
  const userId = resolveOptionalUser(req);

  // ?markets=all (Parlay Builder) doesn't need the Upcoming Matches
  // feature at all — keeps its original simple pick-only query,
  // unchanged, no extra load added there.
  if (markets === 'all') {
    const picks = await db.pick.findMany({
      where: {
        pickType: { in: ['model', 'winner'] },
        match: {
          startTime: { gte: startOfDay, lte: endOfDay },
          ...(sport ? { sport: { slug: sport } } : {}),
        },
      },
      include: { match: { include: { sport: true } } },
      orderBy: { confidence: 'desc' },
    });
    const shaped = await Promise.all(picks.map((p) => shapePick(p, userId)));
    return res.json({ picks: shaped });
  }

  // ?includeFinal=true — the Scoreboard tab needs this. Default mode
  // (below, no query param) intentionally excludes finished matches,
  // since that's the right behavior for the live-polling Money Line
  // board. But that meant NOTHING ever fetched final matches with their
  // real score/pick shape via REST — Scoreboard was silently relying on
  // whatever finished while a WebSocket happened to be connected during
  // this exact browser session, missing anything that finished earlier
  // or while the tab was closed. This explicitly asks for the full
  // day's slate including finals, same full pick/score shape as normal.
  const includeFinal = req.query.includeFinal === 'true';
  const statusFilter = includeFinal ? { in: ['scheduled', 'live', 'final'] } : { in: ['scheduled', 'live'] };

  // ?includeTomorrow=true — extends the board's window through tomorrow.
  //
  // Showing a fixture costs nothing; ANALYSING one costs a paid research
  // call. Those two are deliberately decoupled: the pregame pipeline stays
  // strictly today-only (analysis is frozen once written, so a pick made a
  // day early is built on stale team news), while the board can show
  // tomorrow's slate as upcoming with no pick attached yet.
  //
  // Not applied to the "analysed today" counter, which must stay bounded
  // to today or it starts counting tomorrow's fixtures.
  const windowEnd = req.query.includeTomorrow === 'true'
    ? new Date(endOfDay.getTime() + 24 * 60 * 60 * 1000)
    : endOfDay;

  // Default moneyline mode: ONE query on Match (with its picks included),
  // not two separate queries against Pick and Match — this endpoint
  // already polls every 20 seconds from the frontend, so doubling its
  // query count (as an earlier version of this endpoint briefly did) is
  // real, meaningful added database load, not a rounding error. Splitting
  // the single result set into "has a real pick" vs "doesn't yet" happens
  // in JS below instead of via a second round-trip to the database.
  const matches = await db.match.findMany({
    where: {
      startTime: { gte: startOfDay, lte: windowEnd },
      status: statusFilter,
      // skipAnalysis only matters for matches the pipeline might still
      // attempt — irrelevant (and could wrongly hide a real final match)
      // once a match has actually finished, so it's only applied in the
      // normal (non-final) mode.
      ...(includeFinal ? {} : { skipAnalysis: false }),
      ...(sport ? { sport: { slug: sport } } : {}),
    },
    include: {
      sport: true,
      picks: { where: { pickType: { in: ['model', 'winner', 'live'] }, market: { in: ['moneyline'] } } },
    },
  });

  // Drop stale, unanalysable rows.
  //
  // A match can sit in the database long after the odds feed has stopped
  // listing it — books pull a market, a qualifier gets rescheduled, an
  // event id is reissued. If such a row never received a pick, it never
  // will: there's no price left to analyse against. It then renders as
  // "Awaiting Analysis" indefinitely, and since the start time has passed
  // the countdown shows a permanent "Starting…".
  //
  // Measured in production: 47 database rows for today's window against
  // 30 matches actually in the feed, 13 of them pickless. Those 13 were
  // the entire unexplained block on the board.
  //
  // Only rows that are ALL of: unanalysed, still 'scheduled' (ESPN never
  // saw them start), and more than two hours past their start time. A
  // genuine delay stays visible; two hours is well beyond any real tennis
  // session slip.
  // 45 minutes, not 2 hours. If a match's start time has passed, ESPN
  // hasn't reported it in progress, and it still has no pick, it isn't
  // going to get one — the odds feed has already dropped it. Two hours
  // meant a screen full of permanently "Starting…" rows in the meantime.
  //
  // Still comfortably longer than a real tennis session slip, and a match
  // ESPN DOES see start is exempt regardless of age (the status check
  // below), so a genuinely delayed match is never hidden.
  const STALE_UNANALYSED_MS = 45 * 60 * 1000;
  const staleCutoff = Date.now() - STALE_UNANALYSED_MS;
  // COLLAPSE DUPLICATE FIXTURES.
  //
  // The same match can exist as two rows. The odds feed reissues an event
  // id when it renames a player ("Daniel Merida" -> "Daniel Merida
  // Aguilar") or moves an event between tournament keys, and externalId
  // is what identifies a row — so a second row gets created, the pipeline
  // analyses whichever one the feed currently lists, and the board renders
  // BOTH. The orphan has no pick and shows "Awaiting Analysis" next to its
  // own analysed twin.
  //
  // Grouping on the exact matchup string missed this completely, because
  // the whole point is that the names differ slightly. namesLikelyMatch
  // already handles those variants for ESPN matching; reused here.
  //
  // Keeps the row WITH a pick. If neither has one, keeps the newest —
  // that's the row the feed currently references.
  const deduped = [];
  for (const m of matches) {
    const twin = deduped.find((d) =>
      Math.abs(new Date(d.startTime).getTime() - new Date(m.startTime).getTime()) < 6 * 60 * 60 * 1000 &&
      namesLikelyMatch(d.competitorA, m.competitorA) &&
      namesLikelyMatch(d.competitorB, m.competitorB)
    );
    if (!twin) { deduped.push(m); continue; }
    const twinHasPick = twin.picks.some((pk) => pk.pickType !== 'live');
    const thisHasPick = m.picks.some((pk) => pk.pickType !== 'live');
    if (thisHasPick && !twinHasPick) deduped[deduped.indexOf(twin)] = m;
  }
  if (deduped.length !== matches.length) {
    console.log(`[today] collapsed ${matches.length - deduped.length} duplicate fixture row(s) for ${sport || 'all sports'}.`);
  }

  const visibleMatches = deduped.filter((m) => {
    const hasPregamePick = m.picks.some((pk) => pk.pickType !== 'live');
    if (hasPregamePick) return true;
    if (m.status !== 'scheduled') return true;
    return new Date(m.startTime).getTime() >= staleCutoff;
  });

  const shaped = [];
  for (const m of visibleMatches) {
    const pregamePicks = m.picks.filter((pk) => pk.pickType !== 'live');
    if (pregamePicks.length > 0) {
      // One representative pick per match, not every tier — 'winner' and
      // 'model' are two deliberate product tiers on the SAME underlying
      // analysis (every match gets a 'winner' pick; confident ones also
      // get a 'model' pick), not duplicates. Showing both here would
      // display every analyzed match twice. Prefer 'model' when it
      // exists (the more complete product), same fallback pattern
      // already used elsewhere in this file.
      const p = pregamePicks.find((pk) => pk.pickType === 'model') || pregamePicks[0];
      // Real fix: live reassessment (cron.js, updateLivePicksForSport)
      // has been computing an updated selection/confidence/rationale
      // every 15 minutes this whole time, writing it to a SEPARATE
      // pickType:'live' record — deliberately kept apart from the
      // frozen pregame pick so stats/grading never touch it. But
      // nothing ever displayed that live record; the frontend showed
      // the frozen pregame value even while a match was live, making
      // confidence look permanently static. When a match is actually
      // live and a live-reassessed record exists, use ITS
      // selection/confidence/rationale for display — analyzedAt still
      // reflects the ORIGINAL pregame analysis time (that's real
      // information, not something to overwrite), only the live
      // judgment itself is swapped in.
      const liveOverride = m.status === 'live' ? m.picks.find((pk) => pk.pickType === 'live') : null;
      // entryOdds is the PREGAME pick's frozen price — the number the
      // call was originally made at. The live record's odds get
      // overwritten with the current market price every cycle, so
      // without carrying this through separately there'd be nothing to
      // compare against. This is what the Line Value meter measures:
      // current live price vs. the price when the pick was made.
      // entryOdds is ONLY meaningful when the live pick is on the same
      // side as the pregame pick — it's the price of THIS selection when
      // the call was made. If the two ever disagree (a stale row from
      // before live picks inherited the pregame side, mid-heal), sending
      // it anyway would have the Line Value meter compare one player's
      // price to the other player's price and report a huge bogus
      // "better price". Withholding it just hides the badge for that row
      // until the next cycle heals it, which is the safe failure.
      const sidesAgree = liveOverride && p.selection === liveOverride.selection;
      const displayPick = liveOverride
        ? {
            ...p,
            selection: liveOverride.selection,
            confidence: liveOverride.confidence,
            rationale: liveOverride.rationale,
            odds: liveOverride.odds,
            entryOdds: sidesAgree ? p.odds : null,
            // When the live price was last actually refreshed. Books close
            // in-play markets as a match nears its end, and when that
            // happens the meter keeps showing its last value — which looks
            // identical to the pipeline being broken. Exposing the age lets
            // the board say "this price is stale" instead of presenting a
            // dead number as live.
            liveUpdatedAt: liveOverride.updatedAt,
          }
        : p;
      shaped.push(await shapePick({ ...displayPick, match: m }, userId));
    } else {
      shaped.push(shapeUnanalyzedMatch(m));
    }
  }

  // EXPERIMENTAL — real test, not a permanent architecture change yet.
  // Pulls ESPN's own schedule directly and surfaces any event that has
  // NO corresponding Match row at all (not even an unanalyzed one) —
  // this catches real gaps in the odds provider's coverage, like tennis
  // doubles (which that provider doesn't seem to carry at all) or a
  // specific singles match that provider simply never returned despite
  // being real and priced on a real sportsbook (confirmed happening for
  // at least one real match today). These entries have no odds and
  // never will via the normal pipeline — reusing matchEspnEvent() here
  // for the INVERSE of its normal purpose: finding ESPN events that
  // DON'T match anything we already have, not events that do.
  if (sport && !markets) {
    try {
      const espnEvents = await fetchEspnLiveScores(sport);
      const alreadyKnown = matches; // same list already fetched above — both picked and unanalyzed matches
      const espnOnlyRaw = espnEvents.filter((ev) =>
        !matchEspnEvent(ev, alreadyKnown) &&
        !ev.completed &&
        // TODAY ONLY. ESPN's scoreboard returns whole tournament draws,
        // not just the current day — tennis especially. Without this,
        // matches scheduled days from now were injected straight into
        // today's board, which is why "Upcoming Matches" showed fixtures
        // from other days. The main query above is already bounded to
        // today; this supplemental path never was.
        ev.eventDate &&
        new Date(ev.eventDate).getTime() >= startOfDay.getTime() &&
        new Date(ev.eventDate).getTime() <= windowEnd.getTime() &&
        // Future-round bracket slots ESPN lists before the actual
        // players are determined — not a real, bettable matchup yet.
        // Confirmed happening in production (15+ of these in one
        // response) rather than a hypothetical edge case.
        ev.competitorAName !== 'TBD' && ev.competitorBName !== 'TBD'
      );
      // De-dupe by matchup+time — confirmed happening in production
      // (several real matches, like Naomi Osaka vs Elena Rybakina,
      // appearing twice) — likely ESPN listing the same event under more
      // than one grouping/league query.
      const seenEspnKeys = new Set();
      const espnOnly = espnOnlyRaw.filter((ev) => {
        const key = `${ev.competitorAName}|${ev.competitorBName}|${ev.eventDate}`;
        if (seenEspnKeys.has(key)) return false;
        seenEspnKeys.add(key);
        return true;
      });
      espnOnly.forEach((ev, i) => {
        shaped.push({
          id: `espn-only-${sport}-${i}-${new Date(ev.eventDate).getTime()}`,
          sport,
          league: 'ESPN Schedule', // real tournament/league name isn't available from this parsing path
          matchup: `${ev.competitorAName} vs ${ev.competitorBName}`,
          startTime: ev.eventDate,
          pickType: 'pending',
          market: 'moneyline',
          line: null, price: null, selection: null, confidence: null, rationale: null, odds: null,
          spread: null, spreadOddsA: null, spreadOddsB: null, total: null, overOdds: null, underOdds: null,
          matchStatus: ev.inProgress ? 'live' : 'scheduled',
          analyzedAt: null,
          liveScore: null, setScore: ev.setScore || null, periodScores: null, period: null, clockSeconds: null, liveClock: null,
          unlocked: false,
          hasPick: false,
          espnOnly: true, // real flag — no odds provider will ever price this via the normal pipeline; distinct from a normal "waiting on analysis" entry
        });
      });
    } catch (err) {
      console.error(`[today] ESPN supplemental fetch failed for ${sport}:`, err.message);
      // Fails silently into just not adding supplemental entries — the
      // normal picks/unanalyzed matches above are unaffected either way.
    }
  }

  shaped.sort((a, b) => (b.confidence || -1) - (a.confidence || -1));

  res.json({ picks: shaped });
});

// Shapes one real Pick row (with its match already attached) into the
// public-facing shape /today returns. Pulled out of the route handler so
// both the markets=all path and the default path can share it.
async function shapePick(p, userId) {
  const unlocked = await userHasAccess(userId, p.id);
  return {
    id: p.id,
    sport: p.match.sport.slug,
    league: p.match.league,
    matchup: `${p.match.competitorA} vs ${p.match.competitorB}`,
    startTime: p.match.startTime,
    pickType: p.pickType,
    market: p.market, // 'moneyline' | 'spread' | 'total' — callers that opted into ?markets=all need this to tell picks apart
    line: p.line, // the spread/total number this specific pick was made against, null for moneyline
    price: p.price,
    // Redact the actual pick and confidence until purchased/subscribed
    selection: unlocked ? p.selection : null,
    confidence: unlocked ? p.confidence : null,
    rationale: unlocked ? p.rationale : null,
    odds: p.odds,
    entryOdds: p.entryOdds ?? null,
    liveUpdatedAt: p.liveUpdatedAt ?? null,
    // Best price across all books for the side actually picked, plus what
    // shopping is worth. Powers the Best Price board column.
    bestOdds: p.bestOdds ?? null,
    bestBook: p.bestBook ?? null,
    shopGain: p.shopGain ?? null,
    openingOdds: p.openingOdds ?? null,
    currentOdds: p.currentOdds ?? null,
    moveGain: p.moveGain ?? null, // pregame price for this same pick, when the match is live — powers the Line Value meter
    // Raw market lines, not model analysis — shown to everyone, same
    // as odds above. Null whenever a book hasn't posted that market
    // yet, never a fabricated number.
    spread: p.match.spread,
    spreadOddsA: p.match.spreadOddsA,
    spreadOddsB: p.match.spreadOddsB,
    total: p.match.total,
    overOdds: p.match.overOdds,
    underOdds: p.match.underOdds,
    // Real live status, sourced from the free ESPN score poller — not
    // the (now-removed) paid live-reassessment loop. matchStatus is
    // 'scheduled' | 'live' | 'final'; the rest are only meaningful
    // once live, and null otherwise.
    matchStatus: p.match.status,
    analyzedAt: p.createdAt, // when the model actually ran on this match — confidence is frozen from this moment on
    liveScore: p.match.liveScore,
    setScore: p.match.setScore, // tennis only — "6-4, 3-6, 2-1" style, for the real set-by-set display
    /* LIVE POINT-LEVEL STATE, tennis only, from the socket.
     *
     * liveStateAt is sent alongside deliberately. A point score goes stale
     * within about a minute, and one displayed as live when it isn't is
     * worse than showing nothing — so the client gates on the timestamp
     * rather than trusting the value. Server-side we just report what we
     * have and when we got it.
     *
     * liveOdds are kept separate from `odds`, which stays the frozen
     * pregame price of record. Grading must never see an in-play number.
     */
    livePoints: p.match.livePoints ?? null,
    liveServing: p.match.liveServing ?? null,
    liveStateAt: p.match.liveStateAt ?? null,
    liveOddsA: p.match.liveOddsA ?? null,
    liveOddsB: p.match.liveOddsB ?? null,
    liveOddsBook: p.match.liveOddsBook ?? null,
    firstServeWonA: p.match.firstServeWonA ?? null,
    firstServeWonB: p.match.firstServeWonB ?? null,
    tourLevel: p.match.tourLevel ?? null,
    tourLevelName: ({ 0: 'ITF', 1: 'Challenger', 2: 'ATP Tour', 3: 'ATP Masters/Slam' })[p.match.tourLevel] ?? null,

    periodScores: p.match.periodScores, // basketball/football — "25-28, 20-21, 20-24, 22-25" style
    homeHits: p.match.homeHits ?? null,
    awayHits: p.match.awayHits ?? null,
    homeErrors: p.match.homeErrors ?? null,
    awayErrors: p.match.awayErrors ?? null,
    period: p.match.period,
    clockSeconds: p.match.clockSeconds,
    liveClock: p.match.liveClock,
    unlocked,
    hasPick: true,
    ...(function () {
      // Resolve best price to the SIDE THE MODEL PICKED — reading side A
      // unconditionally would name the wrong book whenever the pick is on
      // side B, which is exactly when a user would act on it.
      const m = p.match || {};
      const pickedA = p.selection && p.selection.startsWith(m.competitorA);
      const bestOdds = pickedA ? m.bestOddsA : m.bestOddsB;
      const bestBook = pickedA ? m.bestBookA : m.bestBookB;
      const per100 = (o) => (o > 0 ? o : (100 / Math.abs(o)) * 100);

      // CURRENT market price for the side we picked. p.odds is the OPENING
      // price — frozen when the pick was made — so these two together are
      // what the BUY alert compares: has the number moved in our favour
      // since we posted it?
      const currentOdds = pickedA ? m.oddsA : m.oddsB;

      const moveGain = (typeof currentOdds === 'number' && typeof p.odds === 'number')
        ? Math.round(per100(currentOdds) - per100(p.odds))
        : null;

      // Cross-book gain kept separately — a different question (is another
      // book paying more right now) and no longer what BUY reports.
      const shopGain = (typeof bestOdds === 'number' && typeof p.odds === 'number')
        ? Math.round(per100(bestOdds) - per100(p.odds))
        : null;

      return {
        openingOdds: typeof p.odds === 'number' ? p.odds : null,
        currentOdds: currentOdds ?? null,
        moveGain,
        bestOdds: bestOdds ?? null,
        bestBook: bestBook ?? null,
        shopGain,
      };
    })(),
  };
}

// Shapes a real match that doesn't have a pick yet — genuinely free
// schedule data, no pick-specific fields fabricated.
function shapeUnanalyzedMatch(m) {
  return {
    id: m.id,
    sport: m.sport.slug,
    league: m.league,
    matchup: `${m.competitorA} vs ${m.competitorB}`,
    startTime: m.startTime,
    pickType: 'pending',
    market: 'moneyline',
    line: null,
    price: null,
    selection: null,
    confidence: null,
    rationale: null,
    odds: null,
    spread: m.spread,
    spreadOddsA: m.spreadOddsA,
    spreadOddsB: m.spreadOddsB,
    total: m.total,
    overOdds: m.overOdds,
    underOdds: m.underOdds,
    matchStatus: m.status,
    analyzedAt: null,
    liveScore: m.liveScore,
    setScore: m.setScore,
    /* LIVE POINT-LEVEL STATE, tennis only, from the socket.
     *
     * liveStateAt is sent alongside deliberately. A point score goes stale
     * within about a minute, and one displayed as live when it isn't is
     * worse than showing nothing — so the client gates on the timestamp
     * rather than trusting the value. Server-side we just report what we
     * have and when we got it.
     *
     * liveOdds are kept separate from `odds`, which stays the frozen
     * pregame price of record. Grading must never see an in-play number.
     */
    livePoints: m.livePoints ?? null,
    liveServing: m.liveServing ?? null,
    liveStateAt: m.liveStateAt ?? null,
    liveOddsA: m.liveOddsA ?? null,
    liveOddsB: m.liveOddsB ?? null,
    liveOddsBook: m.liveOddsBook ?? null,
    firstServeWonA: m.firstServeWonA ?? null,
    firstServeWonB: m.firstServeWonB ?? null,
    tourLevel: m.tourLevel ?? null,
    tourLevelName: ({ 0: 'ITF', 1: 'Challenger', 2: 'ATP Tour', 3: 'ATP Masters/Slam' })[m.tourLevel] ?? null,
    periodScores: m.periodScores,
    period: m.period,
    clockSeconds: m.clockSeconds,
    liveClock: m.liveClock,
    unlocked: false,
    hasPick: false,
  };
}

// GET /api/picks/live?sport=all
// Selection is locked until purchased/subscribed. Confidence is shown to
// everyone as a teaser — it's the hook that gets people to buy — so it is
// NOT redacted here, unlike /today.
router.get('/live', async (req, res) => {
  const { sport } = req.query;
  const where = {
    status: 'live',
    ...(sport && sport !== 'all' ? { sport: { slug: sport } } : {}),
  };

  const matches = await db.match.findMany({
    where,
    include: { sport: true, picks: { where: { pickType: 'live' } } },
  });

  const userId = resolveOptionalUser(req);

  const shaped = await Promise.all(
    matches.map(async (m) => ({
      id: m.id,
      sport: m.sport.slug,
      league: m.league,
      matchup: `${m.competitorA} vs ${m.competitorB}`,
      liveScore: m.liveScore,
      liveClock: m.liveClock,
      picks: await Promise.all(
        m.picks.map(async (p) => {
          const unlocked = await userHasAccess(userId, p.id);
          return {
            id: p.id,
            selection: unlocked ? p.selection : null,
            confidence: p.confidence,
            odds: p.odds,
            price: p.price,
            unlocked,
          };
        })
      ),
    }))
  );

  res.json({ matches: shaped });
});

// GET /api/picks/stats?sport=tennis — Track Record numbers: win rate, ROI,
// ROI vs. BetMGM's closing line, and matches analyzed/day, ALL-TIME. Public
// — this is marketing-facing proof, not account data.
//
// All-time rather than a rolling window on purpose: with a young, growing
// sample, a 30-day window actually SHRINKS your effective sample as picks
// age out of it, which is backwards — bigger sample size should only make
// the number more trustworthy over time, not less. Pick-selling services
// that publish a real track record report it since inception for the same
// reason.
//
// NOTE ON EMPTY RESULTS: until matches actually finish and get graded (see
// gradeFinishedMatches() in cron.js), this will legitimately return nulls —
// that's not a bug, it's just no settled history existing yet.
router.get('/stats', async (req, res) => {
  const { sport } = req.query;

  // Excludes picks whose recorded odds fall outside a plausible range —
  // these are corrupted rows from before the suspended-market-placeholder
  // fix in fetchMatches.js (e.g. -10000 odds captured during a book's
  // brief in-play market suspension, not a real price). The pick and its
  // result stay in the database untouched; they're just excluded from
  // these public-facing win-rate/ROI calculations so one bad price snapshot
  // doesn't distort the whole track record.
  //
  // Covers BOTH legacy pick types, de-duplicated per match (see
  // dedupeResultsByMatch). This used to be model-only, which avoided
  // double-counting the legacy duplicate pair but also excluded every
  // below-threshold match — so the published win rate described only the
  // high-conviction subset while the site sold every pick. Now it's the
  // complete record, each match counted once.
  // Fetches ALL THREE markets in one query, then splits them out below.
  // Spread and total picks have been graded correctly all along but had
  // no published accuracy anywhere on the site — sold without a track
  // record. The top-level fields stay moneyline-only (that's the headline
  // number and what every existing caller expects); byMarket carries the
  // per-market breakdown alongside it.
  const allMarketResults = await db.result.findMany({
    where: {
      pick: {
        pickType: { in: ['model', 'winner'] }, // both types, de-duped per match below — see dedupeResultsByMatch
        market: { in: ['moneyline', 'spread', 'total'] },
        // Developing sports don't count toward the published figures.
        ...(sport ? {} : developingSportsFilter(req.query.includeDeveloping === 'true')),
        // Sanity bound only. This used to be ±2000, which was written when
        // corrupted "suspended market" placeholder prices could reach the
        // database. That source was fixed upstream (fetchMatches now
        // validates a market by whether its two sides form a coherent
        // two-way price), so the narrow cap no longer protects anything —
        // it just silently drops legitimate heavy favourites from the
        // published record.
        //
        // It also had to go because the Activity feed doesn't apply it, so
        // the same day's results were counted differently in two places on
        // one screen. Widened to a genuine corruption bound.
        odds: { gte: -100000, lte: 100000 },
        ...(sport ? { match: { sport: { slug: sport } } } : {}),
      },
    },
    include: { pick: { include: { match: true } } },
  });

  // De-dupe WITHIN each market, never across them: one match legitimately
  // has a moneyline pick AND a spread pick AND a total pick, and each is
  // a separate real call that belongs in its own record.
  const resultsByMarket = {
    moneyline: allMarketResults.filter((r) => r.pick.market === 'moneyline'),
    spread: allMarketResults.filter((r) => r.pick.market === 'spread'),
    total: allMarketResults.filter((r) => r.pick.market === 'total'),
  };

  const results = resultsByMarket.moneyline;
  const uniqueResults = dedupeResultsByMatch(results);
  const decided = uniqueResults.filter((r) => r.outcome !== 'push');
  const wins = decided.filter((r) => r.outcome === 'win').length;
  const losses = decided.filter((r) => r.outcome === 'loss').length;
  const winRate = decided.length > 0 ? Math.round((wins / decided.length) * 1000) / 10 : null;

  // Flat $100-stake profit for one American-odds outcome.
  function profitFor(americanOdds, won) {
    if (!won) return -100;
    return americanOdds > 0 ? americanOdds : (10000 / Math.abs(americanOdds));
  }

  let roi = null;
  if (decided.length > 0) {
    const totalProfit = decided.reduce(
      (sum, r) => sum + profitFor(r.pick.odds, r.outcome === 'win'),
      0
    );
    roi = Math.round((totalProfit / (decided.length * 100)) * 1000) / 10;
  }

  // ROI vs. close: for picks where we captured a closing line, compare
  // actual ROI (at the odds when the pick was made) against what ROI
  // would have been at the closing line instead. Positive means the
  // pick's early number beat where the market ended up — the standard
  // "beating the closing line" edge metric.
  const withClosing = decided.filter((r) => {
    const m = r.pick.match;
    return m.closingOddsA !== null && m.closingOddsB !== null;
  });

  let roiVsClose = null;
  if (withClosing.length > 0) {
    let entryTotal = 0;
    let closeTotal = 0;
    for (const r of withClosing) {
      const m = r.pick.match;
      const won = r.outcome === 'win';
      entryTotal += profitFor(r.pick.odds, won);

      const pickedName = r.pick.selection.replace(/\s*ML$/, '').trim();
      const closingOdds = pickedName === m.competitorA ? m.closingOddsA : m.closingOddsB;
      closeTotal += profitFor(closingOdds, won);
    }
    const entryRoi = entryTotal / (withClosing.length * 100);
    const closeRoi = closeTotal / (withClosing.length * 100);
    roiVsClose = Math.round((entryRoi - closeRoi) * 1000) / 10;
  }

  // matches/day: distinct matches with a pick, averaged over the time
  // since the FIRST pick was created — a genuine all-time daily pace,
  // not diluted by a fixed window.
  const allPicks = await db.pick.findMany({
    where: sport ? { match: { sport: { slug: sport } } } : {},
    distinct: ['matchId'],
    select: { matchId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  let matchesPerDay = null;
  if (allPicks.length > 0) {
    const earliestCreatedAt = allPicks[0].createdAt;
    const daysElapsed = Math.max(1, Math.ceil((Date.now() - earliestCreatedAt.getTime()) / (24 * 60 * 60 * 1000)));
    matchesPerDay = Math.round(allPicks.length / daysElapsed);
  }

  const winRows = decided.filter((r) => r.outcome === 'win');
  const avgConfidenceWins = winRows.length > 0
    ? Math.round(winRows.reduce((sum, r) => sum + r.pick.confidence, 0) / winRows.length)
    : null;

  // CURRENT STREAK — computed here rather than on the client, for two
  // real reasons:
  //
  //   1. DETERMINISTIC ORDER. Grading runs in 15-second batches, so a
  //      whole slate of matches often shares an almost identical
  //      settledAt. Sorting on that alone leaves ties in arbitrary
  //      order, and a loss landing ahead of wins that actually finished
  //      after it cuts the streak short. Tie-breaking on the match's own
  //      start time gives a stable, meaningful sequence.
  //   2. SAME DATASET AS THE WIN RATE. The client was reading a
  //      different endpoint that caps at 100 results per sport, so the
  //      two headline numbers could disagree about the same history.
  //
  // Pushes are already excluded from `decided` — they're neutral, so
  // they neither extend nor break a run.
  const ordered = [...decided].sort((a, b) => {
    const bySettled = new Date(b.settledAt) - new Date(a.settledAt);
    if (bySettled !== 0) return bySettled;
    return new Date(b.pick.match.startTime) - new Date(a.pick.match.startTime);
  });

  let streakCount = 0;
  let streakType = null;
  for (const r of ordered) {
    if (streakType === null) { streakType = r.outcome; streakCount = 1; continue; }
    if (r.outcome === streakType) streakCount++;
    else break;
  }

  // Per-market records. Same rules as the moneyline figure above: both
  // legacy pick types, de-duped per match within the market, pushes
  // excluded from the denominator (they're void, not half a loss), and a
  // flat $100-stake ROI. Reported honestly with sampleSize attached —
  // a 67% rate off 6 graded picks means far less than 58% off 200, and
  // spread/total have been graded for much less time than moneyline.
  const byMarket = {};
  for (const [marketName, marketResults] of Object.entries(resultsByMarket)) {
    const uniq = dedupeResultsByMatch(marketResults);
    const marketDecided = uniq.filter((r) => r.outcome !== 'push');
    const marketWins = marketDecided.filter((r) => r.outcome === 'win').length;
    const marketLosses = marketDecided.filter((r) => r.outcome === 'loss').length;
    const marketPushes = uniq.length - marketDecided.length;

    let marketRoi = null;
    if (marketDecided.length > 0) {
      const totalProfit = marketDecided.reduce(
        (sum, r) => sum + profitFor(r.pick.odds, r.outcome === 'win'),
        0
      );
      marketRoi = Math.round((totalProfit / (marketDecided.length * 100)) * 1000) / 10;
    }

    byMarket[marketName] = {
      winRate: marketDecided.length > 0 ? Math.round((marketWins / marketDecided.length) * 1000) / 10 : null,
      wins: marketWins,
      losses: marketLosses,
      pushes: marketPushes,
      sampleSize: marketDecided.length,
      roi: marketRoi,
    };
  }

  res.json({
    winRate,
    roi,
    roiVsClose,
    matchesPerDay,
    sampleSize: decided.length,
    picksLogged: decided.length,
    avgConfidenceWins,
    streakCount: streakType ? streakCount : null,
    streakType, // 'win' | 'loss' | null
    // So the UI can label these rather than hardcoding a list that would
    // drift out of sync with the server.
    developingSports: DEVELOPING_SPORTS,
    byMarket, // { moneyline, spread, total } — each { winRate, wins, losses, pushes, sampleSize, roi }
  });
});

// GET /api/picks/matches-today?sport=tennis — full slate with both sides'
// odds, for the "All Matches" board. Uses closingOddsA/closingOddsB as the
// "current" odds for each side — that field is continuously updated by the
// live-picks loop for every scheduled match (see cron.js), so it's the
// closest thing we have to a live both-sides odds snapshot pre-kickoff.
// The picked side is only ever revealed when the pick is actually unlocked
// — showing which side the model picked for free (even via a highlight
// box with no text) would leak the selection the paywall exists to gate.
router.get('/matches-today', async (req, res) => {
  const { sport } = req.query;
  const { startOfDay, endOfDay } = getTimezoneDayBounds('America/Los_Angeles');

  const matches = await db.match.findMany({
    where: {
      startTime: { gte: startOfDay, lte: endOfDay },
      ...(sport ? { sport: { slug: sport } } : {}),
    },
    include: { sport: true, picks: true },
    orderBy: { startTime: 'asc' },
  });

  const userId = resolveOptionalUser(req);

  const shaped = await Promise.all(
    matches.map(async (m) => {
      const pick = m.picks.find((p) => p.pickType === 'model' && p.market === 'moneyline') || m.picks.find((p) => p.pickType === 'winner' && p.market === 'moneyline') || null;
      const unlocked = pick ? await userHasAccess(userId, pick.id) : false;

      let pickedSide = null;
      if (pick && unlocked) {
        const pickedName = pick.selection.replace(/\s*ML$/, '').trim();
        if (pickedName === m.competitorA) pickedSide = 'A';
        else if (pickedName === m.competitorB) pickedSide = 'B';
      }

      return {
        id: m.id,
        sport: m.sport.slug,
        league: m.league,
        competitorA: m.competitorA,
        competitorB: m.competitorB,
        startTime: m.startTime,
        surface: m.surface,
        oddsA: m.closingOddsA,
        oddsB: m.closingOddsB,
        spread: m.spread,
        spreadOddsA: m.spreadOddsA,
        spreadOddsB: m.spreadOddsB,
        total: m.total,
        overOdds: m.overOdds,
        underOdds: m.underOdds,
        pick: pick
          ? {
              id: pick.id,
              pickType: pick.pickType,
              price: pick.price,
              unlocked,
              pickedSide, // 'A' | 'B' | null — null whenever locked or no pick exists
            }
          : null,
      };
    })
  );

  res.json({ matches: shaped });
});

// GET /api/picks/news?sport=tennis — real ESPN headlines, public (not
// proprietary model output, no reason to gate it). Fetched live on each
// request rather than cached/persisted — news doesn't need model analysis
// or a pipeline schedule, just a pass-through to a real source.
//
// IMPORTANT: this must be registered before GET /:id below — Express
// matches routes in registration order, and /news is a single path
// segment just like :id, so whichever is registered first wins the
// match. Registering it after /:id (a real bug this once had) meant
// every request here got swallowed by the pick-lookup route instead,
// returning "Pick not found" for a lookup on a pick literally named
// "news" — a confusing error with nothing to do with the real cause.
router.get('/news', async (req, res) => {
  const { sport } = req.query;
  if (!sport) {
    return res.status(400).json({ error: 'sport query param is required.' });
  }
  try {
    const articles = await fetchEspnNews(sport);
    res.json({ articles });
  } catch (err) {
    console.error('[picks] /news failed:', err.message);
    res.status(502).json({ error: 'Could not fetch news right now.' });
  }
});

// GET /api/picks/insiders — public. Grouped by sport, ordered. This is
// what the left-side Insiders sidebar fetches on page load.
//
// IMPORTANT: same rule as /news above — must be registered before
// GET /:id, or a request here gets swallowed by the pick-lookup route
// (which would treat "insiders" as a pick ID, find nothing, and return
// a 404 "Pick not found" — exactly the bug this fixes).
router.get('/insiders', async (req, res) => {
  try {
    const rows = await db.insiderAccount.findMany({
      orderBy: [{ sport: 'asc' }, { order: 'asc' }],
    });
    const grouped = {};
    INSIDER_SPORTS.forEach((s) => { grouped[s] = []; });
    rows.forEach((r) => {
      if (!grouped[r.sport]) grouped[r.sport] = [];
      grouped[r.sport].push(r.handle);
    });
    res.json(grouped);
  } catch (err) {
    console.error('[insiders] GET /insiders failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/picks/rankings?sport=tennis — the model's own power rankings.
// Ranks teams/players by the model's REAL data about them: how confident
// the model has been when picking them, and how those picks actually
// graded out. No invented composite score — just honest aggregates
// (times picked, avg confidence, W-L record, win rate), sorted by avg
// confidence. Only frozen pregame picks (model/winner, moneyline) count,
// same rule the Win Rate Tracker uses — live picks evolve mid-game and
// aren't a real prediction to rank anyone by.
//
// IMPORTANT: registered before GET /:id — same Express route-ordering
// rule as /news and /insiders above, or "rankings" gets swallowed as a
// pick id.
router.get('/rankings', async (req, res) => {
  try {
    const { sport } = req.query;

    const picks = await db.pick.findMany({
      where: {
        pickType: { in: ['model', 'winner'] },
        market: 'moneyline',
        ...(sport ? { match: { sport: { slug: sport } } } : {}),
      },
      include: {
        result: true,
        match: { include: { sport: true } },
      },
    });

    const byName = {};
    for (const p of picks) {
      const name = p.selection.replace(/\s*ML$/, '').trim();
      if (!name) continue;
      const key = `${p.match.sport.slug}|${name}`;
      if (!byName[key]) {
        byName[key] = { name, sport: p.match.sport.slug, timesPicked: 0, confidenceSum: 0, wins: 0, losses: 0, pushes: 0 };
      }
      const row = byName[key];
      row.timesPicked++;
      row.confidenceSum += p.confidence;
      if (p.result) {
        if (p.result.outcome === 'win') row.wins++;
        else if (p.result.outcome === 'loss') row.losses++;
        else if (p.result.outcome === 'push') row.pushes++;
      }
    }

    const rankings = Object.values(byName)
      .map((r) => {
        const decided = r.wins + r.losses;
        return {
          name: r.name,
          sport: r.sport,
          timesPicked: r.timesPicked,
          avgConfidence: Math.round(r.confidenceSum / r.timesPicked),
          wins: r.wins,
          losses: r.losses,
          pushes: r.pushes,
          winRate: decided > 0 ? Math.round((r.wins / decided) * 100) : null,
        };
      })
      // avg confidence is the ranking key — it's literally "how the
      // model rates them"; record/win rate are shown alongside as the
      // evidence. Ties break toward the larger sample.
      .sort((a, b) => b.avgConfidence - a.avgConfidence || b.timesPicked - a.timesPicked);

    // Join each team's REAL season record (ESPN standings) onto the
    // model's view of them. Best-effort: tennis has no standings, and a
    // name that doesn't match an ESPN displayName just gets null — the
    // model rankings still render fully without it.
    if (sport && sport !== 'tennis') {
      try {
        const recordMap = await getRecordMap(sport);
        rankings.forEach((r) => {
          const rec = recordMap[r.name];
          r.seasonRecord = rec ? rec.record : null;
          r.seasonLeague = rec ? rec.league : null;
        });
      } catch (err) {
        console.error('[rankings] season record join failed:', err.message);
      }
    }

    res.json({ rankings });
  } catch (err) {
    console.error('[rankings] GET /rankings failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/picks/admin/diagnose?sport=tennis — why isn't this analysed?
//
// Runs the same fetch, normalisation and guards the pipeline uses and
// reports the decision per match. Lives here rather than in a script
// because the database is only reachable from inside Railway, and
// chasing tunnels and public URLs to answer a yes/no question wastes
// more time than it saves.
//
// Read-only: no picks created, no Anthropic credit spent.
router.get('/admin/diagnose', requireAuth, async (req, res) => {
  try {
    const user = await db.user.findUnique({ where: { id: req.userId } });
    if (!user || !isAdminEmail(user.email)) return res.status(403).json({ error: 'Admin access required.' });

    const sport = req.query.sport || 'tennis';
    const MAX_CYCLE_FAILURES = 3;
    // ?day=tomorrow — the pregame pipeline can be run manually for the
    // next day, so the diagnostic has to be able to look at that window
    // too. Otherwise "I ran it for tomorrow and nothing happened" is
    // unanswerable.
    const dayOffset = req.query.day === 'tomorrow' ? 1 : 0;

    const matches = await fetchMatches(sport);
    const sample = matches[0] || {};
    const build = {
      // If these are false, the bookmaker-fallback build isn't deployed
      // and that alone explains everything below.
      oddsBookFieldPresent: Object.prototype.hasOwnProperty.call(sample, 'oddsBook'),
      bookCountFieldPresent: Object.prototype.hasOwnProperty.call(sample, 'bookCount'),
    };

    const base = getTimezoneDayBounds('America/Los_Angeles');
    const startOfDay = new Date(base.startOfDay.getTime() + dayOffset * 86400000);
    const endOfDay = new Date(base.endOfDay.getTime() + dayOffset * 86400000);
    const today = matches.filter((m) => {
      const t = new Date(m.startTime).getTime();
      return t >= startOfDay.getTime() && t < endOfDay.getTime();
    });

    const rows = [];
    const tally = {};
    for (const m of today) {
      const match = await db.match.findUnique({
        where: { externalId: m.externalId },
        // ALL picks, unfiltered. The board attaches picks with a narrower
        // filter than this diagnostic used, so "analysed" here and
        // "analysed" on screen could disagree — which is exactly the
        // situation this is meant to explain rather than reproduce.
        include: { picks: true },
      });

      // Mirror the board's own filter exactly: /today only attaches picks
      // that are pickType model/winner/live AND market 'moneyline'. A
      // match can hold a spread or total pick and still render as
      // "Awaiting Analysis" if no moneyline pick exists.
      const boardVisiblePicks = (match?.picks || []).filter(
        (pk) => ['model', 'winner', 'live'].includes(pk.pickType) && pk.market === 'moneyline'
      );

      let verdict;
      if (!match) verdict = 'NOT_IN_DB';
      else if (boardVisiblePicks.length > 0) verdict = 'OK_ALREADY_ANALYSED';
      else if (match.picks.length > 0) verdict = 'HAS_PICKS_BUT_NONE_THE_BOARD_SHOWS';
      else if (match.skipAnalysis) verdict = 'BLOCKED_SKIP_FLAG';
      else if (m.oddsA === null || m.oddsB === null) {
        verdict = (m.bookCount ?? 0) === 0 ? 'BLOCKED_NO_BOOK_PRICES_IT' : 'BLOCKED_BOOKS_PRESENT_BUT_UNUSABLE';
      } else if (match.analysisFailCycles >= MAX_CYCLE_FAILURES) {
        verdict = `BLOCKED_FAIL_CYCLES_${match.analysisFailCycles}`;
      } else {
        verdict = 'SHOULD_ANALYSE';
      }
      tally[verdict] = (tally[verdict] || 0) + 1;

      rows.push({
        matchup: `${m.competitorA} vs ${m.competitorB}`,
        oddsA: m.oddsA, oddsB: m.oddsB,
        oddsBook: m.oddsBook ?? null,
        bookCount: m.bookCount ?? null,
        inDb: !!match,
        skipAnalysis: match?.skipAnalysis ?? null,
        failCycles: match?.analysisFailCycles ?? null,
        // Every pick on this match, so a mismatch between "analysed" and
        // what the board shows is visible rather than inferred.
        picks: (match?.picks || []).map((pk) => `${pk.pickType}/${pk.market}`),
        matchStatus: match?.status ?? null,
        matchStartTime: match?.startTime ?? null,
        verdict,
      });
    }

    // DUPLICATE FIXTURES.
    //
    // Everything above looks up matches by externalId, i.e. whatever the
    // odds feed currently calls them. The BOARD queries the database by
    // date instead. If the same fixture exists twice — the provider
    // reissued an event id, or the match moved between tournament keys
    // (qualifying vs main draw) — the pipeline analyses one row while the
    // board renders the other, and it shows "Awaiting Analysis" for a
    // match that is demonstrably analysed. That's invisible to every
    // check above, because they never see the orphaned row.
    const dbMatches = await db.match.findMany({
      where: {
        startTime: { gte: startOfDay, lte: endOfDay },
        ...(sport ? { sport: { slug: sport } } : {}),
      },
      include: { picks: { where: { market: 'moneyline', pickType: { in: ['model', 'winner', 'live'] } } } },
    });

    const byFixture = new Map();
    for (const dm of dbMatches) {
      const key = `${dm.competitorA} vs ${dm.competitorB}`.toLowerCase();
      if (!byFixture.has(key)) byFixture.set(key, []);
      byFixture.get(key).push({
        externalId: dm.externalId,
        sportKey: dm.sportKey,
        status: dm.status,
        startTime: dm.startTime,
        moneylinePicks: dm.picks.length,
      });
    }
    const duplicates = [...byFixture.entries()]
      .filter(([, v]) => v.length > 1)
      .map(([matchup, entries]) => ({ matchup, entries }));

    res.json({
      sport,
      day: dayOffset ? 'tomorrow' : 'today',
      window: { from: startOfDay, to: endOfDay },
      build,
      fetched: matches.length,
      startingInWindow: today.length,
      // What the BOARD actually queries — if this exceeds startingInWindow,
      // the extra rows are what's rendering as unanalysed.
      matchesInDatabaseWindow: dbMatches.length,
      databaseRowsWithNoMoneylinePick: dbMatches.filter((dm) => dm.picks.length === 0).length,
      duplicateFixtures: duplicates.length,
      duplicates: duplicates.slice(0, 10),
      tally,
      rows,
    });
  } catch (err) {
    console.error('[diagnose] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/picks/admin/loss-review?sport=&minConfidence= — why do picks lose?
//
// Every pick stores the factors the model actually cited. Individually
// those explain one match; aggregated across hundreds of graded results
// they show which reasoning holds up and which doesn't.
//
// Three losses in a day is noise at a 70% hit rate. This is the view that
// can tell the difference between a bad run and a real pattern, because
// it's computed over the whole record rather than the last thing that hurt.
router.get('/admin/loss-review', requireAuth, async (req, res) => {
  try {
    const user = await db.user.findUnique({ where: { id: req.userId } });
    if (!user || !isAdminEmail(user.email)) return res.status(403).json({ error: 'Admin access required.' });

    const sport = req.query.sport && req.query.sport !== 'all' ? req.query.sport : null;
    const minConfidence = Number(req.query.minConfidence) || 0;

    const results = await db.result.findMany({
      where: {
        outcome: { in: ['win', 'loss'] },
        pick: {
          market: 'moneyline',
          pickType: { in: ['model', 'winner'] },
          confidence: { gte: minConfidence },
          ...(sport ? { match: { sport: { slug: sport } } } : {}),
        },
      },
      include: { pick: { include: { match: { include: { sport: true } } } } },
      orderBy: { settledAt: 'desc' },
    });

    const unique = dedupeResultsByMatch(results);

    // Accuracy grouped by the FACTOR LABELS the model cited. A label that
    // appears far more often in losses than wins is reasoning that isn't
    // carrying its weight.
    const byFactor = {};
    // And by league — "our tennis is 75%" can hide a league inside it that
    // is well under water.
    const byLeague = {};

    for (const r of unique) {
      const won = r.outcome === 'win';
      const league = r.pick.match.league || r.pick.match.sport.slug;
      byLeague[league] = byLeague[league] || { wins: 0, losses: 0 };
      byLeague[league][won ? 'wins' : 'losses']++;

      let factors = [];
      try { factors = JSON.parse(r.pick.factsUsed || '[]'); } catch { factors = []; }
      // Same canonicalisation the weight model uses. Without it the same
      // concept splits across several labels and nothing ever reaches a
      // readable sample.
      const labels = new Set(
        (Array.isArray(factors) ? factors : [])
          .map((f) => canonicalLabel(f && f.label))
          .filter(Boolean)
      );
      for (const label of labels) {
        byFactor[label] = byFactor[label] || { wins: 0, losses: 0 };
        byFactor[label][won ? 'wins' : 'losses']++;
      }
    }

    const shape = (obj, minSample) => Object.entries(obj)
      .map(([k, v]) => ({
        name: k, wins: v.wins, losses: v.losses, n: v.wins + v.losses,
        winRate: Math.round((v.wins / (v.wins + v.losses)) * 100),
      }))
      // Small samples produce meaningless extremes — a 0% on two picks
      // isn't a finding, and surfacing it invites exactly the overfitting
      // this view is meant to prevent.
      .filter((x) => x.n >= minSample)
      .sort((a, b) => a.winRate - b.winRate);

    // Weight alongside measured performance, so the assumed weighting can
    // be checked against what actually happened. A factor weighted 16 that
    // performs below the overall baseline across a real sample is the
    // clearest signal available that the weight is wrong.
    // Live, data-derived weights — the same ones the analyst prompt uses.
    const wk = await getWeights(sport || 'tennis');
    const weights = wk.weights || {};
    const factorRows = shape(byFactor, 15).map((f) => ({
      ...f,
      weight: weights[f.name] ?? null,
      vsBaseline: unique.length
        ? f.winRate - Math.round((unique.filter((r) => r.outcome === 'win').length / unique.length) * 100)
        : null,
    }));

    res.json({
      weights,
      weightSource: wk.source,       // 'measured' | 'seed' — never let an assumed
      weightDetail: wk.detail || [], // weight be mistaken for a measured one
      graded: unique.length,
      overallWinRate: unique.length
        ? Math.round((unique.filter((r) => r.outcome === 'win').length / unique.length) * 100)
        : null,
      byLeague: shape(byLeague, 8),
      byFactor: factorRows,
      recentLosses: unique.filter((r) => r.outcome === 'loss').slice(0, 25).map((r) => {
        let factors = [];
        try { factors = JSON.parse(r.pick.factsUsed || '[]'); } catch { factors = []; }
        return {
          matchup: `${r.pick.match.competitorA} vs ${r.pick.match.competitorB}`,
          league: r.pick.match.league,
          selection: r.pick.selection,
          confidence: r.pick.confidence,
          odds: r.pick.odds,
          settledAt: r.settledAt,
          factors: (Array.isArray(factors) ? factors : []).map((f) => ({ label: f.label, tag: f.tag, body: f.body })),
        };
      }),
    });
  } catch (err) {
    console.error('[admin/loss-review] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/picks/admin/reanalyze  { sport, limit, dryRun }
//
// Re-runs analysis on upcoming matches that already have a pick, so the
// queue reflects the current model after a process change.
//
// dryRun defaults to TRUE. Each match is a paid research call, so the
// count is reported before anything is spent — an accidental full-slate
// re-run is real money.
router.post('/admin/reanalyze', requireAuth, async (req, res) => {
  try {
    const user = await db.user.findUnique({ where: { id: req.userId } });
    if (!user || !isAdminEmail(user.email)) return res.status(403).json({ error: 'Admin access required.' });

    const { sport = 'tennis', limit = 50, dryRun = true, mode = 'existing' } = req.body || {};
    const result = await reanalyzeUpcoming(sport, {
      limit: Math.min(Number(limit) || 50, 200),
      dryRun: dryRun !== false,
      mode: mode === 'missing' ? 'missing' : 'existing',
    });
    res.json(result);
  } catch (err) {
    console.error('[admin/reanalyze] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/picks/admin/reset-sport-results  { sport, confirm }
//
// Deletes graded results for one sport, so its win rate starts from zero.
// The picks and matches stay; only the Result rows go, which is what the
// win rate, streak and equity curve are computed from.
//
// Irreversible. Requires an explicit confirm matching the sport slug so a
// stray request can't wipe a record.
router.post('/admin/reset-sport-results', requireAuth, async (req, res) => {
  try {
    const user = await db.user.findUnique({ where: { id: req.userId } });
    if (!user || !isAdminEmail(user.email)) return res.status(403).json({ error: 'Admin access required.' });

    const { sport, confirm } = req.body || {};
    if (!sport) return res.status(400).json({ error: 'sport is required.' });
    if (confirm !== sport) {
      return res.status(400).json({ error: `Pass confirm:"${sport}" to proceed — this permanently deletes graded results.` });
    }

    const sportRow = await db.sport.findUnique({ where: { slug: sport } });
    if (!sportRow) return res.status(404).json({ error: `Unknown sport: ${sport}` });

    const deleted = await db.result.deleteMany({
      where: { pick: { match: { sportId: sportRow.id } } },
    });

    console.log(`[admin] reset ${deleted.count} graded result(s) for ${sport} (by ${user.email}).`);
    res.json({ sport, deletedResults: deleted.count });
  } catch (err) {
    console.error('[admin/reset-sport-results] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/picks/admin/winners?sport=&day= — the model's predicted winner
// for every analysed match, admin only.
//
// This is the "winner picks" view from the original framework: not a
// recommended-bet list, just who the model thinks wins each match, across
// the whole slate. Kept behind the admin gate deliberately — it's an
// internal accuracy check, and publishing a call on every match invites
// judging the model on games it never claimed an edge on.
//
// Graded results are attached where they exist, so the same screen shows
// what was predicted and what happened.
router.get('/admin/winners', requireAuth, async (req, res) => {
  try {
    const user = await db.user.findUnique({ where: { id: req.userId } });
    if (!user || !isAdminEmail(user.email)) return res.status(403).json({ error: 'Admin access required.' });

    const sport = req.query.sport && req.query.sport !== 'all' ? req.query.sport : null;
    const dayOffset = req.query.day === 'tomorrow' ? 1 : req.query.day === 'yesterday' ? -1 : 0;

    // HIGH-CONVICTION ONLY. This view is for calls the model actually
    // stands behind, not a print-out of every match.
    //
    // Two separate filters, because they exclude different things:
    //   - minConfidence removes matches the model isn't sure about.
    //   - maxOdds removes LONGSHOTS. A pick can carry high confidence and
    //     still be priced +400, which means the market strongly disagrees;
    //     those are exactly the picks that don't belong on a "winners"
    //     list even when the model likes them.
    // Both are query-tunable so the thresholds can be tested rather than
    // baked in.
    const minConfidence = Number(req.query.minConfidence) || 65;
    const maxOdds = req.query.maxOdds !== undefined ? Number(req.query.maxOdds) : 110;

    // CONVICTION is the primary filter now. The model classifies each call
    // as strong / lean / guess based on the quality of information it
    // actually found, which a confidence number can't express — a 68%
    // built on real injury news and a 68% built on nothing but ranking
    // look identical otherwise.
    //
    // Default 'strong' only: this view is the model separating calls it
    // stands behind from ones it was forced to make. Legacy picks created
    // before this field existed have conviction null and are excluded,
    // rather than being assumed strong.
    // Price band, so the whole day's heavy favourites can be pulled up as
    // a group — the set worth shopping hardest for, since at -250 the
    // required win rate is ~71% and every point of price matters.
    const band = req.query.band || 'all';
    const bandFilter = band === 'heavy' ? { odds: { lte: -200 } }
      : band === 'favourites' ? { odds: { lte: -125 } }
      : band === 'shortish' ? { odds: { lte: -125, gte: -249 } }
      : {};

    const conviction = req.query.conviction || 'strong';
    const convictionFilter = conviction === 'all'
      ? {}
      : conviction === 'strong+lean'
        ? { conviction: { in: ['strong', 'lean'] } }
        : { conviction };
    const base = getTimezoneDayBounds('America/Los_Angeles');
    const startOfDay = new Date(base.startOfDay.getTime() + dayOffset * 86400000);
    const endOfDay = new Date(base.endOfDay.getTime() + dayOffset * 86400000);

    const matches = await db.match.findMany({
      where: {
        startTime: { gte: startOfDay, lte: endOfDay },
        ...(sport ? { sport: { slug: sport } } : {}),
        picks: {
          some: {
            pickType: { in: ['model', 'winner'] },
            market: 'moneyline',
            confidence: { gte: minConfidence },
            odds: { lte: maxOdds },
            ...convictionFilter,
            ...bandFilter,
          },
        },
      },
      include: {
        sport: true,
        picks: {
          where: {
            pickType: { in: ['model', 'winner'] },
            market: 'moneyline',
            confidence: { gte: minConfidence },
            odds: { lte: maxOdds },
            ...convictionFilter,
            ...bandFilter,
          },
          include: { result: true },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { startTime: 'asc' },
    });

    const rows = matches.map((m) => {
      const pick = m.picks[0];
      const result = pick?.result || null;
      return {
        matchId: m.id,
        sport: m.sport.slug,
        league: m.league,
        matchup: `${m.competitorA} vs ${m.competitorB}`,
        startTime: m.startTime,
        status: m.status,
        predictedWinner: pick?.selection ?? null,
        conviction: pick?.conviction ?? null,
        confidence: pick?.confidence ?? null,
        odds: pick?.odds ?? null,
        // BEST AVAILABLE PRICE for the side actually picked.
        //
        // This was reading bestBookA unconditionally — side A's book even
        // when the model picked side B, which made the whole column
        // useless for the one thing it's for: knowing where to get the
        // number. Resolved against the selection instead.
        //
        // recordedOdds is the price the pick was logged at; bestOdds is
        // the best across every book right now. The gap between them is
        // the money left on the table by not shopping.
        ...(function () {
          const pickedA = pick && pick.selection.startsWith(m.competitorA);
          const bestOdds = pickedA ? m.bestOddsA : m.bestOddsB;
          const bestBook = pickedA ? m.bestBookA : m.bestBookB;
          const profitPer100 = (o) => (o > 0 ? o : (100 / Math.abs(o)) * 100);
          const gain = (typeof bestOdds === 'number' && typeof pick?.odds === 'number')
            ? Math.round(profitPer100(bestOdds) - profitPer100(pick.odds))
            : null;
          return { bestOdds: bestOdds ?? null, bestBook: bestBook ?? null, shopGain: gain };
        })(),
        // What actually happened, when it's known.
        outcome: result?.outcome ?? null,
        actualWinner: m.homeScore !== null && m.awayScore !== null
          ? (m.homeScore > m.awayScore ? m.competitorA : m.awayScore > m.homeScore ? m.competitorB : null)
          : null,
        homeScore: m.homeScore,
        awayScore: m.awayScore,
      };
    });

    const decided = rows.filter((r) => r.outcome === 'win' || r.outcome === 'loss');
    const correct = decided.filter((r) => r.outcome === 'win').length;

    res.json({
      day: dayOffset === 1 ? 'tomorrow' : dayOffset === -1 ? 'yesterday' : 'today',
      filters: { minConfidence, maxOdds, conviction, band },
      total: rows.length,
      graded: decided.length,
      correct,
      // Straight hit rate on graded matches — no odds weighting. This is an
      // accuracy check, not a profitability one; ROI lives on the Win Rate
      // Tracker where the prices are.
      accuracy: decided.length ? Math.round((correct / decided.length) * 100) : null,
      rows,
    });
  } catch (err) {
    console.error('[admin/winners] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/picks/admin/diagnose-live — why isn't the live meter moving?
//
// Walks the exact gates updateLivePicksForSport walks, in order, and
// reports which one each live match stops at. Read-only.
router.get('/admin/diagnose-live', requireAuth, async (req, res) => {
  try {
    const user = await db.user.findUnique({ where: { id: req.userId } });
    if (!user || !isAdminEmail(user.email)) return res.status(403).json({ error: 'Admin access required.' });

    const sport = req.query.sport || 'tennis';
    const liveOddsSports = (process.env.LIVE_ODDS_SPORTS || 'tennis').split(',').map((x) => x.trim());

    const config = {
      LIVE_ODDS_SPORTS: liveOddsSports,
      sportIsCovered: liveOddsSports.includes(sport),
      LIVE_PIPELINE_INTERVAL_MS: process.env.LIVE_PIPELINE_INTERVAL_MS || '(unset — defaults to 900000, i.e. 15 minutes)',
      LIVE_REACTIVE_COOLDOWN_MS: process.env.LIVE_REACTIVE_COOLDOWN_MS || '(unset — defaults to 45000)',
    };

    // Gate 1: does the DATABASE think anything is live?
    const liveDb = await db.match.findMany({
      where: { sport: { slug: sport }, status: { in: ['live', 'in_progress'] } },
      include: { picks: { where: { pickType: 'live', market: 'moneyline' }, take: 1 } },
    });

    // Gate 2: does the odds provider still return those matches, with prices?
    let fetched = [];
    let fetchError = null;
    try {
      fetched = await fetchMatches(sport);
    } catch (err) {
      fetchError = err.message;
    }
    const byExternalId = new Map(fetched.map((m) => [m.externalId, m]));

    const now = Date.now();
    const rows = liveDb.map((match) => {
      const m = byExternalId.get(match.externalId);
      const livePick = match.picks[0] || null;
      const ageSec = livePick ? Math.round((now - new Date(livePick.updatedAt).getTime()) / 1000) : null;

      let stopsAt;
      if (!config.sportIsCovered) stopsAt = 'SPORT_NOT_IN_LIVE_ODDS_SPORTS';
      else if (!m) stopsAt = 'ODDS_PROVIDER_NO_LONGER_LISTS_THIS_MATCH';
      else if (m.oddsA === null || m.oddsB === null) {
        stopsAt = (m.bookCount ?? 0) === 0 ? 'MARKET_CLOSED_NO_BOOKS' : 'BOOKS_PRESENT_BUT_NO_USABLE_PRICE';
      } else if (!livePick) stopsAt = 'NO_LIVE_PICK_YET_WILL_BE_CREATED';
      else stopsAt = 'SHOULD_BE_UPDATING';

      return {
        matchup: `${match.competitorA} vs ${match.competitorB}`,
        dbStatus: match.status,
        inOddsFeed: !!m,
        oddsA: m?.oddsA ?? null,
        oddsB: m?.oddsB ?? null,
        oddsBook: m?.oddsBook ?? null,
        bookCount: m?.bookCount ?? null,
        livePickConfidence: livePick?.confidence ?? null,
        livePickOdds: livePick?.odds ?? null,
        // The number that actually answers the question.
        secondsSinceLivePickUpdated: ageSec,
        stopsAt,
      };
    });

    const tally = {};
    rows.forEach((r) => { tally[r.stopsAt] = (tally[r.stopsAt] || 0) + 1; });

    res.json({ sport, config, liveInDatabase: liveDb.length, fetchedFromProvider: fetched.length, fetchError, tally, rows });
  } catch (err) {
    console.error('[diagnose-live] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/picks/timing/:pickId — "should I bet this now, or wait?"
//
// This is the honest version of that question. It does NOT predict where
// a line is going: nothing here has the data to do that, and a confident
// forecast built on a few hours of history would be a guess dressed up as
// a signal. What it CAN say truthfully is where the current price sits
// within everything we've actually observed for this match, and what line
// shopping is worth right now.
//
// Registered before GET /:id — same route-ordering rule as /rankings.
router.get('/timing/:pickId', async (req, res) => {
  try {
    const pick = await db.pick.findUnique({
      where: { id: req.params.pickId },
      include: { match: true },
    });
    if (!pick) return res.status(404).json({ error: 'Pick not found.' });

    const history = await db.oddsSnapshot.findMany({
      where: { matchId: pick.matchId },
      orderBy: { capturedAt: 'asc' },
    });

    // Which side is the pick on? Everything below is from that side's
    // perspective — a price that's "good" for one side is bad for the other.
    const sideIsA = pick.selection.startsWith(pick.match.competitorA);
    const seriesBest = history.map((h) => (sideIsA ? h.bestOddsA : h.bestOddsB)).filter((v) => typeof v === 'number');
    const seriesBook = history.map((h) => (sideIsA ? h.bookOddsA : h.bookOddsB)).filter((v) => typeof v === 'number');

    if (seriesBest.length < 2) {
      return res.json({
        status: 'insufficient_history',
        message: 'Not enough price history yet for this match.',
        samples: seriesBest.length,
      });
    }

    const latest = history[history.length - 1];
    const currentBest = sideIsA ? latest.bestOddsA : latest.bestOddsB;
    const currentBook = sideIsA ? latest.bookOddsA : latest.bookOddsB;
    const bestBook = sideIsA ? latest.bestBookA : latest.bestBookB;

    // Higher American odds always pay more for the same stake, either
    // side of zero, so max is simply the best price seen.
    const observedBest = Math.max(...seriesBest);
    const observedWorst = Math.min(...seriesBest);
    const range = observedBest - observedWorst;

    // Where the current price sits in the observed range, 0 (worst seen)
    // to 100 (best seen). A flat market gives 100 — there's been nothing
    // better, so now is as good as it's been.
    const pricePosition = range === 0 ? 100 : Math.round(((currentBest - observedWorst) / range) * 100);

    // What line shopping is worth at this instant, in profit per $100.
    const profitPer100 = (odds) => (odds > 0 ? odds : (100 / Math.abs(odds)) * 100);
    const shoppingGain = (typeof currentBest === 'number' && typeof currentBook === 'number')
      ? Math.round(profitPer100(currentBest) - profitPer100(currentBook))
      : null;

    // Deliberately conservative language. "Good spot" is a statement
    // about the observed range, not a prediction; "has been better"
    // reports a fact rather than advising someone to wait for a price
    // that may never return.
    let verdict;
    if (pricePosition >= 85) verdict = 'at_or_near_best';
    else if (pricePosition >= 55) verdict = 'mid_range';
    else verdict = 'below_recent';

    res.json({
      status: 'ok',
      selection: pick.selection,
      currentBest,
      currentBook,
      bestBook,
      shoppingGain,        // extra $ per $100 staked from taking the best book
      observedBest,
      observedWorst,
      pricePosition,       // 0-100 within the observed range
      verdict,
      samples: seriesBest.length,
      firstSeenAt: history[0].capturedAt,
      lastSeenAt: latest.capturedAt,
    });
  } catch (err) {
    console.error('[timing] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/picks/standings?sport=basketball — real league standings
// (ESPN), grouped by league (soccer spans several; basketball returns
// NBA + WNBA groups). Server-cached 6h in the adapter. Tennis returns
// an empty list honestly — tours use rankings, not standings, and that
// data isn't wired up.
//
// Registered before GET /:id — same route-ordering rule as /rankings.
router.get('/standings', async (req, res) => {
  try {
    const { sport } = req.query;
    if (!sport) return res.status(400).json({ error: 'sport query param is required.' });
    const groups = await getStandings(sport);
    res.json({ groups });
  } catch (err) {
    console.error('[standings] GET /standings failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/picks/insiders/feed?sport=tennis — server-cached recent posts
// per curated account, replacing the client-side X embed widget. Only
// this backend's single IP ever calls X directly (via fetchXTimeline.js,
// cached 20 min per handle) — visitors' browsers never talk to X at
// all anymore, so they can never be individually rate-limited by it,
// which is exactly what kept happening with the client-side widget
// approach under real repeated testing.
router.get('/insiders/feed', async (req, res) => {
  try {
    const { sport } = req.query;
    if (!sport || !INSIDER_SPORTS.includes(sport)) {
      return res.status(400).json({ error: 'valid sport query param is required.' });
    }
    const rows = await db.insiderAccount.findMany({
      where: { sport },
      orderBy: { order: 'asc' },
    });
    const accounts = await Promise.all(
      rows.map(async (r) => {
        const { posts, stale } = await getRecentPosts(r.handle);
        return { handle: r.handle, posts, stale };
      })
    );
    res.json({ accounts });
  } catch (err) {
    console.error('[insiders] GET /insiders/feed failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/picks/:id — full detail, requires purchase or active subscription
router.get('/:id', async (req, res) => {
  const pick = await db.pick.findUnique({
    where: { id: req.params.id },
    include: { match: { include: { sport: true } }, result: true },
  });
  if (!pick) return res.status(404).json({ error: 'Pick not found.' });

  // Once a pick is settled (the match is over and it's been graded),
  // there's no competitive value left to protect by hiding it — the
  // whole point of a public results archive is to prove the track record,
  // which doesn't work if clicking into a past result just hits a
  // paywall. Only still-upcoming picks require a purchase/subscription.
  const isSettled = pick.result !== null;
  const userId = resolveOptionalUser(req);
  const unlocked = isSettled || (await userHasAccess(userId, pick.id));

  if (!unlocked) {
    return res.status(402).json({ error: 'This pick has not been purchased or unlocked by a subscription.' });
  }

  let factsUsed = [];
  try {
    factsUsed = pick.factsUsed ? JSON.parse(pick.factsUsed) : [];
  } catch (e) {
    factsUsed = []; // malformed/legacy row — degrade gracefully rather than error the whole request
  }

  res.json({
    id: pick.id,
    matchId: pick.matchId,
    sport: pick.match.sport.slug,
    league: pick.match.league,
    matchup: `${pick.match.competitorA} vs ${pick.match.competitorB}`,
    competitorA: pick.match.competitorA,
    competitorB: pick.match.competitorB,
    startTime: pick.match.startTime,
    surface: pick.match.surface,
    matchStatus: pick.match.status,
    analyzedAt: pick.createdAt,
    homeScore: pick.match.homeScore,
    awayScore: pick.match.awayScore,
    setScore: pick.match.setScore, // tennis only
    spread: pick.match.spread,
    spreadOddsA: pick.match.spreadOddsA,
    spreadOddsB: pick.match.spreadOddsB,
    total: pick.match.total,
    overOdds: pick.match.overOdds,
    underOdds: pick.match.underOdds,
    selection: pick.selection,
    confidence: pick.confidence,
    odds: pick.odds,
    rationale: pick.rationale,
    factsUsed,
    result: pick.result ? pick.result.outcome : null,
  });
});

// GET /api/results?sport=tennis — settled picks archive (public)
router.get('/archive/results', async (req, res) => {
  const { sport } = req.query;

  // Same scoping as /stats — see the comment there. Keeps corrupted
  // -10000-style placeholder-odds rows out of the public archive without
  // deleting the underlying data, and de-duplicates the legacy
  // model/winner pair so no match appears twice.
  // NOTE: ?recent=true is still accepted (the Activity feed sends it) but
  // no longer changes anything. It used to relax the odds filter, which
  // meant the Activity feed and the Win Rate Tracker counted the same
  // day's results differently — the feed showed picks the tracker had
  // silently excluded. One scoping for every caller now, so the numbers
  // on screen can't disagree.

  const results = await db.result.findMany({
    where: {
      pick: {
        pickType: { in: ['model', 'winner'] }, // de-duped per match below
        market: 'moneyline', // keep spread/total picks out of the moneyline archive — same reasoning as /stats
        // Per-sport callers (the tracker's own table) pass
        // includeDeveloping=true so those sports stay visible there,
        // labelled, while the headline figures exclude them.
        ...(sport ? {} : developingSportsFilter(req.query.includeDeveloping === 'true')),
        // Identical bound in both modes — recent mode used to skip this
        // entirely, which is exactly why the Activity feed and the Win
        // Rate Tracker reported different totals for the same day.
        odds: { gte: -100000, lte: 100000 },
        ...(sport ? { match: { sport: { slug: sport } } } : {}),
      },
    },
    include: { pick: { include: { match: { include: { sport: true } } } } },
    orderBy: { settledAt: 'desc' },
    // Was 100 — but this endpoint is read PER SPORT, so a sport with more
    // than 100 graded picks was silently truncated. The Win Rate Tracker
    // sums these five calls, so its all-time figure drifted below the
    // uncapped one on /stats and the two disagreed on screen. Raised well
    // past any realistic single-sport history while still bounded.
    take: 1000,
  });

  // Always one row per match, newest first — never the legacy duplicate pair.
  const shapedResults = dedupeResultsByMatch(results)
    .sort((a, b) => new Date(b.settledAt) - new Date(a.settledAt));

  res.json({
    results: shapedResults.map((r) => ({
      id: r.pick.id,
      date: r.settledAt,
      matchup: `${r.pick.match.competitorA} vs ${r.pick.match.competitorB}`,
      sport: r.pick.match.sport.slug,
      league: r.pick.match.league,
      pickType: r.pick.pickType,
      market: r.pick.market, // exposed so the client can assert what it's plotting rather than trusting an invisible server-side filter
      selection: r.pick.selection,
      confidence: r.pick.confidence,
      odds: r.pick.odds,
      outcome: r.outcome,
    })),
  });
});

// GET /api/picks/admin/health — pipeline status at a glance: last
// successful run per sport, ESPN poll error counts, analysis retry/
// failure counts, recent errors. Gated behind requireAuth AND the same
// admin email check the /auth/me bypass uses — this reveals internal
// operational detail (error messages, run timing) that shouldn't be
// public, even to a paying non-admin subscriber.
router.get('/admin/health', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  res.json(getHealthSnapshot());
});

// GET /api/picks/admin/pending — real matches that exist (already
// fetched/upserted by the pipeline) but don't have a real pick yet.
// Deliberately NOT a fake "pending" Pick row — that would risk leaking
// into stats/grading logic if a filter was ever missed somewhere. This
// is a genuinely separate, read-only view straight off Match, showing
// exactly what's waiting or stuck (including the real cross-cycle
// failure count) without touching the pick system at all.
router.get('/admin/pending', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { startOfDay, endOfDay } = getTimezoneDayBounds('America/Los_Angeles');
  const matches = await db.match.findMany({
    where: {
      startTime: { gte: startOfDay, lt: endOfDay },
      status: { in: ['scheduled', 'live'] },
      skipAnalysis: false,
    },
    include: {
      sport: true,
      picks: { where: { pickType: { in: ['model', 'winner'] } }, take: 1 },
    },
    orderBy: { startTime: 'asc' },
  });

  const pending = matches
    .filter((m) => m.picks.length === 0)
    .map((m) => ({
      id: m.id,
      sport: m.sport.slug,
      matchup: `${m.competitorA} vs ${m.competitorB}`,
      league: m.league,
      startTime: m.startTime,
      status: m.status,
      hasOdds: m.oddsA !== null && m.oddsB !== null,
      analysisFailCycles: m.analysisFailCycles,
    }));

  res.json({ pending });
});

// GET /api/picks/admin/player-props?matchId=X — real raw prop lines for
// one basketball match, fetched on-demand (not automatically, not for
// every match) given the per-event API cost. Admin-only, same reasoning
// as /admin/health: this is a "coming soon" feature under real
// construction, not something to expose to paying subscribers yet —
// especially since there's no analysis or grading behind it at all,
// just raw lines.
router.get('/admin/player-props', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { matchId } = req.query;
  if (!matchId) {
    return res.status(400).json({ error: 'matchId query param is required.' });
  }

  const match = await db.match.findUnique({ where: { id: matchId } });
  if (!match) {
    return res.status(404).json({ error: 'Match not found.' });
  }

  const props = await fetchBasketballPlayerProps(match);
  res.json({
    matchup: `${match.competitorA} vs ${match.competitorB}`,
    league: match.league,
    props,
  });
});

// Real concurrency cap for props analysis — this runs automatically for
// every player the moment the Props & Fantasy tab opens (per explicit
// product decision), which means a match with several players showing
// props could otherwise fire many simultaneous Claude calls at once.
// Same defensive pattern as the pregame pipeline's MAX_CONCURRENT_ANALYSIS
// in cron.js, scoped separately here since this is a distinct, on-demand
// feature rather than the scheduled pipeline.
const MAX_CONCURRENT_PROPS_ANALYSIS = 3;
let activePropsAnalysisCount = 0;
const propsAnalysisQueue = [];

function acquirePropsAnalysisSlot() {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (activePropsAnalysisCount < MAX_CONCURRENT_PROPS_ANALYSIS) {
        activePropsAnalysisCount++;
        resolve();
      } else {
        propsAnalysisQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

function releasePropsAnalysisSlot() {
  activePropsAnalysisCount--;
  const next = propsAnalysisQueue.shift();
  if (next) next();
}

// POST /api/picks/admin/analyze-props — real confidence-scored verdicts
// for one player's full set of prop lines, in a single call. Body:
// { playerName, team, opponent, sport, propLines: [...] } — propLines
// comes straight from the raw /admin/player-props response, grouped by
// player on the frontend. Admin-only, real cost per call (one Claude
// request covering all of this player's markets at once — see
// propsAnalyst.js for why it's structured this way).
router.post('/admin/analyze-props', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { playerName, team, opponent, sport, propLines, matchId } = req.body || {};
  if (!playerName || !team || !opponent || !matchId || !Array.isArray(propLines) || propLines.length === 0) {
    return res.status(400).json({ error: 'playerName, team, opponent, matchId, and a non-empty propLines array are required.' });
  }

  await acquirePropsAnalysisSlot();
  try {
    const results = await analyzePlayerProps({ playerName, team, opponent, sport: sport || 'basketball', propLines });
    if (!results) {
      return res.status(502).json({ error: 'Analysis failed — check server logs for the specific cause.' });
    }

    // Persisted BEFORE attempting to respond — real fix for results
    // getting lost when Railway's proxy kills the connection on a
    // longer call. Even if res.json() below never reaches the browser,
    // this data is already safely saved and fetchable via
    // /admin/player-prop-analyses.
    await db.playerPropAnalysis.createMany({
      data: results.map((r) => ({
        matchId,
        playerName,
        market: r.market,
        line: (propLines.find((p) => p.market === r.market) || {}).line ?? null,
        verdict: r.verdict,
        confidence: r.confidence,
        reasoning: r.reasoning,
      })),
    });

    res.json({ playerName, props: results });
  } finally {
    releasePropsAnalysisSlot();
  }
});

// GET /api/picks/admin/player-prop-analyses?matchId=X — real fallback
// for the case above: if the triggering POST's connection died before
// the response arrived, the analysis still completed and was saved.
// The frontend polls this after a failed/timed-out request to check
// whether the work actually succeeded server-side before giving up.
router.get('/admin/player-prop-analyses', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { matchId } = req.query;
  if (!matchId) {
    return res.status(400).json({ error: 'matchId query param is required.' });
  }

  const rows = await db.playerPropAnalysis.findMany({
    where: { matchId },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    analyses: rows.map((r) => ({
      playerName: r.playerName,
      market: r.market,
      line: r.line,
      verdict: r.verdict,
      confidence: r.confidence,
      reasoning: r.reasoning,
      createdAt: r.createdAt,
    })),
  });
});

// POST /api/picks/admin/start-sit — real fantasy start/sit analysis,
// admin-only, on-demand (this is a real Claude research call, same cost
// shape as match analysis — not something to trigger automatically for
// every player in a league). Body: { playerName, team, opponent, sport,
// spread?, total?, injuryStatus? }. spread/total/injuryStatus are
// optional real context — pass them when known, omit when not; the
// analysis is honest about working with less context either way.
router.post('/admin/start-sit', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { playerName, team, opponent, sport, spread, total, injuryStatus } = req.body || {};
  if (!playerName || !team || !opponent || !sport) {
    return res.status(400).json({ error: 'playerName, team, opponent, and sport are required.' });
  }

  const result = await analyzeStartSit({ playerName, team, opponent, sport, spread, total, injuryStatus });
  if (!result) {
    return res.status(502).json({ error: 'Analysis failed — check server logs for the specific cause.' });
  }

  const saved = await db.startSitAdvice.create({
    data: {
      playerName,
      team,
      opponent,
      sport,
      verdict: result.verdict,
      confidence: result.confidence,
      rationale: result.analysis,
      factsUsed: JSON.stringify(result.factors),
    },
  });

  res.json({
    id: saved.id,
    playerName,
    team,
    opponent,
    sport,
    verdict: result.verdict,
    confidence: result.confidence,
    analysis: result.analysis,
    factors: result.factors,
  });
});

// GET /api/picks/admin/start-sit/recent — the last 20 saved start/sit
// analyses, so the admin doesn't have to re-run one to see it again.
router.get('/admin/start-sit/recent', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const recent = await db.startSitAdvice.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  res.json({
    advice: recent.map((a) => ({
      id: a.id,
      playerName: a.playerName,
      team: a.team,
      opponent: a.opponent,
      sport: a.sport,
      verdict: a.verdict,
      confidence: a.confidence,
      analysis: a.rationale,
      factors: JSON.parse(a.factsUsed || '[]'),
      createdAt: a.createdAt,
    })),
  });
});

// POST /api/picks/admin/run-pipeline — manually trigger the pregame
// pipeline right now instead of waiting up to 15 minutes for the next
// scheduled cycle. Real use case: recovering after a period where
// Anthropic balance hit zero and matches got silently skipped. Fires
// the run and returns immediately (a full 5-sport cycle with real
// analysis calls can take several minutes) rather than holding the
// request open — check the Health tab a bit after to see whether
// matches actually got processed.
router.post('/admin/run-pipeline', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const result = await triggerManualRun();
  res.json(result);
});

// POST /api/picks/admin/run-pipeline-tomorrow — same as above, but
// filtered to tomorrow's matches only. Real use case: right after
// "Skip Today's Backlog," kick off tomorrow's slate immediately rather
// than waiting for the scheduled cycle to naturally reach it.
router.post('/admin/run-pipeline-tomorrow', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const result = await triggerManualRunTomorrow();
  res.json(result);
});

// POST /api/picks/admin/skip-today-backlog — bulk-marks every one of
// today's matches that doesn't yet have a real pick as skipAnalysis,
// so the pipeline stops re-attempting them and moves straight to
// tomorrow's matches. Real use case: after a balance-outage window left
// a pile of today's matches un-analyzed — letting the pipeline "catch
// up" on all of them risks the exact overload (many concurrent long
// calls, real spend, zero picks) that caused the problem in the first
// place. This just draws a line under today and starts clean.
router.post('/admin/skip-today-backlog', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { startOfDay, endOfDay } = getTimezoneDayBounds('America/Los_Angeles');

  const todaysMatches = await db.match.findMany({
    where: { startTime: { gte: startOfDay, lt: endOfDay }, skipAnalysis: false },
    include: { picks: { where: { pickType: { in: ['model', 'winner'] } } } },
  });

  const toSkip = todaysMatches.filter((m) => m.picks.length === 0);

  await db.match.updateMany({
    where: { id: { in: toSkip.map((m) => m.id) } },
    data: { skipAnalysis: true },
  });

  res.json({ skipped: toSkip.length, totalToday: todaysMatches.length });
});

// ---------------------------------------------------------------------------
// Insiders — curated X/Twitter accounts for the frontend's left-side
// Insiders sidebar. This does NOT call the X API — the account list is
// just stored here; the actual tweets are rendered client-side via X's
// free embed widget (platform.twitter.com/widgets.js). So this has zero
// ongoing API cost, same as everything else the sidebar does.
// ---------------------------------------------------------------------------

const INSIDER_SPORTS = ['tennis', 'basketball', 'soccer', 'baseball', 'football'];

// GET /api/picks/admin/insiders — admin-only, full rows (with IDs) for
// the management UI in the Health tab.
router.get('/admin/insiders', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const accounts = await db.insiderAccount.findMany({
    orderBy: [{ sport: 'asc' }, { order: 'asc' }],
  });
  res.json({ accounts });
});

// POST /api/picks/admin/insiders  { handle, sport } — admin-only.
router.post('/admin/insiders', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { handle, sport } = req.body || {};
  if (!handle || !sport) {
    return res.status(400).json({ error: 'handle and sport are required.' });
  }
  if (!INSIDER_SPORTS.includes(sport)) {
    return res.status(400).json({ error: `Unknown sport: ${sport}` });
  }

  const cleanHandle = handle.trim().replace(/^@/, '');
  if (!cleanHandle) {
    return res.status(400).json({ error: 'handle cannot be empty.' });
  }

  try {
    const existingCount = await db.insiderAccount.count({ where: { sport } });
    const account = await db.insiderAccount.create({
      data: { sport, handle: cleanHandle, order: existingCount },
    });
    res.json({ account });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'That handle is already tracked for this sport.' });
    }
    console.error('[insiders] POST /admin/insiders failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/picks/admin/insiders/:id — admin-only.
router.delete('/admin/insiders/:id', requireAuth, async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.userId } });
  if (!user || !isAdminEmail(user.email)) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  try {
    await db.insiderAccount.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  } catch (err) {
    console.error('[insiders] DELETE /admin/insiders failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
