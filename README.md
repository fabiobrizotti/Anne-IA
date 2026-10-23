# Anne-IA — Stack Docker (n8n, Evolution API, Postgres, Redis, RabbitMQ, pgAdmin, Dashboard)

A stack é auto-inicializável a partir de um clone limpo. A pasta `setup/` concentra as configurações de infraestrutura:

| Artefato | Papel |
|---|---|
| `setup/rabbitmq/rabbitmq.conf` | Limites de memória/disco, paginação, timeout de LLM e carga de definições. |
| `setup/rabbitmq/definitions.json.template` | Topologia padrão industrial: exchanges diretas, pipeline em 3 etapas com Quorum Queues e DLX/DLQ (senha via `.env`). |
| `setup/rabbitmq/entrypoint.sh` | Injeta a senha no template e gera o `definitions.json`. |
| `setup/postgres/init.sql` | **Fonte única**: schema do negócio, memória LangChain (`memorypostgreschat`), base RAG (`base_conhecimento`), `clientes` + `Instance` (Evolution API), **alinhamento 1:1** entre `public."Instance"` e `public.clientes` pelo mesmo ID (`clientes.id = Instance.id`), `prompt_config` (persona/role/playbook por cliente), **ledger de custos** (`precos_modelos`, `uso_tokens` por requisição com idempotência). Backfill idempotente e não-destrutivo. |
| `setup/pgadmin/servers.json` | Auto-provisionamento da conexão do PostgreSQL no pgAdmin 4. |
| `setup/n8n/clean-workflows.js` | Limpa workflows antigos no SQLite antes de reimportar (idempotência). |
| `setup/n8n/sanitize-workflow.js` | Remove rastros da instância de origem para evitar falhas no import. |

Os workflows do n8n não são versionados aqui. Eles vêm de `fabiobrizotti/n8n_anneia_workflows`. O container `n8n-import` usa o `GITHUB_TOKEN` para clonar e aplicar automaticamente.

## 1. Pré-requisitos
- Docker Engine com Compose v2 (usuário no grupo `docker`: `sudo usermod -aG docker $USER && newgrp docker`).
- Portas livres: `5678` (n8n), `8081` (Evolution), `5432` (Postgres), `6379` (Redis), `5672`/`15672` (RabbitMQ), `20000` (9Router), `5050` (pgAdmin), `3000` (Dashboard).
- Conta no GitHub com acesso de leitura (token) ao repositório dos workflows.

## 2. Instalação

<details>
<summary><strong><img src="https://raw.githubusercontent.com/devicons/devicon/master/icons/linux/linux-original.svg" width="16" height="16" /> Linux</strong></summary>

```bash
git clone https://github.com/fabiobrizotti/Anne-IA
cd Anne-IA

# Gera o .env, sincroniza chaves novas e preenche senhas fortes Base62 (32 chars)
chmod +x scripts/*.sh
./scripts/sync-env.sh

# (Opcional) Ativa sincronização automática do .env após 'git pull'
git config core.hooksPath .githooks

# Edite o .env para preencher seu GITHUB_TOKEN e N8N_INSTANCE_OWNER_EMAIL
# (as senhas de banco, redis, rabbitmq e 9router já foram geradas com segurança)

# O n8n roda como UID 1000, pgAdmin como UID 5050; 9Router persiste em ./data/9router
mkdir -p ./data/n8n ./workflows ./data/9router ./data/pgadmin
sudo chown -R 1000:1000 ./data/n8n ./workflows
sudo chown -R 5050:5050 ./data/pgadmin

# Sobe a stack rodando os scripts de setup
docker compose --profile setup up -d

# Reinicie o n8n na primeira vez para carregar os workflows importados
docker compose restart n8n
```

</details>

<details>
<summary><strong><img src="https://raw.githubusercontent.com/devicons/devicon/master/icons/windows8/windows8-original.svg" width="16" height="16" /> Windows (Powershell)</strong></summary>

```powershell
git clone https://github.com/fabiobrizotti/Anne-IA
cd Anne-IA

copy .env.example .env
# Edite o .env com suas senhas e o GITHUB_TOKEN

# Docker Desktop resolve permissões de usuário nativamente, basta criar as pastas:
mkdir data\n8n
mkdir workflows
mkdir data\9router
mkdir data\pgadmin

# Sobe a stack rodando os scripts de setup
docker compose --profile setup up -d

# Reinicie o n8n na primeira vez para carregar os workflows importados
docker compose restart n8n
```

</details>

O perfil `setup` sobe toda a infraestrutura e executa os scripts via variáveis de ambiente e entrypoints. O `n8n-import` espera o n8n estar saudável antes de limpar e injetar os workflows novos.

**Para atualizar (reimportar) os workflows:**
```bash
docker compose stop n8n
docker compose --profile setup rm -f n8n-import
docker compose --profile setup run --rm --no-deps n8n-import
docker compose start n8n
```

## 3. Gestão e Sincronização de Ambiente (.env)
A infraestrutura utiliza o `.env.example` como fonte única da verdade estrutural (schema).

- **Sincronizar variáveis e gerar senhas**: Execute `./scripts/sync-env.sh` (ou `./scripts/generate-passwords.sh`). Ele insere novas variáveis adicionadas ao `.env.example`, preserva todos os valores e senhas locais já configurados, cria backup atômico (`.env.bak`) e gera senhas Base62 (32 caracteres alfanuméricos) para credenciais vazias.
- **Auditoria de divergências (Diff)**: Execute `./scripts/sync-env.sh --diff` para visualizar chaves ausentes, chaves órfãs e valores customizados localmente vs defaults do `.env.example` (com máscara automática em credenciais).
- **Automação pós-`git pull`**: Execute `git config core.hooksPath .githooks` uma única vez. Sempre que um `git pull` trouxer alterações no `.env.example`, o `.env` local será sincronizado automaticamente.

### Variáveis Críticas de Autenticação:
- `RABBITMQ_DEFAULT_PASS`: Senha admin do RabbitMQ (sincronizada em `CHAVE_RABBITMQ_DEFAULT_PASS`).
- `POSTGRES_PASSWORD`: Senha do PostgreSQL (sincronizada em `CHAVE_POSTGRES_PASSWORD`).
- `REDIS_PASSWORD`: Senha do Redis (sincronizada em `CHAVE_REDIS_PASSWORD`).
- `NINE_ROUTER_PASSWORD`: Senha admin do 9Router (sincronizada em `CHAVE_NINE_ROUTER_PASSWORD`). O compose publica esta variável no container como `INITIAL_PASSWORD`, único nome lido pela imagem.
- `N8N_ENCRYPTION_KEY`: Chave para criptografia de credenciais internas do n8n.
- `AUTHENTICATION_API_KEY`: Chave de autenticação da Evolution API.
- `PGADMIN_DEFAULT_EMAIL`: E-mail de login no pgAdmin 4.
- `PGADMIN_DEFAULT_PASSWORD`: Senha de acesso admin ao pgAdmin 4.
- `DASHBOARD_PASSWORD`: Senha do painel administrativo de instâncias (usuário: `admin`).
- `GITHUB_TOKEN`: Formato `ghp_...` ou token pessoal para clonar os workflows no n8n-import.
- `N8N_INSTANCE_OWNER_EMAIL`: E-mail do owner da instância n8n.

## 4. Estrutura de Diretórios
- `setup/`: Scripts de boot (versionado).
- `data/`: Bancos e dados — postgres, redis, rabbitmq, n8n, evolution-api, 9router e pgadmin (ignorado via .gitignore).
- `files/`: Exports (ignorado).
- `workflows/`: Clone local automático dos workflows do n8n (ignorado).

## 5. Roteamento de IA (9Router)
O 9Router centraliza provedores de LLM e atua como gateway universal compatível com OpenAI/Anthropic:
- **Dashboard Web**: `http://localhost:20000` (autentique com `NINE_ROUTER_PASSWORD`).

> **Senha do 9Router — como funciona de verdade**
> A imagem `decolua/9router` não lê `NINE_ROUTER_PASSWORD`: ela consulta `INITIAL_PASSWORD`
> (default `123456`). O bloco `9router` do `docker-compose.yml` publica a variável do projeto
> sob esse nome via `environment:`, então a senha do `.env` é a senha de login.
>
> Nesta versão (`NINE_ROUTER_VERSION`), o env permanece autoritativo: trocar
> `NINE_ROUTER_PASSWORD` no `.env` e rodar `docker compose up -d 9router` já altera a senha,
> sem necessidade de reset. Se algum dia a versão passar a gravar hash próprio, o sintoma será
> o login recusar a senha do `.env` com `/api/auth/status` reportando `hasPassword: true` —
> nesse caso o reset é `docker compose stop 9router && sqlite3 data/9router/db/data.sqlite
> "DELETE FROM settings WHERE id=1;" && docker compose up -d 9router`.

- **Endpoint interno para n8n / LangChain**: `http://9router:20000/v1` (usar credencial OpenAI compatível com a chave de API gerada no dashboard do 9Router).

## 6. Painel Web PostgreSQL (pgAdmin 4)
O pgAdmin 4 oferece interface gráfica para gerenciar esquemas, tabelas e vetores (pgvector) no PostgreSQL:
- **Acesso Web**: `http://127.0.0.1:5050` (restrito ao host local para máxima segurança).
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

### 7.2. Pipeline em 3 Estágios do Projeto

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
[FILA 2: anne.ai.process.q] ──(n8n RAG / LLM)───┐
                                                │
   ┌────────────────────────────────────────────┘
   │ (rk: outbound.dispatch)
   ▼
[FILA 3: anne.outbound.dispatch.q] ──(n8n humanização / envio WhatsApp)
```

| Estágio | Finalidade | Exchange de Ingress / Trabalho | Routing Key | Fila Quorum Principal | DLX | Routing Key DLQ | Fila Dead Letter (DLQ) |
|---|---|---|---|---|---|---|---|
| **1. Inbound** | Recepção de conversas e dados brutos do cliente (WhatsApp/Evolution) | `evolution` (Topic) / `anne.direct.work` | `MESSAGES_UPSERT` / `inbound.received` | `anne.inbound.raw.q` | `anne.direct.dlx` | `dlq.inbound` | `anne.inbound.raw.dlq` |
| **2. Core IA** | Motor principal de raciocínio, contexto, RAG e chamadas de LLM | `anne.direct.work` | `ai.process` | `anne.ai.process.q` | `anne.direct.dlx` | `dlq.ai` | `anne.ai.process.dlq` |
| **3. Outbound**| Humanização, formatação e despacho das respostas ao cliente | `anne.direct.work` | `outbound.dispatch`| `anne.outbound.dispatch.q` | `anne.direct.dlx` | `dlq.outbound` | `anne.outbound.dispatch.dlq` |

---

### 7.3. Estratégias de Resiliência e Prevenção de Perdas

1. **Persistência Total (Quorum Queues)**:
   - Todas as filas operam com `x-queue-type: quorum`, mantendo Write-Ahead Log (WAL) no disco. Em caso de queda de energia ou reinicialização do computador, nenhuma mensagem é perdida.
2. **Proteção contra Mensagens Venenosas (`x-delivery-limit`)**:
   - `anne.inbound.raw.q`: `3` tentativas antes de desviar para DLQ.
   - `anne.ai.process.q`: `2` tentativas antes de desviar para DLQ (impede loops caros ou infinitos de chamadas à LLM).
   - `anne.outbound.dispatch.q`: `3` tentativas antes de desviar para DLQ.
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
- **Nós RabbitMQ (Publicadores)**:
  - Exchange: `anne.direct.work`.
  - Delivery Mode: `2 - Persistent`.

---

## 8. Painel Administrativo Vanilla (Gestão de Instâncias e Clientes)

O Dashboard administrativo é uma aplicação web ultra-leve construída em **Vanilla HTML5, CSS puro e JavaScript nativo** (com backend enxuto em Node.js 20 Alpine). Ele consome menos de 30MB de memória RAM no servidor e inicia automaticamente junto ao Docker Compose.

### 8.1. Acesso ao Painel
- **URL**: `http://127.0.0.1:3000` (restrito ao host local por segurança).
- **Autenticação**:
  - Usuário: `DASHBOARD_USERNAME` (padrão: `admin`).
  - Senha: `DASHBOARD_PASSWORD` (gerada automaticamente no `.env`).

### 8.2. Interface e Experiência Neutra
- **Design Monocromático Neutro**: Visual preto e branco sóbrio, livre de neons, gradientes coloridos ou elementos visuais decorativos supérfluos.
- **Tema Claro/Escuro do Sistema**: Adaptação automática e instantânea às preferências do sistema operacional (`prefers-color-scheme: light/dark`) com `color-scheme: light dark`.
- **Rastreabilidade Temporal**: Indicador global "Atualizado em" no cabeçalho com horário da última sincronização, coluna dedicada na tabela e registros tabulares (`tabular-nums`) de criação e modificação.

### 8.3. Funcionalidades Principais
1. **Gestão Centralizada e Ficha do Cliente (Dossier)**:
   - Tabela `clientes` no PostgreSQL (`anneia`), onde o campo `id` é estritamente imutável e idêntico ao `instanceName`/`instanceId` da Evolution API, acompanhado de `codigo` numérico sequencial (`BIGSERIAL UNIQUE`) para referência simplificada de faturamento e ledger.
   - **Prontuário Completo**: Modal administrativo para consulta e edição de dados do cliente (Nome, E-mail, Status Ativo).
   - **Histórico Persistente de Telefones**: Mudanças de número registram automaticamente o número anterior, novo número, data (ISO 8601) e motivo da alteração em coluna `JSONB` (`historico_telefones`) com auditoria.
   - **Conexão Direta**: Botão para disparar o fluxo de conexão do WhatsApp com o número preenchido na ficha.
2. **Conexão ao WhatsApp sem Complicações**:
   - **Código de Pareamento (Pairing Code)**: Informe o número com DDD e receba um código de 8 dígitos para digitar no celular diretamente, sem depender de câmera.
   - **QR Code em Alta Resolução**: Renderização confiável de imagens base64 geradas pelo Baileys na Evolution API, com atualização manual e auto-polling de status.
3. **Ajuste de Comportamento (Settings)**:
   - Rejeição automática de chamadas de voz e vídeo com mensagem explicativa customizável.
   - Ignorar mensagens em grupos para focar apenas no atendimento privado.
   - Manter status sempre online, recibo de leitura (tique azul), visualização de status e sincronização de histórico.
4. **Painel Financeiro & Métricas de Tokens (Aba Financeiro)**:
   - Visualização dedicada com KPIs de custo acumulado (USD), requisições LLM, tokens totais (prompt/completion) e taxa de cache.
   - Gráfico temporal diário interativo (SVG puro) com alternador de visão em tabela (WCAG acessível).
   - Rankings em barras horizontais de custo por cliente e consumo por modelo.
   - Tabela de detalhamento analítico por cliente com busca textual instantânea.
5. **Modelos de IA & Gestão de Custos (Aba Modelos de IA)**:
   - Catálogo de modelos com precificação por 1M tokens (input, output, cache, reasoning).
   - Cadastro, edição e desativação segura protegendo integridade de auditoria.
   - Teste de conectividade e inferência direta via 9Router com medição de latência em milissegundos e rate limit defensivo.

### 8.4. Endpoints da API REST (v1)

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/health` | Healthcheck simples da aplicação |
| `GET` | `/api/v1/instances` | Lista clientes e status em tempo real da Evolution API |
| `POST` | `/api/v1/instances` | Cria nova instância na Evolution e cadastra no PostgreSQL |
| `PUT` | `/api/v1/instances/:id` | Atualiza dados do cliente e anexa histórico de telefones no PostgreSQL |
| `GET` | `/api/v1/instances/:id/connect` | Gera Pairing Code (via query `?number=`) ou QR Code em base64 |
| `GET` | `/api/v1/instances/:id/status` | Retorna estado de conexão em tempo real (`open`, `connecting`, `close`) |
| `GET` | `/api/v1/instances/:id/settings` | Obtém configurações comportamentais da instância |
| `POST` | `/api/v1/instances/:id/settings` | Salva configurações comportamentais na Evolution e no banco |
| `GET` | `/api/v1/instances/:id/prompt` | Busca config de prompts do agente (`prompt_config`: identidade, papel, personalidade, playbook, escalação, system prompt) |
| `PUT` | `/api/v1/instances/:id/prompt` | Salva config de prompts do agente (upsert idempotente em `prompt_config`) |
| `GET` | `/api/v1/financeiro` | Retorna métricas analíticas de custo e tokens por período (`?dias=7\|30\|90`) |
| `GET` | `/api/v1/9router/status` | Retorna diagnóstico de conectividade, endpoint e lista de modelos do 9Router |
| `GET` | `/api/v1/modelos` | Lista catálogo de modelos de IA, status e custos por 1M tokens |
| `POST` | `/api/v1/modelos` | Cadastra novo modelo com preços de entrada/saída sanitizados |
| `PUT` | `/api/v1/modelos/:id` | Atualiza parâmetros e vigência de precificação do modelo |
| `DELETE` | `/api/v1/modelos/:id` | Exclui ou desativa modelo (soft-delete seguro se houver histórico contábil) |
| `POST` | `/api/v1/modelos/:id/testar` | Dispara teste de ping/inferência no 9Router e afere latência |
| `POST` | `/api/v1/instances/:id/restart` | Reinicia a conexão da instância |
| `DELETE` | `/api/v1/instances/:id` | Remove a instância na Evolution API e no banco de dados |

---

## 9. Recriar Banco e RabbitMQ
Se alterar os scripts em `setup/` (como uma nova tabela no `init.sql`), aplique forçando a recriação. 
**Atenção:** o `init.sql` do Postgres só roda se a pasta de dados estiver vazia.

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