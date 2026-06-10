/**
 * Async job backbone (Stage 2 needs this: prior auths take days).
 *
 * Postgres-backed when DATABASE_URL is set (claim with FOR UPDATE SKIP LOCKED),
 * in-memory otherwise. A worker registers handlers per `kind` and polls.
 */

import { pool, databaseEnabled } from './db.js';

class PostgresQueue {
  async enqueue(kind, payload = {}, runAfter = new Date()) {
    const { rows } = await pool.query(
      `INSERT INTO jobs (kind, payload, run_after) VALUES ($1,$2,$3) RETURNING id`,
      [kind, payload, runAfter]
    );
    return rows[0].id;
  }

  async claim() {
    const { rows } = await pool.query(
      `UPDATE jobs SET status='running', attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM jobs
         WHERE status='queued' AND run_after <= now()
         ORDER BY run_after
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING id, kind, payload, attempts`
    );
    return rows[0] ?? null;
  }

  async complete(id) {
    await pool.query(`UPDATE jobs SET status='done', updated_at=now() WHERE id=$1`, [id]);
  }

  async fail(id, error, retryInMs) {
    if (retryInMs != null) {
      await pool.query(
        `UPDATE jobs SET status='queued', last_error=$2,
         run_after = now() + ($3::int * interval '1 millisecond'), updated_at=now() WHERE id=$1`,
        [id, String(error), retryInMs]
      );
    } else {
      await pool.query(`UPDATE jobs SET status='failed', last_error=$2, updated_at=now() WHERE id=$1`, [id, String(error)]);
    }
  }
}

class MemoryQueue {
  constructor() {
    this.jobs = [];
    this.seq = 0;
  }
  async enqueue(kind, payload = {}, runAfter = new Date()) {
    const id = ++this.seq;
    this.jobs.push({ id, kind, payload, status: 'queued', run_after: runAfter, attempts: 0 });
    return id;
  }
  async claim() {
    const now = Date.now();
    const job = this.jobs.find((j) => j.status === 'queued' && new Date(j.run_after).getTime() <= now);
    if (!job) return null;
    job.status = 'running';
    job.attempts += 1;
    return { id: job.id, kind: job.kind, payload: job.payload, attempts: job.attempts };
  }
  async complete(id) {
    const j = this.jobs.find((x) => x.id === id);
    if (j) j.status = 'done';
  }
  async fail(id, error, retryInMs) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return;
    j.last_error = String(error);
    if (retryInMs != null) {
      j.status = 'queued';
      j.run_after = new Date(Date.now() + retryInMs);
    } else {
      j.status = 'failed';
    }
  }
}

export const queue = databaseEnabled && pool ? new PostgresQueue() : new MemoryQueue();

const MAX_ATTEMPTS = 5;

/**
 * Run one tick: claim a job, dispatch to its handler. Returns true if a job ran.
 * handlers: { [kind]: async (payload) => void }
 */
export async function runOnce(handlers) {
  const job = await queue.claim();
  if (!job) return false;
  const handler = handlers[job.kind];
  if (!handler) {
    await queue.fail(job.id, `no handler for kind ${job.kind}`);
    return true;
  }
  try {
    await handler(job.payload, job);
    await queue.complete(job.id);
  } catch (err) {
    const retry = job.attempts < MAX_ATTEMPTS ? Math.min(60_000, 2 ** job.attempts * 1000) : null;
    await queue.fail(job.id, err.message, retry);
  }
  return true;
}

/** Start a polling worker. Returns a stop() function. */
export function startWorker(handlers, intervalMs = 2000) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      // Drain available jobs each interval.
      while (await runOnce(handlers)) { /* keep draining */ }
    } catch (err) {
      console.error('[jobs] worker error:', err.message);
    }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  setTimeout(tick, intervalMs);
  return () => { stopped = true; };
}
