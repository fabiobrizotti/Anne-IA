## 🚀 Descrição da Release v1.0.0

Reconciliação e consolidação industrial da branch `dev` para a branch `main`, incorporando 41 commits com mais de 11.500 linhas de código revisadas sob critérios de conformidade NIST SP 800-63B, LGPD (Art. 46 e 48), OWASP ASVS v4.0 e OpenSSF Scorecard.

---

### 🛡️ Matriz de Conformidade & DevSecOps

- [x] **Autenticação e Criptografia (RFC 7914)**:
  - Algoritmo `scrypt` canônico ($N=16384, r=8, p=1$, dkLen=64).
  - Semáforo in-memory de limitação de concorrência (`MAX_SCRYPT_CONCURRENCY = 1`, fila máx 20, HTTP 503 com `Retry-After: 1`).
  - Rehash transparente automático na autenticação para hashes legados ou com custo inferior.
- [x] **Diretrizes de Identidade NIST SP 800-63B**:
  - Comprimento de senha entre 8 e 128 caracteres.
  - Suporte irrestrito a caracteres Unicode imprimíveis e espaços internos.
  - Remoção de regras arbitrárias de composição (sem truncamento silencioso).
  - Bloqueio de senhas fracas/previsíveis conhecidas via Set em memória.
- [x] **Privacidade e Proteção de Dados (LGPD Art. 46/48)**:
  - Cifra autenticada AES-256-GCM com IV aleatório de 12 bytes e Auth Tag de 16 bytes para CPFs de operadores.
  - Blind Index determinístico via HMAC-SHA256 (`hashCpf`) com chaves segregadas (`CPF_ENC_KEY` e `CPF_HMAC_KEY`).
  - Mascaramento padrão no formato `***.444.777-**`.
- [x] **Isolamento Multi-Tenant & OWASP API Security**:
  - Mitigação de BFLA (Broken Function-Level Authorization) via middleware `isAdmin`.
  - Mitigação de BOLA (Broken Object-Level Authorization) via validação de tenant (`cliente_id`) em rotas de instâncias, prompts e relatórios financeiros.
  - Mitigação de CSRF com checagem estrita de header `X-Requested-With: XMLHttpRequest` em requisições de mutação.
  - Desacoplamento de bloqueio de conta (backoff exponencial por usuário) e rate limit volumétrico de IP (30 req/min, NAT-safe).
- [x] **Infraestrutura Docker & Governança**:
  - Parametrização 100% via variáveis de ambiente no `.env` (Zero Hardcode no Compose).
  - Geração de senhas alfanuméricas Base62 (32 caracteres) livres de caracteres especiais que quebram URIs.
  - Isolamento de redes Docker (`public_net` e `data_net`) com binding local `127.0.0.1` nos serviços de banco e mensageria.

---

### 🧪 Validação Prática

- [x] **Testes Unitários Nativos**: `npm test` em `dashboard/tests/auth.test.js` (<3s, zero dependências extras).
- [x] **Fixtures Sintéticas**: `setup/postgres/fixtures-test.sql` isoladas do `init.sql` de produção.
- [x] **DAST / Pentest Automatizado**: `tests/pentest_dashboard.sh` validando todos os vetores de ataque.
- [x] **Pipeline CI Hardened**: GitHub Actions (`.github/workflows/ci.yml`) com SHA pinning de 40 caracteres.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
