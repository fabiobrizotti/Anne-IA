'use strict';

class ErroIntegracao extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.name = 'ErroIntegracao';
    this.status = status;
    this.mensagem = mensagem;
  }
}

function slugModelo(row) {
  return `${row.provedor}/${row.modelo}`;
}

function precoPorToken(valor) {
  return Number(valor ?? 0) / 1_000_000;
}

function patternExato(slug) {
  return `(?i)^${String(slug).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

function payloadLiteLLM(row) {
  const slug = slugModelo(row);
  return {
    model_name: slug,
    litellm_params: { model: slug, api_key: 'os.environ/OPENROUTER_API_KEY' }
  };
}

function payloadLangfuse(row) {
  const slug = slugModelo(row);
  return {
    modelName: slug,
    matchPattern: patternExato(slug),
    unit: 'TOKENS',
    pricingTiers: [{
      name: 'Standard',
      isDefault: true,
      priority: 0,
      conditions: [],
      prices: {
        input: precoPorToken(row.input_per_1m),
        output: precoPorToken(row.output_per_1m)
      }
    }]
  };
}

function propagarLiteLLM(row) {
  return row?.provedor === 'openrouter' && row?.ativo === true;
}

function ehGerenciadoLangfuse(item) {
  const scope = String(item?.scope ?? '').toUpperCase();
  return scope === 'LANGFUSE' || scope === 'ORGANIZATION' || item?.isLangfuseManaged === true;
}

function resumoErro(err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  const mensagem = typeof err?.mensagem === 'string'
    ? err.mensagem.replace(/[\r\n]+/g, ' ')
    : 'erro desconhecido';
  return `HTTP ${status}: ${mensagem}`.slice(0, 200);
}

module.exports = {
  slugModelo,
  precoPorToken,
  patternExato,
  payloadLiteLLM,
  payloadLangfuse,
  propagarLiteLLM,
  ehGerenciadoLangfuse,
  resumoErro,
  ErroIntegracao
};
