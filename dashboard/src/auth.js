'use strict';

const crypto = require('crypto');
const util = require('util');

const scryptAsync = util.promisify(crypto.scrypt);

// Parâmetros canônicos scrypt (RFC 7914 / OWASP / NIST SP 800-63B)
const SCRYPT_COST = Object.freeze({ N: 16384, r: 8, p: 1 });
const MAX_SCRYPT_CONCURRENCY = 1;
const MAX_SCRYPT_QUEUE = 20;

let runningScryptCount = 0;
const scryptQueue = [];

function runWithScryptSemaphore(fn) {
  return new Promise((resolve, reject) => {
    if (runningScryptCount < MAX_SCRYPT_CONCURRENCY) {
      runningScryptCount++;
      executeScrypt(fn, resolve, reject);
    } else {
      if (scryptQueue.length >= MAX_SCRYPT_QUEUE) {
        const err = new Error('Muitas operações criptográficas simultâneas. Tente novamente em instantes.');
        err.status = 503;
        err.retryAfter = 1;
        return reject(err);
      }
      scryptQueue.push({ fn, resolve, reject });
    }
  });
}

async function executeScrypt(fn, resolve, reject) {
  try {
    const result = await fn();
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    runningScryptCount--;
    if (scryptQueue.length > 0) {
      const next = scryptQueue.shift();
      runningScryptCount++;
      executeScrypt(next.fn, next.resolve, next.reject);
    }
  }
}

// -----------------------------------------------------------------------------
// 1. HASHING E VERIFICAÇÃO DE SENHAS (NIST SP 800-63B / scrypt)
// -----------------------------------------------------------------------------

async function hashPassword(password, cost = SCRYPT_COST) {
  const N = (cost && cost.N) || 16384;
  const r = (cost && cost.r) || 8;
  const p = (cost && cost.p) || 1;
  const salt = crypto.randomBytes(16);
  const derived = await runWithScryptSemaphore(() =>
    scryptAsync(password, salt, 64, { N, r, p })
  );
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') {
    // Executa scrypt dummy para mitigar timing attack de enumeração
    try {
      await hashPassword('dummy-password-timing-defense');
    } catch (_) {}
    return false;
  }

  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    try {
      await hashPassword('dummy-password-timing-defense');
    } catch (_) {}
    return false;
  }

  const cost = parseInt(parts[1], 10);
  const blockSize = parseInt(parts[2], 10);
  const parallel = parseInt(parts[3], 10);
  let salt;
  let expectedHash;
  try {
    salt = Buffer.from(parts[4], 'hex');
    expectedHash = Buffer.from(parts[5], 'hex');
  } catch (_) {
    return false;
  }

  if (!cost || !blockSize || !parallel || salt.length === 0 || expectedHash.length === 0) {
    return false;
  }

  try {
    const derived = await runWithScryptSemaphore(() =>
      scryptAsync(password, salt, expectedHash.length, {
        N: cost,
        r: blockSize,
        p: parallel
      })
    );
    if (derived.length !== expectedHash.length) return false;
    return crypto.timingSafeEqual(derived, expectedHash);
  } catch (err) {
    if (err.status === 503) throw err;
    return false;
  }
}

function needsRehash(storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return true;
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;

  const N = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);

  if (isNaN(N) || isNaN(r) || isNaN(p)) return true;
  if (N < SCRYPT_COST.N || r < SCRYPT_COST.r || p < SCRYPT_COST.p) return true;
  return false;
}

// Lista local em memória de senhas fracas comuns / comprometidas (zero dependência externa)
const COMMON_WEAK_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '11111111', '00000000',
  'password', 'password1', 'password123', 'passwords',
  'qwertyuiop', 'qwerty12345', 'asdfghjkl', 'zxcvbnm123', 'admin123',
  'administrator', 'welcome1', 'welcome123', 'iloveyou',
  'senha123', 'senha1234', 'mudar123', 'trocar123',
  'brasil123', 'anneia123', 'master123', 'root1234',
  'letmein123', 'changeme', 'secret123', 'monkey123',
  'dragon123', 'football', 'baseball', 'princess'
]);

function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, error: 'A senha é obrigatória.' };
  }
  if (password.length < 8 || password.length > 128) {
    return { valid: false, error: 'A senha deve conter entre 8 e 128 caracteres.' };
  }
  if (password.trim().length === 0) {
    return { valid: false, error: 'A senha não pode ser composta apenas por espaços em branco.' };
  }
  if (/[\x00-\x1F\x7F]/.test(password)) {
    return { valid: false, error: 'A senha contém caracteres de controle não permitidos.' };
  }
  if (COMMON_WEAK_PASSWORDS.has(password.toLowerCase())) {
    return { valid: false, error: 'Esta senha é muito comum ou previsível. Escolha uma senha mais forte.' };
  }
  return { valid: true };
}

// -----------------------------------------------------------------------------
// 2. ISOLAMENTO E CIFRAGEM LGPD (AES-256-GCM + HMAC BLIND INDEX)
// -----------------------------------------------------------------------------

function getCryptoKey() {
  if (process.env.CPF_ENC_KEY) {
    const raw = Buffer.from(process.env.CPF_ENC_KEY, 'base64');
    if (raw.length === 32) return raw;
  }
  const master = process.env.AUTH_SECRET_KEY ||
    process.env.DASHBOARD_PASSWORD ||
    'anne-ia-production-auth-salt-key-2026';
  return crypto.createHash('sha256').update(master).digest();
}

function getHmacKey() {
  if (process.env.CPF_HMAC_KEY) {
    const raw = Buffer.from(process.env.CPF_HMAC_KEY, 'base64');
    if (raw.length === 32) return raw;
  }
  const cryptoKey = getCryptoKey();
  return crypto.createHash('sha256').update(Buffer.concat([cryptoKey, Buffer.from(':hmac-v1')])).digest();
}

function hashCpf(cpfDigits, key = getHmacKey()) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Chave HMAC deve ter exatamente 32 bytes.');
  }
  const clean = String(cpfDigits || '').replace(/\D/g, '');
  return crypto.createHmac('sha256', key).update(clean).digest('hex');
}

function encryptCpf(cpfDigits, key = getCryptoKey()) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Chave de criptografia inválida. Deve ter exatamente 32 bytes.');
  }
  const clean = String(cpfDigits || '').replace(/\D/g, '');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(clean, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptCpf(encryptedData, key = getCryptoKey()) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Chave de criptografia inválida. Deve ter exatamente 32 bytes.');
  }
  let buf = encryptedData;
  if (typeof buf === 'string') {
    buf = Buffer.from(buf, 'base64');
  }
  if (!Buffer.isBuffer(buf) || buf.length < 28) {
    throw new Error('Buffer criptografado inválido ou truncado (mínimo 28 bytes: 12 IV + 16 Tag).');
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    throw new Error('Falha de integridade ao decifrar CPF: ' + err.message);
  }
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
// 4. RATE LIMITING DE LOGIN & PROTEÇÃO BRUTE FORCE (NIST SP 800-63B / NAT-safe)
// -----------------------------------------------------------------------------

const accountLockoutMap = new Map();
const ipRateLimitMap = new Map();

const IP_RATE_LIMIT_MAX = 30; // máx 30 req/min por IP
const IP_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minuto
const MAX_LOCKOUT_DELAY_SECONDS = 900; // 15 minutos

function checkBruteForce(ip, identifier) {
  const now = Date.now();
  const cleanId = String(identifier || '').trim().toLowerCase();
  const cleanIp = String(ip || '').trim();

  // 1. Rate limit volumétrico por IP (máx 30 req/min com HTTP 429)
  if (cleanIp) {
    const ipEntry = ipRateLimitMap.get(cleanIp);
    if (ipEntry && ipEntry.timestamps) {
      ipEntry.timestamps = ipEntry.timestamps.filter(ts => now - ts < IP_RATE_LIMIT_WINDOW_MS);
      if (ipEntry.timestamps.length >= IP_RATE_LIMIT_MAX) {
        const oldest = ipEntry.timestamps[0];
        const remainingSeconds = Math.max(1, Math.ceil((IP_RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000));
        return {
          blocked: true,
          reason: 'ip_rate_limit',
          remainingSeconds,
          error: `Limite de tentativas excedido para este IP (${IP_RATE_LIMIT_MAX}/min). Tente novamente em ${remainingSeconds} segundo(s).`
        };
      }
    }
  }

  // 2. Lockout por conta com atraso progressivo (1s, 2s, 4s, 8s... até máx 15 min)
  if (cleanId) {
    const userKey = `user:${cleanId}`;
    const userEntry = accountLockoutMap.get(userKey);
    if (userEntry && userEntry.blockedUntil && now < userEntry.blockedUntil) {
      const remainingSeconds = Math.max(1, Math.ceil((userEntry.blockedUntil - now) / 1000));
      return {
        blocked: true,
        reason: 'account_lockout',
        remainingSeconds,
        error: `Muitas tentativas incorretas. Conta bloqueada temporariamente. Tente novamente em ${remainingSeconds} segundo(s).`
      };
    }
  }

  return { blocked: false };
}

function recordBruteForceFailure(ip, identifier) {
  const now = Date.now();
  const cleanId = String(identifier || '').trim().toLowerCase();
  const cleanIp = String(ip || '').trim();

  // Registra tentativa no rate limit de IP
  if (cleanIp) {
    const ipEntry = ipRateLimitMap.get(cleanIp) || { timestamps: [] };
    ipEntry.timestamps = ipEntry.timestamps.filter(ts => now - ts < IP_RATE_LIMIT_WINDOW_MS);
    ipEntry.timestamps.push(now);
    ipRateLimitMap.set(cleanIp, ipEntry);
  }

  // Atraso progressivo por conta: 1s, 2s, 4s, 8s, 16s... até 900s (15 min)
  if (cleanId) {
    const userKey = `user:${cleanId}`;
    const userEntry = accountLockoutMap.get(userKey) || { count: 0, blockedUntil: null, lastAttempt: now };
    userEntry.count += 1;
    userEntry.lastAttempt = now;
    const delaySeconds = Math.min(Math.pow(2, userEntry.count - 1), MAX_LOCKOUT_DELAY_SECONDS);
    userEntry.blockedUntil = now + (delaySeconds * 1000);
    accountLockoutMap.set(userKey, userEntry);
  }

  // Limpeza preventiva de memória
  if (accountLockoutMap.size > 5000) {
    for (const [k, v] of accountLockoutMap.entries()) {
      if (now - v.lastAttempt > 3600000) accountLockoutMap.delete(k);
    }
  }
  if (ipRateLimitMap.size > 5000) {
    for (const [k, v] of ipRateLimitMap.entries()) {
      if (v.timestamps.length === 0 || now - v.timestamps[v.timestamps.length - 1] > IP_RATE_LIMIT_WINDOW_MS) {
        ipRateLimitMap.delete(k);
      }
    }
  }
}

function resetBruteForce(ip, identifier) {
  const cleanId = String(identifier || '').trim().toLowerCase();
  if (cleanId) accountLockoutMap.delete(`user:${cleanId}`);
}

function clearAllBruteForce() {
  accountLockoutMap.clear();
  ipRateLimitMap.clear();
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
  SCRYPT_COST,
  MAX_SCRYPT_CONCURRENCY,
  MAX_SCRYPT_QUEUE,
  hashPassword,
  verifyPassword,
  needsRehash,
  validatePassword,
  COMMON_WEAK_PASSWORDS,
  getCryptoKey,
  getHmacKey,
  hashCpf,
  encryptCpf,
  decryptCpf,
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
  clearAllBruteForce,
  recordAudit,
  legalTexts,
  initAdminUser
};
