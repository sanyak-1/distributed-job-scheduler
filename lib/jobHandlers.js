// ============================================================================
// lib/jobHandlers.js — pluggable job execution logic
//
// Register a handler per job "name". Handlers receive the job's payload and
// must return a JSON-serializable result, or throw to signal failure.
// ============================================================================

const handlers = new Map();

/**
 * Register a handler for a given job name.
 * @param {string} jobName
 * @param {(payload: object, job: object) => Promise<any>} handlerFn
 */
function registerHandler(jobName, handlerFn) {
  handlers.set(jobName, handlerFn);
}

/**
 * Look up the handler for a job. Falls back to a default that throws,
 * so unknown job types fail loudly (and go through normal retry/DLQ flow)
 * instead of silently no-oping.
 */
function getHandler(jobName) {
  return handlers.get(jobName) || defaultHandler;
}

async function defaultHandler(payload, job) {
  throw new Error(`No handler registered for job name "${job.name}"`);
}

// ----------------------------------------------------------------------------
// Example handlers — replace with real business logic
// ----------------------------------------------------------------------------

registerHandler('send-welcome-email', async (payload) => {
  if (!payload.userId) throw new Error('payload.userId is required');
  // ... actual email-sending logic goes here ...
  return { sent: true, userId: payload.userId };
});

registerHandler('generate-report', async (payload) => {
  // ... actual report generation logic goes here ...
  return { reportId: `report-${Date.now()}`, params: payload };
});

module.exports = { registerHandler, getHandler };