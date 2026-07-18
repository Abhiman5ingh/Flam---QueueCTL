'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PID_FILE, LOG_DIR, ensureDirs } = require('./paths');

ensureDirs();

function readPidFile() {
  if (!fs.existsSync(PID_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writePidFile(pids) {
  fs.writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startWorkers(count) {
  const workerScript = path.join(__dirname, 'worker.js');
  const existing = readPidFile().filter((p) => isAlive(p.pid));
  const started = [];

  for (let i = 0; i < count; i++) {
    const logPath = path.join(LOG_DIR, `worker-${Date.now()}-${i}.log`);
    const logFd = fs.openSync(logPath, 'a');
    const child = spawn(process.execPath, [workerScript], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);
    started.push({ pid: child.pid, startedAt: new Date().toISOString(), log: logPath });
  }

  writePidFile([...existing, ...started]);
  return started;
}

function stopWorkers({ timeoutMs = 8000 } = {}) {
  const entries = readPidFile();
  const alive = entries.filter((p) => isAlive(p.pid));

  if (alive.length === 0) {
    writePidFile([]);
    return { stopped: [], notRunning: entries.length };
  }

  for (const { pid } of alive) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }

  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const stillAlive = alive.filter((p) => isAlive(p.pid));
      if (stillAlive.length === 0 || Date.now() - start > timeoutMs) {
        clearInterval(interval);
        // Force-kill anything that didn't exit in time.
        for (const p of stillAlive) {
          try {
            process.kill(p.pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
        writePidFile([]);
        resolve({
          stopped: alive.map((p) => p.pid),
          forceKilled: stillAlive.map((p) => p.pid),
        });
      }
    }, 200);
  });
}

function activeWorkers() {
  const entries = readPidFile().filter((p) => isAlive(p.pid));
  writePidFile(entries);
  return entries;
}

module.exports = { startWorkers, stopWorkers, activeWorkers };
