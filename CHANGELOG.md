# CHANGELOG - Anne-IA Dashboard

## [1.2.0] - 2026-11-16

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
  - Middleware de logging automático para todas as rotas `/api/v1/*` (persiste assíncrono + cache)
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