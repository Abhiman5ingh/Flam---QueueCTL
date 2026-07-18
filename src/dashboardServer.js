'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const jobs = require('./jobs');
const workerManager = require('./workerManager');

function startDashboard(port = 3000) {
  const htmlPath = path.join(__dirname, 'dashboard.html');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // CORS Headers just in case
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Serve UI
    if (url.pathname === '/' || url.pathname === '/index.html') {
      fs.readFile(htmlPath, 'utf8', (err, content) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Error loading dashboard HTML');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      });
      return;
    }

    // API: GET /api/status
    if (url.pathname === '/api/status' && req.method === 'GET') {
      try {
        const summary = jobs.statusSummary();
        const active = workerManager.activeWorkers();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ summary, workersCount: active.length }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: GET /api/jobs
    if (url.pathname === '/api/jobs' && req.method === 'GET') {
      try {
        const stateFilter = url.searchParams.get('state') || null;
        const list = jobs.listJobs(stateFilter);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobs: list }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // API: POST /api/dlq/retry
    if (url.pathname === '/api/dlq/retry' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (!parsed.id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing field "id" in request body' }));
            return;
          }
          jobs.dlqRetry(parsed.id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: `Job ${parsed.id} moved back to pending` }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Fallback: 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, () => {
    console.log(`QueueCTL monitoring dashboard running at http://localhost:${port}/`);
  });

  return server;
}

module.exports = { startDashboard };
