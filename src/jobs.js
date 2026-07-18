'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const config = require('./config');

const VALID_STATES = ['pending', 'processing', 'completed', 'failed', 'dead'];

function nowIso() {
  return new Date().toISOString();
}

class JobExistsError extends Error {
  constructor(id) {
    super(`Job with id "${id}" already exists`);
    this.name = 'JobExistsError';
  }
}

/**
 * Enqueue a new job. `id` is optional (a UUID is generated if omitted).
 * `max_retries` / `backoff_base` fall back to global config.
 */
function enqueue({ id, command, max_retries, backoff_base, priority, timeout_ms, run_at, delay_seconds }) {
  if (!command || typeof command !== 'string') {
    throw new Error('A "command" string is required');
  }
  const jobId = id || uuidv4();
  const existing = db.prepare('SELECT id FROM jobs WHERE id = ?').get(jobId);
  if (existing) throw new JobExistsError(jobId);

  const mr = max_retries !== undefined ? Number(max_retries) : config.get('max_retries', 3);
  const bb = backoff_base !== undefined ? Number(backoff_base) : config.get('backoff_base', 2);
  const prio = priority !== undefined ? Number(priority) : 0;
  const timeout = timeout_ms !== undefined ? Number(timeout_ms) : 0;

  let nextRunAt = null;
  if (run_at) {
    nextRunAt = new Date(run_at).toISOString();
  } else if (delay_seconds !== undefined) {
    nextRunAt = new Date(Date.now() + Number(delay_seconds) * 1000).toISOString();
  }

  const ts = nowIso();

  db.prepare(
    `INSERT INTO jobs (id, command, state, attempts, max_retries, backoff_base, priority, timeout_ms, next_run_at, created_at, updated_at)
     VALUES (?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?)`
  ).run(jobId, command, mr, bb, prio, timeout, nextRunAt, ts, ts);

  return jobId;
}

/**
 * Atomically claim the next runnable job for a worker.
 *
 * Uses an IMMEDIATE transaction so that even with multiple OS processes
 * sharing the same SQLite file, only one worker can ever transition a
 * given job out of 'pending'/'failed' at a time -- this is what prevents
 * duplicate processing without any external lock manager.
 */
function claimNext(workerId) {
  const now = nowIso();
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    const candidate = db
      .prepare(
        `SELECT id FROM jobs
         WHERE (state = 'pending' AND (next_run_at IS NULL OR next_run_at <= ?))
            OR (state = 'failed' AND (next_run_at IS NULL OR next_run_at <= ?))
         ORDER BY priority DESC, created_at ASC
         LIMIT 1`
      )
      .get(now, now);

    if (!candidate) {
      db.prepare('COMMIT').run();
      return null;
    }

    db.prepare(
      `UPDATE jobs SET state = 'processing', worker_id = ?, updated_at = ? WHERE id = ?`
    ).run(workerId, now, candidate.id);

    db.prepare('COMMIT').run();
    return db.prepare('SELECT * FROM jobs WHERE id = ?').get(candidate.id);
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}

function completeJob(id, output) {
  db.prepare(
    `UPDATE jobs SET state = 'completed', output = ?, worker_id = NULL, updated_at = ? WHERE id = ?`
  ).run(output ?? null, nowIso(), id);
}

/**
 * Record a failed execution. Moves the job to 'dead' (DLQ) once
 * max_retries is exhausted, otherwise schedules a retry using
 * exponential backoff: delay = backoff_base ^ attempts seconds.
 */
function failJob(id, errorMessage, output) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return;

  const attempts = job.attempts + 1;
  const now = nowIso();

  if (attempts >= job.max_retries) {
    db.prepare(
      `UPDATE jobs
       SET state = 'dead', attempts = ?, last_error = ?, output = ?, worker_id = NULL, updated_at = ?
       WHERE id = ?`
    ).run(attempts, errorMessage ?? null, output ?? null, now, id);
    return { moved_to_dlq: true, delay_seconds: null };
  }

  const delaySeconds = Math.pow(job.backoff_base, attempts);
  const nextRunAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

  db.prepare(
    `UPDATE jobs
     SET state = 'failed', attempts = ?, last_error = ?, output = ?, worker_id = NULL,
         next_run_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(attempts, errorMessage ?? null, output ?? null, nextRunAt, now, id);

  return { moved_to_dlq: false, delay_seconds: delaySeconds };
}

function listJobs(state) {
  if (state) {
    if (!VALID_STATES.includes(state)) {
      throw new Error(`Invalid state "${state}". Valid states: ${VALID_STATES.join(', ')}`);
    }
    return db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY created_at ASC').all(state);
  }
  return db.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all();
}

function getJob(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function statusSummary() {
  const rows = db.prepare('SELECT state, COUNT(*) as count FROM jobs GROUP BY state').all();
  const summary = { pending: 0, processing: 0, completed: 0, failed: 0, dead: 0 };
  for (const r of rows) summary[r.state] = r.count;
  return summary;
}

function dlqList() {
  return listJobs('dead');
}

/** Reset a dead job back to pending, clearing retry/error state. */
function dlqRetry(id) {
  const job = getJob(id);
  if (!job) throw new Error(`Job "${id}" not found`);
  if (job.state !== 'dead') {
    throw new Error(`Job "${id}" is not in the DLQ (current state: ${job.state})`);
  }
  db.prepare(
    `UPDATE jobs
     SET state = 'pending', attempts = 0, next_run_at = NULL, last_error = NULL, updated_at = ?
     WHERE id = ?`
  ).run(nowIso(), id);
}

module.exports = {
  enqueue,
  claimNext,
  completeJob,
  failJob,
  listJobs,
  getJob,
  statusSummary,
  dlqList,
  dlqRetry,
  JobExistsError,
  VALID_STATES,
};
