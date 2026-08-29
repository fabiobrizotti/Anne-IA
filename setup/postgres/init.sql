-- ============================================================================
-- ANNE IA - PROVISIONAMENTO DO BANCO DE NEGÓCIO (schema do TCC)
-- ============================================================================
-- Roda automaticamente na primeira subida do container db-evolution
-- (mecanismo /docker-entrypoint-initdb.d do Postgres).
--
-- IMPORTANTE: cria um banco DEDICADO `anneia` para o schema de negócio da
-- Anne-IA. O banco `evolution` (default POSTGRES_DB) é controlado pelo Prisma
-- da Evolution API e NÃO deve receber tabelas de negócio - do contrário o
-- `prisma migrate deploy` falha com P3005 (schema not empty).
-- ============================================================================

-- Cria o banco de negócio dedicado da Anne-IA (se ainda não existir).
SELECT 'CREATE DATABASE anneia'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'anneia')\gexec

-- Conecta ao banco de negócio.
\connect anneia

-- 1. Habilita as extensões de Inteligência Artificial e Busca
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Cria a Tabela de Produtos
CREATE TABLE produtos (
  id_produto SERIAL PRIMARY KEY,
  nome_produto VARCHAR(150) NOT NULL,
  preco DECIMAL(10,2) NOT NULL,
  estoque INT NOT NULL DEFAULT 0
);

-- 3. Cria a Tabela de Movimentações (A trava da Idempotência)
CREATE TABLE movimentacoes_estoque (
  id_movimentacao SERIAL PRIMARY KEY,
  id_mensagem VARCHAR(120) UNIQUE NOT NULL,
  id_produto INT NOT NULL,
  quantidade INT NOT NULL,
  tipo_movimentacao VARCHAR(20) DEFAULT 'SAIDA',
  criado_em TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_produto FOREIGN KEY (id_produto) REFERENCES produtos(id_produto)
);

-- 4. Cria a Memória da IA (LangChain / Postgres Chat Memory do n8n)
--    sessionId (sem underscore) para compatibilidade com o node do n8n.
CREATE TABLE memorypostgreschat (
  id SERIAL PRIMARY KEY,
  sessionId VARCHAR NOT NULL,
  message JSONB NOT NULL
);

-- 5. Cria a Base de Conhecimento Institucional (RAG / pgvector)
CREATE TABLE base_conhecimento (
  id SERIAL PRIMARY KEY,
  conteudo TEXT NOT NULL,
  embedding VECTOR(3072)
);
