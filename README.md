# QueueCTL

A CLI-based background job queue system: enqueue jobs, run one or more worker
processes, retry failures with exponential backoff, and park permanently
failed jobs in a Dead Letter Queue (DLQ). Job data is persisted to SQLite so
nothing is lost across restarts.

**Tech stack:** Node.js, `better-sqlite3` (persistence), `commander` (CLI).

> **Demo video:** _[add your recorded CLI demo link here before submitting]_

---

## 1. Setup Instructions

Requires Node.js 18+.

```bash
git clone <your-repo-url>
cd queuectl
npm install

# Optional: run it as `queuectl` instead of `node bin/queuectl.js`
npm link
```

All state (SQLite DB, worker logs, PID tracking) lives under `./data/`,
created automatically on first run. Delete that folder for a clean slate.

---

## 2. Usage Examples

```bash
# Enqueue jobs (id is optional; a UUID is generated if omitted)
$ queuectl enqueue '{"id":"job1","command":"echo Hello World"}'
Enqueued job "job1" (state=pending)

$ queuectl enqueue '{"command":"sleep 2"}'
Enqueued job "3f9a1c2e-..." (state=pending)

# Enqueue with priority (higher values run first, default 0)
$ queuectl enqueue '{"id":"job-high","command":"echo High Priority","priority":10}'

# Enqueue with custom timeout (in milliseconds, e.g. 2s)
$ queuectl enqueue '{"id":"job-timeout","command":"sleep 5","timeout_ms":2000}'

# Enqueue with delayed start (delay in seconds, e.g. 60s)
$ queuectl enqueue '{"id":"job-delayed","command":"echo Delayed Job","delay_seconds":60}'

# Start 3 worker processes (detached, log to ./data/logs/*.log)
$ queuectl worker start --count 3
Started 3 worker(s):
  pid=4821  log=/path/to/data/logs/worker-...-0.log
  pid=4822  log=/path/to/data/logs/worker-...-1.log
  pid=4823  log=/path/to/data/logs/worker-...-2.log

# See what's running / what state jobs are in
$ queuectl worker list
  pid=4821  started=2026-07-18T10:00:00.000Z  log=...

$ queuectl status
Job states:
  pending    0
  processing 1
  completed  1
  failed     0
  dead       0
Active workers: 3

# List jobs, optionally filtered by state
$ queuectl list --state pending
$ queuectl list

# Inspect / retry the Dead Letter Queue
$ queuectl dlq list
job7  cmd="curl bad-host"  attempts=3  last_error=Command failed: curl bad-host

$ queuectl dlq retry job7
Job "job7" moved back to pending.

# Configuration (defaults: max_retries=3, backoff_base=2, poll_interval_ms=1000)
$ queuectl config set max-retries 5
$ queuectl config set backoff-base 3
$ queuectl config get
max_retries = 5
backoff_base = 3
poll_interval_ms = 1000

# Stop workers gracefully — each worker finishes its in-flight job first
$ queuectl worker stop
Sending graceful shutdown signal to workers...
Stopped: 4821, 4822, 4823

# Inspect a single job's details, including output (stdout/stderr) and errors
$ queuectl info job1

# Start the web monitoring dashboard
$ queuectl dashboard --port 3000
```

---

## 3. Architecture Overview

### Job lifecycle

```
pending --> processing --> completed
               |
               v
            failed  --(backoff elapses)--> pending (re-claimed)
               |
               v (max_retries exhausted)
             dead  (DLQ) --(dlq retry)--> pending
```

Every job is a row in a single `jobs` table (SQLite):

| column         | purpose                                             |
|----------------|------------------------------------------------------|
| `id`           | primary key, user-supplied or generated UUID          |
| `command`      | shell command to execute                              |
| `state`        | pending / processing / completed / failed / dead      |
| `attempts`     | number of execution attempts so far                    |
| `max_retries`  | per-job retry ceiling (falls back to global config)    |
| `backoff_base` | per-job backoff base (falls back to global config)     |
| `next_run_at`  | earliest time a `failed` job becomes eligible again     |
| `worker_id`    | which worker currently owns the job (`processing` only) |
| `last_error` / `output` | captured stdout/stderr and error message for debugging |

### Worker loop (`src/worker.js`)

Each `queuectl worker start --count N` call spawns **N separate OS
processes** (via `child_process.spawn`, detached), not threads. Each process
polls the database on an interval (`poll_interval_ms`, default 1s):

1. Try to atomically claim the next runnable job.
2. If claimed: execute `command` via a shell (`child_process.exec`).
   - Exit code 0 -> `completeJob` (state = `completed`).
   - Non-zero exit / command not found -> `failJob`, which either
     schedules a retry (`state = failed`, `next_run_at` set) or moves the
     job to the DLQ (`state = dead`) once `attempts >= max_retries`.
3. If nothing to claim: sleep for `poll_interval_ms` and try again.

**Locking / no duplicate processing:** claiming a job is done inside a
SQLite `BEGIN IMMEDIATE` transaction: select the oldest eligible job, then
`UPDATE ... WHERE state = 'pending'` (or eligible `failed`) in the same
transaction. `BEGIN IMMEDIATE` takes SQLite's file-level RESERVED lock
immediately, so if two worker processes race to claim, the second one's
transaction simply blocks until the first commits — by which point the row
is no longer in a claimable state. This gives correct mutual exclusion
across independent OS processes without any external lock service, at the
cost of serializing the claim step itself (execution still happens fully in
parallel).

**Exponential backoff:** `delay = backoff_base ^ attempts` seconds,
computed after each failed attempt. E.g. with the defaults
(`base=2, max_retries=3`): fail #1 -> retry in 2s, fail #2 -> retry in 4s,
fail #3 -> exhausted, moved to DLQ.

**Graceful shutdown:** `queuectl worker stop` sends `SIGTERM` to every
tracked worker PID. A worker's signal handler just sets a `shuttingDown`
flag — it does **not** kill the in-flight `exec` call, so the current job
runs to completion (success/failure recorded normally) before the process
exits its loop and calls `process.exit(0)`. If a worker hasn't exited after
an 8s grace period, `worker stop` force-kills it (`SIGKILL`) so the CLI
never hangs.

### Persistence

SQLite in WAL mode (`./data/queuectl.db`), accessed synchronously via
`better-sqlite3`. WAL mode allows multiple processes (CLI + N workers) to
read/write the same file concurrently. Every `queuectl` invocation is a
fresh Node process that opens the same DB file, so job/config state is
identical before and after a "restart" — there's no in-memory state to lose.

### Worker process tracking

Worker PIDs are recorded in `./data/workers.json` when started, and pruned
of dead PIDs whenever read (`worker list`, `worker stop`, `status`). Worker
stdout/stderr is redirected to per-worker log files under `./data/logs/`
for debugging, since the processes are detached from the terminal.

---

## 4. Assumptions & Trade-offs

- **Process-per-worker, not thread-per-worker.** Chosen because it's the
  simplest way to get true OS-level isolation and matches how a real job
  queue (Sidekiq, Celery, BullMQ) is typically deployed. The trade-off is
  slightly higher memory overhead per worker versus, say, `worker_threads`.
- **Polling instead of push/notify.** Simpler to reason about and fully
  correct under concurrent writers; the trade-off is up to `poll_interval_ms`
  of latency before a newly enqueued or retry-eligible job is picked up.
  Configurable via `queuectl config set poll-interval-ms <ms>`.
- **Shell execution (`exec`) rather than `execFile`.** The assignment's
  examples (`sleep 2`, `echo hello`) are shell commands, so `exec` (which
  runs through `/bin/sh`) was chosen for flexibility (pipes, env expansion).
  This does mean job commands are trusted input — no sandboxing is applied.
- **`failed` is a real, visible state**, not just an internal implementation
  detail, matching the lifecycle table in the spec. A job sits in `failed`
  between retry attempts (with `next_run_at` set) and is only reclaimed once
  that time has passed.
- **No job timeout by default** (`exec` timeout is unset). Documented as a
  known gap — see Bonus Features below for what a full timeout would add.
- **Single SQLite file, no external services.** Deliberately avoids
  Redis/RabbitMQ/etc. per the "minimal, production-grade" framing in the
  spec — SQLite's WAL mode is sufficient for correctness at this scale and
  keeps the whole thing runnable with zero external infra.
- **DLQ retry resets `attempts` to 0** rather than preserving history, on
  the assumption that a manual retry represents a deliberate "try again
  from scratch" decision. `last_error` is cleared but the row still exists
  so nothing is destroyed.

---

## 5. Testing Instructions

```bash
npm test
# or directly:
bash test/test.sh
```

The script exercises all 5 scenarios called out in the assignment against a
throwaway `./data` directory (reset at the start of the run):

1. A basic job (`echo hi`) completes successfully.
2. A failing job (`exit 1`) retries with backoff and lands in the DLQ once
   `max_retries` is exhausted.
3. Six jobs are enqueued against 2 concurrently running workers, and the
   test asserts all six show up in `completed` exactly once (no duplicate
   processing / no lost jobs).
4. A job pointing at a nonexistent binary fails gracefully (no worker
   crash) and is retried then moved to the DLQ.
5. Job/state counts are read, and then re-read via a brand-new `queuectl`
   process (each CLI invocation *is* a fresh OS process reading the same
   SQLite file, i.e. a real restart) — the two reads are asserted equal.

For manual/exploratory testing, see the Usage Examples above — every
command there is safe to run repeatedly against a scratch `./data` folder.

---

## Bonus Features Implemented

Implemented beyond the minimum bar:
- **Job Timeout Handling**: Enforce execution timeouts on individual jobs via `timeout_ms`.
- **Priority Queues**: Assign priority to jobs (higher values are executed first).
- **Scheduled/Delayed Jobs**: Delay a job using `delay_seconds` or a specific `run_at` timestamp.
- **Detailed Job logs/outputs inspection**: Inspect job details, captured stdout, stderr, and execution errors using `queuectl info <id>`.
- **Web Dashboard**: A beautiful responsive dashboard (started via `queuectl dashboard`) for monitoring workers, status counts, jobs list, logs, and retrying dead DLQ jobs with one click.
- **Per-Job Overrides**: Custom `max_retries` / `backoff_base` values per job, with custom log files.

