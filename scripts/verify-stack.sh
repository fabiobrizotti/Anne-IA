#!/usr/bin/env bash
# ==============================================================================
# ANNE-IA — VERIFICAÇÃO DE SAÚDE DA STACK (SMOKE TEST)
# ==============================================================================
# Portão objetivo de "a stack está de pé e funcionando?" — usado:
#   1. Manualmente após qualquer mudança:   ./scripts/verify-stack.sh
#   2. Como gate do update:                 ./scripts/update.sh  (chama com --timeout)
#   3. Em cron/monitoração externa.
#
# Verifica, em camadas:
#   infra  -> healthcheck do Docker de cada serviço
#   rede   -> portas internas de dados (postgres/redis/rabbit) via docker exec
#   app    -> endpoints HTTP públicos de cada serviço
#   dados  -> schema de negócio (banco anneia) responde
#
# Somente leitura: não altera estado, não reinicia nada, não imprime segredos.
#
# Uso:
#   ./scripts/verify-stack.sh                 # checagem pontual
#   ./scripts/verify-stack.sh --timeout 180   # aguarda até 180s ficar saudável
#
# Saída: 0 = tudo ok | 1 = alguma verificação falhou
# ==============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"
ENV_FILE="${ENV_FILE:-${PROJECT_ROOT}/.env}"

TIMEOUT=0
REQUIRE_REVISION=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout) TIMEOUT="${2:-0}"; shift 2 ;;
    --timeout=*) TIMEOUT="${1#*=}"; shift ;;
    --require-revision) REQUIRE_REVISION=1; shift ;;
    -h|--help)
      echo "Uso: $0 [--timeout SEGUNDOS] [--require-revision]"
      echo "  --require-revision  reprova se o container não estiver no HEAD do checkout"
      exit 0 ;;
    *) echo "[erro] Argumento desconhecido: $1" >&2; exit 1 ;;
  esac
done

[[ -f "${ENV_FILE}" ]] || { echo "[erro] ${ENV_FILE} não encontrado" >&2; exit 1; }

# Lê uma chave do .env sem imprimir valores sensíveis
env_get() {
  local key="$1" default="${2:-}"
  local val
  val="$(grep -E "^${key}=" "${ENV_FILE}" | head -1 | cut -d= -f2- || true)"
  # Remove trailing comment and whitespace
  val="${val%%#*}"
  val="${val%%[[:space:]]}"
  printf '%s' "${val:-${default}}"
}

FAILS=0
CHECKS=0

ok()   { CHECKS=$((CHECKS + 1)); printf '  \033[32m[ok]\033[0m   %s\n' "$*"; }
fail() { CHECKS=$((CHECKS + 1)); FAILS=$((FAILS + 1)); printf '  \033[31m[falha]\033[0m %s\n' "$*"; }
# não conta como verificação: usado quando a checagem não se aplica (ex.: GIT_SHA
# ainda não marcado, porque o update.sh nunca rodou neste diretório).
skip() { printf '  \033[33m[skip]\033[0m  %s\n' "$*"; }
# não reprova a stack, mas sinaliza divergência (ver check_revision).
warn() { CHECKS=$((CHECKS + 1)); printf '  \033[33m[aviso]\033[0m %s\n' "$*"; }

# ------------------------------------------------------------------------------
# HEALTHCHECK DO DOCKER POR SERVIÇO
# ------------------------------------------------------------------------------
SERVICES=(db-evolution redis redis-n8n-queue rabbitmq n8n n8n-worker evolution-api 9router dashboard pgbouncer nginx)

service_state() {
  local svc="$1" id
  id="$(docker compose ps -q "${svc}" 2>/dev/null | head -1 || true)"
  [[ -z "${id}" ]] && { printf 'absent'; return; }
  docker inspect --format \
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "${id}" 2>/dev/null || printf 'unknown'
}

check_services() {
  local svc st bad=()
  for svc in "${SERVICES[@]}"; do
    st="$(service_state "${svc}")"
    case "${st}" in
      healthy|running) ok "container ${svc}: ${st}" ;;
      starting)        bad+=("${svc}:starting") ;;
      *)               bad+=("${svc}:${st}") ;;
    esac
  done
  local b
  for b in "${bad[@]:-}"; do
    [[ -z "${b}" ]] && continue
    if [[ "${b##*:}" == "absent" ]]; then
      fail "container ${b%%:*} não está em execução"
    else
      fail "container ${b%%:*} em estado '${b##*:}'"
    fi
  done
}

# ------------------------------------------------------------------------------
# CAMADA DE DADOS (via docker exec — não expõe portas nem segredos)
# ------------------------------------------------------------------------------
check_postgres() {
  local user db out
  user="$(env_get POSTGRES_USER evolution)"
  db="anneia"
  if docker compose exec -T db-evolution psql -U "${user}" -d "${db}" -tAc 'SELECT 1' >/dev/null 2>&1; then
    out="$(docker compose exec -T db-evolution psql -U "${user}" -d "${db}" -tAc \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'" 2>/dev/null | tr -d '[:space:]')"
    if [[ "${out:-0}" -ge 18 ]]; then
      ok "postgres: banco anneia responde (${out} tabelas)"
    else
      fail "postgres: banco anneia com apenas ${out:-0} tabelas (esperado >= 18) — init.sql não aplicado?"
    fi
  else
    fail "postgres: banco anneia inacessível"
  fi
}

check_redis() {
  local pass
  pass="$(env_get REDIS_PASSWORD)"
  if docker compose exec -T redis redis-cli -a "${pass}" --no-auth-warning ping 2>/dev/null | grep -q PONG; then
    ok "redis: PONG"
  else
    fail "redis: sem resposta ao PING"
  fi
}

check_redis_n8n_queue() {
  local pass
  pass="$(env_get REDIS_N8N_QUEUE_PASSWORD)"
  if docker compose exec -T redis-n8n-queue redis-cli -a "${pass}" --no-auth-warning ping 2>/dev/null | grep -q PONG; then
    ok "redis-n8n-queue: PONG (policy: $(docker compose exec -T redis-n8n-queue redis-cli -a "${pass}" --no-auth-warning INFO memory 2>/dev/null | grep maxmemory_policy | cut -d: -f2 | tr -d '\r'))"
  else
    fail "redis-n8n-queue: sem resposta ao PING"
  fi
}

check_rabbit() {
  if docker compose exec -T rabbitmq rabbitmq-diagnostics -q check_running >/dev/null 2>&1; then
    ok "rabbitmq: check_running ok"
  else
    fail "rabbitmq: check_running falhou"
  fi
}

check_pgbouncer() {
  if docker compose exec -T pgbouncer nc -z 127.0.0.1 6432 >/dev/null 2>&1; then
    ok "pgbouncer: aceitando conexões em 6432"
  else
    fail "pgbouncer: sem resposta ao nc"
  fi
}

check_nginx() {
  local nginx_port tailscale_hostname
  nginx_port="$(env_get NGINX_CONTAINER_PORT 8080)"
  tailscale_hostname="$(env_get TAILSCALE_HOSTNAME tcc-server)"
  if docker compose exec -T nginx wget -q --spider --header="Host: ${tailscale_hostname}" "http://127.0.0.1:${nginx_port}/nginx-health" >/dev/null 2>&1; then
    ok "nginx: healthy endpoint responde"
  else
    fail "nginx: healthcheck falhou"
  fi
}

# ------------------------------------------------------------------------------
# CAMADA HTTP (endpoints públicos de cada serviço)
# ------------------------------------------------------------------------------
http_ok() {
  local name="$1" url="$2" extra="${3:-}"
  local code
  # shellcheck disable=SC2086
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 8 ${extra} "${url}" 2>/dev/null)" || code="000"
  code="${code:-000}"
  if [[ "${code}" =~ ^(200|204|301|302|401)$ ]]; then
    ok "${name}: HTTP ${code}"
  else
    fail "${name}: HTTP ${code} (${url})"
  fi
}

# evolution-api não publica porta no host (isolamento de rede): testa pela rede interna
check_evolution_internal() {
  local port origin
  port="$(env_get SERVER_PORT 8080)"
  # A Evolution valida o header Origin contra o CORS_ORIGIN; usar a porta INTERNA
  # do dashboard (3000), que está na whitelist — a porta do host (41283) não está.
  origin="$(env_get DASHBOARD_CONTAINER_PORT 3000)"
  if docker compose exec -T dashboard wget -q --spider \
       --header="Origin: http://localhost:${origin}" \
       "http://evolution-api:${port}/manager/health" >/dev/null 2>&1; then
    ok "evolution: alcançável pela rede interna (dashboard -> evolution-api:${port})"
  else
    fail "evolution: inacessível pela rede interna (dashboard -> evolution-api:${port})"
  fi
}

check_http() {
  local dash_port n8n_port nine_port
  dash_port="$(env_get DASHBOARD_PORT 41283)"
  n8n_port="$(env_get N8N_PORT 5678)"
  nine_port="$(env_get NINE_ROUTER_PORT 48192)"

  http_ok "dashboard" "http://127.0.0.1:${dash_port}/api/health"
  http_ok "n8n"       "http://127.0.0.1:${n8n_port}/healthz"
  http_ok "9router"   "http://127.0.0.1:${nine_port}/api/health"
  check_evolution_internal
}

# Prova objetiva de que a stack roda o código deste checkout:
# compara o `sha` reportado por /api/health com o HEAD do repositório.
#
# Por padrão a divergência é apenas [aviso]: num clone de desenvolvimento é
# normal commitar e rodar a imagem uma revisão atrás. Com --require-revision
# (usado pelo gate do update.sh) a divergência reprova a stack — porque aí a
# pergunta é "o deploy aplicou o commit?", e a resposta precisa ser sim.
check_revision() {
  local dash_port body running expected
  dash_port="$(env_get DASHBOARD_PORT 41283)"
  body="$(curl -s -m 8 "http://127.0.0.1:${dash_port}/api/health" 2>/dev/null || true)"
  running="$(printf '%s' "${body}" | sed -n 's/.*"sha":"\([^"]*\)".*/\1/p')"

  if [[ -z "${running}" ]]; then
    fail "revisão: /api/health não informou o campo 'sha'"
    return
  fi
  if [[ "${running}" == "unknown" ]]; then
    if [[ "${REQUIRE_REVISION}" -eq 1 ]]; then
      fail "revisão: container sem GIT_SHA (deploy não carimbou a revisão)"
    else
      skip "revisão: container sem GIT_SHA (rode ./scripts/update.sh para marcar)"
    fi
    return
  fi

  expected="$(git -C "${PROJECT_ROOT}" rev-parse --short HEAD 2>/dev/null || true)"
  if [[ -z "${expected}" ]]; then
    skip "revisão: repositório git indisponível para comparar"
  elif [[ "${running}" == "${expected}" ]]; then
    ok "revisão: container em ${running} = HEAD do checkout"
  elif [[ "${REQUIRE_REVISION}" -eq 1 ]]; then
    fail "revisão: container em ${running} != HEAD ${expected} (atualização não aplicada?)"
  else
    warn "revisão: container em ${running}, HEAD ${expected} (rode ./scripts/update.sh)"
  fi
}

# ------------------------------------------------------------------------------
# EXECUÇÃO
# ------------------------------------------------------------------------------
echo "==================================================================="
echo " Anne-IA — Verificação de saúde da stack"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
[[ "${TIMEOUT}" -gt 0 ]] && echo " Aguardando até ${TIMEOUT}s por estado saudável..."
echo "==================================================================="

docker info >/dev/null 2>&1 || { echo "[erro] daemon Docker indisponível" >&2; exit 1; }

if [[ "${TIMEOUT}" -gt 0 ]]; then
  deadline=$(( $(date +%s) + TIMEOUT ))
  while :; do
    pending=0
    for svc in "${SERVICES[@]}"; do
      st="$(service_state "${svc}")"
      case "${st}" in
        healthy|running) ;;
        *) pending=1 ;;
      esac
    done
    [[ ${pending} -eq 0 ]] && break
    if [[ "$(date +%s)" -ge "${deadline}" ]]; then
      echo "[timeout] serviços ainda não saudáveis após ${TIMEOUT}s"
      break
    fi
    sleep 3
  done
fi

echo "--- containers ---"
check_services
echo "--- dados ---"
check_postgres
check_redis
check_redis_n8n_queue
check_rabbit
check_pgbouncer
check_nginx
echo "--- aplicações ---"
check_http
echo "--- revisão em execução ---"
check_revision

echo "==================================================================="
if [[ ${FAILS} -eq 0 ]]; then
  printf ' \033[32m%s\033[0m\n' "STACK SAUDÁVEL — ${CHECKS} verificações ok"
  echo "==================================================================="
  exit 0
fi
printf ' \033[31m%s\033[0m\n' "STACK COM PROBLEMAS — ${FAILS}/${CHECKS} falhas"
echo "  Dica: docker compose ps && docker compose logs --tail=50 <serviço>"
echo "==================================================================="
exit 1
