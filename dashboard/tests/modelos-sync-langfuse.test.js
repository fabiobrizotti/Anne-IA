'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { criarAdapterLangfuse } = require('../src/modelos-sync-langfuse');
const { ErroIntegracao, payloadLangfuse, slugModelo } = require('../src/modelos-sync-mapping');

describe('adapter langfuse', () => {
  const row = { provedor: 'openrouter', modelo: 'openai/gpt-4o-mini',
                input_per_1m: '2.5', output_per_1m: '15', ativo: true };
  const slug = slugModelo(row);

  it('Basic Auth e payload com pricingTiers', async () => {
    let call;
    const a = criarAdapterLangfuse({ host: 'http://lf:3000', publicKey: 'pk', secretKey: 'sk',
      fetchImpl: async (url, init) => {
        call = { url, init };
        return { ok: true, status: 200, json: async () => ({ id: 'lf-1' }) };
      } });
    assert.equal(await a.criar(row), 'lf-1');
    assert.equal(call.url, 'http://lf:3000/api/public/models');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, 'Basic ' + Buffer.from('pk:sk').toString('base64'));
    assert.deepEqual(JSON.parse(call.init.body), payloadLangfuse(row));
    assert.equal(JSON.parse(call.init.body).unit, 'TOKENS');
    assert.ok(call.init.signal instanceof AbortSignal);
  });

  it('sem credenciais não faz fetch', async () => {
    let chamou = false;
    for (const credenciais of [{ publicKey: '', secretKey: 'sk' }, { publicKey: 'pk', secretKey: '' }]) {
      const a = criarAdapterLangfuse({ host: 'http://lf:3000', ...credenciais,
        fetchImpl: async () => { chamou = true; } });
      await assert.rejects(() => a.listar(),
        (e) => e instanceof ErroIntegracao && e.status === 401 &&
          e.mensagem === 'credenciais Langfuse ausentes');
    }
    assert.equal(chamou, false);
  });

  it('listar pagina até menos de 100 itens e normaliza scope', async () => {
    const calls = [];
    const pagina1 = Array.from({ length: 100 }, (_v, i) => ({
      id: `lf-${i}`, modelName: `m-${i}`, scope: 'PROJECT'
    }));
    const a = criarAdapterLangfuse({ host: 'http://lf:3000/', publicKey: 'pk', secretKey: 'sk',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        const pagina = new URL(url).searchParams.get('page');
        return { ok: true, status: 200, json: async () => ({
          data: pagina === '1' ? pagina1 : [{ id: 'lf-100', modelName: 'm-100', scope: 'ORGANIZATION' }]
        }) };
      } });
    const itens = await a.listar();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'http://lf:3000/api/public/models?page=1&limit=100');
    assert.equal(calls[1].url, 'http://lf:3000/api/public/models?page=2&limit=100');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(itens.length, 101);
    assert.deepEqual(itens[100], { id: 'lf-100', nome: 'm-100', scope: 'ORGANIZATION', isLangfuseManaged: true });
    assert.deepEqual(itens[0], { id: 'lf-0', nome: 'm-0', scope: 'PROJECT', isLangfuseManaged: false });
  });

  it('listar respeita o teto de 20 páginas', async () => {
    let paginas = 0;
    const a = criarAdapterLangfuse({ host: 'http://lf:3000', publicKey: 'pk', secretKey: 'sk',
      fetchImpl: async () => {
        paginas++;
        return { ok: true, status: 200, json: async () => ({
          data: Array.from({ length: 100 }, (_v, i) => ({ id: `x-${paginas}-${i}` }))
        }) };
      } });
    assert.equal((await a.listar()).length, 2000);
    assert.equal(paginas, 20);
  });

  it('409 reusa id existente em vez de duplicar', async () => {
    let n = 0;
    const a = criarAdapterLangfuse({ host: 'http://lf:3000', publicKey: 'pk', secretKey: 'sk',
      fetchImpl: async () => (++n === 1
        ? { ok: false, status: 409, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ data: [{ id: 'lf-9', modelName: slug, scope: 'PROJECT' }] }) }) });
    assert.equal(await a.criar(row), 'lf-9');
  });

  it('409 sem modelo de mesmo nome não cria id improvisado', async () => {
    const a = criarAdapterLangfuse({ host: 'http://lf:3000', publicKey: 'pk', secretKey: 'sk',
      fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({}) }) });
    await assert.rejects(() => a.criar(row),
      (e) => e instanceof ErroIntegracao && e.status === 409 && e.mensagem === 'conflito');
  });

  it('atualizar usa PUT na rota do id', async () => {
    let call;
    const a = criarAdapterLangfuse({ host: 'http://lf:3000', publicKey: 'pk', secretKey: 'sk',
      fetchImpl: async (url, init) => {
        call = { url, init };
        return { ok: true, status: 200, json: async () => ({ id: 'lf-1' }) };
      } });
    assert.equal(await a.atualizar('lf 1', row), 'lf-1');
    assert.equal(call.url, 'http://lf:3000/api/public/models/lf%201');
    assert.equal(call.init.method, 'PUT');
    assert.deepEqual(JSON.parse(call.init.body), payloadLangfuse(row));
  });

  it('remover aceita 204 e trata 404 como idempotente', async () => {
    for (const status of [204, 404]) {
      let jsonCalls = 0;
      let call;
      const a = criarAdapterLangfuse({ host: 'http://lf:3000', publicKey: 'pk', secretKey: 'sk',
        fetchImpl: async (url, init) => {
          call = { url, init };
          return { ok: status !== 404, status, json: async () => { jsonCalls++; return {}; } };
        } });
      await assert.doesNotReject(() => a.remover('lf-1'));
      assert.equal(call.url, 'http://lf:3000/api/public/models/lf-1');
      assert.equal(call.init.method, 'DELETE');
      assert.equal(jsonCalls, 0);
    }
  });

  it('403 em remover identifica modelo gerenciado pelo Langfuse', async () => {
    const a = criarAdapterLangfuse({ host: 'http://lf:3000', publicKey: 'pk', secretKey: 'sk',
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ secret: 'vazou' }) }) });
    await assert.rejects(() => a.remover('lf-1'),
      (e) => e instanceof ErroIntegracao && e.status === 403 &&
        e.mensagem === 'modelo gerenciado pelo Langfuse não pode ser removido' &&
        !String(e.mensagem).includes('vazou'));
  });

  it('5xx vira ErroIntegracao sem corpo, headers ou log', async () => {
    const chaves = ['log', 'info', 'warn', 'error', 'debug'];
    const originais = {};
    const logs = [];
    for (const chave of chaves) {
      originais[chave] = console[chave];
      console[chave] = (...args) => logs.push(args);
    }
    try {
      const a = criarAdapterLangfuse({ host: 'http://lf:3000', publicKey: 'pk', secretKey: 'sk',
        fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ secret: 'vazou' }) }) });
      await assert.rejects(() => a.criar(row),
        (e) => e instanceof ErroIntegracao && e.status === 503 &&
          e.mensagem === 'indisponível' && !String(e.stack).includes('vazou'));
      assert.deepEqual(logs, []);
    } finally {
      Object.assign(console, originais);
    }
  });

  it('timeout com AbortController vira ErroIntegracao 504', async () => {
    const a = criarAdapterLangfuse({ host: 'http://lf:3000', publicKey: 'pk', secretKey: 'sk', timeoutMs: 5,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('abortada')));
      }) });
    await assert.rejects(() => a.listar(),
      (e) => e instanceof ErroIntegracao && e.status === 504 && e.mensagem === 'timeout');
  });
});
