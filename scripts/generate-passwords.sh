#!/usr/bin/env bash
# ==============================================================================
# ANNE-IA — GERADOR DE SENHAS FORTES (.env)
# ==============================================================================
# Gera senhas criptograficamente seguras em Base62 ([A-Za-z0-9]) com tamanho
# padrão de 32 caracteres, sem caracteres especiais (evitando falhas em URIs,
# expansão do docker-compose ou comandos sed).
#
# Idempotente e não-destrutivo:
# - Se o .env não existir, cria a partir do .env.example.
# - Preserva integralmente qualquer senha já preenchida no .env.
# - Sincroniza automaticamente pares de variáveis espelhadas (ex: CHAVE_*).
# ==============================================================================

set -euo pipefail

# Diretório raiz do projeto
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-${PROJECT_ROOT}/.env}"
ENV_EXAMPLE="${PROJECT_ROOT}/.env.example"

# ------------------------------------------------------------------------------
# CONFIGURAÇÃO DE CAMPOS E TAMANHOS
# ------------------------------------------------------------------------------
# Tamanho padrão de caracteres para novas senhas
DEFAULT_LENGTH=32

# Lista de variáveis a serem preenchidas se estiverem vazias.
# Formato: "NOME_VARIAVEL" ou "NOME_VARIAVEL:TAMANHO"
PASSWORD_FIELDS=(
  "POSTGRES_PASSWORD"
  "REDIS_PASSWORD"
  "RABBITMQ_DEFAULT_PASS"
  "NINE_ROUTER_PASSWORD"
  "N8N_ENCRYPTION_KEY"
  "AUTHENTICATION_API_KEY"
  "PGADMIN_DEFAULT_PASSWORD"
)

# Pares de variáveis espelhadas que devem possuir o mesmo valor.
# Formato: "VAR_ESPELHO:VAR_ORIGEM"
SYNC_PAIRS=(
  "CHAVE_POSTGRES_PASSWORD:POSTGRES_PASSWORD"
  "CHAVE_REDIS_PASSWORD:REDIS_PASSWORD"
  "CHAVE_RABBITMQ_DEFAULT_PASS:RABBITMQ_DEFAULT_PASS"
  "CHAVE_NINE_ROUTER_PASSWORD:NINE_ROUTER_PASSWORD"
)

# ------------------------------------------------------------------------------
# FUNÇÕES AUXILIARES
# ------------------------------------------------------------------------------

# Gera string aleatória segura contendo apenas [A-Za-z0-9]
generate_password() {
  local len="${1:-${DEFAULT_LENGTH}}"
  # LC_ALL=C garante leitura correta de bytes em /dev/urandom sem falha de locale
  # '|| true' evita encerramento precoce por SIGPIPE (código 141) sob pipefail quando head fecha o pipe
  (LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom || true) | head -c "${len}"
}

# Obtém o valor atual de uma variável no arquivo .env
get_env_val() {
  local var_name="$1"
  local file="$2"
  if [[ ! -f "${file}" ]]; then
    echo ""
    return
  fi
  # Lê o valor após o primeiro '=' ignorando comentários e espaços
  local val
  val=$(grep -E "^${var_name}=" "${file}" 2>/dev/null | head -n 1 | cut -d'=' -f2- || true)
  # Remove aspas simples ou duplas externas se houver
  val="${val%\"}"
  val="${val#\"}"
  val="${val%\'}"
  val="${val#\'}"
  echo "${val}"
}

# Atualiza ou insere uma variável no arquivo .env preservando a formatação
set_env_val() {
  local var_name="$1"
  local var_val="$2"
  local file="$3"

  local tmp_file
  tmp_file=$(mktemp)

  if grep -q -E "^${var_name}=" "${file}" 2>/dev/null; then
    # Substitui a linha existente mantendo as demais intactas
    awk -v var="${var_name}" -v val="${var_val}" '
      $0 ~ "^" var "=" {
        print var "=" val
        next
      }
      { print }
    ' "${file}" > "${tmp_file}"
  else
    # Se a variável não existir no arquivo, adiciona no final
    cat "${file}" > "${tmp_file}"
    echo "${var_name}=${var_val}" >> "${tmp_file}"
  fi

  mv "${tmp_file}" "${file}"
}

# ------------------------------------------------------------------------------
# FLUXO PRINCIPAL
# ------------------------------------------------------------------------------

# Se invocado diretamente, delega ao sync-env.sh para garantir reconciliação de schema
if [[ "${ANNE_SYNCED:-0}" != "1" && -x "${PROJECT_ROOT}/scripts/sync-env.sh" ]]; then
  exec "${PROJECT_ROOT}/scripts/sync-env.sh" "${ENV_FILE}"
fi

echo "==================================================================="
echo "  Anne-IA — Provisionamento Seguro de Senhas (.env)"
echo "==================================================================="

# 1. Garante existência do .env
if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ -f "${ENV_EXAMPLE}" ]]; then
    echo "[init] .env não encontrado. Criando cópia a partir de .env.example..."
    cp "${ENV_EXAMPLE}" "${ENV_FILE}"
  else
    echo "[erro] .env.example não encontrado em ${ENV_EXAMPLE}." >&2
    exit 1
  fi
else
  echo "[ok] .env existente detectado em: ${ENV_FILE}"
fi

count_generated=0
count_preserved=0
count_synced=0

# 2. Processa variáveis principais
for entry in "${PASSWORD_FIELDS[@]}"; do
  var_name="${entry%%:*}"
  if [[ "${entry}" =~ : ]]; then
    var_len="${entry##*:}"
  else
    var_len="${DEFAULT_LENGTH}"
  fi

  current_val=$(get_env_val "${var_name}" "${ENV_FILE}")

  if [[ -z "${current_val}" ]]; then
    new_pass=$(generate_password "${var_len}")
    set_env_val "${var_name}" "${new_pass}" "${ENV_FILE}"
    echo "[gerada]  ${var_name} (${var_len} chars)"
    count_generated=$((count_generated + 1))
  else
    echo "[mantida] ${var_name} (já preenchida)"
    count_preserved=$((count_preserved + 1))
  fi
done

# 3. Sincroniza pares espelhados (CHAVE_* <-> SENHA_PRINCIPAL)
for pair in "${SYNC_PAIRS[@]}"; do
  mirror_var="${pair%%:*}"
  source_var="${pair##*:}"

  mirror_val=$(get_env_val "${mirror_var}" "${ENV_FILE}")
  source_val=$(get_env_val "${source_var}" "${ENV_FILE}")

  if [[ -n "${source_val}" && -z "${mirror_val}" ]]; then
    set_env_val "${mirror_var}" "${source_val}" "${ENV_FILE}"
    echo "[sincronizada] ${mirror_var} <- ${source_var}"
    count_synced=$((count_synced + 1))
  elif [[ -z "${source_val}" && -n "${mirror_val}" ]]; then
    set_env_val "${source_var}" "${mirror_val}" "${ENV_FILE}"
    echo "[sincronizada] ${source_var} <- ${mirror_var}"
    count_synced=$((count_synced + 1))
  elif [[ -z "${source_val}" && -z "${mirror_val}" ]]; then
    # Ambas vazias: gera uma nova senha e atribui a ambas
    new_pass=$(generate_password "${DEFAULT_LENGTH}")
    set_env_val "${source_var}" "${new_pass}" "${ENV_FILE}"
    set_env_val "${mirror_var}" "${new_pass}" "${ENV_FILE}"
    echo "[gerada+sincronizada] ${source_var} & ${mirror_var} (${DEFAULT_LENGTH} chars)"
    count_generated=$((count_generated + 1))
    count_synced=$((count_synced + 1))
  else
    # Ambas já possuem valor
    if [[ "${source_val}" != "${mirror_val}" ]]; then
      echo "[aviso] ${mirror_var} e ${source_var} possuem valores diferentes no .env!"
    else
      echo "[mantida] ${mirror_var} (sincronizada com ${source_var})"
      count_preserved=$((count_preserved + 1))
    fi
  fi
done

echo "-------------------------------------------------------------------"
echo "Resumo: ${count_generated} gerada(s), ${count_preserved} mantida(s), ${count_synced} sincronizada(s)."
echo "Arquivo: ${ENV_FILE}"
echo "==================================================================="
