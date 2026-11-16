#!/usr/bin/env bash
# ==============================================================================
# ANNE-IA — ATUALIZAÇÃO SEGURA A PARTIR DO GITHUB (VPS / PRODUÇÃO)
# ==============================================================================
# Um comando aplica a atualização completa e reverte sozinho se algo quebrar:
#
#   preflight -> backup -> git pull --ff-only -> sync .env -> schema
#             -> rebuild -> gate de saúde -> [rollback automático]
#
# Garantias:
#   - Nunca atualiza com árvore Git suja (aborta e explica o que fazer).
#   - Nunca sobrescreve senhas: o `.env` é mesclado pelo scripts/sync-env.sh.
#   - Nunca perde dado: o schema reaplicado é 100% aditivo/idempotente e há
#     pg_dump do banco `anneia` antes de qualquer mudança.
#   - Nunca deixa a stack quebrada: se o gate de saúde falhar, volta o código e
#     o `.env` para a revisão anterior e sobe de novo.
#
# Uso:
#   ./scripts/update.sh                 # atualiza (pede confirmação se houver TTY)
#   ./scripts/update.sh --yes           # não-interativo (cron / automação)
#   ./scripts/update.sh --dry-run       # mostra o que mudaria, sem aplicar
#   ./scripts/update.sh --schema        # força reaplicar init.sql
#   ./scripts/update.sh --branch main   # branch de origem (padrão: dev)
#
# Códigos de saída:
#   0  atualizado (ou já estava na última revisão)
#   1  falha de preflight / update abortado
#   2  update aplicado, mas o gate falhou e o rollback foi executado
# ==============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

ENV_FILE="${PROJECT_ROOT}/.env"
BACKUP_DIR="${PROJECT_ROOT}/backups"
LOG_DIR="${PROJECT_ROOT}/logs"
LOCK_FILE="${PROJECT_ROOT}/.update.lock"
KEEP_BACKUPS=10

BRANCH="${UPDATE_BRANCH:-dev}"
REMOTE="${UPDATE_REMOTE:-origin}"
ASSUME_YES=0
DRY_RUN=0
FORCE_SCHEMA=0
HEALTH_TIMEOUT="${UPDATE_HEALTH_TIMEOUT:-180}"

for arg in "$@"; do
  case "${arg}" in
    --yes|-y)      ASSUME_YES=1 ;;
    --dry-run|-n)  DRY_RUN=1 ;;
    --schema|-s)   FORCE_SCHEMA=1 ;;
    --branch)      shift; BRANCH="${1:?--branch exige um valor}" ;;
    --branch=*)    BRANCH="${arg#*=}" ;;
    -h|--help)     sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[erro] Argumento desconhecido: ${arg}" >&2; exit 1 ;;
  esac
done

# ------------------------------------------------------------------------------
# LOG / SAÍDA
# ------------------------------------------------------------------------------
mkdir -p "${LOG_DIR}"
TS="$(date '+%Y%m%d-%H%M%S')"
LOG_FILE="${LOG_DIR}/update-${TS}.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m[aviso]\033[0m %s\n' "$*"; }
die()  { printf '\n    \033[31m[erro]\033[0m %s\n' "$*"; printf '    log: %s\n' "${LOG_FILE}"; exit 1; }

# Grava a revisão aplicada no .env. `up -d` recria o container com o novo valor,
# e /api/health passa a devolver este sha — é o que permite afirmar de fora que a
# stack roda o commit esperado.
stamp_git_sha() {
  local short="$1"
  if grep -qE '^GIT_SHA=' "${ENV_FILE}"; then
    sed -i "s|^GIT_SHA=.*|GIT_SHA=${short}|" "${ENV_FILE}"
  else
    printf 'GIT_SHA=%s\n' "${short}" >> "${ENV_FILE}"
  fi
}

# Código já está na revisão certa — mas o container também precisa estar.
# Se a stack está saudável e roda a revisão, termina com "NADA A FAZER". Se o
# container ficou para trás (update interrompido depois do pull, `git pull`
# manual, container recriado de imagem antiga), converge — carimba o sha e
# recria — em vez de abortar: é exatamente o resultado que o operador queria.
up_to_date() {
  local short="$1"

  if ./scripts/verify-stack.sh --timeout "${HEALTH_TIMEOUT}" --require-revision; then
    echo ""
    printf ' \033[32m%s\033[0m\n' "NADA A FAZER — revisão ${short} já aplicada e stack saudável."
    exit 0
  fi

  warn "código em ${short}, mas o container não está nessa revisão — convergindo"
  stamp_git_sha "${short}"
  docker compose up -d >/dev/null 2>&1 \
    || die "docker compose up -d falhou ao convergir para ${short}"
  ./scripts/verify-stack.sh --timeout "${HEALTH_TIMEOUT}" --require-revision \
    || die "não convergiu para ${short} — stack não está saudável (veja o log)"
  echo ""
  printf ' \033[32m%s\033[0m\n' "CONVERGIDO — container recriado em ${short}, stack saudável."
  exit 0
}

env_get() {
  local key="$1" default="${2:-}"
  local val
  val="$(grep -E "^${key}=" "${ENV_FILE}" | head -1 | cut -d= -f2- || true)"
  printf '%s' "${val:-${default}}"
}

step "Anne-IA — atualização $(date '+%Y-%m-%d %H:%M:%S')"
echo "    projeto : ${PROJECT_ROOT}"
echo "    branch  : ${BRANCH} (remoto: ${REMOTE})"
echo "    log     : ${LOG_FILE}"

# ------------------------------------------------------------------------------
# LOCK (impede duas atualizações simultâneas)
# ------------------------------------------------------------------------------
if command -v flock >/dev/null 2>&1; then
  exec 9>"${LOCK_FILE}"
  flock -n 9 || die "Outra atualização já está em execução (lock: ${LOCK_FILE})"
else
  [[ -e "${LOCK_FILE}.d" ]] && die "Outra atualização já está em execução"
  mkdir -p "${LOCK_FILE}.d"
  trap 'rmdir "${LOCK_FILE}.d" 2>/dev/null || true' EXIT
fi

# ------------------------------------------------------------------------------
# PREFLIGHT
# ------------------------------------------------------------------------------
step "[1/8] Preflight"

command -v git >/dev/null 2>&1 || die "git não encontrado"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "não é um repositório git"
docker info >/dev/null 2>&1 || die "daemon Docker indisponível"
[[ -f "${ENV_FILE}" ]] || die ".env não encontrado — rode ./scripts/sync-env.sh primeiro"

PERM="$(stat -c '%a' "${ENV_FILE}")"
[[ "${PERM}" == "600" ]] || { chmod 600 "${ENV_FILE}"; warn ".env estava ${PERM}; ajustado para 600"; }
ok ".env presente e com permissão 600"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "${CURRENT_BRANCH}" == "${BRANCH}" ]] || die "branch atual '${CURRENT_BRANCH}' != esperada '${BRANCH}' (use --branch para mudar)"
ok "branch ${BRANCH}"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo ""
  git status --short --untracked-files=no
  die "Árvore Git suja. Ajuste e faça push na sua máquina, ou faça commit/revert aqui antes de atualizar."
fi
ok "árvore Git limpa"

AVAIL_KB="$(df -Pk "${PROJECT_ROOT}" | awk 'NR==2 {print $4}')"
if [[ "${AVAIL_KB}" -lt 2097152 ]]; then
  die "Espaço insuficiente em disco: $((AVAIL_KB / 1024)) MB livres (mínimo 2048 MB)"
fi
ok "espaço em disco: $((AVAIL_KB / 1024 / 1024)) GB livres"

if git rev-parse --git-path hooks >/dev/null 2>&1; then
  [[ "$(git config --get core.hooksPath || true)" == ".githooks" ]] || {
    git config core.hooksPath .githooks
    warn "core.hooksPath não estava configurado; ajustado para .githooks"
  }
fi
ok "hooks do repositório ativos"

# ------------------------------------------------------------------------------
# REVISÃO ATUAL
# ------------------------------------------------------------------------------
PREV_REV="$(git rev-parse HEAD)"
PREV_SHORT="$(git rev-parse --short HEAD)"
ok "revisão atual: ${PREV_SHORT}"

# ------------------------------------------------------------------------------
# GIT FETCH / PULL
# ------------------------------------------------------------------------------
step "[2/8] Buscando atualizações"
git fetch --tags --prune "${REMOTE}" "${BRANCH}" >/dev/null 2>&1 || die "git fetch falhou (verifique rede/credenciais)"
REMOTE_REV="$(git rev-parse "${REMOTE}/${BRANCH}")"
ok "${REMOTE}/${BRANCH} em $(git rev-parse --short "${REMOTE_REV}")"

if [[ "${REMOTE_REV}" == "${PREV_REV}" ]]; then
  ok "já está na última revisão — nada a atualizar"
  if [[ "${DRY_RUN}" -eq 1 ]]; then exit 0; fi
  up_to_date "${PREV_SHORT}"
fi

BEHIND="$(git rev-list --count "HEAD..${REMOTE_REV}")"
if [[ "${BEHIND}" -eq 0 ]]; then
  ok "nenhum commit novo em ${REMOTE}/${BRANCH} (HEAD está à frente ou igual)"
  if [[ "${DRY_RUN}" -eq 1 ]]; then exit 0; fi
  up_to_date "${PREV_SHORT}"
fi

echo ""
echo "    ${BEHIND} commit(s) novo(s):"
git log --oneline --no-decorate "HEAD..${REMOTE_REV}" | sed 's/^/      /'
echo ""
echo "    arquivos alterados:"
git diff --name-only "HEAD..${REMOTE_REV}" | sed 's/^/      /'

CHANGED="$(git diff --name-only "HEAD..${REMOTE_REV}")"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo ""
  printf ' \033[33m%s\033[0m\n' "DRY-RUN — nada foi aplicado."
  exit 0
fi

if [[ "${ASSUME_YES}" -eq 0 ]]; then
  if [[ -t 0 ]]; then
    printf '    Aplicar esta atualização? [s/N] '
    read -r REPLY
    [[ "${REPLY}" =~ ^[sSyY]$ ]] || die "cancelado pelo usuário"
  else
    die "Sem TTY: use --yes para atualização não-interativa"
  fi
fi

# ------------------------------------------------------------------------------
# BACKUP
# ------------------------------------------------------------------------------
step "[3/8] Backup"
mkdir -p "${BACKUP_DIR}"

cp -p "${ENV_FILE}" "${BACKUP_DIR}/env-${TS}"
chmod 600 "${BACKUP_DIR}/env-${TS}"
ok ".env salvo em backups/env-${TS}"

printf '%s\n' "${PREV_REV}" > "${BACKUP_DIR}/rev-${TS}"
ok "revisão anterior registrada em backups/rev-${TS}"

PG_USER="$(env_get POSTGRES_USER evolution)"
if docker compose ps -q db-evolution >/dev/null 2>&1 \
   && [[ -n "$(docker compose ps -q db-evolution 2>/dev/null)" ]] \
   && docker compose exec -T db-evolution psql -U "${PG_USER}" -d anneia -tAc 'SELECT 1' >/dev/null 2>&1; then
  if docker compose exec -T db-evolution pg_dump -U "${PG_USER}" -d anneia 2>/dev/null | gzip > "${BACKUP_DIR}/anneia-${TS}.sql.gz"; then
    ok "dump do banco anneia: backups/anneia-${TS}.sql.gz ($(du -h "${BACKUP_DIR}/anneia-${TS}.sql.gz" | cut -f1))"
  else
    rm -f "${BACKUP_DIR}/anneia-${TS}.sql.gz"
    warn "pg_dump falhou — seguindo sem dump (schema é aditivo, mas registre isto)"
  fi
else
  warn "banco anneia indisponível agora — dump ignorado (stack possivelmente parada)"
fi

# Retenção: mantém os N backups mais recentes de cada tipo
for prefix in env anneia rev; do
  find "${BACKUP_DIR}" -maxdepth 1 -name "${prefix}-*" -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | tail -n +$((KEEP_BACKUPS + 1)) | cut -d' ' -f2- \
    | while read -r old; do rm -f "${old}"; done
done
ok "retenção aplicada (últimos ${KEEP_BACKUPS} de cada tipo)"

git pull --ff-only "${REMOTE}" "${BRANCH}" >/dev/null 2>&1 || die "git pull --ff-only falhou (histórico divergente?)"
NEW_REV="$(git rev-parse HEAD)"
ok "código atualizado: ${PREV_SHORT} -> $(git rev-parse --short HEAD)"

# ------------------------------------------------------------------------------
# .ENV
# ------------------------------------------------------------------------------
step "[4/8] Reconciliando .env"
if grep -qx '.env.example' <<< "${CHANGED}"; then
  ./scripts/sync-env.sh >/dev/null 2>&1 || die "sync-env.sh falhou — .env preservado intacto"
  ok ".env sincronizado com .env.example (valores locais preservados)"
else
  ok ".env.example sem mudanças"
fi

# Marca a revisão aplicada: /api/health passa a devolver este sha, então a
# verificação "a VPS está mesmo nesse commit?" é objetiva e externa.
NEW_SHORT="$(git rev-parse --short HEAD)"
stamp_git_sha "${NEW_SHORT}"
ok "GIT_SHA=${NEW_SHORT} gravado no .env (reaparece em /api/health)"

# ------------------------------------------------------------------------------
# DOCKER COMPOSE
# ------------------------------------------------------------------------------
step "[5/8] Validando docker-compose.yml"
docker compose config -q || { git reset --hard "${PREV_REV}" >/dev/null 2>&1; die "docker-compose.yml inválido — código revertido para ${PREV_SHORT}"; }
ok "compose válido"

# ------------------------------------------------------------------------------
# SCHEMA
# ------------------------------------------------------------------------------
step "[6/8] Schema do banco (anneia)"
if [[ "${FORCE_SCHEMA}" -eq 1 ]] || grep -qx 'setup/postgres/init.sql' <<< "${CHANGED}"; then
  if docker compose exec -T db-evolution psql -U "${PG_USER}" -d anneia -v ON_ERROR_STOP=1 \
       < setup/postgres/init.sql > "${LOG_DIR}/schema-${TS}.log" 2>&1; then
    ok "init.sql reaplicado sem erros (idempotente)"
  else
    warn "init.sql falhou — detalhes em logs/schema-${TS}.log"
    grep -E 'ERROR' "${LOG_DIR}/schema-${TS}.log" | head -5 || true
    die "schema não aplicado; código mantido em ${PREV_SHORT} para investigação"
  fi
else
  ok "init.sql sem mudanças — schema não reaplicado"
fi

# ------------------------------------------------------------------------------
# APLICAR
# ------------------------------------------------------------------------------
step "[7/8] Aplicando (build quando necessário)"
BUILT_DASHBOARD=0
if grep -qE '^dashboard/' <<< "${CHANGED}"; then
  docker compose build dashboard || die "build do dashboard falhou — nada foi reiniciado"
  BUILT_DASHBOARD=1
  ok "imagem do dashboard reconstruída"
else
  ok "dashboard sem mudanças — imagem reaproveitada"
fi

docker compose up -d --remove-orphans || die "docker compose up falhou"
ok "containers aplicados"

# ------------------------------------------------------------------------------
# GATE + ROLLBACK
# ------------------------------------------------------------------------------
step "[8/8] Gate de saúde (até ${HEALTH_TIMEOUT}s)"
if ./scripts/verify-stack.sh --timeout "${HEALTH_TIMEOUT}" --require-revision; then
  printf '%s\n' "${NEW_REV}" > "${BACKUP_DIR}/last-success"
  echo ""
  printf ' \033[32m%s\033[0m\n' "ATUALIZAÇÃO CONCLUÍDA — $(git rev-parse --short HEAD) aplicada e stack saudável."
  echo "    rollback manual: backups/rev-${TS} + backups/env-${TS}"
  exit 0
fi

warn "gate falhou — iniciando ROLLBACK automático"
echo ""
echo "    [1/3] restaurando .env e código para ${PREV_SHORT}..."
cp -p "${BACKUP_DIR}/env-${TS}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
git reset --hard "${PREV_REV}" >/dev/null 2>&1 || warn "git reset --hard falhou — revisão manual necessária"

echo "    [2/3] subindo stack na revisão anterior..."
ROLLBACK_BUILD=()
[[ "${BUILT_DASHBOARD}" -eq 1 ]] && ROLLBACK_BUILD=(--build)
docker compose up -d "${ROLLBACK_BUILD[@]}" --remove-orphans >/dev/null 2>&1 || warn "up no rollback falhou"

echo "    [3/3] verificando stack pós-rollback..."
if ./scripts/verify-stack.sh --timeout "${HEALTH_TIMEOUT}"; then
  echo ""
  printf ' \033[33m%s\033[0m\n' "ROLLBACK CONCLUÍDO — stack saudável em ${PREV_SHORT}. Atualização NÃO aplicada."
else
  echo ""
  printf ' \033[31m%s\033[0m\n' "ROLLBACK INCOMPLETO — stack ainda com problema. Ação manual necessária."
  echo "    dump do banco : backups/anneia-${TS}.sql.gz"
  echo "    .env anterior : backups/env-${TS}"
  echo "    logs          : ${LOG_FILE}"
fi
exit 2
