/**
 * Testes unitários nativos do logger operacional (node:test).
 *
 * Cobre as regras que sustentam a aba de Logs:
 *  1. Derivação de nível a partir do status HTTP
 *  2. Origem curta por prefixo de rota
 *  3. Rotas ignoradas (anti-loop de feedback)
 *  4. Mascaramento de IP (LGPD) e sanitização/truncamento de contexto
 *  5. Cache + isolamento multi-tenant na leitura (inclui SSE)
 *  6. Nível inválido cai para `info` e mensagem é truncada
 *
 * Sem banco: `init(null)` faz o logger operar apenas em memória.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const logger = require('../src/logger');

describe('1. Classificação de nível e origem', () => {
  it('mapeia status HTTP para o nível operacional correto', () => {
    assert.equal(logger.deriveLevel(200), 'info');
    assert.equal(logger.deriveLevel(201), 'info');
    assert.equal(logger.deriveLevel(304), 'info');
    assert.equal(logger.deriveLevel(400), 'warn');
    assert.equal(logger.deriveLevel(401), 'warn');
    assert.equal(logger.deriveLevel(403), 'warn');
    assert.equal(logger.deriveLevel(404), 'warn');
    assert.equal(logger.deriveLevel(429), 'warn');
    assert.equal(logger.deriveLevel(500), 'error');
    assert.equal(logger.deriveLevel(503), 'error');
  });

  it('deriva origem curta do primeiro segmento conhecido', () => {
    assert.equal(logger.deriveOrigin('/api/v1/instances/abc/status'), 'instances');
    assert.equal(logger.deriveOrigin('/api/v1/auth/login'), 'auth');
    assert.equal(logger.deriveOrigin('/api/v1/conhecimento/bulk-delete'), 'conhecimento');
    assert.equal(logger.deriveOrigin('/api/v1/logs/stream'), 'logs');
    assert.equal(logger.deriveOrigin('/api/v1/qualquer-coisa'), 'api');
    assert.equal(logger.deriveOrigin('/api/health'), 'health');
  });

  it('ignora rotas que gerariam loop de feedback', () => {
    assert.equal(logger.shouldSkip('/api/v1/logs'), true);
    assert.equal(logger.shouldSkip('/api/v1/logs/stream'), true);
    assert.equal(logger.shouldSkip('/api/v1/logs/export'), true);
    assert.equal(logger.shouldSkip('/api/health'), true);
    assert.equal(logger.shouldSkip('/api/v1/instances'), false);
    assert.equal(logger.shouldSkip('/api/v1/auth/login'), false);
  });
});

describe('2. Higienização de dados (LGPD)', () => {
  it('mascara IPv4 preservando a rede', () => {
    assert.equal(logger.maskIp('203.0.113.42'), '203.0.113.x');
    assert.equal(logger.maskIp('::ffff:172.19.0.1'), '172.19.0.x');
  });

  it('mascara IPv6 preservando apenas o prefixo', () => {
    const mascarado = logger.maskIp('2001:db8:3333:4444:5555:6666:7777:8888');
    assert.equal(mascarado, '2001:db8:3333::x');
  });

  it('remove funções/undefined, converte bigint e limita stack trace', () => {
    const ctx = logger.sanitizeContexto({
      id: 10n,
      fn: () => {},
      nada: undefined,
      stack: 'Erro\n' + 'linha\n'.repeat(20)
    });
    assert.equal(ctx.id, '10');
    assert.equal('fn' in ctx, false);
    assert.equal('nada' in ctx, false);
    assert.ok(ctx.stack.split('\n').length <= 8);
  });

  it('trunca string longa isolada (limite por campo)', () => {
    const ctx = logger.sanitizeContexto({ payload: 'x'.repeat(10000) });
    assert.ok(ctx.payload.length <= 500);
  });

  it('trunca contexto gigante em vez de estourar a coluna jsonb', () => {
    // Muitos campos, cada um abaixo do limite individual: o total precisa ser
    // cortado para não estourar o limite de tamanho do contexto.
    const grande = {};
    for (let i = 0; i < 40; i++) grande[`campo_${i}`] = 'y'.repeat(400);

    const ctx = logger.sanitizeContexto(grande);
    const serializado = JSON.stringify(ctx);
    assert.ok(serializado.length <= 4100, `contexto ficou com ${serializado.length} bytes`);
    assert.equal(ctx.truncado, true);
  });

  it('devolve objeto vazio para contexto inválido', () => {
    assert.deepEqual(logger.sanitizeContexto(null), {});
    assert.deepEqual(logger.sanitizeContexto([1, 2]), {});
    assert.deepEqual(logger.sanitizeContexto('texto'), {});
  });
});

describe('3. Escrita e cache (sem banco)', () => {
  beforeEach(() => {
    logger.clearCache();
  });

  it('normaliza nível inválido para info e trunca mensagem longa', async () => {
    const entry = await logger.writeLog('barulhento', 'teste', 'x'.repeat(5000), {});
    assert.equal(entry.nivel, 'info');
    assert.ok(entry.mensagem.length <= 2000);
    assert.ok(String(entry.id).startsWith('tmp-'), 'sem banco o id deve ser sintético');
  });

  it('mantém a ordem mais recente primeiro no cache', async () => {
    await logger.writeLog('info', 'teste', 'primeiro');
    await logger.writeLog('info', 'teste', 'segundo');
    const cache = logger.getCacheFor({ limit: 10, isAdmin: true });
    assert.equal(cache[0].mensagem, 'segundo');
    assert.equal(cache[1].mensagem, 'primeiro');
  });

  it('não vaza logs de um tenant para outro', async () => {
    await logger.writeLog('info', 'instances', 'do tenant A', {}, 'cliente-a');
    await logger.writeLog('info', 'instances', 'do tenant B', {}, 'cliente-b');
    await logger.writeLog('error', 'server', 'global sem tenant');

    const doA = logger.getCacheFor({ limit: 50, isAdmin: false, clienteId: 'cliente-a' });
    assert.equal(doA.length, 1);
    assert.equal(doA[0].mensagem, 'do tenant A');

    const doB = logger.getCacheFor({ limit: 50, isAdmin: false, clienteId: 'cliente-b' });
    assert.equal(doB.length, 1);
    assert.equal(doB[0].mensagem, 'do tenant B');

    assert.equal(logger.getCacheFor({ limit: 50, isAdmin: false, clienteId: null }).length, 0);

    const doAdmin = logger.getCacheFor({ limit: 50, isAdmin: true });
    assert.equal(doAdmin.length, 3);
  });

  it('respeita o limite máximo do cache', async () => {
    for (let i = 0; i < 60; i++) {
      await logger.writeLog('debug', 'teste', `linha ${i}`);
    }
    assert.equal(logger.getCacheFor({ limit: 100, isAdmin: true }).length, 50);
  });

  it('prune remove entradas mais antigas que a retenção', async () => {
    const entry = await logger.writeLog('info', 'teste', 'antiga');
    // Reescreve a data para 10 dias atrás (simula histórico antigo no cache)
    const dezDiasAtras = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const cache = logger.getCacheFor({ limit: 10, isAdmin: true });
    cache[0].criado_em = dezDiasAtras;

    logger.pruneCache(5);
    assert.equal(logger.getCacheFor({ limit: 10, isAdmin: true }).length, 0);
    assert.ok(entry);
  });
});
