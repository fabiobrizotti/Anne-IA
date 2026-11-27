'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/modelos-sync-mapping');

describe('modelos-sync > mapping', () => {
  const row = { provedor: 'openrouter', modelo: 'recursive/flint-v1.0:free',
                input_per_1m: '2.50', output_per_1m: '15', ativo: true };

  it('slug canônico', () => assert.equal(m.slugModelo(row), 'openrouter/recursive/flint-v1.0:free'));
  it('USD/1M → USD/token', () => {
    assert.equal(m.precoPorToken('2.50'), 0.0000025);
    assert.equal(m.precoPorToken('15'), 0.000015);
  });
  it('pattern exato com escape regex', () => {
    assert.equal(m.patternExato(m.slugModelo(row)), '(?i)^openrouter/recursive/flint-v1\\.0:free$');
    const metacaracteres = 'a.*+?^${}()|[]\\b';
    assert.equal(m.patternExato(metacaracteres),
      String.raw`(?i)^a\.\*\+\?\^\$\{\}\(\)\|\[\]\\b$`);
  });
  it('payload LiteLLM sem api_base e sem segredo literal', () =>
    assert.deepEqual(m.payloadLiteLLM(row), {
      model_name: m.slugModelo(row),
      litellm_params: { model: m.slugModelo(row), api_key: 'os.environ/OPENROUTER_API_KEY' }
    }));
  it('payload Langfuse usa tier default e preço por token', () =>
    assert.deepEqual(m.payloadLangfuse(row).pricingTiers, [{
      name: 'Standard', isDefault: true, priority: 0, conditions: [],
      prices: { input: 0.0000025, output: 0.000015 }
    }]));
  it('só openrouter ativo vira rota no gateway', () => {
    assert.equal(m.propagarLiteLLM(row), true);
    assert.equal(m.propagarLiteLLM({ ...row, provedor: 'opencode' }), false);
    assert.equal(m.propagarLiteLLM({ ...row, ativo: false }), false);
  });
  it('modelo gerenciado pelo Langfuse é detectado por scope', () => {
    assert.equal(m.ehGerenciadoLangfuse({ scope: 'LANGFUSE' }), true);
    assert.equal(m.ehGerenciadoLangfuse({ scope: 'ORGANIZATION' }), true);
    assert.equal(m.ehGerenciadoLangfuse({ scope: 'PROJECT', isLangfuseManaged: false }), false);
  });
  it('resumo de erro nunca carrega corpo/header', () => {
    assert.equal(m.resumoErro(new m.ErroIntegracao(500, 'indisponível')), 'HTTP 500: indisponível');

    const err = new m.ErroIntegracao(500, 'x'.repeat(300));
    Object.assign(err, {
      stack: 'SEGREDO',
      headers: { authorization: 'SEGREDO' },
      body: 'SEGREDO',
      message: 'SEGREDO'
    });
    const resumo = m.resumoErro(err);
    assert.equal(resumo.includes('SEGREDO'), false);
    // O contrato atual aplica slice(0, 200) na string completa, prefixo incluído.
    assert.ok(resumo.length <= 200, `resumo com ${resumo.length} caracteres`);
  });
});
