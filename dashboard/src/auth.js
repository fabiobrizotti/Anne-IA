'use strict';

const crypto = require('crypto');
const util = require('util');

const scryptAsync = util.promisify(crypto.scrypt);

// Chave mestre de 32 bytes derivada de segredo de ambiente (para AES-256-GCM e HMAC)
const MASTER_SECRET = process.env.AUTH_SECRET_KEY ||
  process.env.DASHBOARD_PASSWORD ||
  'anne-ia-production-auth-salt-key-2026';
const CRYPTO_KEY = crypto.createHash('sha256').update(MASTER_SECRET).digest();
const HMAC_KEY = crypto.createHash('sha256').update(Buffer.concat([CRYPTO_KEY, Buffer.from(':hmac-v1')])).digest();

// -----------------------------------------------------------------------------
// 1. HASHING E VERIFICAÇÃO DE SENHAS (NIST SP 800-63B / scrypt)
// -----------------------------------------------------------------------------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const cost = 16384;
  const blockSize = 8;
  const parallel = 1;
  const derived = await scryptAsync(password, salt, 64, { N: cost, r: blockSize, p: parallel });
  return `scrypt$${cost}$${blockSize}$${parallel}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') {
    // Executa scrypt dummy para mitigar timing attack de enumeração
    await hashPassword('dummy-password-timing-defense');
    return false;
  }

  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    await hashPassword('dummy-password-timing-defense');
    return false;
  }

  const cost = parseInt(parts[1], 10);
  const blockSize = parseInt(parts[2], 10);
  const parallel = parseInt(parts[3], 10);
  const salt = Buffer.from(parts[4], 'hex');
  const expectedHash = Buffer.from(parts[5], 'hex');

  const derived = await scryptAsync(password, salt, expectedHash.length, {
    N: cost,
    r: blockSize,
    p: parallel
  });

  return crypto.timingSafeEqual(derived, expectedHash);
}

// -----------------------------------------------------------------------------
// 2. ISOLAMENTO E CIFRAGEM LGPD (AES-256-GCM + HMAC BLIND INDEX)
// -----------------------------------------------------------------------------

function hashCpf(cpfDigits) {
  const clean = String(cpfDigits || '').replace(/\D/g, '');
  return crypto.createHmac('sha256', HMAC_KEY).update(clean).digest('hex');
}

function encryptCpf(cpfDigits) {
  const clean = String(cpfDigits || '').replace(/\D/g, '');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', CRYPTO_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(clean, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

function maskCpf(cpfDigits) {
  const clean = String(cpfDigits || '').replace(/\D/g, '');
  if (clean.length !== 11) return '***.***.***-**';
  return `***.${clean.substring(3, 6)}.${clean.substring(6, 9)}-**`;
}

function validateCpf(cpf) {
  const clean = String(cpf || '').replace(/\D/g, '');
  if (clean.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(clean)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(clean[i], 10) * (10 - i);
  let rem = (sum * 10) % 11;
  if (rem === 10 || rem === 11) rem = 0;
  if (rem !== parseInt(clean[9], 10)) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(clean[i], 10) * (11 - i);
  rem = (sum * 10) % 11;
  if (rem === 10 || rem === 11) rem = 0;
  return rem === parseInt(clean[10], 10);
}

// -----------------------------------------------------------------------------
// 3. SESSÕES SERVER-SIDE E COOKIES (OWASP / SameSite / HttpOnly)
// -----------------------------------------------------------------------------

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function parseCookies(req) {
  const list = {};
  const header = req.headers.cookie;
  if (!header) return list;
  header.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    const name = parts.shift().trim();
    if (name) {
      list[name] = decodeURIComponent(parts.join('='));
    }
  });
  return list;
}

function setSessionCookie(req, res, token, maxAgeSeconds) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  // Em HTTPS usa prefixo seguro __Host-
  const cookieName = isHttps ? '__Host-sid' : 'sid';
  let cookieVal = `${cookieName}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax`;
  if (isHttps) {
    cookieVal += '; Secure';
  }
  res.setHeader('Set-Cookie', cookieVal);
}

function clearSessionCookie(req, res) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const cookieName = isHttps ? '__Host-sid' : 'sid';
  res.setHeader('Set-Cookie', [
    `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    `sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    `__Host-sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
  ]);
}

// -----------------------------------------------------------------------------
// 4. RATE LIMITING DE LOGIN & PROTEÇÃO BRUTE FORCE
// -----------------------------------------------------------------------------

const bruteForceMap = new Map();
const MAX_FAILURES_USER = 5;
const MAX_FAILURES_IP = 15;
const BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutos
const WINDOW_MS = 5 * 60 * 1000; // 5 minutos

function checkEntryBlocked(entry, now) {
  if (!entry) return { blocked: false };
  if (entry.blockedUntil && now < entry.blockedUntil) {
    const remainingSeconds = Math.ceil((entry.blockedUntil - now) / 1000);
    return { blocked: true, remainingSeconds };
  }
  if (now - entry.firstAttempt > WINDOW_MS && (!entry.blockedUntil || now >= entry.blockedUntil)) {
    return { expired: true, blocked: false };
  }
  return { blocked: false };
}

function checkBruteForce(ip, identifier) {
  const now = Date.now();
  const cleanId = String(identifier || '').trim().toLowerCase();
  const cleanIp = String(ip || '').trim();

  // 1. Checa bloqueio por conta/identificador (defesa contra força bruta com rotação de IP)
  if (cleanId) {
    const userKey = `user:${cleanId}`;
    const userEntry = bruteForceMap.get(userKey);
    const userStatus = checkEntryBlocked(userEntry, now);
    if (userStatus.expired) bruteForceMap.delete(userKey);
    else if (userStatus.blocked) return userStatus;
  }

  // 2. Checa bloqueio por IP (defesa contra credential stuffing com múltiplas contas)
  if (cleanIp) {
    const ipKey = `ip:${cleanIp}`;
    const ipEntry = bruteForceMap.get(ipKey);
    const ipStatus = checkEntryBlocked(ipEntry, now);
    if (ipStatus.expired) bruteForceMap.delete(ipKey);
    else if (ipStatus.blocked) return ipStatus;
  }

  return { blocked: false };
}

function recordFailureFor(key, maxFailures, now) {
  const entry = bruteForceMap.get(key) || { count: 0, firstAttempt: now, blockedUntil: null };
  entry.count += 1;
  if (entry.count >= maxFailures) {
    entry.blockedUntil = now + BLOCK_DURATION_MS;
  }
  bruteForceMap.set(key, entry);
}

function recordBruteForceFailure(ip, identifier) {
  const now = Date.now();
  const cleanId = String(identifier || '').trim().toLowerCase();
  const cleanIp = String(ip || '').trim();

  if (cleanId) recordFailureFor(`user:${cleanId}`, MAX_FAILURES_USER, now);
  if (cleanIp) recordFailureFor(`ip:${cleanIp}`, MAX_FAILURES_IP, now);

  // Evita memory leak
  if (bruteForceMap.size > 3000) {
    for (const [k, v] of bruteForceMap.entries()) {
      if (v.blockedUntil && now > v.blockedUntil) bruteForceMap.delete(k);
    }
  }
}

function resetBruteForce(ip, identifier) {
  const cleanId = String(identifier || '').trim().toLowerCase();
  if (cleanId) bruteForceMap.delete(`user:${cleanId}`);
}

// -----------------------------------------------------------------------------
// 5. AUDITORIA DE AUTENTICAÇÃO (LGPD Art. 6º, X e Marco Civil Art. 15)
// -----------------------------------------------------------------------------

async function recordAudit(pool, { userId = null, identificador = '', evento, sucesso, ip = '', userAgent = '', detalhes = {} }) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO dashboard_auditoria_auth
       (user_id, identificador, evento, sucesso, ip, user_agent, detalhes)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        userId,
        identificador ? identificador.substring(0, 255) : null,
        evento,
        sucesso,
        ip ? ip.substring(0, 45) : null,
        userAgent ? userAgent.substring(0, 500) : null,
        JSON.stringify(detalhes)
      ]
    );
  } catch (err) {
    console.error('[auth-audit] Erro ao gravar log de auditoria:', err.message);
  }
}

// -----------------------------------------------------------------------------
// 6. TEXTOS LEGAIS LGPD CANÔNICOS (v1.0)
// -----------------------------------------------------------------------------

const legalTexts = {
  termos_uso: {
    titulo: 'Termos de Uso da Plataforma Anne-IA',
    versao: 'v1.0',
    data: '2026-10-31',
    conteudo: `
1. OBJETO E ESCOPO
A Anne-IA é uma plataforma de orquestração de inteligência artificial, mensageria e automação empresarial voltada ao atendimento omnichannel. O uso do painel administrativo é restrito a operadores autorizados pela organização contratante.

2. CONTAS, CREDENCIAIS E ACESSO
O usuário é integralmente responsável pelo sigilo de suas credenciais de acesso. O compartilhamento de senhas é terminantemente vedado. Toda atividade realizada mediante credenciais válidas é atribuída ao respectivo titular.

3. USO ACEITÁVEL E SEGURANÇA
É proibido utilizar a plataforma para fins ilícitos, envio de spam, disseminação de conteúdo discriminatório ou tentativas de engenharia reversa, varredura de vulnerabilidades ou negação de serviço. Tentativas reiteradas de invasão resultam em bloqueio automático e notificação aos encarregados.

4. DISPONIBILIDADE E RESPONSABILIDADE
A plataforma opera sob as melhores práticas de alta disponibilidade e segurança da informação, aplicando Quorum Queues, isolamento em redes internas e cifragem de ponta a ponta. A Anne-IA não se responsabiliza por indisponibilidades decorrentes de provedores terceiros de telecomunicações ou mensageria externa.
    `.trim()
  },
  politica_privacidade: {
    titulo: 'Política de Privacidade e Governança de Dados (LGPD)',
    versao: 'v1.0',
    data: '2026-10-31',
    conteudo: `
1. COMPROMISSO COM A LEI GERAL DE PROTEÇÃO DE DADOS (LEI 13.709/2018)
A Anne-IA atua com estrita observância aos princípios da finalidade, adequação, necessidade, livre acesso, qualidade dos dados, transparência, segurança, prevenção e não discriminação.

2. DADOS COLETADOS E BASES LEGAIS
- Dados de Cadastro: Nome, e-mail corporativo, telefone e CPF (cifrado via AES-256-GCM com blind index HMAC). Finalidade: Execução de contrato e autenticação (Art. 7º, V).
- Registros de Conexão: Endereço IP, data/hora e identificador de sessão. Finalidade: Cumprimento de obrigação legal (Art. 15 Marco Civil da Internet).
- Metadados de Conversação: Tratados de forma anonimizada ou pseudonimizada para suporte e operação do assistente.

3. DIREITOS DO TITULAR (ART. 18 LGPD)
O titular possui direito a: confirmação de tratamento, acesso aos dados, correção de dados incompletos ou inexatos, anonimização ou eliminação de dados desnecessários, portabilidade e revogação do consentimento.

4. RETENÇÃO E ELIMINAÇÃO
Os dados são mantidos pelo período estritamente necessário para cumprimento das finalidades contratuais e regulatórias. Rotinas de expurgo automatizado (fn_lgpd_expurgo_retencao) eliminam memórias antigas e trilhas expiradas.

5. ENCARREGADO DE PROTEÇÃO DE DADOS (DPO)
Para exercer seus direitos ou esclarecer dúvidas sobre o tratamento de dados pessoais, contate nosso Encarregado pelo canal: privacidade@anne-ia.local.
    `.trim()
  }
};

// -----------------------------------------------------------------------------
// 7. BOOTSTRAP DE ADMIN INICIAL IDEMPOTENTE
// -----------------------------------------------------------------------------

async function initAdminUser(pool) {
  if (!pool) return;
  try {
    const checkRes = await pool.query('SELECT COUNT(*)::int AS count FROM dashboard_usuarios');
    if (checkRes.rows[0].count > 0) return;

    const adminUser = process.env.DASHBOARD_USERNAME || 'admin';
    const adminPass = process.env.DASHBOARD_PASSWORD || 'AnneIA@Admin2026!';
    const adminEmail = process.env.DASHBOARD_EMAIL || 'admin@anne-ia.local';

    console.log('[auth] Tabela de usuários vazia. Provisionando admin inicial...');
    const customerCode = `ADM-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const passwordHash = await hashPassword(adminPass);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userRes = await client.query(
        `INSERT INTO dashboard_usuarios (customer_code, status, role)
         VALUES ($1, 'ativo', 'admin') RETURNING id`,
        [customerCode]
      );
      const userId = userRes.rows[0].id;

      await client.query(
        `INSERT INTO dashboard_identidades (user_id, nome)
         VALUES ($1, $2)`,
        [userId, `Administrador (${adminUser})`]
      );

      await client.query(
        `INSERT INTO dashboard_contatos (user_id, email)
         VALUES ($1, $2)`,
        [userId, adminEmail.toLowerCase()]
      );

      await client.query(
        `INSERT INTO dashboard_credenciais (user_id, password_hash)
         VALUES ($1, $2)`,
        [userId, passwordHash]
      );

      await client.query(
        `INSERT INTO dashboard_consentimentos (user_id, documento, versao, ip)
         VALUES ($1, 'termos_uso', 'v1.0', '127.0.0.1'),
                ($1, 'politica_privacidade', 'v1.0', '127.0.0.1')`,
        [userId]
      );

      await client.query('COMMIT');
      console.log(`[auth] Admin provisionado com sucesso: ${adminEmail} (código: ${customerCode})`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[auth] Falha no bootstrap de admin:', err.message);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[auth] Erro ao verificar usuários para bootstrap:', err.message);
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  hashCpf,
  encryptCpf,
  maskCpf,
  validateCpf,
  generateSessionToken,
  hashSessionToken,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  checkBruteForce,
  recordBruteForceFailure,
  resetBruteForce,
  recordAudit,
  legalTexts,
  initAdminUser
};
