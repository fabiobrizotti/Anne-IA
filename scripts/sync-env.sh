#!/usr/bin/env bash
# ==============================================================================
# ANNE-IA — SINCRONIZAÇÃO E AUDITORIA DE AMBIENTE (.env <-> .env.example)
# ==============================================================================
# Sincroniza o arquivo .env a partir do schema mestre .env.example:
# 1. Idempotente e não-destrutivo: NUNCA sobrescreve valores ou senhas já definidos.
# 2. Adiciona chaves novas do .env.example preservando comentários e seções.
# 3. Preserva variáveis locais órfãs (definidas apenas no .env).
# 4. Exibe relatório semântico de diferenças (valores divergentes, chaves novas, órfãs).
# 5. Máscara de segurança para credenciais e chaves criptográficas no diff.
# 6. Escrita atômica com backup automático (.env.bak) e permissão chmod 600.
# 7. Dispara provisionamento de senhas Base62 para variáveis vazias.
#
# Uso:
#   ./scripts/sync-env.sh          # Sincroniza, gera senhas e audita
#   ./scripts/sync-env.sh --diff   # Modo leitura: audita divergências sem alterar arquivos
#   ./scripts/sync-env.sh --help   # Exibe instruções de uso
# ==============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${PROJECT_ROOT}/.env}"
ENV_EXAMPLE="${ENV_EXAMPLE:-${PROJECT_ROOT}/.env.example}"

MODE="sync" # "sync" ou "diff"

for arg in "$@"; do
  case "${arg}" in
    --diff|-d|--check|-c)
      MODE="diff"
      ;;
    --help|-h)
      echo "Uso: $0 [--diff|--check|-d|-c] [--help|-h]"
      echo ""
      echo "Opções:"
      echo "  (sem argumentos)  Sincroniza .env com .env.example, gera senhas e exibe auditoria."
      echo "  --diff, -d        Apenas compara .env e .env.example sem modificar arquivos."
      echo "  --help, -h        Exibe esta mensagem de ajuda."
      exit 0
      ;;
    *)
      if [[ -f "${arg}" ]]; then
        ENV_FILE="${arg}"
      else
        echo "[erro] Argumento desconhecido: ${arg}" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ ! -f "${ENV_EXAMPLE}" ]]; then
  echo "[erro] Arquivo mestre ${ENV_EXAMPLE} não encontrado!" >&2
  exit 1
fi

echo "==================================================================="
echo "  Anne-IA — Sincronização & Auditoria de Ambiente (.env)"
echo "==================================================================="

# Se .env não existir e estiver em modo sync, inicia a partir do example
if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ "${MODE}" == "diff" ]]; then
    echo "[aviso] Arquivo .env não existe. Todas as chaves do .env.example constam como ausentes."
  else
    echo "[init] .env não encontrado. Inicializando cópia a partir de .env.example..."
    cp "${ENV_EXAMPLE}" "${ENV_FILE}"
    chmod 600 "${ENV_FILE}"
  fi
fi

# ------------------------------------------------------------------------------
# PARSER DE ARQUIVOS .ENV (POSIX/BASH PURO)
# ------------------------------------------------------------------------------
declare -A ENV_VARS=()
declare -A EXAMPLE_VARS=()
declare -a EXAMPLE_KEYS_ORDER=()
declare -a ENV_KEYS_ORDER=()

# Carrega chaves do .env se existir
if [[ -f "${ENV_FILE}" ]]; then
  while IFS= read -r line || [[ -n "${line}" ]]; do
    # Linhas com KEY=VAL (ignora comentários e linhas vazias)
    if [[ "${line}" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      val="${BASH_REMATCH[2]}"
      # Remove aspas externas para comparação limpa
      clean_val="${val%\"}"
      clean_val="${clean_val#\"}"
      clean_val="${clean_val%\'}"
      clean_val="${clean_val#\'}"
      ENV_VARS["${key}"]="${val}" # Mantém original com formatação para gravação
      ENV_KEYS_ORDER+=("${key}")
    fi
  done < "${ENV_FILE}"
fi

# Carrega chaves do .env.example
while IFS= read -r line || [[ -n "${line}" ]]; do
  if [[ "${line}" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
    key="${BASH_REMATCH[1]}"
    val="${BASH_REMATCH[2]}"
    EXAMPLE_VARS["${key}"]="${val}"
    EXAMPLE_KEYS_ORDER+=("${key}")
  fi
done < "${ENV_EXAMPLE}"

# ------------------------------------------------------------------------------
# CLASSIFICAÇÃO DE VARIÁVEIS SENSÍVEIS (MÁSCARA NO DIFF)
# ------------------------------------------------------------------------------
is_sensitive_key() {
  local k="$1"
  case "${k}" in
    *PASS*|*PASSWORD*|*SECRET*|*KEY*|*TOKEN*|*CREDENTIAL*|*HASH*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# ------------------------------------------------------------------------------
# ANÁLISE DE DIFERENÇAS (DIFF SEMÂNTICO)
# ------------------------------------------------------------------------------
declare -a MISSING_KEYS=()
declare -a ORPHAN_KEYS=()
declare -a VALUE_DIFFS=()

# 1. Chaves presentes no .env.example
for key in "${EXAMPLE_KEYS_ORDER[@]}"; do
  if [[ ! -v ENV_VARS["${key}"] ]]; then
    MISSING_KEYS+=("${key}")
  else
    env_v="${ENV_VARS[${key}]}"
    ex_v="${EXAMPLE_VARS[${key}]}"

    # Limpa aspas para comparação de valor real
    clean_env_v="${env_v%\"}"
    clean_env_v="${clean_env_v#\"}"
    clean_env_v="${clean_env_v%\'}"
    clean_env_v="${clean_env_v#\'}"

    clean_ex_v="${ex_v%\"}"
    clean_ex_v="${clean_ex_v#\"}"
    clean_ex_v="${clean_ex_v%\'}"
    clean_ex_v="${clean_ex_v#\'}"

    if [[ "${clean_env_v}" != "${clean_ex_v}" ]]; then
      if is_sensitive_key "${key}"; then
        VALUE_DIFFS+=("${key}|[SEGREDO_CUSTOMIZADO]|${clean_ex_v:-<vazio>}")
      else
        VALUE_DIFFS+=("${key}|${clean_env_v:-<vazio>}|${clean_ex_v:-<vazio>}")
      fi
    fi
  fi
done

# 2. Chaves órfãs presentes no .env mas não no .env.example
for key in "${ENV_KEYS_ORDER[@]}"; do
  if [[ ! -v EXAMPLE_VARS["${key}"] ]]; then
    ORPHAN_KEYS+=("${key}")
  fi
done

# ------------------------------------------------------------------------------
# EXIBIÇÃO DO RELATÓRIO DE AUDITORIA / DIFF
# ------------------------------------------------------------------------------
echo "Status do Ambiente:"
echo "  - Total de chaves no .env.example : ${#EXAMPLE_KEYS_ORDER[@]}"
echo "  - Total de chaves no .env         : ${#ENV_KEYS_ORDER[@]}"
echo "  - Chaves novas/ausentes no .env   : ${#MISSING_KEYS[@]}"
echo "  - Chaves locais órfãs no .env     : ${#ORPHAN_KEYS[@]}"
echo "  - Divergências de valor           : ${#VALUE_DIFFS[@]}"
echo "-------------------------------------------------------------------"

if [[ ${#MISSING_KEYS[@]} -gt 0 ]]; then
  echo "Chaves presentes no .env.example e ausentes no .env:"
  for k in "${MISSING_KEYS[@]}"; do
    echo "  [+] ${k}=${EXAMPLE_VARS[${k}]}"
  done
  echo "-------------------------------------------------------------------"
fi

if [[ ${#ORPHAN_KEYS[@]} -gt 0 ]]; then
  echo "Chaves locais detectadas no .env (não listadas no .env.example):"
  for k in "${ORPHAN_KEYS[@]}"; do
    if is_sensitive_key "${k}"; then
      echo "  [?] ${k}=[VALOR_CUSTOMIZADO_OCULTO]"
    else
      echo "  [?] ${k}=${ENV_VARS[${k}]}"
    fi
  done
  echo "-------------------------------------------------------------------"
fi

if [[ ${#VALUE_DIFFS[@]} -gt 0 ]]; then
  echo "Divergências de valor (.env vs padrão .env.example):"
  for diff in "${VALUE_DIFFS[@]}"; do
    IFS='|' read -r k env_val ex_val <<< "${diff}"
    printf "  [*] %-32s : '%s' (.env) != '%s' (.example)\n" "${k}" "${env_val}" "${ex_val}"
  done
  echo "-------------------------------------------------------------------"
fi

# Se estiver em modo diff apenas, encerra aqui
if [[ "${MODE}" == "diff" ]]; then
  echo "[diff] Modo de auditoria finalizado. Nenhuma alteração foi realizada."
  echo "==================================================================="
  exit 0
fi

# ------------------------------------------------------------------------------
# RECONCILIAÇÃO E ESCRITA ATÔMICA
# ------------------------------------------------------------------------------
# Cria backup com segurança
if [[ -f "${ENV_FILE}" ]]; then
  cp -p "${ENV_FILE}" "${ENV_FILE}.bak"
  chmod 600 "${ENV_FILE}.bak"
  echo "[backup] Cópia de segurança criada em: ${ENV_FILE}.bak"
fi

TMP_FILE=$(mktemp "${ENV_FILE}.tmp.XXXXXX")
chmod 600 "${TMP_FILE}"

# Garante remoção de tmp se o script for interrompido
trap 'rm -f "${TMP_FILE}"' EXIT

declare -A PROCESSED_KEYS=()

# Reconstrói .env seguindo rigorosamente a estrutura, ordem e comentários do .env.example
while IFS= read -r line || [[ -n "${line}" ]]; do
  if [[ "${line}" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
    key="${BASH_REMATCH[1]}"
    ex_val="${BASH_REMATCH[2]}"
    PROCESSED_KEYS["${key}"]=1
    if [[ -v ENV_VARS["${key}"] ]]; then
      # Preserva valor existente no .env
      echo "${key}=${ENV_VARS[${key}]}" >> "${TMP_FILE}"
    else
      # Injeta valor padrão do .env.example
      echo "${key}=${ex_val}" >> "${TMP_FILE}"
    fi
  else
    # Comentário ou linha vazia: preserva formatação do .env.example
    echo "${line}" >> "${TMP_FILE}"
  fi
done < "${ENV_EXAMPLE}"

# Se houver chaves órfãs no .env, preserva-as ao final do arquivo
if [[ ${#ORPHAN_KEYS[@]} -gt 0 ]]; then
  echo "" >> "${TMP_FILE}"
  echo "# ==============================================================================" >> "${TMP_FILE}"
  echo "# VARIÁVEIS LOCAIS PERSONALIZADAS (Não catalogadas no .env.example)" >> "${TMP_FILE}"
  echo "# ==============================================================================" >> "${TMP_FILE}"
  for key in "${ORPHAN_KEYS[@]}"; do
    echo "${key}=${ENV_VARS[${key}]}" >> "${TMP_FILE}"
  done
fi

# Substituição atômica no filesystem
mv -f "${TMP_FILE}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
trap - EXIT

echo "[ok] .env sincronizado com sucesso preservando todos os valores existentes."

# ------------------------------------------------------------------------------
# PROVISIONAMENTO DE SENHAS SEGURAS BASE62
# ------------------------------------------------------------------------------
# Invoca o gerador de senhas para preencher eventuais campos de credenciais vazios
if [[ -f "${PROJECT_ROOT}/scripts/generate-passwords.sh" ]]; then
  echo "-------------------------------------------------------------------"
  ANNE_SYNCED=1 bash "${PROJECT_ROOT}/scripts/generate-passwords.sh" "${ENV_FILE}"
fi

echo "==================================================================="
echo "Resumo: Sincronização concluída com permissões restritas (chmod 600)."
echo "==================================================================="
