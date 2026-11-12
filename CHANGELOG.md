# Changelog

Todas as alterações notáveis neste projeto serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/),
e este projeto adere ao [Semantic Versioning (SemVer)](https://semver.org/lang/pt-BR/).

---

## [1.1.0] - 2026-11-12

### Adicionado
- **Autenticação e Conformidade LGPD**:
  - Telas de Login, Cadastro e Recuperação com hashing `scrypt`, rate limiting em memória (`express-rate-limit`) e cookies `HttpOnly`, `SameSite=Lax`.
  - Consentimento explícito LGPD no cadastro, termo de uso e rastreabilidade com IP e User-Agent.
- **Painel Financeiro & FinOps**:
  - Telemetria de consumo de tokens segregada por cliente e instância via RabbitMQ assíncrono e função PostgreSQL `fn_registrar_uso_tokens`.
  - Métricas de rendimento e poder de compra de $1.00 USD por modelo no catálogo.
- **Gestão de Modelos de IA & 9Router**:
  - Catálogo de modelos com descoberta automática do 9Router e classificação por tiers (Gratuito, Raciocínio, Entrada, Flagship).
  - Teste de inferência seguro em sandbox no Dashboard.
- **Base de Conhecimento RAG**:
  - Gestão de documentos e coleções com vetorização via pgvector e isolamento multi-tenant.
- **Ficha de Clientes e Configuração de Prompts**:
  - Vínculo 1:1 estrito entre `clientes.id` e `Instance.id`.
  - Edição de prompts, parâmetros e histórico de telefones por instância.
- **CI/CD Hardened & Qualidade**:
  - Pipeline GitHub Actions com validação de sintaxe JS (`node --check`), Shell (`shellcheck`), Python (`py_compile`), workflows (`actionlint`), SAST (`Semgrep` e `Trivy`) e testes automatizados.
  - Suíte de testes unitários com runner nativo Node.js (`node --test`).

### Corrigido
- **Segurança (Pentest)**:
  - Remediação de vulnerabilidades OWASP BFLA e BOLA com controle de acesso rigoroso por instância e tenant.
  - Expurgo de credenciais, `pinData` e `instanceId` na sanitização de workflows do n8n.
  - Binding RabbitMQ da exchange Evolution com routing key `messages.upsert`.

### Modificado
- Design monocromático neutro no Dashboard com tema claro padrão e suporte a `prefers-color-scheme`.
- Cache-busting de assets estáticos do Dashboard (`app.js?v=1.1.0`).

---

## [1.0.0] - 2026-10-19

### Adicionado
- **Arquitetura Industrial de Mensageria**:
  - Ingestão assíncrona da Evolution API via RabbitMQ Quorum Queues com Dead Letter Exchange (DLX) e Dead Letter Queue (DLQ).
  - Políticas de retenção e tolerância a falhas para mensageria WhatsApp em alta escala.
- **Banco de Dados Multi-Tenant & Vetorial**:
  - PostgreSQL 15 com extensão `pgvector` inicializado via `setup/postgres/init.sql` (SSOT idempotente).
  - Tabelas de clientes, instâncias, vetores e rotinas de anonimização LGPD nativas.
- **Roteamento de IA**:
  - Integração do 9Router v0.5.104 parametrizado via `.env` para fallback de provedores de IA.
- **Dashboard Administrativo Vanilla**:
  - Painel zero-build (<30MB RAM) em Vanilla JS/HTML5/CSS3 servido por Node.js 20 Alpine com Express e `pg`.
  - Gestão de conexões via Pairing Code (8 dígitos) e QR Code.
- **Infraestrutura Docker & Governança**:
  - Docker Compose 100% parametrizado via `.env` (zero hardcode).
  - Scripts utilitários: `sync-env.sh`, `generate-passwords.sh` (senhas Base62 alfanuméricas).
  - Isolamento de redes `public_net` e `data_net` com binds locais `127.0.0.1`.
