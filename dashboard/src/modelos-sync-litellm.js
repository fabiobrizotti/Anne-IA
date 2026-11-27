'use strict';

const { ErroIntegracao, payloadLiteLLM } = require('./modelos-sync-mapping');

const TIMEOUT = Symbol('litellm-timeout');

function mensagemPorStatus(status) {
  if (status === 401 || status === 403) return 'não autorizado';
  if (status === 404) return 'não encontrado';
  if (status === 409) return 'conflito';
  return 'indisponível';
}

// As rotas admin ficam na raiz; LITELLM_URL (/v1) nunca faz parte delas.
function raizAdmin(baseUrl) {
  return String(baseUrl ?? '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

function criarAdapterLiteLLM({ baseUrl, masterKey, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const raiz = raizAdmin(baseUrl);
  const chave = typeof masterKey === 'string' ? masterKey : '';
  const limite = Number(timeoutMs) > 0 ? Number(timeoutMs) : 8000;

  async function request(method, caminho, corpo) {
    if (!raiz || !chave) throw new ErroIntegracao(401, 'credenciais ausentes');

    const url = `${raiz}${caminho}`;
    const controller = new AbortController();
    const init = {
      method,
      headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
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
      // DELETE lógico externo é idempotente.
      if (status === 404 && method === 'POST' && caminho === '/model/delete') return null;
      throw new ErroIntegracao(Number.isInteger(status) ? status : 502, mensagemPorStatus(status));
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
    const idResposta = corpo?.model_info?.id ?? corpo?.id;
    const temId = idResposta !== undefined && idResposta !== null && idResposta !== '';
    const id = temId ? idResposta : fallback;
    if (id === undefined || id === null || id === '') {
      throw new ErroIntegracao(502, 'indisponível');
    }
    return String(id);
  }

  return {
    async listar() {
      const resposta = await request('GET', '/model/info');
      const corpo = await jsonSeguro(resposta);
      const itens = Array.isArray(corpo) ? corpo : (Array.isArray(corpo?.data) ? corpo.data : []);
      return itens.map((item) => {
        const id = item?.model_info?.id ?? item?.id;
        if (id === undefined || id === null || id === '') return null;
        return { id: String(id), nome: String(item?.model_name ?? item?.name ?? id) };
      }).filter(Boolean);
    },

    async criar(row) {
      const resposta = await request('POST', '/model/new', payloadLiteLLM(row));
      return idExterno(await jsonSeguro(resposta));
    },

    async atualizar(externalId, row) {
      const id = String(externalId ?? '');
      if (!id) throw new ErroIntegracao(502, 'indisponível');
      const resposta = await request('PATCH', `/model/${encodeURIComponent(id)}/update`, payloadLiteLLM(row));
      return idExterno(await jsonSeguro(resposta), id);
    },

    async remover(externalId) {
      const id = String(externalId ?? '');
      if (!id) throw new ErroIntegracao(502, 'indisponível');
      await request('POST', '/model/delete', { id });
    }
  };
}

module.exports = { criarAdapterLiteLLM };
