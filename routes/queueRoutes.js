// ============================================================================
// routes/queueRoutes.js
// ============================================================================

const express = require('express');
const asyncHandler = require('../lib/asyncHandler');
const jobController = require('../controllers/jobController');
const queueController = require('../controllers/queueController');

const router = express.Router();

// GET /api/queues/:id/jobs
router.get('/queues/:id/jobs', asyncHandler(jobController.listJobsByQueue));

// GET /api/queues/:id/metrics
router.get('/queues/:id/metrics', asyncHandler(queueController.getQueueMetrics));

module.exports = router;