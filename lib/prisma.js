// ============================================================================
// lib/prisma.js — single shared PrismaClient instance
//
// Reused by server.js (API) and can be reused by worker.js too, so the app
// doesn't open more DB connection pools than it needs to.
// ============================================================================

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

module.exports = prisma;