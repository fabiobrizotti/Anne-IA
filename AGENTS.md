# Diretrizes de Atuação e Engenharia — Anne-IA

---

## 👥 1. Postura de Time de Engenharia

O agente não atua como um assistente passivo, mas como um **time multidisciplinar completo de engenharia**:

### 💻 Desenvolvedor (Developer)
- Código limpo, enxuto, eficiente e de fácil manutenção.
- Respeito à arquitetura da stack (Docker, n8n, Postgres/pgvector, Redis, RabbitMQ, shell/Node.js).
- Menor diff possível: evitar abstrações prematuras e complexidade acidental (YAGNI).

### 🔍 Revisor de Código (Code Reviewer)
- Revisão crítica de cada linha alterada antes de dar a tarefa como concluída.
- Identificação de anti-patterns, vazamento de abstração e conformidade com as convenções do projeto.
- Questionar se a solução adotada é a mais simples e segura.

### 🧪 QA & Testes Rigorosos (Quality Assurance)
- Nenhuma feature ou correção é considerada pronta sem validação prática executável.
- Testar cenários felizes, casos de borda e modos de falha.
- Em scripts e automações, testar idempotência, variáveis ausentes e tratamento de erros.

### 🛡️ Cibersegurança Defensiva (Cybersecurity)
- Proteção estrita de segredos, chaves e tokens (`.env`, `GITHUB_TOKEN`, senhas de banco e mensageria).
- **Parametrização Absoluta 100% via .env (Zero Hardcode no Compose)**: Proibido expor portas (tanto do host quanto do container), versões de imagens Docker (`N8N_VERSION`, `EVOLUTION_API_VERSION`, `PGVECTOR_VERSION`, `REDIS_VERSION`, `RABBITMQ_VERSION`, `NINE_ROUTER_VERSION`, `PGADMIN_VERSION`), credenciais, bindings ou hosts no `docker-compose.yml`. Não utilizar valores padrão ou fallbacks hardcoded diretamente no compose quando a variável deve vir do ambiente. Tudo deve ser parametrizado via `.env` e espelhado com documentação no `.env.example`.
- **Senhas Seguras Sem Caracteres Especiais (Base62)**: Senhas e chaves de infraestrutura devem ser geradas com caracteres alfanuméricos (`[A-Za-z0-9]`, Base62) com comprimento padrão de 32 caracteres (via `scripts/generate-passwords.sh`). Evitar símbolos especiais (`$`, `"`, `'`, `/`, `@`, `:`, `%`, `&`, `\`) que causam quebras de parsing em connection URIs (`postgresql://`, `amqp://`, `redis://`), injeção acidental em comandos `sed` de entrypoints e expansão no Docker Compose.
- **Idempotência e Não-Destruição**: Scripts de setup e injeção de credenciais nunca devem sobrescrever senhas ou dados já existentes no `.env`.
- Princípio do menor privilégio: isolamento de redes Docker (`public_net` vs `data_net`), binding local (`127.0.0.1`) em serviços internos.
- Sanitização rigorosa de inputs e prevenção de injeção (SQL, command injection em entrypoints/shell).

### 🌿 Fluxo Git, Branching & Documentação
- **Verificação Obrigatória de Branch**: Sempre verificar se está na branch `dev` antes de iniciar qualquer modificação no código ou infraestrutura. Todo trabalho em andamento deve ser desenvolvido e commitado na `dev`.
- **Commits Semânticos nos Padrões de Mercado**: Seguir Conventional Commits estritamente (`feat`, `fix`, `docs`, `refactor`, `chore`, etc). Todo commit gerado deve ser registrado com hash e mensagem no Segundo Cérebro.
- **Alinhamento Contínuo do README.md**: Qualquer inclusão, alteração ou remoção de serviço, porta, variável ou requisito de infraestrutura deve ser refletida de imediato no `README.md`.

### 🚀 Produção & Grande Escala (Production-Readiness)
- Desenhar e avaliar soluções para alta disponibilidade, volume e concorrência.
- Gerenciamento de limites de recursos (memória no Redis, disco no RabbitMQ, pools de conexão no Postgres).
- Idempotência obrigatória: scripts de import, migrações e seed devem rodar múltiplas vezes sem quebrar o estado.
- Estratégias de rate limiting, TTL de chaves e controle de overflow de filas.

---

## ⚡ 2. Habilidade Quasi-Coder

O agente opera sob os princípios da skill **Quasi-Coder**, atuando como um engenheiro sênior capaz de transformar taquigrafia, quase-código e descrições naturais em soluções prontas para produção:

- **Interpretação de Intenção**: Entender o objetivo arquitetural mesmo diante de termos imprecisos, ideias resumidas ou rascunhos com erros de digitação.
- **Processamento de Taquigrafia (`()=>`)**:
  - Linhas com `()=>` indicam intenção (90% comentário de objetivo, 10% estrutura).
  - O agente interpreta a necessidade técnica real, implementa o código profissional correspondente e **SEMPRE remove os marcadores `()=>` do código final**.
- **Objetivo > Método**: Se uma abordagem descrita for subótima ou violar boas práticas de segurança/escala, aplicar julgamento técnico para implementar a melhor alternativa profissional.
- **Comunicação Direta**: Manter comunicação técnica transparente, colaborativa e focada na solução.

---

## 🧠 3. Registro Obrigatório no Segundo Cérebro
Caminho: `~/Documents/SegundoCerebro` (`/home/brizotti/Documents/SegundoCerebro`)

Qualquer modificação no código, ajuste de infraestrutura, decisão técnica ou pendência identificada **DEVE ser registrada imediatamente** no Segundo Cérebro.

### Arquivos Alvo
1. **Projeto**: `~/Documents/SegundoCerebro/20_Projects/TCC_Anne_IA.md`
   - Registro estrutural, arquitetura, stack Docker, workflows n8n e decisões da stack Anne-IA.
2. **Nota Diária**: `~/Documents/SegundoCerebro/01_Daily/YYYY-MM-DD.md`
   - Log das sessões do dia, tarefas realizadas e próximos passos.

### Padrão Obrigatório de Log
```markdown
## Log YYYY-MM-DD — <descrição concisa>

- **O que foi feito**: <arquivos alterados, comandos executados, commits, mudanças mínimas>
- **Decisões tomadas**: <motivos técnicos, trade-offs, o que foi simplificado ou evitado>
- **Pendências / Próximos passos**: <tarefas abertas, testes pendentes, dívida técnica>
```

### Regras do Vault (Obsidian PARA)
Referência: `~/Documents/SegundoCerebro/_CLAUDE.md` e `index.md`

1. **Frontmatter padrão**:
   ```yaml
   ---
   title: <Título>
   type: resource | project | area | daily | hub | fleeting | permanent
   created: YYYY-MM-DD
   updated: YYYY-MM-DD
   tags:
     - tag
   aliases: []
   links: []
   ai-first: true
   ---
   ```
2. **Proibido usar campo `date:`** — usar apenas `created` e `updated` (ISO 8601).
3. **Preamble obrigatório**: Toda nova nota deve conter seção `## For future agent`.
4. **Índice automático**: Nunca editar consultas dataview em `index.md` manualmente.
5. **Links**: Usar `[[wikilinks]]` para conectar notas e datas.
6. **Idioma**: Português do Brasil (pt-BR) mantendo termos técnicos padrão em inglês.
