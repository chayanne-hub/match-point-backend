const { PrismaClient } = require('@prisma/client');

// A single shared Prisma instance. Prevents exhausting DB connections in dev
// when the server hot-reloads.
const db = new PrismaClient();

module.exports = db;
