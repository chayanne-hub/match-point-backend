/**
 * Match Point — pipeline watchdog.
 *
 * The single most expensive class of bug on this project has not been a
 * crash — it's been silence. Live odds froze for hours; the live pipeline
 * threw on every cycle; the pregame pipeline produced nothing all day.
 * Every one of those was found because someone happened to look at the
 * screen. A picks site whose data quietly stops updating is worse than
 * one that's obviously down, because it keeps looking authoritative while
 * being wrong.
 *
 * This watches the pipelines' own heartbeats and shouts when one stops.
 *
 * ALERT_WEBHOOK_URL — a Discord or Slack incoming webhook. If unset,
 * alerts still go to the logs and the /admin/health endpoint; the webhook
 * is what turns "visible if you look" into "arrives on your phone".
 */

const fetch = require('node-fetch');

// A cycle is considered stalled once it's overdue by this multiple of its
// own interval. 2.5x rather than 1x so a single slow cycle — a busy slate,
// a slow provider — doesn't page anyone. Only a real stop does.
const STALL_MULTIPLIER = 2.5;

// Never re-send the same alert more often than this. Without it a stalled
// pipeline would fire on every check for as long as it stays down.
const RENOTIFY_MS = 30 * 60 * 1000;

const heartbeats = new Map(); // name -> { lastOkAt, intervalMs, lastAlertAt, alerting }

function registerHeartbeat(name, intervalMs) {
  heartbeats.set(name, { lastOkAt: Date.now(), intervalMs, lastAlertAt: 0, alerting: false });
}

/** Called by a pipeline whenever it finishes a cycle successfully. */
function beat(name) {
  const hb = heartbeats.get(name);
  if (!hb) return;
  const wasAlerting = hb.alerting;
  hb.lastOkAt = Date.now();
  hb.alerting = false;
  if (wasAlerting) {
    send(`✅ *${name}* recovered — a cycle just completed normally.`).catch(() => {});
  }
}

async function send(text) {
  console.error(`[watchdog] ${text}`);
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return; // logs only — still recorded, just not pushed
  try {
    // Discord expects { content }, Slack expects { text }. Sending both
    // keys works for either without needing to know which one it is.
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, text }),
    });
  } catch (err) {
    console.error('[watchdog] could not deliver alert:', err.message);
  }
}

function check() {
  const now = Date.now();
  for (const [name, hb] of heartbeats.entries()) {
    const overdueBy = now - hb.lastOkAt;
    const threshold = hb.intervalMs * STALL_MULTIPLIER;
    if (overdueBy < threshold) continue;

    const canRenotify = now - hb.lastAlertAt > RENOTIFY_MS;
    if (hb.alerting && !canRenotify) continue;

    hb.alerting = true;
    hb.lastAlertAt = now;
    const mins = Math.round(overdueBy / 60000);
    send(
      `🔴 *${name}* has not completed a cycle in ${mins} minutes ` +
      `(expected every ${Math.round(hb.intervalMs / 60000)}m). ` +
      `Data on the site is going stale — check the Railway logs.`
    ).catch(() => {});
  }
}

function startWatchdog() {
  setInterval(check, 60 * 1000);
  console.log('[watchdog] monitoring pipeline heartbeats.');
  if (!process.env.ALERT_WEBHOOK_URL) {
    console.warn('[watchdog] ALERT_WEBHOOK_URL is not set — alerts will only appear in the logs.');
  }
}

/** Snapshot for the Health tab. */
function getWatchdogStatus() {
  const now = Date.now();
  const out = {};
  for (const [name, hb] of heartbeats.entries()) {
    const overdueBy = now - hb.lastOkAt;
    out[name] = {
      lastOkAt: new Date(hb.lastOkAt).toISOString(),
      minutesSince: Math.round(overdueBy / 60000),
      expectedEveryMinutes: Math.round(hb.intervalMs / 60000),
      stalled: overdueBy >= hb.intervalMs * STALL_MULTIPLIER,
    };
  }
  return out;
}

module.exports = { registerHeartbeat, beat, startWatchdog, getWatchdogStatus };
