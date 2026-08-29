#!/bin/sh
# =============================================================================
# RABBITMQ - ENTRYPOINT DE PRÉ-CONFIGURAÇÃO
# =============================================================================
# Gera o /etc/rabbitmq/definitions.json a partir do template versionado,
# substituindo o placeholder "__RABBITMQ_DEFAULT_PASS__" pela senha real
# definida via RABBITMQ_DEFAULT_PASS (vinda do .env do projeto).
#
# Isso permite que o RabbitMQ suba já pré-configurado (usuário + filas quorum
# "client-infos" e "format-message" + policy) sem depender de arquivos externos
# ao repositório e sem expor a senha em texto fixo no código fonte.
# =============================================================================

set -e

TEMPLATE="/setup-rabbitmq/definitions.json.template"
OUTPUT="/etc/rabbitmq/definitions.json"

if [ -z "${RABBITMQ_DEFAULT_PASS}" ]; then
    echo "[rabbitmq-entrypoint] ERRO: RABBITMQ_DEFAULT_PASS não definida. Abortando." >&2
    exit 1
fi

echo "[rabbitmq-entrypoint] Gerando definitions.json a partir do template..."

# Substitui o placeholder pela senha real (sed é suficiente para senhas sem
# caracteres especiais em posições de replace; o valor vem de variável).
sed "s|__RABBITMQ_DEFAULT_PASS__|${RABBITMQ_DEFAULT_PASS}|g" "${TEMPLATE}" > "${OUTPUT}"

echo "[rabbitmq-entrypoint] definitions.json gerado com sucesso."

# Delega ao entrypoint original da imagem RabbitMQ (que lê load_definitions).
if [ -x "/usr/local/bin/docker-entrypoint.sh" ]; then
    exec "/usr/local/bin/docker-entrypoint.sh" "$@"
fi

exec "$@"
