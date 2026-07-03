// ============================================================================
// controllers/queueController.js
// ============================================================================

const prisma = require('../lib/prisma');
const { NotFoundError } = require('../lib/errors');

// Statuses we always report, even if their count is 0, so the response
// shape is stable for dashboards/consumers.
const METRIC_STATUSES = ['PENDING', 'SCHEDULED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD_LETTER', 'CANCELLED'];

// ----------------------------------------------------------------------------
// GET /api/queues/:id/metrics
// ----------------------------------------------------------------------------

async function getQueueMetrics(req, res) {
  const { id: queueId } = req.params;

  const queue = await prisma.queue.findUnique({ where: { id: queueId } });
  if (!queue) {
    throw new NotFoundError('Queue');
  }

  const grouped = await prisma.job.groupBy({
    by: ['status'],
    where: { queueId },
    _count: { _all: true },
  });

  // Seed every status at 0, then overlay the actual counts we got back.
  const counts = METRIC_STATUSES.reduce((acc, status) => {
    acc[status] = 0;
    return acc;
  }, {});

  let total = 0;
  for (const row of grouped) {
    counts[row.status] = row._count._all;
    total += row._count._all;
  }

  res.json({
    data: {
      queueId,
      queueName: queue.name,
      total,
      counts,
      generatedAt: new Date().toISOString(),
    },
  });
}

module.exports = { getQueueMetrics };