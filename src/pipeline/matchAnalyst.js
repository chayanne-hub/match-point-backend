/**
 * Match Point — independent match analysis via Claude.
 *
 * This REPLACES the previous approach (compute confidence as a function of
 * betting odds, then have Claude describe that number afterward) with real
 * independent research: Claude gets a sport-specific brief on what actually
 * matters for that sport, uses its own web search to check it, and returns
 * its own pick + confidence + reasoning — free to disagree with the market
 * entirely, the same way a genuine handicapper would.
 *
 * Ported from the Smart Money Bot's matchAnalyst.js, adapted two ways:
 *   1. No named data sources with unclear/restrictive commercial licensing
 *      (the original hard-coded tennisabstract.com, which is explicitly
 *      non-commercial-licensed — a real problem for a paid product like
 *      this one). Claude is told WHAT to look for, not WHICH exact site to
 *      pull it from, and uses its own judgment on where to look.
 *   2. Selection is constrained to a plain "<competitor> ML" moneyline
 *      call, since that's the only format the grading/stats pipeline knows
 *      how to parse. Claude's reasoning can still discuss spread/total-
 *      level nuance in the analysis text — only the structured field is
 *      constrained.
 */

const fetch = require('node-fetch');
const { weightGuidanceFor, FACTOR_LIST } = require('./factorWeights');

const ANTHROPIC_MODEL = process.env.MATCH_ANALYST_MODEL || 'claude-sonnet-5';
// Used only for fixing a broken JSON response — the content/reasoning is
// already done at that point, so this is a cheap mechanical task, not
// real analysis. Deliberately a smaller/cheaper model than the main
// research call, same reasoning as generateRationale.js's Haiku use.
const JSON_REPAIR_MODEL = process.env.JSON_REPAIR_MODEL || 'claude-haiku-4-5-20251001';

// Reused in every prompt that asks Claude for structured JSON — the most
// common cause of parse failures in practice is natural writing habits
// (an apostrophe in "Fils' game", a literal line break in a longer
// analysis) breaking strict JSON string syntax. Repeating this
// instruction close to the schema itself (not just once at the top of a
// long prompt) measurably reduces how often that happens.
const JSON_VALIDITY_REMINDER = `
Your response must be syntactically valid JSON. Specifically: escape any
double-quote character that appears inside a string value as \\", escape
any apostrophe-containing contraction normally (apostrophes don't need
escaping, but a stray unescaped double-quote does), and never include a
literal line break inside a string value — write it as one continuous
line instead. Double-check your JSON is valid before finishing your
response.`;

/**
 * Attempts to parse Claude's JSON, with one repair pass if the raw parse
 * fails: literal control characters (a raw newline, tab, or carriage
 * return) sitting inside what's otherwise a valid JSON string are the
 * single most common real-world cause of "Unterminated string" / bad
 * JSON from an LLM — this escapes any that survived despite the prompt
 * instruction above, then retries the parse once. Returns null (never
 * throws) if both attempts fail, exactly like a normal JSON.parse
 * failure — callers already handle a null/failed parse.
 */
function parseClaudeJson(text) {
  try {
    return JSON.parse(text);
  } catch (firstErr) {
    // Escape raw control characters that appear anywhere in the text —
    // safe to do broadly here since valid JSON structural whitespace
    // (between keys/braces) tolerates this transform fine; it's only
    // needed for the invalid case where one snuck inside a string.
    const repaired = text.replace(/[\u0000-\u001F]/g, (ch) => {
      if (ch === '\n') return '\\n';
      if (ch === '\r') return '';
      if (ch === '\t') return '\\t';
      return ''; // drop other stray control characters entirely
    });
    try {
      return JSON.parse(repaired);
    } catch (secondErr) {
      return null; // caller logs using the original error for a clearer message
    }
  }
}

/**
 * Last-resort repair: sends Claude its OWN broken JSON and asks for a
 * syntax-only fix. Deliberately cheap — no web search tool, a small
 * prompt, and the fast/cheap model — since the actual research and
 * reasoning already happened in the original (expensive) call; this is
 * purely a mechanical fix, not a re-analysis. Only called when the local
 * repair in parseClaudeJson() has already failed.
 *
 * Returns the parsed object, or null if this also fails (never throws) —
 * at that point the caller gives up for this cycle, same as before, but
 * the local + Claude repair pair together should catch the large
 * majority of cases that used to be a fully wasted expensive call.
 */
async function repairJsonViaClaude(brokenText, context) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const prompt = `The following text was supposed to be a single valid JSON object but has a syntax error (extra/missing punctuation, an unescaped quote, a stray line break inside a string, etc.). Fix ONLY the syntax — do not change, add, or remove any actual content, wording, or values. Respond with ONLY the corrected JSON object, nothing else, no markdown fences.

${brokenText}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: JSON_REPAIR_MODEL,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      console.error(`[match-analyst] JSON repair call itself failed (${res.status}) for ${context}`);
      return null;
    }
    const data = await res.json();
    const text = data.content?.[0]?.text?.trim();
    if (!text) return null;

    const withoutFences = text.replace(/```json|```/g, '').trim();
    const jsonMatch = withoutFences.match(/\{[\s\S]*\}/);
    const cleaned = jsonMatch ? jsonMatch[0] : withoutFences;
    const parsed = parseClaudeJson(cleaned);
    if (parsed) {
      console.log(`[match-analyst] Claude JSON repair succeeded for ${context} — saved an otherwise-wasted analysis call.`);
    }
    return parsed;
  } catch (err) {
    console.error(`[match-analyst] JSON repair call errored for ${context}:`, err.message);
    return null;
  }
}

const SHARED_PRINCIPLES = `
Core approach: data over instinct. Look for what the market might be
under-pricing — angles a casual bettor or a lazily-set line wouldn't fully
account for. Avoid crowd bias — don't default to the more famous side just
because they're more famous. Think in probabilities, not certainties. Give a
real, differentiated confidence number — do not default to a lazy 50-55%
out of caution when the evidence actually supports a stronger or weaker lean,
but also don't force high confidence where the evidence is genuinely mixed.

Calibration matters more than decisiveness. A stated confidence of 75% is a
claim that this side wins roughly 3 times out of 4 in genuinely comparable
spots — not just "the side you like more." Be honest with yourself about
whether the evidence actually supports that claim. Use this scale as the
real anchor for what each range means, not just a rough feel:

- 85-100%: an overwhelming gap, a near-lock. Reserve this for cases where
  multiple INDEPENDENT factors genuinely converge — not one strong signal
  doing all the work while the rest are neutral or thin.
- 65-84%: a clear, well-supported favorite. This is where most genuine
  edges land — real signal, but not overwhelming.
- 45-64%: a genuine toss-up, or the data is too thin to say more. This is
  not hedging — it's an honest report of a close case, and a useful signal
  in its own right. Most matches with mixed or limited evidence belong here.
- Below 45%: you are picking against what the data or market implies. This
  should be rare and should only happen when you have a specific,
  well-supported reason to think the market or the raw numbers are wrong
  — not as a default landing spot.

If your case for 85%+ rests on a single factor, or you notice yourself
rounding up to sound more decisive than the evidence supports, that's the
signal to bring the number back down — not a reason to look for one more
supporting detail to justify it.

Research efficiently — aim for roughly 3-5 searches total, not one
exhaustive search per item in the checklist below. Some of what's asked
for (e.g. bullpen usage over the last several days, pitcher platoon
splits) is genuinely harder to find via search than other things (e.g.
injury reports, rankings) — if a specific data point isn't turning up
after a reasonable search or two, note that as a real limitation in your
analysis and move on, rather than continuing to search for it. A
timely, honest answer that says "couldn't confirm bullpen usage, so this
factor carries less weight" is far more useful than a slow one that
never finishes.
`.trim();

const SPORT_PROCESS = {
  tennis: `
Tennis-specific process:
- Research each player's current ranking, recent form (last few results,
  not just ranking), and — most importantly — how they perform specifically
  on the surface this match is being played on. A player's overall ranking
  can hide a big surface-specific gap.
- Check recent match load and travel: back-to-back tournaments, long
  travel between events, and whether either player is coming off a long
  match or a walkover/retirement.
- Consider a playing-style matchup where relevant (e.g. a flat, aggressive
  hard-court hitter vs. a grinding clay-court retriever) — style matchups
  can matter as much as raw ranking gap.
- Consider motivation/level mismatch — a higher-ranked player might be
  treating a lower-tier event without full focus, or nursing an injury
  through it.
- VENUE HISTORY. Check each player's career record AT THIS SPECIFIC
  EVENT, not just on this surface. Players repeatedly over- or
  under-perform at particular tournaments — conditions, altitude, ball
  type, crowd, court speed and even scheduling habits are consistent
  year to year, and a player who is 14-3 lifetime somewhere is telling
  you something rank alone doesn't. Weight it by sample: six career
  matches at an event is a hint, twenty is evidence.
- COURT SPEED AT THIS VENUE, and how it interacts with each player's
  game. Fast hard courts compress the gap between a higher-ranked
  all-court player and a big server, which makes upsets more common and
  makes ranking/Elo LESS predictive than usual. Slow courts do the
  opposite. If this venue plays notably fast, say so and shade
  confidence down on the favourite accordingly.
- CROWD. Tennis is played alone with no bench, no substitutions and long
  gaps between points, which makes it unusually exposed to atmosphere.
  Two things to check:
    * Is either player effectively at home — same country, or a large
      diaspora crowd in this city? That support is worth real points in
      tight sets.
    * How does each player HISTORICALLY handle a hostile or partisan
      crowd? Some visibly feed off it and raise their level; others
      tighten, argue with the chair, or drop serve after a bad call.
      This is a documented, commented-on trait for many players — look
      for it rather than assuming it cuts one way.
    * POPULARITY. Fan followings differ enormously and don't track
      ranking: a charismatic or veteran player outside the top 50 can
      draw a far louder crowd than a higher-ranked opponent, and against
      a divisive or disliked player the room can turn actively hostile.
      Scheduling reflects this too — a marquee draw gets the main show
      court in the evening session, which is a different environment
      from an outside court at 11am. Where you can establish it, this
      matters MOST in the situation that decides matches: a tight third
      set, where an underdog with the room behind them holds serve they
      would otherwise lose.
  Only cite this when you find something specific about THESE players.
  "Crowd will favour the home player" with nothing behind it is filler,
  and it is the kind of soft factor that quietly inflates confidence
  without adding information.
- TRAVEL AND ADAPTATION. Where was each player last week, and what did
  it cost them to get here? Intercontinental travel with a large time-zone
  shift, altitude changes, and a switch of continent between consecutive
  events all show up in early-round results. A player who went deep in
  last week's event on another continent is carrying both fatigue and jet
  lag; one who arrived early or skipped the previous week is fresher.
- Named sources to prefer: tennisabstract.com (including its ATP/WTA Elo
  ratings page as the standard Elo source — it renders reliably where
  wheeloratings and the tour's own stats pages return nothing),
  TennisStats.com, and itftennis.com for ITF/Futures-level matches.
- Your confidence is YOUR probability that this player wins, formed from
  the research above. The market price is deliberately not shown; do not
  try to infer it. Where your number and the market's differ is the only
  place value can exist, so an estimate reverse-engineered from the price
  is worth nothing.
`.trim(),

  basketball: `
- Named sources to prefer: the OFFICIAL league injury report for
  availability (this is the decisive input and it updates late — a star
  ruled out an hour before tip moves a line more than anything else),
  Cleaning the Glass or Basketball Reference for efficiency and lineup
  data, and the team beat writers on the day for rotation and rest
  intentions that never reach an injury report.
Basketball-specific process (NBA & WNBA):
- Research real per-possession offensive/defensive efficiency and pace for
  both teams, not just win-loss record — record alone hides a lot of noise
  from blowouts vs. close games.
- Check the most current injury report you can find — a scratched starter
  reported shortly before tip matters far more than any season-long trend.
- Check schedule fatigue specifically: back-to-backs, 3-games-in-4-nights,
  and long road trips with time-zone changes all measurably affect
  performance.
- Check stylistic matchups: pace mismatch, three-point volume mismatch,
  rebounding mismatch — not just "who's the better team" in the abstract.
- Check motivation explicitly: teams resting starters, already clinched or
  eliminated, or in a tanking spot — this affects true probability more
  than lines always adjust for, especially late in a season.
- WNBA-specific: smaller rosters and sample sizes mean a single injury or
  rest day swings true probability more than in the NBA — weight injury
  news more heavily than you would for an NBA game.
- Check the current moneyline price for this match as one data point, but
  your confidence should come from your own research, not from the price.
`.trim(),

  soccer: `
- Named sources to prefer: FBref or Understat for underlying performance
  (xG and shot quality tell you far more than the table), Transfermarkt
  for squad status, injuries and suspensions, and the club's own channels
  or a reliable local beat source for PREDICTED LINEUPS on the day — with
  rotation being the biggest factor in this sport, a confirmed XI an hour
  before kick-off is worth more than any season-long statistic.
THE DRAW IS THE DEFINING FEATURE OF THIS MARKET — read this first.
This is a THREE-WAY market: home win, draw, away win. Your pick is one
team to WIN, and a draw counts as a LOSS. Around a quarter of matches in
most leagues end level, so identifying the better side correctly is not
enough on its own.
- Estimate draw probability explicitly before setting confidence, and
  subtract it. If you think Team A is clearly better but the match has a
  35% chance of ending level, your confidence in "Team A wins" cannot be
  70% no matter how one-sided the sides look.
- Low-scoring leagues, defensive sides, derbies, and matches where a
  point suits both teams all raise draw risk sharply. Two attacking sides
  with nothing to play for lower it.
- Confidence above 65% should be rare here and needs a genuinely large
  gap PLUS a reason the match is unlikely to finish level. A 50-60%
  confidence on a clear favourite is often the honest number in soccer,
  and marking it higher just to look decisive is what turns a sound read
  into a losing pick.

Soccer-specific process (any league/tier, not just top divisions):
- Research team strength using something more informative than table
  position or recent W/L alone — underlying performance quality (chances
  created/conceded, not just results) tends to be more predictive than
  results in a small recent sample.
- Check confirmed or strongly-rumored lineups as close to kickoff as you
  can find — squads rotate heavily for cup competitions and congested
  schedules.
- Check home/away form splits specifically, not just overall form — the
  gap between a team's home and away performance is often larger than
  casual bettors assume.
- Check situational stakes explicitly: relegation battles, European
  qualification races, dead rubbers (nothing left to play for), and
  cup-vs-league prioritization when a team has a bigger match coming up.
- For lower-tier/smaller leagues specifically: available data and market
  liquidity are genuinely thinner than top divisions — reflect that
  honestly in your confidence rather than presenting false precision.
- Check the current moneyline price for this match as one data point, but
  your confidence should come from your own research, not from the price.
`.trim(),

  baseball: `
- Named sources to prefer: Baseball Savant for pitcher and hitter
  underlying data (velocity, spin, expected stats — these turn before
  results do, so a struggling starter shows up here first), FanGraphs for
  projections, park factors and bullpen usage, and Baseball Reference for
  splits and historical matchups. Check the official team feeds or
  MLB.com for the confirmed starting pitcher — a probable can change on
  the morning of, and it's the single biggest input in this sport.
Baseball-specific process (MLB):
- Research the starting pitcher matchup in real detail: recent form,
  velocity trend, and — where you can find it — how each pitcher's
  performance splits by opposing batter handedness (L/R), since an
  overall stat line can mask a real platoon split.
- Check bullpen fatigue: has either team's high-leverage relief corps been
  heavily used over the last several days? A taxed bullpen changes true
  win probability even behind a strong starter.
- Check park factors (some parks meaningfully favor hitters or pitchers)
  and weather where relevant — wind direction/speed at outdoor parks
  measurably affects total runs and home run likelihood.
- Check situational motivation (a team in a playoff race vs. one that's
  eliminated or resting regulars) and same-day lineup construction.
- IMPORTANT calibration note: MLB has much higher game-to-game variance
  than tennis or basketball — even a genuinely great team loses close to
  40% of its games, and single-game outcomes are noisier than the true
  talent gap suggests. Don't force tennis-level confidence onto baseball
  picks just because the underlying edge feels similar; a well-supported
  baseball edge often deserves real but more moderate confidence than the
  same-strength case would in a lower-variance sport. Still commit to
  genuine differentiation — don't default to 50-55% out of caution — but
  calibrate against baseball's actual variance.
- Check the current moneyline price for this match as one data point, but
  your confidence should come from your own research, not from the price.
`.trim(),

  football: `
NFL-specific process:
- Check quarterback status above all else — a backup QB is the single
  biggest line-mover in football, and injury news timing (especially
  Friday/Saturday reports) can lag what's actually happening.
- Check rest and travel: short weeks (Thursday games), bye-week timing,
  and cross-country travel (especially West-to-East early kickoffs) have
  measurable effects.
- Check situational motivation: playoff seeding implications, division
  rivalries, "trap game" spots before a bigger opponent, and any team that
  may be resting starters or is effectively out of contention.
- Check weather for outdoor games — wind in particular suppresses passing
  and total points more than temperature does.
- Check matchup-specific efficiency metrics BY UNIT, not team-level
  averages: this offense's pass game vs that defense's secondary, this
  run game vs that front seven, pressure rate vs offensive line
  performance. Team record and point differential are the weakest
  possible inputs — use them last, not first.
- Named sources to prefer, in order: Pro Football Reference for core and
  situational stats, FTN/Football Outsiders for DVOA-style efficiency
  data, and the OFFICIAL NFL injury report (not aggregator summaries)
  for participation status.
- Weight injuries by POSITIONAL IMPACT rather than counting bodies. A
  starting quarterback, left tackle or top cornerback out is worth more
  than three missing rotational players, and the market prices QB news
  faster than it prices line and secondary news.
- Check the current moneyline price for this match as one data point, but
  your confidence should come from your own research, not from the price.
`.trim(),
};

// NFL PRESEASON is a different sport for handicapping purposes, and most
// of the regular-season process above is not just useless here but
// actively misleading. Playoff seeding, division rivalry and season
// records mean nothing in August; the thing that decides these games —
// how long the starters play — isn't in the regular-season list at all.
//
// Applied when the match came from the preseason sport key, so the model
// stops reasoning about standings that don't exist yet.
const NFL_PRESEASON_PROCESS = `
THIS IS AN NFL PRESEASON GAME. Regular-season handicapping logic mostly
does NOT apply. Override the process above where they conflict:
- Playing time is the whole game. Find out how long each coach plans to
  play starters — many announce it in the week's press conferences, and
  it moves outcomes more than any talent gap. Starters often play a
  series or two, sometimes none at all.
- Preseason week matters: week 1 is heavily backups, week 2 usually the
  most starter snaps, week 3 varies by coach and has trended toward
  resting starters entirely in recent years.
- Season records, standings, playoff implications and division rivalry
  are IRRELEVANT. Do not reason from them.
- Depth quality decides these games — QB2/QB3 play, roster-bubble
  players competing for jobs, and how many veterans are being held out.
- Coaching intent varies enormously: some coaches openly don't care
  about the result, others treat it as evaluation. Prior preseason
  behaviour by the same coach is more predictive than team quality.
- Home-field advantage is materially smaller than in the regular season.
- If you cannot establish playing-time intentions, say so and lower your
  confidence accordingly. A confident preseason pick built on
  regular-season team strength is a guess wearing a suit.
`.trim();

async function buildSystemPrompt(sport, opts = {}) {
  const process = SPORT_PROCESS[sport];
  if (!process) return null;

  const preseasonNote = opts.isPreseason ? `\n\n${NFL_PRESEASON_PROCESS}` : '';
  // Relative factor weights — so a crowd note isn't treated as comparable
  // evidence to an injury report.
  const weighting = await weightGuidanceFor(sport);
  const weightNote = weighting ? `\n\n${weighting}` : '';

  return `
You are an experienced sports betting analyst doing independent handicapping
research for one specific match. You have web search available — use it to
research real, current information about this match before forming a view.

${SHARED_PRINCIPLES}

${process}${preseasonNote}${weightNote}
`.trim();
}

/**
 * Runs real independent research on one match via Claude + web search, and
 * returns a pick, confidence, written analysis, and a structured factor
 * breakdown (for the pick-detail page's "how this was graded" section).
 *
 * Returns null (never throws) on any failure — callers should have a
 * fallback plan (e.g. skip creating a pick this cycle) rather than crash
 * the pipeline over one bad match.
 */

/* PERMANENT vs TRANSIENT FAILURE.
 *
 * The caller retries a failed analysis once. That is right for a
 * timeout or a 529, and pure waste for a 400 — an exhausted credit
 * balance or a malformed request fails identically the second time,
 * at full price. Last night every credit error was billed twice for
 * this reason, on every match, on every cycle.
 *
 * A 4xx other than 429 is the model telling us the request itself is
 * the problem. Retrying it cannot help.
 */
let lastFailureWasPermanent = false;

function noteFailure(status, body) {
  const permanent = status >= 400 && status < 500 && status !== 429;
  lastFailureWasPermanent = permanent;
  if (permanent) {
    const reason = /credit balance/i.test(body || '') ? 'credit balance exhausted'
      : /invalid_request/i.test(body || '') ? 'invalid request'
      : /authentication|api key/i.test(body || '') ? 'bad API key'
      : `HTTP ${status}`;
    console.error(`[match-analyst] PERMANENT failure (${reason}) — not retrying, retry would be billed for nothing.`);
  }
}

function lastFailurePermanent() { return lastFailureWasPermanent; }

async function analyzeMatch({ sport, competitorA, competitorB, oddsA, oddsB, startTime, spread, spreadOddsA, spreadOddsB, total, overOdds, underOdds, pregameProjectedTotal, sportKey, verifiedData }) {
  // The preseason sport key is how we know regular-season logic doesn't
  // apply. Without it the model reasons about playoff seeding in August.
  const isPreseason = typeof sportKey === 'string' && sportKey.includes('preseason');
  const systemPrompt = await buildSystemPrompt(sport, { isPreseason });
  if (!systemPrompt) {
    console.error(`[match-analyst] no process defined for sport: ${sport}`);
    return null;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[match-analyst] ANTHROPIC_API_KEY not set — cannot run independent analysis.');
    return null;
  }

  // ANCHORING — why the moneyline price is withheld by default.
  //
  // Showing the price before the model forms a view is the likeliest
  // cause of the pattern in the results: the model beats the market on
  // near pick-em matches, where the price is ambiguous, and matches or
  // loses to it everywhere the price states a clear opinion. Modest
  // favourites (-125 to -174) hit 53% against a 59% implied — 120 picks,
  // -$1,406.
  //
  // That is what anchoring looks like. Shown "-150", the model produces a
  // number near 60% and the edge is zero by construction — it isn't
  // handicapping the match, it's paraphrasing the price and paying vig
  // for the privilege. Instructing it not to anchor doesn't work;
  // anchoring isn't a rule, it's what happens when a number is present.
  //
  // With the price withheld, confidence becomes a genuinely independent
  // estimate, and "edge" becomes a real comparison between two opinions
  // instead of a number compared against itself.
  //
  // Set SHOW_PRICE_TO_ANALYST=true to restore the old behaviour — the
  // by-edge table on the tracker is how you tell which produces better
  // picks, rather than taking my word for it.
  const showPrice = process.env.SHOW_PRICE_TO_ANALYST === 'true';
  const oddsContext = !showPrice
    ? 'Current moneyline price: WITHHELD ON PURPOSE. Form your own probability from research alone. Do not guess at or reason backwards from what the market price might be — an estimate that merely reproduces the market has no value.'
    : (oddsA !== null && oddsB !== null)
      ? `Current moneyline price: ${competitorA} ${oddsA > 0 ? '+' + oddsA : oddsA}, ${competitorB} ${oddsB > 0 ? '+' + oddsB : oddsB} (BetMGM).`
      : 'Current moneyline price: not available.';

  // Spread/total lines are optional — a book may not have posted them yet.
  // Only ask Claude for a view on a market that actually exists; never
  // request a pick against a line that isn't real.
  const hasSpread = spread !== null && spread !== undefined && spreadOddsA !== null && spreadOddsB !== null;
  const hasTotal = total !== null && total !== undefined && overOdds !== null && underOdds !== null;

  const spreadLineA = hasSpread ? spread : null; // signed relative to competitorA
  const spreadLineB = hasSpread ? -spread : null;
  const spreadContext = hasSpread
    ? `Current point spread: ${competitorA} ${spreadLineA > 0 ? '+' : ''}${spreadLineA} (${spreadOddsA > 0 ? '+' : ''}${spreadOddsA}), ${competitorB} ${spreadLineB > 0 ? '+' : ''}${spreadLineB} (${spreadOddsB > 0 ? '+' : ''}${spreadOddsB}) (BetMGM).`
    : 'Point spread: not available for this match yet.';
  const totalContext = hasTotal
    ? `Current total: ${total} (Over ${overOdds > 0 ? '+' : ''}${overOdds} / Under ${underOdds > 0 ? '+' : ''}${underOdds}) (BetMGM).`
    : 'Total (over/under): not available for this match yet.';

  const spreadInstructionBlock = hasSpread ? `

Also give an independent spread pick. The line is ${competitorA} ${spreadLineA > 0 ? '+' : ''}${spreadLineA} / ${competitorB} ${spreadLineB > 0 ? '+' : ''}${spreadLineB}.
"spreadPick.selection" MUST be exactly one of these two strings, verbatim:
"${competitorA} ${spreadLineA > 0 ? '+' : ''}${spreadLineA}" or "${competitorB} ${spreadLineB > 0 ? '+' : ''}${spreadLineB}".
This is a genuinely separate judgment from your moneyline pick — a team can be
the right moneyline pick and still be the wrong side of the spread (e.g. a
likely winner that you don't think wins by enough to cover), or vice versa.
Give your own honest read on the margin, not just a copy of your moneyline lean.` : '';

  // Sport-specific guidance for what actually moves a total, beyond the
  // shared formula baseline — genuinely different weighting per sport,
  // not just reworded copy.
  const TOTAL_GUIDANCE = {
    basketball: 'pace/style fit, injuries, motivation/stakes, and head-to-head history',
    football: 'weather (wind and cold suppress passing/kicking totals more than any indoor-sport factor), pace/plays-per-game (run-heavy clock-control offenses run far fewer snaps — weight this more heavily than "pace" matters in basketball), QB/O-line injuries (a backup QB or missing starting O-line pieces tends to crater a total more than a single missing skill player), and divisional/rivalry familiarity (division games often trend lower-scoring than raw stats suggest, since both defenses know the opponent well)',
    baseball: "starting pitcher quality and handedness (this often matters more than either team's overall offensive average — a strong starter can suppress a total by 2-3 runs on its own, and lefty/righty platoon splits shift things further), ballpark factors (some parks are notorious run-inflators — thin air, short fences — or suppressors; a bigger, more consistent effect here than home-court advantage in basketball), bullpen strength (a good team can still leak runs late if the bullpen is thin), and weather/wind (wind blowing out inflates totals, especially at open-air parks)",
    tennis: "hold percentage and break points (the single biggest lever — two big servers who both hold easily tend to produce longer matches in total games even at a close-looking score margin, while a match with lots of breaks can end in low-game blowouts despite feeling competitive on paper), surface (clay produces more games per set on average — longer rallies, harder to hold/close — while hard and grass tend to run shorter), and Elo gap (a big mismatch often means fewer total games — a straight-sets blowout — while a close gap often means more)",
    soccer: "xG (expected goals) over actual goals — a team can score 3 in a game they were lucky in, or 0 in a game they dominated, so xG-based averages are far more predictive than raw goals scored/conceded — home/away splits (soccer's home advantage is one of the largest in sports, bigger than in the other sports covered here), missing a key striker or starting keeper (moves a total meaningfully more than a role-player injury would in basketball), and match stakes (a dead rubber or an already-eliminated/already-through team tends to deflate scoring; a must-win tends to inflate it)",
  };
  const totalGuidance = TOTAL_GUIDANCE[sport] || 'pace/scoring-environment research relevant to this sport';

  // The unit word and the description of what avgA/avgB actually mean
  // both genuinely differ per sport — tennis's figure isn't "how many
  // games this player won," it's "the total-games figure of matches this
  // player recently played in" (a proxy for their own hold/break
  // tendencies plus recent opponent quality), which needs its own
  // sentence rather than a reused "TeamX averaged N points" template.
  const pregameBaselineText = pregameProjectedTotal ? (
    sport === 'tennis'
      ? `

A simple formula-based baseline projects the total at ${pregameProjectedTotal.projectedTotal} games
(the average of ${competitorA}'s and ${competitorB}'s own recent-match total-games figures — i.e.
how many total games matches involving each of them have produced over their last 3 matches, not
how many games either of them personally won: ${competitorA}'s matches averaged
${pregameProjectedTotal.avgA} total games, ${competitorB}'s averaged ${pregameProjectedTotal.avgB}).
Treat this as your real starting point, then adjust it up or down using the factors above — those
are layered ON TOP of the baseline, not replacements for it. Don't just default to the raw formula
number unadjusted, and don't ignore it either.`
      : sport === 'soccer'
      ? `

A simple formula-based baseline projects the total at ${pregameProjectedTotal.projectedTotal} goals.
It blends each team's own scoring with what they tend to concede (over their last 3 matches):
${competitorA} has averaged ${pregameProjectedTotal.scoredA} scored / ${pregameProjectedTotal.concededA}
conceded; ${competitorB} has averaged ${pregameProjectedTotal.scoredB} scored /
${pregameProjectedTotal.concededB} conceded. This is raw goals, not xG — treat it as your real
starting point, then adjust it up or down using the factors above (xG over raw goals especially —
a team's raw scoring average can be misleadingly high or low relative to their underlying process).
Those factors are layered ON TOP of the baseline, not replacements for it. Don't just default to the
raw formula number unadjusted, and don't ignore it either.`
      : `

A simple formula-based baseline projects the total at ${pregameProjectedTotal.projectedTotal}
${sport === 'baseball' ? 'runs' : 'points'}
(${competitorA} averaged ${pregameProjectedTotal.avgA} ${sport === 'baseball' ? 'runs' : 'points'} and
${competitorB} averaged ${pregameProjectedTotal.avgB} ${sport === 'baseball' ? 'runs' : 'points'} over
their last 3 games — this is just recent scoring average, nothing else). Treat this as your real
starting point, then adjust it up or down using the factors above — those are layered ON TOP of the
baseline, not replacements for it. Don't just default to the raw formula number unadjusted, and
don't ignore it either.`
  ) : '';

  const totalInstructionBlock = hasTotal ? `

Also give an independent total (over/under) pick. The line is ${total}.
"totalPick.selection" MUST be exactly one of these two strings, verbatim:
"Over ${total}" or "Under ${total}".
Base this on real research into ${totalGuidance} — not on which side you
picked to win, a total pick is about combined scoring, not who wins.${pregameBaselineText}` : '';

  const jsonInstruction = `
Do not narrate your process — no "I'll research this by...", no summary of
what you searched for, nothing before or after. Your final message must
contain ONLY the JSON object below and nothing else.

The "selection" field MUST be exactly one of these two strings, verbatim:
"${competitorA} ML" or "${competitorB} ML" — do not use a spread, total, or
any other format, even if your analysis discusses those. This is a straight
moneyline call: who wins.
${spreadInstructionBlock}
${totalInstructionBlock}

The "factors" field is an array of the specific things you actually
the FIXED FACTOR LIST below. Return EVERY factor on the list, in order,
every time — no additions, no omissions, no renaming.

FACTORS TO REPORT:
${(FACTOR_LIST[sport] || []).map((f, i) => `  ${i + 1}. ${f}`).join('\n')}

Each entry needs:
  - "label": copied VERBATIM from the list above
  - "tag": exactly "Favors ${competitorA}", "Favors ${competitorB}",
    "Neutral", or "No data"
  - "body": one sentence stating the specific finding

Use the tags precisely — they are what the weighting model learns from:
  * "Favors X" — you found real, current information and it points to X.
  * "Neutral" — you found information and it genuinely doesn't separate
    these two competitors.
  * "No data" — you could not find usable information on this factor.
    Use this honestly and often; it is not a failure. Marking something
    Neutral when you actually found nothing corrupts the measurement,
    because Neutral claims you looked and the factor didn't matter, while
    No data says you couldn't look. Those are different, and only one of
    them should ever influence confidence.

CONVICTION — classify your own call honestly. This is the single most
important field. It separates calls worth acting on from calls you were
forced to make, and it is judged on the QUALITY OF INFORMATION you found,
not on how lopsided the matchup looks:
  - "strong": you found specific, current, decision-relevant information
    (injury/participation news, surface or matchup fit, rest/travel,
    recent form with real data behind it) and it points one way.
  - "lean": some real signal, but thin, mixed, or partly stale. A
    reasonable call you would not stake much on.
  - "guess": you could not find meaningful current information on these
    competitors and are reasoning mostly from ranking, name recognition,
    or the market price. Lower-tier events with little coverage belong
    here by default.

Mark it "guess" whenever that is true. It is far more useful than a
confident-sounding pick built on nothing — a wrong "guess" costs nothing,
while a wrong "strong" is what destroys trust in the whole model. Do not
upgrade conviction because the favourite is heavy; a one-sided match you
know nothing about is still a guess.

Respond with ONLY a raw JSON object, no markdown fences, no preamble, in
this exact shape:
{
  "selection": "${competitorA} ML" or "${competitorB} ML",
  "confidence": <integer 0-100>,
  "conviction": "strong" | "lean" | "guess",
  "analysis": "2-4 sentence writeup citing the specific findings that drove this pick",
  "factors": [ { "label": "...", "tag": "...", "body": "..." }, ... ]${hasSpread ? `,
  "spreadPick": {
    "selection": "${competitorA} ${spreadLineA > 0 ? '+' : ''}${spreadLineA}" or "${competitorB} ${spreadLineB > 0 ? '+' : ''}${spreadLineB}",
    "confidence": <integer 0-100>,
    "analysis": "2-3 sentence writeup specific to the spread/margin judgment — not a repeat of the moneyline analysis",
    "factors": [ { "label": "...", "tag": "Favors ${competitorA} ${spreadLineA > 0 ? '+' : ''}${spreadLineA}" or "Favors ${competitorB} ${spreadLineB > 0 ? '+' : ''}${spreadLineB}" or "Neutral", "body": "one sentence" }, ... ] — the specific things that actually informed the SPREAD/MARGIN judgment specifically (e.g. blowout potential, garbage-time risk, a team's tendency to cover/not cover as a favorite or underdog) — do not just copy the moneyline factors array` : ''}${hasTotal ? `,
  "totalPick": {
    "selection": "Over ${total}" or "Under ${total}",
    "confidence": <integer 0-100>,
    "analysis": "2-3 sentence writeup specific to the combined-scoring judgment — not a repeat of the moneyline or spread analysis",
    "factors": [ { "label": "...", "tag": "Favors Over" or "Favors Under" or "Neutral", "body": "one sentence" }, ... ] — the specific pace/scoring-environment things from ${totalGuidance} that actually informed THIS total judgment` : ''}
}
${JSON_VALIDITY_REMINDER}
`.trim();

  /* VERIFIED DATA, appended to the match description.
   *
   * Head-to-head, surface record, venue history, recent form and ranking
   * carry 55 of the 100 factor weight points and were previously
   * researched by web search — which returned different quality per match
   * and made the learned weights partly a measure of the research rather
   * than the factor.
   *
   * Appended rather than replacing the description so nothing else
   * changes, and empty when the provider gave nothing, in which case the
   * analyst falls back to search exactly as before.
   */
  const matchDescription = `${competitorA} vs ${competitorB} (${sport}), ${new Date(startTime).toISOString()}. ${oddsContext} ${spreadContext} ${totalContext}`
    + (verifiedData ? `\n${verifiedData}\nThese figures come from the tennis data provider and are accurate — do not re-research them. Use search only for the two things the data above cannot cover: court speed at this venue, and motivation (what each player has to play for). Everything else \u2014 head to head, surface, form, ranking, venue record, workload, travel, home advantage, recent retirements, playing style and the serve/return match-up \u2014 is in the data above when known. Where a line is absent, that fact is simply unavailable: do not search for it and do not assume a value.` : '');

  // Real research with web search can legitimately take a while, but a
  // single hung request must never be allowed to block the entire
  // sequential pipeline run indefinitely — every match after it would
  // wait forever too. Was 90s; raised to 150s after real logs showed
  // multiple baseball matches timing out on BOTH the first attempt and
  // the retry, back to back — meaning 90s was cutting off requests that
  // may well have finished successfully given a bit more room, and
  // failing twice wastes strictly MORE real spend for zero output than
  // one longer, successful call would have cost. Concurrency is still
  // capped globally (see MAX_CONCURRENT_ANALYSIS in cron.js), so a
  // slower match holding its slot longer doesn't risk the kind of
  // pile-up that caused problems before — it's a genuinely safer trade
  // now than it would have been without that cap in place.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 150000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        // Was 1500 — too tight. web_search is a server-side tool, but every
        // search round's tool_use block and any narration between searches
        // still counts against this SAME output budget as the final JSON
        // answer. A match needing several search rounds could burn the
        // whole budget before ever reaching the actual analysis/factors/
        // spreadPick/totalPick — producing either a truncated, unparseable
        // JSON response or, worse, no text response at all (the two
        // dominant failure modes in production logs). Real headroom here
        // directly reduces both.
        // Was 1500, then 5000 — bumped again since spreadPick/totalPick now
        // each carry their own factors array (not just a 1-2 sentence
        // blurb), real additional output volume on top of the same
        // existing budget concerns described below.
        max_tokens: 6500,
        system: `${systemPrompt}\n\n${jsonInstruction}`,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: `Analyze this match:\n\n${matchDescription}` }],
      }),
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '(could not read response body)');
      console.error(`[match-analyst] Anthropic API returned ${res.status} for ${competitorA} vs ${competitorB}: ${errBody}`);
      noteFailure(res.status, errBody);
      return null;
    }

    const data = await res.json();

    // Claude often narrates around tool use ("I'll research this by
    // searching for..."), so the response can contain multiple text
    // blocks — the LAST one is the final answer, after any search tool
    // calls have completed.
    const textBlocks = (data.content || []).filter((b) => b.type === 'text');
    if (!textBlocks.length) {
      console.error(`[match-analyst] no text response from Claude for ${competitorA} vs ${competitorB}`);
      return null;
    }
    const finalText = textBlocks[textBlocks.length - 1].text;

    const withoutFences = finalText.replace(/```json|```/g, '').trim();
    const jsonMatch = withoutFences.match(/\{[\s\S]*\}/);
    const cleaned = jsonMatch ? jsonMatch[0] : withoutFences;

    let parsed = parseClaudeJson(cleaned);
    if (!parsed) {
      parsed = await repairJsonViaClaude(cleaned, `${competitorA} vs ${competitorB} (pregame analysis)`);
    }
    if (!parsed) {
      console.error(`[match-analyst] failed to parse Claude's JSON for ${competitorA} vs ${competitorB} even after repair attempts. Raw text: ${cleaned.slice(0, 300)}`);
      return null;
    }

    const validSelections = [`${competitorA} ML`, `${competitorB} ML`];
    if (
      !validSelections.includes(parsed.selection) ||
      typeof parsed.confidence !== 'number' ||
      typeof parsed.analysis !== 'string' ||
      !Array.isArray(parsed.factors)
    ) {
      console.error(`[match-analyst] Claude's response missing/invalid required fields for ${competitorA} vs ${competitorB}: ${cleaned}`);
      return null;
    }

    parsed.confidence = Math.max(0, Math.min(100, Math.round(parsed.confidence)));

    // spreadPick/totalPick are validated separately and dropped (not
    // treated as a whole-response failure) if malformed — the moneyline
    // pick is still good and shouldn't be thrown away because Claude
    // botched a secondary field's format.
    if (hasSpread) {
      const validSpreadSelections = [
        `${competitorA} ${spreadLineA > 0 ? '+' : ''}${spreadLineA}`,
        `${competitorB} ${spreadLineB > 0 ? '+' : ''}${spreadLineB}`,
      ];
      if (
        parsed.spreadPick &&
        validSpreadSelections.includes(parsed.spreadPick.selection) &&
        typeof parsed.spreadPick.confidence === 'number' &&
        typeof parsed.spreadPick.analysis === 'string'
      ) {
        parsed.spreadPick.confidence = Math.max(0, Math.min(100, Math.round(parsed.spreadPick.confidence)));
        // factors is a nice-to-have, not a hard requirement — a missing or
        // malformed factors array shouldn't throw away an otherwise-valid
        // spreadPick, same "degrade gracefully" rule as everywhere else.
        if (!Array.isArray(parsed.spreadPick.factors)) parsed.spreadPick.factors = [];
      } else {
        if (parsed.spreadPick) console.warn(`[match-analyst] dropping malformed spreadPick for ${competitorA} vs ${competitorB}`);
        parsed.spreadPick = null;
      }
    } else {
      parsed.spreadPick = null;
    }

    if (hasTotal) {
      const validTotalSelections = [`Over ${total}`, `Under ${total}`];
      if (
        parsed.totalPick &&
        validTotalSelections.includes(parsed.totalPick.selection) &&
        typeof parsed.totalPick.confidence === 'number' &&
        typeof parsed.totalPick.analysis === 'string'
      ) {
        parsed.totalPick.confidence = Math.max(0, Math.min(100, Math.round(parsed.totalPick.confidence)));
        if (!Array.isArray(parsed.totalPick.factors)) parsed.totalPick.factors = [];
      } else {
        if (parsed.totalPick) console.warn(`[match-analyst] dropping malformed totalPick for ${competitorA} vs ${competitorB}`);
        parsed.totalPick = null;
      }
    } else {
      parsed.totalPick = null;
    }

    // Conviction must be one of the three values. Anything else — a
    // missing field, an invented tier, a sentence instead of a label —
    // becomes 'guess'. Defaulting UP would let a malformed response
    // masquerade as a high-conviction call, which is precisely the
    // failure this field exists to prevent.
    // FIXED FACTOR LIST enforcement. A response that drops factors would
    // quietly bias the measurement — a factor only ever reported when it
    // was interesting would look far more predictive than it is. Missing
    // entries are filled in as "No data", which is the truthful reading:
    // it wasn't reported, so nothing was established.
    const required = FACTOR_LIST[sport] || [];
    if (required.length) {
      const byLabel = new Map(
        (Array.isArray(parsed.factors) ? parsed.factors : [])
          .filter((f) => f && typeof f.label === 'string')
          .map((f) => [f.label.trim(), f])
      );
      const missing = [];
      parsed.factors = required.map((label) => {
        const found = byLabel.get(label);
        if (found) {
          const tag = String(found.tag || '').trim();
          const validTag = /^Favou?rs /i.test(tag) || tag === 'Neutral' || tag === 'No data';
          return { label, tag: validTag ? tag : 'No data', body: String(found.body || '').trim() };
        }
        missing.push(label);
        return { label, tag: 'No data', body: 'Not reported by the analyst for this match.' };
      });
      if (missing.length) {
        console.warn(`[match-analyst] ${competitorA} vs ${competitorB}: ${missing.length} factor(s) missing, filled as No data — ${missing.join(', ')}`);
      }
    }

    const VALID_CONVICTION = ['strong', 'lean', 'guess'];
    if (!VALID_CONVICTION.includes(parsed.conviction)) {
      if (parsed.conviction) {
        console.warn(`[match-analyst] unexpected conviction "${parsed.conviction}" for ${competitorA} vs ${competitorB} — treating as guess.`);
      }
      parsed.conviction = 'guess';
    }

    return parsed;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error(`[match-analyst] request timed out after 90s for ${competitorA} vs ${competitorB} — skipping this cycle.`);
    } else {
      console.error(`[match-analyst] request failed for ${competitorA} vs ${competitorB}:`, err.message);
    }
    return null;
  }
}

/**
 * Periodically re-evaluates a LIVE match given how it's actually playing
 * out. Deliberately different from analyzeMatch(): no web search tool
 * (this runs repeatedly for every live match, so it needs to be fast and
 * cheap — a full research call every cycle would be neither), and it's
 * explicitly told to weigh the live score and the players' known
 * skill/history alongside the current odds, never let odds alone drive
 * the number. Current odds ARE included as real signal (fast market
 * movement can reflect real information — an injury visible on court,
 * fatigue, momentum) — the instruction is against over-relying on them,
 * not against using them at all.
 *
 * Returns the same shape as analyzeMatch(): { selection, confidence,
 * analysis, factors }. Returns null (never throws) on failure.
 */
async function reassessLiveMatch({ sport, competitorA, competitorB, liveScore, oddsA, oddsB, priorAnalysis }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[match-analyst] ANTHROPIC_API_KEY not set — cannot reassess live match.');
    return null;
  }

  const oddsContext = (oddsA !== null && oddsB !== null)
    ? `Current live moneyline price: ${competitorA} ${oddsA > 0 ? '+' + oddsA : oddsA}, ${competitorB} ${oddsB > 0 ? '+' + oddsB : oddsB} (BetMGM).`
    : 'Current live moneyline price: not available.';

  const jsonInstruction = `
Do not narrate your process. Your final message must contain ONLY the JSON
object below and nothing else.

The "selection" field MUST be exactly one of these two strings, verbatim:
"${competitorA} ML" or "${competitorB} ML".

The "factors" field is an array of the specific things that actually
informed this updated read. Each entry needs "label" (short category, e.g.
"Live Score", "Momentum", "Current Odds", "Pre-Match Scouting"), "tag"
(exactly "Favors ${competitorA}", "Favors ${competitorB}", or "Neutral"),
and "body" (one sentence).

Respond with ONLY a raw JSON object, in this exact shape:
{
  "selection": "${competitorA} ML" or "${competitorB} ML",
  "confidence": <integer 0-100>,
  "analysis": "1-3 sentence updated read given how the match is actually going",
  "factors": [ { "label": "...", "tag": "...", "body": "..." }, ... ]
}
${JSON_VALIDITY_REMINDER}
`.trim();

  const prompt = `
You are re-evaluating a match that's currently IN PROGRESS, given both your
original pre-match scouting and how the match has actually unfolded so far.

Match: ${competitorA} vs ${competitorB} (${sport})
Current score: ${liveScore || 'not available'}
${oddsContext}

Your original pre-match analysis:
${priorAnalysis || '(not available)'}

Give an updated read on who wins from here. Weigh the live score and each
player's known skill/tendencies/history (from your original scouting)
together with the current odds — the odds ARE real signal (fast market
movement can reflect something real happening, like an injury or a
momentum shift), but do not let them be the ONLY thing driving your
number. Odds alone can move quickly and don't always reflect the full
picture. Commit to a real, differentiated confidence number based on your
actual judgment of the match state.

${jsonInstruction}
`.trim();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000); // shorter than analyzeMatch()'s 90s — no search tool, should resolve faster

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1200, // was 800 — small margin added since this still writes a full factors array
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '(could not read response body)');
      console.error(`[match-analyst] live reassessment API returned ${res.status} for ${competitorA} vs ${competitorB}: ${errBody}`);
      return null;
    }

    const data = await res.json();
    const textBlocks = (data.content || []).filter((b) => b.type === 'text');
    if (!textBlocks.length) return null;
    const finalText = textBlocks[textBlocks.length - 1].text;

    const withoutFences = finalText.replace(/```json|```/g, '').trim();
    const jsonMatch = withoutFences.match(/\{[\s\S]*\}/);
    const cleaned = jsonMatch ? jsonMatch[0] : withoutFences;

    let parsed = parseClaudeJson(cleaned);
    if (!parsed) {
      parsed = await repairJsonViaClaude(cleaned, `${competitorA} vs ${competitorB} (live moneyline reassessment)`);
    }
    if (!parsed) {
      console.error(`[match-analyst] failed to parse live reassessment JSON for ${competitorA} vs ${competitorB} even after repair attempts. Raw text: ${cleaned.slice(0, 300)}`);
      return null;
    }

    const validSelections = [`${competitorA} ML`, `${competitorB} ML`];
    if (
      !validSelections.includes(parsed.selection) ||
      typeof parsed.confidence !== 'number' ||
      typeof parsed.analysis !== 'string' ||
      !Array.isArray(parsed.factors)
    ) {
      console.error(`[match-analyst] live reassessment missing/invalid fields for ${competitorA} vs ${competitorB}: ${cleaned}`);
      return null;
    }

    parsed.confidence = Math.max(0, Math.min(100, Math.round(parsed.confidence)));
    return parsed;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error(`[match-analyst] live reassessment timed out for ${competitorA} vs ${competitorB} — skipping this cycle.`);
    } else {
      console.error(`[match-analyst] live reassessment failed for ${competitorA} vs ${competitorB}:`, err.message);
    }
    return null;
  }
}

/**
 * Live total reassessment — parallel to reassessLiveMatch() but for the
 * total (over/under) market specifically, since the selection format and
 * grounding data are genuinely different (a live pace projection, not a
 * live score + odds).
 *
 * liveProjection is the real, computed output of
 * basketballTotals.computeLiveProjectedTotal() — this function's job is
 * to take that real number and layer real basketball judgment on top of
 * it (garbage time, a team sitting on a lead, foul trouble, a trailing
 * team pushing tempo), not to recompute the math itself.
 *
 * Returns { selection, confidence, analysis } or null on failure — same
 * never-throws contract as every other function in this file.
 */
async function reassessLiveTotal({ sport, competitorA, competitorB, total, liveScore, liveProjection, priorAnalysis }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[match-analyst] ANTHROPIC_API_KEY not set — cannot reassess live total.');
    return null;
  }

  // liveProjection's shape depends on which formula produced it — the
  // time-based one (basketball/football) has minutesElapsed/inOvertime;
  // the innings-based one (baseball) has inningsCompleted/inExtraInnings;
  // the sets-based one (tennis) has gamesCompletedSoFar/expectedRemainingSets.
  // Detect by shape rather than trusting `sport` alone, since it's the
  // caller's actual data that determines which text is honest here.
  let projectionContext;
  if (liveProjection && liveProjection.inningsCompleted !== undefined) {
    projectionContext = `Live pace formula: combined runs so far ÷ innings completed = ${liveProjection.pace} runs/inning. At that pace, projected final total = ${liveProjection.projectedFinal}${liveProjection.inExtraInnings ? ' (game is in extra innings — this projection only reflects pace through the end of regulation (9 innings), there is no fixed remaining-innings count past that)' : ` (${liveProjection.inningsRemaining} inning(s) remaining in regulation)`}.`;
  } else if (liveProjection && liveProjection.gamesCompletedSoFar !== undefined) {
    projectionContext = `Live games formula: ${liveProjection.gamesCompletedSoFar} games played so far, averaging ${liveProjection.avgGamesPerSet} games per completed set. Expected remaining sets under a NEUTRAL 50/50-per-set assumption (${liveProjection.matchFormat}): ${liveProjection.expectedRemainingSets} — this does NOT account for who's actually favored to close the match, only the mechanical odds given the current set score. Projected final total = ${liveProjection.projectedTotal} games.`;
  } else if (sport === 'soccer' && liveProjection && liveProjection.minutesElapsed !== undefined) {
    projectionContext = `Live pace formula: goals so far ÷ minutes elapsed = ${liveProjection.pace} goals/min. At that pace, projected final total = ${liveProjection.projectedFinal} (${liveProjection.minutesRemaining} minutes remaining in regulation — this does NOT predict added stoppage time, which isn't knowable in advance).`;
  } else if (liveProjection && liveProjection.minutesElapsed !== undefined) {
    projectionContext = `Live pace formula: combined score so far ÷ minutes elapsed = ${liveProjection.pace} pts/min. At that pace, projected final total = ${liveProjection.projectedFinal}${liveProjection.inOvertime ? ' (game is in overtime — this projection only reflects pace through end of regulation, there is no fixed remaining duration in OT)' : ` (${liveProjection.minutesRemaining} minutes remaining in regulation)`}.`;
  } else {
    projectionContext = 'Live pace projection: not available this cycle.';
  }

  const jsonInstruction = `
Do not narrate your process. Your final message must contain ONLY the JSON
object below and nothing else.

The "selection" field MUST be exactly one of these two strings, verbatim:
"Over ${total}" or "Under ${total}".

Respond with ONLY a raw JSON object, in this exact shape:
{
  "selection": "Over ${total}" or "Under ${total}",
  "confidence": <integer 0-100>,
  "analysis": "1-3 sentence updated read on the total given how the game is actually playing out"
}
${JSON_VALIDITY_REMINDER}
`.trim();

  const LIVE_TOTAL_GUIDANCE = {
    basketball: `The pace formula above is real math, not a guess — but real basketball
doesn't score at a perfectly constant rate. Weigh it against what you'd
actually expect given how the game is playing out: garbage-time fouling
late, a team protecting a lead by slowing pace deliberately, a shorthanded
team fading in the second half, a trailing team pushing tempo to chase a
comeback. Don't just repeat the formula's number unadjusted, and don't
ignore it either — it's real signal, layer real judgment on top of it.`,
    football: `The pace formula above is real math, but treat it with real caution —
football scoring is much lumpier than basketball's. A single possession is
worth 3-8 points instead of 2-3, and a whole quarter can go scoreless or
explode with two quick touchdowns. Pure pace math is far less reliable in
the FIRST HALF especially — weight it more heavily once you're seeing how
each offense/defense is actually performing that day (second half and
later). Layer on football-specific dynamics: two-minute-drill stretches
(end of half, end of game) spike scoring well above the game's average
pace; a team playing from well behind often abandons the run and speeds up
via more passing; a team protecting a big lead often does the opposite —
running the clock, playing conservative, slowing pace right when you might
expect it to pick up. Don't just repeat the formula's number unadjusted,
especially early in the game, and don't ignore it either once the sample
of live play is bigger.`,
    baseball: `The pace formula above is rougher than basketball's or football's — innings
aren't equal-length units of time, so runs/inning is a cruder proxy for
"pace" than points/minute is in a clock sport. The single biggest live
variable here has no basketball/football equivalent: the starter-to-bullpen
transition. If a strong starter exits and a shaky bullpen takes over (or
vice versa), the run-scoring pace can shift hard mid-game in a way pure
pace math won't see coming — check who's actually on the mound now, not
just the pregame starter. Late-inning scoring also tends to be lumpier
than mid-game — a bases-loaded walk or a bullpen implosion can swing the
total by several runs in one inning. Don't just repeat the formula's
number unadjusted, especially once a pitching change has happened.`,
    tennis: `The "expected remaining sets" figure above is a NEUTRAL 50/50-per-set
assumption — real math on the current set score and match format, but it
deliberately does NOT know who's actually favored to close the match out.
That's your job: weigh it against who's actually serving better today,
who looks fresher, and the current set score/momentum. A set that just
went to a tiebreak inflates that set's game count (7-6 = 13 games vs. a
clean 6-2 = 8) — the average-games-per-set figure above already reflects
the actual sets played, not an assumption, so trust it more than you'd
trust a similar average in a sport where set/inning length is more
uniform. Watch for live odds overreacting to a single break before the
returner has proven they can actually hold the advantage — a single
break in a long, high-hold-percentage match is weaker signal than the
market sometimes prices it as. Don't just repeat the formula's number
unadjusted, and don't ignore it either — it's real signal on the
mechanical odds, even though it doesn't know who's playing better.`,
    soccer: `The pace formula above is the shakiest of any sport's live total math —
goals are rare, lumpy events. A 0-0 game after 60 minutes doesn't mean
"no goals are coming," it just means variance hasn't broken yet. Weigh
shot volume, live xG generated, and chance quality far more heavily than
the raw goals-per-minute number — a team peppering shots and hitting the
post twice in a scoreless game is a completely different situation than a
team that hasn't threatened at all, and the pace formula can't tell those
two apart. Live-state adjustments that matter most: a team down a goal
with 15-20 minutes left tends to push numbers forward (raises live goal
probability); a team protecting a 1-0 or 2-0 lead late often sits back
and manages the clock (suppresses it); a red card is a bigger single-
event swing here than almost anything in the other sports — a team
playing a man up very often changes the rest of the match's total-goal
expectation significantly. Don't just repeat the formula's number
unadjusted — weigh the underlying game state more than the pace math.`,
  };
  const liveTotalGuidance = LIVE_TOTAL_GUIDANCE[sport] || LIVE_TOTAL_GUIDANCE.basketball;

  const prompt = `
You are re-evaluating a TOTAL (over/under) pick for a game currently IN
PROGRESS, given the live pace and how the game has actually unfolded.

Match: ${competitorA} vs ${competitorB} (${sport})
Current score: ${liveScore || 'not available'}
Total line: ${total}
${projectionContext}

Your original pre-match total analysis:
${priorAnalysis || '(not available)'}

${liveTotalGuidance}

${jsonInstruction}
`.trim();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '(could not read response body)');
      console.error(`[match-analyst] live total reassessment API returned ${res.status} for ${competitorA} vs ${competitorB}: ${errBody}`);
      return null;
    }

    const data = await res.json();
    const textBlocks = (data.content || []).filter((b) => b.type === 'text');
    if (!textBlocks.length) return null;
    const finalText = textBlocks[textBlocks.length - 1].text;

    const withoutFences = finalText.replace(/```json|```/g, '').trim();
    const jsonMatch = withoutFences.match(/\{[\s\S]*\}/);
    const cleaned = jsonMatch ? jsonMatch[0] : withoutFences;

    let parsed = parseClaudeJson(cleaned);
    if (!parsed) {
      parsed = await repairJsonViaClaude(cleaned, `${competitorA} vs ${competitorB} (live total reassessment)`);
    }
    if (!parsed) {
      console.error(`[match-analyst] failed to parse live total JSON for ${competitorA} vs ${competitorB} even after repair attempts. Raw text: ${cleaned.slice(0, 300)}`);
      return null;
    }

    const validSelections = [`Over ${total}`, `Under ${total}`];
    if (
      !validSelections.includes(parsed.selection) ||
      typeof parsed.confidence !== 'number' ||
      typeof parsed.analysis !== 'string'
    ) {
      console.error(`[match-analyst] live total reassessment missing/invalid fields for ${competitorA} vs ${competitorB}: ${cleaned}`);
      return null;
    }

    parsed.confidence = Math.max(0, Math.min(100, Math.round(parsed.confidence)));
    return parsed;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error(`[match-analyst] live total reassessment timed out for ${competitorA} vs ${competitorB} — skipping this cycle.`);
    } else {
      console.error(`[match-analyst] live total reassessment failed for ${competitorA} vs ${competitorB}:`, err.message);
    }
    return null;
  }
}

module.exports = { analyzeMatch, lastFailurePermanent, reassessLiveMatch, reassessLiveTotal, parseClaudeJson, repairJsonViaClaude };
