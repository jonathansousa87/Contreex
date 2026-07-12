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
Intent Analyzer     (classifies what was actually asked: analyze / plan / implement / review-code)
   ↓
Pipeline Engine     (declarative steps, selects the right profile based on intent)
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

### 3. Context Engine ✅ concluído — 2026-07-12
Antes disso, quem decidia o que entrava em cada prompt era o `orchestrator.mjs`, hardcoded (`doc.plan` + `doc.reviews` sempre, nenhuma listagem de arquivo real do projeto). Virou uma decisão explícita e centralizada.
- [x] `src/context-engine.mjs` — decide contexto por ação: `analyze` recebe listagem real de arquivos do projeto (`readdirSync`, antes disso os agentes eram cegos ao projeto real) + tarefas parecidas da Decision Memory; `review` recebe o plano; `refine` recebe plano + reviews
- [x] Consome `src/memory/query.mjs` (`findSimilarRuns`, migrado de dentro do `orchestrator.mjs` pra cá)
- [x] `src/compress.mjs` (RTK) ainda não tem consumidor real no pipeline — só faz sentido quando a ação `implement` existir de verdade e houver diff pra comprimir; Knowledge Base (item 7) ainda não existe, hook fica pra depois
- [x] Reusa o **mesmo** `PromptBuilder` do Language Engine (`src/language/prompt-builder.mjs`) — Context Engine decide o quê, Prompt Builder só formata, nada duplicado
- [x] `orchestrator.mjs` refatorado: cada `ACTION` agora só define `baseInstruction(doc)` (o que perguntar), não mais um `buildPrompt` completo — montagem final é `buildPrompt({ objective: action.baseInstruction(doc), context: contextEngine.gather(...) })`
- [x] Validado com chamada real: pipeline completo rodou (`Document valid: true`), e `ContextEngine.gather()` testado isoladamente confirma que lista os arquivos reais do diretório de teste e recupera tarefas parecidas de execuções anteriores desta sessão

### 4. Pipeline declarativo / Action Registry ✅ concluído — 2026-07-12
- [x] `ACTIONS` extraído de `src/orchestrator.mjs` pra `src/actions/registry.mjs`, mesmo padrão de `src/agents/registry.mjs` — um arquivo por ação (`analyze.mjs`, `review.mjs`, `refine.mjs`)
- [x] `orchestrator.mjs` não conhece mais `analyze`/`review`/`refine` diretamente — só chama `resolveAction(step.action)`; cada ação só declara `baseInstruction(doc)`, `jsonSchema`/`defName` opcionais, `validate` opcional e `merge`
- [x] Loader de schema compartilhado (`src/aep/schema.mjs`) extraído — antes `validate.mjs` e as ações leriam o mesmo arquivo JSON separadamente
- [x] Abre caminho pra novos step-types (`consensus`, `securityReview`, `documentationReview`) sem tocar no orchestrator — só adicionar um arquivo em `src/actions/`
- [x] Removida uma linha de código morto encontrada durante a extração (`analyze`'s `validate` chamava `parseAndValidateSection` e descartava o resultado sem usar)
- [x] Validado: `resolveAction('doesNotExist')` lança erro claro listando ações conhecidas; pipeline completo rodado com chamada real (`Document valid: true`, refinamento com 1 aceito/1 rejeitado)

### 5. Pipeline Profiles (presets nomeados) ✅ concluído — 2026-07-12
Já desenhado como eixo ortogonal a Workspace desde a Fase 4 — só faltou criar os arquivos de verdade e o mecanismo real de seleção.
- [x] `fast` / `standard` / `review` / `critical` / `enterprise` / `analysis-only` como YAML reais em `~/.contreex/pipelines/*.yaml`, espelhados em `docs/examples/pipelines/` — `critical` é o loop de dupla revisão da concepção original do projeto; `enterprise` é `critical` com um terceiro revisor
- [x] Preset **analysis-only** (`analyze` + `review`, sem `refine`) — resolve diretamente o problema descrito no item 6: um pedido só de análise não pode terminar parecendo uma decisão de implementação
- [x] `src/config/pipeline-profiles.mjs` (`loadPipelineProfile`) + integração em `src/config/load.mjs`: `pipelineProfile: <nome>` em qualquer camada da cascata sobrescreve o `pipeline:` resolvido — sem isso, comportamento inalterado
- [x] Validado: os 6 presets carregam com a contagem de steps esperada, perfil desconhecido lança `UnknownPipelineProfileError` claro, e uma chamada real com `pipelineProfile: fast` rodou só `analyze` (sem `Reviews:`/`Refinement:` na saída, exatamente como o preset define)

### 6. Intent Analyzer ✅ concluído — 2026-07-12
**Adicionado a partir de um caso real**: um pedido de "analise essas duas aplicações" não deveria poder resultar em implementação — antes disso o pipeline era fixo, independente do que foi pedido. Questão de comportamento correto, não estética.
- [x] `src/intent-analyzer.mjs` — classifica a intenção do pedido: `analyze` / `plan` / `implement` / `review-code`
- [x] Fallback barato por palavra-chave PT-BR/EN (`classifyByKeyword`, sem custo, sem IA) — checado sobre o texto bruto do objetivo, antes da tradução, ordem por especificidade (`implement` antes de `plan` antes de `review-code` antes de `analyze`)
- [x] Classificador opcional via LLM pra casos ambíguos, reaproveitando o **mesmo** `openRouterOptimizer` do `PromptOptimizer` (item 2) — mesma degradação graciosa: sem chave de API ou classificação ambígua, cai pro default `plan` (nem análise silenciosa demais, nem implementação não pedida)
- [x] Seleciona automaticamente o preset certo dentre os criados no item 5 (`analyze`/`review-code` → `analysis-only`, `plan` → `review`, `implement` → `critical`) — mas **config explícito (`pipelineProfile:`) sempre vence** a classificação automática
- [x] `analysis` no schema AEP ganhou `clarifyingQuestions` (array opcional); prompt do `analyze` instrui a preencher só quando faltar informação real, nunca por preencher
- [x] 9 testes unitários (`scripts/unit-test-intent-analyzer.mjs`), incluindo o cenário real de migração C#→Java desta própria conversa, confirmando classificação `analyze` (não `implement`, mesmo com verbos como "desacoplar"/"migrar" no meio do texto)
- [x] **Validado com chamada real, cenário exato da discussão**: `contreex "Analise essas duas aplicações..."` em PT-BR → detectou `intent: analyze (keyword) -> analysis-only` → rodou sem nenhum step de `refine` (nenhuma seção "Refinamento" na saída) → o Context Engine mostrou ao implementer que só existe um `README.md` de placeholder no projeto de teste, e o modelo gerou perguntas de esclarecimento genuinamente relevantes em vez de inventar um plano com dados insuficientes

### 7. Saída/relatório consolidado em terminal ✅ concluído — 2026-07-12
Os dados já existem (`agentStats()`, `doc.logs`, `doc.metrics`, `analysis.confidence`) — faltava é apresentação. **Princípio de design**: a saída final deve ler como um relatório técnico consolidado de uma equipe de arquitetos, não como uma conversa com IA — o usuário não precisa ver o debate entre os revisores no uso normal.
- [x] `src/report.mjs` (`formatReport`) — visão formatada em seções (ANÁLISE/PLANO/CONSENSO/DIVERGÊNCIAS) no `console`, consistente com "roda sempre no terminal" — nenhum número exibido é decorativo, tudo vem de campo real do `doc`
- [x] Flags `--verbose` / `--show-reviews` (sinônimos) — expõem findings completos dos revisores e o motivo de cada rejeição; sem a flag, só o consolidado (6 testes cobrindo os dois modos em `scripts/unit-test-report.mjs`)
- [x] Divergências entre revisores destacadas na seção "DIVERGÊNCIAS RESOLVIDAS PELO IMPLEMENTER", construída a partir de `doc.refinement.acceptedChanges`/`rejectedChanges`
- [x] Validado com chamada real — relatório formatado apareceu corretamente em duas chamadas reais (`review` e `fast` presets), incluindo a seção de riscos citando histórico de execuções anteriores via memória
- [ ] Web UI/Dashboard fica **fora de escopo até decisão explícita** — tensiona com a restrição original "roda sempre no terminal", não é assumir por conta própria
- [x] **Uso real de tokens capturado** (2026-07-12) — `claude-agent.mjs`/`codex-agent.mjs` agora extraem `meta.tokens` (input/output/cache) do JSON/JSONL bruto de cada chamada. `scripts/token-economy-report.mjs` mede o que realmente economiza tokens hoje: **só o cache** (comprovado — US$0,058 na 1ª chamada, US$0 na repetição). RTK e Prompt Optimizer estão construídos mas **sem efeito real hoje** — RTK sem consumidor no pipeline, Optimizer em no-op total sem `OPENROUTER_API_KEY`. Achado: overhead de base de cada CLI (ex.: Codex reportou 37k tokens de input contra 6 do Claude no mesmo prompt) pesa mais que qualquer contexto que a gente manda — algo fora do controle do Contreex. Detalhe completo em `docs/ARCHITECTURE.md#token-economy--real-findings-not-aspirational-claims`
- [x] **RTK e pxpipe investigados de verdade (2026-07-12)** — corrigindo o erro de nunca ter verificado os dois projetos que o usuário passou na primeira mensagem desta sessão. RTK real clonado, binário instalado e testado contra este repo: o técnica de compactação de diff é segura e legítima **abaixo** de ~100 linhas por hunk, mas o modo padrão do próprio RTK **descarta silenciosamente** linhas `+`/`-` acima disso (confirmado: um diff real de 100 linhas perdeu todas as linhas `+`, mostrando só "... (100 lines truncated)"). `src/compress.mjs`'s `condenseDiff()` reimplementa a parte seguros da técnica em JS puro, **sem depender do binário `rtk`** (preferência explícita do usuário) e **nunca trunca** uma linha real, mesmo com diffs grandes — troca taxa de compactação por garantia de correção. pxpipe também investigado a fundo (`FINDINGS.md` deles): é uma técnica real e mensurada, mas o próprio documento admite que erros de leitura por VLM são silenciosos e dependem muito do modelo — incompatível com o requisito do AEP de JSON sobreviver exato através de 4 CLIs heterogêneos. Não adotado. Detalhe completo em `docs/ARCHITECTURE.md`
- [ ] `compress.mjs` (agora corrigido e seguro) ainda **sem consumidor real no pipeline** — só faz sentido quando a ação `implement` (item 14) existir e houver diff de verdade pra comprimir; hoje continua sendo código morto do ponto de vista de economia, só que honesto sobre isso
- [ ] Testar o Prompt Optimizer com uma `OPENROUTER_API_KEY` real — hoje não sabemos se ele de fato reduz tokens ou se só "melhora clareza" às custas de mais texto

### 8. Event Bus ✅ concluído — 2026-07-12
Barato — `node:events` já resolve, sem dependência nova.
- [x] `src/event-bus.mjs` — `EventEmitter` compartilhável, um por `AgentManager` (`manager.eventBus`), não obrigatoriamente global — evita cross-talk entre execuções concorrentes futuras (item 13)
- [x] Eventos implementados: `BeforeAgentRun`, `AfterAgentRun` (inclui hit de cache), `RetryStarted`, `QuotaExceeded` (emitidos pelo `AgentManager`), `ReviewAccepted`, `ReviewRejected`, `PipelineFinished` (emitidos pelo `orchestrator.mjs`)
- [x] `doc.logs.push(...)` não existe mais como lógica embutida — `orchestrator.mjs` registra um listener de `AfterAgentRun` que constrói `doc.logs`, removido no fim do run (`eventBus.off`)
- [x] Validado com 4 testes usando plugins falsos (`scripts/unit-test-event-bus.mjs`) — sem custo de API — mais uma chamada real completa confirmando que nada quebrou (relatório e `Documento válido: true` inalterados)

### 9. Knowledge Base ✅ concluído — 2026-07-12
Diferente de Decision Memory (Fase 7): aquilo é estatística de execução, isso é conhecimento curado e permanente.
- [x] `src/knowledge-base.mjs` — módulo separado, `addEntry`/`listEntries`/`queryKnowledgeBase` (mesma técnica de sobreposição de tokens do `memory/query.mjs`, consistente, não uma nova abordagem), armazenado em `~/.contreex/knowledge-base.jsonl`
- [x] Mecanismo de promoção **v1 deliberadamente simples**: entrada manual via `addEntry()` é o caminho principal; `suggestPromotions()` só sugere candidatos (recorrência de findings por agente na Decision Memory) pra um humano confirmar — promoção totalmente automática/clustering fica pra depois, é escopo real, não implementado aqui
- [x] Conectado ao Context Engine — `analyze` e `review` agora recebem lições relevantes da Knowledge Base junto com tarefas parecidas da Decision Memory
- [x] 6 testes (`scripts/unit-test-knowledge-base.mjs`), incluindo injeção de dependência (`knowledgeLookup` customizável) e confirmação de que entradas de teste não vazam pra correspondências irrelevantes

### 10. Consensus Engine ✅ concluído — 2026-07-12
`refine` continua existindo e fazendo sua própria síntese via LLM — o Consensus Engine é um gate determinístico **adicional**, opcional, que roda antes disso sem custo de LLM.
- [x] `src/consensus.mjs` — desacoplado do `refine`, computação pura sobre `doc.reviews`
- [x] Estratégias plugáveis: `unanimity`, `majority`, `implementerDecides` (não computa nada, delega mesmo pro refine), `weighted` (usa `agentStats()` da Decision Memory pra pesar cada revisor pela taxa histórica de aprovação), `corporatePolicy` (indireção configurável pra outra estratégia, default `unanimity`)
- [x] Virou um novo step-type declarativo (`src/actions/consensus.mjs`, registrado em `actions/registry.mjs`) com `local: true` — `orchestrator.mjs` pula o `AgentManager`/worktree/LLM inteiramente pra esse tipo de step, mas ainda emite pelo mesmo Event Bus (`agent: 'contreex'` nos logs, pra diferenciar de chamada real)
- [x] AEP ganhou seção `consensus: {strategy, verdict, rationale}` no schema
- [x] 10 testes unitários (`scripts/unit-test-consensus.mjs`, todos sem custo de API — é computação pura) + demo real (`scripts/demo-consensus.mjs`) confirmando o step local funcionando dentro de um pipeline de verdade (`analyze → review → consensus → refine`), com o log corretamente distinguindo `consensus (contreex)` de chamadas de agente reais

### 11. MCP como Capability ✅ concluído — 2026-07-12
Evolução do `src/mcp-gateway.mjs` existente, não reescrita — ele já filtrava por workspace, faltava formalizar a indireção.
- [x] `resolveCapabilities()`/`writeMcpConfigForCapabilities()` — quem pede acesso pede uma capability ("git", "issueTracker"), nunca um nome de servidor; o workspace ativo resolve qual servidor real atende, via um mapa `capabilities: {...}` novo no YAML do workspace
- [x] Capability sem mapeamento no workspace atual = `unavailableCapabilities`, não erro — um projeto pedindo "issueTracker" no workspace `home` (que não define isso) degrada graciosamente, igual todo o resto do sistema
- [x] Exemplo real em `docs/examples/workspace-corporate.yaml` (e sincronizado em `~/.contreex/workspaces/corporate.yaml`): `git → corporate`, `issueTracker → jira`, `docs → confluence`
- [x] 6 testes, incluindo confirmação de que uma capability resolve até um servidor de verdade já definido (`corporate.json`, da Fase 6) sem tocar filesystem pra capability não mapeada

### 12. Capability Discovery (contrato expandido) ✅ concluído — 2026-07-12
- [x] `capabilities()` de cada plugin expandido com `supportsJson`/`supportsMcp`/`supportsImages`/`supportsToolCalling`/`supportsStreaming`/`supportsPatch`/`supportsReadOnly`/`supportsSandbox` — **todo campo verificado contra `--help` real ou teste empírico da Fase 0, nunca suposto**; o que não foi verificado fica `null`, não `false` (ex.: `supportsImages` no Claude e no Antigravity)
- [x] Achados novos ao verificar: Codex tem `apply` (aplica diff via `git apply`) e `-i/--image`, confirmando `supportsPatch`/`supportsImages`; Antigravity **não tem** `mcp` no `--help` (`supportsMcp: false`, ausência checada, não assumida); MimoCode tem subcomando `mcp` de verdade
- [x] Ainda sem lógica de auto-decisão no pipeline baseada nisso — só o contrato, como planejado, até existir um cenário real que precise
- [x] 8 testes (`scripts/unit-test-capabilities.mjs`) confirmando forma consistente entre os 4 plugins e os achados centrais da Fase 0 (`supportsReadOnly` verdadeiro só em Claude/Codex, falso em Antigravity/MimoCode)

### 13. Concorrência global (não Scheduler completo) ✅ concluído — 2026-07-12
- [x] `src/concurrency.mjs` — semáforo simples (`Semaphore`), limite padrão de 4 processos simultâneos (ajustável via `CONTREEX_MAX_CONCURRENT_AGENTS`), instância compartilhada por padrão (`defaultSemaphore`) já que o risco real é de processos demais no sistema, não por `AgentManager`
- [x] `AgentManager.run()` usa o semáforo só pra proteger o spawn de processo de verdade (`plugin.execute()`), não a criação de worktree nem o lookup de cache
- [x] Fila/prioridade/execução distribuída continuam fora de escopo — não existe ainda mais de um pipeline rodando ao mesmo tempo de verdade que justifique
- [x] 5 testes (`scripts/unit-test-concurrency.mjs`), incluindo um que exercita o `AgentManager.run()` real (só `plugin.execute()` é falso) com 5 tarefas e limite 2, confirmando que nunca mais de 2 rodam ao mesmo tempo

### 14. Ação `implement` real ✅ concluído — 2026-07-12
**Correção importante em 2026-07-12**: a Fase 6 do Intent Analyzer originalmente tentou usar "pular o `refine`" como proxy pra "não implementar sem pedir" — estava errado. `refine` nunca mexe em código, é só o implementer sintetizando o feedback dos revisores em texto/JSON; por isso agora **toda** intenção (analyze/plan/review-code/implement) roda `analyze → review → refine` completo, sempre, pra uma resposta rica. O que realmente precisava de proteção era a ação que escreve código de verdade — implementada agora, gated corretamente.
- [x] `src/actions/implement.mjs`: única ação que escreve arquivos de verdade. `cache: false` (efeito colateral real não pode vir de cache), `timeout: 120_000` (escrita + auto-verificação leva mais tempo que um turno só-JSON). Usa `aepSchema.$defs.implementation` (já existia desde o início do projeto, self-contained, sem `$ref`).
- [x] Registrada em `src/actions/registry.mjs`, contexto próprio em `src/context-engine.mjs` (plano + refinamento).
- [x] Dispara **somente** por comando explícito do usuário: flag `--implement` em `bin/contreex.mjs`, com precedência sobre `pipelineProfile` configurado e sobre o Intent Analyzer — nenhum caminho de linguagem natural chega nessa ação. Confirmado empiricamente: mesmo objetivo, sem `--implement`, o Intent Analyzer escolhe o profile `review` (nunca escreve); com `--implement`, roda o pipeline `implement` (`analyze → review×2 → refine → implement`).
- [x] Isolamento em worktree (já existia desde a Fase 3) é o mecanismo que torna essa ação segura — testado ao vivo com Claude como implementer: `isPalindrome` foi escrito **apenas** em `.worktrees/claude-implementer/utils.js`; o `utils.js` do projeto real ficou byte-a-byte intacto e `git status` no projeto real seguiu limpo (só a pasta `.worktrees/` como untracked). Merge pra `main` é passo humano/explícito, nunca automático.
- [x] `src/compress.mjs` (`summarizeDiff`) ganhou seu primeiro consumidor real: `bin/contreex.mjs` calcula o diff de verdade (`git diff --numstat`) na worktree do implementer e passa pro relatório — validado ao vivo: LLM reportou "+6/-1" em prosa, `git diff --numstat` confirmou exatamente os mesmos números.
- [x] `src/report.mjs` ganhou seção "IMPLEMENTAÇÃO": status, arquivos alterados, comandos rodados pelo implementer, diff real, caminho da worktree e instruções de merge manual (`git log -p` / `git merge`, nunca automático).
- [x] `scripts/unit-test-implement.mjs` (10 testes, todos com plugins fake — sem custo de API): registro/config da ação, instrução, merge, contexto, `runOrchestrator` só retorna `implementWorktree` após um `implement` bem-sucedido (não retorna se nenhum passo `implement` rodou, nem se a validação falhar), seções do relatório. Adicionado à cadeia `npm test` (agora 12 arquivos, todos passando).
- [ ] `capabilities().sandboxed`/`writeBlockConfirmed` (metadados já existentes desde a Fase 0) ainda não são lidos por esta ação — permanecem só informativos por enquanto; não bloqueou o teste real porque o isolamento em worktree já é a garantia efetiva.

### 15. Prompt do reviewer reforçado (defesa em profundidade) ✅ concluído — 2026-07-12
- [x] `src/actions/review.mjs`: instrução agora inclui explicitamente "you never create, edit, or modify any file" — antes a única garantia era estrutural (permission mode/sandbox + isolamento em worktree); pra agy/mimo, cujas flags de bloqueio **não** bloqueiam escrita de verdade (achado da Fase 0), essa era a única lacuna: zero instrução em texto. Agora é defesa em duas camadas.

### 16. Contexto entre rodadas de review/refine ✅ concluído — 2026-07-12
**Achado real durante a implementação**: o campo `refinement.updatedPlan` já existia no schema desde o início do projeto, mas nada preenchia nem propagava — uma 2ª rodada de review revisava sempre o plano original, cega ao que foi decidido na 1ª rodada.
- [x] `src/actions/refine.mjs`: `baseInstruction` agora pede `updatedPlan` quando o plano muda de verdade; `merge` propaga pra `doc.plan`.
- [x] `src/context-engine.mjs`: contexto de `review` agora inclui `doc.refinement` (o que foi aceito/rejeitado e por quê) sempre que existir — corrigido um bug real descoberto durante os testes: essa linha estava aninhada dentro de `if (doc.plan)`, então sumia silenciosamente sempre que não havia plano ainda (o que também colapsava rodadas diferentes num prompt idêntico e cacheável, mascarando o bug).
- [x] 8 testes novos cobrindo o cenário (`scripts/unit-test-consensus-loop.mjs`, ver item 17).

### 17. Loop de consenso dinâmico (review → refine até convergir) ✅ concluído — 2026-07-12
**Regra confirmada pelo usuário**: base é unanimidade, mas o implementer (Claude, "engenheiro-chefe") tem peso maior que qualquer revisor individual, porque divergências às vezes não fazem sentido — ele pode encerrar a rodada sem unanimidade total, desde que justifique.
- [x] `schema/aep.v1.schema.json`: `refinement` ganhou `chiefEngineerOverride`/`overrideRationale`; `consensus` ganhou `rounds`/`maxRounds`/`stopReason`.
- [x] `src/orchestrator.mjs`: novo tipo de passo `{ loop: { maxRounds, reviewers } }` — roda review (paralelo) → consensus (`unanimity`, reaproveitando `src/consensus.mjs` já existente do item 10) → refine, repetindo até: (a) unanimidade real (loop para, refine nem roda naquela rodada), (b) `chiefEngineerOverride: true` do implementer, ou (c) `maxRounds` atingido sem consenso — nesse caso a decisão final volta pro usuário, não fica só com o Claude.
- [x] `docs/examples/pipelines/critical.yaml` e `enterprise.yaml` reescritos pra usar o loop (`maxRounds: 3`) no lugar do antigo esquema fixo de 2 rodadas hardcoded (que tinha o bug do item 16).
- [x] `src/report.mjs`: seção CONSENSO agora mostra rodadas executadas, se convergiu e por quê.
- [x] 8 testes com plugins fake (`scripts/unit-test-consensus-loop.mjs`) cobrindo os 3 caminhos de parada + propagação de `updatedPlan`.
- [x] **Validado ao vivo** com CLIs reais (`pipelineProfile: critical`, Claude implementer + Codex/Antigravity reviewers): rodou 2 rodadas reais, convergiu por unanimidade na 2ª, e o refine rejeitou uma sugestão de revisor com justificativa factual verificada via `grep`/`ls` no próprio código — exatamente o comportamento de "engenheiro-chefe" pedido.

### 18. Anexo de imagem (screenshot → agente) ✅ concluído — 2026-07-12
Motivação do usuário: hoje ele tira print e cola (Ctrl+V) direto no CLI interativo do Claude Code. O Contreex é headless (uma chamada só, sem REPL), então não existe evento de "colar" pra interceptar — a solução lê o mesmo clipboard do Windows que o Ctrl+V usaria.
- [x] `src/clipboard.mjs`: `saveClipboardImage(destDir)` usa `powershell.exe` (interop WSL2) + `System.Windows.Forms.Clipboard`/`System.Drawing` pra salvar a imagem do clipboard como PNG, traduz o caminho via `wslpath -u`. Erro claro (`ClipboardError`) se não houver imagem ou o interop não estiver disponível.
- [x] `bin/contreex.mjs`: flags `--from-clipboard` e `--image <path>` (repetível), resolvidas pra `doc.request.attachments` (novo campo no schema, `request.attachments: string[]`).
- [x] Só a etapa `analyze` recebe as imagens — revisores não precisam reanexar a cada rodada.
- [x] Codex: `-i/--image <FILE>` nativo (achado da Fase 0, agora de fato usado — antes era só metadado sem consumidor). Claude: sem flag nativa, funciona via tool `Read` referenciando o caminho absoluto no texto do prompt (`src/context-engine.mjs`).
- [x] **Validado ao vivo, os dois agentes, com imagem real**: gerei uma imagem sintética via PowerShell com o texto exato "TypeError: cannot read cnpj9931 of undefi" (truncado de propósito) e coloquei no clipboard real do Windows. Claude, via `--from-clipboard` na pipeline completa, transcreveu o texto exatamente e corretamente identificou que estava cortado, sem inventar o resto. Codex, chamado diretamente com `-i`, devolveu a mesma transcrição exata. Nenhum dos dois alucinou o conteúdo.
- [ ] Achado não resolvido, fora de escopo por ora: numa rodada real do loop de consenso (item 17) com 2 revisores configurados, um deles (agy) não apareceu na seção CONSENSO do relatório — comportamento de degradação graciosa já documentado desde a Fase 4 (um revisor falhando nunca derruba o pipeline), mas não foi diagnosticado a fundo desta vez qual foi a causa específica da falha dele nessa rodada.

## Adiado indefinidamente (over-engineering ou escopo especulativo para o estágio atual)

- [ ] Scheduler completo (fila, prioridade, execução distribuída) — não existe ainda um cenário de múltiplos pipelines concorrentes que justifique
- [ ] Agent Registry instalável via npm, estilo extensões do VSCode (`manifest.json` + `activate()`/`deactivate()`) — falta um autor externo real pra validar esse contrato antes de formalizá-lo
- [ ] Web UI / Dashboard — ver item 7
- [ ] Geração de ADR (Architecture Decision Record) a partir do resultado do pipeline
- [ ] Exportação de documentação técnica gerada
- [ ] Exportação de Issues do GitHub a partir do plano de implementação
- [ ] Modo interativo (REPL) além do comando único `contreex "<objetivo>"`
