'use strict';

const path = require('path');
const fs = require('fs');

// All state lives under <project_root>/data so it persists across restarts
// and is trivial to wipe for a clean slate (rm -rf data).
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'queuectl.db');
const PID_FILE = path.join(DATA_DIR, 'workers.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

module.exports = { DATA_DIR, DB_PATH, PID_FILE, LOG_DIR, ensureDirs };
