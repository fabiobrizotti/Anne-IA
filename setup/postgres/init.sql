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
  session_id VARCHAR NOT NULL,
  message JSONB NOT NULL
);

-- 5. Cria a Base de Conhecimento Institucional (RAG / pgvector)
CREATE TABLE base_conhecimento (
  id SERIAL PRIMARY KEY,
  text TEXT NOT NULL,
  metadata JSONB NOT NULL,
  embedding VECTOR(3072)
);

-- 6. Tabela de Clientes (Multi-tenant vinculado às Instâncias Evolution API)
--    O campo id é a chave primária e corresponde ao instanceId / instanceName da Evolution API
--    Relação 1:1 com public."Instance" (Evolution API) pelo MESMO ID: clientes.id = "Instance".id
CREATE TABLE IF NOT EXISTS clientes (
  id VARCHAR(100) PRIMARY KEY,
  nome VARCHAR(255) NOT NULL,
  telefone VARCHAR(30),
  email VARCHAR(255),
  ativo BOOLEAN NOT NULL DEFAULT true,
  configuracoes JSONB NOT NULL DEFAULT '{}',
  historico_telefones JSONB NOT NULL DEFAULT '[]'::jsonb,
  criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS historico_telefones JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_clientes_nome ON clientes (nome);
CREATE INDEX IF NOT EXISTS idx_clientes_ativo ON clientes (ativo);

-- 7. Tabela Instance (Evolution API) - mantida em schema centralizado (idempotente)
--    Garante existência para permitir alinhamento 1:1 com clientes pelo mesmo ID
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InstanceConnectionStatus') THEN
    CREATE TYPE "InstanceConnectionStatus" AS ENUM ('open', 'close', 'connecting');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "Instance" (
  id text NOT NULL,
  name character varying(255) NOT NULL,
  "connectionStatus" "InstanceConnectionStatus" NOT NULL DEFAULT 'open'::"InstanceConnectionStatus",
  "ownerJid" character varying(100),
  "profilePicUrl" character varying(500),
  integration character varying(100),
  "number" character varying(100),
  token character varying(255),
  "clientName" character varying(100),
  "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp without time zone,
  "profileName" character varying(100),
  "businessId" character varying(100),
  "disconnectionAt" timestamp without time zone,
  "disconnectionObject" jsonb,
  "disconnectionReasonCode" integer,
  CONSTRAINT "Instance_pkey" PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS "Instance_name_key" ON "Instance" (name);
ALTER TABLE "Instance" OWNER TO evolution;

-- 8. Alinhamento 1:1 Instance <-> clientes (mesmo ID) - idempotente, não-destrutivo
--    Cria cliente apenas se não existir; nunca sobrescreve clientes pré-existentes
INSERT INTO clientes (
  id,
  nome,
  telefone,
  email,
  ativo,
  configuracoes,
  historico_telefones,
  criado_em,
  atualizado_em
)
SELECT
  i.id,
  COALESCE(i."profileName", i."clientName", i.name),
  i."number",
  NULL,
  true,
  '{}'::jsonb,
  '[]'::jsonb,
  COALESCE(i."createdAt", NOW()),
  COALESCE(i."updatedAt", COALESCE(i."createdAt", NOW()))
FROM "Instance" i
WHERE NOT EXISTS (
  SELECT 1 FROM clientes c WHERE c.id = i.id
)
ON CONFLICT (id) DO NOTHING;

