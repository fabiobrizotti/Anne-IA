'use strict';

// Regressões do fluxo de conexão: respostas sem QR e cache do estado.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const DASHBOARD_DIR = path.join(__dirname, '..');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function freePort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function dashboard(port, evolutionPort) {
  return spawn(process.execPath, ['src/server.js'], {
    cwd: DASHBOARD_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      EVOLUTION_API_URL: `http://127.0.0.1:${evolutionPort}`,
      EVOLUTION_API_KEY: 'chave-teste',
      DATABASE_URL: '',
      REDIS_URL: '',
      DASHBOARD_AUTH_ENABLED: 'true',
      DASHBOARD_USERNAME: 'admin',
      DASHBOARD_PASSWORD: 'senha-teste'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Dashboard encerrou (código ${child.exitCode})`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(250) });
      if (res.ok) return;
    } catch { /* ainda subindo */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Dashboard não escutou em ${url}`);
}

function authHeaders() {
  return { Authorization: `Basic ${Buffer.from('admin:senha-teste').toString('base64')}` };
}

test('connect espera o QR quando a primeira resposta da Evolution vem vazia', async (t) => {
  let connectCalls = 0;
  const evolution = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/instance/connect/diag') {
      connectCalls += 1;
      const body = connectCalls === 1
        ? { instance: { instanceName: 'diag', state: 'connecting' } }
        : { pairingCode: null, code: 'QR-BAILEYS', base64: 'QUJD', count: 1 };
      res.end(JSON.stringify(body));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const evolutionPort = await listen(evolution);
  const port = await freePort();
  const child = dashboard(port, evolutionPort);
  t.after(() => { child.kill(); evolution.close(); });

  await waitFor(`http://127.0.0.1:${port}/api/health`, child);

  const res = await fetch(`http://127.0.0.1:${port}/api/v1/instances/diag/connect`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.base64, 'QUJD');
  assert.ok(connectCalls >= 2, `esperava nova consulta à Evolution, houve ${connectCalls}`);
});

test('status não é cacheado pelo navegador', async (t) => {
  const evolution = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ instance: { instanceName: 'diag', state: 'connecting' } }));
  });
  const evolutionPort = await listen(evolution);
  const port = await freePort();
  const child = dashboard(port, evolutionPort);
  t.after(() => { child.kill(); evolution.close(); });

  await waitFor(`http://127.0.0.1:${port}/api/health`, child);

  const url = `http://127.0.0.1:${port}/api/v1/instances/diag/status`;
  const first = await fetch(url, { headers: authHeaders() });
  assert.equal(first.status, 200);
  assert.match(first.headers.get('cache-control') || '', /no-store/);

  const second = await fetch(url, {
    headers: { ...authHeaders(), 'If-None-Match': first.headers.get('etag') || '"estado-antigo"' }
  });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).state, 'connecting');
});
