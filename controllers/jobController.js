// ============================================================================
// controllers/jobController.js
// ============================================================================

const prisma = require('../lib/prisma');
const { ValidationError, NotFoundError } = require('../lib/errors');

const VALID_STATUSES = ['PENDING', 'SCHEDULED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD_LETTER', 'CANCELLED'];

// ----------------------------------------------------------------------------
// Validation helpers (dependency-free; swap for zod/joi in a real project)
// ----------------------------------------------------------------------------

function validateCreateJobPayload(body) {
  const errors = [];

  if (!body.queueId || typeof body.queueId !== 'string') {
    errors.push('queueId is required and must be a string');
  }
  if (!body.name || typeof body.name !== 'string') {
    errors.push('name is required and must be a string');
  }
  if (body.payload !== undefined && (typeof body.payload !== 'object' || body.payload === null || Array.isArray(body.payload))) {
    errors.push('payload must be a JSON object');
  }
  if (body.priority !== undefined && !Number.isInteger(body.priority)) {
    errors.push('priority must be an integer');
  }
  if (body.scheduledAt !== undefined && Number.isNaN(Date.parse(body.scheduledAt))) {
    errors.push('scheduledAt must be a valid ISO date string');
  }
  if (body.maxRetries !== undefined && !Number.isInteger(body.maxRetries)) {
    errors.push('maxRetries must be an integer');
  }

  if (errors.length > 0) {
    throw new ValidationError('Invalid job payload', errors);
  }
}

function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

// ----------------------------------------------------------------------------
// POST /api/jobs
// ----------------------------------------------------------------------------

async function createJob(req, res) {
  validateCreateJobPayload(req.body);

  const {
    queueId,
    name,
    payload = {},
    priority = 0,
    scheduledAt,
    maxRetries = 3,
    timeoutMs = 30000,
    cronExpr = null,
  } = req.body;

  // Fail fast with a clean 404 instead of a raw FK constraint error from Postgres.
  const queue = await prisma.queue.findUnique({ where: { id: queueId } });
  if (!queue) {
    throw new NotFoundError('Queue');
  }

  const scheduledDate = scheduledAt ? new Date(scheduledAt) : new Date();
  const status = scheduledDate > new Date() ? 'SCHEDULED' : 'PENDING';

  const job = await prisma.job.create({
    data: {
      queueId,
      name,
      payload,
      priority,
      scheduledAt: scheduledDate,
      maxRetries,
      timeoutMs,
      cronExpr,
      status,
    },
  });

  res.status(201).json({ data: job });
}

// ----------------------------------------------------------------------------
// GET /api/jobs/:id
// ----------------------------------------------------------------------------

async function getJob(req, res) {
  const job = await prisma.job.findUnique({
    where: { id: req.params.id },
    include: { executions: { orderBy: { startedAt: 'desc' } } },
  });

  if (!job) {
    throw new NotFoundError('Job');
  }

  res.json({ data: job });
}

// ----------------------------------------------------------------------------
// GET /api/queues/:id/jobs
// Optional query params: status, page, limit
// ----------------------------------------------------------------------------

async function listJobsByQueue(req, res) {
  const { id: queueId } = req.params;
  const { status } = req.query;

  const queue = await prisma.queue.findUnique({ where: { id: queueId } });
  if (!queue) {
    throw new NotFoundError('Queue');
  }

  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    throw new ValidationError('Invalid status filter', [
      `status must be one of: ${VALID_STATUSES.join(', ')}`,
    ]);
  }

  const { page, limit, skip } = parsePagination(req.query);

  const where = { queueId, ...(status ? { status } : {}) };

  const [jobs, total] = await prisma.$transaction([
    prisma.job.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      skip,
      take: limit,
    }),
    prisma.job.count({ where }),
  ]);

  res.json({
    data: jobs,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}

module.exports = {
  createJob,
  getJob,
  listJobsByQueue,
};