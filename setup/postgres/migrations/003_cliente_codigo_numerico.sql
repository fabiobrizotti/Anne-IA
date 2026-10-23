-- ============================================================================
-- Migração 003: Adicionar código numérico sequencial aos clientes
-- Idempotente e não-destrutiva
-- ============================================================================

\connect anneia

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clientes' AND column_name = 'codigo'
  ) THEN
    ALTER TABLE clientes ADD COLUMN codigo BIGSERIAL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_codigo ON clientes (codigo);
