-- ============================================================================
-- ANNE IA — GRANTS DO CLICKHOUSE (Langfuse v4, single-container)
-- ============================================================================
-- Montado em /docker-entrypoint-initdb.d/ do container clickhouse.
-- O usuário é criado pela env CLICKHOUSE_USER=langfuse do entrypoint oficial;
-- a senha vem de CLICKHOUSE_PASSWORD (.env), nunca deste arquivo.
-- GRANT é idempotente: pode reaplicar em volume existente sem erro.
-- Fonte: https://langfuse.com/self-hosting/deployment/infrastructure/clickhouse
-- ============================================================================

-- Leitura e escrita dos dados de tracing.
GRANT SELECT, INSERT ON default.* TO 'langfuse';

-- Retenção de dados, exclusão de projetos/traces e atualização de eventos.
GRANT ALTER UPDATE, ALTER DELETE ON default.* TO 'langfuse';

-- Migrações de schema aplicadas pelo Langfuse na inicialização.
GRANT CREATE, DROP TABLE, DROP VIEW ON default.* TO 'langfuse';
GRANT ALTER ADD COLUMN, ALTER MODIFY COLUMN, ALTER VIEW MODIFY QUERY ON default.* TO 'langfuse';
GRANT ALTER ADD INDEX, ALTER DROP INDEX, ALTER MATERIALIZE INDEX ON default.* TO 'langfuse';

-- Leitura de tabelas de sistema para trabalhos em segundo plano.
GRANT SELECT(database, table, name, partition, partition_id, active, rows) ON system.parts TO 'langfuse';
GRANT SELECT(database, table, is_done) ON system.mutations TO 'langfuse';
GRANT SELECT(database, name, engine) ON system.tables TO 'langfuse';
GRANT SELECT ON system.processes TO 'langfuse';
GRANT SELECT ON system.query_log* TO 'langfuse';

-- Controle de merges da tabela intermediária do backfill histórico v4.
-- Necessário em self-managed (CLICKHOUSE_CLUSTER_ENABLED=false).
GRANT SYSTEM SYNC REPLICA, SYSTEM MERGES, ALTER SETTINGS ON default.observations_pid_tid_sorting TO 'langfuse';
