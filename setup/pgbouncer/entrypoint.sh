#!/bin/sh
# ==============================================================================
# PGBOUNCER ENTRYPOINT (POSIX sh compatible)
# ==============================================================================
# Gera userlist.txt e pgbouncer.ini a partir de variáveis de ambiente.
# Suporta dois pools: anneia (Dashboard) e evolution (Evolution API).
# Executa como root para escrever em /run/pgbouncer/, depois dropa privilégios.
# ==============================================================================

set -eu

echo "[pgbouncer-entrypoint] Iniciando configuração..."

# ------------------------------------------------------------------------------
# VALIDAÇÃO DE VARIÁVEIS OBRIGATÓRIAS
# ------------------------------------------------------------------------------
for var in POSTGRES_HOST POSTGRES_PORT PGBOUNCER_PASSWORD PGBOUNCER_ADMIN_PASSWORD PGBOUNCER_LISTEN_ADDR PGBOUNCER_CONTAINER_PORT; do
  eval "val=\${$var:-}"
  if [ -z "$val" ]; then
    echo "[erro] Variável obrigatória não definida: ${var}" >&2
    exit 1
  fi
done

# Evolution DB variables (optional)
EVOLUTION_DB_HOST="${EVOLUTION_DB_HOST:-${POSTGRES_HOST}}"
EVOLUTION_DB_PORT="${EVOLUTION_DB_PORT:-${POSTGRES_PORT}}"
EVOLUTION_DB_USER="${EVOLUTION_DB_USER:-evolution}"
EVOLUTION_DB_PASSWORD="${EVOLUTION_DB_PASSWORD:-}"
EVOLUTION_DB_NAME="${EVOLUTION_DB_NAME:-evolution}"
EVOLUTION_DB_POOL_MODE="${EVOLUTION_DB_POOL_MODE:-transaction}"
EVOLUTION_DB_POOL_SIZE="${EVOLUTION_DB_POOL_SIZE:-10}"

# ------------------------------------------------------------------------------
# GERAÇÃO DO userlist.txt (em /run/pgbouncer - writable via tmpfs)
# ------------------------------------------------------------------------------
USERLIST_PATH="/run/pgbouncer/userlist.txt"

mkdir -p /run/pgbouncer
chown pgbouncer:pgbouncer /run/pgbouncer 2>/dev/null || true
cat > "${USERLIST_PATH}" <<EOF
"pgbouncer_app" "${PGBOUNCER_PASSWORD}"
"pgbouncer_admin" "${PGBOUNCER_ADMIN_PASSWORD}"
"${EVOLUTION_DB_USER}" "${EVOLUTION_DB_PASSWORD}"
EOF

chmod 600 "${USERLIST_PATH}"
chown pgbouncer:pgbouncer "${USERLIST_PATH}" 2>/dev/null || true
echo "[pgbouncer-entrypoint] userlist.txt gerado em ${USERLIST_PATH}"

# ------------------------------------------------------------------------------
# PROCESSAMENTO DO TEMPLATE pgbouncer.ini (em /run/pgbouncer - writable via tmpfs)
# ------------------------------------------------------------------------------
TEMPLATE_PATH="/etc/pgbouncer/pgbouncer.ini.template"
OUTPUT_PATH="/run/pgbouncer/pgbouncer.ini"

if [ ! -f "${TEMPLATE_PATH}" ]; then
  echo "[erro] Template não encontrado: ${TEMPLATE_PATH}" >&2
  exit 1
fi

# Substitui variáveis ${VAR} no template usando sed (POSIX)
cp "${TEMPLATE_PATH}" "${OUTPUT_PATH}"
sed -i "s|\${POSTGRES_HOST}|${POSTGRES_HOST}|g" "${OUTPUT_PATH}"
sed -i "s|\${POSTGRES_PORT}|${POSTGRES_PORT}|g" "${OUTPUT_PATH}"
sed -i "s|\${PGBOUNCER_LISTEN_ADDR}|${PGBOUNCER_LISTEN_ADDR}|g" "${OUTPUT_PATH}"
sed -i "s|\${PGBOUNCER_CONTAINER_PORT}|${PGBOUNCER_CONTAINER_PORT}|g" "${OUTPUT_PATH}"
# Substitui variáveis do evolution
sed -i "s|\${EVOLUTION_DB_HOST}|${EVOLUTION_DB_HOST}|g" "${OUTPUT_PATH}"
sed -i "s|\${EVOLUTION_DB_PORT}|${EVOLUTION_DB_PORT}|g" "${OUTPUT_PATH}"
sed -i "s|\${EVOLUTION_DB_NAME}|${EVOLUTION_DB_NAME}|g" "${OUTPUT_PATH}"
sed -i "s|\${EVOLUTION_DB_POOL_MODE}|${EVOLUTION_DB_POOL_MODE}|g" "${OUTPUT_PATH}"
sed -i "s|\${EVOLUTION_DB_POOL_SIZE}|${EVOLUTION_DB_POOL_SIZE}|g" "${OUTPUT_PATH}"
# Atualiza auth_file para o local writable
sed -i "s|auth_file = /etc/pgbouncer/userlist.txt|auth_file = /run/pgbouncer/userlist.txt|g" "${OUTPUT_PATH}"

chmod 644 "${OUTPUT_PATH}"
chown pgbouncer:pgbouncer "${OUTPUT_PATH}" 2>/dev/null || true
echo "[pgbouncer-entrypoint] pgbouncer.ini gerado em ${OUTPUT_PATH}"

# ------------------------------------------------------------------------------
# EXECUÇÃO DO PGBOUNCER (drop privileges)
# ------------------------------------------------------------------------------
echo "[pgbouncer-entrypoint] Iniciando PgBouncer..."
exec /opt/pgbouncer/pgbouncer -u postgres "${OUTPUT_PATH}"