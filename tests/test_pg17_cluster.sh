#!/usr/bin/env bash
# ==============================================================================
# ANNE-IA — VALIDAÇÃO DO CLUSTER PG17 APÓS UPGRADE DO db-evolution
# ==============================================================================
# Valida, contra o container real, que o upgrade major preservou os dados e
# que o banco dedicado do n8n existe com role isolada. Valores literais foram
# inventariados ANTES do upgrade: clientes=1, auditoria>=264, vector=0.8.7.
# ==============================================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

FAILS=0
say() { printf '%s\n' "$*"; }
ok()  { printf '  \033[32m[OK]\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m[FALHA]\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }

PG_USER="$(grep -E '^POSTGRES_USER=' .env | head -1 | cut -d= -f2)"
PG_PORT="$(grep -E '^POSTGRES_PORT=' .env | head -1 | cut -d= -f2)"
PG_PORT="${PG_PORT:-5432}"
q() { docker compose --env-file .env exec -T db-evolution psql -U "${PG_USER}" -d "$1" -tAc "$2" 2>/dev/null | tr -d '[:space:]'; }

say "=== Cluster db-evolution (esperado PostgreSQL 17) ==="

VER="$(q postgres 'SHOW server_version_num')"
[[ "${VER:-0}" =~ ^[0-9]+$ ]] && [[ "${VER}" -ge 170000 ]] \
  && ok "server_version_num=${VER} (>= 170000)" \
  || bad "versão ${VER:-vazio} — esperado >= 170000"

for db in anneia evolution n8n; do
  n="$(q postgres "SELECT count(*) FROM pg_database WHERE datname='${db}'")"
  [[ "${n}" == "1" ]] && ok "banco ${db} presente" || bad "banco ${db} ausente"
done

VEC="$(q anneia "SELECT extversion FROM pg_extension WHERE extname='vector'")"
[[ "${VEC}" == "0.8.7" ]] && ok "pgvector 0.8.7 em anneia" || bad "pgvector em anneia: ${VEC:-ausente}"

CLI="$(q anneia 'SELECT count(*) FROM clientes')"
[[ "${CLI}" == "1" ]] && ok "dado de negócio preservado (clientes=1)" || bad "clientes=${CLI:-vazio} (esperado 1)"

AUD="$(q anneia 'SELECT count(*) FROM auditoria_geral')"
[[ "${AUD}" =~ ^[0-9]+$ ]] && [[ "${AUD}" -ge 264 ]] \
  && ok "auditoria preservada (${AUD} >= 264)" || bad "auditoria=${AUD:-vazio} (< 264)"

TAB="$(q anneia "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")"
[[ "${TAB}" =~ ^[0-9]+$ ]] && [[ "${TAB}" -ge 18 ]] \
  && ok "tabelas public (${TAB})" || bad "tabelas public=${TAB:-vazio}"

TRG="$(q anneia "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg_audit%'")"
[[ "${TRG}" == "51" ]] && ok "triggers de auditoria (51)" || bad "triggers=${TRG:-vazio} (esperado 51)"

ROLE="$(q postgres "SELECT rolcanlogin FROM pg_roles WHERE rolname='n8n'")"
[[ "${ROLE}" == "t" ]] && ok "role n8n com LOGIN" || bad "role n8n ausente/sem LOGIN"

N8N_PWD="$(grep -E '^CHAVE_DB_POSTGRESDB_PASSWORD=' .env | head -1 | cut -d= -f2)"
if [[ -n "${N8N_PWD}" ]]; then
  if PGPASSWORD="${N8N_PWD}" psql -h 127.0.0.1 -p "${PG_PORT}" -U n8n -d n8n -tAc 'SELECT 1' 2>/dev/null | grep -q '^ *1'; then
    ok "login direto n8n -> db n8n (sem PgBouncer)"
  else
    bad "login direto n8n falhou"
  fi
else
  bad "CHAVE_DB_POSTGRESDB_PASSWORD vazia no .env"
fi

if [[ ${FAILS} -eq 0 ]]; then
  say "SUCESSO — cluster PG17 íntegro e banco do n8n provisionado."
  exit 0
fi
say "FALHOU — ${FAILS} verificação(ões) com problema."
exit 1
