# Anne-IA — Stack Docker (n8n + Evolution API + Postgres + Redis + RabbitMQ)

Este documento descreve como subir esta stack do zero em uma nova instância/servidor.

A stack é **auto-inicializável a partir de um clone limpo**. A pasta `setup/` (versionada no
repositório) concentra os artefatos de inicialização:

| Artefato | Papel |
|---|---|
| `setup/rabbitmq/rabbitmq.conf` | configuração do broker (definições + limites de memória/disco) |
| `setup/rabbitmq/definitions.json.template` | modelo com filas quorum, policy e usuário (senha via `.env`) |
| `setup/rabbitmq/entrypoint.sh` | injeta `RABBITMQ_DEFAULT_PASS` no template e gera o `definitions.json` |
| `setup/postgres/init.sql` | cria tabelas de negócio, memória da IA (LangChain) e base RAG (pgvector) |
| `setup/n8n/clean-workflows.js` | limpeza idempotente dos workflows no `database.sqlite` antes de reimportar |
| `setup/n8n/sanitize-workflow.js` | remove campos da instância de origem (`activeVersion`, `shared`, ...) que quebram o import e força `active=false` |

Os **workflows do n8n não são versionados neste repositório** — eles vêm do repositório
GitHub de workflows (`n8n_anneia_workflows`), clonado no bootstrap via `n8n-import`
(segue a variável `GITHUB_TOKEN`). O usuário final não precisa manipular workflows.

---

## Pré-requisitos

- Docker Engine **com Compose v2** instalado.
- Portas liberadas (padrão): `5678` (n8n), `8081` (Evolution API), `5432` (Postgres),
  `6379` (Redis), `5672`/`15672` (RabbitMQ).
- Acesso de leitura ao repositório de workflows do n8n
  (`fabiobrizotti/n8n_anneia_workflows`) para uso do `GITHUB_TOKEN`.

---

## 1. Instalação (um comando)

```bash
# 1) Clone o repositório
git clone git@github.com:fabioluis0312/Anne-IA.git
cd Anne-IA

# 2) Configure o ambiente
cp .env.example .env
#    -> preencha as senhas/chaves (veja "Variáveis importantes" abaixo)

# 3) Ajuste as permissões das pastas de volume
#    (o Docker cria pastas de volume como root por padrão; o n8n roda no container
#     como usuário node - UID 1000 - e não consegue escrever em pastas de root)
mkdir -p ./data/n8n ./workflows
sudo chown -R 1000:1000 ./data/n8n ./workflows

# 4) Suba tudo com o perfil `setup` (bootstrap completo)
docker compose --profile setup up -d
```

O perfil `setup` executa **todo o provisionamento** em uma única chamada:

- `rabbitmq` sobe **pré-configurado**: o `entrypoint.sh` gera o `definitions.json` a partir
  do template (injeta `RABBITMQ_DEFAULT_PASS`), criando o usuário `root`, as filas quorum
  `client-infos` e `format-message`, e a policy `politica_quorum_padrao`.
- `db-evolution` executa o `setup/postgres/init.sql` na **primeira subida** (via
  `/docker-entrypoint-initdb.d`), criando as extensões `pg_trgm`/`vector` e as tabelas
  `produtos`, `movimentacoes_estoque`, `memorypostgreschat` e `base_conhecimento`.
- `n8n-import` clona o repositório de workflows do GitHub, remove quaisquer workflows já
  existentes no `database.sqlite` (importação idempotente, via `setup/n8n/clean-workflows.js`),
  sanitiza cada workflow (remove `activeVersion`/`shared`, força `active=false`, via
  `setup/n8n/sanitize-workflow.js`) e então os importa no n8n.

> **Reimportação padrão** (o `n8n-import` é um container one-shot: roda e sai. Não reutilize
> o container parado — remova-o antes e importe em um container novo):
> ```bash
> docker compose stop n8n                          # compartilha o mesmo database.sqlite
> docker compose --profile setup rm -f n8n-import  # remove o container one-shot antigo
> docker compose --profile setup run --rm n8n-import
> docker compose start n8n
> ```
> > Evita o erro `failed to set up container networking: network ... not found`, que ocorre
> > quando o `--profile setup up -d` tenta reutilizar o container one-shot parado ligado a
> > uma rede que já foi recriada.

---

## 3. Variáveis importantes

| Variável | Obrigatória | Descrição |
|---|---|---|
| `RABBITMQ_DEFAULT_PASS` | **sim** | Senha do usuário `root` do RabbitMQ. Também injetada no `definitions.json` (filas/policy). Use a mesma em `CHAVE_RABBITMQ_DEFAULT_PASS` (`RABBITMQ_URI`). |
| `POSTGRES_PASSWORD` | **sim** | Senha do Postgres (`db-evolution`). Use a mesma em `CHAVE_POSTGRES_PASSWORD` (`DATABASE_CONNECTION_URI`). |
| `REDIS_PASSWORD` | **sim** | Senha do Redis. Use a mesma em `CHAVE_REDIS_PASSWORD`. |
| `N8N_ENCRYPTION_KEY` | **sim** | Chave de criptografia das credenciais do n8n. |
| `GITHUB_TOKEN` | **sim** | Token com acesso de leitura ao repo de workflows do n8n. Usado no formato `x-access-token:<token>@github.com/...`. **Nunca exiba o token em logs/screenshots — se vazar, revogue-o e gere um novo.** |
| `N8N_INSTANCE_OWNER_EMAIL` | sim | E-mail do usuário dono da instância n8n. |

> **Importante**: `CHAVE_*` são usadas apenas para montar URIs de conexão. As variáveis
> "reais" (`RABBITMQ_DEFAULT_PASS`, `POSTGRES_PASSWORD`, ...) são as que os containers
> consomem de fato. Mantenha cada par coerente.

---

## 4. O que é criado automaticamente

| Componente | O que o `setup/` cria |
|---|---|
| **RabbitMQ** | Usuário `root` (administrador) + filas quorum `client-infos`, `format-message` + policy `politica_quorum_padrao` (max-length 5000, TTL 30min). |
| **PostgreSQL** | Extensões `pg_trgm` e `vector`; tabelas `produtos`, `movimentacoes_estoque`, `memorypostgreschat` (memória LangChain) e `base_conhecimento` (RAG com `embedding vector(3072)`). |
| **n8n** | Workflows importados do repo GitHub (sanitizados e inativos, prontos para ativar) + pacote da comunidade `n8n-nodes-evolution-api`. Importação idempotente: reimportações limpam os workflows antigos antes de aplicar os novos. |

---

## 5. Estrutura de arquivos

```
setup/                              <- VERSIONADO (configuração/infra de init)
├── postgres/
│   └── init.sql                    # schema do banco (TCC)
├── n8n/
│   ├── clean-workflows.js          # limpeza idempotente dos workflows (n8n-import)
│   └── sanitize-workflow.js        # limpeza dos campos de instância de origem antes do import
└── rabbitmq/
    ├── rabbitmq.conf               # load_definitions + limites
    ├── definitions.json.template   # filas/policy/usuário (senha via .env)
    └── entrypoint.sh               # injeta RABBITMQ_DEFAULT_PASS e gera definitions.json

data/                               <- NÃO versionado (dados de runtime dos containers)
files/                              <- NÃO versionado (backups/exportações)
workflows/                          <- NÃO versionado (workflows são clonados do GitHub)
```

---

## 6. Fluxo de atualização

1. Fazemos alterações em `setup/` (config do Rabbit, schema do banco, etc.) e versionamos.
2. Num ambiente já existente, para aplicar:
   ```bash
   git pull
   docker compose --profile setup up -d --force-recreate rabbitmq db-evolution
   # Se houver novos workflows no repo GitHub, reimporte via container one-shot novo:
   docker compose stop n8n
   docker compose --profile setup rm -f n8n-import
   docker compose --profile setup run --rm n8n-import
   docker compose start n8n
   ```
3. O novo `init.sql` só roda no banco **se o volume `data/postgresql` for novo/vazio**.
   Para reaplicar o schema em um banco existente, remova o volume:
   ```bash
   docker compose down -v   # ATENÇÃO: apaga todos os dados dos containers
   docker compose --profile setup up -d
   ```
   > Após `down -v` (que apaga os volumes e os recria como root), repita o passo de
   > permissões antes de subir: `sudo chown -R 1000:1000 ./data/n8n ./workflows`.
