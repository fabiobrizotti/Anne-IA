'use strict';

const formatadorDia = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function normalizarLinhaUsoTokens(row = {}) {
  const prompt = Number(row.prompt_tokens || 0);
  const completion = Number(row.completion_tokens || 0);

  return {
    cliente_id: row.cliente_id,
    nome: row.nome || row.cliente_id,
    provedor: row.provedor || 'desconhecido',
    modelo: row.modelo || 'desconhecido',
    custo_usd: Number(row.custo_usd || 0),
    total_tokens: Number(row.total_tokens || 0),
    prompt_tokens: prompt,
    completion_tokens: completion,
    cached_tokens: Number(row.cached_tokens || 0),
    request_id: row.request_id,
    ocorrido_em: new Date(row.criado_em),
    origem: 'legacy'
  };
}

function normalizarLinhaSpendLog(row = {}) {
  const modeloBruto = String(row.model || '');
  const indiceBarra = modeloBruto.indexOf('/');
  const prompt = Number(row.prompt_tokens || 0);
  const completion = Number(row.completion_tokens || 0);
  const clienteId = row.end_user || 'nao_atribuido';

  return {
    cliente_id: clienteId,
    nome: row.end_user || 'Não atribuído',
    provedor: indiceBarra === -1 ? 'litellm' : modeloBruto.slice(0, indiceBarra),
    modelo: indiceBarra === -1 ? modeloBruto : modeloBruto.slice(indiceBarra + 1),
    custo_usd: Number(row.spend) || 0,
    total_tokens: Number(row.total_tokens) || prompt + completion,
    prompt_tokens: prompt,
    completion_tokens: completion,
    cached_tokens: 0,
    request_id: row.request_id,
    ocorrido_em: new Date(row.ocorrido_em),
    origem: 'gateway'
  };
}

function normalizarSePreciso(linha, origem) {
  if (linha && (linha.origem === 'legacy' || linha.origem === 'gateway')) return linha;
  return origem === 'gateway' ? normalizarLinhaSpendLog(linha) : normalizarLinhaUsoTokens(linha);
}

function mesclarLinhasUso(legado = [], gateway = []) {
  const mapa = new Map();

  for (const origem of ['legacy', 'gateway']) {
    const linhas = origem === 'gateway' ? gateway : legado;
    for (const linhaCrua of linhas || []) {
      const linha = normalizarSePreciso(linhaCrua, origem);
      const id = linha.request_id == null || linha.request_id === ''
        ? ''
        : String(linha.request_id).trim();
      // Linhas sem request_id nunca colidem; Symbol garante chave única por linha.
      mapa.set(id || Symbol('sem-request-id'), linha);
    }
  }

  return [...mapa.values()];
}

function agrupar(linhas, clientes) {
  const idsValidos = new Set((clientes || []).map(cliente => cliente.id));
  const nomesPorId = new Map((clientes || []).map(cliente => [cliente.id, cliente.nome || cliente.id]));
  const clientesAtivos = new Set();
  const serie = new Map();
  const porCliente = new Map();
  const porModelo = new Map();
  const totais = {
    custo_usd: 0,
    requisicoes: 0,
    tokens_total: 0,
    tokens_prompt: 0,
    tokens_completion: 0,
    tokens_cached: 0
  };

  for (const linha of linhas) {
    let clienteId = linha.cliente_id;
    let nome = linha.nome;

    if (linha.origem === 'gateway') {
      if (!idsValidos.has(clienteId)) {
        clienteId = 'nao_atribuido';
        nome = 'Não atribuído';
      } else {
        nome = nomesPorId.get(clienteId) || clienteId;
      }
    }

    const custo = Number(linha.custo_usd || 0);
    const tokens = Number(linha.total_tokens || 0);
    const prompt = Number(linha.prompt_tokens || 0);
    const completion = Number(linha.completion_tokens || 0);
    const cached = Number(linha.cached_tokens || 0);

    totais.custo_usd += custo;
    totais.requisicoes += 1;
    totais.tokens_total += tokens;
    totais.tokens_prompt += prompt;
    totais.tokens_completion += completion;
    totais.tokens_cached += cached;
    if (clienteId && clienteId !== 'nao_atribuido') clientesAtivos.add(clienteId);

    const dia = formatadorDia.format(linha.ocorrido_em);
    const linhaSerie = serie.get(dia) || { dia, custo_usd: 0, tokens: 0, requisicoes: 0 };
    linhaSerie.custo_usd += custo;
    linhaSerie.tokens += tokens;
    linhaSerie.requisicoes += 1;
    serie.set(dia, linhaSerie);

    const chaveCliente = clienteId || 'nao_atribuido';
    const linhaCliente = porCliente.get(chaveCliente) || {
      cliente_id: clienteId,
      nome,
      custo_usd: 0,
      tokens: 0,
      tokens_cached: 0,
      requisicoes: 0
    };
    linhaCliente.custo_usd += custo;
    linhaCliente.tokens += tokens;
    linhaCliente.tokens_cached += cached;
    linhaCliente.requisicoes += 1;
    porCliente.set(chaveCliente, linhaCliente);

    const provedor = linha.provedor || 'desconhecido';
    const modelo = linha.modelo || 'desconhecido';
    const chaveModelo = `${provedor}\u0000${modelo}`;
    const linhaModelo = porModelo.get(chaveModelo) || {
      provedor,
      modelo,
      custo_usd: 0,
      tokens: 0,
      requisicoes: 0
    };
    linhaModelo.custo_usd += custo;
    linhaModelo.tokens += tokens;
    linhaModelo.requisicoes += 1;
    porModelo.set(chaveModelo, linhaModelo);
  }

  const ordemCusto = (a, b) => (b.custo_usd - a.custo_usd) || (b.tokens - a.tokens);

  return {
    kpis: {
      custo_usd: Number(totais.custo_usd || 0),
      requisicoes: Number(totais.requisicoes || 0),
      tokens_total: Number(totais.tokens_total || 0),
      tokens_prompt: Number(totais.tokens_prompt || 0),
      tokens_completion: Number(totais.tokens_completion || 0),
      tokens_cached: Number(totais.tokens_cached || 0),
      clientes_ativos: Number(clientesAtivos.size || 0)
    },
    serie_diaria: [...serie.values()].sort((a, b) => String(a.dia).localeCompare(String(b.dia))),
    por_cliente: [...porCliente.values()].sort(ordemCusto),
    por_modelo: [...porModelo.values()].sort(ordemCusto)
  };
}

function construirDadosFinanceiro({ atual = [], anterior = [], clientes = [], inicio, fim, prevInicio, prevFim } = {}) {
  const noPeriodo = (linha, inicioPeriodo, fimPeriodo) => {
    const data = linha.ocorrido_em instanceof Date ? linha.ocorrido_em : new Date(linha.ocorrido_em);
    return data >= inicioPeriodo && data <= fimPeriodo;
  };

  const linhasAtuais = mesclarLinhasUso(atual, []).filter(linha => noPeriodo(linha, inicio, fim));
  const linhasAnteriores = mesclarLinhasUso(anterior, []).filter(linha => noPeriodo(linha, prevInicio, prevFim));

  const resultadoAtual = agrupar(linhasAtuais, clientes);
  const resultadoAnterior = agrupar(linhasAnteriores, clientes);

  return {
    kpis: resultadoAtual.kpis,
    kpis_anteriores: {
      custo_usd: Number(resultadoAnterior.kpis.custo_usd || 0),
      requisicoes: Number(resultadoAnterior.kpis.requisicoes || 0),
      tokens_total: Number(resultadoAnterior.kpis.tokens_total || 0)
    },
    serie_diaria: resultadoAtual.serie_diaria,
    por_cliente: resultadoAtual.por_cliente,
    por_modelo: resultadoAtual.por_modelo
  };
}

module.exports = {
  normalizarLinhaUsoTokens,
  normalizarLinhaSpendLog,
  mesclarLinhasUso,
  construirDadosFinanceiro
};
