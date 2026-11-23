#!/usr/bin/env bash
# ============================================================================
# ANNE-IA — TESTES DE FUMAÇA DO PROXY (Nginx + PgBouncer)
# ============================================================================
# Valida comportamentos críticos do reverse proxy e connection pooler.
# Estilo: test_logs_smoke.sh (bash puro, sem dependências externas).
# ============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

ENV_FILE="${PROJECT_ROOT}/.env"

[[ -f "${ENV_FILE}" ]] || { echo "[erro] ${ENV_FILE} não encontrado" >&2; exit 1; }

env_get() {
  local key="$1" default="${2:-}"
  local val
  val="$(grep -E "^${key}=" "${ENV_FILE}" | head -1 | cut -d= -f2- || true)"
  # Strip inline comments
  val="${val%%#*}"
  # Trim whitespace
  val="$(printf '%s' "${val}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  printf '%s' "${val:-${default}}"
}

# Use host port for curl tests (nginx binds to 127.0.0.1:80 on host)
NGINX_HOST_PORT="$(env_get NGINX_PORT 80)"
# Container port for docker exec tests
NGINX_CONTAINER_PORT="$(env_get NGINX_CONTAINER_PORT 8080)"
N8N_PORT="$(env_get N8N_PORT 34567)"
PGBOUNCER_CONTAINER_PORT="$(env_get PGBOUNCER_CONTAINER_PORT 6432)"

# Cores
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
NC='\033[0m'

ok()   { printf '  %b[ok]%b   %s\n' "${GREEN}" "${NC}" "$*"; }
fail() { printf '  %b[falha]%b %s\n' "${RED}" "${NC}" "$*"; exit 1; }
warn() { printf '  %b[aviso]%b %s\n' "${YELLOW}" "${NC}" "$*"; }

echo "==================================================================="
echo " Anne-IA — Testes de fumaça do Proxy (Nginx + PgBouncer)"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo "==================================================================="

# ------------------------------------------------------------------------------
# 1. NGINX HEALTHCHECK
# ------------------------------------------------------------------------------
echo "--- Nginx Healthcheck ---"
# Use TAILSCALE_HOSTNAME as Host header to match nginx server_name
TAILSCALE_HOSTNAME=$(env_get TAILSCALE_HOSTNAME "anneia-vps")
if docker compose exec -T nginx wget -q --spider --header="Host: ${TAILSCALE_HOSTNAME}" "http://127.0.0.1:${NGINX_CONTAINER_PORT}/nginx-health" >/dev/null 2>&1; then
  ok "nginx-health endpoint responde 200"
else
  fail "nginx-health endpoint não responde"
fi

# ------------------------------------------------------------------------------
# 2. RATE LIMIT LOGIN (6 tentativas = 429)
# ------------------------------------------------------------------------------
echo "--- Rate Limit Login ---"
login_url="http://127.0.0.1:${NGINX_HOST_PORT}/api/v1/auth/login"
blocked=0
for _ in {1..7}; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST \
    -H "Content-Type: application/json" \
    -H "Host: ${TAILSCALE_HOSTNAME}" \
    -d '{"identifier":"test","password":"wrong"}' \
    "${login_url}" 2>/dev/null || true)
  if [[ "${code}" == "429" ]]; then
    blocked=1
    break
  fi
done
if [[ ${blocked} -eq 1 ]]; then
  ok "Rate limit login bloqueou após 6 tentativas (HTTP 429)"
else
  fail "Rate limit login NÃO bloqueou (esperado 429 na 6ª+ tentativa)"
fi

# ------------------------------------------------------------------------------
# 3. RATE LIMIT API GERAL (burst respeitado)
# ------------------------------------------------------------------------------
echo "--- Rate Limit API Geral ---"
api_url="http://127.0.0.1:${NGINX_HOST_PORT}/api/health"
# Deve permitir burst inicial
success=0
for _ in {1..5}; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
    -H "Host: ${TAILSCALE_HOSTNAME}" \
    "${api_url}" 2>/dev/null || true)
  [[ "${code}" == "200" ]] && success=$((success + 1))
done
if [[ ${success} -ge 3 ]]; then
  ok "Rate limit API permite burst inicial (${success}/5 OK)"
else
  fail "Rate limit API bloqueou requisições legítimas (${success}/5 OK)"
fi

# ------------------------------------------------------------------------------
# 4. CLIENT MAX BODY SIZE (5MB = 413)
# ------------------------------------------------------------------------------
echo "--- Client Max Body Size ---"
# Gera payload de 5MB em arquivo (argumento inline estouraria o ARG_MAX)
body_file="$(mktemp)"
head -c 5242880 /dev/zero | tr '\0' 'x' > "${body_file}"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST \
  -H "Content-Type: application/json" \
  -H "Host: ${TAILSCALE_HOSTNAME}" \
  --data-binary "@${body_file}" \
  "http://127.0.0.1:${NGINX_HOST_PORT}/api/v1/conhecimento" 2>/dev/null || true)
rm -f "${body_file}"
if [[ "${code}" == "413" ]]; then
  ok "Body 5MB rejeitado com HTTP 413 (client_max_body_size)"
else
  warn "Body 5MB retornou HTTP ${code} (esperado 413) — verifique NGINX_CLIENT_MAX_BODY_SIZE_CONHECIMENTO"
fi

# ------------------------------------------------------------------------------
# 5. HOST DESCONHECIDO (444 = conexão fechada)
# ------------------------------------------------------------------------------
echo "--- Host Desconhecido ---"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
  -H "Host: desconhecido.invalido" \
  "http://127.0.0.1:${NGINX_HOST_PORT}/api/health" 2>/dev/null || true)
# This test correctly uses an invalid host to trigger 444 - keep as is
# 444 = nginx close connection (não aparece no curl como HTTP code)
# curl retorna 000 ou 52/56 dependendo da versão quando conexão é fechada
if [[ "${code}" == "000" ]] || [[ "${code}" == "52" ]] || [[ "${code}" == "56" ]]; then
  ok "Host desconhecido teve conexão fechada (nginx default_server 444)"
else
  warn "Host desconhecido retornou HTTP ${code} (esperado conexão fechada)"
fi

# ------------------------------------------------------------------------------
# 6. DASHBOARD VIA NGINX (login/logout funcional)
# ------------------------------------------------------------------------------
echo "--- Dashboard via Nginx ---"
# Healthcheck via proxy
code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 \
  -H "Host: ${TAILSCALE_HOSTNAME}" \
  "http://127.0.0.1:${NGINX_HOST_PORT}/api/health" 2>/dev/null || true)
if [[ "${code}" == "200" ]]; then
  ok "Dashboard /api/health acessível via Nginx (HTTP 200)"
else
  fail "Dashboard /api/health via Nginx falhou (HTTP ${code})"
fi

# ------------------------------------------------------------------------------
# 7. N8N VIA NGINX (WebSocket upgrade headers)
# ------------------------------------------------------------------------------
echo "--- n8n via Nginx ---"
N8N_BASE_PATH="$(env_get N8N_PATH "/n8n/")"
N8N_BASE_PATH="${N8N_BASE_PATH%/}"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 \
  -H "Host: ${TAILSCALE_HOSTNAME}" \
  "http://127.0.0.1:${NGINX_HOST_PORT}${N8N_BASE_PATH}/healthz" 2>/dev/null || true)
if [[ "${code}" == "200" ]]; then
  ok "n8n ${N8N_BASE_PATH}/healthz acessível via Nginx (HTTP 200)"
else
  warn "n8n ${N8N_BASE_PATH}/healthz retornou HTTP ${code} (esperado 200)"
fi

# ------------------------------------------------------------------------------
# 8. PGBOUNCER CONEXÃO
# ------------------------------------------------------------------------------
echo "--- PgBouncer Conexão ---"
if docker compose exec -T pgbouncer nc -z 127.0.0.1 "${PGBOUNCER_CONTAINER_PORT}" >/dev/null 2>&1; then
  ok "PgBouncer aceita conexões na porta ${PGBOUNCER_CONTAINER_PORT}"
else
  fail "PgBouncer não responde na porta ${PGBOUNCER_CONTAINER_PORT}"
fi

# ------------------------------------------------------------------------------
# 9. DASHBOARD RECONECTA APÓS RESTART PGBOUNCER
# ------------------------------------------------------------------------------
echo "--- Dashboard Reconecta pós PgBouncer Restart ---"
echo "  Reiniciando pgbouncer..."
docker compose restart pgbouncer >/dev/null 2>&1
sleep 3
# Aguarda pgbouncer subir
for _ in {1..10}; do
  if docker compose exec -T pgbouncer nc -z 127.0.0.1 "${PGBOUNCER_CONTAINER_PORT}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
# Testa dashboard health via nginx (que passa pelo pgbouncer)
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 \
  -H "Host: ${TAILSCALE_HOSTNAME}" \
  "http://127.0.0.1:${NGINX_HOST_PORT}/api/health" 2>/dev/null || true)
if [[ "${code}" == "200" ]]; then
  ok "Dashboard reconectou via PgBouncer após restart (HTTP 200)"
else
  fail "Dashboard NÃO reconectou após restart do PgBouncer (HTTP ${code})"
fi

# ------------------------------------------------------------------------------
# 10. EVOLUTION -> N8N -> RABBITMQ INTERNO (não afetado por Nginx)
# ------------------------------------------------------------------------------
echo "--- Fluxo Interno (Evolution -> n8n -> RabbitMQ) ---"
# Verifica se evolution-api alcança n8n internamente (sem Nginx)
if docker compose exec -T evolution-api wget -q --spider \
  --header="Origin: http://localhost:3000" \
  "http://n8n:${N8N_PORT}${N8N_BASE_PATH}/healthz" >/dev/null 2>&1; then
  ok "Evolution API alcança n8n internamente (sem Nginx)"
else
  warn "Evolution API NÃO alcança n8n internamente"
fi

# UIs administrativas via Nginx (subcaminho /rabbitmq e /pgadmin)
for pair in "rabbitmq:/rabbitmq/" "pgadmin:/pgadmin/"; do
  name="${pair%%:*}"
  path="${pair#*:}"
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 \
    -H "Host: ${TAILSCALE_HOSTNAME}" \
    "http://127.0.0.1:${NGINX_HOST_PORT}${path}" 2>/dev/null || true)
  # redirect para tela de login (302/308) também indica rota funcionando
  if [[ "${code}" =~ ^(200|301|302|308|401)$ ]]; then
    ok "${name} acessível via Nginx em ${path} (HTTP ${code})"
  else
    warn "${name} via Nginx em ${path} retornou HTTP ${code}"
  fi
done

echo "==================================================================="
printf ' %b%s%b\n' "${GREEN}" "TESTES DE FUMAÇA CONCLUÍDOS" "${NC}"
echo "==================================================================="