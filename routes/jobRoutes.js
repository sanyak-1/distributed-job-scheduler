// ============================================================================
// routes/jobRoutes.js
// ============================================================================

const express = require('express');
const asyncHandler = require('../lib/asyncHandler');
const jobController = require('../controllers/jobController');

const router = express.Router();

// POST /api/jobs
router.post('/jobs', asyncHandler(jobController.createJob));

// GET /api/jobs/:id
router.get('/jobs/:id', asyncHandler(jobController.getJob));

module.exports = router;