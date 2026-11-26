#!/usr/bin/env bash
# ==============================================================================
# ANNE-IA — TESTE DA CONFIGURAÇÃO DO GATEWAY (LiteLLM + Langfuse)
# ==============================================================================
# Valida, sem tocar na stack de produção:
#   1. geração de segredos Base62/hex e ausência de chaves do 9Router;
#   2. padrões de privacidade/versão (OTel NO_CONTENT, ClickHouse >= 25.12);
#   3. grants do ClickHouse versionados.
#
# Uso: ./tests/test_gateway_env.sh
# ==============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_EXAMPLE="${PROJECT_ROOT}/.env.example"
GRANTS_SQL="${PROJECT_ROOT}/setup/clickhouse/init.sql"
TMP_DIR="$(mktemp -d)"
FAILS=0

cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

say() { printf '%s\n' "$*"; }
ok()  { printf '  \033[32m[OK]\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m[FALHA]\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }

assert_eq() { # descricao esperado obtido
  if [[ "$3" == "$2" ]]; then ok "$1"; else bad "$1 (obtido: ${3:-vazio}, esperado: $2)"; fi
}

assert_match() { # descricao regex valor
  if [[ "$3" =~ $2 ]]; then ok "$1"; else bad "$1 (valor fora do formato)"; fi
}

assert_file_has() { # descricao needle arquivo
  if grep -qF -- "$2" "$3" 2>/dev/null; then ok "$1"; else bad "$1 (trecho ausente: $2)"; fi
}

assert_no_match() { # descricao regex arquivo
  if grep -qE "$2" "$3" 2>/dev/null; then bad "$1"; else ok "$1"; fi
}

say "==================================================================="
say " Anne-IA — Teste de configuração LiteLLM + Langfuse"
say "==================================================================="

[[ -f "${ENV_EXAMPLE}" ]] || { say "[erro] ${ENV_EXAMPLE} não encontrado"; exit 1; }

say "[1/4] Gerando segredos em .env temporário..."
TMP_ENV="${TMP_DIR}/.env"
: > "${TMP_ENV}"
ANNE_SYNCED=1 "${PROJECT_ROOT}/scripts/generate-passwords.sh" "${TMP_ENV}" > "${TMP_DIR}/gen.log" 2>&1 ||
  { bad "generate-passwords.sh falhou"; cat "${TMP_DIR}/gen.log"; exit 1; }
ok "Gerador executado sem erro (arquivo temporário)"

get_val() { # variavel [arquivo]
  { grep -E "^$1=" "${2:-${TMP_ENV}}" || true; } | head -1 | cut -d= -f2-
}

for var in \
  LITELLM_MASTER_KEY LITELLM_SALT_KEY LITELLM_DB_PASSWORD CHAVE_LITELLM_DB_PASSWORD \
  LANGFUSE_DB_PASSWORD CHAVE_LANGFUSE_DB_PASSWORD LANGFUSE_NEXTAUTH_SECRET \
  LANGFUSE_SALT LANGFUSE_MINIO_ROOT_PASSWORD CLICKHOUSE_PASSWORD LANGFUSE_REDIS_PASSWORD
do
  assert_match "Segredo Base62 de 32 chars: ${var}" '^[A-Za-z0-9]{32}$' "$(get_val "${var}")"
done
assert_match "LANGFUSE_ENCRYPTION_KEY em hex de 32 bytes" '^[0-9a-f]{64}$' "$(get_val LANGFUSE_ENCRYPTION_KEY)"

say "[2/4] Verificando remoção do 9Router..."
assert_no_match "Nenhuma chave NINE_ROUTER_ no .env.example" '^NINE_ROUTER_' "${ENV_EXAMPLE}"
assert_no_match "Nenhum segredo 9Router no .env gerado" '^NINE_ROUTER_|^CHAVE_NINE_ROUTER_' "${TMP_ENV}"

say "[3/4] Políticas de privacidade e versão..."
assert_file_has "OTel captura de mensagens desligada por padrão" \
  'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT' "${ENV_EXAMPLE}"
CH_VERSION="$(get_val CLICKHOUSE_VERSION "${ENV_EXAMPLE}")"
FLOOR="$(printf '%s\n%s\n' '25.12' "${CH_VERSION:-0}" | sort -V | head -1)"
assert_eq "ClickHouse >= 25.12 (atual: ${CH_VERSION:-vazio})" '25.12' "${FLOOR}"
assert_file_has "Grants de merge control do ClickHouse versionados" 'SYSTEM MERGES' "${GRANTS_SQL}"

say "[4/4] Resultado final..."
if [[ ${FAILS} -eq 0 ]]; then
  printf ' \033[32m%s\033[0m\n' 'SUCESSO — configuração do gateway válida.'
  exit 0
fi
printf ' \033[31m%s\033[0m\n' "FALHOU — ${FAILS} verificação(ões) com problema."
exit 1
