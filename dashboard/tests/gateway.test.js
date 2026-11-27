'use strict';

// Integração leve da rota de status do gateway: sobe um LiteLLM falso e o
// Dashboard real em portas efêmeras, sem Postgres nem Redis.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
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

async function waitFor(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Dashboard encerrou antes de escutar (código ${child.exitCode})`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(250) });
      if (res.ok) return;
    } catch { /* ainda subindo */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Dashboard não escutou em ${url}`);
}

test('litellm UI wiring', () => {
  const html = fs.readFileSync(path.join(DASHBOARD_DIR, 'public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(DASHBOARD_DIR, 'public/app.js'), 'utf8');

  for (const text of [
    'btn-sync-litellm',
    'datalist-litellm-models',
    'LiteLLM Gateway:',
    'http://litellm:4000/v1/chat/completions'
  ]) {
    assert.ok(html.includes(text), `index.html deveria conter ${text}`);
  }
  assert.ok(app.includes('/api/v1/litellm/status'));
  assert.ok(app.includes('checkLiteLLMStatus'));
  assert.ok(!/9router/i.test(html) && !/9router/i.test(app));
});

test('litellm status', async (t) => {
  let authHeaderSeen = null;
  const gateway = http.createServer((req, res) => {
    if (req.url === '/health/liveliness' || req.url === '/health/readiness') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }
    if (req.url === '/v1/models') {
      authHeaderSeen = req.headers.authorization || null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'openrouter/x', owned_by: 'openrouter' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gatewayPort = await listen(gateway);
  const dashboardPort = await freePort();

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: DASHBOARD_DIR,
    env: {
      ...process.env,
      PORT: String(dashboardPort),
      LITELLM_URL: `http://127.0.0.1:${gatewayPort}/v1`,
      LITELLM_API_KEY: 'chave-teste',
      DATABASE_URL: '',
      REDIS_URL: '',
      DASHBOARD_AUTH_ENABLED: 'true',
      DASHBOARD_USERNAME: 'admin',
      DASHBOARD_PASSWORD: 'senha-teste'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  t.after(() => {
    child.kill();
    gateway.close();
  });

  const base = `http://127.0.0.1:${dashboardPort}`;
  try {
    await waitFor(`${base}/api/health`, child);
  } catch (err) {
    throw new Error(`${err.message}\n${stderr}`);
  }

  const basic = Buffer.from('admin:senha-teste').toString('base64');
  const res = await fetch(`${base}/api/v1/litellm/status`, {
    headers: { Authorization: `Basic ${basic}` }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.gateway_url, `http://127.0.0.1:${gatewayPort}/v1`);
  assert.equal(body.chat_endpoint, `http://127.0.0.1:${gatewayPort}/v1/chat/completions`);
  assert.equal(body.healthy, true);
  assert.equal(body.total_models, 1);
  assert.equal(body.models[0].id, 'openrouter/x');
  assert.equal(body.has_api_key, true);
  assert.equal(authHeaderSeen, 'Bearer chave-teste');
});

test('financeiro fail-closed quando o gateway falha', async (t) => {
  const dashboardPort = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: DASHBOARD_DIR,
    env: {
      ...process.env,
      PORT: String(dashboardPort),
      DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/anneia',
      LITELLM_DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/litellm',
      REDIS_URL: '',
      DASHBOARD_AUTH_ENABLED: 'true',
      DASHBOARD_USERNAME: 'admin',
      DASHBOARD_PASSWORD: 'senha-teste'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  await waitFor(`http://127.0.0.1:${dashboardPort}/api/health`, child);
  const basic = Buffer.from('admin:senha-teste').toString('base64');
  const res = await fetch(`http://127.0.0.1:${dashboardPort}/api/v1/financeiro`, {
    headers: { Authorization: `Basic ${basic}` }
  });
  assert.equal(res.status, 503);
});

test('handler bloqueia usuario sem cliente_id', () => {
  const src = fs.readFileSync(path.join(DASHBOARD_DIR, 'src/server.js'), 'utf8');
  assert.match(src, /if \(!isAdmin\(req\) && !targetClienteId\) return res\.status\(403\)/);
});
