#!/usr/bin/env bash
# ==============================================================================
# ANNE-IA — TESTE DA CONFIGURAÇÃO DO GATEWAY (LiteLLM + Langfuse)
# ==============================================================================
# Valida, sem tocar na stack de produção:
#   1. geração de segredos Base62/hex e ausência de chaves do 9Router;
#   2. padrões de privacidade/versão (OTel NO_CONTENT, ClickHouse >= 25.12);
#   3. grants do ClickHouse versionados;
#   4. serviços do Compose e ausência de segredos no compose versionado;
#   5. documentação operacional (README) alinhada ao gateway e ao Strix.
#
# Uso: ./tests/test_gateway_env.sh
# ==============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_EXAMPLE="${PROJECT_ROOT}/.env.example"
GRANTS_SQL="${PROJECT_ROOT}/setup/clickhouse/init.sql"
TMP_DIR="$(mktemp -d)"
FAILS=0

TMP_COMPOSE_ENV="${PROJECT_ROOT}/.env.test-gateway-tmp"
cleanup() { rm -rf "${TMP_DIR}" "${TMP_COMPOSE_ENV}"; }
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

# Para valores secretos: nao imprime a needle mesmo quando a checagem falha.
assert_file_has_quiet() { # descricao needle arquivo
  if grep -qF -- "$2" "$3" 2>/dev/null; then ok "$1"; else bad "$1 (trecho ausente, não exibido)"; fi
}

say "==================================================================="
say " Anne-IA — Teste de configuração LiteLLM + Langfuse"
say "==================================================================="

[[ -f "${ENV_EXAMPLE}" ]] || { say "[erro] ${ENV_EXAMPLE} não encontrado"; exit 1; }

# Variáveis exportadas no shell têm precedência sobre `--env-file` no Compose.
# Sem isto, um override local (ex.: N8N_VERSION=2.47.7) invalida o teste.
while IFS='=' read -r env_key _; do
  case "${env_key}" in ''|\#*) continue ;; esac
  unset "${env_key}"
done < "${ENV_EXAMPLE}"

say "[1/6] Gerando segredos em .env temporário..."
TMP_ENV="${TMP_DIR}/.env"
cp "${ENV_EXAMPLE}" "${TMP_ENV}"
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
# Política do LiteLLM exige caractere especial; senha não vai em URI.
assert_match "LITELLM_ADMIN_PASSWORD Base62+special" '^[A-Za-z0-9]{31}!$' "$(get_val LITELLM_ADMIN_PASSWORD)"

say "[2/6] Verificando remoção do 9Router..."
assert_no_match "Nenhuma chave NINE_ROUTER_ no .env.example" '^NINE_ROUTER_' "${ENV_EXAMPLE}"
assert_no_match "Nenhum segredo 9Router no .env gerado" '^NINE_ROUTER_|^CHAVE_NINE_ROUTER_' "${TMP_ENV}"

say "[3/6] Políticas de privacidade e versão..."
assert_file_has "OTel captura de mensagens desligada por padrão" \
  'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT' "${ENV_EXAMPLE}"
CH_VERSION="$(get_val CLICKHOUSE_VERSION "${ENV_EXAMPLE}")"
FLOOR="$(printf '%s\n%s\n' '25.12' "${CH_VERSION:-0}" | sort -V | head -1)"
assert_eq "ClickHouse >= 25.12 (atual: ${CH_VERSION:-vazio})" '25.12' "${FLOOR}"
assert_file_has "Grants de merge control do ClickHouse versionados" 'SYSTEM MERGES' "${GRANTS_SQL}"
assert_match "MinIO pinado por digest" '^sha256:[0-9a-f]{64}$' "$(get_val MINIO_VERSION "${ENV_EXAMPLE}")"
assert_file_has "Registry e digest do MinIO parametrizados no compose" 'image: ${MINIO_IMAGE}@${MINIO_VERSION}' "${PROJECT_ROOT}/docker-compose.yml"
assert_no_match "Nenhuma referência ao repo removido minio/minio" 'minio/minio' "${ENV_EXAMPLE}"

# Uma única versão em todo o artefato: .env (imagem + /api/health), package.json,
# footer/cache-buster do HTML e CHANGELOG. Deriva impedem o deploy de reportar
# uma versão antiga e reaproveitar JS em cache.
DASH_VERSION="$(get_val DASHBOARD_VERSION "${ENV_EXAMPLE}")"
PKG_VERSION="$(node -p "require('${PROJECT_ROOT}/dashboard/package.json').version" 2>/dev/null || true)"
assert_eq "DASHBOARD_VERSION = package.json" "${DASH_VERSION}" "${PKG_VERSION}"
assert_file_has "Footer do dashboard usa a versão atual" "Anne-IA v${DASH_VERSION}" "${PROJECT_ROOT}/dashboard/public/index.html"
assert_file_has "Cache-buster do app.js usa a versão atual" "app.js?v=${DASH_VERSION}" "${PROJECT_ROOT}/dashboard/public/index.html"
assert_file_has "README documenta a versão atual em /api/health" "\"version\": \"${DASH_VERSION}\"" "${PROJECT_ROOT}/README.md"
assert_file_has "CHANGELOG registra a versão atual" "## [${DASH_VERSION}]" "${PROJECT_ROOT}/CHANGELOG.md"

say "[4/6] Configuração do Compose..."
assert_file_has "PgBouncer expõe database litellm" \
  'litellm = host=${POSTGRES_HOST} port=${POSTGRES_PORT} dbname=litellm pool_mode=transaction pool_size=5' \
  "${PROJECT_ROOT}/setup/pgbouncer/pgbouncer.ini.template"
cat "${TMP_ENV}" > "${TMP_COMPOSE_ENV}"
docker compose --env-file "${TMP_COMPOSE_ENV}" config --services > "${TMP_DIR}/services.txt" 2> "${TMP_DIR}/compose.err" ||
  { bad "docker compose config --services falhou"; head -20 "${TMP_DIR}/compose.err"; }
for svc in litellm langfuse-web langfuse-worker clickhouse minio langfuse-redis; do
  atual="$({ grep -x "${svc}" "${TMP_DIR}/services.txt" || true; } | head -1)"
  assert_eq "Serviço ${svc} presente" "${svc}" "${atual}"
done
assert_eq "Serviço 9router removido" '' "$({ grep -x '9router' "${TMP_DIR}/services.txt" || true; } | head -1)"
assert_no_match "Nenhuma referência a 9Router no compose" '9router|NINE_ROUTER' "${PROJECT_ROOT}/docker-compose.yml"

docker compose --env-file "${TMP_COMPOSE_ENV}" config > "${TMP_DIR}/compose.config" 2> "${TMP_DIR}/compose.err" ||
  { bad "docker compose config falhou"; head -20 "${TMP_DIR}/compose.err"; }
COMPOSE_JSON="$(docker compose --env-file "${TMP_COMPOSE_ENV}" config --format json 2>/dev/null)"
for svc in litellm langfuse-web; do
  # data_net é internal: sem public_net o Docker descarta a publicação da porta no host.
  if python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if "public_net" in d["services"][sys.argv[1]].get("networks",{}) else 1)' "$svc" <<< "${COMPOSE_JSON}"; then
    ok "Serviço ${svc} publica porta no host via public_net"
  else
    bad "Serviço ${svc} sem public_net (porta do host não seria publicada)"
  fi
done
# Langfuse v4 web (Next.js 16) precisa de heap > ~430MB no boot; 768m no cgroup
# limitava o V8 a 432MB e derrubava o container em loop (OOM).
if python3 -c 'import json,sys; d=json.load(sys.stdin); m=int(d["services"]["langfuse-web"]["deploy"]["resources"]["limits"]["memory"]); sys.exit(0 if m >= 1536*1024*1024 else 1)' <<< "${COMPOSE_JSON}"; then
  ok "Langfuse web com memória >= 1536m (evita OOM do V8 no boot)"
else
  bad "Langfuse web com memória insuficiente (< 1536m)"
fi
assert_file_has "LITELLM_URL resolvido no compose" 'LITELLM_URL: http://litellm:4000/v1' "${TMP_DIR}/compose.config"
# Compara sem imprimir a master key (mesmo em caso de falha).
expected_master="$(get_val LITELLM_MASTER_KEY)"
assert_file_has_quiet "Master key resolvida no compose" \
  "LITELLM_MASTER_KEY: ${expected_master}" "${TMP_DIR}/compose.config"
assert_file_has_quiet "Dashboard usa a master key como LITELLM_API_KEY" \
  "LITELLM_API_KEY: ${expected_master}" "${TMP_DIR}/compose.config"
assert_file_has "Dashboard lê o spend via pgbouncer/litellm" \
  'LITELLM_DATABASE_URL: postgresql://pgbouncer_app:${CHAVE_PGBOUNCER_PASSWORD}@pgbouncer:${PGBOUNCER_CONTAINER_PORT}/litellm' \
  "${PROJECT_ROOT}/docker-compose.yml"
# Sem PGOPTIONS no db-evolution, init.sql cria litellm/langfuse/pgbouncer_app com
# 'changeme' no boot limpo e os gateways não conectam.
assert_file_has "db-evolution recebe PGOPTIONS com as 3 senhas do .env" \
  'PGOPTIONS: "-c app.litellm_password=${CHAVE_LITELLM_DB_PASSWORD} -c app.langfuse_password=${CHAVE_LANGFUSE_DB_PASSWORD} -c app.pgbouncer_password=${PGBOUNCER_PASSWORD}"' \
  "${PROJECT_ROOT}/docker-compose.yml"
assert_no_match "Nenhuma senha 'changeme' no compose" 'changeme' "${PROJECT_ROOT}/docker-compose.yml"
assert_file_has ".env.example documenta a URL derivada do gateway" \
  'LITELLM_DATABASE_URL' "${ENV_EXAMPLE}"

# Variáveis exportadas no shell têm precedência sobre o .env na interpolação do
# Compose. Se LANGFUSE_HOST vier poluído (placeholder literal), o LiteLLM monta
# um endpoint OTEL inválido e os spans nunca chegam ao Langfuse. O valor do
# LiteLLM deve vir do .env via env_file, sem override explícito no compose.
POLLUTED_LANGFUSE_HOST='http://langfuse-web:${LANGFUSE_CONTAINER_PORT}'
resolved_host="$(
  LANGFUSE_HOST="${POLLUTED_LANGFUSE_HOST}" docker compose --env-file "${TMP_COMPOSE_ENV}" config --format json 2>/dev/null |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["litellm"]["environment"].get("LANGFUSE_HOST", ""))'
)"
assert_eq "LiteLLM resolve LANGFUSE_HOST do .env mesmo com override no shell" \
  "$(get_val LANGFUSE_HOST "${TMP_ENV}")" "${resolved_host}"

# Compose não expande placeholder aninhado em valor lido do .env.
assert_no_match "Nenhum placeholder aninhado no compose resolvido" '\$\$\{' "${TMP_DIR}/compose.config"
for var in LITELLM_URL LANGFUSE_HOST LANGFUSE_NEXTAUTH_URL LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT; do
  assert_no_match "Valor literal em .env.example: ${var}" "^${var}=.*\\\$\\{" "${ENV_EXAMPLE}"
done
assert_eq "n8n pinado em versão compatível com configVersion=2" '2.49.7' "$(get_val N8N_VERSION "${ENV_EXAMPLE}")"
assert_file_has "Imagem do n8n resolvida para 2.49.7" 'n8nio/n8n:2.49.7' "${TMP_DIR}/compose.config"
assert_file_has "Fallback de credenciais do LiteLLM desativado" 'disable_env_credential_login: true' "${PROJECT_ROOT}/setup/litellm/config.yaml"
assert_file_has "LiteLLM persiste modelos no banco" 'store_model_in_db: true' "${PROJECT_ROOT}/setup/litellm/config.yaml"
assert_file_has "UI do LiteLLM em modo somente leitura" 'ui_access_mode: "admin_only"' "${PROJECT_ROOT}/setup/litellm/config.yaml"
assert_file_has "Bootstrap cria o admin como proxy_admin_viewer" 'user_role:"proxy_admin_viewer"' "${PROJECT_ROOT}/scripts/bootstrap-litellm-admin.sh"
assert_no_match "Bootstrap não concede proxy_admin com permissão total" 'user_role:"proxy_admin"' "${PROJECT_ROOT}/scripts/bootstrap-litellm-admin.sh"
if [[ -x "${PROJECT_ROOT}/scripts/bootstrap-litellm-admin.sh" ]] \
  && grep -q '/user/new' "${PROJECT_ROOT}/scripts/bootstrap-litellm-admin.sh" \
  && grep -q '/user/update' "${PROJECT_ROOT}/scripts/bootstrap-litellm-admin.sh"; then
  ok "Bootstrap idempotente do admin do LiteLLM presente e executável"
else
  bad "Bootstrap do admin do LiteLLM ausente ou incompleto"
fi

# O compose versionado e o resultado interpolado não podem conter segredos literais.
for var in LITELLM_MASTER_KEY LITELLM_SALT_KEY LITELLM_DB_PASSWORD CLICKHOUSE_PASSWORD LANGFUSE_REDIS_PASSWORD; do
  secret="$(get_val "${var}")"
  if [[ -n "${secret}" ]] && grep -qF -- "${secret}" "${PROJECT_ROOT}/docker-compose.yml" 2>/dev/null; then
    bad "Segredo ${var} vazou no docker-compose.yml"
  else
    ok "Segredo ${var} ausente no docker-compose.yml"
  fi
done

# O pool do gateway precisa tolerar o handshake frio do PgBouncer no boot do CI.
assert_file_has "Pool do gateway usa timeout de conexão tolerante ao boot" \
  'connectionTimeoutMillis: 10000' "${PROJECT_ROOT}/dashboard/src/server.js"

# O userlist do PgBouncer é gerado em /run/pgbouncer no boot; versioná-lo vaza
# as senhas reais do .env (o entrypoint aponta o auth_file para /run).
if git -C "${PROJECT_ROOT}" ls-files --error-unmatch setup/pgbouncer/userlist.txt >/dev/null 2>&1; then
  bad "userlist.txt do PgBouncer está versionado"
else
  ok "userlist.txt do PgBouncer não está versionado"
fi
if git -C "${PROJECT_ROOT}" check-ignore -q setup/pgbouncer/userlist.txt; then
  ok "userlist.txt do PgBouncer é ignorado pelo git"
else
  bad "userlist.txt do PgBouncer não é ignorado pelo git"
fi

say "[5/6] Documentação operacional..."
README="${PROJECT_ROOT}/README.md"
assert_file_has "README documenta fail-closed do financeiro" \
  '/api/v1/financeiro` retorna `503' "${README}"
assert_file_has "README documenta o gateway para o Strix no host" \
  'http://127.0.0.1:${LITELLM_PORT}/v1' "${README}"
# A seção 5 é a do roteamento de IA; 9Router pode aparecer apenas como
# exceção histórica (valor legado do CHECK ou data/ preservado).
ia_section="$(sed -n '/^## 5\. /,/^## 6\. /p' "${README}")"
if grep -qiE '9router|NINE_ROUTER' <<< "${ia_section}"; then
  bad "Seção 5 ainda cita 9Router como serviço ativo"
else
  ok "Seção 5 não cita 9Router como serviço ativo"
fi

say "[6/6] Resultado final..."
if [[ ${FAILS} -eq 0 ]]; then
  printf ' \033[32m%s\033[0m\n' 'SUCESSO — configuração do gateway válida.'
  exit 0
fi
printf ' \033[31m%s\033[0m\n' "FALHOU — ${FAILS} verificação(ões) com problema."
exit 1
