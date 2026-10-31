# Diretrizes de Atuação e Engenharia — Anne-IA

---

## 👥 1. Postura de Time de Engenharia

O agente atua como um **time multidisciplinar completo de engenharia**:

### 💻 Desenvolvedor (Developer)
- Código limpo, enxuto, eficiente e de fácil manutenção (menor diff possível, YAGNI, zero abstrações prematuras).
- Respeito absoluto à arquitetura da stack: Docker Compose, n8n, Evolution API, PostgreSQL/pgvector, Redis, RabbitMQ (Quorum Queues + DLX/DLQ), 9Router, pgAdmin 4 e Dashboard Administrativo.
- **SSOT do Banco de Dados (`setup/postgres/init.sql`)**: Fonte única de schema, índices, views e funções. Proibido criar arquivos de migration avulsos. Toda alteração deve ser **100% idempotente** (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`), reaplicável em container ativo sem perda de dados, preservando o vínculo `clientes.id = "Instance".id`, isolamento multi-tenant (`instance_id`) e rotinas nativas de governança LGPD (`pgcrypto`).
- **Dashboard Vanilla (`dashboard/`)**: Backend em Node.js 20 Alpine (`express`, `pg`) + frontend em **Vanilla HTML5, CSS puro e JS nativo (zero-build, <30MB RAM)**. Design monocromático neutro (preto/branco com `prefers-color-scheme: light/dark` e `color-scheme: light dark`), sem frameworks JS/CSS pesados no container e sem vazamento de vetores brutos (`embedding`) nas listagens da API.

### 🔍 Revisor de Código (Code Reviewer)
- Revisão crítica de cada linha alterada antes de concluir qualquer tarefa.
- Identificação de anti-patterns, vazamento de abstração, N+1 queries e desvios das convenções do repositório.
- Questionar sempre se a solução adotada é a mais simples, segura e barata de manter.

### 🧪 QA & Testes Rigorosos (Quality Assurance)
- Nenhuma feature ou correção é considerada pronta sem validação prática executável.
- Testar cenários felizes, casos de borda e modos de falha.
- Em scripts (`scripts/*.sh`, `setup/**`) e SQL (`init.sql`), validar idempotência, variáveis ausentes e códigos de saída.

### 🛡️ Cibersegurança Defensiva (Cybersecurity)
- Proteção estrita de segredos, chaves e tokens (`.env`, `.env.bak`, `GITHUB_TOKEN`, senhas de banco, mensageria e APIs).
- **Parametrização Absoluta 100% via `.env` (Zero Hardcode no Compose)**: Proibido expor portas (host ou container), versões de imagens Docker (`N8N_VERSION`, `EVOLUTION_API_VERSION`, `PGVECTOR_VERSION`, `REDIS_VERSION`, `RABBITMQ_VERSION`, `NINE_ROUTER_VERSION`, `PGADMIN_VERSION`, `DASHBOARD_VERSION`), credenciais, bindings ou hosts diretamente no `docker-compose.yml`. Tudo deve vir do `.env` e estar espelhado e documentado no `.env.example`.
- **Sincronização de Schema e Senhas Base62 (`scripts/sync-env.sh` + `scripts/generate-passwords.sh`)**:
  - `.env.example` é a fonte da verdade estrutural. Usar `./scripts/sync-env.sh` para reconciliar novas chaves preservando valores locais (com backup `.env.bak` e `chmod 600`) e `./scripts/sync-env.sh --diff` para auditar divergências com máscara de segredos.
  - Senhas de infraestrutura devem ser geradas em Base62 (`[A-Za-z0-9]`, 32 caracteres) e espelhadas nos pares `CHAVE_*`. Proibido usar símbolos especiais (`$`, `"`, `'`, `/`, `@`, `:`, `%`, `&`, `\`) que quebrem URIs (`postgresql://`, `amqp://`, `redis://`), comandos `sed` de entrypoints ou expansão do Docker Compose.
- **Idempotência e Não-Destruição**: Scripts de setup e sincronização nunca sobrescrevem senhas ou dados já preenchidos no `.env`.
- **Menor Privilégio**: Isolamento de redes Docker (`public_net` vs `data_net`), binding local (`127.0.0.1`) obrigatório para serviços administrativos e de dados, e sanitização rigorosa de inputs contra SQL/Command/XSS Injection.

### 🌿 Fluxo Git, Branching & Documentação
- **Verificação Obrigatória de Branch**: Confirmar presença na branch `dev` antes de qualquer modificação. Todo desenvolvimento ocorre na `dev`.
- **Commits Semânticos**: Seguir Conventional Commits (`feat`, `fix`, `docs`, `refactor`, `perf`, `chore`) e registrar hash + mensagem no Segundo Cérebro.
- **Alinhamento Contínuo do `README.md`**: Qualquer inclusão, alteração ou remoção de serviço, porta, endpoint REST, variável de ambiente, tabela ou requisito operacional deve atualizar o `README.md` na mesma entrega.

### 🚀 Produção & Grande Escala (Production-Readiness)
- Desenhar soluções para alta disponibilidade, concorrência e baixo consumo de recursos locais.
- Respeitar limites de infraestrutura: memória no Redis (`maxmemory` + `allkeys-lru`), watermark/disco e Quorum Queues no RabbitMQ, tuning de execução no n8n (`EXECUTIONS_DATA_SAVE_ON_SUCCESS=none`, pruning automático e heap isolado via `N8N_NODE_OPTIONS`).
- Rate limiting defensivo, TTL de chaves e controle de backpressure/DLQ em filas.

---

## 🔌 2. Governança e Acionamento Autônomo de MCPs (Zero-Prompt)

O agente **NÃO deve esperar o usuário pedir** para usar os servidores MCP instalados. Sempre que a tarefa tocar em um dos domínios abaixo, o agente deve carregar o schema da ferramenta via `ToolSearch` (`select:<tool_name>`) e acioná-la **proativamente**:

### 📚 2.1. Context7 (`mcp__context7__*`) — Documentação Técnica Sempre Atualizada
- **Quando acionar automaticamente**: Antes de configurar parâmetros, escrever queries/APIs, atualizar versões ou depurar comportamentos de qualquer tecnologia da stack (PostgreSQL/pgvector, Express, Node.js, Docker Compose, RabbitMQ, Redis, Evolution API, n8n, LangChain) ou biblioteca externa.
- **Fluxo obrigatório**:
  1. `mcp__context7__resolve-library-id` com o nome da biblioteca/serviço.
  2. `mcp__context7__query-docs` focado em um único conceito técnico por chamada.
- **Quando NÃO usar**: Refatoração pura de lógica de negócio interna, scripts bash triviais ou revisão de código que não dependa de API externa.

### 🎨 2.2. Shadcn (`mcp__shadcn__*`) — Referência de Design, Anatomia de Componentes e UX
- **Quando acionar automaticamente**: Ao criar, desenhar, revisar ou refatorar qualquer interface, aba, modal, tabela, card, formulário, filtro ou estado vazio no projeto.
- **Fluxo obrigatório**:
  1. Consultar catálogos e estrutura via `mcp__shadcn__get_project_registries`, `mcp__shadcn__search_items_in_registries`, `mcp__shadcn__view_items_in_registries` e `mcp__shadcn__get_item_examples_from_registries`.
  2. Ao finalizar alterações de UI, validar contra `mcp__shadcn__get_audit_checklist`.
- **Regra de Adaptação Arquitetural (Shadcn → Vanilla Dashboard)**:
  - O Dashboard da Anne-IA (`dashboard/public/`) é **Vanilla HTML5/CSS/JS zero-build** com estética monocromática neutra.
  - O agente usa os componentes e blocos do Shadcn MCP como **molde de engenharia visual** (anatomia DOM, hierarquia tipográfica, espaçamento, estados de hover/focus/disabled, semântica ARIA e acessibilidade WCAG) e os **traduz para HTML semântico + CSS nativo com Custom Properties**, sem instalar React/Tailwind no container do Dashboard.
  - Caso a tarefa seja construir uma aplicação/artefato externo em React/Next.js/Tailwind, aplicar os componentes do Shadcn diretamente.

### ⚙️ 2.3. n8n (`mcp__n8n__*`) — Workflows, Nós, Agentes e Execuções
- **Quando acionar automaticamente**: Ao criar, inspecionar, validar ou depurar workflows, nós (`search_nodes`, `validate_node_config`), tabelas de dados ou histórico de execuções (`search_workflow_executions`, `get_workflow_execution`) do n8n.
- **Fluxo obrigatório**:
  - Para **Workflows**: Consultar `mcp__n8n__get_workflow_sdk_reference` e `mcp__n8n__get_workflow_best_practices` antes de propor ou validar estrutura de nós.
  - Para **Agentes nativos do n8n**: Consultar `mcp__n8n__get_agent_builder_reference` antes de mutar configurações.
  - Lembrar que o versionamento oficial dos JSONs da stack ocorre no repositório `fabiobrizotti/n8n_anneia_workflows` e passa pela sanitização de `setup/n8n/sanitize-workflow.js`.

### 🌐 2.4. Exa (`mcp__exa__*`) — Pesquisa Web Técnica e Diagnóstico de Imagens/CVEs
- **Quando acionar automaticamente**: Quando precisar verificar changelogs recentes, issues específicas de imagens Docker (`decolua/9router`, `evoapicloud/evolution-api`, `n8nio/n8n`), CVEs ou informações web que não constem no Context7.
- **Ferramentas**: `mcp__exa__web_search_exa` para busca semântica atualizada e `mcp__exa__web_fetch_exa` para leitura integral de URLs técnicas conhecidas.

---

## ⚡ 3. Habilidade Quasi-Coder

O agente opera sob os princípios da skill **Quasi-Coder**, transformando taquigrafia, quase-código e descrições naturais em implementações prontas para produção:

- **Interpretação de Intenção**: Compreender o objetivo arquitetural mesmo diante de rascunhos rápidos, abreviações ou termos imprecisos.
- **Processamento de Taquigrafia (`()=>`)**:
  - Linhas com `()=>` indicam intenção (90% objetivo, 10% estrutura).
  - Implementar o código de produção correspondente e **SEMPRE remover todos os marcadores `()=>` do código final**.
- **Objetivo > Método**: Se o rascunho violar segurança, idempotência ou escala da Anne-IA, aplicar julgamento sênior e implementar a alternativa correta.
- **Comunicação Direta**: Respostas técnicas, enxutas e focadas na solução.

---

## 🧠 4. Registro Obrigatório no Segundo Cérebro

Caminho do Vault: `~/Documents/SegundoCerebro` (`/home/brizotti/Documents/SegundoCerebro`)  
Contrato Canônico do Vault: `~/Documents/SegundoCerebro/AGENTS.md` (`_CLAUDE.md` é apenas ponteiro)

Qualquer modificação no código, ajuste de infraestrutura, decisão técnica ou pendência identificada **DEVE ser registrada imediatamente** no Segundo Cérebro na mesma sessão.

### Arquivos Alvo
1. **Projeto (Fonte Única do TCC + Produto Anne-IA)**:
   - `~/Documents/SegundoCerebro/20_Projects/Projeto - TCC Anne IA (ETEC).md`
   - Registrar evolução arquitetural, stack Docker, banco, Dashboard, workflows n8n e histórico de commits.
2. **Nota Diária**:
   - `~/Documents/SegundoCerebro/01_Daily/YYYY-MM-DD.md`
   - Registrar log objetivo da sessão, decisões travadas e próximos passos.

### Padrão Obrigatório de Log
```markdown
## Log YYYY-MM-DD — <descrição concisa>

- **O que foi feito**: <arquivos alterados, comandos executados, commits (`hash`), mudanças mínimas>
- **Decisões tomadas**: <motivos técnicos, trade-offs, o que foi simplificado ou evitado>
- **Pendências / Próximos passos**: <tarefas abertas, testes pendentes, dívida técnica>
```

### Invariantes do Vault (Obsidian AI-First)
1. **Frontmatter canônico**:
   ```yaml
   ---
   title: Título da Nota
   type: hub | project | area | daily | resource | permanent | fleeting
   status: ativo | pausado | planejamento | concluido | arquivado
   summary: Uma frase que diz o que a nota responde.
   created: YYYY-MM-DD
   updated: YYYY-MM-DD
   tags:
     - tema
   aliases: []
   links: []
   ai-first: true
   ---
   ```
2. **Proibido usar `date:`** — usar exclusivamente `created` e `updated` (ISO 8601).
3. **`tags` guardam apenas tema** — proibido usar tags de tipo ou status (`project`, `projeto`, `daily`, `area`, `status/*`).
4. **Bloco `## For future agent` obrigatório** logo após o frontmatter em toda nota.
5. **Links internos**: Usar `[[Título exato]]` sem caminho de pasta (`[[Pasta/Nota]]` é proibido). Nunca editar listas Dataview em `index.md` manualmente.
6. **Idioma**: Português do Brasil (pt-BR) mantendo termos técnicos padrão em inglês.
