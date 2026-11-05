'use strict';
const { performance } = require('node:perf_hooks');

function startStage(stage, log = console.log) {
  const start = performance.now();
  return details => log('Release metrics: ' + JSON.stringify({ stage,
    elapsed_ms: Math.round(performance.now() - start), ...details }));
}

function latencySummary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => sorted.length ? Math.round(sorted[Math.ceil(sorted.length * fraction) - 1]) : null;
  return { chunk_p50_ms: percentile(0.5), chunk_p95_ms: percentile(0.95) };
}

async function measure(stage, operation, log = console.log) {
  const finish = startStage(stage, log); let completed = false;
  try { const result = await operation(); completed = true; return result; }
  finally { finish({ status: completed ? 'complete' : 'failed' }); }
}

module.exports = { startStage, latencySummary, measure };
