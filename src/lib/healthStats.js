/**
 * Match Point — lightweight pipeline health tracking.
 *
 * In-memory only, deliberately — this isn't meant to be a permanent
 * audit log, just "what's the pipeline doing right now, and is anything
 * broken." Resets on every deploy/restart, which is fine for this
 * purpose (you want current state, not historical archaeology). If you
 * ever want real historical uptime tracking, that's a genuinely
 * different, bigger feature (a real time-series store), not this.
 */

const stats = {
  startedAt: new Date(),
  pregameRuns: {}, // sport -> { lastRunAt, lastSuccessAt, matchesProcessed, errors }
  espnPolls: {},   // sport -> { lastPollAt, lastSuccessAt, errorCount }
  analysisRetries: 0,   // how many times analyzeMatchWithRetry's retry path fired
  analysisFailures: 0,  // how many times BOTH attempts failed (real, unrecovered loss)
  recentErrors: [],     // last 20 errors across the whole pipeline, newest first
};

function recordPregameRun(sport, matchesProcessed) {
  stats.pregameRuns[sport] = {
    lastRunAt: new Date(),
    lastSuccessAt: new Date(),
    matchesProcessed,
  };
}

function recordEspnPoll(sport, success) {
  const existing = stats.espnPolls[sport] || { errorCount: 0 };
  stats.espnPolls[sport] = {
    lastPollAt: new Date(),
    lastSuccessAt: success ? new Date() : existing.lastSuccessAt,
    errorCount: success ? existing.errorCount : existing.errorCount + 1,
  };
}

function recordAnalysisRetry() {
  stats.analysisRetries++;
}

function recordAnalysisFailure(context) {
  stats.analysisFailures++;
  recordError(`Analysis failed after retry: ${context}`);
}

function recordError(message) {
  stats.recentErrors.unshift({ message, at: new Date() });
  if (stats.recentErrors.length > 20) stats.recentErrors.pop();
}

function getHealthSnapshot() {
  return {
    uptimeSeconds: Math.round((Date.now() - stats.startedAt.getTime()) / 1000),
    startedAt: stats.startedAt,
    pregameRuns: stats.pregameRuns,
    espnPolls: stats.espnPolls,
    analysisRetries: stats.analysisRetries,
    analysisFailures: stats.analysisFailures,
    recentErrors: stats.recentErrors,
  };
}

module.exports = { recordPregameRun, recordEspnPoll, recordAnalysisRetry, recordAnalysisFailure, recordError, getHealthSnapshot };
