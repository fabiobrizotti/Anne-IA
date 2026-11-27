'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('rotas modelos-sync', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  it('rota de sincronização é admin-only e com rate limit', () => {
    const i = src.indexOf("app.post('/api/v1/modelos/sincronizar'");
    assert.ok(i > 0);
    const bloco = src.slice(i, i + 500);
    assert.match(bloco, /isAdmin\(req\)/);
    assert.match(bloco, /checkTestRateLimitRedis/);
  });
  it('POST e PUT usam o slug canônico no teste de inferência', () =>
    assert.match(src, /model:\s*slugModelo\(record\)/));
  it('boot não derruba o dashboard se a reconciliação falhar', () =>
    assert.match(src, /reconciliar\(\)\.catch/));
});
