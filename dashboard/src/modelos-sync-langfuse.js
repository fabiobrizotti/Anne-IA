'use strict';

const {
  ErroIntegracao,
  slugModelo,
  payloadLangfuse,
  ehGerenciadoLangfuse
} = require('./modelos-sync-mapping');

const TIMEOUT = Symbol('langfuse-timeout');
const LIMITE_PAGINAS = 20;
const TAMANHO_PAGINA = 100;

function mensagemPorStatus(status, method) {
  if (status === 403 && method === 'DELETE') {
    return 'modelo gerenciado pelo Langfuse não pode ser removido';
  }
  if (status === 401 || status === 403) return 'não autorizado';
  if (status === 404) return 'não encontrado';
  if (status === 409) return 'conflito';
  return 'indisponível';
}

function criarAdapterLangfuse({ host, publicKey, secretKey, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const raiz = String(host ?? '').replace(/\/+$/, '');
  const chavePublica = typeof publicKey === 'string' ? publicKey : '';
  const chaveSecreta = typeof secretKey === 'string' ? secretKey : '';
  const limite = Number(timeoutMs) > 0 ? Number(timeoutMs) : 8000;
  const autorizacao = 'Basic ' + Buffer.from(`${chavePublica}:${chaveSecreta}`).toString('base64');

  async function request(method, caminho, corpo) {
    if (!raiz || !chavePublica || !chaveSecreta) {
      throw new ErroIntegracao(401, 'credenciais Langfuse ausentes');
    }

    const url = `${raiz}${caminho}`;
    const controller = new AbortController();
    const init = {
      method,
      headers: { Authorization: autorizacao, 'Content-Type': 'application/json' },
      signal: controller.signal
    };
    if (corpo !== undefined) init.body = JSON.stringify(corpo);

    let timer;
    const expira = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(TIMEOUT);
      }, limite);
    });

    let resposta;
    try {
      resposta = await Promise.race([
        Promise.resolve().then(() => fetchImpl(url, init)),
        expira
      ]);
    } catch (err) {
      if (err === TIMEOUT) throw new ErroIntegracao(504, 'timeout');
      // Nunca propagar erro de rede: corpo, headers e stack ficam de fora.
      throw new ErroIntegracao(502, 'indisponível');
    } finally {
      clearTimeout(timer);
    }

    if (!resposta || typeof resposta !== 'object') {
      throw new ErroIntegracao(502, 'indisponível');
    }
    const status = Number(resposta.status);
    if (resposta.ok === false || status >= 400) {
      // DELETE externo é idempotente; nenhum corpo é lido nesses caminhos.
      if (status === 404 && method === 'DELETE') return null;
      throw new ErroIntegracao(
        Number.isInteger(status) ? status : 502,
        mensagemPorStatus(status, method)
      );
    }
    return resposta;
  }

  async function jsonSeguro(resposta) {
    if (!resposta || typeof resposta.json !== 'function') {
      throw new ErroIntegracao(502, 'indisponível');
    }
    try {
      return await resposta.json();
    } catch {
      throw new ErroIntegracao(502, 'indisponível');
    }
  }

  function idExterno(corpo, fallback) {
    const idResposta = corpo?.id ?? corpo?.modelId;
    const temId = idResposta !== undefined && idResposta !== null && idResposta !== '';
    const id = temId ? idResposta : fallback;
    if (id === undefined || id === null || id === '') {
      throw new ErroIntegracao(502, 'indisponível');
    }
    return String(id);
  }

  async function listar() {
    const itens = [];
    for (let pagina = 1; pagina <= LIMITE_PAGINAS; pagina++) {
      const resposta = await request('GET', `/api/public/models?page=${pagina}&limit=${TAMANHO_PAGINA}`);
      const corpo = await jsonSeguro(resposta);
      const paginaItens = Array.isArray(corpo?.data) ? corpo.data : [];
      for (const item of paginaItens) {
        const id = item?.id;
        if (id === undefined || id === null || id === '') continue;
        itens.push({
          id: String(id),
          nome: String(item?.modelName ?? item?.name ?? item?.model_name ?? id),
          scope: String(item?.scope ?? ''),
          isLangfuseManaged: ehGerenciadoLangfuse({
            scope: item?.scope,
            isLangfuseManaged: item?.isLangfuseManaged
          })
        });
      }
      if (paginaItens.length < TAMANHO_PAGINA) break;
    }
    return itens;
  }

  return {
    listar,

    async criar(row) {
      let resposta;
      try {
        resposta = await request('POST', '/api/public/models', payloadLangfuse(row));
      } catch (err) {
        if (!(err instanceof ErroIntegracao) || err.status !== 409) throw err;
        const nome = slugModelo(row);
        const existente = (await listar()).find((item) => item.nome === nome);
        if (!existente) throw new ErroIntegracao(409, 'conflito');
        return existente.id;
      }
      return idExterno(await jsonSeguro(resposta));
    },

    async atualizar(externalId, row) {
      const id = String(externalId ?? '');
      if (!id) throw new ErroIntegracao(502, 'indisponível');
      const resposta = await request('PUT', `/api/public/models/${encodeURIComponent(id)}`, payloadLangfuse(row));
      return idExterno(await jsonSeguro(resposta), id);
    },

    async remover(externalId) {
      const id = String(externalId ?? '');
      if (!id) throw new ErroIntegracao(502, 'indisponível');
      await request('DELETE', `/api/public/models/${encodeURIComponent(id)}`);
    }
  };
}

module.exports = { criarAdapterLangfuse };
