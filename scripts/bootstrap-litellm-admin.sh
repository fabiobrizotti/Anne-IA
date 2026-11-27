#!/usr/bin/env bash
# ==============================================================================
# ANNE-IA — Bootstrap do admin local do LiteLLM (idempotente)
# ==============================================================================
# Cria o usuario proxy_admin_viewer `anneia-admin` e define sua senha a partir do .env.
# Necessario antes de manter `disable_env_credential_login: true`, pois a master
# key deixa de servir para login na UI (continua valida como Bearer da API).
#
# Uso: ./scripts/bootstrap-litellm-admin.sh [--force]
#   --force  redefine a senha mesmo se o usuario ja existir.
# ==============================================================================
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${PROJECT_ROOT}/.env}"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

for cmd in curl jq; do
  command -v "${cmd}" >/dev/null 2>&1 || { echo "[erro] ${cmd} nao encontrado" >&2; exit 1; }
done
[[ -f "${ENV_FILE}" ]] || { echo "[erro] ${ENV_FILE} nao encontrado" >&2; exit 1; }

get_val() {
  { grep -E "^$1=" "${ENV_FILE}" || true; } | head -1 | cut -d= -f2- | tr -d '\r"'
}

MASTER_KEY="$(get_val LITELLM_MASTER_KEY)"
ADMIN_PASS="$(get_val LITELLM_ADMIN_PASSWORD)"
LITELLM_PORT="$(get_val LITELLM_PORT)"
BASE="http://127.0.0.1:${LITELLM_PORT:-4000}"

if [[ -z "${MASTER_KEY}" || -z "${ADMIN_PASS}" || -z "${LITELLM_PORT}" ]]; then
  echo "[erro] LITELLM_MASTER_KEY, LITELLM_ADMIN_PASSWORD e LITELLM_PORT devem estar preenchidos" >&2
  exit 1
fi

AUTH=(-H "Authorization: Bearer ${MASTER_KEY}" -H 'Content-Type: application/json')

# Usuario ja existe? Nao imprime dados de outros usuarios. Uma falha de rede ou
# de autenticacao NAO pode ser lida como "ausente" (evita /user/new as cegas).
USER_LIST="$(curl -fsS "${BASE}/user/list" "${AUTH[@]}")" || {
  echo "[erro] falha em /user/list (gateway indisponível ou master key inválida)" >&2
  exit 1
}
if ! jq -e '[.users[]? | select(.user_id == "anneia-admin")] | length > 0' <<<"${USER_LIST}" >/dev/null 2>&1; then
  echo "Criando usuario anneia-admin (proxy_admin_viewer)..."
  NEW_PAYLOAD="$(jq -nc '{user_id:"anneia-admin", user_email:"admin@anneia.local", user_role:"proxy_admin_viewer", auto_create_key:false}')"
  if ! curl -fsS -o /dev/null -X POST "${BASE}/user/new" "${AUTH[@]}" -d "${NEW_PAYLOAD}"; then
    echo "[erro] falha em /user/new" >&2
    exit 1
  fi
  CREATED=1
else
  CREATED=0
  echo "Usuario anneia-admin ja existe."
fi

if [[ "${CREATED}" -eq 1 || "${FORCE}" -eq 1 ]]; then
  echo "Definindo senha de anneia-admin..."
  UPDATE_PAYLOAD="$(jq -nc --arg uid 'anneia-admin' --arg pw "${ADMIN_PASS}" '{user_id:$uid,password:$pw}')"
  if ! curl -fsS -o /dev/null -X POST "${BASE}/user/update" "${AUTH[@]}" -d "${UPDATE_PAYLOAD}"; then
    echo "[erro] falha em /user/update (verifique a politica de senha)" >&2
    exit 1
  fi
else
  echo "Senha preservada (use --force para redefinir a partir do .env)."
fi

echo "OK — login da UI: anneia-admin / LITELLM_ADMIN_PASSWORD (valor nao exibido)."
unset MASTER_KEY ADMIN_PASS USER_LIST NEW_PAYLOAD UPDATE_PAYLOAD
