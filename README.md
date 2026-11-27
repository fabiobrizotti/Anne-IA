# Anne-IA — Stack Docker (n8n, Evolution API, Postgres/pgvector, Redis, RabbitMQ, LiteLLM, Langfuse, pgAdmin, Dashboard)

**Arquitetura Hardened + Tailscale:** Zero exposição à internet pública. Todos os serviços bindam em `127.0.0.1` na VPS. Acesso via Tailscale mesh VPN (IP `100.x.y.z` ou MagicDNS `http://anneia-vps:porta`).

A stack é auto-inicializável a partir de um clone limpo. A pasta `setup/` concentra as configurações de infraestrutura:

| Artefato | Papel |
|---|---|
| `setup/rabbitmq/rabbitmq.conf` | Limites de memória/disco, paginação, timeout de LLM e carga de definições. |
| `setup/rabbitmq/definitions.json.template` | Topologia padrão industrial: exchanges diretas, pipeline em 4 etapas com Quorum Queues e DLX/DLQ (senha via `.env`). |
| `setup/rabbitmq/entrypoint.sh` | Injeta a senha no template e gera o `definitions.json`. |
| `setup/litellm/config.yaml` | Modelos `openrouter/<provider>/<model>` e callback `langfuse_otel`; nenhuma chave é gravada no arquivo (provider key e master key vêm do `.env`). |
| `setup/clickhouse/init.sql` | Grants do usuário `langfuse` no ClickHouse single-container, incluindo `SYSTEM MERGES` exigido pelo Langfuse v4. |
| `setup/postgres/init.sql` | **Fonte única (SSOT 100% idempotente)**: bancos `litellm` e `langfuse` com roles próprias, schema do negócio, memória LangChain indexada (`memorypostgreschat` com `idx_memorypostgreschat_session` e `criado_em` para retenção LGPD), base RAG isolada multi-tenant (`base_conhecimento` com `instance_id`, índices HNSW vetoriais, B-tree composto de paginação e GIN trigram `pg_trgm`), `clientes` + `Instance` (Evolution API), **alinhamento 1:1** entre `public."Instance"` e `public.clientes` pelo mesmo ID (`clientes.id = Instance.id`), `prompt_config` (persona/role/playbook por cliente), `prompts_padrao` (prompts mestres globais para roteamento e economia de modelos), **ledger contábil e função de custeio** (`precos_modelos`, `uso_tokens`, `fn_registrar_uso_tokens` com idempotência estrita e precificação dinâmica), **autenticação e sessões server-side** (`dashboard_usuarios`, `dashboard_identidades` cifrada via AES-256-GCM com blind index HMAC-SHA-256, `dashboard_contatos`, `dashboard_credenciais` com hash NIST `scrypt`, `dashboard_sessoes`, `dashboard_consentimentos` LGPD e `dashboard_auditoria_auth`), **governança LGPD nativa** (`lgpd_auditoria` com hash SHA-256 via `pgcrypto`, `vw_clientes_mascarado`, `fn_lgpd_anonimizar_titular`, `fn_lgpd_anonimizar_cliente` e `fn_lgpd_expurgo_retencao`), **auditoria unificada statement-level** (`auditoria_geral` com triggers em todas tabelas de negócio). |
| `setup/pgadmin/servers.json` | Auto-provisionamento da conexão do PostgreSQL no pgAdmin 4. |
| `setup/n8n/clean-workflows.js` | Limpa workflows antigos no SQLite antes de reimportar (idempotência). |
| `setup/n8n/sanitize-workflow.js` | Remove rastros da instância de origem para evitar falhas no import. |

Os workflows do n8n não são versionados aqui. Eles vêm de `fabiobrizotti/n8n_anneia_workflows`. O container `n8n-import` usa o `GITHUB_TOKEN` para clonar e aplicar automaticamente.

## 1. Pré-requisitos
- Docker Engine com Compose v2 (usuário no grupo `docker`: `sudo usermod -aG docker $USER && newgrp docker`).
- **Portas ofuscadas (localhost only):** `34567` (n8n), `41283` (Dashboard), `52841` (pgAdmin), `48192` (LiteLLM), `40193` (Langfuse), `39271` (RabbitMQ Management), `5432` (Postgres), `6379` (Redis), `5672` (RabbitMQ AMQP).
- **Tailscale** na VPS (host): `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --authkey=... --hostname=anneia-vps`
- Conta no GitHub com acesso de leitura (token) ao repositório dos workflows.

## 2. Instalação

<details>
<summary><strong><img src="https://raw.githubusercontent.com/devicons/devicon/master/icons/linux/linux-original.svg" width="16" height="16" /> Linux (VPS com Tailscale)</strong></summary>

```bash
# 1. Instalar Tailscale na VPS (host) - ACESSO PRIVADO VIA MESH VPN
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --authkey=tskey-auth-XXXXXXXXXXXXXXXXXXXX --hostname=anneia-vps
# Verificar IP Tailscale: tailscale ip -4  (ex: 100.64.1.23)
# Opcional: MagicDNS habilitado no admin console -> acesso via http://anneia-vps:41283

# 2. Firewall UFW - APENAS TAILSCALE UDP + SSH (ZERO PORTAS PÚBLICAS)
sudo ufw allow 41641/udp   # Tailscale
sudo ufw allow 22/tcp      # SSH (ou sua porta SSH customizada)
sudo ufw enable

# 3. Clone e setup da stack
git clone https://github.com/fabiobrizotti/Anne-IA
cd Anne-IA

# Gera o .env, sincroniza chaves novas e preenche senhas fortes Base62 (32 chars)
chmod +x scripts/*.sh
./scripts/sync-env.sh

# (Opcional) Ativa sincronização automática do .env após 'git pull'
git config core.hooksPath .githooks

# Edite o .env para preencher:
# - GITHUB_TOKEN (para n8n-import clonar workflows)
# - N8N_INSTANCE_OWNER_EMAIL
# - TAILSCALE_AUTHKEY (opcional, para documentação)
# (as senhas de banco, redis, rabbitmq, litellm e langfuse já foram geradas com segurança)

# O n8n roda como UID 1000, pgAdmin como UID 5050; ClickHouse/MinIO persistem em data/
mkdir -p ./data/n8n ./workflows ./data/pgadmin ./data/clickhouse ./data/minio ./data/langfuse-redis
sudo chown -R 1000:1000 ./data/n8n ./workflows
sudo chown -R 5050:5050 ./data/pgadmin

# Sobe a stack rodando os scripts de setup
docker compose --profile setup up -d

# Reinicie o n8n na primeira vez para carregar os workflows importados
docker compose restart n8n
```

</details>

<details>
<summary><strong><img src="https://raw.githubusercontent.com/devicons/devicon/master/icons/windows8/windows8-original.svg" width="16" height="16" /> Windows/Local (Powershell) - Desenvolvimento</strong></summary>

```powershell
git clone https://github.com/fabiobrizotti/Anne-IA
cd Anne-IA

copy .env.example .env
# Edite o .env com suas senhas e o GITHUB_TOKEN

# Docker Desktop resolve permissões de usuário nativamente, basta criar as pastas:
mkdir data\n8n
mkdir workflows
mkdir data\pgadmin
mkdir data\clickhouse
mkdir data\minio
mkdir data\langfuse-redis

# Sobe a stack rodando os scripts de setup
docker compose --profile setup up -d

# Reinicie o n8n na primeira vez para carregar os workflows importados
docker compose restart n8n
```

</details>

O perfil `setup` sobe toda a infraestrutura e executa os scripts de setup via variáveis de ambiente e entrypoints. O `n8n-import` espera o n8n estar saudável antes de limpar e injetar os workflows novos.

**Para atualizar (reimportar) os workflows:**
```bash
docker compose stop n8n
docker compose --profile setup rm -f n8n-import
docker compose --profile setup run --rm --no-deps n8n-import
docker compose start n8n
```

---

### 2.1 Acesso aos Serviços (Pós-Instalação)

> **Legenda**: Porta Host = porta publicada no `127.0.0.1` (ofuscada, localhost only). Porta Container = porta interna do serviço. Acesso via Tailscale usa a **Porta Host** no IP `100.x.y.z` ou MagicDNS `anneia-vps`.

| Serviço | Porta Host | Porta Container | Local (localhost) | Via Nginx na tailnet (`:80`) |
|---------|------------|-----------------|-------------------|------------------------------|
| Dashboard | 41283 | 3000 | `http://127.0.0.1:41283` | `http://anneia-vps/` |
| n8n | 34567 | 34567 | `http://127.0.0.1:34567` | `http://anneia-vps/n8n/` |
| pgAdmin | 52841 | 80 | `http://127.0.0.1:52841` | `http://anneia-vps/pgadmin/` |
| LiteLLM | 48192 | 4000 | `http://127.0.0.1:48192/v1` | — (gateway OpenAI-compatible, sem UI) |
| Langfuse | 40193 | 3000 | `http://127.0.0.1:40193` | — (primeiro login cria o projeto) |
| RabbitMQ Mgmt | 39271 | 15672 | `http://127.0.0.1:39271` | `http://anneia-vps/rabbitmq/` |
| PostgreSQL | 5432 | 5432 | `psql -h 127.0.0.1 -p 5432` | — |
| PgBouncer | 6432 | 6432 | `psql -h 127.0.0.1 -p 6432` | — |
| Redis | 6379 | 6379 | `redis-cli -h 127.0.0.1 -p 6379` | — |
| Redis n8n Queue | 6380 | 6379 | `redis-cli -h 127.0.0.1 -p 6380` | — |
| Nginx (HTTP) | 80 | 8080 | `http://127.0.0.1:80` | `http://anneia-vps/` |

> **Host header:** o `server_name` do Nginx casa com `TAILSCALE_HOSTNAME`. Testes locais por `127.0.0.1` exigem `-H "Host: ${TAILSCALE_HOSTNAME}"`; hosts desconhecidos são fechados com `444`.
> **Evolution API:** Imagem `evoapicloud/evolution-api:${EVOLUTION_API_VERSION}` (v2.3.8 — corrige `stream errored out` do Baileys sem exigir novo scan). Não exposta no host. Acesso interno via `http://evolution-api:8080` (usado pelo Dashboard e n8n). Por isso `CORS_ORIGIN=*`: a Evolution rejeita requisição **sem** header `Origin` com `500 Not allowed by CORS`, e chamadas server-side (node `n8n-nodes-evolution-api`, scripts) não enviam `Origin`. A proteção real é o `AUTHENTICATION_API_KEY` + ausência de porta publicada/rota no Nginx — se algum dia expor a API, volte para allow-list e injete `Origin` nos chamadores (o Dashboard já faz em `evolutionFetch()`).
> **PgBouncer:** Pool de conexões Postgres (transaction mode). Dashboard e Evolution API conectam aqui; pgAdmin/pg_dump direto no Postgres.
> **Nginx:** Reverse proxy HTTP only (sem TLS — WireGuard do Tailscale já criptografa). Bind no IP Tailscale da VPS.

### 2.2 Reverse Proxy (Nginx) e Connection Pooling (PgBouncer)

**Nginx** (`setup/nginx/nginx.conf.template` + `entrypoint.sh`, imagem `nginx-unprivileged`, roda como UID 101):

| Rota | Upstream | Proteção |
|------|----------|----------|
| `/` | `dashboard:3000` | `limit_req` API + `limit_conn` 20 + SSE sem buffer em `/api/v1/logs/stream` |
| `/api/v1/auth/login`, `/register` | `dashboard:3000` | zona `login` (5r/m, burst 3) anti-brute-force |
| `/api/v1/conhecimento` | `dashboard:3000` | `client_max_body_size` 2m |
| `/n8n/` | `n8n:34567` | WebSocket do editor (`/rest/push`), `limit_conn` 30, **sem `limit_req` por design** |
| `/pgadmin/` | `pgadmin:80` | `X-Script-Name: /pgadmin` (gera links com o prefixo) |
| `/rabbitmq/` | `rabbitmq:15672` | casa com `management.path_prefix = /rabbitmq` |
| `*` (host desconhecido) | — | `return 444` (conexão fechada) |

- **Rate limit / body size** vêm do `.env` (`NGINX_RATE_LIMIT_*`, `NGINX_CLIENT_MAX_BODY_SIZE*`); o entrypoint substitui no template com `sed` (sem `envsubst`).
- **`/n8n/` sem `limit_req`**: o editor dispara >100 assets + REST em paralelo ao abrir; a zona compartilhada `api` (10r/s, burst 20) devolvia 429 em workflows/settings (todos os clientes chegam como `172.20.0.1`, o gateway Docker, e compartilhavam o mesmo bucket). A proteção residual é `limit_conn perip 30` (conexões, não taxa de requisições) + autenticação do próprio n8n; login (zona `login`, 5r/m) e dashboard continuam limitados. **Não reintroduzir `limit_req zone=api` neste location**; se houver abuso, criar zona dedicada e generosa para `/n8n/rest/`, mantendo assets e WebSocket livres.
- **n8n sob subpath**: `N8N_PATH=/n8n/` e `N8N_WEBHOOK_URL=http://${TAILSCALE_HOSTNAME}/n8n/` (valor interpolado pelo Compose). Consequência: webhooks internos passam a viver em `/n8n/webhook/...`.
- **WebSocket do editor (`/n8n/rest/push`)**: `Upgrade`/`Connection` são definidos **exclusivamente** no snippet `setup/nginx/snippets/proxy-params.conf` (via `$connection_upgrade`). Não redeclare `proxy_set_header Upgrade` dentro do `location /n8n/`: o nginx acumula as diretivas do mesmo nível e envia o header duas vezes (`upgrade: websocket, websocket`); o Node concatena headers repetidos com `", "` e a lib `ws` do n8n rejeita o handshake com **400 "Invalid Upgrade header"** (no editor: *Lost connection to the server*). Diagnóstico: `curl -i -H 'Upgrade: websocket' -H 'Connection: Upgrade' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' http://127.0.0.1/n8n/rest/push?pushRef=x` deve responder `101 Switching Protocols`.
- **Trust proxy**: `NGINX_TRUST_PROXY_IP` é preenchido pelo `scripts/update.sh` com o IP real do container Nginx na rede `frontend` (log de auditoria do Dashboard registra o IP do cliente, não o do proxy).
- **DNS de upstream**: `resolver 127.0.0.11 valid=10s ipv6=off` + `zone`/`resolve` em todos os upstreams (Nginx ≥ 1.27.3). O proxy reaplica o IP do backend em até 10s após recriação do container — sem isso o IP ficava congelado no boot e o serviço recriado respondia `502` até `docker compose restart nginx`.
- **Keepalive de upstream**: `proxy_http_version 1.1` + `Connection` vazio (map `$http_upgrade` → `''`) fazem os blocos `upstream { keepalive N }` valerem de fato — com `Connection: close` cada request abria uma conexão TCP nova. Verificado contando conexões `ESTABLISHED` com `docker exec nginx netstat -tn`.
- **Testes de fumaça**: `./tests/test_proxy_smoke.sh` valida healthcheck, rate limits, `client_max_body_size`, host desconhecido, n8n (health, WebSocket e DNS dinâmico do upstream), PgBouncer e reconexão do Dashboard após restart do pooler.

**PgBouncer** (`setup/pgbouncer/`, `auth_type=plain` com `userlist.txt` gerado no boot):

| Database (virtual) | Backend | Pool mode | Usuário |
|--------------------|---------|-----------|---------|
| `anneia` | `db-evolution:5432/anneia` | `transaction` | `pgbouncer_app` |
| `anneia_session` | `db-evolution:5432/anneia` | `session` | `pgbouncer_app` |
| `evolution` | `db-evolution:5432/evolution` | `transaction` | `evolution` |

- `ignore_startup_parameters = extra_float_digits, statement_timeout` — clientes que enviam `statement_timeout` no startup não são rejeitados (o Dashboard define o timeout por query, não no pool).
- Roles `pgbouncer_app`, `pgbouncer_admin` e `pgbouncer_auth` são criadas por `setup/postgres/init.sql` com senha placeholder; `scripts/update.sh` aplica as senhas reais do `.env` via `ALTER ROLE`.
- O container roda como UID 70 (`postgres`): `/run/pgbouncer` é `tmpfs` com `mode=1777` — sem isso o entrypoint não consegue escrever `userlist.txt` (erro `Permission denied`, container em restart loop).
- Evolution API usa `?pgbouncer=true` na URI (obrigatório para o Prisma em transaction mode).
## 3. Gestão e Sincronização de Ambiente (.env)
A infraestrutura utiliza o `.env.example` como fonte única da verdade estrutural (schema).

- **Sincronizar variáveis e gerar senhas**: Execute `./scripts/sync-env.sh` (ou `./scripts/generate-passwords.sh`). Ele insere novas variáveis adicionadas ao `.env.example`, preserva todos os valores e senhas locais já configurados, cria backup atômico (`.env.bak`) e gera senhas Base62 (32 caracteres alfanuméricos) para credenciais vazias.
- **Auditoria de divergências (Diff)**: Execute `./scripts/sync-env.sh --diff` para visualizar chaves ausentes, chaves órfãs e valores customizados localmente vs defaults do `.env.example` (com máscara automática em credenciais).
- **Automação pós-`git pull`**: Execute `git config core.hooksPath .githooks` uma única vez. Sempre que um `git pull` trouxer alterações no `.env.example`, o `.env` local será sincronizado automaticamente.
- **Hooks de commit/checkout (grafo de código)**: os hooks `post-commit`, `post-checkout`, `post-merge` e `post-rewrite` em `.githooks/` reconstróem o grafo do `graphify-out/` em segundo plano após mudanças de código. O `.gitattributes` registra o merge driver `merge=graphify` para `graphify-out/graph.json`. O diretório é gerado e permanece fora do Git; use `GRAPHIFY_SKIP_HOOK=1` para suprimir o rebuild quando necessário.
- **Ordem das variáveis**: o parser dotenv do Compose resolve `${VARIAVEL}` na ordem em que as linhas aparecem no `.env`. Variáveis referenciadas por outras (ex.: `TAILSCALE_HOSTNAME`, usada por `N8N_EDITOR_BASE_URL` e `N8N_WEBHOOK_URL`) devem ser definidas **antes** das primeiras referências — caso contrário o Compose emite `The "VARIAVEL" variable is not set. Defaulting to a blank string.` mesmo com a chave preenchida corretamente no arquivo.

### Variáveis Críticas de Autenticação:
- `RABBITMQ_DEFAULT_PASS`: Senha admin do RabbitMQ (sincronizada em `CHAVE_RABBITMQ_DEFAULT_PASS`).
- `POSTGRES_PASSWORD`: Senha do PostgreSQL (sincronizada em `CHAVE_POSTGRES_PASSWORD`).
- `REDIS_PASSWORD`: Senha do Redis (sincronizada em `CHAVE_REDIS_PASSWORD`).
- `LITELLM_MASTER_KEY`: Master key do gateway (gerada pelo `scripts/generate-passwords.sh`); o Compose a injeta no Dashboard como `LITELLM_API_KEY`, sem expor a chave ao navegador. **Não serve mais para login na UI** do LiteLLM.
- `LITELLM_ADMIN_PASSWORD`: senha do usuário local `anneia-admin` (`proxy_admin_viewer`, e-mail `admin@anneia.local`), gerada em Base62 + `!` para satisfazer a política do LiteLLM. Após subir a stack, rode `./scripts/bootstrap-litellm-admin.sh` (idempotente; `--force` redefine a senha) antes de manter `disable_env_credential_login: true` em `setup/litellm/config.yaml`.
- `OPENROUTER_API_KEY`: Credencial do provedor usada pelo LiteLLM; entra apenas no `.env`, nunca no `config.yaml`.
- `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`: Chaves do projeto criadas no primeiro login no Langfuse; aponte o LiteLLM para elas e recrie o container após preenchê-las.
- `N8N_ENCRYPTION_KEY`: Chave para criptografia de credenciais internas do n8n.
- `AUTHENTICATION_API_KEY`: Chave de autenticação da Evolution API.
- `PGADMIN_DEFAULT_EMAIL`: E-mail de login no pgAdmin 4.
- `PGADMIN_DEFAULT_PASSWORD`: Senha de acesso admin ao pgAdmin 4.
- `DASHBOARD_PASSWORD`: Senha do painel administrativo de instâncias (usuário: `admin`).
- `GITHUB_TOKEN`: Formato `ghp_...` ou token pessoal para clonar os workflows no n8n-import.
- `N8N_INSTANCE_OWNER_EMAIL`: E-mail do owner da instância n8n.
- `PGBOUNCER_PASSWORD`: Senha do usuário de aplicação do PgBouncer (sincronizada em `CHAVE_PGBOUNCER_PASSWORD`).
- `PGBOUNCER_ADMIN_PASSWORD`: Senha do usuário admin do PgBouncer (sincronizada em `CHAVE_PGBOUNCER_ADMIN_PASSWORD`).

## 4. Estrutura de Diretórios
- `setup/`: Scripts de boot (versionado).
- `data/`: Bancos e dados — postgres, redis, rabbitmq, n8n, evolution-api, clickhouse, minio, langfuse-redis e pgadmin (ignorado via .gitignore).
- `files/`: Exports (ignorado).
- `workflows/`: Clone local automático dos workflows do n8n (ignorado).

## 5. Roteamento de IA (LiteLLM + Langfuse)

O LiteLLM é o gateway OpenAI-compatible usado pelo Dashboard (catálogo e teste de modelos) e pelo Strix (`LLM_API_BASE`). O Agente nativo do n8n **continua** chamando a OpenRouter direto pelo nó `LLM: OpenRouter` — memória Postgres, tools e filas `anne.direct.work`/`costs.telemetry` permanecem intactos; limite de gasto por cliente no Agente segue pendente.

- **Endpoint interno (Dashboard)**: `http://litellm:4000/v1` (`LITELLM_URL`). O Compose injeta a master key de `LITELLM_MASTER_KEY` em `LITELLM_API_KEY`; `config.yaml` não contém segredos.
- **URLs derivadas são literais**: o Compose não expande `${...}` dentro de valores lidos do `.env`. `LITELLM_URL`, `LANGFUSE_HOST`, `LANGFUSE_NEXTAUTH_URL` e `LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT` usam portas fixas no texto (ex.: `http://langfuse-web:3000`); um placeholder aninhado vira `$${...}` e derruba o boot do Langfuse (`NEXTAUTH_URL` inválido). `tests/test_gateway_env.sh` barra regressões.
- **Login da UI do LiteLLM**: `general_settings.disable_env_credential_login: true` remove o aviso "Environment-credential login is enabled". Use `anneia-admin` / `LITELLM_ADMIN_PASSWORD`; a master key continua válida apenas como Bearer da API. Em deploy limpo, rode `./scripts/bootstrap-litellm-admin.sh` logo após o primeiro `up` (a API aceita a master key como Bearer mesmo com o fallback de UI desativado).
- **Custeio por cliente (Dashboard)**: `LITELLM_DATABASE_URL` deriva de `CHAVE_PGBOUNCER_PASSWORD` e lê `LiteLLM_SpendLogs` via `pgbouncer` (db `litellm`).
- **Fail-closed do financeiro**: `/api/v1/financeiro` retorna `503` se o banco `litellm` estiver indisponível.
- **Endpoint no host (Strix/CLI)**: `http://127.0.0.1:${LITELLM_PORT}/v1` (OpenAI-compatible). Use uma chave virtual do LiteLLM em `LLM_API_KEY`/`Authorization: Bearer ...`; a master key fica restrita ao Dashboard dentro do container.
- **Modelos**: IDs `openrouter/<provider>/<model>` são gerenciados na aba **Modelos de IA** do Dashboard (`precos_modelos` é a SSOT) e replicados por API para LiteLLM e Langfuse; não editar modelos nas UIs desses serviços. `OPENROUTER_API_KEY` entra somente pelo `.env`. A chave de teste do Dashboard usa esse mesmo endpoint.
- **Langfuse v4**: UI em `http://127.0.0.1:${LANGFUSE_PORT}` (web + worker + ClickHouse 25.12 + MinIO + Redis). No primeiro login, crie o projeto e copie `pk-lf-*`/`sk-lf-*` para `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` no `.env`; depois rode `docker compose up -d --force-recreate litellm langfuse-web langfuse-worker` para o gateway passar a publicar spans.
- **Observabilidade**: preset `langfuse_otel` com `LITELLM_OTEL_V2=true` e `LITELLM_OTEL_LANGFUSE_SPAN_SCOPE=llm_only`. `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT` registra modelo, tokens, custo e latência **sem** prompt/resposta; mudar para `SPAN_ONLY` exige avaliação LGPD prévia. Antes de criar o projeto no Langfuse, o exporter global do LiteLLM permanece no `console` padrão e imprime spans de DB no stdout — são informativos, não erros; para silenciá-los é preciso configurar as chaves e redirecionar o exporter.
- **Agente → Langfuse (opcional)**: configurar *Observability → Broadcast* na conta OpenRouter apontando para o Langfuse. É uma decisão externa ao repositório; não há código para isso.
- **Nginx**: não há rota proxy para LiteLLM/Langfuse; o `depends_on` usa `condition: service_started` apenas para ordem de boot (o health do Langfuse depende do primeiro login).
- **Versões**: `LITELLM_VERSION=lts` foi escolhido explicitamente, mas é tag móvel — revisar e pinar até **2026-12-02**. O repositório `minio/minio` foi removido do Docker Hub; o compose usa a imagem Chainguard oficial do Langfuse (`MINIO_IMAGE`) fixada por digest em `MINIO_VERSION`.

## 6. Painel Web PostgreSQL (pgAdmin 4)
O pgAdmin 4 oferece interface gráfica para gerenciar esquemas, tabelas e vetores (pgvector) no PostgreSQL:
- **Acesso Web**: `http://127.0.0.1:52841` (host local) ou `http://anneia-vps/pgadmin/` via Nginx (o header `X-Script-Name` mantém os links sob o prefixo).
- **Autenticação**:
  - Usuário: `PGADMIN_DEFAULT_EMAIL` (padrão: `admin@anne.ia`).
  - Senha: `PGADMIN_DEFAULT_PASSWORD` (gerada automaticamente no `.env`).
- **Auto-Provisionamento**: A conexão com o banco `db-evolution` é importada automaticamente no boot a partir de `setup/pgadmin/servers.json`.

## 7. Mensageria e Filas Industriais (RabbitMQ)

O RabbitMQ opera como o barramento assíncrono de alta confiabilidade da Anne-IA. O sistema adota topologia padrão de mercado, baseada em **Direct Exchanges**, **Quorum Queues** (persistência em disco via algoritmo Raft WAL) e **Dead Lettering isolado por estágio**.

### 7.1. Acesso ao Painel Management
- **URL**: `http://127.0.0.1:15672` (restrito ao host local).
- **Usuário**: `${RABBITMQ_DEFAULT_USER}` (padrão: `root`).
- **Senha**: `${RABBITMQ_DEFAULT_PASS}` (gerada no `.env`).

---

### 7.2. Pipeline em 4 Estágios do Projeto

```text
[Evolution API (AMQP Global)]
             │
             ▼ (rk: MESSAGES_UPSERT)
   [EXCHANGE: evolution] (Topic / Durable)
             │
             ▼
[FILA 1: anne.inbound.raw.q] ──(n8n validação)──┐
  (Quorum Queue + DLX + DLQ)                    │
                                                ▼
                                  [EXCHANGE: anne.direct.work] (Direct / Durable)
                                                │
   ┌────────────────────────────────────────────┘
   │ (rk: ai.process)
   ▼
[FILA 2: anne.ai.process.q] ──(n8n RAG / LLM)───┬───────────────────────────────────────────┐
                                                │ (rk: outbound.dispatch)                   │ (rk: costs.telemetry)
                                                ▼                                           ▼
[FILA 3: anne.outbound.dispatch.q] ──(n8n envio WhatsApp)    [FILA 4: anne.costs.telemetry.q] ──(n8n FinOps)
  (Quorum Queue + DLX + DLQ)                                   (Quorum Queue + DLX + DLQ)          │
                                                                                                   ▼
                                                                                   [PostgreSQL: uso_tokens]
```

| Estágio | Finalidade | Exchange de Ingress / Trabalho | Routing Key | Fila Quorum Principal | DLX | Routing Key DLQ | Fila Dead Letter (DLQ) |
|---|---|---|---|---|---|---|---|
| **1. Inbound** | Recepção de conversas e dados brutos do cliente (WhatsApp/Evolution) | `evolution` (Topic) / `anne.direct.work` | `MESSAGES_UPSERT` / `inbound.received` | `anne.inbound.raw.q` | `anne.direct.dlx` | `dlq.inbound` | `anne.inbound.raw.dlq` |
| **2. Core IA** | Motor principal de raciocínio, contexto, RAG e chamadas de LLM | `anne.direct.work` | `ai.process` | `anne.ai.process.q` | `anne.direct.dlx` | `dlq.ai` | `anne.ai.process.dlq` |
| **3. Outbound**| Humanização, formatação e despacho das respostas ao cliente | `anne.direct.work` | `outbound.dispatch`| `anne.outbound.dispatch.q` | `anne.direct.dlx` | `dlq.outbound` | `anne.outbound.dispatch.dlq` |
| **4. FinOps Telemetria** | Registro assíncrono de tokens e auditoria contábil de IA sem bloquear UX | `anne.direct.work` | `costs.telemetry` | `anne.costs.telemetry.q` | `anne.direct.dlx` | `dlq.costs` | `anne.costs.telemetry.dlq` |

---

### 7.3. Estratégias de Resiliência e Prevenção de Perdas

1. **Persistência Total (Quorum Queues)**:
   - Todas as filas operam com `x-queue-type: quorum`, mantendo Write-Ahead Log (WAL) no disco. Em caso de queda de energia ou reinicialização do computador, nenhuma mensagem é perdida.
2. **Proteção contra Mensagens Venenosas (`x-delivery-limit`)**:
   - `anne.inbound.raw.q`: `3` tentativas antes de desviar para DLQ.
   - `anne.ai.process.q`: `2` tentativas antes de desviar para DLQ (impede loops caros ou infinitos de chamadas à LLM).
   - `anne.outbound.dispatch.q`: `3` tentativas antes de desviar para DLQ.
   - `anne.costs.telemetry.q`: `3` tentativas antes de desviar para DLQ.
3. **Backpressure e Estabilidade no Servidor Local**:
   - `vm_memory_high_watermark.relative = 0.6`: ativa backpressure aos 60% de RAM.
   - `vm_memory_high_watermark_paging_ratio = 0.5`: inicia paginação para disco aos 30% da RAM total, impedindo estouro de memória local.
   - `disk_free_limit.absolute = 2GB`: bloqueia novos envios se o disco livre for menor que 2GB.
   - `overflow: reject-publish`: filas de trabalho rejeitam novas mensagens se atingirem 10.000 itens (protege a máquina física de exaustão).
   - `consumer_timeout = 3600000`: timeout estendido para 1 hora, impedindo que tarefas demoradas de LLM derrubem o canal AMQP.

---

### 7.4. Boas Práticas para Workflows no n8n

- **Nós RabbitMQ Trigger (Consumidores)**:
  - Definir modo de **Acknowledge**: `Manual / Only on complete` (garante reprocessamento seguro se o workflow falhar).
  - **Prefetch Count**:
    - `anne.inbound.raw.q`: `10` a `20` (I/O leve).
    - `anne.ai.process.q`: `1` ou `2` (tarefa pesada de IA; impede acúmulo de mensagens não processadas em um único worker).
    - `anne.outbound.dispatch.q`: `5` a `10` (requisições HTTP à Evolution API).
    - `anne.costs.telemetry.q`: `10` a `20` (telemetria contábil leve em background).
- **Nós RabbitMQ (Publicadores)**:
  - Exchange: `anne.direct.work`.
  - Delivery Mode: `2 - Persistent`.

---

### 7.5. Tuning Industrial do n8n & Comparativo de Escala (Queue Mode vs Single-Instance)

O n8n padrão sem parametrização grava o payload JSON de cada execução no SQLite, provocando lentidão extrema e `database is locked` sob tráfego contínuo. A stack Anne-IA adota práticas recomendadas para operação industrial:

| Dimensão | n8n Padrão (Sem Tuning) | n8n Anne-IA (Tuned) | n8n Queue Mode (Escala Multi-Node) |
|---|---|---|---|
| **Persistência de Execuções** | Grava 100% dos dados em disco | `SAVE_ON_SUCCESS=none` (Zero I/O no sucesso) | `SAVE_ON_SUCCESS=none` |
| **Diagnóstico de Erros** | Misturado com logs normais | `SAVE_ON_ERROR=all` (Logs completos em falha) | `SAVE_ON_ERROR=all` |
| **Limpeza de Histórico** | 336h / 10.000 execuções | `EXECUTIONS_DATA_MAX_AGE=48` (hard delete automático a cada 15min) | Pruning automatizado |
| **Modelo de Execução** | Processo único (`regular`) | Processo único (`regular`) | Distribuído em workers independentes (`queue`) |
| **Broker de Tarefas** | Nenhum | RabbitMQ desacopla ingestão externa | Redis (BullMQ interno) + RabbitMQ (negócio) |
| **Banco de Metadados** | SQLite (mono-instância) | SQLite sem escrita em execuções de sucesso | PostgreSQL compartilhado obrigatório |
| **Consumo de Memória** | Heap padrão do Node | Heap de 2GB só no n8n (`N8N_NODE_OPTIONS`) | ~400MB por worker + Redis + Main + Webhook |

> Todas as variáveis acima foram conferidas na config efetiva do n8n 2.36.5 (`GlobalConfig`). Nomes como `EXECUTIONS_PROCESS` e `EXECUTIONS_DATA_PRUNE_MAX_AGE` são de versões antigas e são **ignorados em silêncio** pelo n8n 2.x.

> **Quando migrar para o Queue Mode?**  
> O n8n Queue Mode separa o n8n em 3 processos (`main`, `webhook` e múltiplos `workers`) coordenados por filas BullMQ no **Redis** e banco **PostgreSQL**. Ele é indicado quando a volumetria exige múltiplos nós físicos ou dezenas de mensagens por segundo simultâneas. Na topologia atual da Anne-IA, o **RabbitMQ já atua como buffer de absorção assíncrona com prefetch e Quorum Queues**, e com `SAVE_ON_SUCCESS=none` as execuções bem-sucedidas não escrevem no banco do n8n.

---

## 8. Painel Administrativo Vanilla (Gestão de Instâncias e Clientes)

O Dashboard administrativo é uma aplicação web ultra-leve construída em **Vanilla HTML5, CSS puro e JavaScript nativo** (com backend enxuto em Node.js 20 Alpine). Ele consome menos de 30MB de memória RAM no servidor e inicia automaticamente junto ao Docker Compose.

### 8.1. Acesso ao Painel e Autenticação Segura (OWASP ASVS / LGPD)
- **URL**: `http://127.0.0.1:3000` (restrito ao host local por segurança).
- **Tela de Login e Cadastro (`/login.html`)**:
  - Gatekeeper automático: requisições não autenticadas são redirecionadas para a tela de login.
  - Abas segmentadas para **Entrar** e **Criar Conta**.
  - Hash de senhas via `scrypt` nativo do Node.js 20 (NIST SP 800-63B), imune a timing attacks (`crypto.timingSafeEqual`).
  - Sessões server-side opacas em banco (`dashboard_sessoes`) com cookies rotativos `HttpOnly; SameSite=Lax; Path=/` (`__Host-sid` em HTTPS / `sid` em HTTP local).
  - Rate limiting in-memory e bloqueio temporário (lockout) após 5 tentativas consecutivas com mensagens genéricas anti-enumeração.
  - Governança LGPD: consentimento explícito e auditável (`dashboard_consentimentos`) com checkboxes desmarcados por padrão para Termos de Uso e Política de Privacidade e cifragem AES-256-GCM com blind index HMAC para CPFs.
- **Credenciais Iniciais (Bootstrap)**:
  - Usuário padrão: `DASHBOARD_USERNAME` (ex: `admin@anne-ia.local`).
  - Senha: `DASHBOARD_PASSWORD` (gerada automaticamente no `.env`).
  - Provisionamento automático de admin inicial caso a tabela `dashboard_usuarios` esteja vazia.

### 8.2. Interface e Experiência Neutra
- **Design Monocromático Neutro**: Visual preto e branco sóbrio (<30MB RAM, zero-build), livre de neons, gradientes coloridos ou elementos decorativos supérfluos.
- **Tema Adaptativo & Identidade Institucional**: Sem preferência salva, o tema segue o sistema operacional (`prefers-color-scheme`) em tempo real; o botão alternador (Sol / Lua) grava a escolha em `localStorage` (`anne_theme`), aplica `data-theme`/`color-scheme` com script anti-FOUC no `<head>` e sincroniza a preferência entre abas pelo evento `storage`. A faixa de identidade escura e o menu lateral de navegação são permanentes no console; a tela de login usa a mesma faixa, sem sidebar.
- **Rastreabilidade Temporal**: Indicador global "Atualizado em" no cabeçalho com horário da última sincronização, coluna dedicada na tabela e registros tabulares (`tabular-nums`) de criação e modificação.

### 8.3. Funcionalidades Principais
1. **Gestão Centralizada e Ficha do Cliente (Dossier)**:
   - Tabela `clientes` no PostgreSQL (`anneia`), onde o campo `id` é estritamente imutável e idêntico ao `instanceName`/`instanceId` da Evolution API, acompanhado de `codigo` numérico sequencial (`BIGSERIAL UNIQUE`) para referência simplificada de faturamento e ledger.
   - **Prontuário Completo**: Modal administrativo para consulta e edição de dados do cliente (Nome, E-mail, Status Ativo).
   - **Histórico Persistente de Telefones**: Mudanças de número registram automaticamente o número anterior, novo número, data (ISO 8601) e motivo da alteração em coluna `JSONB` (`historico_telefones`) com auditoria.
   - **Conexão Direta**: Botão para disparar o fluxo de conexão do WhatsApp com o número preenchido na ficha.
2. **Conexão ao WhatsApp sem Complicações**:
   - **Código de Pareamento (Pairing Code)**: Layout flex perfeitamente alinhado. Informe o número com DDD e receba um código de 8 dígitos para digitar no celular diretamente, sem depender de câmera.
   - **QR Code em Alta Resolução**: Renderização confiável de imagens base64 geradas pelo Baileys na Evolution API, com atualização manual e auto-polling de status.
3. **Ajuste de Comportamento (Settings)**:
   - Rejeição automática de chamadas de voz e vídeo com mensagem explicativa customizável.
   - Ignorar mensagens em grupos para focar apenas no atendimento privado.
   - Manter status sempre online, recibo de leitura (tique azul), visualização de status e sincronização de histórico.
4. **Painel Financeiro Industrial & Métricas de Tokens (Aba Financeiro)**:
   - **Filtros Flexíveis & Mês Atual**: Seletor rápido com padrão ativo em "Mês Atual" (faturamento contábil), opções de 7 ou 30 dias e filtro customizado por datas com campos nativos `[de]` e `[até]`.
   - **Arredondamento e Formatação Visual**: Custos consolidados em padrão monetário (`$ 0.00` ou 4 casas quando < $0.01) e métricas de tokens/requisições formatadas com separador de milhar brasileiro (`pt-BR`).
   - **Arquitetura Client-Side First (Offloading de CPU)**: Cálculos de deltas, médias, construção da série temporal contínua e renderização de gráficos SVG executados 100% no computador do operador, desonerando o servidor pai.
   - **Poder de Compra & Rendimento de $1 USD**: Reposicionado no rodapé do painel como card informativo discreto (Requisições por $1 USD, Mensagens atendidas por $1 USD, Volume de tokens e Média por mensagem).
   - **Preparação para Gateway & Faturamento**: Coluna de faturamento na tabela de clientes com status e botão de ação para emitir link de pagamento em modal dedicado.
   - Gráfico temporal diário interativo (SVG puro) com alternador de visão em tabela (WCAG acessível).
5. **Modelos de IA & Gestão de Custos (Aba Modelos de IA)**:
   - Catálogo de modelos com precificação por 1M tokens (input, output, cache, reasoning) e **classificação por Níveis** (`T1`, `T2`, `T3`, com rótulos acessíveis `Nível 1`, `Nível 2`, `Nível 3`).
   - Cadastro, edição e desativação segura protegendo integridade de auditoria contábil.
   - Teste de conectividade e inferência direta via LiteLLM com medição de latência em milissegundos e rate limit defensivo.
   - Coluna **Sync** por modelo e resumo de reconciliação no banner: `Sincronizado`, `Pendente`, `Removido` ou `N/A` por sistema (`Litellm`/`Langfuse`), atualizados pelo botão **Sincronizar Modelos**.
   - O custo exibido nos traces do Langfuse é o devolvido pelo LiteLLM; os preços cadastrados no Dashboard são referência/fallback, não sobrescrevem o custo observado.
6. **Base de Conhecimento RAG & Vetores pgvector (Sub-aba Base de Conhecimento)**:
   - Central de auditoria e inspeção de fragmentos (chunks) textuais, metadados JSONB e embeddings na tabela `base_conhecimento`.
   - Índices de performance industrial: B-tree composto `(instance_id, id DESC)` para paginação multi-tenant instantânea e GIN `pg_trgm` para buscas textuais rápidas.
   - Projeção de dados otimizada sem tráfego de vetores brutos (zero vector leakage).
   - Filtro por tenant/empresa, busca textual em tempo real, visualizador completo com syntax highlighting de metadados, contagem de tokens e exclusão/cadastro rápido.
7. **Observabilidade Operacional (Aba Logs do Sistema)**:
   - **Captura automática**: o `requestLogger` (em `dashboard/src/logger.js`) registra toda requisição autenticada em `/api/v1/*` com método, rota normalizada, status HTTP, duração e nível derivado do status (`info` 2xx/3xx, `warn` 4xx, `error` 5xx). Rotas de logs, `/api/health` e arquivos estáticos são ignorados de propósito para não criar loop de feedback.
   - **Eventos de negócio e falhas**: login OK/falha/lockout, CRUD de instâncias, conhecimento, modelos e prompts padrão são gravados explicitamente; `unhandledRejection`, `uncaughtException` e o handler global de erros também persistem em `system_logs`.
   - **Tempo real sem duplicar**: SSE em `/api/v1/logs/stream` entrega o replay do cache e os eventos novos; o frontend deduplica pelo `id` real do banco (o `INSERT` usa `RETURNING id`).
   - **Isolamento multi-tenant**: o cache só é servido a admin (`use_cache=true`); SSE e listagem filtram por `cliente_id`, então operador/visualizador enxerga apenas o próprio tenant.
   - **LGPD por padrão**: o logger não grava corpo de requisição, senha, CPF ou e-mail no contexto e mascara o IP (`203.0.113.x` / `2001:db8::x`), além de truncar mensagens e contexto antes de gravar no `jsonb`.
   - **Operação**: retenção diária configurável (`LOG_RETENTION_DAYS`, padrão 90) e ingestão externa opcional (`POST /api/v1/logs/ingest`) autenticada por `X-Log-Token` (`LOG_INGEST_TOKEN`); sem o token o endpoint responde `503`.
   - **Rate limit distribuído**: `REDIS_URL` (db 7, dedicado ao Dashboard) é montada no Compose a partir de `CHAVE_REDIS_PASSWORD`; sem Redis a aplicação cai para rate limit em memória (fail-open) em vez de derrubar o login.


### 8.4. Endpoints da API REST (v1)

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/health` | Healthcheck simples da aplicação |
| `POST` | `/api/v1/auth/login` | Autenticação com rate limit anti-força bruta e emissão de cookie de sessão |
| `POST` | `/api/v1/auth/register` | Cadastro de operador com validação de CPF, idade >= 18 e consentimento LGPD |
| `POST` | `/api/v1/auth/logout` | Revogação de sessão server-side e limpeza de cookies |
| `GET` | `/api/v1/auth/me` | Retorna dados e role do usuário ativo da sessão |
| `GET` | `/api/v1/auth/legal/:tipo` | Retorna texto canônico dos Termos de Uso ou Política de Privacidade |
| `GET` | `/api/v1/instances` | Lista clientes e status em tempo real da Evolution API |
| `POST` | `/api/v1/instances` | Cria nova instância na Evolution e cadastra no PostgreSQL |
| `PUT` | `/api/v1/instances/:id` | Atualiza dados do cliente e anexa histórico de telefones no PostgreSQL |
| `GET` | `/api/v1/instances/:id/connect` | Gera Pairing Code (via query `?number=`) ou QR Code em base64 |
| `GET` | `/api/v1/instances/:id/status` | Retorna estado de conexão em tempo real (`open`, `connecting`, `close`) |
| `GET` | `/api/v1/instances/:id/settings` | Obtém configurações comportamentais da instância |
| `POST` | `/api/v1/instances/:id/settings` | Salva configurações comportamentais na Evolution e no banco |
| `GET` | `/api/v1/instances/:id/prompt` | Busca config de prompts do agente (`prompt_config`: identidade, papel, personalidade, playbook, escalação, system prompt) |
| `PUT` | `/api/v1/instances/:id/prompt` | Salva config de prompts do agente (upsert idempotente em `prompt_config`) |
| `GET` | `/api/v1/financeiro` | Retorna métricas brutas de custo e tokens por período (`?periodo=mes_atual`, `?dias=7\|30\|90` ou `?inicio=YYYY-MM-DD&fim=YYYY-MM-DD`) |
| `GET` | `/api/v1/litellm/status` | Retorna diagnóstico de conectividade (liveness + readiness), endpoint e lista de modelos do LiteLLM |
| `GET` | `/api/v1/modelos` | Lista catálogo de modelos de IA, status e custos por 1M tokens |
| `POST` | `/api/v1/modelos` | Cadastra novo modelo com preços de entrada/saída sanitizados |
| `PUT` | `/api/v1/modelos/:id` | Atualiza parâmetros e vigência de precificação do modelo |
| `DELETE` | `/api/v1/modelos/:id` | Exclui ou desativa modelo (soft-delete seguro se houver histórico contábil) |
| `POST` | `/api/v1/modelos/:id/testar` | Dispara teste de ping/inferência no LiteLLM e afere latência |
| `POST` | `/api/v1/modelos/sincronizar` | Reconcilia o catálogo com LiteLLM e Langfuse (admin, máx. 5/min por IP) |
| `GET` | `/api/v1/prompts-padrao` | Lista prompts padrão globais com filtro opcional por status ativo |
| `GET` | `/api/v1/prompts-padrao/:id` | Obtém prompt padrão por ID ou chave única (slug n8n) |
| `POST` | `/api/v1/prompts-padrao` | Cadastra novo prompt padrão com modelo validado contra a tabela de modelos |
| `PUT` | `/api/v1/prompts-padrao/:id` | Atualiza prompt padrão, incrementando versão automaticamente |
| `DELETE` | `/api/v1/prompts-padrao/:id` | Exclui ou desativa prompt padrão (protegendo chave mestre do sistema) |
| `GET` | `/api/v1/conhecimento/stats` | Retorna métricas globais agregadas da base de conhecimento RAG |
| `GET` | `/api/v1/conhecimento` | Lista fragmentos RAG paginados com filtro por tenant e busca trigram |
| `GET` | `/api/v1/conhecimento/:id` | Detalha fragmento individual, texto integral e metadados JSONB |
| `POST` | `/api/v1/conhecimento` | Cadastra novo fragmento textual na base de conhecimento de um tenant |
| `DELETE` | `/api/v1/conhecimento/:id` | Remove fragmento individual da base de conhecimento |
| `POST` | `/api/v1/conhecimento/bulk-delete` | Exclusão em lote segura de múltiplos fragmentos via array de IDs |
| `POST` | `/api/v1/instances/:id/restart` | Reinicia a conexão da instância |
| `DELETE` | `/api/v1/instances/:id` | Remove a instância na Evolution API e no banco de dados |
| `GET` | `/api/v1/logs` | Lista logs paginados com filtros (`nivel`, `origem`, `busca`, `inicio`, `fim`, `cliente_id`, `page`, `limit`); `use_cache=true` só vale para admin |
| `GET` | `/api/v1/logs/stats` | Contadores por nível (`critical`, `error`, `warn`, `info`, `debug`) para os badges, respeitando os mesmos filtros |
| `GET` | `/api/v1/logs/origens` | Lista as origens distintas visíveis ao usuário (alimenta o filtro) |
| `GET` | `/api/v1/logs/stream` | Server-Sent Events: replay do cache + eventos em tempo real (heartbeat de 30s) |
| `GET` | `/api/v1/logs/export` | Exportação CSV server-side respeitando filtros (até 5000 linhas para admin, 1000 para tenant) |
| `DELETE` | `/api/v1/logs/cache` | Limpa apenas o cache em memória (não apaga o histórico do banco) |
| `POST` | `/api/v1/logs/limpar` | Remove logs mais antigos que `dias` (admin; usa `fn_limpar_logs_antigos`) |
| `POST` | `/api/v1/logs/ingest` | Ingestão de eventos externos (n8n, Evolution, scripts) via header `X-Log-Token`; `503` quando `LOG_INGEST_TOKEN` está vazio |

### 8.5. Testes Unitários Nativos (NIST SP 800-63B / LGPD)
O backend do dashboard inclui suíte completa de testes unitários nativos (`node:test` e `node:assert/strict`), sem dependências extras, executada em menos de 3 segundos:

```bash
cd dashboard
npm test
```

A suíte valida integralmente:
- **scrypt (RFC 7914)**: custo canônico ($N=16384, r=8, p=1$, dkLen=64), semáforo em memória (`MAX_SCRYPT_CONCURRENCY = 1`, fila máx 20 com HTTP 503 e `Retry-After: 1`), e rehash automático (`needsRehash`).
- **AES-256-GCM (LGPD Art. 46)**: cifra de PII (CPF) com integridade autenticada e teste de adulteração de ciphertext e Auth Tag.
- **Blind Index HMAC-SHA256**: índice determinístico para busca exata com segregação estrita de chaves (`CPF_ENC_KEY` e `CPF_HMAC_KEY`).
- **NIST SP 800-63B**: tamanho de 8 a 128 caracteres, suporte a Unicode, rejeição de caracteres de controle e bloqueio de senhas comuns/fracas conhecidas.
- **Lockout Desacoplado & NAT-Safe**: backoff progressivo por conta com IP sujeito apenas a rate limit volumétrico (30 req/min, HTTP 429).
- **Gestão de Sessão**: cookies `HttpOnly; SameSite=Lax` com prefixo seguro `__Host-sid` em HTTPS.
- **Logger operacional (`tests/logger.test.js`)**: classificação de nível por status, origem curta por rota, skip anti-loop, mascaramento de IP (IPv4/IPv6), truncamento de contexto e isolamento multi-tenant no cache/SSE — 40 asserções, sem banco.

Smoke test da aba em stack real (pula e sai com `0` se o Dashboard não estiver acessível):

```bash
./tests/test_logs_smoke.sh
```

Valida 401 sem sessão, listagem autenticada com registros, anti-loop (contagem estável após várias listagens), export CSV e recusa de ingestão anônima.

---

## 9. Atualizar Schema sem Perda de Dados, Governança LGPD e Recriação Total

### 9.1. Reaplicar `init.sql` em Banco em Execução (Sem Apagar Dados)
Como `setup/postgres/init.sql` é **100% idempotente** (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`), alterações de schema, índices ou funções podem ser aplicadas diretamente no container ativo sem derrubar volumes:

```bash
docker exec -i db-evolution psql -v ON_ERROR_STOP=1 -U evolution -d anneia < setup/postgres/init.sql
```

> **Por que `-d anneia` e não `-d postgres`?** O `init.sql` cria o banco `anneia` e faz
> `\connect anneia`; conectado em `postgres`, o `CREATE DATABASE`/`\connect` ainda
> funciona, mas qualquer erro de conexão passa despercebido. Conectando direto no banco
> de negócio, `ON_ERROR_STOP=1` aborta no primeiro problema real.
>
> **Não precisa fazer isso à mão:** `./scripts/update.sh` reaplica o `init.sql`
> automaticamente quando ele muda entre revisões (ver §12).

As senhas dos roles `litellm`, `langfuse` e `pgbouncer_app` vêm do `.env` via `PGOPTIONS` (o SQL usa `current_setting('app.litellm_password')`, `app.langfuse_password` e `app.pgbouncer_password`). O `docker-compose.yml` injeta essas variáveis no `db-evolution` no boot limpo e `scripts/update.sh` reaplica o `init.sql` com o mesmo `PGOPTIONS`, além de sincronizar as senhas das roles já existentes. O comando manual abaixo é apenas para recuperação excepcional:

```bash
set -a; . ./.env; set +a
docker exec -i \
  -e PGOPTIONS="-c app.litellm_password=${CHAVE_LITELLM_DB_PASSWORD} -c app.langfuse_password=${CHAVE_LANGFUSE_DB_PASSWORD} -c app.pgbouncer_password=${PGBOUNCER_PASSWORD}" \
  db-evolution psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d anneia < setup/postgres/init.sql
```

> **Exceção histórica:** `'9router_sync'` permanece no `CHECK` de `uso_tokens.origem` somente para leitura de linhas antigas. O fallback ativo em `fn_registrar_uso_tokens()` grava `'litellm'`; não remova o valor antigo sem migrar o histórico contábil.

### 9.2. Rotinas Nativas de Conformidade LGPD (Lei nº 13.709/2018)
O banco `anneia` inclui procedimentos armazenados auditáveis com pseudonimização criptográfica SHA-256 (`pgcrypto`):
- **Direito ao Esquecimento de Titular WhatsApp (Art. 18, VI)**:
  ```sql
  SELECT fn_lgpd_anonimizar_titular('5515999999999@s.whatsapp.net', 'Solicitação do titular via canal oficial');
  ```
- **Anonimização de Cliente / Tenant preservando Ledger Contábil (Art. 16, I e Art. 18, IV)**:
  ```sql
  SELECT fn_lgpd_anonimizar_cliente('id_da_instancia', 'Encerramento contratual');
  ```
- **Expurgo Preventivo por Janela de Retenção (Art. 6º, III e Art. 15)**:
  ```sql
  SELECT fn_lgpd_expurgo_retencao(90, 365); -- 90 dias p/ memória de chat, 365 dias p/ auditoria
  ```
- **Consulta Mascarada (Privacy by Design)**: `SELECT * FROM vw_clientes_mascarado;`

### 9.3. Gestão e Rotação de Chaves Criptográficas LGPD (`CPF_ENC_KEY` e `CPF_HMAC_KEY`)
O dashboard isola dados sensíveis de titulares (CPF) com dupla proteção criptográfica:
- `CPF_ENC_KEY`: Chave simétrica AES-256-GCM de 32 bytes (Base64) para confidencialidade reversível com verificação de autenticidade.
- `CPF_HMAC_KEY`: Chave HMAC-SHA256 de 32 bytes (Base64) para blind index determinístico em consultas indexadas.
- **Armazenamento e Backup**: As chaves residem exclusivamente no `.env` (fora do controle de versão). O backup das chaves criptográficas deve ser gerenciado **separadamente** dos dumps do PostgreSQL, garantindo que o vazamento do banco não comprometa o acesso aos dados em repouso (LGPD Art. 46).
- **Procedimento de Rotação**:
  1. Gerar nova chave de 32 bytes: `openssl rand -base64 32`.
  2. Rotação de `CPF_ENC_KEY`: requer script de migração para decifrar os registros legados com a chave anterior e recifrá-los com a nova chave.
  3. Rotação de `CPF_HMAC_KEY`: altera as assinaturas determinísticas; requer recalcular `cpf_hash` de todos os registros na tabela `dashboard_usuarios` utilizando a nova chave HMAC.

### 9.4. Catálogo de IAs: chaves do Langfuse e papéis de conta

- `STORE_MODEL_IN_DB=True` no `.env` é pré-requisito do `/model/new` e `/model/delete`
  do proxy LiteLLM; sem ele a reconciliação marca esse sistema como `pendente`.
- No primeiro login do Langfuse, crie o projeto e copie `pk-lf-*`/`sk-lf-*` de
  *Project Settings → API Keys* para `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`
  no `.env` (nunca impressos em log, README ou commit). Recrie os containers com
  `docker compose up -d --force-recreate litellm langfuse-web langfuse-worker`.
- Contas humanas no Langfuse devem usar `Member` ou `Viewer`. A conta bootstrap
  pode permanecer `Owner` apenas para administração inicial; transferir/proteger
  essa conta é responsabilidade operacional, pois `Owner`/`Admin` consegue
  configurar modelos pela UI. As chaves de escrita vivem somente no backend do
  Dashboard.
- Sem as chaves, a reconciliação marca os modelos como `pendente` (não derruba o
  boot). Preencha o `.env`, recrie os containers e clique em **Sincronizar
  Modelos** (ou `POST /api/v1/modelos/sincronizar`) para convergir.
- `POST /api/v1/modelos/sincronizar` é administrativo e limitado a 5 chamadas por
  minuto por IP. Falhas externas não apagam o catálogo local: viram `pendente`
  e são retentadas na próxima reconciliação. Modelos padrão do Langfuse fora do
  catálogo aparecem apenas como `orfos_observados`; nenhum é removido.

### 9.5. Recriar Banco e RabbitMQ do Zero (Destrutivo)
Se desejar destruir todos os volumes e reinicializar o ambiente do zero:

<details>
<summary><img src="https://raw.githubusercontent.com/devicons/devicon/master/icons/linux/linux-original.svg" width="16" height="16" /> <strong>Recriar no Linux</strong></summary>

```bash
docker compose down -v # APAGA TUDO
sudo chown -R 1000:1000 ./data/n8n ./workflows
docker compose --profile setup up -d
```
</details>

<details>
<summary><img src="https://raw.githubusercontent.com/devicons/devicon/master/icons/windows8/windows8-original.svg" width="16" height="16" /> <strong>Recriar no Windows</strong></summary>

```powershell
docker compose down -v # APAGA TUDO
docker compose --profile setup up -d
```
</details>

---

## 10. Pentest Autônomo e Segurança Ofensiva (Strix AI)

A plataforma conta com uma suíte completa de testes ofensivos autônomos integrados ao **Strix** para validação prática de vulnerabilidades (OWASP Top 10:2025 e OWASP API Security Top 10:2023), testes de isolamento multi-tenant (BOLA/IDOR), conformidade LGPD e auditoria de código white-box.

O Strix roda no **host**, então `LLM_API_BASE` aponta para `http://127.0.0.1:${LITELLM_PORT}/v1`. Preencha `LLM_API_KEY` com uma chave virtual do LiteLLM (nunca a master key); o nome `http://litellm:4000/v1` só valeria se o Strix passasse a rodar dentro da `data_net`.

### 10.1. Execução Rápida via Script CLI
```bash
# Pentest de Aplicação Web (Dashboard Vanilla)
./scripts/run-strix-pentest.sh web --mode standard --budget 15

# Pentest de REST API guiado por OpenAPI com auto-seed de tenants (Alpha vs Beta)
./scripts/run-strix-pentest.sh api --seed --budget 20

# Auditoria White-box do código-fonte (SQLi, segredos, scripts shell)
./scripts/run-strix-pentest.sh code --mode quick --budget 10

# Bateria completa mapeada para OWASP Top 10:2025
./scripts/run-strix-pentest.sh owasp --mode deep --budget 30

# Exibir o último relatório consolidado gerado
./scripts/run-strix-pentest.sh report
```

### 10.2. Acionamento via Claude Code Skills
- `/api-security-testing`: Testa rotas REST contra o contrato `strix/openapi.yaml`.
- `/web-app-penetration-testing`: Pentest na interface web e autenticação `http://localhost:3000`.
- `/find-security-vulnerabilities-in-code`: Varredura white-box de código e queries SQL.
- `/owasp-top-10-testing`: Conformidade estrita com OWASP Top 10:2025.
- `/penetration-testing-with-strix`: Execução combinada multialvo.
- `/fix-security-vulnerabilities-with-strix`: Patch e contra-prova de remediação.

Para documentação técnica detalhada, consulte [docs/PENTEST_STRIX.md](docs/PENTEST_STRIX.md).

---

## 11. Teste de Carga e Benchmark de Capacidade (n8n & Servidor)

Script de estresse nativo em Python (`scripts/load-test-runner.py`, zero dependências externas) para mensurar limites simultâneos do servidor host e do container n8n:

### 11.1. Modos de Teste

1. **Checagem de Conectividade (`--check`)**:
   Valida se n8n e RabbitMQ Management API respondem antes da carga.
   ```bash
   python3 scripts/load-test-runner.py --check --password="$RABBITMQ_DEFAULT_PASS"
   ```

2. **Nível 1: Teto HTTP e Event Loop do n8n (`--mode=http`)**:
   Testa a saturação do processo Node.js do n8n com conexões simultâneas crescentes (5 -> 25 -> 50 -> 100).
   ```bash
   python3 scripts/load-test-runner.py --mode=http --n8n-url=http://127.0.0.1:5678
   ```

3. **Nível 2: Ingestão de Mensageria e Backpressure AMQP (`--mode=amqp`)**:
   Injeta rajadas de mensagens WhatsApp sintéticas na exchange `evolution` do RabbitMQ para avaliar consumo concorrente, prefetch e pressão de memória/banco.
   ```bash
   python3 scripts/load-test-runner.py --mode=amqp --password="$RABBITMQ_DEFAULT_PASS" --instance=fabio
   ```

### 11.2. Observabilidade Durante a Carga
Em terminais paralelos, acompanhar:
```bash
# Host CPU, I/O e RAM
vmstat 1
iostat -xz 1

# Containers Docker (atenção ao n8n: teto V8 de 2048MB)
docker stats --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"

# Filas RabbitMQ e alarmes de memória (watermark 60%)
curl -s -u root:"$RABBITMQ_DEFAULT_PASS" http://127.0.0.1:15672/api/nodes | jq '.[0] | {mem_used, mem_limit, mem_alarm}'
```


## 12. Atualização em Produção (VPS) — Um Comando, com Rollback

Esta seção responde a duas perguntas operacionais: **"como atualizo a VPS?"** e
**"como sei que a atualização realmente aconteceu?"**.

### 12.1. Fluxo normal

```bash
cd ~/Anne-IA          # ou onde o repositório vive na VPS
git status --short    # deve estar vazio
./scripts/update.sh   # pede confirmação; --yes para automação
```

O script executa 8 etapas e **aborta na primeira que falhar**:

| # | Etapa | O que garante |
|---|---|---|
| 1 | Preflight | branch correta, árvore Git limpa, `.env` com `chmod 600`, ≥ 2 GB livres, `flock` contra execução concorrente |
| 2 | Busca | `git fetch` do remoto e diff legível (commits + arquivos); `--dry-run` termina aqui sem escrever nada |
| 3 | Backup | `.env`, revisão anterior e `pg_dump` do banco `anneia` em `backups/` (retenção: 10 de cada) |
| 4 | Reconcílio `.env` | `sync-env.sh` só quando `.env.example` mudou + carimba `GIT_SHA=<sha>` |
| 5 | Compose | `docker compose config -q` antes de tocar em qualquer container |
| 6 | Schema | reaplica `init.sql` **somente** se ele mudou (ou `--schema`) |
| 7 | Aplicação | rebuild do dashboard **somente** se `dashboard/` mudou; `docker compose up -d` |
| 8 | Gate | `verify-stack.sh` com 15 verificações; falhou → **rollback automático** |

Códigos de saída: `0` sucesso (ou nada a fazer) · `1` abortado no preflight ·
`2` aplicado, gate falhou e o rollback foi executado.

Se o código já está na revisão certa, o script **não** reaplica schema nem
reconstrói imagem — mas confere se o *container* também está. Quando o container
ficou para trás (update interrompido depois do pull, `git pull` manual, container
recriado a partir de imagem antiga), ele converge: carimba o `GIT_SHA`, roda
`docker compose up -d` e revalida. A saída é uma das duas:

```
 NADA A FAZER — revisão e6197de já aplicada e stack saudável.
 CONVERGIDO — container recriado em e6197de, stack saudável.
```

### 12.2. Como afirmar que a VPS está na revisão certa

O `/api/health` devolve a revisão em execução:

```bash
curl -s http://127.0.0.1:${DASHBOARD_PORT:-41283}/api/health | jq
# {
#   "status": "ok",
#   "version": "1.2.6",      <- DASHBOARD_VERSION do .env
#   "sha": "abbdf62",        <- commit aplicado pelo update.sh
#   "uptime": 42,
#   "timestamp": "..."
# }
git -C ~/Anne-IA rev-parse --short HEAD   # compare com "sha"
```

O próprio gate já faz essa comparação e falha em divergência:

```bash
./scripts/verify-stack.sh --require-revision
# ...
#   [ok]   revisão: container em abbdf62 = HEAD do checkout
#  STACK SAUDÁVEL — 15 verificações ok
```

Quatro estados possíveis da checagem de revisão:

- `[ok]` — container e checkout no mesmo commit.
- `[aviso]` — container em outro commit, em execução **manual** do `verify-stack.sh`
  (num clone de desenvolvimento é normal rodar uma revisão atrás do HEAD).
- `[falha]` — divergência sob `--require-revision` (é o que o `update.sh` usa):
  atualização não aplicada ou imagem antiga.
- `[skip]` — `GIT_SHA=unknown`: a stack foi construída à mão, sem passar pelo
  `update.sh`. Rode `./scripts/update.sh` uma vez para começar a rastrear.

### 12.3. Flags úteis

```bash
./scripts/update.sh --dry-run        # mostra commits/arquivos; não escreve nada
./scripts/update.sh --yes            # não-interativo (cron, CI, systemd-timer)
./scripts/update.sh --schema         # força reaplicar o init.sql
./scripts/update.sh --branch main    # branch de origem (padrão: dev)
UPDATE_HEALTH_TIMEOUT=300 ./scripts/update.sh   # mais tempo para o gate
UPDATE_REMOTE=upstream ./scripts/update.sh      # remoto alternativo

# verificação manual da stack
./scripts/verify-stack.sh                  # divergência de revisão = [aviso]
./scripts/verify-stack.sh --require-revision   # divergência = falha (exit 1)
./scripts/verify-stack.sh --timeout 180        # aguarda convergência
```

Logs completos de cada execução: `logs/update-<AAAAmmdd-HHMMSS>.log`.

### 12.4. O que foi verificado antes de confiar neste fluxo

| Cenário | Resultado |
|---|---|
| `init.sql` em volume vazio (boot limpo) | 0 ERRORs, 21 tabelas, 51 triggers de auditoria |
| `init.sql` reaplicado em banco populado | 0 ERRORs, dado sentinela preservado |
| `UPDATE` em tabela **sem** coluna `id` (produtos, movimentações) | auditado com antes/depois |
| Update com 1 commit novo (só README) | exit 0, sha do health acompanhou o HEAD, sem rebuild |
| Rodar o update duas vezes seguidas | exit 0, "NADA A FAZER — revisão já aplicada" |
| Remoto divergente (`git pull` sem fast-forward) | abortado com exit 1, nada aplicado |
| Gate falhando (healthcheck sabotado) | **rollback**: código e `.env` restaurados, stack saudável, exit 2 |
| Bump de `N8N_VERSION` no `.env.example` | `[atualizada] 2.47.7 -> 2.49.7` no `.env` (a `2.47.8` nunca foi publicada; `2.49.7` lê o `configVersion=2` do SQLite) |
| `sync-env.sh` sobre `.env` preenchido | sha256 dos 12 segredos idêntico antes/depois |

### 12.5. Quando algo dá errado

| Sintoma | Causa provável | Ação |
|---|---|---|
| `[erro] Árvore Git suja` | commit/edição local na VPS | commite ou `git checkout -- .` **antes** de atualizar |
| `[erro] git pull --ff-only falhou` | histórico divergente | `git log --oneline HEAD..origin/dev` e reconcilie na sua máquina |
| `[erro] branch atual 'x' != esperada 'dev'` | VPS numa branch errada | `git switch dev` ou use `--branch` |
| `init.sql falhou` | mudança de schema inválida | leia `logs/schema-<ts>.log`; o código **não** foi trocado |
| `ROLLBACK CONCLUÍDO` (exit 2) | update quebrou a stack | stack está na revisão anterior e saudável; corrija e republique |
| `ROLLBACK INCOMPLETO` (exit 2) | falha generalizada | restaure `backups/anneia-<ts>.sql.gz` e `backups/env-<ts>` manualmente |
| health com `sha` de outro commit | container antigo | `docker compose up -d dashboard` ou rode o update novamente |
| `update` diz `CONVERGIDO` mas a versão da imagem não muda | variável exportada no shell vence o `.env` (Compose) | `unset DASHBOARD_VERSION` / `unset N8N_VERSION` antes de rodar; o `update.sh` já exporta o `GIT_SHA` que ele mesmo carimba |

### 12.6. Rollback manual (sem o script)

```bash
# 1. código
git reset --hard "$(cat backups/rev-<ts>)"

# 2. .env
cp -p backups/env-<ts> .env && chmod 600 .env

# 3. banco (somente se o schema mudou de forma incompatível)
gunzip -c backups/anneia-<ts>.sql.gz | \
  docker exec -i db-evolution psql -U evolution -d anneia

# 4. subir e verificar
docker compose up -d --build
./scripts/verify-stack.sh --timeout 180
```

### 12.7. Hooks de Git (opcional, recomendado)

Com `git config core.hooksPath .githooks`, o `.env` é sincronizado automaticamente
após `git pull`/`git merge` (`post-merge`) e após `git pull --rebase`
(`post-rewrite`) — este último sempre, porque durante o rebase o `ORIG_HEAD` não é
confiável e o `sync-env.sh` é idempotente e nunca sobrescreve segredos.
