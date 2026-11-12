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

-- 1. Habilita as extensões de Inteligência Artificial, Busca e Criptografia (LGPD)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. Cria a Tabela de Produtos (Idempotente)
CREATE TABLE IF NOT EXISTS produtos (
  id_produto SERIAL PRIMARY KEY,
  nome_produto VARCHAR(150) NOT NULL,
  preco DECIMAL(10,2) NOT NULL,
  estoque INT NOT NULL DEFAULT 0
);

-- 3. Cria a Tabela de Movimentações (A trava da Idempotência)
CREATE TABLE IF NOT EXISTS movimentacoes_estoque (
  id_movimentacao SERIAL PRIMARY KEY,
  id_mensagem VARCHAR(120) UNIQUE NOT NULL,
  id_produto INT NOT NULL,
  quantidade INT NOT NULL,
  tipo_movimentacao VARCHAR(20) DEFAULT 'SAIDA',
  criado_em TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_produto FOREIGN KEY (id_produto) REFERENCES produtos(id_produto)
);

-- 4. Cria a Memória da IA (LangChain / Postgres Chat Memory do n8n)
--    session_id compatível com o node do n8n; criado_em permite retenção/expurgo LGPD.
CREATE TABLE IF NOT EXISTS memorypostgreschat (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR NOT NULL,
  message JSONB NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE memorypostgreschat ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_memorypostgreschat_session ON memorypostgreschat (session_id);
CREATE INDEX IF NOT EXISTS idx_memorypostgreschat_criado_em ON memorypostgreschat (criado_em);

-- 5. Tabela de Clientes (Multi-tenant vinculado às Instâncias Evolution API)
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
  atualizado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  codigo BIGSERIAL UNIQUE
);

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS codigo BIGSERIAL;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS historico_telefones JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_codigo ON clientes (codigo);
CREATE INDEX IF NOT EXISTS idx_clientes_nome ON clientes (nome);
CREATE INDEX IF NOT EXISTS idx_clientes_ativo ON clientes (ativo);

-- 6. Cria a Base de Conhecimento Institucional (RAG / pgvector)
--    Multi-tenant isolado estritamente por instance_id (clientes.id)
CREATE TABLE IF NOT EXISTS base_conhecimento (
  id SERIAL PRIMARY KEY,
  instance_id VARCHAR(100) REFERENCES clientes(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  metadata JSONB NOT NULL,
  embedding VECTOR(3072),
  criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  atualizado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE base_conhecimento ADD COLUMN IF NOT EXISTS instance_id VARCHAR(100) REFERENCES clientes(id) ON DELETE CASCADE;
ALTER TABLE base_conhecimento ADD COLUMN IF NOT EXISTS criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE base_conhecimento ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- Backfill idempotente: sincroniza instance_id a partir de metadata->>'instance_id' quando válido
UPDATE base_conhecimento
SET instance_id = metadata->>'instance_id'
WHERE (instance_id IS NULL OR instance_id = '')
  AND metadata IS NOT NULL
  AND metadata->>'instance_id' IS NOT NULL
  AND EXISTS (SELECT 1 FROM clientes c WHERE c.id = metadata->>'instance_id');

CREATE INDEX IF NOT EXISTS idx_base_conhecimento_instance ON base_conhecimento (instance_id);
CREATE INDEX IF NOT EXISTS idx_base_conhecimento_tenant_pagination ON base_conhecimento (instance_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_base_conhecimento_text_trgm ON base_conhecimento USING gin (text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_base_conhecimento_metadata_gin ON base_conhecimento USING gin (metadata);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'base_conhecimento' AND indexname = 'idx_base_conhecimento_hnsw'
  ) THEN
    BEGIN
      CREATE INDEX idx_base_conhecimento_hnsw ON base_conhecimento USING hnsw (embedding vector_cosine_ops);
    EXCEPTION WHEN program_limit_exceeded THEN
      CREATE INDEX idx_base_conhecimento_hnsw ON base_conhecimento USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops);
    END;
  END IF;
END $$;

-- Trigger automático para sincronizar instance_id caso inserido via LangChain/n8n em metadata JSONB
CREATE OR REPLACE FUNCTION trg_base_conhecimento_sync_instance_id()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.instance_id IS NULL OR NEW.instance_id = '') AND NEW.metadata IS NOT NULL AND NEW.metadata->>'instance_id' IS NOT NULL THEN
    NEW.instance_id := NEW.metadata->>'instance_id';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_instance_id ON base_conhecimento;
CREATE TRIGGER trg_sync_instance_id
BEFORE INSERT OR UPDATE ON base_conhecimento
FOR EACH ROW
EXECUTE FUNCTION trg_base_conhecimento_sync_instance_id();

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
  tier VARCHAR(20) NOT NULL DEFAULT 'tier_1',
  input_per_1m NUMERIC(12,6) NOT NULL DEFAULT 0,
  cached_per_1m NUMERIC(12,6) NOT NULL DEFAULT 0,
  output_per_1m NUMERIC(12,6) NOT NULL DEFAULT 0,
  reasoning_per_1m NUMERIC(12,6) NOT NULL DEFAULT 0,
  cache_creation_per_1m NUMERIC(12,6) NOT NULL DEFAULT 0,
  moeda CHAR(3) NOT NULL DEFAULT 'USD',
  vigente_de TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  vigente_ate TIMESTAMPTZ,
  ativo BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT chk_precos_modelos_tier CHECK (tier IN ('tier_1', 'tier_2', 'tier_3')),
  UNIQUE(provedor, modelo, vigente_de)
);
ALTER TABLE precos_modelos ADD COLUMN IF NOT EXISTS tier VARCHAR(20) NOT NULL DEFAULT 'tier_1';
CREATE INDEX IF NOT EXISTS idx_precos_modelos_lookup ON precos_modelos(provedor, modelo, ativo, vigente_de);
CREATE INDEX IF NOT EXISTS idx_precos_modelos_tier_ativo_custo ON precos_modelos (tier, ativo, input_per_1m ASC);

-- Seed idempotente: preços mínimos para opencode/big-pickle e antigravity/ag/gemini-3.1-flash-lite
INSERT INTO precos_modelos (provedor, modelo, tier, input_per_1m, cached_per_1m, output_per_1m, reasoning_per_1m, cache_creation_per_1m, moeda, vigente_de, ativo)
VALUES ('opencode', 'big-pickle', 'tier_3', 0, 0, 0, 0, 0, 'USD', NOW(), true)
ON CONFLICT (provedor, modelo, vigente_de) DO NOTHING;

INSERT INTO precos_modelos (provedor, modelo, tier, input_per_1m, cached_per_1m, output_per_1m, reasoning_per_1m, cache_creation_per_1m, moeda, vigente_de, ativo)
SELECT 'antigravity', 'ag/gemini-3.1-flash-lite', 'tier_1', 0.250000, 0.000000, 1.500000, 0.000000, 0.000000, 'USD', NOW(), true
WHERE NOT EXISTS (
  SELECT 1 FROM precos_modelos WHERE provedor = 'antigravity' AND modelo = 'ag/gemini-3.1-flash-lite'
);

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

-- Função idempotente de registro contábil de uso de tokens (FinOps SSOT)
CREATE OR REPLACE FUNCTION fn_registrar_uso_tokens(
  p_instance_id VARCHAR(100),
  p_workflow_id VARCHAR(64),
  p_execution_id VARCHAR(64),
  p_provedor VARCHAR(50),
  p_modelo VARCHAR(100),
  p_prompt_tokens BIGINT DEFAULT 0,
  p_completion_tokens BIGINT DEFAULT 0,
  p_cached_tokens BIGINT DEFAULT 0,
  p_cache_creation_tokens BIGINT DEFAULT 0,
  p_reasoning_tokens BIGINT DEFAULT 0,
  p_total_tokens BIGINT DEFAULT NULL,
  p_origem VARCHAR(20) DEFAULT 'n8n',
  p_step VARCHAR(50) DEFAULT 'main',
  p_request_id VARCHAR(128) DEFAULT NULL,
  p_metadados JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB AS $$
DECLARE
  v_cliente_id VARCHAR(100);
  v_cliente_codigo BIGINT;
  v_inst_clean VARCHAR(100);
  v_wf_clean VARCHAR(64);
  v_exec_clean VARCHAR(64);
  v_step_clean VARCHAR(50);
  v_origem_clean VARCHAR(20);
  v_prov_clean VARCHAR(50);
  v_mod_clean VARCHAR(100);
  v_mod_slug VARCHAR(100);
  v_chave_idemp VARCHAR(128);
  v_prompt BIGINT;
  v_completion BIGINT;
  v_cached BIGINT;
  v_cache_creation BIGINT;
  v_reasoning BIGINT;
  v_total BIGINT;
  v_billable_input BIGINT;
  v_preco RECORD;
  v_custo_usd NUMERIC(18,10) := 0;
  v_inserted_id BIGINT;
BEGIN
  v_inst_clean := btrim(COALESCE(p_instance_id, ''));
  IF v_inst_clean = '' THEN
    RETURN jsonb_build_object('sucesso', false, 'ignorado', true, 'motivo', 'instance_id_vazio');
  END IF;

  SELECT c.id, c.codigo
    INTO v_cliente_id, v_cliente_codigo
  FROM clientes c
  WHERE c.id = v_inst_clean OR c.codigo::text = v_inst_clean
  LIMIT 1;

  IF v_cliente_id IS NULL THEN
    RETURN jsonb_build_object('sucesso', false, 'ignorado', true, 'motivo', 'cliente_nao_encontrado', 'instance_id', v_inst_clean);
  END IF;

  v_wf_clean := COALESCE(NULLIF(btrim(p_workflow_id), ''), 'manual');
  v_exec_clean := COALESCE(NULLIF(btrim(p_execution_id), ''), 'manual');
  v_step_clean := COALESCE(NULLIF(btrim(p_step), ''), 'main');
  v_origem_clean := CASE WHEN p_origem IN ('n8n', '9router_sync', 'manual') THEN p_origem ELSE 'n8n' END;

  v_chave_idemp := left('n8n:' || v_wf_clean || ':' || v_exec_clean || ':' || v_step_clean, 128);

  v_prov_clean := lower(COALESCE(NULLIF(btrim(p_provedor), ''), '9router'));
  v_mod_clean := COALESCE(NULLIF(btrim(p_modelo), ''), 'anneia');
  v_mod_slug := lower(regexp_replace(v_mod_clean, '^[^/]+/', ''));

  v_prompt := GREATEST(COALESCE(p_prompt_tokens, 0), 0);
  v_completion := GREATEST(COALESCE(p_completion_tokens, 0), 0);
  v_cached := GREATEST(COALESCE(p_cached_tokens, 0), 0);
  v_cache_creation := GREATEST(COALESCE(p_cache_creation_tokens, 0), 0);
  v_reasoning := GREATEST(COALESCE(p_reasoning_tokens, 0), 0);
  v_total := GREATEST(COALESCE(NULLIF(p_total_tokens, 0), v_prompt + v_completion + v_reasoning), 0);

  -- Lookup resiliente a prefixos de roteamento (ex: 'ag/gemini-3.1-flash-lite' vs 'gemini-3.1-flash-lite')
  SELECT
    provedor,
    modelo,
    COALESCE(input_per_1m, 0) AS input_per_1m,
    COALESCE(cached_per_1m, 0) AS cached_per_1m,
    COALESCE(output_per_1m, 0) AS output_per_1m,
    COALESCE(reasoning_per_1m, 0) AS reasoning_per_1m,
    COALESCE(cache_creation_per_1m, 0) AS cache_creation_per_1m
  INTO v_preco
  FROM precos_modelos
  WHERE ativo = true
    AND vigente_de <= NOW()
    AND (vigente_ate IS NULL OR vigente_ate > NOW())
    AND (
      lower(modelo) = lower(v_mod_clean)
      OR lower(regexp_replace(modelo, '^[^/]+/', '')) = v_mod_slug
    )
  ORDER BY
    (lower(provedor) = v_prov_clean AND lower(modelo) = lower(v_mod_clean)) DESC,
    (lower(provedor) = v_prov_clean) DESC,
    (lower(modelo) = lower(v_mod_clean)) DESC,
    vigente_de DESC
  LIMIT 1;

  IF FOUND THEN
    v_prov_clean := COALESCE(v_preco.provedor, v_prov_clean);
    v_mod_clean := COALESCE(v_preco.modelo, v_mod_clean);
    v_billable_input := GREATEST(v_prompt - v_cached - v_cache_creation, 0);
    v_custo_usd := (
      (v_billable_input / 1000000.0 * v_preco.input_per_1m)
      + (v_cached / 1000000.0 * v_preco.cached_per_1m)
      + (v_cache_creation / 1000000.0 * v_preco.cache_creation_per_1m)
      + (v_completion / 1000000.0 * v_preco.output_per_1m)
      + (v_reasoning / 1000000.0 * v_preco.reasoning_per_1m)
    )::NUMERIC(18,10);
  END IF;

  INSERT INTO uso_tokens (
    cliente_id,
    instance_id,
    workflow_id,
    execution_id,
    chave_idempotencia,
    origem,
    provedor,
    modelo,
    prompt_tokens,
    completion_tokens,
    cached_tokens,
    cache_creation_tokens,
    reasoning_tokens,
    total_tokens,
    custo_usd,
    request_id,
    metadados
  )
  VALUES (
    v_cliente_id,
    v_inst_clean,
    v_wf_clean,
    v_exec_clean,
    v_chave_idemp,
    v_origem_clean,
    v_prov_clean,
    v_mod_clean,
    v_prompt,
    v_completion,
    v_cached,
    v_cache_creation,
    v_reasoning,
    v_total,
    v_custo_usd,
    NULLIF(btrim(COALESCE(p_request_id, '')), ''),
    COALESCE(p_metadados, '{}'::jsonb) || jsonb_build_object(
      'source', 'anne-costs-rmq',
      'cliente_codigo', v_cliente_codigo,
      'price_matched', FOUND,
      'recorded_at', NOW()
    )
  )
  ON CONFLICT (chave_idempotencia) DO NOTHING
  RETURNING id INTO v_inserted_id;

  RETURN jsonb_build_object(
    'sucesso', true,
    'id', v_inserted_id,
    'duplicado', (v_inserted_id IS NULL),
    'chave_idempotencia', v_chave_idemp,
    'cliente_id', v_cliente_id,
    'provedor', v_prov_clean,
    'modelo', v_mod_clean,
    'total_tokens', v_total,
    'custo_usd', v_custo_usd
  );
END;
$$ LANGUAGE plpgsql;

-- 11. Tabela de Prompts Padrão do Sistema (prompts_padrao)
--     Prompts globais para roteamento, classificação de intenção e otimização de custos de IA
CREATE TABLE IF NOT EXISTS prompts_padrao (
  id BIGSERIAL PRIMARY KEY,
  chave VARCHAR(100) UNIQUE NOT NULL,
  nome VARCHAR(200) NOT NULL,
  descricao TEXT,
  conteudo TEXT NOT NULL,
  modelo_sugerido VARCHAR(100) DEFAULT 'deepseek/deepseek-chat',
  variaveis JSONB NOT NULL DEFAULT '[]'::jsonb,
  ativo BOOLEAN NOT NULL DEFAULT true,
  versao INT NOT NULL DEFAULT 1,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_chave_format CHECK (length(chave) >= 3 AND chave ~ '^[a-z0-9_-]+$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompts_padrao_chave ON prompts_padrao (chave);
CREATE INDEX IF NOT EXISTS idx_prompts_padrao_ativo ON prompts_padrao (ativo);

CREATE OR REPLACE FUNCTION trigger_set_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN
  NEW.atualizado_em = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_prompts_padrao_atualizado_em ON prompts_padrao;
CREATE TRIGGER set_prompts_padrao_atualizado_em
BEFORE UPDATE ON prompts_padrao
FOR EACH ROW
EXECUTE FUNCTION trigger_set_atualizado_em();

-- Seed Idempotente: Prompt Mestre de Roteamento e Economia de Custos (Mini JEV)
INSERT INTO prompts_padrao (
  chave,
  nome,
  descricao,
  conteudo,
  modelo_sugerido,
  variaveis,
  ativo,
  versao
)
VALUES (
  'roteador_modelos_economia',
  'Roteador Inteligente e Classificador de Tarefas (Mini JEV)',
  'Classifica a intenção da mensagem e seleciona dinamicamente o modelo mais econômico e eficiente do catálogo ativo (Tier 1: Texto Puro, Tier 2: Ferramentas, Tier 3: Raciocínio Complexo).',
  '<context>
Você é o Router e Classificador de Tarefas da Anne-IA.
Sua missão é analisar a mensagem do cliente e o histórico recente, avaliar a complexidade da intenção e selecionar o modelo mais econômico e eficiente disponível no catálogo ativo.
</context>

<objective>
Classificar a intenção e determinar se a solicitação pode ser atendida diretamente por texto puro ou se necessita de execução de ferramentas externas (tool/function calling) ou raciocínio complexo, escolhendo o modelo adequado.
</objective>

<models_catalog>
{{catalogo_modelos}}
</models_catalog>

<routing_guidelines>
1. TAREFA TEXTO PURO (Conversação geral, saudações, esclarecimento de dúvidas simples, resumos informativos):
   - Selecione o modelo de menor custo de input/output do catálogo ativo que seja adequado para conversação direta.
   - requer_ferramentas: false
   - tipo_tarefa: "texto_puro"

2. TAREFA COM FERRAMENTAS (Consulta de preços específicos, verificação de estoque, busca de pedidos, agendamentos, chamadas de API n8n, leitura/escrita em banco de dados):
   - Selecione um modelo com alta confiabilidade de tool-calling (ex: jev, gpt-4o-mini ou equivalente listado no catálogo).
   - requer_ferramentas: true
   - tipo_tarefa: "uso_ferramenta"

3. TAREFA COMPLEXA / CRÍTICA (Cálculos matemáticos complexos, lógica dedutiva avançada, análise de contratos, resolução de conflitos graves):
   - Selecione o modelo de raciocínio avançado presente no catálogo (ex: reasoning/deepseek-reasoner, big-pickle, sonnet).
   - requer_ferramentas: false
   - tipo_tarefa: "raciocinio_complexo"
</routing_guidelines>

<constraints>
- Responda EXCLUSIVAMENTE com um objeto JSON válido.
- NÃO inclua markdown (proibido usar ```json ... ```).
- NÃO inclua introduções, saudações ou texto antes/depois do JSON.
- O campo "modelo_selecionado" DEVE corresponder exatamente a um dos modelos presentes no <models_catalog>.
</constraints>

<output_contract>
{
  "tipo_tarefa": "texto_puro | uso_ferramenta | raciocinio_complexo",
  "requer_ferramentas": false,
  "modelo_selecionado": "string",
  "temperatura_recomendada": 0.2,
  "ferramentas_sugeridas": [],
  "justificativa": "Texto conciso justificando a escolha baseada em custo e capacidade",
  "confianca": 0.95
}
</output_contract>',
  'deepseek/deepseek-chat',
  '["mensagem_usuario", "historico_recente", "catalogo_modelos"]'::jsonb,
  true,
  1
)
ON CONFLICT (chave) DO NOTHING;

-- ============================================================================
-- 12. GOVERNANÇA DE DADOS, PRIVACIDADE POR DESIGN & CONFORMIDADE LGPD (Lei 13.709/2018)
-- ============================================================================
-- Art. 6º, III (Necessidade / Minimização), Art. 15/16 (Término e Retenção),
-- Art. 18, IV e VI (Anonimização / Eliminação) e Art. 37/46 (Auditoria e Segurança).
-- ============================================================================

CREATE TABLE IF NOT EXISTS lgpd_auditoria (
  id BIGSERIAL PRIMARY KEY,
  evento VARCHAR(60) NOT NULL,
  entidade VARCHAR(60) NOT NULL,
  titular_hash_sha256 CHAR(64) NOT NULL,
  detalhes JSONB NOT NULL DEFAULT '{}'::jsonb,
  executado_por VARCHAR(100) NOT NULL DEFAULT CURRENT_USER,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lgpd_auditoria_hash ON lgpd_auditoria (titular_hash_sha256);
CREATE INDEX IF NOT EXISTS idx_lgpd_auditoria_criado ON lgpd_auditoria (criado_em DESC);

-- View de clientes com mascaramento nativo de PII (Privacy by Design para relatórios/auditoria)
CREATE OR REPLACE VIEW vw_clientes_mascarado AS
SELECT
  c.id,
  c.codigo,
  c.nome,
  CASE
    WHEN c.telefone IS NULL OR length(c.telefone) < 6 THEN '***'
    ELSE left(c.telefone, 4) || repeat('*', GREATEST(length(c.telefone) - 8, 4)) || right(c.telefone, 4)
  END AS telefone_mascarado,
  CASE
    WHEN c.email IS NULL OR position('@' IN c.email) <= 1 THEN '***'
    ELSE left(c.email, 1) || '***' || substring(c.email FROM position('@' IN c.email))
  END AS email_mascarado,
  c.ativo,
  c.criado_em,
  c.atualizado_em
FROM clientes c;

-- Direito ao Esquecimento / Eliminação de Titular Final do WhatsApp (Art. 18, VI LGPD)
-- Remove mensagens em memorypostgreschat e grava hash SHA-256 pseudonimizado na trilha de auditoria.
CREATE OR REPLACE FUNCTION fn_lgpd_anonimizar_titular(
  p_identificador TEXT,
  p_motivo TEXT DEFAULT 'Solicitação do titular (Art. 18 LGPD)'
)
RETURNS JSONB AS $$
DECLARE
  v_clean TEXT;
  v_digits TEXT;
  v_hash CHAR(64);
  v_deleted_mem BIGINT := 0;
BEGIN
  v_clean := btrim(COALESCE(p_identificador, ''));
  IF v_clean = '' THEN
    RAISE EXCEPTION 'Identificador do titular não pode ser vazio';
  END IF;

  v_digits := regexp_replace(v_clean, '\D', '', 'g');
  v_hash := encode(digest( COALESCE(NULLIF(v_digits, ''), lower(v_clean)), 'sha256' ), 'hex');

  DELETE FROM memorypostgreschat
  WHERE session_id = v_clean
     OR (v_digits <> '' AND (
          session_id = v_digits
          OR session_id = v_digits || '@s.whatsapp.net'
          OR session_id LIKE '%' || v_digits || '%'
        ));
  GET DIAGNOSTICS v_deleted_mem = ROW_COUNT;

  INSERT INTO lgpd_auditoria (evento, entidade, titular_hash_sha256, detalhes)
  VALUES (
    'ELIMINACAO_TITULAR',
    'memorypostgreschat',
    v_hash,
    jsonb_build_object(
      'mensagens_removidas', v_deleted_mem,
      'motivo', COALESCE(p_motivo, 'Solicitação do titular (Art. 18 LGPD)')
    )
  );

  RETURN jsonb_build_object(
    'sucesso', true,
    'titular_hash_sha256', v_hash,
    'mensagens_removidas', v_deleted_mem
  );
END;
$$ LANGUAGE plpgsql;

-- Anonimização de Cliente / Tenant (Art. 16, I e Art. 18, IV LGPD)
-- Desidentifica PII em clientes e limpa base_conhecimento, preservando o ledger contábil uso_tokens.
CREATE OR REPLACE FUNCTION fn_lgpd_anonimizar_cliente(
  p_cliente_id VARCHAR(100),
  p_motivo TEXT DEFAULT 'Encerramento contratual / Anonimização LGPD'
)
RETURNS JSONB AS $$
DECLARE
  v_codigo BIGINT;
  v_hash CHAR(64);
  v_deleted_rag BIGINT := 0;
BEGIN
  SELECT codigo INTO v_codigo FROM clientes WHERE id = p_cliente_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente % não encontrado', p_cliente_id;
  END IF;

  v_hash := encode(digest(lower(btrim(p_cliente_id)), 'sha256'), 'hex');

  UPDATE clientes
  SET nome = 'ANONIMIZADO-' || v_codigo,
      telefone = NULL,
      email = NULL,
      configuracoes = '{}'::jsonb,
      historico_telefones = '[]'::jsonb,
      ativo = false,
      atualizado_em = NOW()
  WHERE id = p_cliente_id;

  DELETE FROM base_conhecimento WHERE instance_id = p_cliente_id;
  GET DIAGNOSTICS v_deleted_rag = ROW_COUNT;

  INSERT INTO lgpd_auditoria (evento, entidade, titular_hash_sha256, detalhes)
  VALUES (
    'ANONIMIZACAO_CLIENTE',
    'clientes',
    v_hash,
    jsonb_build_object(
      'codigo_cliente', v_codigo,
      'fragmentos_rag_removidos', v_deleted_rag,
      'motivo', COALESCE(p_motivo, 'Encerramento contratual / Anonimização LGPD')
    )
  );

  RETURN jsonb_build_object(
    'sucesso', true,
    'cliente_hash_sha256', v_hash,
    'codigo_preservado', v_codigo,
    'fragmentos_rag_removidos', v_deleted_rag
  );
END;
$$ LANGUAGE plpgsql;

-- Política Automatizada de Retenção e Minimização de Dados (Art. 6º, III e Art. 15 LGPD)
CREATE OR REPLACE FUNCTION fn_lgpd_expurgo_retencao(
  p_dias_memoria INT DEFAULT 90,
  p_dias_auditoria INT DEFAULT 365
)
RETURNS JSONB AS $$
DECLARE
  v_expurgados_mem BIGINT := 0;
  v_expurgados_aud BIGINT := 0;
BEGIN
  IF p_dias_memoria < 1 OR p_dias_auditoria < 30 THEN
    RAISE EXCEPTION 'Janela mínima de retenção inválida (memória >= 1d, auditoria >= 30d)';
  END IF;

  DELETE FROM memorypostgreschat
  WHERE criado_em < NOW() - make_interval(days => p_dias_memoria);
  GET DIAGNOSTICS v_expurgados_mem = ROW_COUNT;

  DELETE FROM lgpd_auditoria
  WHERE criado_em < NOW() - make_interval(days => p_dias_auditoria);
  GET DIAGNOSTICS v_expurgados_aud = ROW_COUNT;

  IF v_expurgados_mem > 0 OR v_expurgados_aud > 0 THEN
    INSERT INTO lgpd_auditoria (evento, entidade, titular_hash_sha256, detalhes)
    VALUES (
      'EXPURGO_RETENCAO',
      'memorypostgreschat',
      encode(digest('system:retention_policy', 'sha256'), 'hex'),
      jsonb_build_object(
        'dias_memoria', p_dias_memoria,
        'mensagens_expurgadas', v_expurgados_mem,
        'auditorias_antigas_expurgadas', v_expurgados_aud
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'sucesso', true,
    'mensagens_expurgadas', v_expurgados_mem,
    'auditorias_expurgadas', v_expurgados_aud
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- AUTENTICAÇÃO, CONTROLE DE ACESSO E GOVERNANÇA LGPD (DASHBOARD ANNE-IA)
-- Normas: OWASP ASVS Lv 2, NIST SP 800-63B, LGPD (Lei 13.709/2018)
-- ============================================================================

-- 1. Usuários do Dashboard
CREATE TABLE IF NOT EXISTS dashboard_usuarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_code VARCHAR(32) UNIQUE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ativo' CHECK (status IN ('pendente', 'ativo', 'bloqueado', 'excluido')),
  role VARCHAR(20) NOT NULL DEFAULT 'operador' CHECK (role IN ('admin', 'operador', 'visualizador')),
  cliente_id VARCHAR(100) REFERENCES clientes(id) ON DELETE SET NULL,
  tentativas_falhas INT NOT NULL DEFAULT 0,
  bloqueado_ate TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dash_usuarios_status ON dashboard_usuarios(status);
CREATE INDEX IF NOT EXISTS idx_dash_usuarios_cliente ON dashboard_usuarios(cliente_id);

-- 2. Identidade Cifrada (Proteção de Titular / PII)
CREATE TABLE IF NOT EXISTS dashboard_identidades (
  user_id UUID PRIMARY KEY REFERENCES dashboard_usuarios(id) ON DELETE CASCADE,
  nome VARCHAR(255) NOT NULL,
  nascimento DATE,
  cpf_cifrado BYTEA,
  cpf_hash CHAR(64) UNIQUE,
  key_id VARCHAR(32) NOT NULL DEFAULT 'v1',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dash_identidades_cpf_hash ON dashboard_identidades(cpf_hash);

-- 3. Contatos do Usuário
CREATE TABLE IF NOT EXISTS dashboard_contatos (
  user_id UUID PRIMARY KEY REFERENCES dashboard_usuarios(id) ON DELETE CASCADE,
  email VARCHAR(255) UNIQUE NOT NULL,
  email_verificado_em TIMESTAMPTZ,
  telefone VARCHAR(30),
  telefone_verificado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dash_contatos_email ON dashboard_contatos(LOWER(email));

-- 4. Credenciais e Hash de Senha (NIST SP 800-63B)
CREATE TABLE IF NOT EXISTS dashboard_credenciais (
  user_id UUID PRIMARY KEY REFERENCES dashboard_usuarios(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  algoritmo VARCHAR(30) NOT NULL DEFAULT 'scrypt',
  parametros JSONB NOT NULL DEFAULT '{"cost":16384,"blockSize":8,"parallelism":1}'::jsonb,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Sessões Server-Side Opaque (Tokens rotativos / Revogáveis)
CREATE TABLE IF NOT EXISTS dashboard_sessoes (
  id_hash CHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES dashboard_usuarios(id) ON DELETE CASCADE,
  ip VARCHAR(45),
  user_agent TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultimo_uso TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_em TIMESTAMPTZ NOT NULL,
  revogado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_dash_sessoes_expira ON dashboard_sessoes(expira_em);
CREATE INDEX IF NOT EXISTS idx_dash_sessoes_user ON dashboard_sessoes(user_id);

-- 6. Consentimentos Explícitos LGPD (Art. 7º, I e Art. 8º Lei 13.709/2018)
CREATE TABLE IF NOT EXISTS dashboard_consentimentos (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES dashboard_usuarios(id) ON DELETE CASCADE,
  documento VARCHAR(50) NOT NULL CHECK (documento IN ('termos_uso', 'politica_privacidade', 'marketing')),
  versao VARCHAR(20) NOT NULL,
  aceito_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip VARCHAR(45) NOT NULL,
  user_agent TEXT,
  revogado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_dash_consentimentos_user ON dashboard_consentimentos(user_id, documento);

-- 7. Auditoria de Autenticação (Marco Civil Art. 15 e OWASP Logging)
CREATE TABLE IF NOT EXISTS dashboard_auditoria_auth (
  id BIGSERIAL PRIMARY KEY,
  quando TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id UUID REFERENCES dashboard_usuarios(id) ON DELETE SET NULL,
  identificador VARCHAR(255),
  evento VARCHAR(50) NOT NULL,
  sucesso BOOLEAN NOT NULL,
  ip VARCHAR(45),
  user_agent TEXT,
  detalhes JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_dash_auditoria_quando ON dashboard_auditoria_auth(quando DESC);
CREATE INDEX IF NOT EXISTS idx_dash_auditoria_ip_evento ON dashboard_auditoria_auth(ip, evento, quando DESC);




