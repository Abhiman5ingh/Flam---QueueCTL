#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const jobs = require('../src/jobs');
const config = require('../src/config');
const workerManager = require('../src/workerManager');
const dashboardServer = require('../src/dashboardServer');

const program = new Command();

program
  .name('queuectl')
  .description('CLI-based background job queue with retries, exponential backoff, and a DLQ')
  .version('1.0.0');

// ---------------------------------------------------------------------------
// enqueue
// ---------------------------------------------------------------------------
program
  .command('enqueue <jobJson>')
  .description('Add a new job to the queue, e.g. queuectl enqueue \'{"id":"job1","command":"sleep 2"}\'')
  .action((jobJson) => {
    let parsed;
    try {
      parsed = JSON.parse(jobJson);
    } catch {
      console.error('Error: job payload must be valid JSON');
      process.exitCode = 1;
      return;
    }
    try {
      const id = jobs.enqueue(parsed);
      console.log(`Enqueued job "${id}" (state=pending)`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });

// ---------------------------------------------------------------------------
// worker start / stop
// ---------------------------------------------------------------------------
const worker = program.command('worker').description('Manage worker processes');

worker
  .command('start')
  .description('Start one or more worker processes')
  .option('--count <n>', 'number of workers to start', '1')
  .action((opts) => {
    const count = Number(opts.count);
    if (!Number.isInteger(count) || count < 1) {
      console.error('Error: --count must be a positive integer');
      process.exitCode = 1;
      return;
    }
    const started = workerManager.startWorkers(count);
    console.log(`Started ${started.length} worker(s):`);
    for (const w of started) console.log(`  pid=${w.pid}  log=${w.log}`);
  });

worker
  .command('stop')
  .description('Stop running workers gracefully (finishes in-flight jobs first)')
  .action(async () => {
    console.log('Sending graceful shutdown signal to workers...');
    const result = await workerManager.stopWorkers();
    if (result.stopped.length === 0 && !result.notRunning) {
      console.log('No workers were running.');
      return;
    }
    if (result.stopped?.length) console.log(`Stopped: ${result.stopped.join(', ')}`);
    if (result.forceKilled?.length) console.log(`Force-killed (timeout): ${result.forceKilled.join(', ')}`);
  });

worker
  .command('list')
  .description('List currently running worker processes')
  .action(() => {
    const active = workerManager.activeWorkers();
    if (active.length === 0) {
      console.log('No active workers.');
      return;
    }
    for (const w of active) console.log(`  pid=${w.pid}  started=${w.startedAt}  log=${w.log}`);
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
program
  .command('status')
  .description('Show summary of all job states & active workers')
  .action(() => {
    const summary = jobs.statusSummary();
    const active = workerManager.activeWorkers();
    console.log('Job states:');
    for (const [state, count] of Object.entries(summary)) {
      console.log(`  ${state.padEnd(10)} ${count}`);
    }
    console.log(`Active workers: ${active.length}`);
  });

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------
program
  .command('list')
  .description('List jobs, optionally filtered by state')
  .option('--state <state>', 'pending | processing | completed | failed | dead')
  .action((opts) => {
    let rows;
    try {
      rows = jobs.listJobs(opts.state);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    if (rows.length === 0) {
      console.log('No jobs found.');
      return;
    }
    for (const j of rows) {
      console.log(
        `${j.id}  [${j.state}]  attempts=${j.attempts}/${j.max_retries}  cmd="${j.command}"` +
          (j.next_run_at ? `  next_run_at=${j.next_run_at}` : '')
      );
    }
  });

// ---------------------------------------------------------------------------
// dlq list / retry
// ---------------------------------------------------------------------------
const dlq = program.command('dlq').description('Inspect or retry Dead Letter Queue jobs');

dlq
  .command('list')
  .description('List jobs in the DLQ')
  .action(() => {
    const rows = jobs.dlqList();
    if (rows.length === 0) {
      console.log('DLQ is empty.');
      return;
    }
    for (const j of rows) {
      console.log(`${j.id}  cmd="${j.command}"  attempts=${j.attempts}  last_error=${j.last_error || 'n/a'}`);
    }
  });

dlq
  .command('retry <jobId>')
  .description('Move a DLQ job back to pending, resetting its attempt count')
  .action((jobId) => {
    try {
      jobs.dlqRetry(jobId);
      console.log(`Job "${jobId}" moved back to pending.`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
  });

// ---------------------------------------------------------------------------
// config get / set
// ---------------------------------------------------------------------------
const cfg = program.command('config').description('Manage configuration (retry, backoff, etc.)');

cfg
  .command('set <key> <value>')
  .description('Set a config value, e.g. queuectl config set max-retries 3')
  .action((key, value) => {
    const normalizedKey = key.replace(/-/g, '_');
    config.set(normalizedKey, value);
    console.log(`Set ${normalizedKey} = ${value}`);
  });

cfg
  .command('get [key]')
  .description('Get a config value, or show all config if no key is given')
  .action((key) => {
    if (key) {
      const normalizedKey = key.replace(/-/g, '_');
      console.log(`${normalizedKey} = ${config.get(normalizedKey, '(not set)')}`);
    } else {
      const all = config.getAll();
      for (const [k, v] of Object.entries(all)) console.log(`${k} = ${v}`);
    }
  });

// ---------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------
program
  .command('info <jobId>')
  .description('Show detailed information for a specific job')
  .action((jobId) => {
    const job = jobs.getJob(jobId);
    if (!job) {
      console.error(`Error: Job "${jobId}" not found`);
      process.exitCode = 1;
      return;
    }
    console.log(`Job details:`);
    console.log(`  ID:         ${job.id}`);
    console.log(`  Command:    ${job.command}`);
    console.log(`  State:      ${job.state}`);
    console.log(`  Priority:   ${job.priority}`);
    console.log(`  Attempts:   ${job.attempts}/${job.max_retries}`);
    console.log(`  Timeout:    ${job.timeout_ms > 0 ? job.timeout_ms + 'ms' : 'none'}`);
    if (job.next_run_at) console.log(`  Next run:   ${job.next_run_at}`);
    if (job.worker_id)   console.log(`  Worker ID:  ${job.worker_id}`);
    console.log(`  Created At: ${job.created_at}`);
    console.log(`  Updated At: ${job.updated_at}`);
    if (job.last_error) {
      console.log(`\nLast Error:\n-------------------\n${job.last_error}\n-------------------`);
    }
    if (job.output) {
      console.log(`\nCaptured Output:\n-------------------\n${job.output}\n-------------------`);
    }
  });

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------
program
  .command('dashboard')
  .description('Start the web monitoring dashboard')
  .option('--port <port>', 'port to run the dashboard server on', '3000')
  .action((opts) => {
    const port = Number(opts.port);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Error: --port must be a valid port number');
      process.exitCode = 1;
      return;
    }
    dashboardServer.startDashboard(port);
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
