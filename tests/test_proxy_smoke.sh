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

# 7.1 Handshake WebSocket do editor (regressão: 400 "Invalid Upgrade header").
# O n8n usa a lib ws, que rejeita o upgrade quando recebe "upgrade: websocket, websocket"
# (nginx envia o header duplicado se proxy_set_header Upgrade for declarado duas vezes
# no mesmo location). curl mantém a conexão aberta após o 101, daí o timeout esperado.
push_code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 \
  -H "Host: ${TAILSCALE_HOSTNAME}" \
  -H "Upgrade: websocket" \
  -H "Connection: Upgrade" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Origin: http://${TAILSCALE_HOSTNAME}" \
  "http://127.0.0.1:${NGINX_HOST_PORT}${N8N_BASE_PATH}/rest/push?pushRef=smoke" 2>/dev/null || true)
if [[ "${push_code}" == "101" ]]; then
  ok "handshake WebSocket ${N8N_BASE_PATH}/rest/push aceito (HTTP 101 Switching Protocols)"
else
  fail "handshake ${N8N_BASE_PATH}/rest/push retornou HTTP ${push_code} (esperado 101; verifique proxy_set_header Upgrade duplicado no location)"
fi

# 7.2 Guarda estática: Upgrade/Connection vêm SÓ do snippet proxy-params.conf.
# O include não é expandido no arquivo gerado, então o location não deve redeclarar
# os headers (redeclarar => nginx envia o header duas vezes => ws do n8n responde 400).
conf_dump="$(mktemp)"
docker compose exec -T nginx cat /tmp/nginx/nginx.conf > "${conf_dump}" 2>/dev/null || true
loc_check=$(awk -v pat="location ${N8N_BASE_PATH}/" '
  inblock == 0 && index($0, pat) > 0 { inblock = 1; next }
  inblock == 1 && $1 == "}" { inblock = 0; next }
  inblock == 1 && $1 == "proxy_set_header" && ($2 == "Upgrade" || $2 == "Connection") { count++ }
  inblock == 1 && $1 == "include" && $2 ~ /proxy-params\.conf/ { has_include = 1 }
  END { print (count + 0) "," (has_include + 0) }
' "${conf_dump}")
rm -f "${conf_dump}"
snippet_ws=$(grep -cE '^proxy_set_header (Upgrade|Connection)' setup/nginx/snippets/proxy-params.conf || true)
if [[ "${loc_check}" == "0,1" ]] && [[ "${snippet_ws}" == "2" ]]; then
  ok "location ${N8N_BASE_PATH}/ herda Upgrade/Connection do snippet, sem redeclarar (sem header duplicado)"
else
  fail "location ${N8N_BASE_PATH}/ redeclara Upgrade/Connection ou não inclui o snippet (location:${loc_check}, snippet:${snippet_ws}) — esperado 0,1 e 2"
fi

# 7.3 Keepalive de upstream: exige HTTP/1.1 (no snippet) e map sem "close"
# (Connection vazio => header omitido => o pool `keepalive` dos upstreams é usado).
if grep -q '^proxy_http_version 1.1;' setup/nginx/snippets/proxy-params.conf \
  && ! grep -qE "^[[:space:]]*''[[:space:]]+close;" setup/nginx/nginx.conf.template; then
  ok "keepalive de upstream habilitado (proxy_http_version 1.1 + Connection vazio)"
else
  fail "keepalive de upstream desligado: falta 'proxy_http_version 1.1' no snippet ou o map mapeia '' para 'close'"
fi

# 7.4 Rate limit do editor: /n8n/ NÃO deve aplicar limit_req.
# O editor dispara >100 assets + REST em paralelo; a zona `api` (10r/s, burst 20)
# compartilhada com o dashboard devolvia 429 em workflows/settings. Concurrency
# fixada em 20 para não confundir com `limit_conn perip 30`.
echo "--- Rate Limit do editor n8n ---"
probe_codes="$(mktemp)"
workflows_probe='/rest/workflows?includeScopes=true&includeFolders=true&filter=%7B%7D&skip=0&take=50&sortBy=updatedAt%3Adesc'
for probe_path in "/rest/settings" "${workflows_probe}"; do
  seq 1 60 | xargs -P 20 -I{} curl -s -o /dev/null -w '%{http_code}\n' -m 10 \
    -H "Host: ${TAILSCALE_HOSTNAME}" \
    "http://127.0.0.1:${NGINX_HOST_PORT}${N8N_BASE_PATH}${probe_path}" > "${probe_codes}" 2>/dev/null || true
  total=$(wc -l < "${probe_codes}" | tr -d '[:space:]')
  blocked=$(grep -c '^429$' "${probe_codes}" || true)
  echo "  ${probe_path%%\?*}: ${total}/60 respostas, ${blocked} HTTP 429"
  [[ "${total}" -eq 60 ]] || fail "Sonda n8n ${probe_path%%\?*} incompleta (${total}/60 respostas)"
  [[ "${blocked}" -eq 0 ]] || fail "location ${N8N_BASE_PATH}/ ainda aplica limit_req: ${blocked}/60 HTTP 429 em ${probe_path%%\?*}"
done
rm -f "${probe_codes}"

conf_dump="$(mktemp)"
docker compose exec -T nginx cat /tmp/nginx/nginx.conf > "${conf_dump}" 2>/dev/null || true
loc_check=$(awk -v pat="location ${N8N_BASE_PATH}/" '
  inblock == 0 && index($0, pat) > 0 { inblock = 1; next }
  inblock == 1 && $1 == "}" { inblock = 0; next }
  inblock == 1 && $1 == "limit_req" { req++ }
  inblock == 1 && $1 == "limit_conn" && $2 == "perip" && $3 == "30;" { conn++ }
  inblock == 1 && $1 == "include" && $2 ~ /proxy-params\.conf/ { inc++ }
  END { print (req + 0) "," (conn + 0) "," (inc + 0) }
' "${conf_dump}")
rm -f "${conf_dump}"
if [[ "${loc_check}" == "0,1,1" ]]; then
  ok "location ${N8N_BASE_PATH}/ sem limit_req; limit_conn perip 30 e proxy-params preservados"
else
  fail "location ${N8N_BASE_PATH}/ deve ter 0 limit_req, limit_conn perip 30 e include do snippet (atual: ${loc_check}; esperado 0,1,1)"
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

# CORS: o node n8n-nodes-evolution-api chama a Evolution server-side SEM Origin.
# Se CORS_ORIGIN não contém "*", a v2.3.7 responde 500 "Not allowed by CORS"
# (o callback faz CORS.ORIGIN.indexOf(undefined) => -1).
# Roda de dentro do n8n para reproduzir exatamente a chamada do workflow.
cors_probe=$(docker compose exec -T n8n node -e '
  (async () => {
    try {
      const r = await fetch("http://evolution-api:8080/instance/fetchInstances", {
        headers: { apikey: process.env.AUTHENTICATION_API_KEY },
      });
      const body = await r.text();
      console.log(r.status, body.includes("Not allowed by CORS") ? "CORS_REJEITADO" : "OK");
    } catch (err) {
      console.log("ERRO", err.message);
    }
  })();
' 2>/dev/null || true)
if [[ "${cors_probe}" == "200 OK" ]]; then
  ok "Evolution aceita chamada server-side sem Origin (CORS_ORIGIN='*')"
else
  fail "Evolution rejeitou chamada sem Origin: ${cors_probe:-sem resposta} (marcar mensagens como lidas quebra com 500)"
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