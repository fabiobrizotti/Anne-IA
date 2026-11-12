FROM node:20-alpine

WORKDIR /app

# Copia manifestos e instala dependências de produção
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copia código-fonte e arquivos estáticos
COPY src/ ./src/
COPY public/ ./public/

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "src/server.js"]
