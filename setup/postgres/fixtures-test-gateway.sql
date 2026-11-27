-- ============================================================================
-- FIXTURE SINTÉTICA DO SPEND DO GATEWAY (CI / DAST / PENTEST)
-- ============================================================================
-- Uso exclusivo de teste. Em produção o schema é criado pelo LiteLLM e o SSOT
-- do banco de negócio continua sendo setup/postgres/init.sql.
--
-- O job `dast` sobe somente db-evolution + pgbouncer + dashboard (sem o
-- serviço litellm). Sem esta tabela, /api/v1/financeiro falha fechado com 503
-- e a bateria de pentest reprova o acesso autorizado e o UNION SELECT.
-- ============================================================================

\connect litellm

CREATE TABLE IF NOT EXISTS "LiteLLM_SpendLogs" (
  request_id text PRIMARY KEY,
  "end_user" text,
  model text NOT NULL DEFAULT '',
  spend double precision NOT NULL DEFAULT 0,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer NOT NULL DEFAULT 0,
  "startTime" timestamp(3) without time zone NOT NULL,
  "endTime" timestamp(3) without time zone NOT NULL
);

-- O dashboard lê o spend pelo pool `litellm` do PgBouncer (pgbouncer_app).
GRANT USAGE ON SCHEMA public TO pgbouncer_app;
GRANT SELECT ON TABLE "LiteLLM_SpendLogs" TO pgbouncer_app;

INSERT INTO "LiteLLM_SpendLogs"
  (request_id, "end_user", model, spend, prompt_tokens, completion_tokens, total_tokens, "startTime", "endTime")
VALUES
  ('pentest-gateway-spend', 'pentest_tenant_alpha', 'pentest-gpt-4o-mini',
   0.0123, 100, 25, 125,
   (NOW() - INTERVAL '1 hour')::timestamp, (NOW() - INTERVAL '30 minutes')::timestamp)
ON CONFLICT (request_id) DO NOTHING;
