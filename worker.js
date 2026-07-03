// ============================================================================
// worker.js — Distributed Job Scheduler Worker
//
// Polls the `jobs` table using SELECT ... FOR UPDATE SKIP LOCKED so that
// multiple worker processes can safely race for work without double-claiming
// the same job (SKIP LOCKED makes Postgres skip rows another transaction
// already has locked, instead of blocking on them).
// ============================================================================

const os = require('os');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { computeNextRetryAt } = require('./lib/backoff');
const { getHandler } = require('./lib/jobHandlers');

const prisma = new PrismaClient();

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------

const WORKER_ID = crypto.randomUUID();
const HOSTNAME = os.hostname();
const ORGANIZATION_ID = process.env.ORGANIZATION_ID; // which org this worker serves
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2000);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 10000);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 1);

let activeJobCount = 0;
let isShuttingDown = false;

// ----------------------------------------------------------------------------
// Worker lifecycle: register + heartbeat
// ----------------------------------------------------------------------------

async function registerWorker() {
  if (!ORGANIZATION_ID) {
    throw new Error('ORGANIZATION_ID env var is required to register a worker');
  }

  return prisma.worker.create({
    data: {
      id: WORKER_ID,
      hostname: HOSTNAME,
      status: 'IDLE',
      maxConcurrent: MAX_CONCURRENT,
      organizationId: ORGANIZATION_ID,
      lastHeartbeat: new Date(),
    },
  });
}

async function sendHeartbeat() {
  const status = activeJobCount >= MAX_CONCURRENT ? 'BUSY' : 'IDLE';
  await prisma.worker.update({
    where: { id: WORKER_ID },
    data: { lastHeartbeat: new Date(), status },
  }).catch((err) => {
    console.error(`[${WORKER_ID}] heartbeat failed:`, err.message);
  });
}

// ----------------------------------------------------------------------------
// Claim a job: SELECT ... FOR UPDATE SKIP LOCKED inside a transaction,
// then flip its status to RUNNING and stamp the lock owner, all atomically.
// ----------------------------------------------------------------------------

async function claimNextJob() {
  return prisma.$transaction(async (tx) => {
    // Select one eligible job, locking the row so no other worker's
    // concurrent transaction can select it too. SKIP LOCKED means we don't
    // block waiting on rows other workers already hold locks on — we just
    // move on and try the next candidate row.
    const candidates = await tx.$queryRaw`
      SELECT id
      FROM jobs
      WHERE status IN ('PENDING', 'SCHEDULED')
        AND scheduled_at <= NOW()
      ORDER BY priority DESC, scheduled_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;

    if (!candidates || candidates.length === 0) {
      return null;
    }

    const jobId = candidates[0].id;

    const job = await tx.job.update({
      where: { id: jobId },
      data: {
        status: 'RUNNING',
        lockedAt: new Date(),
        lockedBy: WORKER_ID,
      },
    });

    return job;
  });
}

// ----------------------------------------------------------------------------
// Execute a claimed job: create the JobExecution record, run the handler,
// route to success/failure handling.
// ----------------------------------------------------------------------------

async function runJob(job) {
  activeJobCount += 1;

  const execution = await prisma.jobExecution.create({
    data: {
      jobId: job.id,
      workerId: WORKER_ID,
      attempt: job.retryCount + 1,
      status: 'RUNNING',
      startedAt: new Date(),
    },
  });

  try {
    const result = await runWithTimeout(job);
    await handleSuccess(job, execution, result);
  } catch (err) {
    const isTimeout = err instanceof TimeoutError;
    await handleFailure(job, execution, err, isTimeout);
  } finally {
    activeJobCount -= 1;
  }
}

class TimeoutError extends Error {}

function runWithTimeout(job) {
  const handler = getHandler(job.name);

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new TimeoutError(`Job timed out after ${job.timeoutMs}ms`)), job.timeoutMs);
  });

  return Promise.race([handler(job.payload, job), timeoutPromise]);
}

// ----------------------------------------------------------------------------
// Success path
// ----------------------------------------------------------------------------

async function handleSuccess(job, execution, result) {
  await prisma.$transaction([
    prisma.jobExecution.update({
      where: { id: execution.id },
      data: {
        status: 'SUCCESS',
        finishedAt: new Date(),
        output: result ?? {},
      },
    }),
    prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'COMPLETED',
        lockedAt: null,
        lockedBy: null,
      },
    }),
  ]);

  console.log(`[${WORKER_ID}] job ${job.id} (${job.name}) completed successfully`);
}

// ----------------------------------------------------------------------------
// Failure path: retry with exponential backoff, or move to DLQ if exhausted
// ----------------------------------------------------------------------------

async function handleFailure(job, execution, error, isTimeout) {
  const nextRetryCount = job.retryCount + 1;
  const exhausted = nextRetryCount >= job.maxRetries;

  const executionUpdate = prisma.jobExecution.update({
    where: { id: execution.id },
    data: {
      status: isTimeout ? 'TIMEOUT' : 'FAILED',
      finishedAt: new Date(),
      errorMsg: error.message,
      stackTrace: error.stack,
    },
  });

  if (exhausted) {
    await prisma.$transaction([
      executionUpdate,
      prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'DEAD_LETTER',
          retryCount: nextRetryCount,
          lockedAt: null,
          lockedBy: null,
        },
      }),
      prisma.deadLetterQueue.create({
        data: {
          jobId: job.id,
          queueId: job.queueId,
          reason: `Max retries (${job.maxRetries}) exceeded. Last error: ${error.message}`,
          payloadSnapshot: job.payload,
          failedAt: new Date(),
        },
      }),
    ]);

    console.warn(`[${WORKER_ID}] job ${job.id} (${job.name}) moved to DEAD_LETTER after ${nextRetryCount} attempts`);
    return;
  }

  const nextRetryAt = computeNextRetryAt(nextRetryCount);

  await prisma.$transaction([
    executionUpdate,
    prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'SCHEDULED',
        retryCount: nextRetryCount,
        scheduledAt: nextRetryAt,
        lockedAt: null,
        lockedBy: null,
      },
    }),
  ]);

  console.log(
    `[${WORKER_ID}] job ${job.id} (${job.name}) failed (attempt ${nextRetryCount}/${job.maxRetries}), ` +
    `retrying at ${nextRetryAt.toISOString()}`
  );
}

// ----------------------------------------------------------------------------
// Poll loop
// ----------------------------------------------------------------------------

async function pollOnce() {
  if (isShuttingDown || activeJobCount >= MAX_CONCURRENT) {
    return;
  }

  let job;
  try {
    job = await claimNextJob();
  } catch (err) {
    console.error(`[${WORKER_ID}] claim failed:`, err.message);
    return;
  }

  if (!job) {
    return; // nothing to do this tick
  }

  // Intentionally not awaited — lets the poll loop keep ticking so this
  // worker can pick up additional jobs concurrently up to MAX_CONCURRENT.
  runJob(job).catch((err) => {
    console.error(`[${WORKER_ID}] unexpected error running job ${job.id}:`, err);
  });
}

async function startPolling() {
  await registerWorker();
  console.log(`[${WORKER_ID}] worker registered (host=${HOSTNAME}, maxConcurrent=${MAX_CONCURRENT})`);

  const pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  const heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

  return { pollTimer, heartbeatTimer };
}

// ----------------------------------------------------------------------------
// Graceful shutdown: stop claiming new work, let in-flight jobs finish
// ----------------------------------------------------------------------------

async function shutdown(timers) {
  console.log(`[${WORKER_ID}] shutting down...`);
  isShuttingDown = true;
  clearInterval(timers.pollTimer);
  clearInterval(timers.heartbeatTimer);

  await prisma.worker.update({
    where: { id: WORKER_ID },
    data: { status: 'DRAINING' },
  }).catch(() => {});

  // wait for in-flight jobs to finish, up to a hard cap
  const maxWaitMs = 30000;
  const start = Date.now();
  while (activeJobCount > 0 && Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 500));
  }

  await prisma.worker.update({
    where: { id: WORKER_ID },
    data: { status: 'OFFLINE' },
  }).catch(() => {});

  await prisma.$disconnect();
  process.exit(0);
}

// ----------------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------------

if (require.main === module) {
  startPolling()
    .then((timers) => {
      process.on('SIGTERM', () => shutdown(timers));
      process.on('SIGINT', () => shutdown(timers));
    })
    .catch((err) => {
      console.error('Failed to start worker:', err);
      process.exit(1);
    });
}

module.exports = {
  claimNextJob,
  runJob,
  handleSuccess,
  handleFailure,
  pollOnce,
};