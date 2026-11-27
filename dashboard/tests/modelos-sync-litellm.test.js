'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { criarAdapterLiteLLM } = require('../src/modelos-sync-litellm');
const { ErroIntegracao, payloadLiteLLM } = require('../src/modelos-sync-mapping');

describe('adapter litellm', () => {
  const row = { provedor: 'openrouter', modelo: 'openai/gpt-4o-mini',
                input_per_1m: '2.5', output_per_1m: '15', ativo: true };

  it('usa rota admin na raiz e Bearer da master key', async () => {
    const calls = [];
    const a = criarAdapterLiteLLM({ baseUrl: 'http://gw:4000', masterKey: 'mk',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      } });
    assert.deepEqual(await a.listar(), []);
    assert.equal(calls[0].url, 'http://gw:4000/model/info');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer mk');
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  });

  it('normaliza id e nome de model_info com fallback', async () => {
    const a = criarAdapterLiteLLM({ baseUrl: 'http://gw:4000', masterKey: 'mk',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
        data: [
          { model_info: { id: 'm-1' }, model_name: 'openrouter/a' },
          { id: 'm-2', name: 'openrouter/b' }
        ]
      }) }) });
    assert.deepEqual(await a.listar(), [
      { id: 'm-1', nome: 'openrouter/a' },
      { id: 'm-2', nome: 'openrouter/b' }
    ]);
  });

  it('cria e atualiza com payload canônico e devolve external id', async () => {
    const calls = [];
    const a = criarAdapterLiteLLM({ baseUrl: 'http://gw:4000', masterKey: 'mk',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ model_info: { id: 'ext-1' } }) };
      } });
    assert.equal(await a.criar(row), 'ext-1');
    assert.equal(calls[0].url, 'http://gw:4000/model/new');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), payloadLiteLLM(row));

    assert.equal(await a.atualizar('ext-1', row), 'ext-1');
    assert.equal(calls[1].url, 'http://gw:4000/model/ext-1/update');
    assert.equal(calls[1].init.method, 'PATCH');
  });

  it('response sem external id não grava id errado', async () => {
    const a = criarAdapterLiteLLM({ baseUrl: 'http://gw:4000', masterKey: 'mk',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ model_info: {} }) }) });
    await assert.rejects(() => a.criar(row),
      (e) => e instanceof ErroIntegracao && e.status === 502 && e.mensagem === 'indisponível');
  });

  it('atualizar usa o externalId conhecido quando o PATCH não devolve id', async () => {
    const calls = [];
    const a = criarAdapterLiteLLM({ baseUrl: 'http://gw:4000', masterKey: 'mk',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({}) };
      } });
    assert.equal(await a.atualizar('ext-42', row), 'ext-42');
    assert.equal(calls[0].url, 'http://gw:4000/model/ext-42/update');
    assert.equal(calls[0].init.method, 'PATCH');
  });

  it('404 em remover é idempotente e não lê corpo', async () => {
    const calls = [];
    let jsonCalls = 0;
    const a = criarAdapterLiteLLM({ baseUrl: 'http://gw:4000', masterKey: 'mk',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: false, status: 404, json: async () => { jsonCalls++; return {}; } };
      } });
    await assert.doesNotReject(() => a.remover('abc'));
    assert.equal(calls[0].url, 'http://gw:4000/model/delete');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { id: 'abc' });
    assert.equal(jsonCalls, 0);
  });

  it('5xx vira ErroIntegracao sem corpo e sem log', async () => {
    const chaves = ['log', 'info', 'warn', 'error', 'debug'];
    const originais = {};
    const logs = [];
    for (const chave of chaves) {
      originais[chave] = console[chave];
      console[chave] = (...args) => logs.push(args);
    }
    try {
      const a = criarAdapterLiteLLM({ baseUrl: 'http://gw:4000', masterKey: 'mk',
        fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ secret: 'vazou' }) }) });
      await assert.rejects(() => a.criar(row),
        (e) => e instanceof ErroIntegracao && e.status === 503 &&
          e.mensagem === 'indisponível' && !String(e.mensagem).includes('vazou') &&
          !String(e.stack).includes('vazou'));
      assert.deepEqual(logs, []);
    } finally {
      Object.assign(console, originais);
    }
  });

  it('normaliza 401, 404 e 409 apenas com a whitelist', async () => {
    const casos = [[401, 'não autorizado'], [404, 'não encontrado'], [409, 'conflito']];
    for (const [status, mensagem] of casos) {
      const a = criarAdapterLiteLLM({ baseUrl: 'http://gw:4000', masterKey: 'mk',
        fetchImpl: async () => ({ ok: false, status, json: async () => ({ secret: 'vazou' }) }) });
      await assert.rejects(() => a.criar(row),
        (e) => e instanceof ErroIntegracao && e.status === status && e.mensagem === mensagem);
    }
  });

  it('timeout com AbortController vira ErroIntegracao 504', async () => {
    const a = criarAdapterLiteLLM({ baseUrl: 'http://gw:4000', masterKey: 'mk', timeoutMs: 5,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('abortada')));
      }) });
    await assert.rejects(() => a.listar(),
      (e) => e instanceof ErroIntegracao && e.status === 504 && e.mensagem === 'timeout');
  });

  it('sem master key não faz fetch', async () => {
    let chamou = false;
    const a = criarAdapterLiteLLM({ baseUrl: 'http://gw:4000', masterKey: '',
      fetchImpl: async () => { chamou = true; } });
    await assert.rejects(() => a.listar(),
      (e) => e instanceof ErroIntegracao && e.status === 401 && e.mensagem === 'credenciais ausentes');
    assert.equal(chamou, false);
  });

  it('nunca monta rota admin sob /v1', async () => {
    let urlVista = '';
    const a = criarAdapterLiteLLM({ baseUrl: 'http://gw:4000/v1', masterKey: 'mk',
      fetchImpl: async (url) => {
        urlVista = url;
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      } });
    await a.listar();
    assert.equal(urlVista, 'http://gw:4000/model/info');
  });
});
