'use strict';

const {
  propagarLiteLLM,
  ehGerenciadoLangfuse,
  resumoErro,
  slugModelo,
  ErroIntegracao
} = require('./modelos-sync-mapping');

const SISTEMAS = ['litellm', 'langfuse'];

const SQL_LISTAR = `
  SELECT p.*,
         s_lit.status AS lit_status,
         s_lit.external_id AS lit_external_id,
         s_lit.ultimo_erro AS lit_ultimo_erro,
         s_lf.status AS lf_status,
         s_lf.external_id AS lf_external_id,
         s_lf.ultimo_erro AS lf_ultimo_erro
  FROM precos_modelos p
  LEFT JOIN modelos_sync_estado s_lit ON s_lit.modelo_id = p.id AND s_lit.sistema = 'litellm'
  LEFT JOIN modelos_sync_estado s_lf ON s_lf.modelo_id = p.id AND s_lf.sistema = 'langfuse'
  ORDER BY p.id
`;

const SQL_ESTADO = 'SELECT sistema, external_id, status, ultimo_erro FROM modelos_sync_estado WHERE modelo_id = $1';

// Ordem dos parâmetros é contrato: status em $4, ultimo_erro em $5.
const SQL_GRAVAR = `INSERT INTO modelos_sync_estado (modelo_id, sistema, external_id, status, ultimo_erro, sincronizado_em)
VALUES ($1,$2,$3,$4,$5,NOW())
ON CONFLICT (modelo_id, sistema) DO UPDATE SET external_id=EXCLUDED.external_id, status=EXCLUDED.status, ultimo_erro=EXCLUDED.ultimo_erro, sincronizado_em=NOW()`;

function idExterno(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  return String(valor);
}

function estado(bruto) {
  const dados = bruto && typeof bruto === 'object' ? bruto : {};
  return {
    external_id: idExterno(dados.external_id),
    status: typeof dados.status === 'string' ? dados.status : null,
    ultimo_erro: typeof dados.ultimo_erro === 'string' ? dados.ultimo_erro : null
  };
}

function estadosVazios() {
  return Object.fromEntries(SISTEMAS.map((sistema) => [sistema, estado(null)]));
}

function estadosDaLinha(linha) {
  const sincronizacao = linha?.sync;
  if (!sincronizacao || typeof sincronizacao !== 'object') return null;
  return Object.fromEntries(SISTEMAS.map((sistema) => [sistema, estado(sincronizacao[sistema])]));
}

function novoContexto() {
  return { erros: [], listagens: new Map() };
}

function criarSyncModelos({ pool, litellm, langfuse } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('pool.query é obrigatório');
  }
  const adapters = { litellm, langfuse };

  async function gravar(ctx, linha, sistema, resultado) {
    if (linha?.id === undefined || linha?.id === null) return;
    try {
      await pool.query(SQL_GRAVAR, [
        linha.id,
        sistema,
        resultado.external_id,
        resultado.status,
        resultado.erro
      ]);
    } catch (err) {
      // A escrita local já aconteceu na rota; falha de estado nunca a derruba.
      ctx.erros.push(resumoErro(err));
    }
  }

  async function estadosAtuais(linha, ctx) {
    const conhecidos = estadosDaLinha(linha);
    if (conhecidos) return conhecidos;
    if (linha?.id === undefined || linha?.id === null) return estadosVazios();
    try {
      const { rows } = await pool.query(SQL_ESTADO, [linha.id]);
      const encontrados = new Map((rows || []).map((r) => [r.sistema, r]));
      return Object.fromEntries(SISTEMAS.map((sistema) => [
        sistema, estado(encontrados.get(sistema))
      ]));
    } catch (err) {
      const mensagem = resumoErro(err);
      ctx.erros.push(mensagem);
      return Object.fromEntries(SISTEMAS.map((sistema) => [sistema, {
        ...estado(null), status: 'pendente', ultimo_erro: mensagem, indisponivel: true
      }]));
    }
  }

  async function listarSistema(sistema, ctx) {
    if (!ctx.listagens.has(sistema)) {
      ctx.listagens.set(sistema, Promise.resolve()
        .then(() => {
          const adapter = adapters[sistema];
          if (!adapter || typeof adapter.listar !== 'function') {
            throw new ErroIntegracao(401, 'credenciais ausentes');
          }
          return adapter.listar();
        })
        .then((itens) => ({ itens: Array.isArray(itens) ? itens : [], erro: null }))
        .catch((err) => ({ itens: [], erro: resumoErro(err) })));
    }
    return ctx.listagens.get(sistema);
  }

  async function listarLinhas() {
    const { rows } = await pool.query(SQL_LISTAR);
    return (rows || []).map((linha) => ({
      ...linha,
      sync: Object.fromEntries(SISTEMAS.map((sistema) => {
        const prefixo = sistema === 'litellm' ? 'lit_' : 'lf_';
        // As colunas aliasadas vêm do JOIN; o fallback cobre linhas que já
        // chegaram com sync montado (ex.: chamadas internas e fakes de teste).
        const bruto = linha[`${prefixo}status`] === undefined && linha?.sync
          ? linha.sync[sistema]
          : {
            status: linha[`${prefixo}status`],
            external_id: linha[`${prefixo}external_id`],
            ultimo_erro: linha[`${prefixo}ultimo_erro`]
          };
        return [sistema, estado(bruto)];
      }))
    }));
  }

  async function aplicarSistema(sistema, linha, anterior, ctx) {
    const atual = anterior.external_id;

    async function concluir(status, externo, erro) {
      const resultado = { status, external_id: idExterno(externo) ?? atual, erro: erro || null };
      await gravar(ctx, linha, sistema, resultado);
      return resultado;
    }

    async function falhar(err) {
      return concluir('pendente', atual, resumoErro(err));
    }

    // Rota de gateway: só openrouter ativo. Nunca apaga estado nem gera retry.
    if (sistema === 'litellm' && !propagarLiteLLM(linha)) {
      return concluir('nao_aplicavel', atual, null);
    }
    if (anterior.indisponivel) {
      return concluir('pendente', atual, anterior.ultimo_erro);
    }

    const adapter = adapters[sistema];

    // Langfuse: checar posse ANTES de qualquer escrita, inclusive em retry/boot.
    // Um modelo gerenciado pelo Langfuse nunca é atualizado nem recriado.
    if (sistema === 'langfuse') {
      const lista = await listarSistema(sistema, ctx);
      // Sem listagem confiável não dá para provar que o objeto é nosso: não escreve.
      if (lista.erro) return concluir('pendente', atual, lista.erro);
      const slug = slugModelo(linha);
      const existente = lista.itens.find((item) =>
        (atual && item?.id !== undefined && item?.id !== null && String(item.id) === atual) ||
        item?.nome === slug);
      if (existente && ehGerenciadoLangfuse(existente)) {
        return concluir('nao_aplicavel', atual ?? existente.id, null);
      }
    }

    const metodo = atual ? 'atualizar' : 'criar';
    if (!adapter || typeof adapter[metodo] !== 'function') {
      return falhar(new ErroIntegracao(401, 'credenciais ausentes'));
    }

    if (atual) {
      try {
        const devolvido = await adapter.atualizar(atual, linha);
        return concluir('sincronizado', devolvido, null);
      } catch (err) {
        return falhar(err);
      }
    }

    // Catálogo de preço: todos os ativos vão ao Langfuse, exceto os gerenciados por ele.
    try {
      const devolvido = await adapter.criar(linha);
      const id = idExterno(devolvido);
      if (!id) throw new ErroIntegracao(502, 'indisponível');
      return concluir('sincronizado', id, null);
    } catch (err) {
      return falhar(err);
    }
  }

  async function removerSistema(sistema, linha, anterior, ctx) {
    async function concluir(status, erro) {
      const resultado = {
        status,
        external_id: anterior.external_id,
        erro: erro || null
      };
      await gravar(ctx, linha, sistema, resultado);
      return resultado;
    }

    // Sem id (ou gerenciado pelo Langfuse) não há nada a remover externamente.
    if (!anterior.external_id || anterior.status === 'nao_aplicavel') {
      return concluir('removido', null);
    }

    const adapter = adapters[sistema];
    if (!adapter || typeof adapter.remover !== 'function') {
      return concluir('pendente', resumoErro(new ErroIntegracao(401, 'credenciais ausentes')));
    }
    try {
      await adapter.remover(anterior.external_id);
      return concluir('removido', null);
    } catch (err) {
      return concluir('pendente', resumoErro(err));
    }
  }

  return {
    async listar() {
      return listarLinhas();
    },

    async aplicarModelo(linha) {
      const ctx = novoContexto();
      const estados = await estadosAtuais(linha, ctx);
      const resultados = await Promise.all(SISTEMAS.map((sistema) =>
        aplicarSistema(sistema, linha, estados[sistema], ctx)));
      return Object.fromEntries(SISTEMAS.map((sistema, i) => [sistema, resultados[i].status]));
    },

    async removerModelo(linha) {
      const ctx = novoContexto();
      const estados = await estadosAtuais(linha, ctx);
      const resultados = await Promise.all(SISTEMAS.map((sistema) =>
        removerSistema(sistema, linha, estados[sistema], ctx)));
      return Object.fromEntries(SISTEMAS.map((sistema, i) => [sistema, resultados[i].status]));
    },

    async reconciliar() {
      const ctx = novoContexto();
      const linhas = await listarLinhas();
      const slugs = new Set(linhas.map(slugModelo));
      const resumo = {
        criados: 0,
        atualizados: 0,
        removidos: 0,
        pendentes: 0,
        orfos_observados: 0,
        erros: []
      };

      const listagens = await Promise.all(SISTEMAS.map((sistema) => listarSistema(sistema, ctx)));
      for (const lista of listagens) {
        if (lista.erro) ctx.erros.push(lista.erro);
      }

      for (const linha of linhas) {
        const estados = estadosDaLinha(linha) || estadosVazios();
        if (linha.ativo === true) {
          const resultados = await Promise.all(SISTEMAS.map((sistema) =>
            aplicarSistema(sistema, linha, estados[sistema], ctx)));
          for (const [i, resultado] of resultados.entries()) {
            const anterior = estados[SISTEMAS[i]];
            if (resultado.status === 'pendente') {
              resumo.pendentes++;
              if (resultado.erro) ctx.erros.push(resultado.erro);
            } else if (resultado.status === 'sincronizado') {
              if (anterior.external_id) resumo.atualizados++;
              else resumo.criados++;
            }
          }
        } else {
          const resultados = await Promise.all(SISTEMAS.map((sistema) =>
            removerSistema(sistema, linha, estados[sistema], ctx)));
          for (const [i, resultado] of resultados.entries()) {
            const anterior = estados[SISTEMAS[i]];
            if (resultado.status === 'pendente') {
              resumo.pendentes++;
              if (resultado.erro) ctx.erros.push(resultado.erro);
            } else if (resultado.status === 'removido' && anterior.external_id) {
              resumo.removidos++;
            }
          }
        }
      }

      for (const lista of listagens) {
        for (const item of lista.itens) {
          const nome = item?.nome;
          if (nome !== undefined && nome !== null && !slugs.has(String(nome))) {
            resumo.orfos_observados++;
          }
        }
      }

      resumo.erros = [...new Set(ctx.erros)];
      return resumo;
    }
  };
}

module.exports = { criarSyncModelos };
