#!/bin/sh
# ============================================================================
# NGINX ENTRYPOINT (POSIX sh compatible - no envsubst dependency)
# ============================================================================
# Processa template nginx.conf com sed, valida config e inicia nginx.
# ============================================================================

set -eu

echo "[nginx-entrypoint] Iniciando configuração..."

# ------------------------------------------------------------------------------
# VALIDAÇÃO DE VARIÁVEIS OBRIGATÓRIAS
# ------------------------------------------------------------------------------
for var in TAILSCALE_HOSTNAME NGINX_CONTAINER_PORT N8N_PORT; do
  eval "val=\${$var:-}"
  if [ -z "$val" ]; then
    echo "[erro] Variável obrigatória não definida: ${var}" >&2
    exit 1
  fi
done

# Defaults para rate limits e body size (se não definidos no .env)
NGINX_RATE_LIMIT_LOGIN="${NGINX_RATE_LIMIT_LOGIN:-5r/m}"
NGINX_RATE_LIMIT_API="${NGINX_RATE_LIMIT_API:-10r/s}"
NGINX_RATE_LIMIT_BURST_LOGIN="${NGINX_RATE_LIMIT_BURST_LOGIN:-3}"
NGINX_RATE_LIMIT_BURST_API="${NGINX_RATE_LIMIT_BURST_API:-20}"
NGINX_CLIENT_MAX_BODY_SIZE="${NGINX_CLIENT_MAX_BODY_SIZE:-1m}"
NGINX_CLIENT_MAX_BODY_SIZE_CONHECIMENTO="${NGINX_CLIENT_MAX_BODY_SIZE_CONHECIMENTO:-2m}"

# ------------------------------------------------------------------------------
# PROCESSAMENTO DO TEMPLATE (sed)
# ------------------------------------------------------------------------------
TEMPLATE_PATH="/etc/nginx/nginx.conf.template"
OUTPUT_PATH="/tmp/nginx/nginx.conf"

if [ ! -f "${TEMPLATE_PATH}" ]; then
  echo "[erro] Template não encontrado: ${TEMPLATE_PATH}" >&2
  exit 1
fi

# Create directory structure (running as root from entrypoint)
mkdir -p /tmp/nginx /tmp/nginx/snippets

# Copy snippets to writable location FIRST
cp /etc/nginx/snippets/*.conf /tmp/nginx/snippets/ 2>/dev/null || true

# Substitui variáveis nos snippets (in writable location) BEFORE processing template
for snippet in /tmp/nginx/snippets/*.conf; do
  if [ -f "${snippet}" ]; then
    sed -i "s|\${NGINX_RATE_LIMIT_LOGIN}|${NGINX_RATE_LIMIT_LOGIN}|g" "${snippet}"
    sed -i "s|\${NGINX_RATE_LIMIT_API}|${NGINX_RATE_LIMIT_API}|g" "${snippet}"
    sed -i "s|\${NGINX_RATE_LIMIT_BURST_LOGIN}|${NGINX_RATE_LIMIT_BURST_LOGIN}|g" "${snippet}"
    sed -i "s|\${NGINX_RATE_LIMIT_BURST_API}|${NGINX_RATE_LIMIT_BURST_API}|g" "${snippet}"
    sed -i "s|\${NGINX_CLIENT_MAX_BODY_SIZE}|${NGINX_CLIENT_MAX_BODY_SIZE}|g" "${snippet}"
    sed -i "s|\${NGINX_CLIENT_MAX_BODY_SIZE_CONHECIMENTO}|${NGINX_CLIENT_MAX_BODY_SIZE_CONHECIMENTO}|g" "${snippet}"
  fi
done

# Now copy and process the template
cp "${TEMPLATE_PATH}" "${OUTPUT_PATH}"

# No path replacement needed - template already uses correct paths

# Substitui variáveis conhecidas no arquivo principal (incluindo valores default)
sed -i "s|\${TAILSCALE_HOSTNAME}|${TAILSCALE_HOSTNAME}|g" "${OUTPUT_PATH}"
sed -i "s|\${NGINX_CONTAINER_PORT}|${NGINX_CONTAINER_PORT}|g" "${OUTPUT_PATH}"
sed -i "s|\${N8N_PORT}|${N8N_PORT}|g" "${OUTPUT_PATH}"
sed -i "s|\${NGINX_RATE_LIMIT_LOGIN}|${NGINX_RATE_LIMIT_LOGIN}|g" "${OUTPUT_PATH}"
sed -i "s|\${NGINX_RATE_LIMIT_API}|${NGINX_RATE_LIMIT_API}|g" "${OUTPUT_PATH}"
sed -i "s|\${NGINX_RATE_LIMIT_BURST_LOGIN}|${NGINX_RATE_LIMIT_BURST_LOGIN}|g" "${OUTPUT_PATH}"
sed -i "s|\${NGINX_RATE_LIMIT_BURST_API}|${NGINX_RATE_LIMIT_BURST_API}|g" "${OUTPUT_PATH}"
# First replace the _CONHECIMENTO variant (more specific) - match entire ${VAR:-default} pattern
sed -i "s|\${NGINX_CLIENT_MAX_BODY_SIZE_CONHECIMENTO[^}]*}|${NGINX_CLIENT_MAX_BODY_SIZE_CONHECIMENTO}|g" "${OUTPUT_PATH}"
# Then replace the base variant
sed -i "s|\${NGINX_CLIENT_MAX_BODY_SIZE[^}]*}|${NGINX_CLIENT_MAX_BODY_SIZE}|g" "${OUTPUT_PATH}"

echo "[nginx-entrypoint] nginx.conf gerado em ${OUTPUT_PATH}"

# ------------------------------------------------------------------------------
# PREPARE CACHE DIRECTORIES (nginx needs write access to cache dirs during config test)
# Create cache temp directories with sticky bit (1777) - no chown needed
mkdir -p /tmp/nginx/client_temp /tmp/nginx/proxy_temp /tmp/nginx/fastcgi_temp /tmp/nginx/uwsgi_temp /tmp/nginx/scgi_temp
chmod 1777 /tmp/nginx/client_temp /tmp/nginx/proxy_temp /tmp/nginx/fastcgi_temp /tmp/nginx/uwsgi_temp /tmp/nginx/scgi_temp 2>/dev/null || true

# For config test: keep user root (allows chown to root)
# Set explicit cache paths to /tmp (writable even with read_only: true)
sed -i '/^http {/a\    client_body_temp_path /tmp/nginx/client_temp;\n    proxy_temp_path /tmp/nginx/proxy_temp;\n    fastcgi_temp_path /tmp/nginx/fastcgi_temp;\n    uwsgi_temp_path /tmp/nginx/uwsgi_temp;\n    scgi_temp_path /tmp/nginx/scgi_temp;' "${OUTPUT_PATH}"

# ------------------------------------------------------------------------------
# VALIDAÇÃO DA CONFIGURAÇÃO (com user root)
# ------------------------------------------------------------------------------
echo "[nginx-entrypoint] Validando configuração nginx..."
if ! nginx -t -c "${OUTPUT_PATH}"; then
  echo "[erro] nginx -t falhou" >&2
  cat "${OUTPUT_PATH}"
  exit 1
fi
echo "[nginx-entrypoint] Configuração válida"

# ------------------------------------------------------------------------------
# CHANGE user FROM root TO nginx FOR RUNTIME
# ------------------------------------------------------------------------------
sed -i 's/^user root;/user nginx;/' "${OUTPUT_PATH}"

# ------------------------------------------------------------------------------
# EXECUÇÃO DO NGINX
# ------------------------------------------------------------------------------
echo "[nginx-entrypoint] Validando configuração nginx..."
if ! nginx -t -c "${OUTPUT_PATH}"; then
  echo "[erro] nginx -t falhou" >&2
  cat "${OUTPUT_PATH}"
  exit 1
fi
echo "[nginx-entrypoint] Configuração válida"

# ------------------------------------------------------------------------------
# EXECUÇÃO DO NGINX
# ------------------------------------------------------------------------------
echo "[nginx-entrypoint] Iniciando nginx..."
exec nginx -c "${OUTPUT_PATH}" -g "daemon off;"