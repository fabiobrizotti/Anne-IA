# LiteLLM + Langfuse Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remover o 9Router e substituí-lo por LiteLLM como gateway OpenAI-compatible do Dashboard/Strix, adicionando Langfuse v4 para observabilidade, sem alterar o Agente do n8n.

**Architecture:** O Postgres existente (`db-evolution`) ganha os bancos lógicos `litellm` e `langfuse`. O Compose sobe seis serviços novos (`litellm`, `langfuse-web`, `langfuse-worker`, `clickhouse`, `minio`, `langfuse-redis`) com portas de host apenas em loopback. O Dashboard passa a chamar `/health/liveliness`, `/health/readiness` e `/v1/models` do LiteLLM. A captura de conteúdo OTel fica desligada por padrão (`NO_CONTENT`).

**Tech Stack:** Docker Compose, PostgreSQL 15/pgvector, LiteLLM `lts`, Langfuse `4`, ClickHouse ≥25.12, MinIO, Redis, Node.js 20 (Express, Vanilla JS), Bash.

**Spec:** `docs/superpowers/specs/2026-11-26-litellm-langfuse-migration-design.md`

## Global Constraints

- Branch `dev`, Conventional Commits, sem push em `main`.
- `setup/postgres/init.sql` é SSOT do schema; toda alteração é idempotente e reaplicável em container ativo.
- Nenhuma porta, versão de imagem, host ou credencial hardcoded no `docker-compose.yml`: tudo `${VARIAVEL}` com espelho no `.env.example`.
- Senhas de infraestrutura em Base62 de 32 caracteres; `LANGFUSE_ENCRYPTION_KEY` em hex de 32 bytes.
- Dashboard permanece zero-build (HTML/CSS/JS nativos); nenhuma chave é enviada ao navegador.
- Toda mudança de serviço/porta/endpoint/variável/tabela atualiza `README.md` na mesma entrega.
- Nunca colar segredos, tokens ou trechos de `.env` em chat, arquivos versionados ou vault.
- Multimodal desativado (`LANGFUSE_S3_MEDIA_UPLOAD_*` não definido); MinIO sem porta no host.

## Review Focus

- Volume Postgres já existente não executa `init.sql`: o bootstrap manual é pré-requisito para `docker compose up -d`; teste em `tests/test_init_sql.sh` (Task 1) aplica o SQL duas vezes em container descartável e verifica bancos/roles/fallback.
- ClickHouse <25.12 ou sem grants de DDL/sistema: Teste `@test_clickhouse_grants` em `tests/test_gateway_env.sh` (Task 2) valida que o artefato de grants contém `SYSTEM MERGES` e que `CLICKHOUSE_VERSION` tem piso 25.12 no `.env.example`.
- Captura OTel sem valor explícito faz o LiteLLM persistir prompts/respostas: Teste `@test_otel_no_content` (Task 2) verifica que o valor padrão é `NO_CONTENT`.
- Strix roda no host e não resolve o nome DNS `litellm`: Teste `@test_strix_host_url` (Task 5) verifica que o README documenta `http://127.0.0.1:${LITELLM_PORT}/v1`.
- Modelo ausente no `config.yaml` quebra o botão “Testar”: validação em Task 6 com chamada real ao `/v1/models` e ao endpoint de teste do Dashboard.

---

### Task 1: Bases de dados e grants

**Files:**
- Modify: `setup/postgres/init.sql:13-18,342,423` (acrescentar bancos/roles; trocar fallback)
- Create: `setup/clickhouse/init.sql`
- Test: `tests/test_init_sql.sh`

**Interfaces:**
- Consumes: padrão `\gexec` existente em `init.sql:13-18`; `current_setting('app.*', true)` com fallback já usado em `setup/pgbouncer/init-pgbouncer.sql`.
- Produces: bancos `litellm`/`langfuse`, roles `litellm`/`langfuse` (senha via `app.litellm_password` / `app.langfuse_password`, fallback `changeme`), fallback `provedor='litellm'`, grants do ClickHouse aplicáveis no entrypoint.

- [ ] **Step 1: Write the failing test** — acrescentar em `tests/test_init_sql.sh`, após o bloco `[6/7]`: asserções `assert_eq "Banco litellm criado" "1" "$(psql_q "SELECT count(*) FROM pg_database WHERE datname='litellm'")"`; equivalente para `langfuse`; `assert_ge "Roles litellm/langfuse" 2 ...`; e teste funcional chamando `SELECT provedor FROM fn_registrar_uso_tokens(...)` sem provedor e esperando `litellm`. Conferir assinatura da função antes de escrever a chamada.
- [ ] **Step 2: Run test to verify it fails** — `./tests/test_init_sql.sh`; Expected: falha nas quatro asserções novas (bancos/roles/fallback).
- [ ] **Step 3: Implement `init.sql`** — criar os bancos com o padrão `\gexec` antes do `\connect anneia`; criar os roles com `DO $$ ... IF NOT EXISTS ... EXECUTE format('CREATE ROLE ... PASSWORD %L', COALESCE(current_setting('app.litellm_password', true), 'changeme')) ... END $$`, sem alterar senha de role existente; trocar `COALESCE(NULLIF(btrim(p_provedor), ''), '9router')` por `'litellm'`; manter `'9router_sync'` no CHECK.
- [ ] **Step 4: Create `setup/clickhouse/init.sql`** com os grants v4 oficiais (DDL em `default.*`, leitura de `system.*`, `SYSTEM SYNC REPLICA, SYSTEM MERGES, ALTER SETTINGS` em `default.observations_pid_tid_sorting`). Nenhum grant `ON CLUSTER` (single-container).
- [ ] **Step 5: Run test to verify it passes** — `./tests/test_init_sql.sh`; Expected: SUCESSO, 0 ERRORs nas duas aplicações, sentinelas preservadas.
- [ ] **Step 6: Commit** — `git add setup/postgres/init.sql setup/clickhouse/init.sql tests/test_init_sql.sh && git commit -m "feat(db): provisiona bancos litellm/langfuse e grants do clickhouse"`

### Task 2: Variáveis, senhas e config do LiteLLM

**Files:**
- Modify: `.env.example`, `scripts/generate-passwords.sh`
- Create: `setup/litellm/config.yaml`, `tests/test_gateway_env.sh`
- Test: `tests/test_gateway_env.sh`

**Interfaces:**
- Consumes: `generate-passwords.sh` aceita `ENV_FILE` como primeiro argumento (linha 16); `sync-env.sh` aceita `ENV_FILE` via variável de ambiente.
- Produces: chaves `LITELLM_*`, `LANGFUSE_*`, `CLICKHOUSE_*`, `MINIO_*`; `LITELLM_URL`/`LITELLM_API_KEY` para o Dashboard; `LLM_API_BASE` do Strix.

- [ ] **Step 1: Write the failing test** — `tests/test_gateway_env.sh`: cria `.env` temporário vazio, roda `scripts/generate-passwords.sh "$TMP/env"` com `ANNE_SYNCED=1`, e afirma: (a) todas as novas variáveis secretas foram geradas com 32 chars Base62; (b) `LANGFUSE_ENCRYPTION_KEY` tem 64 chars hexLowerCase; (c) nenhuma chave `NINE_ROUTER_` permanece; (d) `@test_otel_no_content`: `.env.example` define `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT`; (e) `@test_clickhouse_grants`: piso `CLICKHOUSE_VERSION` ≥25.12 no `.env.example` e `SYSTEM MERGES` presente em `setup/clickhouse/init.sql`. Usar valores literais, não expressões do código sob teste.
- [ ] **Step 2: Run test to verify it fails** — `./tests/test_gateway_env.sh`; Expected: falha nas asserções (a)-(e).
- [ ] **Step 3: Implement `.env.example`** — remover as chaves do 9Router listadas no spec; adicionar versões (`LITELLM_VERSION=lts`, `LANGFUSE_VERSION=4`, `CLICKHOUSE_VERSION=25.12...`, `MINIO_VERSION`, `LANGFUSE_REDIS_VERSION`), portas ofuscadas com bind `127.0.0.1`, senhas com espelhos `CHAVE_*`, `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT`, chaves do projeto Langfuse vazias, commentários de Strix no host. Não renumerar seções existentes.
- [ ] **Step 4: Implement `scripts/generate-passwords.sh`** — remover `NINE_ROUTER_PASSWORD` e seu espelho; adicionar lista `HEX_FIELDS` com `LANGFUSE_ENCRYPTION_KEY:64` e gerador `openssl rand -hex 32`; adicionar variáveis secretas e espelhos ao `PASSWORD_FIELDS`/`SYNC_PAIRS`.
- [ ] **Step 5: Create `setup/litellm/config.yaml`** — `model_list` com os modelos atuais de `precos_modelos` e `litellm_settings.callbacks: ["langfuse_otel"]`; provider key da OpenRouter vem de `.env`, nunca do YAML.
- [ ] **Step 6: Run test to verify it passes** — `./tests/test_gateway_env.sh` e `./scripts/sync-env.sh --diff`; Expected: todos os testes passam e diff sem segredos.
- [ ] **Step 7: Commit** — `git add .env.example scripts/generate-passwords.sh setup/litellm/config.yaml tests/test_gateway_env.sh && git commit -m "feat(env): parametriza litellm, langfuse e observabilidade"`

### Task 3: Compose e verificação da stack

**Files:**
- Modify: `docker-compose.yml:173-195,278-300,451-492`, `scripts/verify-stack.sh:73,204-214`
- Test: `tests/test_gateway_env.sh` ( acrescentar asserções de compose )

**Interfaces:**
- Consumes: `.env.example` completo da Task 2; bancos/roles da Task 1.
- Produces: serviços `litellm`, `langfuse-web`, `langfuse-worker`, `clickhouse`, `minio`, `langfuse-redis`; `LITELLM_URL` injetado no Dashboard; healthchecks.

- [ ] **Step 1: Write the failing test** — acrescentar em `tests/test_gateway_env.sh`: `docker compose config --services` contém os seis serviços novos e não contém `9router`; `docker compose config` resolve `LITELLM_URL` e todas as variáveis obrigatórias sem placeholder vazio; `grep` em `docker compose config` não encontra valor de nenhuma senha do `.env` temporário.
- [ ] **Step 2: Run test to verify it fails** — `./tests/test_gateway_env.sh`; Expected: falha nos serviços ausentes.
- [ ] **Step 3: Implement Compose** — remover serviço `9router` e `NINE_ROUTER_TAILSCALE_URL` do evolution-api; adicionar os seis serviços com `env_file: .env`, `environment` mapeado, `deploy.resources.limits`, `networks: [data_net]` (LiteLLM também em `frontend` apenas se necessário ao Nginx — preferir só `data_net`), healthchecks, volumes de dados, `command` do MinIO com `mkdir -p /data/langfuse`, montagem do `setup/clickhouse/init.sql` em `/docker-entrypoint-initdb.d/01-grants.sql:ro`; trocar `depends_on` do Nginx de `9router` para `litellm` e `langfuse-web`; injetar `LITELLM_URL`/`LITELLM_API_KEY` no Dashboard.
- [ ] **Step 4: Implement `scripts/verify-stack.sh`** — `SERVICES` sem `9router` e com os seis novos; `check_http()` troca `nine_port`/`/api/health` por `litellm_port`/`/health/liveliness` e acrescenta `/api/public/health` do Langfuse, sem imprimir master key.
- [ ] **Step 5: Run test to verify it passes** — `./tests/test_gateway_env.sh && docker compose config --quiet`; Expected: tudo verde, zero segredos no output.
- [ ] **Step 6: Commit** — `git add docker-compose.yml scripts/verify-stack.sh tests/test_gateway_env.sh && git commit -m "feat(compose): troca 9router por litellm e langfuse v4"`

### Task 4: Dashboard API e UI

**Files:**
- Modify: `dashboard/src/server.js:15-16,2270-2328,2524,2544,2583`, `dashboard/public/app.js:142-147,274,1527-1567,1754-1801`, `dashboard/public/index.html:336-353,1023-1025,1078-1114`, `dashboard/src/logger.js`
- Create: `dashboard/tests/gateway.test.js`

**Interfaces:**
- Consumes: `LITELLM_URL` e `LITELLM_API_KEY` da Task 3.
- Produces: `GET /api/v1/litellm/status`, `POST /api/v1/modelos/:id/testar` inalterado no contrato; ids `btn-sync-litellm`, `datalist-litellm-models`.

- [ ] **Step 1: Write the failing test** — `dashboard/tests/gateway.test.js`: sobe servidor HTTP local falso com `/health/liveliness`, `/health/readiness`, `/v1/models` (`{data:[{id:"openrouter/x",owned_by:"openrouter"}]}`),子进程 `node src/server.js` com `PORT` livre, `LITELLM_URL=http://127.0.0.1:<porta>/v1`, `LITELLM_API_KEY=chave-teste`, sem `DATABASE_URL`/`REDIS_URL`; espera o listen e faz `GET /api/v1/litellm/status`. Afirma `gateway_url`, `healthy: true`, `total_models: 1`, `models[0].id` e `has_api_key: true`. Encerra o filho no `after`.
- [ ] **Step 2: Run test to verify it fails** — `npm test --prefix dashboard -- --test-name-pattern='litellm status'`; Expected: FAIL (rota 404).
- [ ] **Step 3: Implement API** — trocar constantes por `LITELLM_URL`/`LITELLM_API_KEY`; renomear rota para `/api/v1/litellm/status`; health em `/health/liveliness` e `/health/readiness`; modelos em `/v1/models` com Bearer quando houver chave; manter envelope de resposta atual; atualizar `endpoint_url` no handler de teste para o LiteLLM; trocar categoria do logger para `'litellm'`.
- [ ] **Step 4: Run test to verify it passes** — `npm test --prefix dashboard`; Expected: suite verde.
- [ ] **Step 5: Implement UI Vanilla** — renomear ids/funções/estado (`checkLiteLLMStatus`, `liteLLMModels`), rótulos, endpoints literais e mensagens de erro; sem frameworks.
- [ ] **Step 6: Verify UI in browser** — Playwright/Chrome DevTools em `127.0.0.1` nos temas claro/escuro: banner mostra “LiteLLM”, sync popula a datalist, modal “Ping LiteLLM” sem segredos no DOM.
- [ ] **Step 7: Commit** — `git add dashboard && git commit -m "feat(dashboard): aponta status e teste de modelos para litellm"`

### Task 5: Documentação e scripts operacionais

**Files:**
- Modify: `README.md`, `AGENTS.md`, `.gitignore`
- Test: `tests/test_gateway_env.sh` (asserções de docs)

**Interfaces:**
- Consumes: Tasks 1–4 completas.
- Produces: procedimento de bootstrap, portas, variáveis e endpoints documentados.

- [ ] **Step 1: Write the failing test** — acrescentar `@test_strix_host_url` em `tests/test_gateway_env.sh`: `README.md` contém `http://127.0.0.1:${LITELLM_PORT}/v1` e a seção §5 não cita `9Router` como serviço ativo. Usar `grep -q`, não comparar conteúdo integral.
- [ ] **Step 2: Run test to verify it fails** — `./tests/test_gateway_env.sh`; Expected: falha na asserção do Strix.
- [ ] **Step 3: Implement docs** — reescrever README §5, tabela de portas, estrutura `data/`, variáveis, endpoints (§9)/Strix (§10), bootstrap manual com `PGOPTIONS` para as senhas dos roles, chaves do projeto Langfuse, Broadcast opcional da OpenRouter, aviso LGPD do `NO_CONTENT`, exceção histórica `9router_sync`, data de revisão do `lts`; atualizar `AGENTS.md` e `.gitignore` (`data/clickhouse/`, `data/minio/`; remover `data/9router/`).
- [ ] **Step 4: Run test to verify it passes** — `./tests/test_gateway_env.sh`; Expected: verde.
- [ ] **Step 5: Commit** — `git add README.md AGENTS.md .gitignore tests/test_gateway_env.sh && git commit -m "docs: atualiza stack litellm/langfuse e bootstrap do banco"`

### Task 6: Validação integrada e registro no vault

**Files:**
- Modify: `~/Documents/SegundoCerebro/01_Daily/2026-11-26.md`, `~/Documents/SegundoCerebro/20_Projects/Projeto - TCC Anne IA (ETEC).md`

**Interfaces:**
- Consumes: stack implantada pelas Tasks 1–5.
- Produces: evidência de healthchecks, endpoints, trace e consumo de memória; log canonical no vault.

- [ ] **Step 1: Bootstrap e subida** — aplicar `init.sql` no `db-evolution` com `PGOPTIONS` das senhas; `./scripts/sync-env.sh`; `docker compose up -d --remove-orphans`. Expected: 17 serviços healthy/started, 9router removido.
- [ ] **Step 2: Verificação** — `./scripts/verify-stack.sh`, `npm test --prefix dashboard`, `./tests/test_init_sql.sh`, `./tests/test_gateway_env.sh`. Expected: todos verdes.
- [ ] **Step 3: Integração funcional** — `curl` em `/api/v1/litellm/status`, `GET /v1/models` com master key (via Docker, sem expor chave), teste de modelo no Dashboard via UI real, chamada OpenAI-compatible ao LiteLLM, login no Langfuse e conferência de um trace com modelo/tokens/custo e input/output vazios. Expected: tudo funcional; nenhum segredo em logs.
- [ ] **Step 4: Registro no vault** — acrescentar o bloco `## Log 2026-11-26 — Migração LiteLLM + Langfuse` com o padrão obrigatório (O que foi feito / Decisões tomadas / Pendências) nos dois arquivos do vault, preservando frontmatter canônico e sem segredos.
- [ ] **Step 5: Commit final** (somente arquivos do repo; vault fica fora) — `git commit -am "chore: registra validação da migração"` se houver alteração pendente.

---

**Nota de execução:** o usuário autorizou execução inline com validação completa e registro. Worktree não será usado porque `AGENTS.md` exige desenvolvimento na branch `dev` (ruling registrado no ledger).
