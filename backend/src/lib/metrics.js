import { pool } from '../db.js';

/** Tiny in-process metrics in the Prometheus text format (GET /api/metrics, protected by METRICS_TOKEN). */
const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const started = Date.now();
const byClass = {};            // "2xx" -> count
const buckets = BUCKETS.map(() => 0);
let latencyCount = 0;
let latencySum = 0;

export function observeRequest(status, seconds) {
  const cls = `${Math.floor(status / 100)}xx`;
  byClass[cls] = (byClass[cls] ?? 0) + 1;
  latencyCount += 1;
  latencySum += seconds;
  BUCKETS.forEach((b, i) => { if (seconds <= b) buckets[i] += 1; });
}

export function renderMetrics() {
  const out = [];
  out.push('# TYPE http_requests_total counter');
  for (const [cls, n] of Object.entries(byClass)) out.push(`http_requests_total{status="${cls}"} ${n}`);
  out.push('# TYPE http_request_duration_seconds histogram');
  BUCKETS.forEach((b, i) => out.push(`http_request_duration_seconds_bucket{le="${b}"} ${buckets[i]}`));
  out.push(`http_request_duration_seconds_bucket{le="+Inf"} ${latencyCount}`);
  out.push(`http_request_duration_seconds_sum ${latencySum}`);
  out.push(`http_request_duration_seconds_count ${latencyCount}`);
  out.push('# TYPE db_pool_connections gauge');
  out.push(`db_pool_connections{state="total"} ${pool.totalCount}`);
  out.push(`db_pool_connections{state="idle"} ${pool.idleCount}`);
  out.push(`db_pool_connections{state="waiting"} ${pool.waitingCount}`);
  out.push('# TYPE process_uptime_seconds gauge');
  out.push(`process_uptime_seconds ${(Date.now() - started) / 1000}`);
  out.push('# TYPE process_resident_memory_bytes gauge');
  out.push(`process_resident_memory_bytes ${process.memoryUsage().rss}`);
  return `${out.join('\n')}\n`;
}
