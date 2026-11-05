'use strict';

// One client-wide budget, including status reconciliation. A failed operation
// releases its slot before any retry/status request is scheduled.
function createLimiter(limit) {
  const queue = []; let active = 0;
  function drain() {
    while (active < limit && queue.length) {
      const { operation, resolve, reject } = queue.shift(); active++;
      Promise.resolve().then(operation).then(value => {
        active--; resolve(value); drain();
      }, error => {
        active--; reject(error); drain();
      });
    }
  }
  return operation => new Promise((resolve, reject) => {
    queue.push({ operation, resolve, reject }); drain();
  });
}

// Preserve input order, stop assigning work on failure, and drain work already
// started before rejecting. All client tasks settle before failure is reported.
async function mapConcurrent(items, limit, operation) {
  const result = new Array(items.length); let next = 0, failure;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try { result[index] = await operation(items[index], index); }
      catch (error) { failure ||= { error }; }
    }
  }));
  if (failure) throw failure.error;
  return result;
}

module.exports = { createLimiter, mapConcurrent };
