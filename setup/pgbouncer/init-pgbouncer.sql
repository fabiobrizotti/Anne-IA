-- ============================================================================
-- PGBOUNCER - PROVISIONAMENTO DE ROLES E SCHEMA DE AUTENTICAÇÃO (IDEMPOTENTE)
-- ============================================================================
-- Executado automaticamente pelo container db-evolution via init.sql
-- (pode ser incluído no init.sql principal ou rodado separadamente).
-- ============================================================================

-- 1. Schema dedicado para objetos do PgBouncer
CREATE SCHEMA IF NOT EXISTS pgbouncer AUTHORIZATION postgres;

-- 2. Role de aplicação (usado pelo Dashboard, Evolution API, etc.)
-- Senha vem da variável PGBOUNCER_PASSWORD (injetada via entrypoint do Postgres)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgbouncer_app') THEN
    CREATE ROLE pgbouncer_app
      LOGIN
      PASSWORD current_setting('app.pgbouncer_password', true)
      NOINHERIT
      CONNECTION LIMIT 50;
    RAISE NOTICE 'Role pgbouncer_app criada';
  ELSE
    ALTER ROLE pgbouncer_app
      PASSWORD current_setting('app.pgbouncer_password', true)
      CONNECTION LIMIT 50;
    RAISE NOTICE 'Role pgbouncer_app atualizada';
  END IF;
END $$;

-- 3. Role admin (para console admin do PgBouncer: SHOW POOLS, SHOW STATS, etc.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgbouncer_admin') THEN
    CREATE ROLE pgbouncer_admin
      LOGIN
      PASSWORD current_setting('app.pgbouncer_admin_password', true)
      NOINHERIT
      CONNECTION LIMIT 5;
    RAISE NOTICE 'Role pgbouncer_admin criada';
  ELSE
    ALTER ROLE pgbouncer_admin
      PASSWORD current_setting('app.pgbouncer_admin_password', true)
      CONNECTION LIMIT 5;
    RAISE NOTICE 'Role pgbouncer_admin atualizada';
  END IF;
END $$;

-- 4. Role para auth_query (se optar por usar auth_query no futuro)
-- Com SCRAM + userlist.txt, não é estritamente necessário, mas mantido para flexibilidade.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgbouncer_auth') THEN
    CREATE ROLE pgbouncer_auth
      NOLOGIN
      NOINHERIT;
    RAISE NOTICE 'Role pgbouncer_auth criada';
  END IF;
END $$;

-- 5. Função get_auth para auth_query (opcional, requer pgbouncer_auth com permissão)
-- Retorna usename e passwd (SCRAM) para o usuário solicitado.
-- ATENÇÃO: Só usar se migrar de userlist.txt para auth_query.
-- Prisma (Evolution API) tem problemas conhecidos com auth_query.
CREATE OR REPLACE FUNCTION pgbouncer.get_auth(p_username TEXT)
RETURNS TABLE (usename TEXT, passwd TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgbouncer, pg_catalog
AS $$
BEGIN
  -- Validação básica para evitar enumeração
  IF p_username NOT IN ('pgbouncer_app', 'pgbouncer_admin') THEN
    RETURN QUERY SELECT NULL::TEXT, NULL::TEXT;
  END IF;

  -- Busca o hash SCRAM do pg_authid (requer permissão de leitura)
  RETURN QUERY
  SELECT rolname::TEXT,
         rolpassword::TEXT
  FROM pg_authid
  WHERE rolname = p_username
    AND rolcanlogin;
END;
$$;

-- 6. Permissões para pgbouncer_auth executar get_auth
GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(TEXT) TO pgbouncer_auth;

-- 7. Permissões nas tabelas de negócio para pgbouncer_app
-- O pool anneia (transaction) usa esta role.
-- As permissões reais são gerenciadas pelo schema anneia (init.sql principal).
-- Aqui apenas garantimos USAGE no schema.
GRANT USAGE ON SCHEMA public TO pgbouncer_app;
GRANT USAGE ON SCHEMA anneia TO pgbouncer_app;  -- se schema anneia existir separado

-- 8. Configurações de proteção no Postgres para roles do PgBouncer
-- Evita que uma transação travada segure o pool inteiro.
ALTER ROLE pgbouncer_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE pgbouncer_app SET statement_timeout = '15s';
ALTER ROLE pgbouncer_admin SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE pgbouncer_admin SET statement_timeout = '30s';

-- 9. Comentários para documentação
COMMENT ON ROLE pgbouncer_app IS 'Role de aplicação para PgBouncer (transaction pool)';
COMMENT ON ROLE pgbouncer_admin IS 'Role admin para console PgBouncer (session pool)';
COMMENT ON ROLE pgbouncer_auth IS 'Role para auth_query (opcional, não usada com userlist.txt)';
COMMENT ON FUNCTION pgbouncer.get_auth(TEXT) IS 'Retorna credenciais SCRAM para auth_query do PgBouncer';