# Anne-IA — Stack Docker (n8n, Evolution API, Postgres, Redis, RabbitMQ)

A stack é auto-inicializável a partir de um clone limpo. A pasta `setup/` concentra as configurações de infraestrutura:

| Artefato | Papel |
|---|---|
| `setup/rabbitmq/rabbitmq.conf` | Limites de memória/disco e instrução para carregar definições. |
| `setup/rabbitmq/definitions.json.template` | Modelo com filas quorum, policy e usuário (senha via `.env`). |
| `setup/rabbitmq/entrypoint.sh` | Injeta a senha no template e gera o `definitions.json`. |
| `setup/postgres/init.sql` | Schema do negócio, memória LangChain (`memorypostgreschat`) e base RAG (`base_conhecimento`). |
| `setup/n8n/clean-workflows.js` | Limpa workflows antigos no SQLite antes de reimportar (idempotência). |
| `setup/n8n/sanitize-workflow.js` | Remove rastros da instância de origem para evitar falhas no import. |

Os workflows do n8n não são versionados aqui. Eles vêm de `fabiobrizotti/n8n_anneia_workflows`. O container `n8n-import` usa o `GITHUB_TOKEN` para clonar e aplicar automaticamente.

## 1. Pré-requisitos
- Docker Engine com Compose v2.
- Portas livres: `5678` (n8n), `8081` (Evolution), `5432` (Postgres), `6379` (Redis), `5672`/`15672` (RabbitMQ).
- Conta no GitHub com acesso de leitura (token) ao repositório dos workflows.

## 2. Instalação

<details>
<summary><strong><img src="https://raw.githubusercontent.com/devicons/devicon/master/icons/linux/linux-original.svg" width="16" height="16" /> Linux</strong></summary>

```bash
git clone https://github.com/fabiobrizotti/Anne-IA
cd Anne-IA

cp .env.example .env
# Edite o .env com suas senhas e o GITHUB_TOKEN

# O n8n roda como UID 1000 e precisa de permissão de escrita
mkdir -p ./data/n8n ./workflows
sudo chown -R 1000:1000 ./data/n8n ./workflows

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
- `RABBITMQ_DEFAULT_PASS`: Senha admin. Reflita em `CHAVE_RABBITMQ_DEFAULT_PASS`.
- `POSTGRES_PASSWORD`: Senha banco. Reflita em `CHAVE_POSTGRES_PASSWORD`.
- `REDIS_PASSWORD`: Senha Redis. Reflita em `CHAVE_REDIS_PASSWORD`.
- `N8N_ENCRYPTION_KEY`: Chave para credenciais internas do n8n.
- `GITHUB_TOKEN`: Formato `x-access-token:<token>@github.com/...` para clonar os workflows.
- `N8N_INSTANCE_OWNER_EMAIL`: E-mail owner da instância n8n.

## 4. Estrutura de Diretórios
- `setup/`: Scripts de boot (versionado).
- `data/`: Bancos e dados (ignorado via .gitignore).
- `files/`: Exports (ignorado).
- `workflows/`: Clone local automático dos workflows do n8n (ignorado).

## 5. Recriar Banco e RabbitMQ
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