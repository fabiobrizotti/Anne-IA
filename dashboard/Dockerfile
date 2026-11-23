FROM node:20-alpine

WORKDIR /app

# Rastreabilidade: qual revisão e versão estão rodando NESTE container.
# Injetados no build (docker-compose.yml -> build.args) para que /api/health
# permita afirmar, de fora, se a VPS realmente está na revisão esperada.
ARG GIT_SHA=unknown
ARG APP_VERSION=unknown
ENV GIT_SHA=${GIT_SHA}
ENV APP_VERSION=${APP_VERSION}

# Copia manifestos e instala dependências de produção
#   `npm ci` (não `npm install`): instala EXATAMENTE o package-lock.json,
#   então a imagem é reproduzível e idêntica à árvore que o CI auditou.
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copia código-fonte e arquivos estáticos
COPY src/ ./src/
COPY public/ ./public/

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "src/server.js"]
