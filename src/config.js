'use strict';

const db = require('./db');

const getStmt = db.prepare('SELECT value FROM config WHERE key = ?');
const setStmt = db.prepare(
  `INSERT INTO config (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);
const allStmt = db.prepare('SELECT key, value FROM config ORDER BY key');

function get(key, fallback) {
  const row = getStmt.get(key);
  if (!row) return fallback;
  const n = Number(row.value);
  return Number.isNaN(n) ? row.value : n;
}

function set(key, value) {
  setStmt.run(key, String(value));
}

function getAll() {
  return allStmt.all().reduce((acc, r) => {
    acc[r.key] = r.value;
    return acc;
  }, {});
}

module.exports = { get, set, getAll };
