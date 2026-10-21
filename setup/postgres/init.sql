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

-- 6b. Config de Prompts por Cliente (persona/role/playbook usados pelo n8n)
--     Schema casado com o SQL do workflow ANNE-AI-ORQUESTRAÇÃO:
--     prompt_final = identity || role || personality || playbook || tools ||
--                    locale || escalation_* || system_prompt
--     IMPORTANTE: colunas NOT NULL DEFAULT '' porque o n8n concatena com ||
--     sem COALESCE — qualquer NULL propagaria e anularia o prompt inteiro.
CREATE TABLE IF NOT EXISTS prompt_config (
  id VARCHAR(100) PRIMARY KEY,
  identity TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  playbook TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT 'pt-BR',
  escalation_channel TEXT NOT NULL DEFAULT '',
  escalation_target TEXT NOT NULL DEFAULT '',
  escalation_policy TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  fatiamento_override TEXT NOT NULL DEFAULT '',
  criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_prompt_cliente FOREIGN KEY (id) REFERENCES clientes(id) ON DELETE CASCADE
);

-- Seed idempotente: 1 linha default por cliente existente (nunca sobrescreve)
INSERT INTO prompt_config (id)
SELECT c.id FROM clientes c
WHERE NOT EXISTS (
  SELECT 1 FROM prompt_config p WHERE p.id = c.id
)
ON CONFLICT (id) DO NOTHING;

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

-- 9. Tabela de Preços por Modelo (USD/1M) - versionada por vigência
CREATE TABLE IF NOT EXISTS precos_modelos (
  id BIGSERIAL PRIMARY KEY,
  provedor VARCHAR(50) NOT NULL,
  modelo VARCHAR(100) NOT NULL,
  input_per_1m NUMERIC(12,6) NOT NULL DEFAULT 0,
  cached_per_1m NUMERIC(12,6) NOT NULL DEFAULT 0,
  output_per_1m NUMERIC(12,6) NOT NULL DEFAULT 0,
  reasoning_per_1m NUMERIC(12,6) NOT NULL DEFAULT 0,
  cache_creation_per_1m NUMERIC(12,6) NOT NULL DEFAULT 0,
  moeda CHAR(3) NOT NULL DEFAULT 'USD',
  vigente_de TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  vigente_ate TIMESTAMPTZ,
  ativo BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(provedor, modelo, vigente_de)
);
CREATE INDEX IF NOT EXISTS idx_precos_modelos_lookup ON precos_modelos(provedor, modelo, ativo, vigente_de);

-- Seed idempotente: preços mínimos para opencode/big-pickle (ajustar conforme valores reais)
INSERT INTO precos_modelos (provedor, modelo, input_per_1m, cached_per_1m, output_per_1m, reasoning_per_1m, cache_creation_per_1m, moeda, vigente_de, ativo)
VALUES ('opencode', 'big-pickle', 0, 0, 0, 0, 0, 'USD', NOW(), true)
ON CONFLICT (provedor, modelo, vigente_de) DO NOTHING;

-- 10. Ledger de uso de tokens por cliente/instância (granular por requisição)
CREATE TABLE IF NOT EXISTS uso_tokens (
  id BIGSERIAL PRIMARY KEY,
  cliente_id VARCHAR(100) NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  instance_id VARCHAR(100),
  workflow_id VARCHAR(64),
  execution_id VARCHAR(64),
  chave_idempotencia VARCHAR(128) UNIQUE,
  origem VARCHAR(20) NOT NULL CHECK (origem IN ('n8n','9router_sync','manual')),
  provedor VARCHAR(50),
  modelo VARCHAR(100),
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  cached_tokens BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  custo_usd NUMERIC(18,10) NOT NULL DEFAULT 0,
  request_id VARCHAR(128),
  metadados JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_uso_tokens_cliente_criado ON uso_tokens(cliente_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_uso_tokens_exec ON uso_tokens(execution_id);
CREATE INDEX IF NOT EXISTS idx_uso_tokens_prov_mod ON uso_tokens(provedor, modelo);

