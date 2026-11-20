#!/usr/bin/env bash
# ==============================================================================
# ANNE-IA — SMOKE TEST DA ABA "LOGS" DO DASHBOARD
# ==============================================================================
# Valida, contra a stack em execução, o que a aba de Logs precisa cumprir:
#   1. Rota protegida rejeita requisição sem credencial (401)
#   2. Listagem autenticada responde 200 e devolve logs persistidos
#   3. Anti-loop: listar N vezes NÃO cria logs novos (rotas /api/v1/logs* são
#      ignoradas pelo requestLogger)
#   4. Exportação CSV responde 200 com cabeçalho correto
#   5. Ingestão externa nunca aceita escrita anônima (503 sem token / 401 errado)
#
# Se a stack não estiver acessível, o teste PULA e sai com 0 (não quebra CI).
#
# Uso:  ./tests/test_logs_smoke.sh
# Saída: exit 0 = ok/pulado | exit 1 = falha
# ==============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"

read_env() { grep -E "^$1=" "${ENV_FILE}" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r\n'; }

DASH_PORT="$(read_env DASHBOARD_PORT)"
BASE_URL="http://127.0.0.1:${DASH_PORT:-3000}"
USER="$(read_env DASHBOARD_USERNAME)"
PASS="$(read_env DASHBOARD_PASSWORD)"

PASSED=0
FAILED=0
pass() { printf '\033[32m[PASS]\033[0m %s\n' "$1"; PASSED=$((PASSED + 1)); }
fail() { printf '\033[31m[FAIL]\033[0m %s\n' "$1"; FAILED=$((FAILED + 1)); }

# --- 0. Disponibilidade da stack ---------------------------------------------
if ! curl -fsS --max-time 3 "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[SKIP] Dashboard não acessível em ${BASE_URL} — smoke test ignorado."
  exit 0
fi

if [ -z "${USER}" ] || [ -z "${PASS}" ]; then
  echo "[SKIP] DASHBOARD_USERNAME/DASHBOARD_PASSWORD ausentes no .env — smoke test ignorado."
  exit 0
fi

echo "Smoke test da aba Logs — alvo: ${BASE_URL}"

# --- 1. Sem credencial -------------------------------------------------------
CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/v1/logs")
[ "${CODE}" = "401" ] && pass "GET /api/v1/logs sem sessão retorna 401" \
  || fail "GET /api/v1/logs sem sessão retornou ${CODE} (esperado 401)"

# --- 2. Listagem autenticada -------------------------------------------------
BODY=$(curl -s -u "${USER}:${PASS}" "${BASE_URL}/api/v1/logs?limit=5")
if printf '%s' "${BODY}" | grep -q '"success":true'; then
  pass "Listagem autenticada responde success=true"
else
  fail "Listagem autenticada não retornou success=true"
fi

TOTAL_1=$(printf '%s' "${BODY}" | grep -o '"total":[0-9]*' | head -1 | cut -d: -f2)
if [ -n "${TOTAL_1}" ] && [ "${TOTAL_1}" -gt 0 ]; then
  pass "system_logs possui registros (total=${TOTAL_1})"
else
  fail "system_logs está vazio ou total ausente — a aba continuaria em branco"
fi

# --- 3. Anti-loop (rotas de logs não se auto-logam) --------------------------
for _ in 1 2 3; do
  curl -s -u "${USER}:${PASS}" "${BASE_URL}/api/v1/logs?limit=1" >/dev/null
  curl -s -u "${USER}:${PASS}" "${BASE_URL}/api/v1/logs/stats" >/dev/null
done
TOTAL_2=$(curl -s -u "${USER}:${PASS}" "${BASE_URL}/api/v1/logs?limit=1" \
  | grep -o '"total":[0-9]*' | head -1 | cut -d: -f2)

if [ "${TOTAL_1}" = "${TOTAL_2}" ]; then
  pass "Anti-loop: contagem estável após 6 requisições (${TOTAL_2})"
else
  fail "Anti-loop quebrado: ${TOTAL_1} -> ${TOTAL_2} (rotas de logs se auto-registram)"
fi

# --- 4. Exportação CSV -------------------------------------------------------
CSV_HEADERS=$(curl -s -D - -o /dev/null -u "${USER}:${PASS}" "${BASE_URL}/api/v1/logs/export?limit=10")
CODE=$(printf '%s' "${CSV_HEADERS}" | head -1 | grep -o '[0-9]\{3\}')
CONTENT_TYPE=$(printf '%s' "${CSV_HEADERS}" | grep -i '^content-type:' | head -1)
[ "${CODE}" = "200" ] && pass "Export responde 200" || fail "Export respondeu ${CODE} (esperado 200)"
printf '%s' "${CONTENT_TYPE}" | grep -qi 'text/csv' \
  && pass "Export serve text/csv" || fail "Export não serve text/csv"

CSV_BODY=$(curl -s -u "${USER}:${PASS}" "${BASE_URL}/api/v1/logs/export?limit=10")
printf '%s' "${CSV_BODY}" | head -1 | grep -q '^Timestamp,Nivel,Origem,Mensagem,Contexto,Cliente' \
  && pass "CSV começa com o cabeçalho esperado" || fail "Cabeçalho do CSV incorreto"

# --- 5. Ingestão externa nunca é anônima -------------------------------------
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"nivel":"info","origem":"n8n","mensagem":"smoke"}' "${BASE_URL}/api/v1/logs/ingest")
if [ "${CODE}" = "503" ] || [ "${CODE}" = "401" ]; then
  pass "Ingestão sem token recusada (HTTP ${CODE})"
else
  fail "Ingestão sem token retornou ${CODE} (esperado 503 desabilitado ou 401)"
fi

echo "----------------------------------------------------------------------"
echo "Resultado: ${PASSED} passou, ${FAILED} falhou"
[ "${FAILED}" -eq 0 ] || exit 1
