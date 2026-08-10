const { PrismaClient } = require('@prisma/client');

// A single shared Prisma instance. Prevents exhausting DB connections in dev
// when the server hot-reloads.
//
// connection_limit is explicitly capped here — Prisma's default pool size
// can exceed what a smaller managed Postgres plan actually supports
// underneath, and this app has grown a lot of independently-polling
// tabs/endpoints today (P&L strip, Health tab, Win Rate Tracker, several
// new admin routes), each firing its own real queries. Without an
// explicit cap, enough concurrent load can genuinely exhaust the pool —
// confirmed via a real production crash (Prisma P2024, "Timed out
// fetching a new connection from the connection pool"), not a
// theoretical concern. 10 is a conservative, safe default; raise it if
// your actual Postgres plan comfortably supports more.
const DATABASE_URL = process.env.DATABASE_URL;
const CONNECTION_LIMIT = process.env.DB_CONNECTION_LIMIT || '10';
const urlWithLimit = DATABASE_URL && !DATABASE_URL.includes('connection_limit')
  ? `${DATABASE_URL}${DATABASE_URL.includes('?') ? '&' : '?'}connection_limit=${CONNECTION_LIMIT}&pool_timeout=20`
  : DATABASE_URL;

const db = new PrismaClient({
  datasources: urlWithLimit ? { db: { url: urlWithLimit } } : undefined,
});

module.exports = db;
