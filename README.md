# Anne-IA — Stack Docker (n8n, Evolution API, Postgres, Redis, RabbitMQ, pgAdmin, Dashboard)

A stack é auto-inicializável a partir de um clone limpo. A pasta `setup/` concentra as configurações de infraestrutura:

| Artefato | Papel |
|---|---|
| `setup/rabbitmq/rabbitmq.conf` | Limites de memória/disco, paginação, timeout de LLM e carga de definições. |
| `setup/rabbitmq/definitions.json.template` | Topologia padrão industrial: exchanges diretas, pipeline em 4 etapas com Quorum Queues e DLX/DLQ (senha via `.env`). |
| `setup/rabbitmq/entrypoint.sh` | Injeta a senha no template e gera o `definitions.json`. |
| `setup/postgres/init.sql` | **Fonte única (SSOT 100% idempotente)**: schema do negócio, memória LangChain indexada (`memorypostgreschat` com `idx_memorypostgreschat_session` e `criado_em` para retenção LGPD), base RAG isolada multi-tenant (`base_conhecimento` com `instance_id`, índices HNSW vetoriais, B-tree composto de paginação e GIN trigram `pg_trgm`), `clientes` + `Instance` (Evolution API), **alinhamento 1:1** entre `public."Instance"` e `public.clientes` pelo mesmo ID (`clientes.id = Instance.id`), `prompt_config` (persona/role/playbook por cliente), `prompts_padrao` (prompts mestres globais para roteamento e economia de modelos), **ledger contábil e função de custeio** (`precos_modelos`, `uso_tokens`, `fn_registrar_uso_tokens` com idempotência estrita e precificação dinâmica), **autenticação e sessões server-side** (`dashboard_usuarios`, `dashboard_identidades` cifrada via AES-256-GCM com blind index HMAC-SHA-256, `dashboard_contatos`, `dashboard_credenciais` com hash NIST `scrypt`, `dashboard_sessoes`, `dashboard_consentimentos` LGPD e `dashboard_auditoria_auth`) e **governança LGPD nativa** (`lgpd_auditoria` com hash SHA-256 via `pgcrypto`, `vw_clientes_mascarado`, `fn_lgpd_anonimizar_titular`, `fn_lgpd_anonimizar_cliente` e `fn_lgpd_expurgo_retencao`). |
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
- **Tema Claro Padrão & Seletor de Tema**: Inicialização em tema claro (branco) por padrão, seguindo automaticamente as preferências do sistema operacional (`prefers-color-scheme: dark`) caso não haja preferência manual salva, com botão alternador (Sol / Lua) no cabeçalho persistido no `localStorage` e script anti-FOUC no `<head>`.
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
   - Catálogo de modelos com precificação por 1M tokens (input, output, cache, reasoning) e **classificação por Níveis** (`Nível 1`, `Nível 2`, `Nível 3`).
   - Cadastro, edição e desativação segura protegendo integridade de auditoria contábil.
   - Teste de conectividade e inferência direta via 9Router com medição de latência em milissegundos e rate limit defensivo.
6. **Base de Conhecimento RAG & Vetores pgvector (Sub-aba Base de Conhecimento)**:
   - Central de auditoria e inspeção de fragmentos (chunks) textuais, metadados JSONB e embeddings na tabela `base_conhecimento`.
   - Índices de performance industrial: B-tree composto `(instance_id, id DESC)` para paginação multi-tenant instantânea e GIN `pg_trgm` para buscas textuais rápidas.
   - Projeção de dados otimizada sem tráfego de vetores brutos (zero vector leakage).
   - Filtro por tenant/empresa, busca textual em tempo real, visualizador completo com syntax highlighting de metadados, contagem de tokens e exclusão/cadastro rápido.

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
| `GET` | `/api/v1/9router/status` | Retorna diagnóstico de conectividade, endpoint e lista de modelos do 9Router |
| `GET` | `/api/v1/modelos` | Lista catálogo de modelos de IA, status e custos por 1M tokens |
| `POST` | `/api/v1/modelos` | Cadastra novo modelo com preços de entrada/saída sanitizados |
| `PUT` | `/api/v1/modelos/:id` | Atualiza parâmetros e vigência de precificação do modelo |
| `DELETE` | `/api/v1/modelos/:id` | Exclui ou desativa modelo (soft-delete seguro se houver histórico contábil) |
| `POST` | `/api/v1/modelos/:id/testar` | Dispara teste de ping/inferência no 9Router e afere latência |
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

---

## 9. Atualizar Schema sem Perda de Dados, Governança LGPD e Recriação Total

### 9.1. Reaplicar `init.sql` em Banco em Execução (Sem Apagar Dados)
Como `setup/postgres/init.sql` é **100% idempotente** (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`), alterações de schema, índices ou funções podem ser aplicadas diretamente no container ativo sem derrubar volumes:

```bash
docker exec -i db-evolution psql -v ON_ERROR_STOP=1 -U evolution -d postgres < setup/postgres/init.sql
```

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

### 9.3. Recriar Banco e RabbitMQ do Zero (Destrutivo)
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

