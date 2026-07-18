'use strict';

const { exec } = require('child_process');
const util = require('util');
const jobs = require('./jobs');
const config = require('./config');

const execAsync = util.promisify(exec);

const workerId = `worker-${process.pid}`;
let shuttingDown = false;
let currentJobId = null;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${workerId}] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runJob(job) {
  currentJobId = job.id;
  log(`picked up job ${job.id} (attempt ${job.attempts + 1}/${job.max_retries}): ${job.command}`);
  const timeout = job.timeout_ms > 0 ? job.timeout_ms : 0;
  try {
    const { stdout, stderr } = await execAsync(job.command, {
      timeout: timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
    jobs.completeJob(job.id, output.trim());
    log(`job ${job.id} completed successfully`);
  } catch (err) {
    // err.code is the process exit code; missing binaries surface as err.code === 127
    // or an ENOENT-style message depending on the shell.
    let errorMessage = err.message || String(err);
    if (err.killed && timeout > 0) {
      errorMessage = `Job timed out after exceeding limit of ${timeout}ms`;
    }
    const output = (err.stdout || '') + (err.stderr ? `\n[stderr]\n${err.stderr}` : '');
    const result = jobs.failJob(job.id, errorMessage.trim(), output.trim());
    if (result.moved_to_dlq) {
      log(`job ${job.id} failed permanently, moved to DLQ`);
    } else {
      log(`job ${job.id} failed, will retry in ${result.delay_seconds}s (backoff)`);
    }
  } finally {
    currentJobId = null;
  }
}

async function mainLoop() {
  const pollIntervalMs = config.get('poll_interval_ms', 1000);
  log('worker started, polling for jobs');

  while (!shuttingDown) {
    let job = null;
    try {
      job = jobs.claimNext(workerId);
    } catch (err) {
      log(`error claiming job: ${err.message}`);
    }

    if (job) {
      await runJob(job);
    } else {
      await sleep(pollIntervalMs);
    }
  }

  log('worker stopped gracefully');
  process.exit(0);
}

function handleShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (currentJobId) {
    log(`received ${signal}, finishing job ${currentJobId} before exiting...`);
  } else {
    log(`received ${signal}, no job in progress, shutting down now`);
  }
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

mainLoop();
