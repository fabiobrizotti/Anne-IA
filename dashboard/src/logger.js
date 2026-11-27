/**
 * Logger operacional do Dashboard Anne-IA.
 *
 * Responsabilidades (uma só, sem abstração extra):
 *  1. Persistir telemetria em `system_logs` (Postgres) de forma fire-and-forget.
 *  2. Manter as últimas N entradas em memória (cache quente da aba de logs).
 *  3. Transmitir em tempo real via SSE, respeitando o isolamento multi-tenant.
 *  4. Interceptar requisições HTTP automaticamente (método, rota, status, latência).
 *  5. Aplicar retenção configurável em `system_logs`.
 *
 * Regras de segurança/LGPD: nunca persistir corpo de request, senha, token,
 * CPF, e-mail ou query string completa. IP é mascarado antes de sair do processo.
 */

'use strict';

const crypto = require('crypto');

const CACHE_MAX = 50;
const MENSAGEM_MAX = 2000;
const CONTEXTO_MAX = 4096;
const NIVEIS = new Set(['debug', 'info', 'warn', 'error', 'critical']);

// Rotas que NÃO geram log de acesso: health e a própria aba de logs (evita loop
// de feedback: log -> SSE -> nova consulta -> novo log).
const SKIP_PREFIXES = ['/api/v1/logs', '/api/health', '/favicon.ico'];

let pool = null;
let logCache = [];
/** clientId -> { res, isAdmin, clienteId } */
const sseClients = new Map();
/** chave -> timestamp da última emissão (para não inundar a tabela) */
const throttles = new Map();

function init(poolInstance) {
  pool = poolInstance || null;
}

// ---------------------------------------------------------------------------
// Higienização
// ---------------------------------------------------------------------------

function truncate(value, max) {
  const str = typeof value === 'string' ? value : String(value ?? '');
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

/** Mascara o último octeto (IPv4) ou os grupos finais (IPv6) do IP. */
function maskIp(ip) {
  const raw = String(ip || '').replace(/^::ffff:/, '');
  if (!raw) return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) {
    const parts = raw.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
  }
  if (raw.includes(':')) {
    const groups = raw.split(':').filter(Boolean);
    return `${groups.slice(0, 3).join(':')}::x`;
  }
  return truncate(raw, 45);
}

/** Remove campos não serializáveis e limita tamanho/tamanho de strings. */
function sanitizeContexto(contexto) {
  if (!contexto || typeof contexto !== 'object' || Array.isArray(contexto)) return {};
  try {
    const json = JSON.stringify(contexto, (chave, valor) => {
      if (typeof valor === 'function' || typeof valor === 'undefined') return undefined;
      if (typeof valor === 'bigint') return String(valor);
      if (chave === 'stack' && typeof valor === 'string') {
        return valor.split('\n').slice(0, 8).join('\n');
      }
      if (typeof valor === 'string' && valor.length > 500) return `${valor.slice(0, 499)}…`;
      return valor;
    });
    if (!json || json.length <= CONTEXTO_MAX) return JSON.parse(json || '{}');

    // Fallback compacto: preserva o tamanho original e um trecho legível, sem
    // nunca ultrapassar CONTEXTO_MAX bytes no total. O trecho é JSON cru (com
    // aspas), que ao ser re-serializado ganha escapes — por isso o corte é
    // ajustado até o resultado final caber.
    const bytes_originais = json.length;
    let inicio = json.slice(0, CONTEXTO_MAX);
    let saida = { truncado: true, bytes_originais, inicio };
    while (inicio.length > 0 && JSON.stringify(saida).length > CONTEXTO_MAX) {
      inicio = inicio.slice(0, Math.floor(inicio.length * 0.9));
      saida = { truncado: true, bytes_originais, inicio };
    }
    return saida;
  } catch (_err) {
    return { erro: 'contexto_nao_serializavel' };
  }
}

// ---------------------------------------------------------------------------
// Classificação
// ---------------------------------------------------------------------------

function deriveLevel(status) {
  const code = Number(status) || 0;
  if (code >= 500) return 'error';
  if (code === 401 || code === 403 || code === 429) return 'warn';
  if (code >= 400) return 'warn';
  return 'info';
}

/** Origem curta e estável, derivada do primeiro segmento relevante da rota. */
function deriveOrigin(rota) {
  const path = String(rota || '');
  const known = [
    'auth', 'instances', 'financeiro', 'modelos', 'conhecimento',
    'prompts-padrao', 'usuarios', 'permissoes', 'logs', 'litellm'
  ];
  for (const prefix of known) {
    if (path.startsWith(`/api/v1/${prefix}`)) return prefix;
  }
  if (path.startsWith('/api/health')) return 'health';
  if (path.startsWith('/api/')) return 'api';
  return 'system';
}

function shouldSkip(path) {
  const alvo = String(path || '');
  return SKIP_PREFIXES.some((prefixo) => alvo.startsWith(prefixo));
}

// ---------------------------------------------------------------------------
// Cache + SSE
// ---------------------------------------------------------------------------

function isVisibleTo(entry, cliente) {
  if (!cliente) return false;
  if (cliente.isAdmin) return true;
  if (!cliente.clienteId) return false;
  return entry.cliente_id === cliente.clienteId;
}

function addToCache(entry) {
  logCache.unshift(entry);
  if (logCache.length > CACHE_MAX) logCache.length = CACHE_MAX;

  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  sseClients.forEach((cliente, clientId) => {
    if (!isVisibleTo(entry, cliente)) return;
    try {
      cliente.res.write(payload);
    } catch (_err) {
      sseClients.delete(clientId);
    }
  });
}

function getCacheFor({ limit = CACHE_MAX, isAdmin = false, clienteId = null } = {}) {
  const cliente = { isAdmin, clienteId };
  return logCache.filter((entry) => isVisibleTo(entry, cliente)).slice(0, limit);
}

function clearCache() {
  logCache = [];
}

function pruneCache(dias) {
  const diasNum = Math.max(1, Number(dias) || 90);
  const corte = Date.now() - diasNum * 24 * 60 * 60 * 1000;
  logCache = logCache.filter((entry) => new Date(entry.criado_em).getTime() >= corte);
}

/**
 * Abre o stream SSE do cliente já autenticado.
 * O filtro por tenant é aplicado na reprodução do histórico E no broadcast.
 */
function streamLogs(req, res, { isAdmin = false, clienteId = null } = {}) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // desliga buffer de proxies
  res.flushHeaders();

  const clientId = crypto.randomUUID();
  const cliente = { res, isAdmin, clienteId };
  sseClients.set(clientId, cliente);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (_err) {
      sseClients.delete(clientId);
    }
  }, 30000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const cleanup = () => {
    clearInterval(heartbeat);
    sseClients.delete(clientId);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  // Histórico imediato (evita tabela vazia ao abrir a aba)
  const historico = getCacheFor({ limit: CACHE_MAX, isAdmin, clienteId });
  if (historico.length === 0) {
    res.write(': connected\n\n');
  } else {
    historico.forEach((entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`));
  }
}

// ---------------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------------

async function writeLog(nivel, origem, mensagem, contexto = {}, clienteId = null) {
  const entry = {
    nivel: NIVEIS.has(nivel) ? nivel : 'info',
    origem: truncate(String(origem || 'system').trim() || 'system', 100),
    mensagem: truncate(mensagem, MENSAGEM_MAX),
    contexto: sanitizeContexto(contexto),
    cliente_id: clienteId ? String(clienteId) : null,
    criado_em: new Date().toISOString()
  };

  if (pool) {
    try {
      const result = await pool.query(
        `INSERT INTO system_logs (nivel, origem, mensagem, contexto, cliente_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, criado_em`,
        [entry.nivel, entry.origem, entry.mensagem, JSON.stringify(entry.contexto), entry.cliente_id]
      );
      entry.id = result.rows[0].id;
      entry.criado_em = new Date(result.rows[0].criado_em).toISOString();
    } catch (err) {
      console.error('[log] Falha ao persistir:', err.message);
    }
  }

  // Sem banco (ou falha), usa id sintético: a UI continua funcionando e o
  // dedupe do frontend ignora ids temporários.
  if (entry.id === undefined) entry.id = `tmp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  addToCache(entry);
  return entry;
}

/**
 * Emite no máximo uma entrada por chave a cada `ttlMs`.
 * Usado para falhas crônicas (Redis fora, Evolution fora) que acontecem a cada
 * requisição e inundariam a tabela.
 */
async function writeLogThrottled(chave, ttlMs, nivel, origem, mensagem, contexto = {}, clienteId = null) {
  const agora = Date.now();
  const ultimo = throttles.get(chave) || 0;
  if (agora - ultimo < ttlMs) return null;
  throttles.set(chave, agora);
  return writeLog(nivel, origem, mensagem, contexto, clienteId);
}

/** Carrega as últimas entradas do banco para o cache no boot. */
async function warmup() {
  if (!pool) return 0;
  try {
    const result = await pool.query(
      `SELECT id, nivel, origem, mensagem, contexto, cliente_id, criado_em
       FROM system_logs
       ORDER BY criado_em DESC
       LIMIT $1`,
      [CACHE_MAX]
    );
    logCache = result.rows.map((row) => ({
      id: row.id,
      nivel: row.nivel,
      origem: row.origem,
      mensagem: row.mensagem,
      contexto: row.contexto || {},
      cliente_id: row.cliente_id,
      criado_em: new Date(row.criado_em).toISOString()
    }));
    return logCache.length;
  } catch (err) {
    console.error('[log] Falha no warm-up do cache:', err.message);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Interceptação HTTP
// ---------------------------------------------------------------------------

/**
 * Middleware de log de acesso. Só registra `/api/*` e usa a rota declarada
 * (`req.route.path`) para não gravar ids/valores arbitrários vindos da URL.
 */
function requestLogger() {
  return (req, res, next) => {
    // Capturado na entrada: routers montados reescrevem `req.url`/`req.path`
    // antes do `finish` (ex.: 401 do middleware de auth viraria "/instances").
    const caminho = (req.originalUrl || req.url || '').split('?')[0];
    if (!caminho.startsWith('/api/') || shouldSkip(caminho)) return next();

    const inicio = process.hrtime.bigint();
    const requestId = crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    let registrado = false;
    const registrar = () => {
      if (registrado) return;
      registrado = true;

      const duracaoMs = Math.round(Number(process.hrtime.bigint() - inicio) / 1e6);
      const status = res.statusCode;
      const rota = req.route ? `${req.baseUrl || ''}${req.route.path}` : caminho;

      writeLog(
        deriveLevel(status),
        deriveOrigin(caminho),
        `${req.method} ${rota} ${status}`,
        {
          request_id: requestId,
          metodo: req.method,
          rota,
          status,
          duracao_ms: duracaoMs,
          ip: maskIp(req.ip),
          role: req.user?.role || null,
          user_id: req.user?.id || null
        },
        req.user?.cliente_id || null
      ).catch(() => {});
    };

    res.on('finish', registrar);
    res.on('close', registrar);
    next();
  };
}

// ---------------------------------------------------------------------------
// Retenção
// ---------------------------------------------------------------------------

/**
 * Agenda a limpeza de `system_logs` (1x/dia). O primeiro ciclo roda após
 * `primeiroAtrasoMs` para não competir com o boot do container.
 */
function startRetentionJob({ dias = 90, intervaloMs = 24 * 60 * 60 * 1000, primeiroAtrasoMs = 60000 } = {}) {
  if (!pool) return null;
  const diasNum = Math.max(1, Number(dias) || 90);

  const executar = async () => {
    try {
      const result = await pool.query('SELECT fn_limpar_logs_antigos($1) AS result', [diasNum]);
      const data = result.rows[0].result || {};
      const removidos = Number(data.removidos) || 0;
      pruneCache(diasNum);
      if (removidos > 0) {
        await writeLog('info', 'system', `Retenção automática: ${removidos} log(s) com mais de ${diasNum} dias removido(s)`, { dias: diasNum, removidos });
      }
    } catch (err) {
      console.error('[log] Falha na retenção automática:', err.message);
      await writeLogThrottled('retencao_falha', 60 * 60 * 1000, 'error', 'system', `Retenção automática falhou: ${err.message}`, { dias: diasNum });
    }
  };

  const startTimer = setTimeout(executar, primeiroAtrasoMs);
  if (typeof startTimer.unref === 'function') startTimer.unref();
  const interval = setInterval(executar, intervaloMs);
  if (typeof interval.unref === 'function') interval.unref();
  return { executar, interval };
}

module.exports = {
  // ciclo de vida
  init,
  warmup,
  startRetentionJob,
  // escrita
  writeLog,
  writeLogThrottled,
  // leitura / tempo real
  getCacheFor,
  streamLogs,
  clearCache,
  pruneCache,
  // middlewares
  requestLogger,
  // utilitários (testáveis)
  deriveLevel,
  deriveOrigin,
  shouldSkip,
  maskIp,
  sanitizeContexto
};
