#!/usr/bin/env bash
# ==============================================================================
# ANNE-IA — TESTE DE IDEMPOTÊNCIA E BOOT LIMPO DO init.sql
# ==============================================================================
# Valida os dois cenários que a atualização na VPS precisa cumprir:
#   1. BOOT LIMPO  : volume vazio -> init.sql roda sem nenhum ERROR.
#   2. REAPLICAÇÃO : init.sql roda de novo em banco já populado, sem ERROR e
#                    SEM perda de dados (idempotência real, não só declarada).
#
# Isolamento: sobe um Postgres DESCARTÁVEL (sem portas publicadas, sem volume,
# nome aleatório) e o remove ao final. NUNCA toca na stack de produção.
#
# Uso:  ./tests/test_init_sql.sh
# Saída: exit 0 = tudo ok | exit 1 = falha (com diff do log)
# ==============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INIT_SQL="${PROJECT_ROOT}/setup/postgres/init.sql"
LOG_DIR="${TMPDIR:-/tmp}/anneia-test-init-$$"

# Versão da imagem espelha o que roda em produção (.env tem prioridade)
PGVECTOR_VERSION="$(grep -E '^PGVECTOR_VERSION=' "${PROJECT_ROOT}/.env" 2>/dev/null | head -1 | cut -d= -f2 || true)"
PGVECTOR_VERSION="${PGVECTOR_VERSION:-pg15}"
PG_IMAGE="pgvector/pgvector:${PGVECTOR_VERSION}"

# Credenciais efêmeras do container de teste (nunca são de produção)
TEST_PWD="testonly_$(openssl rand -hex 12 2>/dev/null || echo "fallback$$")"
TEST_USER="evolution"
TEST_DB="evolution"

CONTAINER="anneia-test-init-$$"
FAILS=0

mkdir -p "${LOG_DIR}"

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  rm -rf "${LOG_DIR}"
}
trap cleanup EXIT

say() { printf '%s\n' "$*"; }
ok()  { printf '  \033[32m[OK]\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m[FALHA]\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }

require() {
  command -v docker >/dev/null 2>&1 || { say "[erro] docker não encontrado"; exit 1; }
  [[ -f "${INIT_SQL}" ]] || { say "[erro] ${INIT_SQL} não encontrado"; exit 1; }
  docker info >/dev/null 2>&1 || { say "[erro] daemon Docker indisponível"; exit 1; }
}

wait_ready() {
  local stable=0
  for _ in $(seq 1 90); do
    if docker exec "${CONTAINER}" psql -U "${TEST_USER}" -d "${TEST_DB}" -tAc 'SELECT 1' >/dev/null 2>&1; then
      stable=$((stable + 1))
      [[ ${stable} -ge 3 ]] && return 0
    else
      stable=0
    fi
    sleep 1
  done
  return 1
}

# Aplica o init.sql e devolve a contagem de ERRORs
apply_init() {
  local out="$1" n
  docker exec -i "${CONTAINER}" psql -U "${TEST_USER}" -d "${TEST_DB}" < "${INIT_SQL}" > "${out}" 2>&1 || true
  n="$(grep -c 'ERROR:' "${out}" 2>/dev/null)" || n=0
  printf '%s' "${n:-0}"
}

psql_q() {
  docker exec "${CONTAINER}" psql -U "${TEST_USER}" -d anneia -tAc "$1" 2>/dev/null | tr -d '[:space:]'
}

say "==================================================================="
say " Anne-IA — Teste de idempotência do init.sql"
say " imagem: ${PG_IMAGE}"
say "==================================================================="

require
say "[1/7] Subindo Postgres descartável (${CONTAINER})..."
docker run -d --name "${CONTAINER}" \
  -e POSTGRES_PASSWORD="${TEST_PWD}" \
  -e POSTGRES_USER="${TEST_USER}" \
  -e POSTGRES_DB="${TEST_DB}" \
  "${PG_IMAGE}" >/dev/null

if ! wait_ready; then
  bad "Postgres de teste não ficou pronto em 90s"
  docker logs --tail 30 "${CONTAINER}" 2>&1 || true
  exit 1
fi
ok "Postgres pronto e estável"

say "[2/7] Aplicação #1 (cenário BOOT LIMPO) — volume vazio..."
ERR1="$(apply_init "${LOG_DIR}/run1.log")"
if [[ "${ERR1}" == "0" ]]; then
  ok "Sem ERRORs na primeira aplicação"
else
  bad "${ERR1} ERROR(s) na primeira aplicação:"
  grep -n 'ERROR:' "${LOG_DIR}/run1.log" | head -20
fi

say "[3/7] Inserindo dado de negócio para provar que a reaplicação não destrói nada..."
docker exec -i "${CONTAINER}" psql -U "${TEST_USER}" -d anneia -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
INSERT INTO clientes (id, nome) VALUES ('tenant-teste-idempotencia', 'Cliente Sentinela')
ON CONFLICT (id) DO NOTHING;
SQL
ok "Registro sentinela criado em clientes"

say "[4/7] Aplicação #2 (cenário GIT PULL + reaplicar schema)..."
ERR2="$(apply_init "${LOG_DIR}/run2.log")"
if [[ "${ERR2}" == "0" ]]; then
  ok "Sem ERRORs na reaplicação"
else
  bad "${ERR2} ERROR(s) na reaplicação:"
  grep -n 'ERROR:' "${LOG_DIR}/run2.log" | head -20
fi

say "[5/7] Teste funcional dos triggers de auditoria (DML real)..."
# Cobre o caso que derrubava a aplicação: tabela SEM coluna `id` (produtos)
if docker exec -i "${CONTAINER}" psql -U "${TEST_USER}" -d anneia -v ON_ERROR_STOP=1 \
     > "${LOG_DIR}/dml.log" 2>&1 <<'SQL'
INSERT INTO produtos (nome_produto, preco, estoque) VALUES ('Produto Auditoria', 10.00, 5);
UPDATE produtos SET preco = 12.50 WHERE nome_produto = 'Produto Auditoria';
UPDATE clientes SET nome = 'Cliente Sentinela Renomeado' WHERE id = 'tenant-teste-idempotencia';
DELETE FROM produtos WHERE nome_produto = 'Produto Auditoria';
SQL
then
  ok "INSERT/UPDATE/DELETE executados sem erro (produtos e clientes)"
else
  bad "DML quebrou — triggers de auditoria inviáveis:"
  grep -nE 'ERROR|DETAIL|HINT' "${LOG_DIR}/dml.log" | head -10
fi

say "[6/7] Verificando integridade pós-reaplicação..."
SENTINELA="$(psql_q "SELECT count(*) FROM clientes WHERE id='tenant-teste-idempotencia'")"
[[ "${SENTINELA}" == "1" ]] && ok "Dado sentinela preservado (sem perda)" || bad "Dado sentinela PERDIDO (idempotência destrutiva!)"

TABELAS="$(psql_q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")"
[[ "${TABELAS:-0}" -ge 18 ]] && ok "${TABELAS} tabelas no schema public" || bad "Apenas ${TABELAS:-0} tabelas (esperado >= 18)"

TRIGGERS="$(psql_q "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg_audit%'")"
[[ "${TRIGGERS:-0}" -eq 51 ]] && ok "51 triggers de auditoria (17 tabelas x 3 eventos)" || bad "${TRIGGERS:-0} triggers de auditoria (esperado 51)"

ADMIN="$(psql_q "SELECT count(*) FROM dashboard_permissoes WHERE role='admin' AND recurso='*' AND acao='*'")"
[[ "${ADMIN}" == "1" ]] && ok "Seed wildcard admin/*/* presente" || bad "Seed wildcard admin/*/* ausente (CHECK constraint barrando)"

FUNCS="$(psql_q "SELECT count(*) FROM pg_proc WHERE proname IN ('fn_auditoria_statement','fn_limpar_logs_antigos','fn_registrar_uso_tokens','fn_lgpd_expurgo_retencao')")"
[[ "${FUNCS:-0}" -eq 4 ]] && ok "4 funções críticas presentes" || bad "${FUNCS:-0}/4 funções críticas presentes"

AUD_PROD="$(psql_q "SELECT count(*) FROM auditoria_geral WHERE tabela='produtos'")"
[[ "${AUD_PROD:-0}" -ge 3 ]] && ok "${AUD_PROD} eventos auditados em produtos (I+U+D)" || bad "${AUD_PROD:-0} eventos em produtos (esperado >= 3)"

AUD_PAR="$(psql_q "SELECT count(*) FROM auditoria_geral WHERE tabela='produtos' AND operacao='U' AND dados_antigos IS NOT NULL AND dados_novos IS NOT NULL")"
[[ "${AUD_PAR:-0}" -ge 1 ]] && ok "UPDATE auditado com dados_antigos + dados_novos (pareamento ok)" || bad "UPDATE sem pareamento antigo/novo"

AUD_CLI="$(psql_q "SELECT count(*) FROM auditoria_geral WHERE tabela='clientes' AND operacao='U'")"
[[ "${AUD_CLI:-0}" -ge 1 ]] && ok "UPDATE em clientes auditado (tabela com PK id)" || bad "UPDATE em clientes não auditado"

say "[7/7] Resultado final..."
if [[ ${FAILS} -eq 0 ]]; then
  say "==================================================================="
  printf ' \033[32m%s\033[0m\n' "SUCESSO — init.sql é idempotente e sobe em banco vazio."
  say "==================================================================="
  exit 0
fi

say "==================================================================="
printf ' \033[31m%s\033[0m\n' "FALHOU — ${FAILS} verificação(ões) com problema."
say "==================================================================="
exit 1
