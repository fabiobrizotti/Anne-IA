/**
 * Testes Unitários Nativos do Módulo de Autenticação e Criptografia LGPD
 *
 * Executado via Node.js nativo (node:test e node:assert/strict).
 * Zero dependências externas / npm. Tempo alvo: <3 segundos.
 *
 * Cobertura:
 *  1. Hashing e rehashing scrypt (RFC 7914) com semáforo de concorrência
 *  2. Cifra autenticada AES-256-GCM para PII com detecção de adulteração
 *  3. Blind Index determinístico HMAC-SHA256 para busca exata (LGPD)
 *  4. Validação e mascaramento de CPF
 *  5. Política de senhas NIST SP 800-63B
 *  6. Desacoplamento de bloqueio de conta e rate limit volumétrico de IP (NAT-safe)
 *  7. Gestão de tokens de sessão e cookies de segurança (__Host-sid / Secure)
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const auth = require('../src/auth');

describe('1. Criptografia de Senhas scrypt (RFC 7914)', () => {
  it('hashPassword deve gerar hash no formato canônico scrypt$N$r$p$salt$hash', async () => {
    const password = 'MinhaSenhaSegura2026!';
    const hash = await auth.hashPassword(password);

    assert.ok(typeof hash === 'string', 'Hash deve ser string');
    const parts = hash.split('$');
    assert.equal(parts.length, 6, 'Formato deve conter 6 partes separadas por $');
    assert.equal(parts[0], 'scrypt', 'Prefixo do algoritmo deve ser scrypt');
    assert.equal(parseInt(parts[1], 10), auth.SCRYPT_COST.N, 'Custo N deve coincidir');
    assert.equal(parseInt(parts[2], 10), auth.SCRYPT_COST.r, 'Tamanho de bloco r deve coincidir');
    assert.equal(parseInt(parts[3], 10), auth.SCRYPT_COST.p, 'Paralelismo p deve coincidir');
    assert.equal(parts[4].length, 32, 'Salt deve ser hex de 16 bytes (32 caracteres)');
    assert.equal(parts[5].length, 128, 'Chave derivada deve ser hex de 64 bytes (128 caracteres)');
  });

  it('verifyPassword deve autenticar senha correta e rejeitar senha incorreta', async () => {
    const password = 'SenhaCorreta#2026';
    const hash = await auth.hashPassword(password);

    const valid = await auth.verifyPassword(password, hash);
    assert.equal(valid, true, 'Senha correta deve ser aceita');

    const invalid = await auth.verifyPassword('SenhaIncorreta#2026', hash);
    assert.equal(invalid, false, 'Senha incorreta deve ser rejeitada');

    const malformed = await auth.verifyPassword(password, 'formato_invalido_sem_cifrao');
    assert.equal(malformed, false, 'Hash malformado deve retornar false sem crash');
  });

  it('needsRehash deve identificar hashes com parâmetros inferiores aos canônicos', async () => {
    const currentHash = await auth.hashPassword('teste1234');
    assert.equal(auth.needsRehash(currentHash), false, 'Hash canônico não deve precisar de rehash');

    // Hash legado com custo N reduzido (N=8192)
    const salt = crypto.randomBytes(16).toString('hex');
    const weakDerived = crypto.scryptSync('teste1234', Buffer.from(salt, 'hex'), 64, { N: 8192, r: 8, p: 1 }).toString('hex');
    const legacyHash = `scrypt$8192$8$1$${salt}$${weakDerived}`;

    assert.equal(auth.needsRehash(legacyHash), true, 'Hash com N inferior deve exigir rehash');
    assert.equal(auth.needsRehash('hash_antigo_sem_formato'), true, 'Hash em formato legado deve exigir rehash');
  });
});

describe('2. Cifra Autenticada AES-256-GCM para PII (LGPD Art. 46)', () => {
  const validKey = crypto.randomBytes(32);
  const plainCpf = '12345678901';

  it('encryptCpf e decryptCpf devem realizar ciclo reversível com chave válida', () => {
    const encrypted = auth.encryptCpf(plainCpf, validKey);
    assert.ok(typeof encrypted === 'string', 'Retorno cifrado deve ser string Base64');
    assert.notEqual(encrypted, plainCpf, 'Dado cifrado não pode expor dado em claro');

    const decrypted = auth.decryptCpf(encrypted, validKey);
    assert.equal(decrypted, plainCpf, 'Dado decifrado deve ser idêntico ao original');
  });

  it('decryptCpf deve falhar com erro de integridade se o texto cifrado for adulterado', () => {
    const encrypted = auth.encryptCpf(plainCpf, validKey);
    const buf = Buffer.from(encrypted, 'base64');

    // Altera o último byte do ciphertext
    buf[buf.length - 1] ^= 0xFF;
    const tampered = buf.toString('base64');

    assert.throws(
      () => auth.decryptCpf(tampered, validKey),
      /Falha de integridade ao decifrar CPF|unable to authenticate/i,
      'Adulteração de ciphertext deve disparar falha de autenticidade GCM'
    );
  });

  it('decryptCpf deve falhar com erro de integridade se a tag de autenticação for adulterada', () => {
    const encrypted = auth.encryptCpf(plainCpf, validKey);
    const buf = Buffer.from(encrypted, 'base64');

    // Tag reside entre os bytes 12 e 28
    buf[15] ^= 0xAA;
    const tampered = buf.toString('base64');

    assert.throws(
      () => auth.decryptCpf(tampered, validKey),
      /Falha de integridade ao decifrar CPF|unable to authenticate/i,
      'Adulteração de authTag deve ser barrada pelo GCM'
    );
  });

  it('decryptCpf deve falhar com chave de criptografia incorreta', () => {
    const encrypted = auth.encryptCpf(plainCpf, validKey);
    const wrongKey = crypto.randomBytes(32);

    assert.throws(
      () => auth.decryptCpf(encrypted, wrongKey),
      /Falha de integridade ao decifrar CPF|unable to authenticate/i,
      'Chave diferente deve falhar na autenticação'
    );
  });

  it('encryptCpf deve rejeitar chave com tamanho diferente de 32 bytes', () => {
    assert.throws(
      () => auth.encryptCpf(plainCpf, Buffer.alloc(16)),
      /Chave de criptografia inválida/i
    );
  });
});

describe('3. Blind Index HMAC-SHA256 (Busca Determinística LGPD)', () => {
  const hmacKey = crypto.randomBytes(32);

  it('hashCpf deve ser determinístico e normalizar caracteres não numéricos', () => {
    const formatted = '123.456.789-01';
    const plain = '12345678901';

    const hash1 = auth.hashCpf(formatted, hmacKey);
    const hash2 = auth.hashCpf(plain, hmacKey);

    assert.equal(typeof hash1, 'string', 'Hash deve ser string');
    assert.equal(hash1.length, 64, 'SHA-256 deve ter 64 caracteres hex');
    assert.equal(hash1, hash2, 'CPF formatado e sem formatação devem gerar o mesmo blind index');
  });

  it('hashCpf deve gerar hashes distintos para CPFs diferentes', () => {
    const hashA = auth.hashCpf('11144477735', hmacKey);
    const hashB = auth.hashCpf('99988877700', hmacKey);

    assert.notEqual(hashA, hashB, 'CPFs distintos devem ter hashes distintos');
  });

  it('hashCpf deve gerar hashes distintos para chaves HMAC distintas', () => {
    const keyA = crypto.randomBytes(32);
    const keyB = crypto.randomBytes(32);

    const hashA = auth.hashCpf('11144477735', keyA);
    const hashB = auth.hashCpf('11144477735', keyB);

    assert.notEqual(hashA, hashB, 'Chaves distintas devem isolar o blind index');
  });
});

describe('4. Validação e Mascaramento de CPF', () => {
  it('validateCpf deve validar corretamente dígitos verificadores oficiais', () => {
    assert.equal(auth.validateCpf('111.444.777-35'), true, 'CPF válido com máscara');
    assert.equal(auth.validateCpf('11144477735'), true, 'CPF válido sem máscara');
    assert.equal(auth.validateCpf('52998224725'), true, 'Segundo CPF válido');
  });

  it('validateCpf deve rejeitar CPFs com dígitos inválidos ou repetidos', () => {
    assert.equal(auth.validateCpf('111.111.111-11'), false, 'Dígitos todos iguais devem ser rejeitados');
    assert.equal(auth.validateCpf('00000000000'), false, 'Todos zeros devem ser rejeitados');
    assert.equal(auth.validateCpf('12345678901'), false, 'Dígito verificador incorreto');
    assert.equal(auth.validateCpf('12345'), false, 'CPF incompleto');
    assert.equal(auth.validateCpf(''), false, 'CPF vazio');
    assert.equal(auth.validateCpf(null), false, 'Valor nulo');
  });

  it('maskCpf deve mascarar mantendo conformidade LGPD', () => {
    assert.equal(auth.maskCpf('111.444.777-35'), '***.444.777-**', 'Mascara padrão com blocos intermediários visíveis');
    assert.equal(auth.maskCpf('11144477735'), '***.444.777-**', 'Mascara de número puro');
    assert.equal(auth.maskCpf('123'), '***.***.***-**', 'Tamanho inválido recebe máscara total');
  });
});

describe('5. Política de Senhas NIST SP 800-63B', () => {
  it('validatePassword deve aceitar senhas válidas de 8 a 128 caracteres', () => {
    const valid8 = 'senhaValida8';
    const res8 = auth.validatePassword(valid8);
    assert.equal(res8.valid, true, 'Senha de 8 caracteres deve ser válida');

    const validUnicode = 'Senha com Espaço & Acentuação 2026';
    const resUni = auth.validatePassword(validUnicode);
    assert.equal(resUni.valid, true, 'Unicode e espaços internos devem ser permitidos');

    const validLong = 'A'.repeat(128);
    const resLong = auth.validatePassword(validLong);
    assert.equal(resLong.valid, true, 'Senha no teto de 128 caracteres deve ser válida');
  });

  it('validatePassword deve rejeitar senhas muito curtas (<8) ou muito longas (>128)', () => {
    const short = auth.validatePassword('curta77');
    assert.equal(short.valid, false);
    assert.match(short.error, /8 e 128 caracteres/i);

    const overLimit = auth.validatePassword('A'.repeat(129));
    assert.equal(overLimit.valid, false);
    assert.match(overLimit.error, /8 e 128 caracteres/i);
  });

  it('validatePassword deve rejeitar espaços em branco puros e caracteres de controle ASCII', () => {
    const empty = auth.validatePassword('        ');
    assert.equal(empty.valid, false);

    const controlChar = auth.validatePassword('senha\x00valida123');
    assert.equal(controlChar.valid, false);
    assert.match(controlChar.error, /caracteres de controle/i);
  });

  it('validatePassword deve rejeitar senhas fracas conhecidas da lista', () => {
    for (const weak of ['password', '12345678', 'admin123', 'qwerty12345', 'mudar123']) {
      const res = auth.validatePassword(weak);
      assert.equal(res.valid, false, `Senha fraca '${weak}' deve ser barrada`);
      assert.match(res.error, /muito comum ou previsível/i);
    }
  });
});

describe('6. Bloqueio de Conta e Rate Limit de IP (NAT-safe / Anti-DoS)', () => {
  beforeEach(() => {
    auth.clearAllBruteForce();
  });

  it('Deve aplicar backoff exponencial por conta mantendo IP desbloqueado para outros usuários', () => {
    const sharedNatIp = '200.180.10.5';
    const targetUser = 'usuario.alvo@anne.ia';
    const innocentUser = 'usuario.inocente@anne.ia';

    // 1ª falha do alvo
    auth.recordBruteForceFailure(sharedNatIp, targetUser);
    let checkAlvo = auth.checkBruteForce(sharedNatIp, targetUser);
    assert.equal(checkAlvo.blocked, true, 'Alvo deve estar temporariamente em backoff');
    assert.equal(checkAlvo.reason, 'account_lockout');

    // Usuário inocente no mesmo IP (gateway NAT corporativo/escolar) NÃO pode ser bloqueado
    let checkInocente = auth.checkBruteForce(sharedNatIp, innocentUser);
    assert.equal(checkInocente.blocked, false, 'Usuário inocente sob o mesmo NAT não pode sofrer lockout');

    // Sucesso do alvo reseta seu lockout
    auth.resetBruteForce(sharedNatIp, targetUser);
    checkAlvo = auth.checkBruteForce(sharedNatIp, targetUser);
    assert.equal(checkAlvo.blocked, false, 'Sucesso deve resetar o lockout do alvo');
  });

  it('Deve ativar rate limit volumétrico de IP quando exceder 30 req/min', () => {
    const attackerIp = '198.51.100.99';

    // Simula 30 tentativas rápidas de login pelo mesmo IP
    for (let i = 0; i < 30; i++) {
      auth.recordBruteForceFailure(attackerIp, `user_${i}@teste.com`);
    }

    const check = auth.checkBruteForce(attackerIp, 'qualquer_usuario@teste.com');
    assert.equal(check.blocked, true, 'IP deve ser bloqueado por volumetria excessiva');
    assert.equal(check.reason, 'ip_rate_limit');
    assert.ok(check.remainingSeconds > 0, 'Deve retornar tempo de espera para Retry-After');
  });
});

describe('7. Gestão de Sessão e Cookies de Segurança', () => {
  it('generateSessionToken deve gerar 64 caracteres hex (32 bytes criptográficos)', () => {
    const token = auth.generateSessionToken();
    assert.equal(typeof token, 'string');
    assert.equal(token.length, 64);
    assert.match(token, /^[0-9a-f]{64}$/);
  });

  it('hashSessionToken deve produzir SHA-256 determinístico', () => {
    const token = 'a'.repeat(64);
    const hash1 = auth.hashSessionToken(token);
    const hash2 = auth.hashSessionToken(token);

    assert.equal(hash1.length, 64);
    assert.equal(hash1, hash2, 'Hash de sessão deve ser determinístico');
  });

  it('parseCookies deve interpretar corretamente o cabeçalho Cookie', () => {
    const mockReq = {
      headers: {
        cookie: 'sid=abc123token; tema=dark; custom=valor%20codificado'
      }
    };
    const cookies = auth.parseCookies(mockReq);
    assert.equal(cookies.sid, 'abc123token');
    assert.equal(cookies.tema, 'dark');
    assert.equal(cookies.custom, 'valor codificado');
  });

  it('setSessionCookie deve emitir __Host-sid com Secure em requisição HTTPS', () => {
    const req = { secure: true, headers: {} };
    let setHeaderVal = null;
    const res = {
      setHeader: (name, val) => {
        if (name === 'Set-Cookie') setHeaderVal = val;
      }
    };

    auth.setSessionCookie(req, res, 'tok123', 86400);
    assert.ok(setHeaderVal, 'Set-Cookie deve ser chamado');
    assert.match(setHeaderVal, /^__Host-sid=tok123;/);
    assert.match(setHeaderVal, /HttpOnly/);
    assert.match(setHeaderVal, /SameSite=Lax/);
    assert.match(setHeaderVal, /Secure/);
    assert.match(setHeaderVal, /Path=\//);
  });

  it('setSessionCookie deve emitir sid comum em HTTP simples (desenvolvimento local)', () => {
    const req = { secure: false, headers: {} };
    let setHeaderVal = null;
    const res = {
      setHeader: (name, val) => {
        if (name === 'Set-Cookie') setHeaderVal = val;
      }
    };

    auth.setSessionCookie(req, res, 'tok123', 86400);
    assert.ok(setHeaderVal);
    assert.match(setHeaderVal, /^sid=tok123;/);
    assert.doesNotMatch(setHeaderVal, /Secure/);
  });

  it('clearSessionCookie deve invalidar tanto sid quanto __Host-sid com Max-Age=0', () => {
    const req = { secure: false, headers: {} };
    let setHeaderVal = null;
    const res = {
      setHeader: (name, val) => {
        if (name === 'Set-Cookie') setHeaderVal = val;
      }
    };

    auth.clearSessionCookie(req, res);
    assert.ok(Array.isArray(setHeaderVal), 'Deve limpar ambos os cookies em array');
    const joined = setHeaderVal.join(' | ');
    assert.match(joined, /Max-Age=0/);
    assert.match(joined, /sid=/);
    assert.match(joined, /__Host-sid=/);
  });
});
