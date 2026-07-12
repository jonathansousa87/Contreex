# Roadmap

Task list for Contreex. `[x]` = done and validated with real calls, `[ ]` = open. Priority order within "Em aberto" reflects the current plan — revisit it as things change, don't treat it as fixed.

## Target architecture (north star, not yet fully built)

```
Contreex CLI
   ↓
Language Engine     (PT-BR ⇄ EN, technical dictionary, prompt optimization)
   ↓
Context Engine      (decides what context goes in: files, memory, Knowledge Base, RTK compression)
   ↓
Pipeline Engine     (declarative steps, not hardcoded actions)
   ↓
Consensus Engine    (pluggable strategies: unanimity, majority, implementer-decides, weighted)
   ↓
Agent Manager       (worktree isolation, retry, cache, state)
   ↓
Plugins             (Claude, Codex, Antigravity, MimoCode, ...)
   ↓
MCP (as a capability the Workspace resolves, not something an Agent requests directly)
   ↓
Knowledge Base + Decision Memory
   ↓
Event Bus           (everything above emits events; nothing above depends on who's listening)
```

The models (Claude Code, Codex, Antigravity, MimoCode, future ones) are just implementations of one layer. The project's value is the layers around them: how context gets prepared, how agents get coordinated, how consensus is reached, how knowledge accumulates.

## Concluído

- [x] Fase 0 — probe real de capacidades contra as 4 CLIs (headless, JSON, exit code, timeout, controle de escrita)
- [x] Fase 1 — confiabilidade de JSON headless (absorvida pela Fase 0/2)
- [x] Fase 2 — AEP v1 (schema) + Normalizer + Validator, validado com chamada real (Claude `--json-schema` + Antigravity sem suporte nativo)
- [x] Fase 3 — Agent Manager + isolamento real em git worktree, 2 plugins provados antes de generalizar
- [x] Fase 4 — Orchestrator + pipeline DSL + execução paralela de reviewers, 4º plugin (MimoCode) adicionado sem tocar no core
- [x] Fase 5 — config em cascata Home/Corporate, seleção de perfil obrigatória (nunca default silencioso)
- [x] Fase 6 — cache de resposta, MCP Gateway (filtro por workspace, sem reimplementar protocolo), compressão de diff estilo RTK
- [x] Fase 7 — Memory Engine (decision memory: histórico de execuções + busca por similaridade + stats por agente)
- [x] Renomeado de "Conclave" para "Contreex" em todo o código, docs e config runtime (`~/.contreex/`)
- [x] Repositório criado em `github.com/jonathansousa87/Contreex`, branch `main`, licença MIT
- [x] Documentação: `README.md`, `docs/ARCHITECTURE.md`, `docs/examples/*.yaml`

## Em aberto — ordem de prioridade

### 1. CLI shell mínimo ✅ concluído — 2026-07-12
Sem isso a ferramenta não é usável por ninguém, nem em inglês. Deliberadamente pequeno — só existe pra dar um lugar de entrada/saída pro Language Engine se conectar em seguida.
- [x] `bin/contreex.mjs` — parse de `contreex "<prompt>"`, chama o `runOrchestrator` já existente (inglês, sem Language Engine ainda), imprime resumo legível + documento AEP opcional (`--json`)
- [x] campo `"bin"` no `package.json`
- [x] instruções de instalação local no README — `npm link` falhou neste ambiente por permissão de prefixo global do npm (`/usr/lib/node_modules`, exige root); documentado symlink pra `~/.local/bin` como alternativa portável, sem sudo
- [x] validado com chamada real (`node bin/contreex.mjs "Add isPalindrome..." --dir <projeto de teste>`) — pipeline completo, `Document valid: true`, exit code 0
- [x] caminhos de erro testados: `--help` (exit 0), sem argumento (exit 1, mostra uso), sem `.contreex-profile` (exit 1, mensagem clara apontando pro template)

### 2. Language Engine ✅ concluído — 2026-07-12
O diferencial real do projeto — trabalhar em PT-BR, agentes operando em inglês otimizado, resposta volta preservando terminologia técnica.
- [x] Dicionário técnico (`src/language/dictionary.mjs`) — lista curada (`Worktree`, `Agent`, `MCP`, `JSON Schema`...) + detecção automática de tokens de código (camelCase, `file.ext`, `ALL_CAPS`, crases) via placeholder que sobrevive à tradução (verificado empiricamente)
- [x] `TranslationProvider` (`src/language/translation-provider.mjs`) — interface plugável, Google Translate (endpoint gratuito não-oficial, sem chave) como primeira implementação
- [x] `PromptBuilder` (`src/language/prompt-builder.mjs`) — monta prompt a partir de objetivo + contexto; deliberadamente simples até o Context Engine (item 3) existir
- [x] `PromptOptimizer` (`src/language/prompt-optimizer.mjs`) — interface plugável, OpenRouter como primeira implementação, **no-op gracioso se `OPENROUTER_API_KEY` não estiver configurada** (nunca falha o pipeline por falta de credencial opcional)
- [x] `LanguageEngine` (`src/language/engine.mjs`) — orquestra tradução de entrada + otimização + tradução reversa + restauração de terminologia
- [x] AEP ganha `request.language: { input, internal, output }` (schema atualizado, `additionalProperties: false`)
- [x] Config: seção `language` no `.contreex-profile` (ver `docs/examples/`)
- [x] `bin/contreex.mjs` integrado — objetivo e resumo final traduzidos automaticamente quando `language.input`/`output` ≠ `language.internal`
- [x] 7 testes unitários (`scripts/unit-test-language.mjs`) cobrindo proteção/restauração de termos, detecção de código, termos customizados
- [x] **Validado com chamada real e round-trip completo**: `contreex "Adicione uma função isPalindrome no arquivo utils.js..."` — traduziu pra inglês preservando `isPalindrome`/`utils.js`, rodou o pipeline inteiro, e devolveu o resumo em português (`Documento válido: verdadeiro`)

### 3. Context Engine
Hoje quem decide o que entra em cada prompt é o `orchestrator.mjs`, hardcoded (`doc.plan` + `doc.reviews`, sempre). Isso devia ser uma decisão explícita, não um acidente de implementação.
- [ ] Decide quais arquivos, quanto contexto, quais decisões antigas e qual memória entram em cada chamada
- [ ] Consome `src/compress.mjs` (RTK), `src/memory/query.mjs` (decision memory) e a futura Knowledge Base (item 7)
- [ ] Alimenta o `PromptBuilder` do Language Engine — Context Engine decide o quê, Prompt Builder monta o prompt com isso

### 4. Pipeline declarativo / Action Registry
- [ ] Extrair `ACTIONS` de `src/orchestrator.mjs` pra um registry externo (mesmo padrão de `src/agents/registry.mjs`)
- [ ] Orchestrator passa a só executar etapas nomeadas — não conhece mais `analyze`/`review`/`refine` diretamente
- [ ] Abre caminho pra novos step-types (`consensus`, `securityReview`, `documentationReview`) sem tocar no núcleo

### 5. Event Bus
Barato — `node:events` já resolve, sem dependência nova.
- [ ] `EventEmitter` central
- [ ] Eventos: `BeforeAgentRun`, `AfterAgentRun`, `ReviewAccepted`, `ReviewRejected`, `RetryStarted`, `QuotaExceeded`, `PipelineFinished`
- [ ] `doc.logs.push(...)` atual migra pra virar um listener do bus, não lógica embutida no orchestrator

### 6. Pipeline Profiles (presets nomeados)
Já desenhado como eixo ortogonal a Workspace desde a Fase 4 — só faltou criar os arquivos de verdade.
- [ ] `fast` / `standard` / `review` / `critical` / `enterprise` como pipelines YAML prontos em `docs/examples/` ou `~/.contreex/pipelines/`

### 7. Knowledge Base
Diferente de Decision Memory (Fase 7): aquilo é estatística de execução, isso é conhecimento curado e permanente.
- [ ] Módulo separado — ex.: "Codex costuma perder bug de concorrência em código async", "Claude ignora o parâmetro X sob condição Y"
- [ ] Definir mecanismo de promoção: entrada manual, ou detecção automática de padrão repetido na Decision Memory?

### 8. Consensus Engine
Hoje "refine" é uma chamada única do implementer decidindo tudo via prompt — funciona, mas não é uma estratégia, é um comportamento fixo.
- [ ] Desacoplar do step `refine` atual
- [ ] Estratégias plugáveis: unanimidade, maioria, implementer decide, weighted, corporate policy
- [ ] Provavelmente vira um step-type novo dentro do pipeline declarativo (item 4), não um módulo isolado

### 9. MCP como Capability
Evolução do `src/mcp-gateway.mjs` existente, não reescrita — ele já filtra por workspace, falta formalizar a indireção.
- [ ] Agente pede uma capability ("Git", "Filesystem"), o Workspace resolve qual provider atende — o agente nunca conhece o servidor MCP diretamente

### 10. Capability Discovery (contrato expandido)
- [ ] Expandir `capabilities()` de cada plugin com booleans: `supportsJson`, `supportsMcp`, `supportsImages`, `supportsToolCalling`, `supportsStreaming`, `supportsPatch`, `supportsReadOnly`, `supportsSandbox`
- [ ] Sem lógica de auto-decisão no pipeline ainda baseada nisso — só o contrato, até existir um cenário real que precise

### 11. Concorrência global (não Scheduler completo)
- [ ] Limite de processos de agente simultâneos dentro do `AgentManager` — problema real, resolução barata
- [ ] Fila/prioridade/execução distribuída ficam fora de escopo até existir mais de um pipeline rodando ao mesmo tempo de verdade

### 12. Observabilidade em terminal
Os dados já existem (`agentStats()`, `doc.logs`, `doc.metrics`) — falta é apresentação.
- [ ] Visão tipo tabela/timeline renderizada no `console`, consistente com a restrição "roda sempre no terminal"
- [ ] Web UI/Dashboard fica **fora de escopo até decisão explícita** — tensiona com essa restrição original, não é assumir por conta própria

## Adiado indefinidamente (over-engineering para o estágio atual)

- [ ] Scheduler completo (fila, prioridade, execução distribuída) — não existe ainda um cenário de múltiplos pipelines concorrentes que justifique
- [ ] Agent Registry instalável via npm, estilo extensões do VSCode (`manifest.json` + `activate()`/`deactivate()`) — falta um autor externo real pra validar esse contrato antes de formalizá-lo
- [ ] Web UI / Dashboard — ver item 12
