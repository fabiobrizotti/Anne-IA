-- ============================================================================
-- FIXTURES SINTÉTICAS DE TESTE MULTI-TENANT (CI / DAST / PENTEST)
-- ============================================================================
-- Alvo: banco `anneia` (tabelas de negócio), NÃO o banco `evolution`.
-- Idempotente: pode ser reaplicado sem duplicar linhas.
--
-- Inquilinos:
--   pentest_tenant_alpha  (operador alpha@pentest.local)
--   pentest_tenant_beta   (operador beta@pentest.local / SenhaBeta#2026)
--
-- IMPORTANTE: as colunas abaixo espelham setup/postgres/init.sql. Se o schema
-- mudar, atualize este arquivo — caso contrário o job `dast` do CI quebra em
-- "column ... does not exist" (foi o que aconteceu com status/max_instances).
-- ============================================================================

-- 1. Inquilinos (clientes). Colunas NOT NULL sem default: id, nome.
--    (ativo, configuracoes, historico_telefones e codigo têm default)
INSERT INTO clientes (id, nome, telefone, email, ativo)
VALUES
  ('pentest_tenant_alpha', 'Tenant Alpha Pentest', '5511999990001', 'alpha@pentest.local', true),
  ('pentest_tenant_beta',  'Tenant Beta Pentest',  '5511999990002', 'beta@pentest.local',  true)
ON CONFLICT (id) DO UPDATE SET
  nome = EXCLUDED.nome,
  ativo = EXCLUDED.ativo;

-- 2. Instâncias vinculadas (compatibilidade Evolution API)
--    connectionStatus é enum InstanceConnectionStatus e tem default 'open'
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'Instance') THEN
    INSERT INTO "Instance" (id, name)
    VALUES
      ('pentest_tenant_alpha', 'pentest_tenant_alpha'),
      ('pentest_tenant_beta',  'pentest_tenant_beta')
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- 3. Prompt confidencial por Tenant (alvo do teste BOLA)
--    Só id e system_prompt são necessários: as demais NOT NULL têm default ''
INSERT INTO prompt_config (id, system_prompt)
VALUES
  ('pentest_tenant_alpha', 'Prompt ultra-secreto e confidencial do Inquilino Alpha - Acesso restrito'),
  ('pentest_tenant_beta',  'Prompt operacional do Inquilino Beta')
ON CONFLICT (id) DO UPDATE SET
  system_prompt = EXCLUDED.system_prompt;

-- 4. Consumo de tokens (alvo do teste BOLA financeiro)
--    Nenhuma constraint única além de id (serial), então o filtro evita duplicar
INSERT INTO uso_tokens (cliente_id, instance_id, origem, provedor, modelo,
                        prompt_tokens, completion_tokens, total_tokens, custo_usd)
-- `origem` tem CHECK (origem IN ('n8n','9router_sync','manual')) — 'pentest' viola.
-- Usamos 'manual' e marcamos o modelo com o prefixo `pentest-` para identificar
-- com segurança as linhas sintéticas na limpeza pós-teste.
SELECT * FROM (VALUES
  ('pentest_tenant_alpha', 'pentest_tenant_alpha', 'manual', 'openai', 'pentest-gpt-4o-mini', 12000, 3000, 15000, 0.4500),
  ('pentest_tenant_beta',  'pentest_tenant_beta',  'manual', 'openai', 'pentest-gpt-4o-mini',  3400,  800,  4200, 0.1260)
) AS v(cliente_id, instance_id, origem, provedor, modelo, pt, ct, tt, cu)
WHERE NOT EXISTS (
  SELECT 1 FROM uso_tokens u
  WHERE u.cliente_id = v.cliente_id AND u.modelo = 'pentest-gpt-4o-mini'
);

-- 5. Usuários do Dashboard (RBAC / isolamento multi-tenant)
INSERT INTO dashboard_usuarios (id, customer_code, status, role, cliente_id)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'PENTEST-ALPHA', 'ativo', 'operador', 'pentest_tenant_alpha'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'PENTEST-BETA',  'ativo', 'operador', 'pentest_tenant_beta')
ON CONFLICT (id) DO UPDATE SET
  status = EXCLUDED.status,
  role = EXCLUDED.role,
  cliente_id = EXCLUDED.cliente_id;

-- 6. Contatos (e-mail de autenticação)
INSERT INTO dashboard_contatos (user_id, email, email_verificado_em)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'alpha@pentest.local', NOW()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'beta@pentest.local',  NOW())
ON CONFLICT (user_id) DO UPDATE SET
  email = EXCLUDED.email;

-- 7. Identidades
INSERT INTO dashboard_identidades (user_id, nome)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Operador Alpha Pentest'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Operador Beta Pentest')
ON CONFLICT (user_id) DO UPDATE SET
  nome = EXCLUDED.nome;

-- 8. Credenciais scrypt — senha SenhaBeta#2026 (ambos os operadores)
--    Formato: scrypt$N$r$p$salt_hex$hash_hex (compatível com dashboard/src/auth.js)
--    Hash gerado com N=16384, r=8, p=1, keylen=64, salt=00112233445566778899aabbccddeeff
--    e VERIFICADO por verifyPassword() antes de entrar no repositório.
INSERT INTO dashboard_credenciais (user_id, password_hash)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'scrypt$16384$8$1$00112233445566778899aabbccddeeff$6bf82d86ca98f61b88ff2e0224786fe798af9f2f076e5d540ca6618111cc21621308980efec0549f058e6779e8fe0feeed2a12ba0125b6b6f7bc64a180ae4fbd'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'scrypt$16384$8$1$00112233445566778899aabbccddeeff$6bf82d86ca98f61b88ff2e0224786fe798af9f2f076e5d540ca6618111cc21621308980efec0549f058e6779e8fe0feeed2a12ba0125b6b6f7bc64a180ae4fbd')
ON CONFLICT (user_id) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  atualizado_em = NOW();

-- 9. Consentimentos LGPD (aceito_em tem default now())
--    ATENÇÃO: a tabela só tem PK serial — `ON CONFLICT DO NOTHING` não protege
--    nada e cada execução duplicaria as linhas. A idempotência é feita aqui.
INSERT INTO dashboard_consentimentos (user_id, documento, versao, ip)
SELECT v.user_id, v.documento, v.versao, v.ip
FROM (VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'termos_uso', 'v1.0', '127.0.0.1'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'politica_privacidade', 'v1.0', '127.0.0.1'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 'termos_uso', 'v1.0', '127.0.0.1'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid, 'politica_privacidade', 'v1.0', '127.0.0.1')
) AS v(user_id, documento, versao, ip)
WHERE NOT EXISTS (
  SELECT 1 FROM dashboard_consentimentos c
  WHERE c.user_id = v.user_id AND c.documento = v.documento AND c.versao = v.versao
);
