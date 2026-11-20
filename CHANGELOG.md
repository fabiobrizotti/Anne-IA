# CHANGELOG - Anne-IA Dashboard

## [Unreleased] - 2026-11-19

### Fixed — a aba "Logs" ficava vazia porque nada era interceptado

O diagnóstico foi direto: `system_logs` tinha **0 linhas**. A aba existia, a tabela
existia e o `INSERT` funcionava, mas nenhum ponto do código chamava a escrita para
requisições HTTP — só 6 call sites gravavam eventos de negócio. O "middleware de
logging automático" anunciado na versão de 2026-11-15 **nunca existiu**.

- **Logger extraído para um módulo único** (`dashboard/src/logger.js`): cache em
  memória, SSE, `writeLog`/`writeLogThrottled`, `requestLogger`, retenção e
  utilitários de higienização saíram do `server.js` inline.
- **`requestLogger` montado logo após `express.json`**, capturando o path de
  `req.originalUrl` na entrada (o Express reescreve `req.url` em sub-routers).
  Persiste método, rota normalizada, status, duração e nível derivado do status.
- **Anti-loop de feedback**: `/api/v1/logs*`, `/api/health` e estáticos são
  ignorados; sem isso, cada listagem da aba gerava um log novo.
- **Falhas de processo persistidas**: `unhandledRejection`, `uncaughtException` e
  o handler global de erros gravam em `system_logs`.
- **`writeLog` usa `INSERT ... RETURNING id`**, devolvendo o id real do banco para
  o frontend deduplicar SSE + listagem sem repetir linhas.
- **Isolamento multi-tenant no SSE**: replay e broadcast filtram por `cliente_id`;
  `use_cache` ficou restrito a admin (antes vazava cache global entre tenants).
- **`Assignment to constant variable`** na listagem de logs: `paramIdx` era `const`
  e sofria `++` no `LIMIT/OFFSET`. Corrigido com índice local mutável.
- **Rate limit com Redis**: `REDIS_URL` montada no Compose a partir de
  `CHAVE_REDIS_PASSWORD` (db 7, exclusivo do Dashboard). Sem Redis, o rate limit
  cai para memória (fail-open) — fim do `WRONGPASS` derrubando o login.
- **Throttle de 5 min em `dashboard_sessoes`**: sem ele, cada requisição
  autenticada disparava um `UPDATE` e o trigger de auditoria gravava uma linha em
  `auditoria_geral` por request.
- **4 middlewares de debug/`console.log` por request removidos.**

### Added
- `GET /api/v1/logs/export`: exportação CSV server-side respeitando os filtros
  (antes o CSV era montado no navegador e truncava em 100 linhas).
- `DELETE /api/v1/logs/cache`: limpa só o cache em memória, preservando o banco.
- `POST /api/v1/logs/ingest`: ingestão de eventos externos (n8n, Evolution,
  scripts) via `X-Log-Token` com `crypto.timingSafeEqual`, whitelist de
  nível/origem e rate limit de 120/min. Sem `LOG_INGEST_TOKEN`, responde `503`.
- `LOG_RETENTION_DAYS` (padrão 90): job diário de retenção no boot
  (`startRetentionJob`).
- Frontend: dedupe por `renderedLogIds`, buffer enquanto pausado, reconexão SSE
  com backoff, export/clear-cache pela UI e filtros em `buildLogFilterParams()`.
- CSS monocromático com escala de severidade, `.log-message`, layout responsivo
  abaixo de 720px e `data-label` nos contadores.
- `dashboard/tests/logger.test.js` (40 asserções, sem banco) e
  `tests/test_logs_smoke.sh` (pula com exit 0 se a stack não estiver acessível).

### Changed
- `dashboard/package.json`: `test` passa a rodar `node --test tests/` (auth + logger).
- `README.md`: aba, endpoints, `LOG_RETENTION_DAYS`, `LOG_INGEST_TOKEN` e `REDIS_URL`
  documentados na seção 8.
- `setup/postgres/init.sql`: comentário do throttle de 5 min em `dashboard_sessoes`
  (sem alteração de schema).

## [1.2.0] - 2026-11-16

### Fixed — `update.sh` abortava quando o código estava certo e o container não

O caminho "nada a fazer" morria com exit 1 se o container não rodasse o `HEAD`.
Essa é uma situação **recuperável e comum**: update interrompido depois do pull,
`git pull` feito à mão, container recriado a partir de imagem antiga. O operador
ficava com a stack inconsistente e sem ação óbvia.

Agora o script converge: carimba o `GIT_SHA`, roda `docker compose up -d` e
revalida com `--require-revision`. `NADA A FAZER` quando tudo já casa,
`CONVERGIDO — container recriado em <sha>` quando precisou recriar, e erro (com
log) só se a stack continuar insalubre.

### Fixed — `GIT_SHA` herdado do ambiente anulava silenciosamente o carimbo

O Docker Compose dá **precedência ao ambiente do shell sobre o `.env`**. Com um
`GIT_SHA` exportado na sessão (deploy anterior, script de CI, shell interativo),
o script gravava `d7025ca` no `.env`, o Compose resolvia `fe81794` do ambiente e
o container **nunca era recriado** — a convergência falhava com "não convergiu"
sem causa aparente. `stamp_git_sha()` agora grava **e exporta**, tornando o
`update.sh` a autoridade sobre a revisão.

Mesma armadilha vale para `DASHBOARD_VERSION`/`N8N_VERSION` (documentada em
§12.5 do README): `env -u DASHBOARD_VERSION docker compose ...` isola o teste.

### Fixed — primeira execução real do CI no GitHub Actions (run 43969044849)

O `actionlint` valida sintaxe e expressões, mas **não** valida se os SHAs pinados
existem nem se as ferramentas do runner têm a mesma versão da máquina local.
O primeiro run de verdade encontrou 4 problemas — todos de CI, nenhum de produto:

| Job | Falha | Causa raiz | Correção |
|---|---|---|---|
| `schema-idempotency` | — | **passou (0 falhas)** | — |
| `dast` | — | **passou** (stack completa no runner, fixtures, pentest) | — |
| `secret-scan` | `Set up job` | `gitleaks/gitleaks-action@f91b498f...` **não existe** no repositório da action (SHA inventado, comentado como `v2.3.8`) | pin no SHA real de `v2.3.9`: `ff98106e4c7b2bc287b24eaf42907196329070c7` |
| `unit-tests` | `Instalar Dependências` | `npm ci` exige `package-lock.json`, que **nunca foi commitado** (nem estava no `.gitignore`) | `dashboard/package-lock.json` gerado e versionado (93 pacotes, `lockfileVersion: 3`) |
| `sca-audit` | `npm audit` | mesmo motivo: `ENOLOCK` | idem |
| `lint-and-sast` | `ShellCheck` | `apt install shellcheck` entrega **0.9.x**, que emite `SC2317` em função chamada via `trap`; a 0.11 não emite | CI passa a usar `koalaman/shellcheck:v0.11.0` (mesma versão do ambiente local) |

Consequência prática do lockfile: `dashboard/Dockerfile` trocou `npm install` por
`npm ci --omit=dev`, então a imagem passa a instalar **exatamente** a árvore que o
CI auditou — antes, cada build resolvia semver de novo e podia produzir uma imagem
diferente da testada.

### Bateria final de verificação (antes de fechar a release)

Executada com a árvore limpa em `302dcda`:

```bash
docker run --rm -v "$PWD:/mnt:ro" koalaman/shellcheck:stable scripts/*.sh tests/*.sh
# exit 0  (antes desta entrega: 4 achados legados em sync-env.sh)

for f in scripts/*.sh tests/*.sh .githooks/*; do bash -n "$f"; done        # ok
node --check dashboard/src/server.js && node --check dashboard/src/auth.js # ok
python3 -c "import yaml;yaml.safe_load(open('.github/workflows/ci.yml'))"  # ok
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest            # exit 0
docker compose config -q                                                    # ok

./tests/test_init_sql.sh
# SUCESSO — boot limpo 0 erros, reaplicação 0 erros, 21 tabelas,
# 51 triggers, admin/*/*, 4 funções, I+U+D em produtos (sem coluna id)

cd dashboard && npm test
# tests 26 | pass 26 | fail 0

./scripts/verify-stack.sh --require-revision
# STACK SAUDÁVEL — 15 verificações ok (exit 0)

./tests/pentest_dashboard.sh
# 16 aprovados, 0 reprovados
```

Também registrado no Segundo Cérebro: `20_Projects/Projeto - TCC Anne IA (ETEC).md`
(log da sessão com commits e evidências) e `01_Daily/2026-11-16.md`.

### Added — runbook de atualização em produção (`README` §12)

Seção nova respondendo "como atualizo a VPS?" e "como sei que atualizou?": tabela
das 8 etapas, verificação por `/api/health` + gate, flags, tabela dos cenários
efetivamente testados, tabela sintoma → causa → ação, rollback manual e hooks.
§2 agora avisa que reinstalar não é o caminho de atualização.

### Changed — divergência de revisão: aviso no uso local, falha no deploy

A 15ª verificação compara o `sha` do container com o `HEAD`. Reprovar sempre
tornava o `verify-stack.sh` inútil em desenvolvimento (container legitimamente
uma revisão atrás). Agora:

- `verify-stack.sh` sem flag → `[aviso]` (não reprova).
- `verify-stack.sh --require-revision` → `[falha]` (exit 1).
- `update.sh` usa `--require-revision` no gate pós-update e nos caminhos
  "nada a fazer"; o gate pós-rollback **não** usa (caminho de recuperação — se o
  `.env` anterior tinha `GIT_SHA=unknown`, exigir revisão transformaria um
  rollback bem-sucedido em "INCOMPLETO").

### Testes executados (2026-11-16)
```bash
./scripts/verify-stack.sh                      # container 1 commit atrás
# [aviso] revisão: container em abbdf62, HEAD 93149a7 (rode ./scripts/update.sh)
# STACK SAUDÁVEL — 15 verificações ok            (exit 0)

./scripts/verify-stack.sh --require-revision
# [falha] revisão: container em abbdf62 != HEAD 93149a7 (atualização não aplicada?)
# STACK COM PROBLEMAS — 1/15 falhas              (exit 1)

# após carimbar GIT_SHA=93149a7 no .env + up -d
./scripts/verify-stack.sh --require-revision
# [ok] revisão: container em 93149a7 = HEAD do checkout
# STACK SAUDÁVEL — 15 verificações ok            (exit 0)

./scripts/update.sh --dry-run        # árvore limpa, nada a fazer: não escreve
# backups/ = 0 arquivos

# árvore suja (arquivo rastreado modificado) -> bloqueia
./scripts/update.sh --dry-run
# [erro] Árvore Git suja. ...                    (exit 1)

# arquivo NÃO rastreado -> não bloqueia (untracked-files=no)
```


### Added — revisão rastreável (`/api/health`) e gate de atualização

Antes disso não era possível **afirmar** que a VPS rodava o commit do GitHub: o
health respondia apenas `{"status":"ok"}`. Um deploy que falhasse silenciosamente
(imagem antiga reaproveitada, container não recriado) era indistinguível de sucesso.

- `dashboard/Dockerfile`: `ARG GIT_SHA` / `ARG APP_VERSION` (fallback `unknown`).
- `docker-compose.yml`: `build.args` **e** `environment` no serviço `dashboard`.
  O runtime é necessário porque um update que só toca documentação não reconstrói
  a imagem — mas a revisão em execução precisa mudar mesmo assim.
- `dashboard/src/server.js`: `/api/health` devolve `version`, `sha` e `uptime`.
  Nenhum segredo: só a versão e o hash curto do commit.
- `scripts/update.sh`: grava `GIT_SHA=<sha>` no `.env` a cada deploy; o compose
  recria o container com o novo valor (sem rebuild, custo ~1s).
- `scripts/verify-stack.sh`: 15ª verificação — compara o `sha` do container com o
  `HEAD` do checkout. Três estados explícitos: `ok` (casa), `falha` (divergiu) e
  `skip` (container ainda sem `GIT_SHA`, porque o `update.sh` nunca rodou ali).

### Fixed — bump de versão de imagem nunca chegava à VPS

`sync-env.sh` preservava **todos** os valores existentes no `.env`, incluindo
`N8N_VERSION` e `DASHBOARD_VERSION`. Resultado: subir `N8N_VERSION` no
`.env.example` e rodar o update mantinha a VPS na versão antiga — a atualização
"passava" sem atualizar o serviço. Agora as chaves `*_VERSION` seguem a release do
`.env.example` (são pinos de tag, não configuração do host) e o sync informa
`[atualizada] CHAVE: antiga -> nova`. Portas, binds e credenciais continuam
preservados.

### Testes executados (2026-11-16)
```bash
curl -s http://127.0.0.1:41283/api/health
# {"status":"ok","version":"1.2.0","sha":"abbdf62","uptime":10,...}
# git rev-parse --short HEAD -> abbdf62   (coincide)

./scripts/verify-stack.sh
# [ok] revisão: container em abbdf62 = HEAD do checkout
# STACK SAUDÁVEL — 15 verificações ok

# teste negativo: GIT_SHA=deadbee no .env + up -d
# [falha] revisão: container em deadbee != HEAD abbdf62 (atualização não aplicada?)
# STACK COM PROBLEMAS — 1/15 falhas (exit 1)
# teste neutro: GIT_SHA=unknown
# [skip]  revisão: container sem GIT_SHA (rode ./scripts/update.sh para marcar)
# STACK SAUDÁVEL — 14 verificações ok

# update.sh end-to-end com remoto falso (commit que só toca CHANGELOG)
# [ok] GIT_SHA=cd126f4 gravado no .env (reaparece em /api/health)
# [ok] dashboard sem mudanças — imagem reaproveitada
# [ok] revisão: container em cd126f4 = HEAD do checkout
# segunda execução: NADA A FAZER — revisão cd126f4 já aplicada

# sync-env.sh: bump N8N_VERSION 2.47.7 -> 2.47.8
# [atualizada] N8N_VERSION: 2.47.7 -> 2.47.8 (release)
# sha256 dos 12 segredos idêntico antes/depois
# segunda execução: 0 gerada(s), 13 mantida(s), 0 sincronizada(s)
```


### Fixed — CI (`dast`) nunca executou: YAML inválido e alvos errados

O workflow estava **inválido** (GitHub não conseguia nem fazer parse), então os jobs
jamais rodaram. Quatro defeitos encadeados:

1. **YAML inválido** — `- name: Checkout Completo do Repositório (fetch-depth: 0)` sem
   aspas: o `:` dentro do escalar quebrava o parser (`mapping values are not allowed here`).
   Correção: nome entre aspas.
2. **Serviço inexistente** — `docker compose up -d postgres dashboard` referenciava um
   serviço `postgres` que não existe (o nome real é `db-evolution`). O job falharia no
   primeiro comando.
3. **Porta errada** — o health-wait usava `http://127.0.0.1:3000/...`, que é a porta
   **interna** do container. No host o dashboard responde em `DASHBOARD_PORT` (41283).
   Alem disso `/api/v1/health` é protegido (401); o endpoint público é `/api/health`.
4. **Banco errado nas fixtures** — o painel rodava em `-d "$POSTGRES_DB"` (`evolution`,
   banco do Prisma da Evolution API). As tabelas de negócio vivem em `anneia`.
5. **`actionlint` (SC2046)** — `python3 -m py_compile $(git ls-files "*.py")` sem `xargs`.

### Fixed — `setup/postgres/fixtures-test.sql` desalinhado do schema real

O arquivo referenciava colunas que não existem mais (`clientes.status`,
`clientes.max_instances`, `clientes.max_tokens_dia`) e violava CHECKs:

- `uso_tokens.origem` aceita apenas `n8n | 9router_sync | manual`; usava `'pentest'`
  → trocado para `'manual'` com modelo marcado como `pentest-gpt-4o-mini` (sirve de
  filtro seguro na limpeza).
- Colunas presentes na tabela por engano (`telefone`/`email` são NOT NULL mas têm
  default vazio; `ativo`/`configuracoes`/`historico_telefones`/`codigo` têm default).
- `dashboard_consentimentos` **não tem UNIQUE** além da PK serial, portanto
  `ON CONFLICT DO NOTHING` não protegia nada e cada execução duplicava as linhas
  (4 → 8 → 12). Substituído por `WHERE NOT EXISTS` sobre `(user_id, documento, versao)`.
- Hash scrypt dos operadores era inválido (não correspondia a `SenhaBeta#2026`).
  Regenerado com N=16384/r=8/p=1 e **verificado por `verifyPassword()`** do app antes
  de entrar no repositório.

### Added
- Job `schema-idempotency` no CI: roda `tests/test_init_sql.sh` (boot limpo, reaplicação,
  51 triggers, seed admin/*/*, DML real em tabela com e sem coluna `id`). É o mesmo
  teste do qual o `update.sh` depende para reaplicar o schema na VPS.
- `tests/pentest_dashboard.sh`: porta derivada de `DASHBOARD_PORT` (antes fixa em 3000).

### Testes executados (2026-11-16)
```bash
./tests/pentest_dashboard.sh
# Alvo: http://127.0.0.1:41283
# 16 aprovados, 0 reprovados (inclui login beta@pentest.local / SenhaBeta#2026,
# BOLA/BFLA, CSRF, SQLi, path traversal, payload 413)

# idempotência das fixtures (3 execuções consecutivas)
for i in 1 2 3; do docker exec -i db-evolution psql -v ON_ERROR_STOP=1 -U evolution \
  -d anneia < setup/postgres/fixtures-test.sql; done
# run1/run2/run3: exit 0, 0 ERRORs
# contagens estáveis: clientes=2 uso_tokens=2 usuarios=2 consentimentos=4

# verificação do hash scrypt pelo próprio app
node -e "require('./dashboard/src/auth.js').verifyPassword('SenhaBeta#2026', HASH)"
# true (senha correta) / false (senha errada)

python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"
# [ok] jobs: lint-and-sast, sca-audit, unit-tests, schema-idempotency, secret-scan, dast

docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest
# exit 0 (antes: SC2046 na validação de Python)

# cenário CI de .env do zero
rm .env && ./scripts/sync-env.sh && docker compose --env-file .env config -q
# sync exit 0; compose resolve todas as variáveis
```


### Fixed — Boot e idempotência do `setup/postgres/init.sql` (bloqueavam deploy em VPS)

Diagnóstico feito aplicando o `init.sql` em container `pgvector:pg15` descartável,
duas vezes (boot limpo + reaplicação). Baseline: **4 ERRORs** em ambos os cenários.

1. **`transition tables cannot be specified for triggers with more than one event`** (3 ocorrências)
   - `CREATE TRIGGER ... AFTER INSERT OR UPDATE OR DELETE ... REFERENCING OLD TABLE ... NEW TABLE`
     é proibido no PostgreSQL. O trigger nunca era criado e o `DO $$ FOREACH` abortava na
     primeira tabela (`clientes`), deixando **0 de 51** triggers de auditoria no banco.
   - Correção: 3 triggers por tabela (`_ins`, `_upd`, `_del`), cada um com apenas as
     transition tables válidas para o seu evento. Nomes legados são removidos via
     `DROP TRIGGER IF EXISTS` (idempotente).
   - Impacto real: a auditoria LGPD (`auditoria_geral`) **não funcionava** em nenhuma tabela.
     Verificado: banco em execução tinha `0` triggers `trg_audit*`.

2. **`fn_auditoria_statement()` era criada depois dos triggers que a usam** (linha 958 vs 780)
   - `CREATE TRIGGER ... EXECUTE FUNCTION` exige a função já existente.
   - Correção: `auditoria_geral` + `fn_auditoria_statement()` movidas para a seção `1.1`,
     logo após as extensões. Definição duplicada no fim do arquivo removida.

3. **`violates check constraint dashboard_permissoes_acao_check`** no seed `('admin','*','*')`
   - O `CHECK` aceitava só `create|read|update|delete|execute`, mas o seed grava `'*'`
     (curinga). Em banco novo o admin ficava **sem permissão registrada**.
   - Correção: `'*'` incluído nos CHECK de `role` e `acao`, com `DROP CONSTRAINT IF EXISTS`
     + `ADD CONSTRAINT` para reconciliar bancos já existentes (o banco local tinha a
     constraint antiga porque `CREATE TABLE IF NOT EXISTS` não altera constraints).

4. **UPDATE de auditoria quebrava tabelas sem coluna `id`** (latente, detectado em review)
   - `FROM old_table, new_table WHERE old_table.id = new_table.id` explodia em
     `produtos` (`id_produto`), `movimentacoes_estoque` (`id_movimentacao`) e nas tabelas
     `dashboard_contatos`, `dashboard_credenciais`, `dashboard_identidades`, `dashboard_sessoes`.
     Qualquer `UPDATE` nessas tabelas retornaria `column old_table.id does not exist`.
   - Correção: pareamento posicional com `row_number() OVER ()` + `to_jsonb(...)`,
     independente de PK. Antes/Depois continuam na mesma linha de `auditoria_geral`.

5. **`system_logs` excluída da auditoria** (decisão de engenharia)
   - É telemetria com retenção própria (`fn_limpar_logs_antigos`); auditá-la dobraria a
     escrita na tabela mais quente do sistema sem ganho de conformidade.

### Added
- `tests/test_init_sql.sh` — teste automatizado que sobe um Postgres descartável (sem
  portas, sem volume, nome aleatório) e valida: boot limpo, reaplicação, preservação de
  dado sentinela, 51 triggers, seed `admin/*/*`, funções críticas e DML real
  (INSERT/UPDATE/DELETE em tabela com e sem coluna `id`).

- `scripts/verify-stack.sh` — smoke test em 4 camadas (healthcheck do Docker, dados via
  `docker exec`, HTTP dos serviços, schema do banco `anneia`). 14 verificações, somente
  leitura, com `--timeout` para aguardar convergência. `evolution-api` é testada pela rede
  interna (não publica porta no host) usando a porta interna 3000 no header `Origin`,
  exigida pelo CORS da Evolution.

- `scripts/update.sh` — **comando único de atualização** para a VPS:
  `preflight → backup → git pull --ff-only → sync .env → schema → rebuild → gate de saúde
  → rollback automático`. Garantias implementadas:
  - `flock` impede atualização concorrente; toda execução grava `logs/update-<ts>.log`.
  - Preflight aborta com árvore Git suja, branch errada, `.env` ausente ou < 2 GB livres.
  - Backup antes de tocar em qualquer coisa: `.env`, revisão anterior e `pg_dump` do banco
    `anneia` (retenção dos 10 mais recentes).
  - `git pull --ff-only` (nunca merge cego) + validação `docker compose config -q`.
  - Reaplica `init.sql` **somente** quando ele mudou (ou com `--schema`).
  - Rebuild do dashboard **somente** quando `dashboard/` mudou; aborta antes de reiniciar
    nada se o build falhar.
  - Gate obrigatório via `verify-stack.sh --timeout 180`; em falha, restaura `.env`,
    `git reset --hard` para a revisão anterior e sobe de novo (exit code 2).
  - Flags: `--yes` (não-interativo), `--dry-run`, `--schema`, `--branch`, `--help`.
  - `UPDATE_REMOTE` permite apontar para um remoto alternativo (usado nos testes).

### Changed
- `scripts/sync-env.sh`: zerado o `shellcheck` (4 achados legados — padrão `*PASS*`
  redundante, array `PROCESSED_KEYS` morto e redirects individuais). Nenhuma mudança de
  comportamento; `sha256` dos 12 segredos do `.env` idêntico antes/depois.
- `.env.example`: `N8N_VERSION` 2.36.5 → **2.47.7** (alinhado à versão validada em execução;
  evitava VPS nova nascer com versão diferente do ambiente de desenvolvimento).
- `.env.example` + `dashboard/package.json`: `DASHBOARD_VERSION`/`version` 1.1.0 → **1.2.0**.

### Testes executados (2026-11-16)
```bash
./tests/test_init_sql.sh
# [1/7] Postgres pronto e estável
# [2/7] Aplicação #1 (BOOT LIMPO) ....... [OK] 0 ERRORs
# [3/7] Dado sentinela ................. [OK] criado
# [4/7] Aplicação #2 (reaplicação) ..... [OK] 0 ERRORs
# [5/7] DML real (INSERT/UPDATE/DELETE) [OK] sem erro
# [6/7] Integridade .................... [OK] sentinela preservado, 21 tabelas,
#                                            51 triggers, admin/*/*, 4 funções,
#                                            3 eventos em produtos, pareamento ok
# [7/7] SUCESSO  (exit 0)

docker exec -i db-evolution psql -v ON_ERROR_STOP=1 -U evolution -d anneia < setup/postgres/init.sql
# EXIT=0, 0 ERRORs, 51 triggers criados (antes: 0)

cd dashboard && npm test
# 26 testes, 26 pass, 0 fail

curl -s http://127.0.0.1:41283/api/health
# {"status":"ok",...}

./scripts/sync-env.sh   # prova de não-destruição
# sha256 dos 12 segredos idêntico antes/depois; .env 600; .env.bak gerado

./scripts/verify-stack.sh
# STACK SAUDÁVEL — 14 verificações ok  (exit 0)
# teste negativo: docker compose stop dashboard
#   [falha] container dashboard não está em execução
#   [falha] dashboard: HTTP 000
#   [falha] evolution: inacessível pela rede interna
#   STACK COM PROBLEMAS — 3/14 falhas  (exit 1)
# docker compose start dashboard -> volta a exit 0

docker run --rm -v "$PWD:/mnt:ro" koalaman/shellcheck:stable scripts/*.sh tests/*.sh
# exit 0 (antes: 4 achados em sync-env.sh)
```

---

## [Unreleased] - 2026-11-15

### Added
- **Logs do Sistema (Tempo Real)**
  - Nova tabela `system_logs` com índices otimizados (criado_em DESC, nivel, origem, cliente_id, contexto GIN)
  - Função `fn_limpar_logs_antigos(p_dias INT DEFAULT 90)` para retenção configurável
  - Cache em memória das últimas 50 entradas (evita sobrecarga do servidor)
  - Server-Sent Events (SSE) em `/api/v1/logs/stream` para tempo real com heartbeat 30s
  - ~~Middleware de logging automático para todas as rotas `/api/v1/*`~~ — **alegação incorreta**: esse middleware nunca existiu (ver entrada de 2026-11-19).
  - Endpoints: listagem paginada com filtros, stats por nível, origens únicas, limpeza manual (admin)
  - Filtros frontend: nível, origem, busca textual, período; exportação CSV; pause/retomar streaming

- **RBAC Granular (Matriz de Permissões)**
  - Nova tabela `dashboard_permissoes` (role, recurso, acao, permitido) com constraint UNIQUE
  - Seed idempotente: admin/*/*, operador (instances, financeiro, modelos, conhecimento, logs), visualizador (read-only)
  - Endpoints: matrix efetiva do usuário, lista completa (admin), create/update (upsert), delete
  - Middleware `requirePermission(recurso, acao)` para proteção declarativa de rotas
  - Cache em memória recarregado a cada 5min

- **Controle de Acesso**
  - `POST /api/v1/auth/register` restrito ao usuário mestre (DASHBOARD_USERNAME do .env)
  - Verificação via `resolveSessionUser` + Basic Auth
  - Auditoria de tentativas negadas

- **Frontend (Vanilla JS)**
  - Nova aba "Logs do Sistema" com tabela, filtros, badges por nível, paginação
  - Nova aba "Usuários e Permissões" (admin): listagem, matriz visual editável, minhas permissões
  - Modal para cadastro/edição de usuários (nome, email, CPF, role, cliente, senha, etc.)
  - Modal de detalhes do log (contexto JSON expandível, cópia)

### Changed
- Schema `init.sql`: adiciona `system_logs`, `dashboard_permissoes`, triggers de auditoria, função de limpeza
- Backend `server.js`: middleware de auth unificado, logging automático, SSE, RBAC
- Frontend `app.js`: state/logic para logs (SSE + polling fallback), usuários/permissões, navegação de abas

### Fixed
- **Known Issue**: Middleware chain para `/api/v1/auth/users` perde `req.user` após auth middleware
  - Cause: Express middleware ordering para sub-paths `/api/v1/auth/*`
  - Workaround: Logs endpoints funcionam corretamente (200 OK)
  - Fix pendente: ajustar ordem dos middlewares debug/requirePermission para sub-paths

### Database
```sql
-- Executar no container db-evolution:
docker compose exec db-evolution psql -U evolution -d anneia -f /docker-entrypoint-initdb.d/init.sql
-- Ou aplicar apenas as novas tabelas:
CREATE TABLE IF NOT EXISTS system_logs (...);
CREATE TABLE IF NOT EXISTS dashboard_permissoes (...);
CREATE OR REPLACE FUNCTION fn_limpar_logs_antigos(p_dias INT DEFAULT 90) RETURNS JSONB ...;
```

### Testes
```bash
# Logs (funcionando)
curl -u admin:$DASHBOARD_PASSWORD http://localhost:3000/api/v1/logs?use_cache=true
curl -u admin:$DASHBOARD_PASSWORD http://localhost:3000/api/v1/logs/stats
curl -u admin:$DASHBOARD_PASSWORD -N http://localhost:3000/api/v1/logs/stream  # SSE

# Permissões (admin)
curl -u admin:$DASHBOARD_PASSWORD http://localhost:3000/api/v1/permissoes/matrix
curl -u admin:$DASHBOARD_PASSWORD http://localhost:3000/api/v1/permissoes/list
```

---
Co-Authored-By: Claude Code <noreply@anthropic.com>