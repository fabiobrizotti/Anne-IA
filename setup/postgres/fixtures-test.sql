-- ============================================================================
-- FIXTURES SINTÉTICAS DE TESTE MULTI-TENANT (CI / DAST / PENTEST)
-- Inquilinos: pentest_tenant_alpha e pentest_tenant_beta
-- Operador Beta: beta@pentest.local / SenhaBeta#2026
-- ============================================================================

-- 1. Inquilinos (clientes)
INSERT INTO clientes (id, nome, status, max_instances, max_tokens_dia)
VALUES
  ('pentest_tenant_alpha', 'Tenant Alpha Pentest', 'ativo', 5, 1000000),
  ('pentest_tenant_beta', 'Tenant Beta Pentest', 'ativo', 5, 1000000)
ON CONFLICT (id) DO UPDATE SET
  nome = EXCLUDED.nome,
  status = EXCLUDED.status;

-- 2. Instâncias vinculadas (compatibilidade Evolution API)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'Instance') THEN
    INSERT INTO "Instance" (id, name, status, created_at, updated_at)
    VALUES
      ('pentest_tenant_alpha', 'pentest_tenant_alpha', 'open', NOW(), NOW()),
      ('pentest_tenant_beta', 'pentest_tenant_beta', 'open', NOW(), NOW())
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- 3. Configuração de Prompt confidencial por Tenant (BOLA test target)
INSERT INTO prompt_config (id, system_prompt, temperatura, top_p, criado_em, atualizado_em)
VALUES
  ('pentest_tenant_alpha', 'Prompt ultra-secreto e confidencial do Inquilino Alpha - Acesso restrito', 0.7, 0.9, NOW(), NOW()),
  ('pentest_tenant_beta', 'Prompt operacional do Inquilino Beta', 0.7, 0.9, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  system_prompt = EXCLUDED.system_prompt;

-- 4. Registros financeiros / consumo de tokens (BOLA financeiro test target)
INSERT INTO uso_tokens (cliente_id, instance_id, total_tokens, custo_usd, data_hora)
VALUES
  ('pentest_tenant_alpha', 'pentest_tenant_alpha', 15000, 0.4500, NOW() - INTERVAL '1 hour'),
  ('pentest_tenant_beta', 'pentest_tenant_beta', 4200, 0.1260, NOW() - INTERVAL '30 minutes')
ON CONFLICT DO NOTHING;

-- 5. Usuários do Dashboard (RBAC / Isolamento Multi-Tenant)
INSERT INTO dashboard_usuarios (id, customer_code, status, role, cliente_id, criado_em, atualizado_em)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'PENTEST-ALPHA', 'ativo', 'operador', 'pentest_tenant_alpha', NOW(), NOW()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'PENTEST-BETA', 'ativo', 'operador', 'pentest_tenant_beta', NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  status = EXCLUDED.status,
  role = EXCLUDED.role,
  cliente_id = EXCLUDED.cliente_id;

-- 6. Contatos (E-mails para autenticação)
INSERT INTO dashboard_contatos (user_id, email, email_verificado_em, criado_em, atualizado_em)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'alpha@pentest.local', NOW(), NOW(), NOW()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'beta@pentest.local', NOW(), NOW(), NOW())
ON CONFLICT (user_id) DO UPDATE SET
  email = EXCLUDED.email;

-- 7. Identidades
INSERT INTO dashboard_identidades (user_id, nome, criado_em, atualizado_em)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Operador Alpha Pentest', NOW(), NOW()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Operador Beta Pentest', NOW(), NOW())
ON CONFLICT (user_id) DO UPDATE SET
  nome = EXCLUDED.nome;

-- 8. Credenciais scrypt (RFC 7914 - SenhaBeta#2026 com salt canônico)
-- Hash computado: N=16384, r=8, p=1, salt=00112233445566778899aabbccddeeff
INSERT INTO dashboard_credenciais (user_id, password_hash, algoritmo, parametros, atualizado_em)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'scrypt$16384$8$1$00112233445566778899aabbccddeeff$e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'scrypt', '{"cost":16384,"blockSize":8,"parallelism":1}'::jsonb, NOW()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'scrypt$16384$8$1$00112233445566778899aabbccddeeff$17df712866946bf8e1b6ff08044ce4a622df149b1a0e5b721e06573e8e7a6850239cfd00344cff205167b1b590e8e75f0a05a06516a504ef56be5e003ba7f272', 'scrypt', '{"cost":16384,"blockSize":8,"parallelism":1}'::jsonb, NOW())
ON CONFLICT (user_id) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  atualizado_em = NOW();

-- 9. Consentimentos LGPD
INSERT INTO dashboard_consentimentos (user_id, documento, versao, ip, user_agent, criado_em)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'termos_uso', 'v1.0', '127.0.0.1', 'CI-Pentest-Runner', NOW()),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'politica_privacidade', 'v1.0', '127.0.0.1', 'CI-Pentest-Runner', NOW()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'termos_uso', 'v1.0', '127.0.0.1', 'CI-Pentest-Runner', NOW()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'politica_privacidade', 'v1.0', '127.0.0.1', 'CI-Pentest-Runner', NOW())
ON CONFLICT DO NOTHING;
