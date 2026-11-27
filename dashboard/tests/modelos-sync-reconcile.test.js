'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ErroIntegracao } = require('../src/modelos-sync-mapping');
const { criarSyncModelos } = require('../src/modelos-sync');

const SISTEMAS = ['litellm', 'langfuse'];

function fakePool(rows = []) {
  const state = new Map();
  const writes = [];
  const chave = (id, sistema) => `${id}:${sistema}`;
  const montarSync = (id) => Object.fromEntries(SISTEMAS.map((sistema) => {
    const atual = state.get(chave(id, sistema));
    return [sistema, atual ? {
      status: atual.status,
      external_id: atual.external_id,
      ultimo_erro: atual.ultimo_erro
    } : {}];
  }));

  return {
    state,
    writes,
    async query(sql, params = []) {
      if (sql.includes('LEFT JOIN modelos_sync_estado')) {
        return { rows: rows.map((r) => ({ ...r, sync: montarSync(r.id) })) };
      }
      if (sql.includes('FROM modelos_sync_estado WHERE modelo_id')) {
        return { rows: SISTEMAS.filter((s) => state.has(chave(params[0], s)))
          .map((s) => ({ sistema: s, ...state.get(chave(params[0], s)) })) };
      }
      if (sql.includes('INSERT INTO modelos_sync_estado')) {
        writes.push({ sql, params: [...params] });
        state.set(chave(params[0], params[1]), {
          status: params[3],
          external_id: params[2],
          ultimo_erro: params[4]
        });
        return { rows: [] };
      }
      throw new Error(`query inesperada: ${sql.slice(0, 100)}`);
    }
  };
}

function gwFake({ lista = [], criar, atualizar, remover } = {}) {
  return {
    chamadas: { listar: 0, criar: [], atualizar: [], remover: [] },
    async listar() {
      this.chamadas.listar++;
      return [...lista];
    },
    async criar(row) {
      this.chamadas.criar.push(row);
      return criar ? criar(row) : 'g-1';
    },
    async atualizar(id, row) {
      this.chamadas.atualizar.push({ id, row });
      return atualizar ? atualizar(id, row) : id;
    },
    async remover(id) {
      this.chamadas.remover.push(id);
      return remover ? remover(id) : undefined;
    }
  };
}

const row = {
  id: 1,
  provedor: 'openrouter',
  modelo: 'openai/gpt-4o-mini',
  ativo: true,
  input_per_1m: '2.5',
  output_per_1m: '15'
};

describe('orquestrador modelos-sync', () => {
  it('falha em um sistema não apaga a escrita local e marca pendente', async () => {
    const pool = fakePool([row]);
    const ruim = gwFake({ criar: () => { throw new ErroIntegracao(503, 'indisponível'); } });
    const bom = gwFake({ criar: () => 'lf-1' });
    const s = criarSyncModelos({ pool, litellm: ruim, langfuse: bom });

    assert.deepEqual(await s.aplicarModelo(row), { litellm: 'pendente', langfuse: 'sincronizado' });

    const escritaRuim = pool.writes.find((w) => w.params[1] === 'litellm');
    assert.deepEqual(escritaRuim.params.slice(0, 5),
      [1, 'litellm', null, 'pendente', 'HTTP 503: indisponível']);
    assert.match(escritaRuim.sql, /INSERT INTO modelos_sync_estado \(modelo_id, sistema, external_id, status, ultimo_erro, sincronizado_em\)/);
    assert.match(escritaRuim.sql, /VALUES \(\$1,\$2,\$3,\$4,\$5,NOW\(\)\)/);
    assert.match(escritaRuim.sql, /ON CONFLICT \(modelo_id, sistema\) DO UPDATE SET/);
    assert.deepEqual(pool.writes.find((w) => w.params[1] === 'langfuse').params.slice(0, 4),
      [1, 'langfuse', 'lf-1', 'sincronizado']);
  });

  it('listar devolve sync por sistema com status, external_id e ultimo_erro', async () => {
    const pool = fakePool([row]);
    pool.state.set('1:litellm', { status: 'sincronizado', external_id: 'g-1', ultimo_erro: null });
    pool.state.set('1:langfuse', {
      status: 'pendente', external_id: 'lf-1', ultimo_erro: 'HTTP 503: indisponível'
    });
    const s = criarSyncModelos({ pool, litellm: gwFake(), langfuse: gwFake() });
    const [linha] = await s.listar();
    assert.deepEqual(linha.sync, {
      litellm: { status: 'sincronizado', external_id: 'g-1', ultimo_erro: null },
      langfuse: { status: 'pendente', external_id: 'lf-1', ultimo_erro: 'HTTP 503: indisponível' }
    });
  });

  it('com external_id usa atualizar; sem external_id usa criar', async () => {
    const pool = fakePool([row]);
    pool.state.set('1:litellm', { status: 'sincronizado', external_id: 'g-1', ultimo_erro: null });
    pool.state.set('1:langfuse', { status: 'sincronizado', external_id: 'lf-1', ultimo_erro: null });
    const l = gwFake();
    const f = gwFake();
    const s = criarSyncModelos({ pool, litellm: l, langfuse: f });

    assert.deepEqual(await s.aplicarModelo(row),
      { litellm: 'sincronizado', langfuse: 'sincronizado' });
    assert.deepEqual(l.chamadas.atualizar.map((c) => c.id), ['g-1']);
    assert.deepEqual(f.chamadas.atualizar.map((c) => c.id), ['lf-1']);
    assert.equal(l.chamadas.criar.length, 0);
    assert.equal(f.chamadas.criar.length, 0);
    // A listagem é obrigatória para provar que o objeto não é gerenciado.
    assert.equal(f.chamadas.listar, 1);
  });

  it('LiteLLM não propagado vira nao_aplicavel sem chamar o adapter', async () => {
    const rowOpencode = { ...row, provedor: 'opencode' };
    const pool = fakePool([rowOpencode]);
    const l = gwFake();
    const f = gwFake();
    const s = criarSyncModelos({ pool, litellm: l, langfuse: f });

    assert.deepEqual(await s.aplicarModelo(rowOpencode),
      { litellm: 'nao_aplicavel', langfuse: 'sincronizado' });
    assert.equal(l.chamadas.criar.length, 0);
    assert.equal(l.chamadas.atualizar.length, 0);
    assert.equal(pool.state.get('1:litellm').status, 'nao_aplicavel');
  });

  it('modelo gerenciado pelo Langfuse vira nao_aplicavel e não é criado', async () => {
    const pool = fakePool([row]);
    const l = gwFake();
    const f = gwFake({ lista: [{
      id: 'lf-x', nome: 'openrouter/openai/gpt-4o-mini',
      scope: 'ORGANIZATION', isLangfuseManaged: true
    }] });
    const s = criarSyncModelos({ pool, litellm: l, langfuse: f });

    assert.deepEqual(await s.aplicarModelo(row),
      { litellm: 'sincronizado', langfuse: 'nao_aplicavel' });
    assert.equal(f.chamadas.criar.length, 0);
    assert.equal(pool.state.get('1:langfuse').external_id, 'lf-x');
    assert.equal(pool.state.get('1:langfuse').status, 'nao_aplicavel');
  });

  it('não sobrescreve modelo gerenciado pelo Langfuse em execuções repetidas', async () => {
    const pool = fakePool([row]);
    pool.state.set('1:langfuse', {
      status: 'sincronizado', external_id: 'lf-x', ultimo_erro: null
    });
    const l = gwFake();
    const f = gwFake({ lista: [{
      id: 'lf-x', nome: 'openrouter/openai/gpt-4o-mini',
      scope: 'LANGFUSE', isLangfuseManaged: true
    }] });
    const s = criarSyncModelos({ pool, litellm: l, langfuse: f });

    assert.deepEqual(await s.aplicarModelo(row),
      { litellm: 'sincronizado', langfuse: 'nao_aplicavel' });
    assert.deepEqual(await s.aplicarModelo(row),
      { litellm: 'sincronizado', langfuse: 'nao_aplicavel' });

    const r1 = await s.reconciliar();
    const r2 = await s.reconciliar();

    assert.equal(r1.pendentes, 0);
    assert.equal(r2.pendentes, 0);
    assert.equal(f.chamadas.atualizar.length, 0);
    assert.equal(f.chamadas.criar.length, 0);
    assert.equal(pool.state.get('1:langfuse').status, 'nao_aplicavel');
    assert.equal(pool.state.get('1:langfuse').external_id, 'lf-x');
  });

  it('detecta modelo gerenciado pelo slug mesmo com external_id divergente', async () => {
    const pool = fakePool([row]);
    pool.state.set('1:langfuse', {
      status: 'sincronizado', external_id: 'lf-antigo', ultimo_erro: null
    });
    const f = gwFake({ lista: [{
      id: 'lf-outro', nome: 'openrouter/openai/gpt-4o-mini', scope: 'ORGANIZATION'
    }] });

    const resultado = await criarSyncModelos({ pool, litellm: gwFake(), langfuse: f })
      .aplicarModelo(row);

    assert.deepEqual(resultado, { litellm: 'sincronizado', langfuse: 'nao_aplicavel' });
    assert.equal(f.chamadas.atualizar.length, 0);
    assert.equal(f.chamadas.criar.length, 0);
    assert.equal(pool.state.get('1:langfuse').external_id, 'lf-antigo');
  });

  it('falha ao listar no Langfuse vira pendente sem criar às cegas', async () => {
    const pool = fakePool([row]);
    const l = gwFake();
    const f = {
      listar: async () => { throw new ErroIntegracao(401, 'credenciais Langfuse ausentes'); },
      criar: async () => { throw new Error('não deveria criar'); },
      atualizar: async () => { throw new Error('não deveria atualizar'); },
      remover: async () => {}
    };
    const s = criarSyncModelos({ pool, litellm: l, langfuse: f });

    assert.deepEqual(await s.aplicarModelo(row),
      { litellm: 'sincronizado', langfuse: 'pendente' });
    assert.equal(pool.state.get('1:langfuse').ultimo_erro,
      'HTTP 401: credenciais Langfuse ausentes');
  });

  it('removerModelo preserva external_id no sucesso e na falha, e não chama sem id', async () => {
    const pool = fakePool([row]);
    pool.state.set('1:litellm', { status: 'sincronizado', external_id: 'g-1', ultimo_erro: null });
    pool.state.set('1:langfuse', { status: 'sincronizado', external_id: 'lf-1', ultimo_erro: null });
    const l = gwFake();
    const f = gwFake({ remover: () => { throw new ErroIntegracao(403, 'não autorizado'); } });
    const s = criarSyncModelos({ pool, litellm: l, langfuse: f });

    assert.deepEqual(await s.removerModelo(row), { litellm: 'removido', langfuse: 'pendente' });
    assert.deepEqual(l.chamadas.remover, ['g-1']);
    assert.deepEqual(f.chamadas.remover, ['lf-1']);
    assert.equal(pool.state.get('1:litellm').external_id, 'g-1');
    assert.equal(pool.state.get('1:langfuse').external_id, 'lf-1');
    assert.equal(pool.state.get('1:langfuse').ultimo_erro, 'HTTP 403: não autorizado');

    const poolSemId = fakePool([]);
    const lSemId = gwFake();
    const fSemId = gwFake();
    assert.deepEqual(
      await criarSyncModelos({ pool: poolSemId, litellm: lSemId, langfuse: fSemId })
        .removerModelo({ ...row, id: 2 }),
      { litellm: 'removido', langfuse: 'removido' }
    );
    assert.equal(lSemId.chamadas.remover.length, 0);
    assert.equal(fSemId.chamadas.remover.length, 0);
    assert.equal(poolSemId.state.get('2:litellm').status, 'removido');
  });

  it('reconcilia ativos e inativos com contadores corretos', async () => {
    const inativoComId = { ...row, id: 2, modelo: 'openai/gpt-4.1', ativo: false };
    const inativoSemId = { ...row, id: 3, modelo: 'openai/o3', ativo: false };
    const pool = fakePool([row, inativoComId, inativoSemId]);
    pool.state.set('2:litellm', { status: 'sincronizado', external_id: 'g-2', ultimo_erro: null });
    pool.state.set('2:langfuse', { status: 'sincronizado', external_id: 'lf-2', ultimo_erro: null });
    const l = gwFake();
    const f = gwFake();

    const r = await criarSyncModelos({ pool, litellm: l, langfuse: f }).reconciliar();

    assert.equal(r.criados, 2);
    assert.equal(r.atualizados, 0);
    assert.equal(r.removidos, 2);
    assert.equal(r.pendentes, 0);
    assert.equal(r.orfos_observados, 0);
    assert.deepEqual(r.erros, []);
    assert.equal(l.chamadas.criar.length, 1);
    assert.equal(l.chamadas.remover.length, 1);
    assert.equal(pool.state.get('3:litellm').status, 'removido');
    assert.equal(pool.state.get('3:langfuse').status, 'removido');
  });

  it('inativo removido não é recriado pela reconciliação', async () => {
    const pool = fakePool([{ ...row, ativo: false }]);
    let criou = 0;
    const gw = gwFake({ criar: () => { criou++; return 'g-1'; } });

    const r = await criarSyncModelos({ pool, litellm: gw, langfuse: gw }).reconciliar();

    assert.equal(criou, 0);
    assert.equal(r.criados, 0);
    assert.equal(r.pendentes, 0);
  });

  it('conta órfãos sem deletar', async () => {
    const pool = fakePool([]);
    const gw = gwFake({ lista: [{ id: 'x', nome: 'criado-fora' }] });

    const r = await criarSyncModelos({ pool, litellm: gw, langfuse: gw }).reconciliar();

    assert.equal(r.orfos_observados, 2);
    assert.equal(gw.chamadas.remover.length, 0);
  });

  it('nao_aplicavel não entra em pendentes e não é deletado', async () => {
    const rowOpencode = { ...row, provedor: 'opencode' };
    const pool = fakePool([rowOpencode]);
    const l = gwFake();
    const f = gwFake();

    const r = await criarSyncModelos({ pool, litellm: l, langfuse: f }).reconciliar();

    assert.equal(l.chamadas.criar.length, 0);
    assert.equal(l.chamadas.remover.length, 0);
    assert.equal(r.pendentes, 0);
    assert.equal(pool.state.get('1:litellm').status, 'nao_aplicavel');
    // Spec: todos os modelos ativos são enviados ao Langfuse (catálogo de preço, não rota).
    assert.equal(f.chamadas.criar.length, 1);
  });

  it('reconciliação repetida reaproveita o external_id sem duplicar', async () => {
    const pool = fakePool([row]);
    const l = gwFake();
    const f = gwFake();
    const s = criarSyncModelos({ pool, litellm: l, langfuse: f });

    const r1 = await s.reconciliar();
    const r2 = await s.reconciliar();

    assert.equal(r1.criados, 2);
    assert.equal(r2.criados, 0);
    assert.equal(r2.atualizados, 2);
    assert.equal(l.chamadas.criar.length, 1);
    assert.equal(l.chamadas.atualizar.length, 1);
    assert.equal(f.chamadas.criar.length, 1);
  });

  it('falha ao ler estado não derruba aplicarModelo nem cria às cegas', async () => {
    const pool = {
      async query(sql) {
        if (sql.includes('FROM modelos_sync_estado WHERE modelo_id')) {
          throw Object.assign(new Error('vazou o stack'), { status: 503, mensagem: 'indisponível' });
        }
        return { rows: [] };
      }
    };
    const l = gwFake();
    const f = gwFake();

    assert.deepEqual(
      await criarSyncModelos({ pool, litellm: l, langfuse: f }).aplicarModelo(row),
      { litellm: 'pendente', langfuse: 'pendente' }
    );
    assert.equal(l.chamadas.criar.length, 0);
    assert.equal(f.chamadas.criar.length, 0);
  });

  it('deduplica mensagens repetidas em resumo.erros', async () => {
    const pool = fakePool([row, { ...row, id: 2, modelo: 'openai/gpt-4.1' }]);
    const f = {
      listar: async () => { throw new ErroIntegracao(401, 'credenciais Langfuse ausentes'); },
      criar: async () => { throw new Error('não deveria criar'); },
      atualizar: async () => { throw new Error('não deveria atualizar'); },
      remover: async () => {}
    };

    const r = await criarSyncModelos({ pool, litellm: gwFake(), langfuse: f }).reconciliar();

    assert.equal(r.pendentes, 2);
    assert.deepEqual(r.erros, ['HTTP 401: credenciais Langfuse ausentes']);
  });

  it('erros da reconciliação são apenas mensagens sanitizadas', async () => {
    const pool = fakePool([row]);
    const erro = new ErroIntegracao(500, 'indisponível');
    erro.stack = 'vazou o stack com secret';
    erro.response = { body: 'vazou o corpo com secret' };
    const ruim = gwFake({ criar: () => { throw erro; } });

    const r = await criarSyncModelos({ pool, litellm: ruim, langfuse: gwFake() }).reconciliar();

    assert.equal(r.pendentes, 1);
    assert.deepEqual(r.erros, ['HTTP 500: indisponível']);
    assert.equal(pool.state.get('1:litellm').ultimo_erro, 'HTTP 500: indisponível');
    assert.ok(!JSON.stringify(r).includes('secret'));
  });
});
