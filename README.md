# Anne-IA — Stack Docker (n8n, Evolution API, Postgres, Redis, RabbitMQ, pgAdmin)

A stack é auto-inicializável a partir de um clone limpo. A pasta `setup/` concentra as configurações de infraestrutura:

| Artefato | Papel |
|---|---|
| `setup/rabbitmq/rabbitmq.conf` | Limites de memória/disco e instrução para carregar definições. |
| `setup/rabbitmq/definitions.json.template` | Modelo com filas quorum, policy e usuário (senha via `.env`). |
| `setup/rabbitmq/entrypoint.sh` | Injeta a senha no template e gera o `definitions.json`. |
| `setup/postgres/init.sql` | Schema do negócio, memória LangChain (`memorypostgreschat`) e base RAG (`base_conhecimento`). |
| `setup/pgadmin/servers.json` | Auto-provisionamento da conexão do PostgreSQL no pgAdmin 4. |
| `setup/n8n/clean-workflows.js` | Limpa workflows antigos no SQLite antes de reimportar (idempotência). |
| `setup/n8n/sanitize-workflow.js` | Remove rastros da instância de origem para evitar falhas no import. |

Os workflows do n8n não são versionados aqui. Eles vêm de `fabiobrizotti/n8n_anneia_workflows`. O container `n8n-import` usa o `GITHUB_TOKEN` para clonar e aplicar automaticamente.

## 1. Pré-requisitos
- Docker Engine com Compose v2.
- Portas livres: `5678` (n8n), `8081` (Evolution), `5432` (Postgres), `6379` (Redis), `5672`/`15672` (RabbitMQ), `20000` (9Router), `5050` (pgAdmin).
- Conta no GitHub com acesso de leitura (token) ao repositório dos workflows.

## 2. Instalação

<details>
<summary><strong><img src="https://raw.githubusercontent.com/devicons/devicon/master/icons/linux/linux-original.svg" width="16" height="16" /> Linux</strong></summary>

```bash
git clone https://github.com/fabiobrizotti/Anne-IA
cd Anne-IA

# Gera o .env e preenche senhas fortes alfanuméricas (32 chars, Base62) sem quebrar URIs
chmod +x scripts/generate-passwords.sh
./scripts/generate-passwords.sh

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

## 3. Variáveis Obrigatórias (.env)
Todas as senhas da stack podem ser geradas automaticamente executando `./scripts/generate-passwords.sh` (Base62 alfanumérico, sem símbolos que quebrem URIs ou Docker Compose):
- `RABBITMQ_DEFAULT_PASS`: Senha admin do RabbitMQ (sincronizada em `CHAVE_RABBITMQ_DEFAULT_PASS`).
- `POSTGRES_PASSWORD`: Senha do PostgreSQL (sincronizada em `CHAVE_POSTGRES_PASSWORD`).
- `REDIS_PASSWORD`: Senha do Redis (sincronizada em `CHAVE_REDIS_PASSWORD`).
- `NINE_ROUTER_PASSWORD`: Senha admin do 9Router (sincronizada em `CHAVE_NINE_ROUTER_PASSWORD`).
- `N8N_ENCRYPTION_KEY`: Chave para criptografia de credenciais internas do n8n.
- `AUTHENTICATION_API_KEY`: Chave de autenticação da Evolution API.
- `PGADMIN_DEFAULT_EMAIL`: E-mail de login no pgAdmin 4.
- `PGADMIN_DEFAULT_PASSWORD`: Senha de acesso admin ao pgAdmin 4.
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
- **Endpoint interno para n8n / LangChain**: `http://9router:20000/v1` (usar credencial OpenAI compatível com a chave de API gerada no dashboard do 9Router).

## 6. Painel Web PostgreSQL (pgAdmin 4)
O pgAdmin 4 oferece interface gráfica para gerenciar esquemas, tabelas e vetores (pgvector) no PostgreSQL:
- **Acesso Web**: `http://127.0.0.1:5050` (restrito ao host local para máxima segurança).
- **Autenticação**:
  - Usuário: `PGADMIN_DEFAULT_EMAIL` (padrão: `admin@anne.ia`).
  - Senha: `PGADMIN_DEFAULT_PASSWORD` (gerada automaticamente no `.env`).
- **Auto-Provisionamento**: A conexão com o banco `db-evolution` é importada automaticamente no boot a partir de `setup/pgadmin/servers.json`.

## 7. Recriar Banco e RabbitMQ
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