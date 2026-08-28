# Anne-IA — Stack Docker (n8n + Evolution API + Postgres + Redis + RabbitMQ)

Este documento descreve como subir esta stack do zero em uma nova instância/servidor.

## Sumário

- [Pré-requisitos](#pré-requisitos)
- [1. Clonar o repositório](#1-clonar-o-repositório)
- [2. Configurar o `.env`](#2-configurar-o-env)
- [3. Ajustar permissões de pastas](#3-ajustar-permissões-de-pastas)
- [4. Subir os containers](#4-subir-os-containers)
- [5. Importar os workflows](#5-importar-os-workflows)
- [6. Configurar credenciais dentro do n8n](#6-configurar-credenciais-dentro-do-n8n)
- [7. Ativar os workflows](#7-ativar-os-workflows)
- [Backup automático de workflows](#backup-automático-de-workflows)
- [Exportação manual de workflows](#exportação-manual-de-workflows)
- [Troubleshooting](#troubleshooting)

---

## Pré-requisitos

- Docker Engine instalado
- Docker Compose v2 (`docker compose`, sem hífen)
- `git`
- Acesso de rede liberado nas portas usadas (ver `.env`): `N8N_PORT` (padrão 5678), `REDIS_PORT` (6379), `POSTGRES_PORT` (5432), `RABBITMQ_MANAGEMENT_PORT` (15672), porta da Evolution API (8081, já fixada em `127.0.0.1` no compose)
- Um **Personal Access Token do GitHub** com permissão de `repo` (leitura/escrita), usado para importar/exportar os workflows do repositório [`n8n_anneia_workflows`](https://github.com/fabiobrizotti/n8n_anneia_workflows)

## 1. Clonar o repositório

```bash
git clone <url-deste-repositorio>
cd <pasta-do-repositorio>
```

## 2. Configurar o `.env`

Copie o `.env.example` (ou o modelo abaixo) para `.env` e preencha os valores:

```bash
cp .env.example .env
```

### Variáveis obrigatórias

| Variável | Descrição |
|---|---|
| `CHAVE_POSTGRES_PASSWORD` | Senha do Postgres usada pela Evolution API para conectar no `db-evolution` |
| `POSTGRES_PASSWORD` | Senha do usuário do Postgres (deve bater com `CHAVE_POSTGRES_PASSWORD`) |
| `CHAVE_RABBITMQ_DEFAULT_PASS` / `RABBITMQ_DEFAULT_PASS` | Senha do usuário `root` do RabbitMQ (devem ser iguais) |
| `CHAVE_REDIS_PASSWORD` / `REDIS_PASSWORD` | Senha do Redis (devem ser iguais) |
| `N8N_ENCRYPTION_KEY` | Chave usada pelo n8n para criptografar credenciais salvas no banco. **Gere uma vez e nunca mude** — trocar essa chave invalida todas as credenciais já salvas |
| `GITHUB_TOKEN` | Token do GitHub (permissão `repo`) para importar/exportar workflows do repositório de backup |
| `AUTHENTICATION_API_KEY` | Chave de autenticação da Evolution API |
| `N8N_INSTANCE_OWNER_EMAIL` | E-mail do usuário administrador criado automaticamente no primeiro boot do n8n |
| `N8N_INSTANCE_OWNER_PASSWORD_HASH` | Hash bcrypt da senha do administrador (já vem pré-preenchido no exemplo; senha em texto puro: `anneai` — **troque em produção**) |

> ⚠️ **Atenção ao formato:** `N8N_INSTANCE_OWNER_PASSWORD_HASH` contém `$` no valor (hash bcrypt). Mantenha entre aspas simples no `.env`, senão o Docker Compose tenta interpretar como variável.

### Demais variáveis

O restante do `.env` já vem com valores padrão sensatos (timezone `America/Sao_Paulo`, portas, políticas de memória do Redis, eventos de webhook da Evolution API etc.). Normalmente não precisa alterar, exceto:

- `N8N_HOST` / `WEBHOOK_URL` / `SERVER_URL` — ajuste para o domínio/IP público real se a instância não for acessada via `localhost`.

## 3. Ajustar permissões de pastas

O Docker cria pastas de volume novas como `root` por padrão. Como o n8n roda **dentro do container como usuário `node` (UID 1000)**, ele não consegue escrever em pastas que pertencem a `root` no host. Faça isso **antes** de subir os containers pela primeira vez:

```bash
mkdir -p ./data/n8n ./data/workflows
sudo chown -R 1000:1000 ./data/n8n ./data/workflows
```

> Não rode `chown` recursivo na pasta `./data` inteira — ela também contém dados do Postgres e do RabbitMQ, que rodam com usuários diferentes dentro dos seus próprios containers. Aplique o `chown` só nas subpastas usadas pelo n8n.

## 4. Subir os containers

```bash
docker compose up -d
```

Isso sobe: `n8n`, `rabbitmq`, `evolution-api`, `db-evolution`, `redis`. O serviço `n8n-import` **não** sobe aqui — ele só roda sob demanda (perfil `setup`, ver próximo passo).

Confira se tudo subiu saudável:

```bash
docker ps
```

## 5. Importar os workflows

Este passo baixa os workflows do repositório GitHub de backup e importa na instância nova:

```bash
docker compose --profile setup run --rm --no-deps n8n-import
```

O que esse comando faz:
1. Clona o repositório `n8n_anneia_workflows` (usando `GITHUB_TOKEN`)
2. Sanitiza os arquivos `.json` (remove campos internos de versionamento que causam erro de foreign key em instância diferente da origem, e força `active: false`)
3. Importa cada workflow via `n8n import:workflow`

Ao final, confira na UI do n8n (`http://<host>:<N8N_PORT>`) se os workflows aparecem.

## 6. Configurar credenciais dentro do n8n

**Credenciais nunca são exportadas** por segurança — elas precisam ser recriadas manualmente na UI do n8n (`Credentials` → `Add credential`) após o import. Pelo menos estas são usadas pelos workflows atuais:

| Nome da credencial (como aparece nos workflows) | Tipo | Usada em |
|---|---|---|
| `GitHub account` | GitHub API | Backup-n8n (ler/gravar arquivos no repo) |
| `n8n account` | n8n API | Backup-n8n (`Get many workflows1`) |
| `Postgres account` | Postgres | TOOL_GARBAGE_COLLECTOR (e possivelmente outros workflows de dados) |

> ⚠️ Verifique se há mais credenciais usadas pelos demais workflows (`TOOL-ANNEIA-ESTOQUE`, `TOOL_ANNEIA_CHAMARATENDENTE`, `ANNE-AI-ORQUESTRAÇÃO`, `ANNE-AI-FATIAMENTO`, `ANNE-AI-PRELOADUSER`, `BASEDATA_ANNEIA`) — como chaves de LLM (OpenAI/Gemini/Anthropic) ou Evolution API — e adicione nesta tabela. Depois de recriar cada credencial, abra os nodes que usam `n8n-nodes-base.github`, `n8n-nodes-base.postgres` etc. (eles aparecem sem credencial vinculada após o import) e associe a credencial recriada.

## 7. Ativar os workflows

Os workflows são importados sempre **inativos**, de propósito (evita erro de FK e evita ativar triggers antes das credenciais estarem configuradas). Depois de configurar as credenciais:

1. Abra cada workflow na UI
2. Confirme que os nodes têm credencial associada
3. Ative pelo toggle "Active" no canto superior direito

Ative na ordem que fizer sentido para as dependências entre workflows (ex.: sub-workflows chamados por `Execute Workflow` antes dos workflows "pai").

---

## Backup automático de workflows

O workflow **"Backup-n8n"** roda a cada 2 horas (`Schedule Trigger1`) e:
1. Lista todos os workflows via API do n8n
2. Remove campos internos de versionamento (`shared`, `activeVersion`, `activeVersionId`) e força `active: false` no JSON salvo
3. Compara com o conteúdo já existente no GitHub — só commita se houver diferença
4. Cria ou atualiza o arquivo em `workflows/<id>.json` no repositório `n8n_anneia_workflows`

Não é necessário rodar nada manualmente para manter o backup atualizado — isso acontece sozinho enquanto o workflow "Backup-n8n" estiver ativo.

## Exportação manual de workflows

Caso precise gerar um export manual (fora do fluxo automático acima):

```bash
docker exec -it <nome-do-container-n8n> n8n export:workflow \
  --backup \
  --output=/home/node/.n8n-files/workflows \
  --separate
```

Os arquivos aparecem em `./data/workflows` no host (mapeado via volume). Se der erro de permissão, revise o passo [3. Ajustar permissões de pastas](#3-ajustar-permissões-de-pastas).

---

## Troubleshooting

**`EACCES: permission denied` ao exportar/importar workflows**
A pasta de destino não pertence ao usuário `node` (UID 1000) dentro do container. Rode:
```bash
docker compose down
sudo chown -R 1000:1000 ./data/n8n ./data/workflows
docker compose up -d
```

**`SQLITE_CONSTRAINT: FOREIGN KEY constraint failed` ao importar**
O JSON do workflow contém campos de versionamento (`shared`, `activeVersion`, `activeVersionId`) que só existem na instância de origem. O passo de sanitização do `n8n-import` (item 5) já trata isso automaticamente; se algum workflow novo continuar falhando, abra o `.json` dele e confirme se esses campos foram removidos.

**`apk: not found` / `jq: not found` ao tentar instalar pacotes no container do n8n**
A partir do n8n 2.x, a imagem oficial não inclui gerenciador de pacotes (hardening de segurança). Use `node -e '...'` para scripts inline em vez de instalar ferramentas externas — o Node.js já está disponível no PATH por padrão.

**Warning `The "X" variable is not set` ao rodar `docker compose run`**
O Docker Compose interpola `$variavel` no próprio arquivo `docker-compose.yml` antes de repassar ao container. Se o script dentro do `command:` usa variáveis de shell (não variáveis de ambiente do Compose), escape com `$$` no YAML — ex.: `"$$f"` em vez de `"$f"`.