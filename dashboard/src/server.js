const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://evolution-api:8080';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const NINE_ROUTER_URL = process.env.NINE_ROUTER_URL || 'http://9router:20000/v1';
const NINE_ROUTER_API_KEY = process.env.NINE_ROUTER_API_KEY || process.env.NINE_ROUTER_PASSWORD || '';

// Pool PostgreSQL (dimensionado para alta concorrência e proteção contra queries lentas)
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 15,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000
  });
  pool.on('error', (err) => {
    console.error('[db] Erro inesperado no pool do Postgres:', err.message);
  });
} else {
  console.error('[db] DATABASE_URL não configurada. Schema deve ser provisionado por setup/postgres/init.sql.');
}

// Middlewares de Parsing e Segurança Defensiva
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none';"
  );
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Helper de resolução de sessão server-side (opaque session cookie)
async function resolveSessionUser(req) {
  if (!pool) return null;
  const cookies = auth.parseCookies(req);
  const token = cookies['__Host-sid'] || cookies['sid'];
  if (!token) return null;

  const tokenHash = auth.hashSessionToken(token);
  try {
    const res = await pool.query(
      `SELECT s.id_hash, s.user_id, s.expira_em, u.customer_code, u.status, u.role, u.cliente_id,
              COALESCE(i.nome, 'Operador') AS nome, c.email
       FROM dashboard_sessoes s
       JOIN dashboard_usuarios u ON u.id = s.user_id
       LEFT JOIN dashboard_identidades i ON i.user_id = u.id
       LEFT JOIN dashboard_contatos c ON c.user_id = u.id
       WHERE s.id_hash = $1 AND s.expira_em > NOW() AND s.revogado_em IS NULL AND u.status = 'ativo'`,
      [tokenHash]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];

    // Atualiza sliding window em background
    pool.query(
      `UPDATE dashboard_sessoes
       SET ultimo_uso = NOW(), expira_em = NOW() + INTERVAL '30 minutes'
       WHERE id_hash = $1`,
      [tokenHash]
    ).catch(() => {});

    return {
      id: row.user_id,
      customer_code: row.customer_code,
      nome: row.nome,
      email: row.email,
      role: row.role,
      cliente_id: row.cliente_id
    };
  } catch (err) {
    console.error('[auth] Erro ao validar sessão:', err.message);
    return null;
  }
}

// Fallback de Basic Auth para automações headless (n8n/scripts locais)
const authEnabled = process.env.DASHBOARD_AUTH_ENABLED === 'true';
const authUser = process.env.DASHBOARD_USERNAME || 'admin';
const authPass = process.env.DASHBOARD_PASSWORD || '';

function verifyBasicAuth(req) {
  if (!authEnabled || !authPass) return false;
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;

  try {
    const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString('ascii');
    const separatorIdx = credentials.indexOf(':');
    if (separatorIdx === -1) return false;

    const user = credentials.substring(0, separatorIdx);
    const pass = credentials.substring(separatorIdx + 1);

    const userBuf = Buffer.from(user);
    const authUserBuf = Buffer.from(authUser);
    const passBuf = Buffer.from(pass);
    const authPassBuf = Buffer.from(authPass);

    const userMatch = userBuf.length === authUserBuf.length && crypto.timingSafeEqual(userBuf, authUserBuf);
    const passMatch = passBuf.length === authPassBuf.length && crypto.timingSafeEqual(passBuf, authPassBuf);
    return userMatch && passMatch;
  } catch (_e) {
    return false;
  }
}

// Gatekeeper de navegação da interface Vanilla
app.get(['/', '/index.html'], async (req, res, next) => {
  const user = await resolveSessionUser(req);
  if (!user && !verifyBasicAuth(req)) {
    return res.redirect('/login.html');
  }
  next();
});

app.get('/login.html', async (req, res, next) => {
  const user = await resolveSessionUser(req);
  if (user || verifyBasicAuth(req)) {
    return res.redirect('/');
  }
  next();
});

// Arquivos estáticos da interface Vanilla
app.use(express.static(path.join(__dirname, '../public')));

// Helper de requisição para a Evolution API
async function evolutionFetch(endpoint, options = {}) {
  const url = `${EVOLUTION_API_URL}${endpoint}`;
  const headers = {
    'apikey': EVOLUTION_API_KEY,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  try {
    const res = await fetch(url, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    console.error(`[evolution-api] Falha ao chamar ${endpoint}:`, err.message);
    return { status: 502, ok: false, data: { error: 'Evolution API indisponível no momento' } };
  }
}

// Extrai mensagem limpa de erro da Evolution API (NestJS/Baileys)
function extractEvoError(data, defaultMsg = 'Falha na comunicação com a Evolution API') {
  if (!data) return defaultMsg;
  if (typeof data === 'string') return data;
  if (Array.isArray(data.response?.message) && data.response.message.length > 0) {
    return data.response.message.join(', ');
  }
  if (typeof data.response?.message === 'string') return data.response.message;
  if (Array.isArray(data.message) && data.message.length > 0) {
    return data.message.join(', ');
  }
  if (typeof data.message === 'string') return data.message;
  if (typeof data.error === 'string') return data.error;
  return defaultMsg;
}

// Normaliza números de telefone garantindo DDI do Brasil (55) quando omitido
function normalizePhoneNumber(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';
  // Se tem 10 ou 11 dígitos (DDD + número no Brasil sem o DDI 55)
  if (digits.length === 10 || digits.length === 11) {
    return `55${digits}`;
  }
  return digits;
}

// -----------------------------------------------------------------------------
// ROTAS DA API REST (v1)
// -----------------------------------------------------------------------------

// Healthcheck
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// -----------------------------------------------------------------------------
// ENDPOINTS DE AUTENTICAÇÃO E GOVERNANÇA LGPD (v1)
// -----------------------------------------------------------------------------

app.use('/api/v1/auth', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

// GET /api/v1/auth/legal/:tipo - Termos de Uso e Política de Privacidade
app.get('/api/v1/auth/legal/:tipo', (req, res) => {
  const doc = auth.legalTexts[req.params.tipo];
  if (!doc) {
    return res.status(404).json({ success: false, error: 'Documento legal não encontrado.' });
  }
  res.json({ success: true, data: doc });
});

// POST /api/v1/auth/login
app.post('/api/v1/auth/login', async (req, res) => {
  if (!pool) return res.status(500).json({ success: false, error: 'Banco de dados não disponível' });
  const ip = req.ip || req.socket.remoteAddress || '';
  const userAgent = req.headers['user-agent'] || '';
  const { identifier, password, remember_me } = req.body || {};

  const cleanId = String(identifier || '').trim().toLowerCase();
  const cleanPass = String(password || '');

  if (!cleanId || !cleanPass) {
    return res.status(400).json({ success: false, error: 'Identificador e senha são obrigatórios.' });
  }

  // Rate limiting contra brute force
  const bfCheck = auth.checkBruteForce(ip, cleanId);
  if (bfCheck.blocked) {
    await auth.recordAudit(pool, {
      identificador: cleanId,
      evento: 'LOGIN_LOCKOUT',
      sucesso: false,
      ip,
      userAgent,
      detalhes: { remainingSeconds: bfCheck.remainingSeconds, reason: bfCheck.reason }
    });
    res.setHeader('Retry-After', String(bfCheck.remainingSeconds));
    return res.status(429).json({
      success: false,
      error: bfCheck.error
    });
  }

  try {
    const userRes = await pool.query(
      `SELECT u.id, u.customer_code, u.status, u.role, u.cliente_id,
              COALESCE(i.nome, 'Operador') AS nome, c.email, cr.password_hash
       FROM dashboard_usuarios u
       LEFT JOIN dashboard_identidades i ON i.user_id = u.id
       LEFT JOIN dashboard_contatos c ON c.user_id = u.id
       LEFT JOIN dashboard_credenciais cr ON cr.user_id = u.id
       WHERE (LOWER(c.email) = $1 OR UPPER(u.customer_code) = UPPER($1))
       LIMIT 1`,
      [cleanId]
    );

    const user = userRes.rows[0];
    const passwordMatch = user ? await auth.verifyPassword(cleanPass, user.password_hash) : await auth.verifyPassword(cleanPass, null);

    if (!user || !passwordMatch || user.status !== 'ativo') {
      auth.recordBruteForceFailure(ip, cleanId);
      await auth.recordAudit(pool, {
        userId: user ? user.id : null,
        identificador: cleanId,
        evento: 'LOGIN_FAIL',
        sucesso: false,
        ip,
        userAgent,
        detalhes: { motivo: !user ? 'usuario_nao_encontrado' : (user.status !== 'ativo' ? 'usuario_inativo' : 'senha_incorreta') }
      });
      return res.status(401).json({ success: false, error: 'E-mail ou senha incorretos.' });
    }

    // Sucesso: reseta rate limit
    auth.resetBruteForce(ip, cleanId);

    // Rehash transparente se parâmetros scrypt estiverem defasados (Decisão 2)
    if (auth.needsRehash(user.password_hash)) {
      try {
        const upgradedHash = await auth.hashPassword(cleanPass);
        await pool.query(
          `UPDATE dashboard_credenciais
           SET password_hash = $1, atualizado_em = NOW()
           WHERE user_id = $2`,
          [upgradedHash, user.id]
        );
      } catch (rehashErr) {
        console.error('[auth] Falha no rehash transparente:', rehashErr.message);
      }
    }

    // Duração da sessão: 30 dias se 'remember_me', senão 8 horas
    const maxAgeSeconds = remember_me ? (30 * 24 * 60 * 60) : (8 * 60 * 60);
    const sessionToken = auth.generateSessionToken();
    const tokenHash = auth.hashSessionToken(sessionToken);

    await pool.query(
      `INSERT INTO dashboard_sessoes (id_hash, user_id, ip, user_agent, expira_em)
       VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5))`,
      [tokenHash, user.id, ip, userAgent, maxAgeSeconds]
    );

    auth.setSessionCookie(req, res, sessionToken, maxAgeSeconds);

    await auth.recordAudit(pool, {
      userId: user.id,
      identificador: cleanId,
      evento: 'LOGIN_OK',
      sucesso: true,
      ip,
      userAgent,
      detalhes: { remember_me: !!remember_me }
    });

    res.json({
      success: true,
      data: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        role: user.role,
        customer_code: user.customer_code
      }
    });
  } catch (err) {
    if (err.status === 503) {
      res.setHeader('Retry-After', String(err.retryAfter || 1));
      return res.status(503).json({ success: false, error: err.message });
    }
    console.error('[auth] Erro no login:', err.message);
    res.status(500).json({ success: false, error: 'Erro interno ao processar autenticação.' });
  }
});

const registerIpMap = new Map();
function checkRegisterRateLimit(ip) {
  const now = Date.now();
  const clean = String(ip || 'local').trim();
  const entry = registerIpMap.get(clean) || { count: 0, first: now };
  if (now - entry.first > 15 * 60 * 1000) {
    registerIpMap.set(clean, { count: 1, first: now });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count += 1;
  registerIpMap.set(clean, entry);
  return true;
}

// POST /api/v1/auth/register
app.post('/api/v1/auth/register', async (req, res) => {
  if (!pool) return res.status(500).json({ success: false, error: 'Banco de dados não disponível' });
  const ip = req.ip || req.socket.remoteAddress || '';
  const userAgent = req.headers['user-agent'] || '';

  if (!checkRegisterRateLimit(ip)) {
    return res.status(429).json({
      success: false,
      error: 'Muitas tentativas de cadastro a partir deste endereço. Tente novamente mais tarde.'
    });
  }

  const { nome, cpf, data_nascimento, email, telefone, password, aceitou_termos, aceitou_privacidade } = req.body || {};

  // Validação de consentimento LGPD obrigatório (unchecked by default)
  if (aceitou_termos !== true || aceitou_privacidade !== true) {
    return res.status(400).json({
      success: false,
      error: 'É obrigatório aceitar os Termos de Uso e a Política de Privacidade para prosseguir.'
    });
  }

  // Validação de campos
  const cleanNome = String(nome || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanCpf = String(cpf || '').replace(/\D/g, '');
  const cleanTelefone = String(telefone || '').replace(/\D/g, '');
  const cleanPass = String(password || '');

  if (!cleanNome || cleanNome.split(/\s+/).length < 2) {
    return res.status(400).json({ success: false, error: 'Informe seu nome completo (nome e sobrenome).' });
  }

  if (!auth.validateCpf(cleanCpf)) {
    return res.status(400).json({ success: false, error: 'CPF inválido.' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ success: false, error: 'E-mail corporativo inválido.' });
  }

  const passCheck = auth.validatePassword(cleanPass);
  if (!passCheck.valid) {
    return res.status(400).json({ success: false, error: passCheck.error });
  }

  // Validação de maioridade (>= 18 anos)
  if (data_nascimento) {
    const dob = new Date(data_nascimento);
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
    if (isNaN(age) || age < 18) {
      return res.status(400).json({ success: false, error: 'O cadastro é restrito a maiores de 18 anos.' });
    }
  }

  const cpfHash = auth.hashCpf(cleanCpf);
  const cpfCifrado = auth.encryptCpf(cleanCpf);
  let passwordHash;
  try {
    passwordHash = await auth.hashPassword(cleanPass);
  } catch (err) {
    if (err.status === 503) {
      res.setHeader('Retry-After', String(err.retryAfter || 1));
      return res.status(503).json({ success: false, error: err.message });
    }
    throw err;
  }
  const customerCode = `CLI-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  const client = await pool.connect();
  try {
    const checkDup = await client.query(
      `SELECT 'email' AS campo FROM dashboard_contatos WHERE LOWER(email) = $1
       UNION ALL
       SELECT 'cpf' AS campo FROM dashboard_identidades WHERE cpf_hash = $2`,
      [cleanEmail, cpfHash]
    );

    if (checkDup.rowCount > 0) {
      client.release();
      await auth.recordAudit(pool, {
        identificador: cleanEmail,
        evento: 'REGISTER_DUP_ATTEMPT',
        sucesso: false,
        ip,
        userAgent
      });
      return res.status(400).json({
        success: false,
        error: 'Não foi possível concluir o cadastro com os dados informados. Verifique as informações ou acesse sua conta.'
      });
    }

    await client.query('BEGIN');

    // 1. Usuário
    const userRes = await client.query(
      `INSERT INTO dashboard_usuarios (customer_code, status, role)
       VALUES ($1, 'ativo', 'operador')
       RETURNING id, customer_code, role`,
      [customerCode]
    );
    const userId = userRes.rows[0].id;

    // 2. Identidade (cifrada + blind index)
    await client.query(
      `INSERT INTO dashboard_identidades (user_id, nome, nascimento, cpf_cifrado, cpf_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, cleanNome, data_nascimento || null, Buffer.from(cpfCifrado, 'base64'), cpfHash]
    );

    // 3. Contatos
    await client.query(
      `INSERT INTO dashboard_contatos (user_id, email, telefone)
       VALUES ($1, $2, $3)`,
      [userId, cleanEmail, cleanTelefone || null]
    );

    // 4. Credenciais
    await client.query(
      `INSERT INTO dashboard_credenciais (user_id, password_hash)
       VALUES ($1, $2)`,
      [userId, passwordHash]
    );

    // 5. Consentimentos LGPD
    await client.query(
      `INSERT INTO dashboard_consentimentos (user_id, documento, versao, ip, user_agent)
       VALUES ($1, 'termos_uso', 'v1.0', $2, $3),
              ($1, 'politica_privacidade', 'v1.0', $2, $3)`,
      [userId, ip, userAgent]
    );

    // 6. Sessão automática
    const maxAgeSeconds = 8 * 60 * 60;
    const sessionToken = auth.generateSessionToken();
    const tokenHash = auth.hashSessionToken(sessionToken);

    await client.query(
      `INSERT INTO dashboard_sessoes (id_hash, user_id, ip, user_agent, expira_em)
       VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5))`,
      [tokenHash, userId, ip, userAgent, maxAgeSeconds]
    );

    await client.query('COMMIT');
    auth.setSessionCookie(req, res, sessionToken, maxAgeSeconds);

    await auth.recordAudit(pool, {
      userId,
      identificador: cleanEmail,
      evento: 'REGISTER_OK',
      sucesso: true,
      ip,
      userAgent,
      detalhes: { customer_code: customerCode }
    });

    res.status(201).json({
      success: true,
      data: {
        id: userId,
        nome: cleanNome,
        email: cleanEmail,
        role: userRes.rows[0].role,
        customer_code: customerCode
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[auth] Erro no cadastro:', err.message);
    res.status(500).json({ success: false, error: 'Falha ao registrar novo usuário.' });
  } finally {
    client.release();
  }
});

// POST /api/v1/auth/logout
app.post('/api/v1/auth/logout', async (req, res) => {
  const cookies = auth.parseCookies(req);
  const token = cookies['__Host-sid'] || cookies['sid'];
  if (token && pool) {
    const tokenHash = auth.hashSessionToken(token);
    await pool.query('UPDATE dashboard_sessoes SET revogado_em = NOW() WHERE id_hash = $1', [tokenHash]).catch(() => {});
  }
  auth.clearSessionCookie(req, res);
  res.json({ success: true, message: 'Sessão encerrada com sucesso.' });
});

// GET /api/v1/auth/me
app.get('/api/v1/auth/me', async (req, res) => {
  const user = await resolveSessionUser(req);
  if (user) {
    return res.json({ success: true, data: user });
  }
  if (verifyBasicAuth(req)) {
    return res.json({
      success: true,
      data: {
        id: 'system-basic-auth',
        nome: `Administrador (${authUser})`,
        email: 'admin@anne-ia.local',
        role: 'admin',
        customer_code: 'SYS-ADMIN'
      }
    });
  }
  res.status(401).json({ success: false, error: 'Não autenticado' });
});

// Middleware de Proteção das Rotas /api/v1/*
app.use('/api/v1', async (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();

  const user = await resolveSessionUser(req);
  if (user) {
    req.user = user;

    // Defesa anti-CSRF para requisições mutantes autenticadas via cookie de sessão
    const isMutating = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
    if (isMutating) {
      const origin = req.headers.origin;
      const host = req.headers.host;
      const requestedWith = req.headers['x-requested-with'];
      const hasCustomHeader = requestedWith === 'XMLHttpRequest';
      const isSameOrigin = origin && host ? origin.endsWith(host) : true;

      if (!hasCustomHeader && !isSameOrigin) {
        return res.status(403).json({ success: false, error: 'Requisição rejeitada por política de segurança anti-CSRF.' });
      }
    }

    return next();
  }

  if (verifyBasicAuth(req)) {
    req.user = { id: 'basic', role: 'admin', nome: 'Admin' };
    return next();
  }

  res.status(401).json({ success: false, error: 'Sessão expirada ou não autenticada.' });
});

// Helpers de Autorização RBAC / Isolamento Multi-Tenant
function isAdmin(req) {
  return Boolean(req.user && req.user.role === 'admin');
}

function canAccessInstance(req, targetId) {
  if (!req.user) return false;
  if (req.user.role === 'admin') return true;
  if (!req.user.cliente_id || !targetId) return false;
  return String(req.user.cliente_id).trim().toLowerCase() === String(targetId).trim().toLowerCase();
}

// 1. Listar Instâncias e Clientes
app.get('/api/v1/instances', async (req, res) => {
  try {
    let dbClients = [];
    if (pool) {
      const clientRes = await pool.query('SELECT * FROM clientes ORDER BY criado_em DESC');
      dbClients = clientRes.rows;
    }

    // Busca instâncias ativas na Evolution API
    const evoRes = await evolutionFetch('/instance/fetchInstances');
    const evoInstances = Array.isArray(evoRes.data) ? evoRes.data : [];

    // Mapeamento das instâncias por nome
    const evoMap = new Map();
    evoInstances.forEach((inst) => {
      const name = inst.name || inst.instance?.name || inst.instanceName;
      if (name) evoMap.set(name, inst);
    });

    // Mescla dados do banco com status em tempo real da Evolution
    let merged = dbClients.map((c) => {
      const evo = evoMap.get(c.id);
      let status = 'close';
      let profilePicUrl = null;
      let ownerJid = null;

      if (evo) {
        status = evo.connectionStatus || evo.instance?.status || evo.status || 'close';
        profilePicUrl = evo.profilePicUrl || evo.instance?.profilePicUrl || null;
        ownerJid = evo.ownerJid || evo.instance?.ownerJid || null;
        evoMap.delete(c.id);
      }

      return {
        id: c.id,
        nome: c.nome,
        telefone: c.telefone || (ownerJid ? ownerJid.split('@')[0] : ''),
        email: c.email,
        ativo: c.ativo,
        configuracoes: c.configuracoes || {},
        historico_telefones: Array.isArray(c.historico_telefones) ? c.historico_telefones : [],
        status,
        profilePicUrl,
        criado_em: c.criado_em,
        atualizado_em: c.atualizado_em
      };
    });

    // Se houver instâncias na Evolution API mas não no banco (apenas visíveis ao admin)
    if (isAdmin(req)) {
      for (const [name, evo] of evoMap.entries()) {
        merged.push({
          id: name,
          nome: name,
          telefone: evo.ownerJid ? evo.ownerJid.split('@')[0] : '',
          email: '',
          ativo: true,
          configuracoes: {},
          historico_telefones: [],
          status: evo.connectionStatus || evo.instance?.status || evo.status || 'close',
          profilePicUrl: evo.profilePicUrl || evo.instance?.profilePicUrl || null,
          criado_em: evo.createdAt || new Date().toISOString(),
          atualizado_em: evo.updatedAt || new Date().toISOString(),
          aviso: 'Instância encontrada apenas na Evolution API'
        });
      }
    } else {
      // Isolamento multi-tenant: operador enxerga estritamente seu próprio inquilino
      merged = merged.filter(c => c.id && String(c.id).toLowerCase() === String(req.user.cliente_id).toLowerCase());
    }

    res.json({ success: true, data: merged });
  } catch (err) {
    console.error('[api] Erro ao listar instâncias:', err);
    res.status(500).json({ success: false, error: 'Falha ao carregar lista de instâncias' });
  }
});

// 2. Criar Nova Instância e Cliente
app.post('/api/v1/instances', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ success: false, error: 'Acesso restrito a administradores.' });
  }
  try {
    const { id, nome, telefone, email, settings = {} } = req.body;

    if (!id || !nome) {
      return res.status(400).json({ success: false, error: 'ID da instância e Nome são obrigatórios' });
    }

    // Higieniza ID (apenas letras, números, traços e underscores)
    const cleanId = id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');

    // 1. Cria na Evolution API
    const createRes = await evolutionFetch('/instance/create', {
      method: 'POST',
      body: JSON.stringify({
        instanceName: cleanId,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        number: telefone ? telefone.replace(/\D/g, '') : undefined
      })
    });

    if (!createRes.ok && createRes.status !== 403) {
      const msg = createRes.data?.response?.message?.[0] || createRes.data?.error || 'Erro ao criar na Evolution API';
      return res.status(createRes.status).json({ success: false, error: msg });
    }

    // 2. Aplica configurações iniciais na Evolution API se fornecidas
    const defaultSettings = {
      rejectCall: settings.rejectCall ?? false,
      msgCall: settings.msgCall ?? '',
      groupsIgnore: settings.groupsIgnore ?? true,
      alwaysOnline: settings.alwaysOnline ?? false,
      readMessages: settings.readMessages ?? false,
      readStatus: settings.readStatus ?? false,
      syncFullHistory: settings.syncFullHistory ?? false
    };

    await evolutionFetch(`/settings/set/${cleanId}`, {
      method: 'POST',
      body: JSON.stringify(defaultSettings)
    });

    // 3. Salva no banco de dados
    if (pool) {
      const initialHistory = telefone ? [{
        telefone: telefone.trim(),
        data: new Date().toISOString(),
        motivo: 'Número inicial cadastrado'
      }] : [];

      await pool.query(
        `INSERT INTO clientes (id, nome, telefone, email, configuracoes, historico_telefones, atualizado_em)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (id) DO UPDATE
         SET nome = EXCLUDED.nome, telefone = EXCLUDED.telefone, email = EXCLUDED.email,
             configuracoes = EXCLUDED.configuracoes, atualizado_em = NOW()`,
        [cleanId, nome.trim(), telefone ? telefone.trim() : null, email ? email.trim() : null, JSON.stringify(defaultSettings), JSON.stringify(initialHistory)]
      );
    }

    res.status(201).json({
      success: true,
      data: {
        id: cleanId,
        nome: nome.trim(),
        telefone,
        email,
        settings: defaultSettings
      }
    });
  } catch (err) {
    console.error('[api] Erro ao criar instância:', err);
    res.status(500).json({ success: false, error: 'Falha interna ao criar instância' });
  }
});

// 3. Atualizar Dados do Cliente / Instância (Ficha)
app.put('/api/v1/instances/:id', async (req, res) => {
  const { id } = req.params;
  if (!canAccessInstance(req, id)) {
    return res.status(403).json({ success: false, error: 'Acesso negado a esta instância.' });
  }
  try {
    const { nome, email, telefone, ativo, motivoTroca } = req.body;

    if (!nome || typeof nome !== 'string' || !nome.trim()) {
      return res.status(400).json({ success: false, error: 'Nome do cliente é obrigatório' });
    }

    if (!pool) {
      return res.status(503).json({ success: false, error: 'Banco de dados não conectado' });
    }

    const currentClientRes = await pool.query('SELECT * FROM clientes WHERE id = $1', [id]);
    if (currentClientRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Instância ou cliente não encontrado' });
    }

    const currentClient = currentClientRes.rows[0];
    const cleanNome = nome.trim();
    const cleanEmail = email ? email.trim() : null;
    const cleanTelefone = telefone ? String(telefone).trim() : null;
    const isAtivo = ativo !== undefined ? Boolean(ativo) : currentClient.ativo;

    let historico = Array.isArray(currentClient.historico_telefones) ? [...currentClient.historico_telefones] : [];

    // Se o telefone foi alterado ou novo telefone informado
    const currentTelDigits = (currentClient.telefone || '').replace(/\D/g, '');
    const newTelDigits = (cleanTelefone || '').replace(/\D/g, '');

    if (newTelDigits && newTelDigits !== currentTelDigits) {
      historico.push({
        telefone: cleanTelefone,
        telefone_anterior: currentClient.telefone || null,
        data: new Date().toISOString(),
        motivo: motivoTroca || 'Alteração cadastral de número'
      });
    }

    const updateRes = await pool.query(
      `UPDATE clientes
       SET nome = $1, email = $2, telefone = $3, ativo = $4, historico_telefones = $5, atualizado_em = NOW()
       WHERE id = $6
       RETURNING *`,
      [cleanNome, cleanEmail, cleanTelefone, isAtivo, JSON.stringify(historico), id]
    );

    res.json({
      success: true,
      data: updateRes.rows[0]
    });
  } catch (err) {
    console.error('[api] Erro ao atualizar cliente:', err);
    res.status(500).json({ success: false, error: 'Falha ao atualizar dados do cliente' });
  }
});

// 4. Conectar WhatsApp (Pairing Code ou QR Code) - Aceita POST (recomendado/seguro) e GET (legado)
app.all('/api/v1/instances/:id/connect', async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método não permitido' });
  }
  const { id } = req.params;
  if (!canAccessInstance(req, id)) {
    return res.status(403).json({ success: false, error: 'Acesso negado a esta instância.' });
  }
  try {
    const number = req.body?.number || req.query?.number;

    let cleanNumber = null;
    let endpoint = `/instance/connect/${encodeURIComponent(id)}`;

    if (number) {
      cleanNumber = normalizePhoneNumber(number);
      if (!cleanNumber || cleanNumber.length < 10) {
        return res.status(400).json({ success: false, error: 'Número de telefone inválido. Informe com DDD e país.' });
      }
      endpoint += `?number=${cleanNumber}`;
    }

    let evoRes = await evolutionFetch(endpoint);

    if (!evoRes.ok) {
      const msg = extractEvoError(evoRes.data, 'Falha ao solicitar conexão ao WhatsApp');
      const isAlreadyConnected = msg.toLowerCase().includes('already connected') || msg.toLowerCase().includes('conectada');
      return res.status(evoRes.status).json({
        success: false,
        error: isAlreadyConnected ? 'Instância já está conectada ao WhatsApp.' : msg
      });
    }

    let base64 = evoRes.data?.base64 || evoRes.data?.qrcode?.base64 || null;
    let code = evoRes.data?.code || evoRes.data?.qrcode?.code || null;
    let pairingCode = evoRes.data?.pairingCode || null;

    // Se for Pairing Code mas o WhatsApp ainda estiver negociando o código (assíncrono no Baileys)
    // Realiza espera ativa inteligente de até ~4.8s (4 tentativas de 1.2s)
    if (cleanNumber && !pairingCode) {
      for (let attempt = 1; attempt <= 4; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1200));

        const pollRes = await evolutionFetch(endpoint);
        if (pollRes.ok) {
          pairingCode = pollRes.data?.pairingCode || null;
          base64 = pollRes.data?.base64 || pollRes.data?.qrcode?.base64 || base64;
          code = pollRes.data?.code || pollRes.data?.qrcode?.code || code;
          if (pairingCode) {
            evoRes = pollRes;
            break;
          }
        }
      }
    }

    res.json({
      success: true,
      data: {
        pairingCode,
        base64,
        code,
        count: evoRes.data?.count || 1
      }
    });
  } catch (err) {
    console.error('[api] Erro ao conectar instância:', err);
    res.status(500).json({ success: false, error: 'Falha ao solicitar conexão' });
  }
});

// 4. Status de Conexão em Tempo Real
app.get('/api/v1/instances/:id/status', async (req, res) => {
  const { id } = req.params;
  if (!canAccessInstance(req, id)) {
    return res.status(403).json({ success: false, error: 'Acesso negado a esta instância.' });
  }
  try {
    const evoRes = await evolutionFetch(`/instance/connectionState/${encodeURIComponent(id)}`);

    const state = evoRes.data?.instance?.state || evoRes.data?.state || 'close';
    res.json({ success: true, state });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Falha ao verificar status' });
  }
});

// 5. Consultar Configurações (Settings)
app.get('/api/v1/instances/:id/settings', async (req, res) => {
  const { id } = req.params;
  if (!canAccessInstance(req, id)) {
    return res.status(403).json({ success: false, error: 'Acesso negado a esta instância.' });
  }
  try {
    const evoRes = await evolutionFetch(`/settings/find/${encodeURIComponent(id)}`);

    let settings = null;
    if (evoRes.ok && evoRes.data?.settings) {
      settings = evoRes.data.settings;
    } else if (pool) {
      // Fallback para o cache do banco
      const r = await pool.query('SELECT configuracoes FROM clientes WHERE id = $1', [id]);
      if (r.rows.length > 0) settings = r.rows[0].configuracoes;
    }

    res.json({
      success: true,
      settings: settings || {
        rejectCall: false,
        msgCall: '',
        groupsIgnore: true,
        alwaysOnline: false,
        readMessages: false,
        readStatus: false,
        syncFullHistory: false
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Falha ao buscar configurações' });
  }
});

// 6. Atualizar Configurações (Settings)
app.post('/api/v1/instances/:id/settings', async (req, res) => {
  const { id } = req.params;
  if (!canAccessInstance(req, id)) {
    return res.status(403).json({ success: false, error: 'Acesso negado a esta instância.' });
  }
  try {
    const {
      rejectCall = false,
      msgCall = '',
      groupsIgnore = true,
      alwaysOnline = false,
      readMessages = false,
      readStatus = false,
      syncFullHistory = false
    } = req.body;

    const payload = {
      rejectCall: Boolean(rejectCall),
      msgCall: String(msgCall || ''),
      groupsIgnore: Boolean(groupsIgnore),
      alwaysOnline: Boolean(alwaysOnline),
      readMessages: Boolean(readMessages),
      readStatus: Boolean(readStatus),
      syncFullHistory: Boolean(syncFullHistory)
    };

    // Atualiza na Evolution API
    const evoRes = await evolutionFetch(`/settings/set/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    // Salva no banco de dados local
    if (pool) {
      await pool.query(
        'UPDATE clientes SET configuracoes = $1, atualizado_em = NOW() WHERE id = $2',
        [JSON.stringify(payload), id]
      );
    }

    if (!evoRes.ok) {
      console.warn('[settings] Evolution retornou aviso:', evoRes.data);
    }

    res.json({ success: true, settings: payload });
  } catch (err) {
    console.error('[api] Erro ao salvar configurações:', err);
    res.status(500).json({ success: false, error: 'Falha ao salvar configurações' });
  }
});

// 6b. Consultar Prompt do Agente (persona/role/playbook)
app.get('/api/v1/instances/:id/prompt', async (req, res) => {
  const { id } = req.params;
  if (!canAccessInstance(req, id)) {
    return res.status(403).json({ success: false, error: 'Acesso negado ao prompt desta instância.' });
  }
  try {
    if (!pool) {
      return res.status(503).json({ success: false, error: 'Banco de dados indisponível' });
    }
    const r = await pool.query('SELECT * FROM prompt_config WHERE id = $1', [id]);
    if (r.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Prompt não configurado para este cliente' });
    }
    res.json({ success: true, prompt: r.rows[0] });
  } catch (err) {
    console.error('[api] Erro ao buscar prompt:', err);
    res.status(500).json({ success: false, error: 'Falha ao buscar prompt' });
  }
});

// 6c. Salvar Prompt do Agente (upsert idempotente)
app.put('/api/v1/instances/:id/prompt', async (req, res) => {
  const { id } = req.params;
  if (!canAccessInstance(req, id)) {
    return res.status(403).json({ success: false, error: 'Acesso negado para alterar prompt desta instância.' });
  }
  try {
    const {
      identity = '',
      role = '',
      personality = '',
      playbook = '',
      tools = '',
      locale = 'pt-BR',
      escalation_channel = '',
      escalation_target = '',
      escalation_policy = '',
      system_prompt = '',
      fatiamento_override = ''
    } = req.body;

    const prompt = {
      identity: String(identity || ''),
      role: String(role || ''),
      personality: String(personality || ''),
      playbook: String(playbook || ''),
      tools: String(tools || ''),
      locale: String(locale || 'pt-BR'),
      escalation_channel: String(escalation_channel || ''),
      escalation_target: String(escalation_target || ''),
      escalation_policy: String(escalation_policy || ''),
      system_prompt: String(system_prompt || ''),
      fatiamento_override: String(fatiamento_override || '')
    };

    const r = await pool.query(
      `INSERT INTO prompt_config (
         id, identity, role, personality, playbook, tools, locale,
         escalation_channel, escalation_target, escalation_policy,
         system_prompt, fatiamento_override, atualizado_em
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
       ON CONFLICT (id) DO UPDATE SET
         identity = EXCLUDED.identity,
         role = EXCLUDED.role,
         personality = EXCLUDED.personality,
         playbook = EXCLUDED.playbook,
         tools = EXCLUDED.tools,
         locale = EXCLUDED.locale,
         escalation_channel = EXCLUDED.escalation_channel,
         escalation_target = EXCLUDED.escalation_target,
         escalation_policy = EXCLUDED.escalation_policy,
         system_prompt = EXCLUDED.system_prompt,
         fatiamento_override = EXCLUDED.fatiamento_override,
         atualizado_em = NOW()
       RETURNING *`,
      [
        id,
        prompt.identity,
        prompt.role,
        prompt.personality,
        prompt.playbook,
        prompt.tools,
        prompt.locale,
        prompt.escalation_channel,
        prompt.escalation_target,
        prompt.escalation_policy,
        prompt.system_prompt,
        prompt.fatiamento_override
      ]
    );

    res.json({ success: true, prompt: r.rows[0] });
  } catch (err) {
    // 23503 = foreign_key_violation: cliente não existe em `clientes`
    if (err.code === '23503') {
      return res.status(404).json({ success: false, error: 'Cliente não encontrado para este ID' });
    }
    console.error('[api] Erro ao salvar prompt:', err);
    res.status(500).json({ success: false, error: 'Falha ao salvar prompt' });
  }
});

// 7. Reiniciar Instância
app.post('/api/v1/instances/:id/restart', async (req, res) => {
  const { id } = req.params;
  if (!canAccessInstance(req, id)) {
    return res.status(403).json({ success: false, error: 'Acesso negado a esta instância.' });
  }
  try {
    const evoRes = await evolutionFetch(`/instance/restart/${encodeURIComponent(id)}`, {
      method: 'POST'
    });

    res.json({ success: evoRes.ok, data: evoRes.data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Falha ao reiniciar instância' });
  }
});

// 8. Excluir Instância e Cliente
app.delete('/api/v1/instances/:id', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ success: false, error: 'Acesso restrito a administradores.' });
  }
  try {
    const { id } = req.params;

    // Remove na Evolution API
    await evolutionFetch(`/instance/delete/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });

    // Remove no banco de dados
    if (pool) {
      await pool.query('DELETE FROM clientes WHERE id = $1', [id]);
    }

    res.json({ success: true, message: `Instância ${id} removida com sucesso.` });
  } catch (err) {
    console.error('[api] Erro ao excluir instância:', err);
    res.status(500).json({ success: false, error: 'Falha ao excluir instância' });
  }
});

function resolvePeriodRange(query) {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  const periodo = String(query.periodo || '').trim().toLowerCase();
  const inicio = String(query.inicio || query.data_inicio || '').trim();
  const fim = String(query.fim || query.data_fim || '').trim();

  if (inicio || fim) {
    if (!dateRegex.test(inicio) || !dateRegex.test(fim)) {
      throw new Error('Formato de data inválido. Utilize YYYY-MM-DD.');
    }
    const dInicio = new Date(`${inicio}T00:00:00-03:00`);
    const dFim = new Date(`${fim}T23:59:59.999-03:00`);
    if (isNaN(dInicio.getTime()) || isNaN(dFim.getTime()) || dInicio > dFim) {
      throw new Error('Intervalo de datas inválido.');
    }
    const diffMs = dFim.getTime() - dInicio.getTime();
    const dPrevFim = new Date(dInicio.getTime() - 1);
    const dPrevInicio = new Date(dPrevFim.getTime() - diffMs);
    return {
      tipo: 'custom',
      inicio: dInicio,
      fim: dFim,
      prevInicio: dPrevInicio,
      prevFim: dPrevFim,
      labelInicio: inicio,
      labelFim: fim
    };
  }

  if (periodo === 'mes_atual' || (!query.dias && !periodo)) {
    const now = new Date();
    const dInicio = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const dFim = new Date(now.getTime());
    const dPrevInicio = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    const dPrevFim = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return {
      tipo: 'mes_atual',
      inicio: dInicio,
      fim: dFim,
      prevInicio: dPrevInicio,
      prevFim: dPrevFim,
      labelInicio: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`,
      labelFim: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    };
  }

  const rawDias = parseInt(query.dias || '30', 10);
  const dias = [7, 30, 90].includes(rawDias) ? rawDias : 30;
  const now = new Date();
  const dInicio = new Date(now.getTime() - dias * 24 * 60 * 60 * 1000);
  const dPrevInicio = new Date(now.getTime() - 2 * dias * 24 * 60 * 60 * 1000);
  return {
    tipo: 'dias',
    dias,
    inicio: dInicio,
    fim: now,
    prevInicio: dPrevInicio,
    prevFim: dInicio,
    labelInicio: dInicio.toISOString().slice(0, 10),
    labelFim: now.toISOString().slice(0, 10)
  };
}

// 9. Relatório Financeiro (Custo e Consumo de Tokens - Enxuto com Offloading)
app.get('/api/v1/financeiro', async (req, res) => {
  if (!pool) {
    return res.status(503).json({ success: false, error: 'Banco de dados indisponível' });
  }

  try {
    let range;
    try {
      range = resolvePeriodRange(req.query);
    } catch (valErr) {
      return res.status(400).json({ success: false, error: valErr.message });
    }

    let targetClienteId = null;
    if (isAdmin(req)) {
      if (req.query.cliente_id && req.query.cliente_id !== 'all') {
        targetClienteId = String(req.query.cliente_id).trim();
      }
    } else {
      if (req.query.cliente_id && String(req.query.cliente_id).trim() !== String(req.user.cliente_id).trim()) {
        return res.status(403).json({ success: false, error: 'Acesso negado ao relatório financeiro deste cliente.' });
      }
      targetClienteId = req.user.cliente_id;
    }

    const clientFilterWhere = targetClienteId ? ' AND cliente_id = $3' : '';
    const clientFilterWhereU = targetClienteId ? ' AND u.cliente_id = $3' : '';
    const queryParams = targetClienteId ? [range.inicio, range.fim, targetClienteId] : [range.inicio, range.fim];
    const prevQueryParams = targetClienteId ? [range.prevInicio, range.prevFim, targetClienteId] : [range.prevInicio, range.prevFim];

    const [kpiRes, kpiPrevRes, serieRes, clienteRes, modeloRes] = await Promise.all([
      // KPIs período atual (100% parametrizado)
      pool.query(
        `SELECT
           COALESCE(SUM(custo_usd), 0) AS custo_usd,
           COALESCE(COUNT(*), 0) AS requisicoes,
           COALESCE(SUM(total_tokens), 0) AS tokens_total,
           COALESCE(SUM(prompt_tokens), 0) AS tokens_prompt,
           COALESCE(SUM(completion_tokens), 0) AS tokens_completion,
           COALESCE(SUM(cached_tokens), 0) AS tokens_cached,
           COUNT(DISTINCT cliente_id) AS clientes_ativos
         FROM uso_tokens
         WHERE criado_em >= $1 AND criado_em <= $2${clientFilterWhere}`,
        queryParams
      ),
      // KPIs período anterior (para cálculo de delta no cliente)
      pool.query(
        `SELECT
           COALESCE(SUM(custo_usd), 0) AS custo_usd,
           COALESCE(COUNT(*), 0) AS requisicoes,
           COALESCE(SUM(total_tokens), 0) AS tokens_total,
           COALESCE(SUM(cached_tokens), 0) AS tokens_cached
         FROM uso_tokens
         WHERE criado_em >= $1 AND criado_em <= $2${clientFilterWhere}`,
        prevQueryParams
      ),
      // Série temporal diária agregada
      pool.query(
        `SELECT
           TO_CHAR(date_trunc('day', criado_em AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS dia,
           COALESCE(SUM(custo_usd), 0) AS custo_usd,
           COALESCE(SUM(total_tokens), 0) AS tokens,
           COUNT(*) AS requisicoes
         FROM uso_tokens
         WHERE criado_em >= $1 AND criado_em <= $2${clientFilterWhere}
         GROUP BY 1
         ORDER BY 1 ASC`,
        queryParams
      ),
      // Agrupamento por cliente
      pool.query(
        `SELECT
           u.cliente_id,
           COALESCE(c.nome, u.cliente_id) AS nome,
           COALESCE(SUM(u.custo_usd), 0) AS custo_usd,
           COALESCE(SUM(u.total_tokens), 0) AS tokens,
           COALESCE(SUM(u.cached_tokens), 0) AS tokens_cached,
           COUNT(*) AS requisicoes
         FROM uso_tokens u
         LEFT JOIN clientes c ON c.id = u.cliente_id
         WHERE u.criado_em >= $1 AND u.criado_em <= $2${clientFilterWhereU}
         GROUP BY u.cliente_id, c.nome
         ORDER BY custo_usd DESC, tokens DESC`,
        queryParams
      ),
      // Agrupamento por modelo
      pool.query(
        `SELECT
           COALESCE(provedor, 'desconhecido') AS provedor,
           COALESCE(modelo, 'desconhecido') AS modelo,
           COALESCE(SUM(custo_usd), 0) AS custo_usd,
           COALESCE(SUM(total_tokens), 0) AS tokens,
           COUNT(*) AS requisicoes
         FROM uso_tokens
         WHERE criado_em >= $1 AND criado_em <= $2${clientFilterWhere}
         GROUP BY provedor, modelo
         ORDER BY custo_usd DESC, tokens DESC`,
        queryParams
      )
    ]);

    const kpiRow = kpiRes.rows[0] || {};
    const kpiPrevRow = kpiPrevRes.rows[0] || {};

    const custo = Number(kpiRow.custo_usd || 0);
    const reqs = Number(kpiRow.requisicoes || 0);
    const tokensTotal = Number(kpiRow.tokens_total || 0);
    const tokensCached = Number(kpiRow.tokens_cached || 0);

    const prevCusto = Number(kpiPrevRow.custo_usd || 0);
    const prevReqs = Number(kpiPrevRow.requisicoes || 0);
    const prevTokens = Number(kpiPrevRow.tokens_total || 0);

    const serieBruta = serieRes.rows.map(r => ({
      dia: r.dia,
      custo_usd: Number(r.custo_usd || 0),
      tokens: Number(r.tokens || 0),
      requisicoes: Number(r.requisicoes || 0)
    }));

    const porCliente = clienteRes.rows.map(r => ({
      cliente_id: r.cliente_id,
      nome: r.nome,
      custo_usd: Number(r.custo_usd || 0),
      tokens: Number(r.tokens || 0),
      tokens_cached: Number(r.tokens_cached || 0),
      requisicoes: Number(r.requisicoes || 0)
    }));

    const porModelo = modeloRes.rows.map(r => ({
      provedor: r.provedor,
      modelo: r.modelo,
      custo_usd: Number(r.custo_usd || 0),
      tokens: Number(r.tokens || 0),
      requisicoes: Number(r.requisicoes || 0)
    }));

    res.json({
      success: true,
      data: {
        tipo_periodo: range.tipo,
        inicio: range.labelInicio,
        fim: range.labelFim,
        gerado_em: new Date().toISOString(),
        kpis: {
          custo_usd: custo,
          requisicoes: reqs,
          tokens_total: tokensTotal,
          tokens_prompt: Number(kpiRow.tokens_prompt || 0),
          tokens_completion: Number(kpiRow.tokens_completion || 0),
          tokens_cached: tokensCached,
          clientes_ativos: Number(kpiRow.clientes_ativos || 0)
        },
        kpis_anteriores: {
          custo_usd: prevCusto,
          requisicoes: prevReqs,
          tokens_total: prevTokens
        },
        serie_diaria: serieBruta,
        por_cliente: porCliente,
        por_modelo: porModelo
      }
    });
  } catch (err) {
    console.error('[api] Erro ao carregar dados financeiros:', err);
    res.status(500).json({ success: false, error: 'Falha ao processar dados financeiros' });
  }
});

// -----------------------------------------------------------------------------
// ROTAS DE GESTÃO E TESTE DE MODELOS (/api/v1/modelos)
// -----------------------------------------------------------------------------

// Rate limit simples em memória para testes de modelo (máx 10 testes por minuto por IP)
// ponytail: Map em memória com teto de 1000 entradas; migrar para Redis só se dashboard rodar em múltiplas réplicas
const testRateLimits = new Map();
const MAX_RATE_LIMIT_ENTRIES = 1000;
function checkTestRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 10;

  if (testRateLimits.size >= MAX_RATE_LIMIT_ENTRIES && !testRateLimits.has(ip)) {
    for (const [k, v] of testRateLimits.entries()) {
      if (now > v.resetAt) testRateLimits.delete(k);
    }
    if (testRateLimits.size >= MAX_RATE_LIMIT_ENTRIES) {
      const oldestKey = testRateLimits.keys().next().value;
      if (oldestKey !== undefined) testRateLimits.delete(oldestKey);
    }
  }

  const record = testRateLimits.get(ip) || { count: 0, resetAt: now + windowMs };

  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + windowMs;
  } else {
    record.count += 1;
  }
  testRateLimits.set(ip, record);
  return record.count <= maxRequests;
}

// GET /api/v1/9router/status - Diagnóstico e lista de modelos do 9Router
app.get('/api/v1/9router/status', async (_req, res) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  // Calcula URL base da API do 9Router (ex: http://9router:20000)
  const baseUrl = NINE_ROUTER_URL.replace(/\/v1\/?$/, '');

  let isHealthy = false;
  let models = [];
  let errorMsg = null;

  try {
    // 1. Checa health
    const healthRes = await fetch(`${baseUrl}/api/health`, { signal: controller.signal }).catch(() => null);
    if (healthRes && healthRes.ok) {
      const hData = await healthRes.json().catch(() => ({}));
      isHealthy = hData.ok === true || healthRes.status < 400;
    }

    // 2. Consulta modelos
    const modelsRes = await fetch(`${NINE_ROUTER_URL}/models`, {
      headers: NINE_ROUTER_API_KEY ? { 'Authorization': `Bearer ${NINE_ROUTER_API_KEY}` } : {},
      signal: controller.signal
    }).catch((e) => {
      errorMsg = e.message;
      return null;
    });

    if (modelsRes) {
      if (modelsRes.ok) {
        const mData = await modelsRes.json().catch(() => ({}));
        models = Array.isArray(mData.data) ? mData.data.map(m => ({
          id: m.id,
          owned_by: m.owned_by,
          capabilities: m.capabilities || null
        })) : [];
      } else {
        const errData = await modelsRes.json().catch(() => ({}));
        errorMsg = errData.error || `HTTP ${modelsRes.status}`;
      }
    }
  } catch (err) {
    errorMsg = err.message;
  } finally {
    clearTimeout(timeout);
  }

  res.json({
    success: true,
    gateway_url: NINE_ROUTER_URL,
    chat_endpoint: `${NINE_ROUTER_URL}/chat/completions`,
    has_api_key: Boolean(NINE_ROUTER_API_KEY),
    healthy: isHealthy,
    error: errorMsg,
    total_models: models.length,
    models
  });
});

// Constantes de validação
const ALLOWED_MODEL_TIERS = ['tier_1', 'tier_2', 'tier_3'];

// GET /api/v1/modelos - Listar todos os modelos
app.get('/api/v1/modelos', async (_req, res) => {
  if (!pool) return res.status(500).json({ success: false, error: 'Postgres não conectado' });
  try {
    const result = await pool.query(
      `SELECT id, provedor, modelo, tier, input_per_1m, cached_per_1m, output_per_1m,
              reasoning_per_1m, cache_creation_per_1m, moeda, vigente_de, vigente_ate, ativo
       FROM precos_modelos
       ORDER BY ativo DESC, tier ASC, input_per_1m ASC, provedor ASC, modelo ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[api] Erro ao listar modelos:', err.message);
    res.status(500).json({ success: false, error: 'Falha ao consultar modelos' });
  }
});

// POST /api/v1/modelos - Cadastrar novo modelo
app.post('/api/v1/modelos', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ success: false, error: 'Acesso restrito a administradores.' });
  }
  if (!pool) return res.status(500).json({ success: false, error: 'Postgres não conectado' });
  const { provedor, modelo, tier, input_per_1m, cached_per_1m, output_per_1m, reasoning_per_1m, cache_creation_per_1m, ativo } = req.body;

  // Sanitização rigorosa
  const provClean = String(provedor || '').trim().toLowerCase();
  const modClean = String(modelo || '').trim();
  const tierClean = String(tier || 'tier_1').trim().toLowerCase();

  if (!/^[a-zA-Z0-9_-]{2,50}$/.test(provClean)) {
    return res.status(400).json({ success: false, error: 'Provedor inválido (2-50 chars, alfanumérico, hífen ou underline)' });
  }
  if (!/^[a-zA-Z0-9_./:-]{2,100}$/.test(modClean)) {
    return res.status(400).json({ success: false, error: 'Nome de modelo inválido (2-100 chars)' });
  }
  if (!ALLOWED_MODEL_TIERS.includes(tierClean)) {
    return res.status(400).json({ success: false, error: 'Tier inválido. Opções: tier_1, tier_2, tier_3' });
  }

  const pInput = Math.max(0, Math.min(10000, Number(input_per_1m) || 0));
  const pCached = Math.max(0, Math.min(10000, Number(cached_per_1m) || 0));
  const pOutput = Math.max(0, Math.min(10000, Number(output_per_1m) || 0));
  const pReasoning = Math.max(0, Math.min(10000, Number(reasoning_per_1m) || 0));
  const pCacheCreation = Math.max(0, Math.min(10000, Number(cache_creation_per_1m) || 0));
  const isAtivo = ativo !== false;

  try {
    const insertRes = await pool.query(
      `INSERT INTO precos_modelos (provedor, modelo, tier, input_per_1m, cached_per_1m, output_per_1m, reasoning_per_1m, cache_creation_per_1m, moeda, vigente_de, ativo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'USD', NOW(), $9)
       RETURNING *`,
      [provClean, modClean, tierClean, pInput, pCached, pOutput, pReasoning, pCacheCreation, isAtivo]
    );
    res.status(201).json({ success: true, data: insertRes.rows[0] });
  } catch (err) {
    console.error('[api] Erro ao cadastrar modelo:', err.message);
    res.status(500).json({ success: false, error: 'Falha ao salvar modelo no banco' });
  }
});

// PUT /api/v1/modelos/:id - Atualizar modelo existente
app.put('/api/v1/modelos/:id', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ success: false, error: 'Acesso restrito a administradores.' });
  }
  if (!pool) return res.status(500).json({ success: false, error: 'Postgres não conectado' });
  const id = parseInt(req.params.id, 10);
  if (!id || id <= 0) return res.status(400).json({ success: false, error: 'ID inválido' });

  const { provedor, modelo, tier, input_per_1m, cached_per_1m, output_per_1m, reasoning_per_1m, cache_creation_per_1m, ativo } = req.body;

  const provClean = String(provedor || '').trim().toLowerCase();
  const modClean = String(modelo || '').trim();
  const tierClean = String(tier || 'tier_1').trim().toLowerCase();

  if (!/^[a-zA-Z0-9_-]{2,50}$/.test(provClean)) {
    return res.status(400).json({ success: false, error: 'Provedor inválido' });
  }
  if (!/^[a-zA-Z0-9_./:-]{2,100}$/.test(modClean)) {
    return res.status(400).json({ success: false, error: 'Nome de modelo inválido' });
  }
  if (!ALLOWED_MODEL_TIERS.includes(tierClean)) {
    return res.status(400).json({ success: false, error: 'Tier inválido. Opções: tier_1, tier_2, tier_3' });
  }

  const pInput = Math.max(0, Math.min(10000, Number(input_per_1m) || 0));
  const pCached = Math.max(0, Math.min(10000, Number(cached_per_1m) || 0));
  const pOutput = Math.max(0, Math.min(10000, Number(output_per_1m) || 0));
  const pReasoning = Math.max(0, Math.min(10000, Number(reasoning_per_1m) || 0));
  const pCacheCreation = Math.max(0, Math.min(10000, Number(cache_creation_per_1m) || 0));
  const isAtivo = ativo !== false;

  try {
    const updateRes = await pool.query(
      `UPDATE precos_modelos
       SET provedor = $1, modelo = $2, tier = $3, input_per_1m = $4, cached_per_1m = $5,
           output_per_1m = $6, reasoning_per_1m = $7, cache_creation_per_1m = $8, ativo = $9
       WHERE id = $10
       RETURNING *`,
      [provClean, modClean, tierClean, pInput, pCached, pOutput, pReasoning, pCacheCreation, isAtivo, id]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Modelo não encontrado' });
    }
    res.json({ success: true, data: updateRes.rows[0] });
  } catch (err) {
    console.error('[api] Erro ao atualizar modelo:', err.message);
    res.status(500).json({ success: false, error: 'Falha ao atualizar modelo' });
  }
});

// DELETE /api/v1/modelos/:id - Excluir modelo ou desativar com segurança
app.delete('/api/v1/modelos/:id', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ success: false, error: 'Acesso restrito a administradores.' });
  }
  if (!pool) return res.status(500).json({ success: false, error: 'Postgres não conectado' });
  const id = parseInt(req.params.id, 10);
  if (!id || id <= 0) return res.status(400).json({ success: false, error: 'ID inválido' });

  try {
    // Busca informações do modelo
    const modRes = await pool.query('SELECT provedor, modelo FROM precos_modelos WHERE id = $1', [id]);
    if (modRes.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Modelo não encontrado' });
    }
    const { provedor, modelo } = modRes.rows[0];

    // Checa se possui registros no ledger de uso de tokens
    const usageCheck = await pool.query(
      'SELECT 1 FROM uso_tokens WHERE provedor = $1 AND modelo = $2 LIMIT 1',
      [provedor, modelo]
    );

    if (usageCheck.rowCount > 0) {
      // Protege integridade referencial histórica desativando o modelo
      await pool.query('UPDATE precos_modelos SET ativo = false WHERE id = $1', [id]);
      return res.json({
        success: true,
        action: 'desativado',
        message: 'Modelo possui histórico financeiro; foi desativado em vez de excluído para preservar auditoria.'
      });
    }

    await pool.query('DELETE FROM precos_modelos WHERE id = $1', [id]);
    res.json({ success: true, action: 'removido', message: 'Modelo removido com sucesso' });
  } catch (err) {
    console.error('[api] Erro ao excluir modelo:', err.message);
    res.status(500).json({ success: false, error: 'Falha ao excluir modelo' });
  }
});

// POST /api/v1/modelos/:id/testar - Testar inferência/ping do modelo via 9Router
app.post('/api/v1/modelos/:id/testar', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ success: false, error: 'Acesso restrito a administradores.' });
  }
  if (!pool) return res.status(500).json({ success: false, error: 'Postgres não conectado' });
  const id = parseInt(req.params.id, 10);
  if (!id || id <= 0) return res.status(400).json({ success: false, error: 'ID inválido' });

  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local';
  if (!checkTestRateLimit(clientIp)) {
    return res.status(429).json({ success: false, error: 'Limite de testes atingido (máx 10 por minuto). Aguarde.' });
  }

  try {
    const modRes = await pool.query('SELECT provedor, modelo, ativo FROM precos_modelos WHERE id = $1', [id]);
    if (modRes.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Modelo não encontrado' });
    }
    const record = modRes.rows[0];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000); // 12s timeout estrito

    const startTime = Date.now();
    let statusHttp = 0;
    let rawResponse = null;

    try {
      const response = await fetch(`${NINE_ROUTER_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${NINE_ROUTER_API_KEY}`
        },
        body: JSON.stringify({
          model: record.modelo,
          messages: [{ role: 'user', content: 'Responda apenas "OK" em 1 palavra.' }],
          max_tokens: 5,
          temperature: 0.1
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);
      statusHttp = response.status;
      rawResponse = await response.json().catch(() => ({}));

      const latencyMs = Date.now() - startTime;
      const endpointUsed = `${NINE_ROUTER_URL}/chat/completions`;

      if (!response.ok) {
        return res.status(502).json({
          success: false,
          endpoint_url: endpointUsed,
          modelo_solicitado: record.modelo,
          latency_ms: latencyMs,
          status_http: statusHttp,
          error: rawResponse.error?.message || rawResponse.message || 'Falha na resposta do 9Router/LLM',
          raw: rawResponse
        });
      }

      // Captura resposta de texto ou reasoning_content caso presente
      const msg = rawResponse.choices?.[0]?.message || {};
      const reply = msg.content || (msg.reasoning_content ? `[Reasoning]: ${msg.reasoning_content}` : '(resposta vazia)');
      const usage = rawResponse.usage || null;

      res.json({
        success: true,
        endpoint_url: endpointUsed,
        modelo_solicitado: record.modelo,
        latency_ms: latencyMs,
        status_http: statusHttp,
        modelo_retornado: rawResponse.model || record.modelo,
        resposta: reply.trim(),
        usage
      });
    } catch (fetchErr) {
      clearTimeout(timeout);
      const latencyMs = Date.now() - startTime;
      const isTimeout = fetchErr.name === 'AbortError';

      res.status(504).json({
        success: false,
        endpoint_url: `${NINE_ROUTER_URL}/chat/completions`,
        modelo_solicitado: record.modelo,
        latency_ms: latencyMs,
        error: isTimeout ? 'Timeout: o modelo não respondeu em até 12 segundos' : `Erro de conexão com 9Router: ${fetchErr.message}`
      });
    }
  } catch (err) {
    console.error('[api] Erro ao testar modelo:', err.message);
    res.status(500).json({ success: false, error: 'Falha interna ao processar teste' });
  }
});

// -----------------------------------------------------------------------------
// ROTAS DE GESTÃO DE PROMPTS PADRÃO (/api/v1/prompts-padrao)
// -----------------------------------------------------------------------------

// GET /api/v1/prompts-padrao - Listar todos os prompts padrão
app.get('/api/v1/prompts-padrao', async (req, res) => {
  if (!pool) return res.status(500).json({ success: false, error: 'Postgres não conectado' });
  try {
    const { ativo } = req.query;
    const conditions = [];
    const values = [];

    if (ativo !== undefined && (ativo === 'true' || ativo === 'false')) {
      values.push(ativo === 'true');
      conditions.push(`ativo = $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `
      SELECT id, chave, nome, descricao, conteudo, modelo_sugerido,
             variaveis, ativo, versao, criado_em, atualizado_em
      FROM prompts_padrao
      ${whereClause}
      ORDER BY ativo DESC, nome ASC
    `;

    const result = await pool.query(query, values);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[api] Erro ao listar prompts padrão:', err.message);
    res.status(500).json({ success: false, error: 'Falha ao consultar prompts padrão' });
  }
});

// GET /api/v1/prompts-padrao/:id - Obter prompt padrão por ID ou chave
app.get('/api/v1/prompts-padrao/:id', async (req, res) => {
  if (!pool) return res.status(500).json({ success: false, error: 'Postgres não conectado' });
  const rawId = req.params.id;

  try {
    const isNumeric = /^\d+$/.test(rawId);
    const query = isNumeric
      ? 'SELECT * FROM prompts_padrao WHERE id = $1'
      : 'SELECT * FROM prompts_padrao WHERE chave = $1';
    const params = isNumeric ? [parseInt(rawId, 10)] : [rawId.trim().toLowerCase()];

    const result = await pool.query(query, params);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Prompt padrão não encontrado' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[api] Erro ao buscar prompt padrão:', err.message);
    res.status(500).json({ success: false, error: 'Falha ao consultar prompt padrão' });
  }
});

// POST /api/v1/prompts-padrao - Cadastrar novo prompt padrão
app.post('/api/v1/prompts-padrao', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ success: false, error: 'Acesso restrito a administradores.' });
  }
  if (!pool) return res.status(500).json({ success: false, error: 'Postgres não conectado' });
  const { chave, nome, descricao, conteudo, modelo_sugerido, variaveis, ativo } = req.body;

  const chaveClean = String(chave || '').trim().toLowerCase();
  const nomeClean = String(nome || '').trim();
  const conteudoClean = String(conteudo || '').trim();
  const descClean = String(descricao || '').trim();
  const modClean = String(modelo_sugerido || '').trim();

  // Validação estrita
  if (!/^[a-z0-9_-]{3,100}$/.test(chaveClean)) {
    return res.status(400).json({
      success: false,
      error: 'Chave inválida. Use de 3 a 100 caracteres minúsculos, números, underline ou hífen (ex: roteador_modelos).'
    });
  }

  if (nomeClean.length < 2 || nomeClean.length > 200) {
    return res.status(400).json({ success: false, error: 'Nome do prompt deve ter entre 2 e 200 caracteres.' });
  }

  if (!conteudoClean || conteudoClean.length > 500000) {
    return res.status(400).json({ success: false, error: 'Conteúdo do prompt é obrigatório e deve ter no máximo 500KB.' });
  }

  // Valida integridade referencial do modelo sugerido
  if (modClean) {
    const checkModel = await pool.query(
      'SELECT 1 FROM precos_modelos WHERE modelo = $1 AND ativo = true LIMIT 1',
      [modClean]
    );
    if (checkModel.rowCount === 0) {
      return res.status(400).json({
        success: false,
        error: `O modelo "${modClean}" não está cadastrado ou ativo na tabela de modelos.`
      });
    }
  }

  let varsJson = '[]';
  try {
    varsJson = Array.isArray(variaveis) ? JSON.stringify(variaveis) : (variaveis ? JSON.stringify([variaveis]) : '[]');
  } catch (_e) {
    varsJson = '[]';
  }

  const isAtivo = ativo !== false;

  try {
    // Checa duplicação de chave
    const checkDup = await pool.query('SELECT 1 FROM prompts_padrao WHERE chave = $1', [chaveClean]);
    if (checkDup.rowCount > 0) {
      return res.status(409).json({ success: false, error: `Já existe um prompt padrão cadastrado com a chave "${chaveClean}".` });
    }

    const insertRes = await pool.query(
      `INSERT INTO prompts_padrao (chave, nome, descricao, conteudo, modelo_sugerido, variaveis, ativo, versao, criado_em, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 1, NOW(), NOW())
       RETURNING *`,
      [chaveClean, nomeClean, descClean, conteudoClean, modClean || null, varsJson, isAtivo]
    );

    res.status(201).json({ success: true, data: insertRes.rows[0] });
  } catch (err) {
    console.error('[api] Erro ao cadastrar prompt padrão:', err.message);
    res.status(500).json({ success: false, error: 'Falha ao salvar prompt padrão' });
  }
});

// PUT /api/v1/prompts-padrao/:id - Atualizar prompt padrão
app.put('/api/v1/prompts-padrao/:id', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ success: false, error: 'Acesso restrito a administradores.' });
  }
  if (!pool) return res.status(500).json({ success: false, error: 'Postgres não conectado' });
  const id = parseInt(req.params.id, 10);
  if (!id || id <= 0) return res.status(400).json({ success: false, error: 'ID inválido' });

  const { chave, nome, descricao, conteudo, modelo_sugerido, variaveis, ativo } = req.body;

  const chaveClean = String(chave || '').trim().toLowerCase();
  const nomeClean = String(nome || '').trim();
  const conteudoClean = String(conteudo || '').trim();
  const descClean = String(descricao || '').trim();
  const modClean = String(modelo_sugerido || '').trim();

  if (!/^[a-z0-9_-]{3,100}$/.test(chaveClean)) {
    return res.status(400).json({ success: false, error: 'Chave inválida (3-100 chars, alfanumérico, hífen ou underline).' });
  }

  if (nomeClean.length < 2 || nomeClean.length > 200) {
    return res.status(400).json({ success: false, error: 'Nome do prompt deve ter entre 2 e 200 caracteres.' });
  }

  if (!conteudoClean || conteudoClean.length > 500000) {
    return res.status(400).json({ success: false, error: 'Conteúdo do prompt é obrigatório (máx 500KB).' });
  }

  // Valida integridade referencial do modelo sugerido
  if (modClean) {
    const checkModel = await pool.query(
      'SELECT 1 FROM precos_modelos WHERE modelo = $1 AND ativo = true LIMIT 1',
      [modClean]
    );
    if (checkModel.rowCount === 0) {
      return res.status(400).json({
        success: false,
        error: `O modelo "${modClean}" não está cadastrado ou ativo na tabela de modelos.`
      });
    }
  }

  let varsJson = '[]';
  try {
    varsJson = Array.isArray(variaveis) ? JSON.stringify(variaveis) : (variaveis ? JSON.stringify([variaveis]) : '[]');
  } catch (_e) {
    varsJson = '[]';
  }

  const isAtivo = ativo !== false;

  try {
    // Checa duplicação de chave em outro registro
    const checkDup = await pool.query('SELECT id FROM prompts_padrao WHERE chave = $1 AND id <> $2', [chaveClean, id]);
    if (checkDup.rowCount > 0) {
      return res.status(409).json({ success: false, error: `A chave "${chaveClean}" já está em uso por outro prompt.` });
    }

    const updateRes = await pool.query(
      `UPDATE prompts_padrao
       SET chave = $1, nome = $2, descricao = $3, conteudo = $4,
           modelo_sugerido = $5, variaveis = $6::jsonb, ativo = $7,
           versao = versao + 1, atualizado_em = NOW()
       WHERE id = $8
       RETURNING *`,
      [chaveClean, nomeClean, descClean, conteudoClean, modClean || null, varsJson, isAtivo, id]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Prompt padrão não encontrado' });
    }

    res.json({ success: true, data: updateRes.rows[0] });
  } catch (err) {
    console.error('[api] Erro ao atualizar prompt padrão:', err.message);
    res.status(500).json({ success: false, error: 'Falha ao atualizar prompt padrão' });
  }
});

// DELETE /api/v1/prompts-padrao/:id - Excluir ou desativar com proteção de integridade
app.delete('/api/v1/prompts-padrao/:id', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ success: false, error: 'Acesso restrito a administradores.' });
  }
  if (!pool) return res.status(500).json({ success: false, error: 'Postgres não conectado' });
  const id = parseInt(req.params.id, 10);
  if (!id || id <= 0) return res.status(400).json({ success: false, error: 'ID inválido' });

  try {
    const promptRes = await pool.query('SELECT chave FROM prompts_padrao WHERE id = $1', [id]);
    if (promptRes.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Prompt padrão não encontrado' });
    }

    const { chave } = promptRes.rows[0];

    // Proteção de segurança industrial: o prompt core do sistema não deve ser destruído
    if (chave === 'roteador_modelos_economia') {
      await pool.query('UPDATE prompts_padrao SET ativo = false WHERE id = $1', [id]);
      return res.json({
        success: true,
        action: 'desativado',
        message: 'Prompt mestre do sistema foi desativado em vez de excluído para evitar interrupção de fluxos n8n.'
      });
    }

    await pool.query('DELETE FROM prompts_padrao WHERE id = $1', [id]);
    res.json({ success: true, action: 'removido', message: 'Prompt padrão removido com sucesso' });
  } catch (err) {
    console.error('[api] Erro ao excluir prompt padrão:', err.message);
    res.status(500).json({ success: false, error: 'Falha ao excluir prompt padrão' });
  }
});

// -----------------------------------------------------------------------------
// BASE DE CONHECIMENTO & RAG (pgvector)
// -----------------------------------------------------------------------------

// GET /api/v1/conhecimento/stats - Métricas agregadas de conhecimento e vetores
app.get('/api/v1/conhecimento/stats', async (req, res) => {
  if (!pool) return res.status(500).json({ success: false, error: 'Postgres não conectado' });
  try {
    const isAdm = isAdmin(req);
    const filter = isAdm ? '' : "WHERE (instance_id = $1 OR metadata->>'instance_id' = $1)";
    const params = isAdm ? [] : [req.user.cliente_id];
    const statsQuery = `
      SELECT
        COUNT(*)::int AS total_fragmentos,
        COUNT(DISTINCT COALESCE(instance_id, metadata->>'instance_id'))::int AS total_tenants,
        COUNT(CASE WHEN embedding IS NOT NULL THEN 1 END)::int AS com_vetor,
        COUNT(CASE WHEN embedding IS NULL THEN 1 END)::int AS sem_vetor,
        COALESCE(ROUND(AVG(LENGTH(text))), 0)::int AS media_caracteres
      FROM base_conhecimento
      ${filter}
    `;
    const result = await pool.query(statsQuery, params);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[api] Erro ao buscar métricas de conhecimento:', err.message);
    res.status(500).json({ success: false, error: 'Falha ao consultar métricas da base de conhecimento' });
  }
});

// GET /api/v1/conhecimento - Listar fragmentos com paginação, filtro e busca trigram
app.get('/api/v1/conhecimento', async (req, res) => {
  if (!pool) return res.status(500).json({ success: false, error: 'Postgres não conectado' });
  try {
    const { instance_id, busca, before_id } = req.query;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit || '25', 10)));
    const offset = (page - 1) * limit;

    const conditions = [];
    const values = [];

    let targetInstance = null;
    if (isAdmin(req)) {
      if (instance_id && instance_id !== 'all') {
        targetInstance = instance_id.trim();
      }
    } else {
      if (instance_id && instance_id !== 'all' && instance_id.trim() !== req.user.cliente_id) {
        return res.status(403).json({ success: false, error: 'Acesso negado aos documentos deste cliente.' });
      }
      targetInstance = req.user.cliente_id;
    }

    if (targetInstance) {
      values.push(targetInstance);
      conditions.push(`(b.instance_id = $${values.length} OR b.metadata->>'instance_id' = $${values.length})`);
    }

    if (busca && busca.trim().length > 0) {
      values.push(`%${busca.trim()}%`);
      conditions.push(`(b.text ILIKE $${values.length} OR b.metadata::text ILIKE $${values.length})`);
    }

    if (before_id && parseInt(before_id, 10) > 0) {
      values.push(parseInt(before_id, 10));
      conditions.push(`b.id < $${values.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Projeção segura: NUNCA trafegar o vetor float32 bruto de 3072 posições
    const query = `
      SELECT
        b.id,
        COALESCE(b.instance_id, b.metadata->>'instance_id') AS instance_id,
        COALESCE(c.nome, b.instance_id, b.metadata->>'instance_id', 'Sem cliente') AS cliente_nome,
        b.text,
        b.metadata,
        LENGTH(b.text) AS tamanho_caracteres,
        (b.embedding IS NOT NULL) AS tem_vetor,
        CASE WHEN b.embedding IS NOT NULL THEN 3072 ELSE 0 END AS dimensao_vetor,
        COALESCE(b.criado_em, NOW()) AS criado_em,
        COUNT(*) OVER() AS total_count
      FROM base_conhecimento b
      LEFT JOIN clientes c ON c.id = COALESCE(b.instance_id, b.metadata->>'instance_id')
      ${whereClause}
      ORDER BY b.id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}
    `;

    values.push(limit, offset);

    const result = await pool.query(query, values);
    const totalCount = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;
    const totalPages = Math.ceil(totalCount / limit);

    // Remove total_count de cada item para payload limpo
    const items = result.rows.map(row => {
      const { total_count, ...clean } = row;
      return clean;
    });

    res.json({
      success: true,
      data: items,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages
      }
    });
  } catch (err) {
    console.error('[api] Erro ao listar fragmentos de conhecimento:', err.message);
    res.status(500).json({ success: false, error: 'Falha ao consultar fragmentos da base de conhecimento' });
  }
});

// GET /api/v1/conhecimento/:id - Obter fragmento individual com metadados detalhados
app.get('/api/v1/conhecimento/:id', async (req, res) => {
  if (!pool) return res.status(500).json({ success: false, error: 'Postgres não conectado' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'ID inválido' });

  try {
    const query = `
      SELECT
        b.id,
        COALESCE(b.instance_id, b.metadata->>'instance_id') AS instance_id,
        COALESCE(c.nome, b.instance_id, b.metadata->>'instance_id', 'Sem cliente') AS cliente_nome,
        b.text,
        b.metadata,
        LENGTH(b.text) AS tamanho_caracteres,
        (b.embedding IS NOT NULL) AS tem_vetor,
        CASE WHEN b.embedding IS NOT NULL THEN 3072 ELSE 0 END AS dimensao_vetor,
        COALESCE(b.criado_em, NOW()) AS criado_em,
        b.atualizado_em
      FROM base_conhecimento b
      LEFT JOIN clientes c ON c.id = COALESCE(b.instance_id, b.metadata->>'instance_id')
      WHERE b.id = $1
    `;
    const result = await pool.query(query, [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Fragmento não encontrado' });
    }
    const doc = result.rows[0];
    if (!canAccessInstance(req, doc.instance_id)) {
      return res.status(403).json({ success: false, error: 'Acesso negado a este fragmento.' });
    }
    res.json({ success: true, data: doc });
  } catch (err) {
    console.error('[api] Erro ao obter fragmento de conhecimento:', err.message);
    res.status(500).json({ success: false, error: 'Falha ao buscar fragmento de conhecimento' });
  }
});

// POST /api/v1/conhecimento - Inserir novo fragmento textual de conhecimento
app.post('/api/v1/conhecimento', async (req, res) => {
  if (!pool) return res.status(500).json({ success: false, error: 'Postgres não conectado' });
  const { instance_id, text, metadata } = req.body;

  if (!instance_id || typeof instance_id !== 'string') {
    return res.status(400).json({ success: false, error: 'ID da instância (cliente) é obrigatório' });
  }
  if (!canAccessInstance(req, instance_id)) {
    return res.status(403).json({ success: false, error: 'Acesso negado para cadastrar conhecimento em outro cliente.' });
  }
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ success: false, error: 'Conteúdo textual do documento é obrigatório' });
  }

  let parsedMetadata = {};
  if (metadata) {
    if (typeof metadata === 'object') {
      parsedMetadata = metadata;
    } else if (typeof metadata === 'string') {
      try {
        parsedMetadata = JSON.parse(metadata);
      } catch (e) {
        return res.status(400).json({ success: false, error: 'Metadados devem ser um JSON válido' });
      }
    }
  }

  try {
    // Insere sem vetor (ficará com status pendente até n8n/processador gerar embedding)
    const insertQuery = `
      INSERT INTO base_conhecimento (instance_id, text, metadata, criado_em, atualizado_em)
      VALUES ($1, $2, $3, NOW(), NOW())
      RETURNING id, instance_id, LENGTH(text) AS tamanho_caracteres, criado_em
    `;
    const result = await pool.query(insertQuery, [instance_id.trim(), text.trim(), JSON.stringify(parsedMetadata)]);
    res.status(201).json({ success: true, data: result.rows[0], message: 'Fragmento cadastrado com sucesso' });
  } catch (err) {
    console.error('[api] Erro ao cadastrar fragmento de conhecimento:', err.message);
    res.status(500).json({ success: false, error: 'Falha ao salvar fragmento no banco de dados' });
  }
});

// DELETE /api/v1/conhecimento/:id - Remover fragmento individual
app.delete('/api/v1/conhecimento/:id', async (req, res) => {
  if (!pool) return res.status(500).json({ success: false, error: 'Postgres não conectado' });
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'ID inválido' });

  try {
    if (!isAdmin(req)) {
      const checkDoc = await pool.query("SELECT COALESCE(instance_id, metadata->>'instance_id') AS inst_id FROM base_conhecimento WHERE id = $1", [id]);
      if (checkDoc.rowCount > 0 && !canAccessInstance(req, checkDoc.rows[0].inst_id)) {
        return res.status(403).json({ success: false, error: 'Acesso negado para excluir fragmento de outro cliente.' });
      }
    }
    const result = await pool.query('DELETE FROM base_conhecimento WHERE id = $1 RETURNING id', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Fragmento não encontrado' });
    }
    res.json({ success: true, message: 'Fragmento removido com sucesso' });
  } catch (err) {
    console.error('[api] Erro ao excluir fragmento de conhecimento:', err.message);
    res.status(500).json({ success: false, error: 'Falha ao remover fragmento' });
  }
});

// POST /api/v1/conhecimento/bulk-delete - Exclusão em lote industrial
app.post('/api/v1/conhecimento/bulk-delete', async (req, res) => {
  if (!pool) return res.status(500).json({ success: false, error: 'Postgres não conectado' });
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: 'Array de IDs é obrigatório' });
  }

  const cleanIds = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0);
  if (cleanIds.length === 0) {
    return res.status(400).json({ success: false, error: 'Nenhum ID numérico válido fornecido' });
  }

  try {
    if (!isAdmin(req)) {
      const checkDocs = await pool.query(
        "SELECT id FROM base_conhecimento WHERE id = ANY($1::int[]) AND COALESCE(instance_id, metadata->>'instance_id') != $2",
        [cleanIds, req.user.cliente_id]
      );
      if (checkDocs.rowCount > 0) {
        return res.status(403).json({ success: false, error: 'Acesso negado para excluir fragmentos de outros clientes.' });
      }
    }
    const result = await pool.query('DELETE FROM base_conhecimento WHERE id = ANY($1::int[]) RETURNING id', [cleanIds]);
    res.json({
      success: true,
      removidos: result.rowCount,
      message: `${result.rowCount} fragmento(s) removido(s) com sucesso`
    });
  } catch (err) {
    console.error('[api] Erro na exclusão em lote de conhecimento:', err.message);
    res.status(500).json({ success: false, error: 'Falha ao excluir fragmentos em lote' });
  }
});

// Middleware global de tratamento de erros (impede vazamento de stack traces e padroniza JSON)
app.use((err, req, res, _next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ success: false, error: 'Payload JSON malformado ou inválido.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'Payload excede o limite máximo permitido de 256KB.' });
  }
  console.error('[server] Erro não tratado:', err.message);
  res.status(err.status || 500).json({ success: false, error: 'Erro interno no processamento da requisição.' });
});

// Inicia servidor HTTP
app.listen(port, '0.0.0.0', async () => {
  console.log(`[dashboard] Painel administrativo ativo na porta ${port}`);
  if (pool) {
    await auth.initAdminUser(pool);
  }
});
