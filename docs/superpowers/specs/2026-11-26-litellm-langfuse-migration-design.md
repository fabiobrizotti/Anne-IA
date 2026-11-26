# Design: substituir 9Router por LiteLLM e adicionar Langfuse v4

## Intenção e motivo

O 9Router hoje é o gateway OpenAI-compatible da stack. Ele não entrega limite de gasto por cliente, tem `cost` próprio (estimativa de savings, `0.0` em modelos free) e exige uma senha admin (`INITIAL_PASSWORD`). O usuário decidiu em 2026-11-26: **remover o 9Router por completo**, adotar o LiteLLM como gateway padrão (`litellm/litellm:lts`) e adicionar observabilidade com Langfuse self-hosted (`langfuse/langfuse:4`).

Escopo escolhido pelo usuário: **abordagem B**. O `ANNE-AI-CORE-ORCHESTRATOR` continua chamando a OpenRouter direto pelo nó `LLM: OpenRouter` — memória, tools e fluxo assíncrono permanecem intactos. O LiteLLM assume apenas os papéis que hoje são do 9Router: catálogo/teste de modelos no Dashboard, `LLM_API_BASE` do Strix e endpoint OpenAI-compatible genérico. O Langfuse recebe traces dos chamados que passam pelo LiteLLM; os chamados do Agente dependem de configuração externa na OpenRouter (Broadcast), fora do código.

## Objetivos

1. Nenhum processo, variável, endpoint ou diretório ativo referencie 9Router após a entrega.
2. Após o bootstrap explícito do SQL no Postgres em execução, `docker compose up -d` suba `litellm`, `langfuse-web`, `langfuse-worker`, `clickhouse`, `minio` e `langfuse-redis`, com healthchecks e limites de memória.
3. Dashboard continue mostrando status do gateway, lista de modelos e teste de ping/inferência — agora contra o LiteLLM.
4. LiteLLM tenha Postgres dedicado para chaves/Admin UI/spend e publique traces no Langfuse via preset oficial `langfuse_otel`.
5. Langfuse v4 funcione com web + worker + Postgres + ClickHouse + Redis + bucket S3 (MinIO), sem expor ClickHouse/MinIO ao host e sem multimodal (upload de mídia desativado).
6. README, `.env.example`, scripts de senha/verificação e `AGENTS.md` reflitam a nova stack na mesma entrega.

## Não-objetivos e anti-objetivos

- Não colocar o Agente do n8n atrás do LiteLLM nesta entrega (decisão B); não trocar `lmChatOpenRouter`, não mexer em memória/tools/workflow.
- Não implementar cobrança/limite por cliente do Agente — pendência separada, já registrada no vault.
- Não usar o compose do quickstart baixado por `curl`: aqui o compose é versionado e toda versão, porta, bind e credencial vem do `.env`.
- Não apagar `data/9router/` do host sem confirmação explícita; apenas desmontar o serviço.
- Não criar migration avulsa: toda criação de banco/role entra em `setup/postgres/init.sql`, idempotente. Grants do ClickHouse ficam em `setup/clickhouse/init.sql`, artefato separado e também idempotente.
- Não vazar master key do LiteLLM, chaves do Langfuse ou segredos do MinIO para navegador, logs, README ou vault.
- Não expor portas de administração fora de `127.0.0.1`.

## Restrições do repositório

- Working directory `/home/brizotti/repos/Anne-IA`, branch `dev`; Conventional Commits; sem push em `main`.
- `setup/postgres/init.sql` é SSOT do schema. O padrão já existente para `CREATE DATABASE` é `SELECT 'CREATE DATABASE ...' WHERE NOT EXISTS (...)\gexec`, antes de qualquer `\connect` (linhas 13-18).
- Compose com parametrização absoluta: nenhuma porta, versão de imagem, host ou credencial hardcoded (AGENTS.md §1).
- `.env.example` é a fonte da verdade estrutural; novas chaves entram por `scripts/sync-env.sh`, que preserva valores locais com backup `.env.bak` e `chmod 600`.
- Senhas de infraestrutura em Base62, 32 caracteres, sem símbolos que quebrem URIs (`scripts/generate-passwords.sh`).
- Dashboard permanece Vanilla HTML/CSS/JS zero-build; uma mudança de UI exige validação em navegador real (Playwright/Chrome DevTools).
- Toda alteração de serviço, porta, endpoint, variável ou tabela atualiza `README.md` na mesma entrega.

## Abordagens consideradas

| Abordagem | O que entrega | Trade-off | Veredito |
|---|---|---|---|
| **A — LiteLLM no caminho do Agente** | Sub-nó `lmChatOpenAi` apontando para o LiteLLM, chave virtual por cliente, `extraBody` com `user`/`session_id`/`trace`, teto real de gasto | Exige editar o workflow no repo externo; muda credential do Agente; enfrenta o problema de item 0 do sub-node | Rejeitada pelo usuário nesta entrega |
| **B — LiteLLM substitui só o 9Router (escolhida)** | Gateway para Dashboard/Strix, Agente segue direto na OpenRouter, Langfuse observa o que passa pelo gateway | Sem limite de gasto por cliente no Agente; rastros do Agente dependem de Broadcast na OpenRouter | **Adotada** |
| **Manter 9Router e só anexar Langfuse** | Menor diff | Contraria a decisão de padronizar no LiteLLM e mantém `cost` estimado | Rejeitada |

## Decisões fechadas

### Imagens e versões

- `LITELLM_VERSION=lts` → imagem `litellm/litellm:${LITELLM_VERSION}`. A tag `lts` é móvel; o programa LTS é um piloto iniciado em 2026-11-02 com janela de cerca de um mês, e a própria LiteLLM recomenda pinar `1.108.2`/`1.108.2-lts` em produção. O usuário escolheu `lts` explicitamente. Registrar a data da imagem em `/api/health` e rever a pinagem até 2026-12-02. [LiteLLM LTS pilot: https://docs.litellm.ai/docs/enterprise/lts_pilot]
- `LANGFUSE_VERSION=4` → `langfuse/langfuse:${LANGFUSE_VERSION}` (web) e `langfuse/langfuse-worker:${LANGFUSE_VERSION}` (worker). [Langfuse containers: https://langfuse.com/self-hosting/deployment/infrastructure/containers]

### Banco de dados

- Reaproveitar o container `db-evolution` (Postgres já existente) com **dois bancos lógicos novos**: `litellm` e `langfuse`. Evita um quarto servidor Postgres.
- `setup/postgres/init.sql`: criar ambos com o padrão `\gexec` antes do `\connect anneia`, e criar os roles `litellm` e `langfuse` de forma idempotente (`DO $$ ... IF NOT EXISTS ... CREATE ROLE ... END $$`) com senhas vindas de variáveis de ambiente. Reaplicar o SQL em container ativo não pode alterar senhas já existentes — se o role existir, manter como está (senha gerida pelo `.env` e pelo administrador).
- LiteLLM: `DATABASE_URL=postgresql://litellm:${LITELLM_DB_PASSWORD}@db-evolution:${POSTGRES_CONTAINER_PORT}/litellm`. Postgres é **obrigatório** para chaves virtuais, Admin UI e spend tracking. [LiteLLM virtual keys: https://docs.litellm.ai/docs/proxy/virtual_keys]
- Langfuse: `DATABASE_URL=postgresql://langfuse:${LANGFUSE_DB_PASSWORD}@db-evolution:${POSTGRES_CONTAINER_PORT}/langfuse`.
- **Bootstrap obrigatório em stack já instalada:** `docker-entrypoint-initdb.d` roda apenas com PGDATA vazio (`docker-compose.yml:212-213` monta `./data/postgresql`). Antes de subir os serviços novos, aplicar manualmente, usando o procedimento já documentado em `README.md:461-466`:

  ```bash
  docker exec -i db-evolution psql -v ON_ERROR_STOP=1 -U ${POSTGRES_USER} -d anneia < setup/postgres/init.sql
  ```

  O comando é idempotente e não apaga dados. O README da mesma entrega deve registrá-lo como pré-requisito; o Compose sozinho **não** cria os bancos `litellm`/`langfuse` num volume existente.

### LiteLLM

- Serviço `litellm`, porta host ofuscada `LITELLM_PORT` (bind `127.0.0.1`), porta container `LITELLM_CONTAINER_PORT=4000`, rede `data_net`.
- Healthcheck: `wget -q --spider http://127.0.0.1:${LITELLM_CONTAINER_PORT}/health/liveliness`. `/health/readiness` também existe e verifica DB; usar `/health/liveliness` no Compose para não derrubar o serviço em janela de indisponibilidade do Postgres. [LiteLLM health: https://docs.litellm.ai/docs/proxy/health]
- Segredos: `LITELLM_MASTER_KEY` (admin + chamadas do Dashboard/Strix) e `LITELLM_SALT_KEY` (cifra dos provider keys). **`LITELLM_SALT_KEY` não tem rotação in-place**: depois que um provider key for salvo, trocar esse valor torna a credencial ilegível. [LiteLLM quickstart: https://docs.litellm.ai/docs/proxy/docker_quick_start]
- Provider key da OpenRouter (`OPENROUTER_API_KEY`) entra no container por `.env`, nunca no `config.yaml` versionado.
- `setup/litellm/config.yaml` versionado com `model_list` mínimo (os modelos hoje em `precos_modelos`) e `litellm_settings.callbacks: ["langfuse_otel"]`. Modelo fora da lista deve ser adicionado ao config — o teste do Dashboard falhará com erro claro se o modelo não existir no gateway.
- Observabilidade: `LITELLM_OTEL_V2=true`, `LITELLM_OTEL_LANGFUSE_SPAN_SCOPE=llm_only`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST=http://langfuse-web:3000`. Sem `llm_only`, todos os spans do proxy são enviados e o volume/custo no Langfuse dispara. [LiteLLM OTel v2: https://docs.litellm.ai/docs/observability/opentelemetry_v2]
- **Conteúdo das mensagens:** `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` deve ser definido explicitamente. Sem valor, o LiteLLM cai no legado `message_logging=true` (`SPAN_AND_EVENT`) e passa a persistir prompts e respostas. Padrão adotado: `NO_CONTENT` — o Langfuse mostra modelo, tokens, custo e latência, sem input/output. Opt-in para `SPAN_ONLY` só com avaliação LGPD, pois mensagens de clientes passam a ser armazenadas no Langfuse. [Capturing message content: https://docs.litellm.ai/docs/observability/opentelemetry_integration]

### Langfuse v4

- Seis serviços novos no total contando o LiteLLM: `litellm`, `langfuse-web`, `langfuse-worker`, `clickhouse`, `minio`, `langfuse-redis`. O 9Router sai; saldo líquido: +5 containers.
- `langfuse-web`: imagem `:4`, porta host ofuscada `LANGFUSE_PORT` em `127.0.0.1`, container `3000`, healthcheck `wget --spider http://127.0.0.1:3000/api/public/health`.
- `langfuse-worker`: mesma imagem `langfuse/langfuse-worker:4`, sem porta no host, healthcheck `http://127.0.0.1:3030/api/health`. [Health endpoints: https://langfuse.com/self-hosting/configuration/health-readiness-endpoints]
- `clickhouse`: imagem `clickhouse/clickhouse-server:${CLICKHOUSE_VERSION}` com **versão mínima 25.12** (requisito do Langfuse v4), sem porta no host, volume `./data/clickhouse`. Env obrigatórias no container: `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `TZ=UTC`. Em web e worker: `CLICKHOUSE_URL=http://clickhouse:${CLICKHOUSE_CONTAINER_PORT}`, `CLICKHOUSE_MIGRATION_URL=clickhouse://clickhouse:${CLICKHOUSE_NATIVE_PORT}`, `CLICKHOUSE_CLUSTER_ENABLED=false` (single-container; sem isso a migração usa `ON CLUSTER` e falha). Grants versionados em `setup/clickhouse/init.sql`, montados em `/docker-entrypoint-initdb.d/`, com: DDL em `default.*` (`DROP VIEW`, `ALTER ADD/MODIFY COLUMN`, `ALTER VIEW MODIFY QUERY`, `ALTER ADD/DROP/MATERIALIZE INDEX`), leitura de `system.parts/mutations/tables/processes/query_log*` e `SYSTEM SYNC REPLICA, SYSTEM MERGES, ALTER SETTINGS` em `default.observations_pid_tid_sorting`. Sem esses grants, migrações e jobs falham com `Not enough privileges`. [ClickHouse: https://langfuse.com/self-hosting/deployment/infrastructure/clickhouse]
- `minio`: imagem `minio/minio:${MINIO_VERSION}`, sem porta no host, volume `./data/minio`. O `command` cria o bucket `langfuse` (`mkdir -p /data/langfuse`) antes de iniciar o servidor — não precisa de container auxiliar nem de script em `setup/litellm/`. Variáveis obrigatórias em web e worker, com nomes completos: `LANGFUSE_S3_EVENT_UPLOAD_BUCKET`, `LANGFUSE_S3_EVENT_UPLOAD_REGION`, `LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT=http://minio:${MINIO_CONTAINER_PORT}`, `LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID`, `LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY`, `LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE=true`, `LANGFUSE_S3_EVENT_UPLOAD_PREFIX=events/`. Versões do MinIO anteriores a `RELEASE.2025-02-03` exigem `LANGFUSE_S3_DELETE_OBJECTS_CHECKSUM_ALGORITHM=MD5`; fixar versão igual ou superior para não precisar do workaround. [Blob storage: https://langfuse.com/self-hosting/deployment/infrastructure/blobstorage]
#### Multimodal e mídia

- **Multimodal desativado:** não definir `LANGFUSE_S3_MEDIA_UPLOAD_*`. URLs presignadas de mídia precisam de um endpoint alcançável pelo navegador. Como o MinIO fica sem porta no host, habilitar mídia exigiria publicá-lo em `127.0.0.1` e configurar `LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT`, `..._INTERNAL_ENDPOINT` e `..._BUCKET`. Fora desta entrega.
- `langfuse-redis`: imagem `redis:${LANGFUSE_REDIS_VERSION}` com senha própria e política `noeviction` (o Redis do Dashboard usa `allkeys-lru`, inadequado para fila do Langfuse); sem porta no host. Env em web/worker: `REDIS_HOST=langfuse-redis`, `REDIS_PORT=${LANGFUSE_REDIS_CONTAINER_PORT}`, `REDIS_AUTH=${LANGFUSE_REDIS_PASSWORD}`.
#### Variáveis e segredos

- Mapa `.env` → `environment:` do Compose. As chaves do `.env` são prefixadas; os nomes dentro do container são os que o Langfuse lê: `LANGFUSE_NEXTAUTH_SECRET` → `NEXTAUTH_SECRET`, `LANGFUSE_NEXTAUTH_URL` → `NEXTAUTH_URL`, `LANGFUSE_SALT` → `SALT`, `LANGFUSE_ENCRYPTION_KEY` → `ENCRYPTION_KEY` (hex de 32 bytes, `openssl rand -hex 32`), `LANGFUSE_DB_PASSWORD` compõe `DATABASE_URL`, `LANGFUSE_MINIO_ROOT_USER`/`LANGFUSE_MINIO_ROOT_PASSWORD` → `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`. O script `generate-passwords.sh` precisa de uma lista separada para campos hex, mantendo os demais em Base62.
- Chaves de projeto do Langfuse (`pk-lf-*`/`sk-lf-*`) são criadas no primeiro login e gravadas no `.env` para o LiteLLM. Não existem no boot; documento o passo manual no README.
- O Agente continua fora do Langfuse via gateway. Para ver as conversas do Agente no Langfuse, configurar **Observability → Broadcast** na conta OpenRouter apontando para o Langfuse. Essa operação é externa, fora do repo; registrar como passo manual opcional, não como código.

### Dashboard e API

- Renomear `GET /api/v1/9router/status` → `GET /api/v1/litellm/status`; o handler passa a checar `/health/liveliness` + `/health/readiness` e listar `/v1/models` com `Authorization: Bearer ${LITELLM_MASTER_KEY}`.
- `POST /api/v1/modelos/:id/testar` continua com o mesmo contrato de resposta, mas chama `${LITELLM_URL}/chat/completions` com a master key e reporta `endpoint_url` do LiteLLM.
- Renomear variáveis do server: `LITELLM_URL`, `LITELLM_API_KEY` (equivalentes às atuais `NINE_ROUTER_URL`/`NINE_ROUTER_API_KEY`). Nenhuma chave vai para o navegador.
- UI Vanilla: trocar rótulos `9Router` → `LiteLLM`, ids `btn-sync-9router`/`datalist-9router-models` → `btn-sync-litellm`/`datalist-litellm-models`, textos de fallback e mensagens de erro. Validar em navegador real nos temas claro/escuro.
- `dashboard/src/logger.js`: substituir a categoria `'9router'` por `'litellm'`.

### Strix e variáveis

- Hoje o Strix roda por script CLI no host (`README.md:526-546`), então `LLM_API_BASE` passa a ser `http://127.0.0.1:${LITELLM_PORT}/v1`. O nome `http://litellm:${LITELLM_CONTAINER_PORT}/v1` só vale se o Strix passar a rodar em container na `data_net`. `LLM_API_KEY` passa a ser uma chave virtual do LiteLLM, não a master key. Atualizar comentário em `.env.example` e README §10.
- Remover do `.env.example`: `NINE_ROUTER_VERSION`, `NINE_ROUTER_HOST_BIND`, `NINE_ROUTER_PORT`, `NINE_ROUTER_CONTAINER_PORT`, `PORT=20000`, `NINE_ROUTER_PASSWORD`, `CHAVE_NINE_ROUTER_PASSWORD`, `NINE_ROUTER_API_KEY`, `HOSTNAME`, `DATA_DIR`, `NINE_ROUTER_TAILSCALE_URL`. Atenção: `HOSTNAME`/`DATA_DIR` são genéricos, mas hoje só são usados pelo 9Router — confirmar com `grep` antes de remover na implementação.
- Adicionar ao `.env.example` (seções numeradas, sem quebrar a ordem de interpolação do Compose): versões novas, portas ofuscadas, credenciais espelhadas e chaves de observabilidade.

### Scripts, documentação e legado

- `scripts/generate-passwords.sh`: remover `NINE_ROUTER_PASSWORD`/`CHAVE_NINE_ROUTER_PASSWORD`; adicionar `LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY`, `LANGFUSE_NEXTAUTH_SECRET`, `LANGFUSE_SALT`, `LANGFUSE_MINIO_ROOT_PASSWORD`, `LITELLM_DB_PASSWORD` (com espelho), `LANGFUSE_DB_PASSWORD` (com espelho), `CLICKHOUSE_PASSWORD`, `LANGFUSE_REDIS_PASSWORD`, mais campos hex (`LANGFUSE_ENCRYPTION_KEY`).
- `scripts/verify-stack.sh`: substituir `9router` da lista `SERVICES` (`linha 73`) por `litellm`, `langfuse-web`, `langfuse-worker`, `clickhouse`, `minio`, `langfuse-redis`; remover `env_get NINE_ROUTER_PORT` e o `http_ok "9router"` (`linhas 205-213`) e trocar por checagens em `/health/liveliness` do LiteLLM e `/api/public/health` do Langfuse.
- `docker-compose.yml`: remover também `NINE_ROUTER_TAILSCALE_URL` do `environment:` do evolution-api (`linha 184`), além do serviço `9router` e do `depends_on` do Nginx.
- `README.md`: reescrever §5 (`Roteamento de IA`), lista de portas, estrutura de diretórios, variáveis, endpoints e §10 (Strix). Documentar o bootstrap do `init.sql` em stack existente e a criação manual das chaves do projeto Langfuse. Registrar também o Broadcast opcional da OpenRouter e o alerta de que `NO_CONTENT` pode ser alterado para `SPAN_ONLY` somente com avaliação LGPD.
- `AGENTS.md`: substituir 9Router da arquitetura e da lista de variáveis versionadas.
- `.gitignore`: remover `data/9router/`; adicionar `data/clickhouse/` e `data/minio/`.
- SQL: manter `'9router_sync'` no CHECK de `uso_tokens.origem` (`init.sql:342`) apenas para leitura de linhas históricas. O fallback ativo `COALESCE(..., '9router')` em `fn_registrar_uso_tokens()` (`init.sql:423`) **deve mudar para `'litellm'`**: ele grava `provedor='9router'` em linhas novas toda vez que a função é chamada sem provedor. Registrar a exceção histórica no README para não parecer esquecimento.
- `CHANGELOG.md` e `docs/superpowers/**`: apenas referências históricas; não reescrever o passado.

### Recursos e segurança

- Host: 19 GiB totais, ~7 GiB disponíveis no momento do levantamento; containers atuais somam ~1,4 GiB. Limites propostos por container: LiteLLM 768 MiB, langfuse-web 768 MiB, worker 768 MiB, ClickHouse 1,5 GiB, MinIO 256 MiB, langfuse-redis 256 MiB (≈4,3 GiB no pior caso).
- Redes: LiteLLM, Langfuse web/worker, ClickHouse, MinIO e langfuse-redis apenas em `data_net`; portas de host somente para LiteLLM e langfuse-web, ambas em `127.0.0.1`. Nginx não ganha rota nova (o 9Router também não era proxyado por ele).
- Nenhuma credencial em `docker-compose.yml`: tudo `${VARIAVEL}` com espelho no `.env.example`.
- Rotação: `LITELLM_SALT_KEY` e `LANGFUSE_ENCRYPTION_KEY` são imutáveis após o primeiro uso; documento o alerta no README.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| `lts` é tag móvel e o piloto tem janela até ~2026-12-02 | Decisão explícita do usuário; registrar data da imagem em `/api/health` e rever a pinagem na data de revisão |
| Estouro de memória com 6 serviços novos | `deploy.resources.limits` em todos; validar `docker stats` e `scripts/verify-stack.sh` após o boot |
| `LITELLM_SALT_KEY` perdido | Gerar uma vez, backup seguro via `.env.bak`, alerta no README; nunca regenerar em `sync-env.sh` |
| Bancos novos não criados em volume existente | Bootstrap manual do `init.sql` antes de subir os serviços; documentado no README e no plano |
| ClickHouse sem grants de sistema ou abaixo de 25.12 | `setup/clickhouse/init.sql` versionado, montado no entrypoint; `CLICKHOUSE_VERSION>=25.12` |
| Prompts/respostas persistidos no Langfuse | `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT` por padrão; opt-in `SPAN_ONLY` exige avaliação LGPD |
| Dashboard quebrado por modelo ausente no config do LiteLLM | `config.yaml` com os modelos atuais de `precos_modelos`; erro 4xx explícito no modal de teste |
| Agente sem rastros no Langfuse | Decisão B aceita; passo manual do Broadcast da OpenRouter documentado como opcional |
| Exclusão acidental de `data/9router` | Compose deixará o diretório intacto; remoção física exige confirmação separada |

## O que fica para o planejamento (após aprovação)

1. Diff cirúrgico do `docker-compose.yml`: remover serviço `9router` e `NINE_ROUTER_TAILSCALE_URL` do evolution-api, adicionar seis serviços com `command`/entrypoint do MinIO, ajustar `depends_on` do Nginx e env do Dashboard.
2. Extensão idempotente de `setup/postgres/init.sql` (bancos, roles, fallback `'litellm'`) e testes correspondentes em `tests/test_init_sql.sh`; bootstrap manual do SQL no container em execução como passo explícito.
3. Novo `setup/litellm/config.yaml` e `setup/clickhouse/init.sql` com os grants v4.
4. Renomeações no Dashboard (API + UI) e validação no navegador.
5. Atualização de `.env.example`, scripts (`generate-passwords.sh`, `verify-stack.sh`), README, `AGENTS.md`, `.gitignore`.
6. Plano de validação: `docker compose config`, `scripts/sync-env.sh --diff` e `scripts/verify-stack.sh`. Depois, validar o teste de modelo no Dashboard e o login no Langfuse. Por fim, conferir o trace no Langfuse, garantir que ele não contém prompt/resposta (`NO_CONTENT`) e checar que nenhum segredo aparece em logs.

A aprovação deste documento autoriza somente a escrita do plano de implementação (`writing-plans`); nenhum código de produção deve ser alterado antes disso.
