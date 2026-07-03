// ============================================================================
// Distributed Job Scheduler — Express Server
// ============================================================================

const express = require('express');
const { Prisma } = require('@prisma/client');
const prisma = require('./lib/prisma');
const { AppError, NotFoundError } = require('./lib/errors');

const jobRoutes = require('./routes/jobRoutes');
const queueRoutes = require('./routes/queueRoutes');

const app = express();

app.use(express.json());

// ----------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api', jobRoutes);
app.use('/api', queueRoutes);

// ----------------------------------------------------------------------------
// 404 handler (no route matched)
// ----------------------------------------------------------------------------

app.use((req, res, next) => {
  next(new NotFoundError('Route'));
});

// ----------------------------------------------------------------------------
// Centralized error-handling middleware (must have 4 args)
// ----------------------------------------------------------------------------

app.use((err, req, res, next) => {
  // Known Prisma errors get mapped to sane HTTP statuses
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return res.status(409).json({
        error: {
          code: 'UNIQUE_CONSTRAINT_VIOLATION',
          message: `Duplicate value for field(s): ${err.meta?.target}`,
        },
      });
    }
    if (err.code === 'P2003') {
      return res.status(400).json({
        error: {
          code: 'FOREIGN_KEY_VIOLATION',
          message: 'Referenced record does not exist',
        },
      });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Record not found' },
      });
    }
  }

  // Our own operational errors
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
  }

  // Anything else is a genuine bug — log full detail, hide it from the client
  console.error('[UNHANDLED ERROR]', err);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
  });
});

// ----------------------------------------------------------------------------
// Graceful shutdown
// ----------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Job scheduler API listening on port ${PORT}`);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});

module.exports = app;