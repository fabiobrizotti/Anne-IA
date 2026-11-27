const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizarLinhaSpendLog, mesclarLinhasUso, construirDadosFinanceiro
} = require('../src/financeiro');

const periodo = {
  inicio: new Date('2026-11-26T00:00:00Z'), fim: new Date('2026-11-27T00:00:00Z'),
  prevInicio: new Date('2026-11-25T00:00:00Z'), prevFim: new Date('2026-11-26T00:00:00Z'),
  clientes: [{ id: 'inst-a', nome: 'Cliente A' }]
};

test('dedupe por request_id: gateway vence', () => {
  const legado = [{ request_id: 'gen-1', cliente_id: 'inst-a', nome: 'Cliente A', custo_usd: 9 }];
  const gateway = [normalizarLinhaSpendLog({
    request_id: 'gen-1', end_user: 'inst-a', model: 'openrouter/z-ai/glm-5.3',
    spend: 1, prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
    ocorrido_em: '2026-11-26T12:00:00Z'
  })];
  const linhas = mesclarLinhasUso(legado, gateway);
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].custo_usd, 1);
  assert.equal(linhas[0].origem, 'gateway');
});

test('usa nao_atribuido para end_user sem cliente', () => {
  const gateway = [normalizarLinhaSpendLog({
    request_id: 'gen-2', end_user: 'inst-teste-123', model: 'openrouter/x/y',
    spend: 2, prompt_tokens: 1, completion_tokens: 1, total_tokens: 2,
    ocorrido_em: '2026-11-26T12:00:00Z'
  })];
  const dados = construirDadosFinanceiro({ ...periodo, atual: gateway, anterior: [] });
  assert.equal(dados.por_cliente[0].cliente_id, 'nao_atribuido');
  assert.equal(dados.kpis.custo_usd, 2);
  assert.equal(dados.kpis.clientes_ativos, 0);
});

test('total_tokens zero usa prompt + completion', () => {
  const linha = normalizarLinhaSpendLog({
    request_id: 'gen-3', end_user: 'inst-a', model: 'openrouter/x/y',
    spend: 0.5, prompt_tokens: 7, completion_tokens: 3, total_tokens: 0,
    ocorrido_em: '2026-11-26T12:00:00Z'
  });
  assert.equal(linha.total_tokens, 10);
  assert.equal(linha.provedor, 'openrouter');
  assert.equal(linha.modelo, 'x/y');
});

test('agrupa dia em America/Sao_Paulo', () => {
  const gateway = [normalizarLinhaSpendLog({
    request_id: 'gen-4', end_user: 'inst-a', model: 'openrouter/x/y',
    spend: 3, prompt_tokens: 1, completion_tokens: 1, total_tokens: 2,
    ocorrido_em: '2026-11-27T02:30:00Z' // 26/11 23:30 em São Paulo
  })];
  const dados = construirDadosFinanceiro({
    ...periodo, inicio: new Date('2026-11-25T00:00:00Z'), fim: new Date('2026-11-28T00:00:00Z'),
    atual: gateway, anterior: []
  });
  assert.equal(dados.serie_diaria[0].dia, '2026-11-26');
});

test('kpis_anteriores inclui gateway', () => {
  const anterior = [normalizarLinhaSpendLog({
    request_id: 'gen-5', end_user: 'inst-a', model: 'openrouter/x/y',
    spend: 4, prompt_tokens: 2, completion_tokens: 2, total_tokens: 4,
    ocorrido_em: '2026-11-25T12:00:00Z'
  })];
  const dados = construirDadosFinanceiro({ ...periodo, atual: [], anterior });
  assert.equal(dados.kpis_anteriores.custo_usd, 4);
});

test('preserva cliente_id legado ausente do cadastro', () => {
  const legado = [{
    request_id: null, cliente_id: 'inst-sem-cadastro', nome: 'inst-sem-cadastro',
    provedor: 'ag', modelo: 'antigo', custo_usd: 1, total_tokens: 1,
    prompt_tokens: 1, completion_tokens: 0, cached_tokens: 0,
    criado_em: '2026-11-26T12:00:00Z'
  }];
  const dados = construirDadosFinanceiro({ ...periodo, atual: legado, anterior: [] });
  assert.equal(dados.por_cliente[0].cliente_id, 'inst-sem-cadastro');
});
