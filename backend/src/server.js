import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { logger, flushLogs } from './lib/logger.js';
import { captureError } from './lib/error-tracking.js';
import { isolationProblems } from './lib/isolation.js';

await pool.query('SELECT 1');

// Never serve traffic if organisations could see each other's data. (Development only warns, so a half-migrated local database can still start.)
const leaks = await isolationProblems(pool);
if (leaks.length) {
  logger.error('tenant isolation is not intact', { problems: leaks });
  if (config.isProd) { await flushLogs(); process.exit(1); }
}
const server = createApp().listen(config.port, () => logger.info('Yapha API listening', { port: config.port, env: config.isProd ? 'production' : 'development' }));

// Graceful shutdown: stop taking new connections, let in-flight requests finish (their transactions commit),
// then close the database pool. A deploy or `docker stop` sends SIGTERM; after 25 s we exit anyway.
let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info('shutting down', { signal });
  const force = setTimeout(() => { logger.error('shutdown timed out, exiting'); flushLogs().finally(() => process.exit(1)); }, 25_000);
  force.unref();
  server.close(async () => {
    await pool.end().catch((err) => logger.error('pool close failed', { err }));
    await flushLogs();
    process.exit(0);
  });
  server.closeIdleConnections?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A bug that escapes every handler leaves the process in an unknown state: log it, then restart cleanly
// (the container or process manager starts a fresh instance).
process.on('unhandledRejection', (err) => { const e = err instanceof Error ? err : new Error(String(err)); logger.error('unhandled rejection', { err: e }); captureError(e); shutdown('unhandledRejection'); });
process.on('uncaughtException', (err) => { logger.error('uncaught exception', { err }); captureError(err); shutdown('uncaughtException'); });
