# Architecture

This document explains what Contreex is built from, why each piece exists, and — where relevant — the empirical finding that drove the decision. It assumes the reader has read the [README](../README.md) once.

## Contents

- [Vision](#vision)
- [Roles, not vendors](#roles-not-vendors)
- [The Agent Exchange Protocol (AEP)](#the-agent-exchange-protocol-aep)
- [Normalizer + Validator](#normalizer--validator)
- [Worktree isolation](#worktree-isolation)
- [Concurrency limit](#concurrency-limit)
- [Agent Manager](#agent-manager)
- [Orchestrator + pipeline DSL](#orchestrator--pipeline-dsl)
- [Context Engine](#context-engine)
- [Configuration](#configuration)
- [Cache](#cache)
- [MCP Gateway](#mcp-gateway)
- [Compression (RTK-style)](#compression-rtk-style)
- [Memory Engine](#memory-engine)
- [Language Engine](#language-engine)
- [Intent Analyzer](#intent-analyzer)
- [Terminal report](#terminal-report)
- [Event Bus](#event-bus)
- [Knowledge Base](#knowledge-base)
- [Consensus Engine](#consensus-engine)
- [Findings and gotchas per CLI](#findings-and-gotchas-per-cli)
- [Development log](#development-log)

## Vision

Most multi-agent coding tools pipe plain text between models: `Text → LLM → Text → LLM → Text`. Ambiguity and hallucination creep in at every hop. Contreex instead treats agents as services exchanging **validated JSON objects** over a shared schema — closer to a distributed system than a chat relay.

One agent, the **implementer**, is the only one that plans and writes code. Any number of other agents act as **reviewers** — they critique, they never implement. This mirrors how a real engineering team works: one person owns the change, others review it, and the reviews are structured feedback, not vibes.

## Roles, not vendors

The orchestrator, the Agent Manager, and the pipeline DSL never reference "Claude" or "Codex" by name. They only know about **roles** — `implementer`, `reviewer1`, `reviewer2`, etc. — each mapped to a concrete plugin via config:

```yaml
roles:
  implementer: claude
  reviewer1: codex
  reviewer2: agy
```

`src/agents/registry.mjs` is the *only* file in the codebase that lists the four concrete CLIs. Swapping a provider, or adding a fifth, is a one-line config change — this was proven directly: MimoCode CLI was added mid-project and slotted into an existing 3-reviewer pipeline with zero changes to `orchestrator.mjs` or `agent-manager.mjs`.

Every plugin implements the same interface:

```js
{
  name: 'claude',
  async execute({ prompt, cwd, role, jsonSchema, timeout }) { /* -> { ok, raw, meta } */ },
  async cancel() {},   // stub today — see Known limitations in the README
  async health() {},
  async version() {},
  capabilities() {},
}
```

## The Agent Exchange Protocol (AEP)

A single versioned JSON Schema (`schema/aep.v1.schema.json`), not a family of sub-protocols (AEP/ARP/ACP/ADP was considered and deliberately rejected as premature — one schema is enough until real usage proves otherwise).

```json
{
  "protocol":  { "name": "Agent Exchange Protocol", "version": "1.0.0" },
  "metadata":  { "requestId": "...", "role": "orchestrator", "createdAt": "..." },
  "request":   { "objective": "..." },
  "analysis":  { "problem": "...", "risks": [], "confidence": 0.9 },
  "plan":      { "steps": [{ "id": "1", "description": "..." }] },
  "reviews":   { "reviewer1": { "verdict": "APPROVE", "findings": [] } },
  "refinement":{ "acceptedChanges": [], "rejectedChanges": [] },
  "implementation": {},
  "validation":{},
  "metrics":   {},
  "logs":      []
}
```

The top-level schema sets `additionalProperties: false` — this is the immutability contract in code, not just in prose. A reviewer literally cannot write outside `reviews.<its-own-role>`; the schema rejects the document if it tries.

## Normalizer + Validator

CLIs are terminal agents, not chat APIs — their raw stdout is not guaranteed to be clean JSON, even when explicitly asked for it. `src/aep/normalize.mjs` strips markdown code fences and extracts the first balanced `{...}`/`[...]` substring, tracking string literals so braces *inside* string values (e.g. a code snippet containing `{{mustache}}`) don't break extraction. `src/aep/validate.mjs` wraps Ajv, validating either a full AEP document or a single named `$def` section in isolation (a reviewer only ever needs to validate its own `review` section, not a whole document).

Two agents (Claude Code, Codex) support native structured-output flags (`--json-schema`, `--output-schema`) and are asked to use them as a first layer — the Normalizer/Validator then verifies independently. The other two (Antigravity, MimoCode) have no such flag; the Normalizer/Validator is the *only* thing standing between their raw text and a usable object, and both were proven to work through it with real calls.

One repair step exists today: `canonicalizeReviewSeverities` in `normalize.mjs` maps common severity synonyms (`major → high`, `minor → low`, `blocker → critical`, etc.) before validation — added after MimoCode returned `"severity": "major"`, a plausible word that simply isn't in the AEP `review` enum. The fix wasn't the extractor (which was already correct); it was recognizing that agents without native schema enforcement need a semantic safety net, not just a syntactic one.

## Worktree isolation

**The real reason a reviewer can't touch your code isn't a CLI flag — it's that it never has a path to your code.**

Every agent invocation — implementer or reviewer — runs inside its own `git worktree` at `<project>/.worktrees/<agent>-<role>/`, on its own branch. `src/worktree.mjs` ensures the project is a git repo (initializing one if needed), ensures at least one commit exists, creates or reuses a worktree per invocation (hard-resetting a dirty leftover from a previous run), and validates role names against `/^[a-zA-Z0-9_-]+$/` before using them in a git branch name.

This exists because Phase 0 testing found that CLI-level permission flags are not uniformly trustworthy:

| CLI | Deny-write mechanism | Verified working? |
|---|---|---|
| Claude Code | `--permission-mode dontAsk` | Yes |
| Codex | `--sandbox read-only` | Yes |
| Antigravity (`agy`) | `--mode plan` | **No** — confirmed twice, wrote the file anyway |
| MimoCode (`mimo`) | none found | **No** — both `--dangerously-skip-permissions` and the bare default wrote the file |

Rather than keep chasing a flag that might not exist, the fix is structural: none of that matters if the reviewer is physically confined to a disposable worktree that never gets merged. This is the same technique used by prior art in this space ([claw-orchestrator](https://github.com/Enderfga/claw-orchestrator), [ccswarm](https://github.com/nwiizo/ccswarm)) — neither of them trusts CLI-level permission flags either.

## Concurrency limit

`src/concurrency.mjs`'s `Semaphore` caps how many agent CLI subprocesses can be in flight at once — deliberately not a full Scheduler (queue, priority, distributed execution, ROADMAP.md's "adiado indefinidamente" list); there's no real use case yet for anything beyond a simple cap. Default limit is 4, overridable via `CONTREEX_MAX_CONCURRENT_AGENTS`. A shared `defaultSemaphore` instance covers the whole process by default (the real risk is too many subprocesses system-wide, not per-`AgentManager`), and `AgentManager.run()` wraps only the actual `plugin.execute()` call in it — worktree setup and cache lookups aren't gated, since they're not the resource being protected.

## Agent Manager

`src/agent-manager.mjs` is the only thing that knows how to run an agent plugin safely. It owns:

- **State machine** — `READY / RUNNING / RETRYING / FAILED / QUOTA_EXCEEDED / AUTH_EXPIRED / OFFLINE / DISABLED`.
- **Retry classification** — a failure is either *retriable* (timeout, network blip, transient rate-limit) or *terminal* (quota exhausted, auth invalid — retrying these only burns time waiting for a result that cannot change). Today this is a regex heuristic over stderr text; it hasn't yet been exercised against a real quota/auth failure, so treat it as a first draft.
- **Worktree lifecycle** — creates one before every `run()` call via `src/worktree.mjs`.
- **Cache integration** — see [Cache](#cache).

```js
const result = await manager.run(claudeAgent, {
  projectDir, role: 'implementer', prompt, defName: 'analysis', jsonSchema, timeout: 60_000,
});
// result: { ok, agent, role, cwd, attempts, state, raw, data, validationErrors, meta }
```

## Orchestrator + pipeline DSL

`src/orchestrator.mjs` walks a pipeline — a plain JS array today, YAML-loadable via the config cascade (see [Configuration](#configuration)):

```js
[
  { role: 'implementer', action: 'analyze' },
  { parallel: [
    { role: 'reviewer1', action: 'review' },
    { role: 'reviewer2', action: 'review' },
  ] },
  { role: 'implementer', action: 'refine' },
]
```

Three actions exist: `analyze` (implementer produces `analysis` + `plan` in one call), `review` (a reviewer produces its `review` section), `refine` (implementer reads all reviews and produces `refinement`). A `parallel` block runs its steps concurrently via `Promise.all` — proven with real wall-clock timing (three reviewers finishing in ~63s total, not three times that).

Each action only defines a `baseInstruction(doc)` — what to ask. It does not decide what context comes with it (that's the Context Engine, below) or how to format the final prompt string (that's `PromptBuilder`, shared with the Language Engine). `runStep` composes all three: `buildPrompt({ objective: action.baseInstruction(doc), context: contextEngine.gather(...) })`.

Actions themselves live in `src/actions/` — one file per action (`analyze.mjs`, `review.mjs`, `refine.mjs`) — and `src/actions/registry.mjs` maps a name to an implementation, exactly mirroring `src/agents/registry.mjs`'s pattern. `orchestrator.mjs` itself has no idea `analyze`/`review`/`refine` exist; it only calls `resolveAction(step.action)`. Adding a new action (`securityReview`, `documentationReview`, a future `consensus` step) means adding one file here, never touching the orchestrator.

**Graceful degradation is load-bearing, not incidental.** If one reviewer's output fails validation, `applyOutcome` simply doesn't merge that section — the pipeline continues, and the final document is still schema-valid without it. This was observed directly: MimoCode failed validation in one real run and the pipeline finished normally anyway.

## Context Engine

Before this existed, `orchestrator.mjs` hardcoded what went into every prompt — always the full `doc.plan` and `doc.reviews`, dumped as JSON, and nothing about the actual project (agents were blind to what files even existed). `src/context-engine.mjs`'s `ContextEngine.gather({ action, doc, projectDir })` makes that an explicit, centralized decision instead, returning a flat array of context strings per action:

- `analyze` gets a real listing of the project's top-level files (`readdirSync`, dotfiles and `node_modules` filtered out, capped at 40) plus similar past tasks pulled from Decision Memory (`findSimilarRuns`, moved here from `orchestrator.mjs` directly).
- `review` gets the plan under review.
- `refine` gets the original plan plus all reviewer feedback.

`compress.mjs` (RTK-style diff summarization) and the future Knowledge Base (see below) don't have a real consumer wired in yet — both only become relevant once an `implement` action exists with an actual diff or curated lessons to draw on. The hooks for both live here when that happens, not scattered elsewhere.

Verified directly: `ContextEngine.gather()` called against a real two-file test project correctly returned `"Project files: index.js, utils.js"` plus every prior `isPalindrome`-related run recorded in Decision Memory during earlier development of this project.

## Configuration

Three layers, cascading, each able to override the one before it — and **profile selection is never silent**:

```
Global      ~/.contreex/config.yaml
   ↓ (overridden by)
Workspace   ~/.contreex/workspaces/<profile>.yaml
   ↓ (overridden by)
Project     .contreex-profile   (found by walking up from cwd, like .git)
```

`src/config/load.mjs`'s `resolveConfig()` throws `NoProfileError` if no `.contreex-profile` is found, or if it doesn't set `profile: <name>`; it throws `UnknownWorkspaceError` if that profile has no matching workspace file. There is deliberately no fallback default — a personal project must never be able to silently inherit a corporate workspace's MCP servers or role overrides just because some default happened to point at "corporate". See `docs/examples/` for a template of all three layers, modeling the Home/Corporate split this was designed around: `home.yaml` has no MCP servers; `corporate.yaml` lists a company's internal MCP servers and — as a worked example — overrides `reviewer2` to a different provider than the global default.

Merge semantics: plain objects merge key-by-key across layers; arrays and primitives are replaced wholesale by the more specific layer (no implicit array concatenation).

### Pipeline profiles

Named presets — `fast`, `standard`, `review`, `critical`, `enterprise`, `analysis-only` — live as real YAML at `~/.contreex/pipelines/<name>.yaml` (templates in `docs/examples/pipelines/`), not just documentation. Setting `pipelineProfile: <name>` anywhere in the cascade makes `resolveConfig()` load that file via `src/config/pipeline-profiles.mjs` and override whatever raw `pipeline:` array the cascade resolved to — the preset wins because choosing one is itself the more specific override. Omitting `pipelineProfile` changes nothing about existing behavior.

`fast` is analyze-only (implementer decides alone). `standard` adds one reviewer. `review` — today's default since Phase 4, and what the Intent Analyzer (below) routes almost everything to — runs two reviewers in parallel plus `refine`. `critical` is the double-review loop from the project's original design conversation (plan → review → refine → review again → refine again). `enterprise` is `critical` with a third reviewer, requiring `reviewer3` in `roles` (this is the most thorough preset available with today's three actions, not a placeholder for a dedicated security/compliance step — that's a separate future action, see ROADMAP.md item 11). `analysis-only` runs `analyze` + `review` with **no `refine` step** — kept as a manual, opt-in leaner/faster option, but **not** auto-selected by the Intent Analyzer (see the correction below).

## Cache

`src/cache.mjs` is a content-addressable cache (`sha256(agent + role + prompt + jsonSchema)`), file-backed at `~/.contreex/cache/`, 15-minute TTL by default. Wired into `AgentManager.run()` with `cache: true` by default; callers pass `cache: false` for any action with a real side effect the caller genuinely needs to happen every time (nothing does yet — `analyze`/`review`/`refine` are all pure JSON generation).

Deliberately keyed on the prompt text, not the worktree `cwd` (a meaningless random `mkdtemp` path) — this assumes the prompt already encodes everything relevant, true for every action that exists today since they all embed the plan/reviews JSON directly in the prompt text.

### Token economy — real findings, not aspirational claims

`scripts/token-economy-report.mjs` measures what actually saves tokens/cost today, following the same "no decorative metrics" rule as ROADMAP.md item 7. Run it yourself; here's what it found (2026-07-12, this environment):

- **Cache is the only proven real saving.** A repeated identical call: first run cost `$0.058` (Claude), second run — a cache hit — cost `$0` and used zero additional tokens. Confirmed with `meta.tokens`/`meta.costUsd` now captured from the raw CLI output (`claude-agent.mjs`, `codex-agent.mjs`).
- **The Prompt Optimizer is a complete no-op without `OPENROUTER_API_KEY`** — verified directly: `optimize()` returned input and output as byte-identical strings. In this environment it costs nothing and saves nothing, because it doesn't run at all. Its real effect on token count (could plausibly increase it — "clarifying" a prompt is not the same as shortening it) has never been measured with a real key.
- **The Context Engine's own overhead is genuinely small**: a real `gather()` call returned 618 characters of context that became a 621-character final prompt — 3 characters of formatting overhead.
- **Unexpected finding**: comparing real token usage for the same task, Codex reported 37,175 input tokens against Claude's 6 "new" input tokens (with 64,514 absorbed by Anthropic's own prompt cache). The dominant cost driver per call is each CLI's own baseline overhead (system prompt, tool definitions) — something Contreex's context/compression work does not and cannot control, since it's internal to each wrapped CLI.

#### RTK and pxpipe — actually investigated (2026-07-12), not assumed

Both were named as token-economy inspiration in the very first message of this whole project, and neither was actually looked at until the user pointed out — correctly — that `compress.mjs` called itself "RTK-inspired" without the author ever having read the real project. That was a mistake; corrected by cloning both and testing for real.

**RTK** (`github.com/rtk-ai/rtk`) is a Rust CLI proxy that compacts common dev command output (`git diff`, test runners, `grep`, ...) before it reaches an LLM's context, and it already supports being hooked into the exact CLIs this project orchestrates (`rtk init -g --codex`, `rtk init -g --agent antigravity`). Installed the real binary and tested it directly against this repo:

| test | raw | rtk | note |
|---|---:|---:|---|
| `npm test` output (passing) | 1,802 B | 304 B | real, valid — shows a compact tail, not hidden failures |
| `npm test` output (deliberately broken) | — | — | correctly showed `SOME TESTS FAILED` in the tail, full log preserved on disk |
| `grep -r "export" src/` | 4,355 B | 4,354 B | no meaningful savings — this codebase's grep output was already dense, nothing to strip |
| `git diff`, small realistic change (2 lines) | 274 B | 260 B | complete, no data loss, modest savings from header replacement |
| `git diff`, large change (100 lines) | 7,321 B | 3,844 B | **looked like a 48% win — turned out to be lossy**: RTK's default caps each hunk at 100 shown lines and silently dropped every single `+` line past that cap, replacing them with `"... (100 lines truncated)"` |

The large-diff result mattered: RTK's real default behavior does lose real content above its truncation threshold, recoverable only via an explicit `--no-compact` flag the caller has to know to ask for. Decision: **do not depend on the `rtk` binary** (the user's explicit preference — a project dependency on an external system tool), but the underlying *technique* (strip diff metadata/header boilerplate) is legitimate and safe below that threshold. `src/compress.mjs`'s `condenseDiff()` reimplements the safe part in plain JS and — deliberately, unlike RTK's own default — never truncates a `+`/`-` line at any diff size, trading some compaction ratio for the correctness guarantee this project actually needs. `expandDiff()` now uses it; a real 100-line change in this repo compacts by only ~3% with this safer approach (vs. RTK's lossy 48%), because most of RTK's number came specifically from the truncation this project's version refuses to do.

**pxpipe** (`github.com/teamchong/pxpipe`) renders bulky context as PNG images for a vision-language model to read — cheaper per-token than dense text, per its own measurements (~68% savings on real traffic). Its own `FINDINGS.md` is unusually candid about why this is risky: a VLM reading an image is not OCR — there's no confidence signal, so misreads are silent and confident rather than visibly garbled, and *exact byte-level content* (hashes, ids, paths) is precisely the content type that fails while prose reads fine. Their own measurements show this is highly model-dependent (one model: 10% exact-match on hex ids at production density; another: 13/15; others: 0/15 to 0/4) — every model needs its own extensive validation before it's considered safe, and most of the models they tested failed that bar. Contreex orchestrates four heterogeneous agent CLIs, and the AEP protocol's entire value proposition depends on JSON surviving byte-exact — the precise worst case for this technique. **Not adopted.**

Honest summary: today, "this product saves tokens" is true in exactly one situation (repeated identical calls, via cache) and not yet true anywhere else the architecture claims to help.

## MCP Gateway

`src/mcp-gateway.mjs` does **not** reimplement the MCP protocol — that would duplicate mature, existing client/server implementations for no benefit. It does exactly one thing: given a workspace's `mcp` allowlist (from the config cascade), it filters `~/.contreex/mcp-servers/<name>.json` definitions down to only the allowed ones and emits a standard `{ mcpServers: {...} }` config file for a CLI's own native `--mcp-config` flag to consume. A server listed in the workspace but with no definition file yet is reported (`missing: [...]`), not fatal — this is the actual enforcement point: an agent running in the `home` workspace is structurally incapable of being handed the `corporate` workspace's Jira/Confluence servers, because the gateway never puts them in its generated config.

**MCP as a capability, not a server name**: `resolveCapabilities()`/`writeMcpConfigForCapabilities()` add one layer of indirection on top of the above. A caller asks for a capability ("git", "issueTracker"), never a literal server — the active workspace's `capabilities` map (a new section in workspace YAML, e.g. `git: corporate, issueTracker: jira`) decides which concrete server actually answers it. A capability with no mapping in the current workspace comes back in `unavailableCapabilities`, not as an error — the same request degrades gracefully in a workspace (like `home`) that doesn't define an issue tracker at all, rather than crashing.

## Compression (RTK-style)

`src/compress.mjs`: `summarizeDiff(cwd)` runs `git diff --numstat` and returns per-file insertion/deletion counts instead of the full diff text; `expandDiff(cwd, filePath)` fetches the full diff for exactly one file, on demand. Verified with a real diff: 14,865 characters of full diff compacted to a 110-character summary (99.3% smaller) — the idea being a reviewer gets the compact form first and only pays the token cost of the full diff for files it actually needs to look closely at.

`condenseDiff(rawDiff)` strips unified-diff header boilerplate but, unlike RTK's own `git diff` wrapper, never truncates hunks regardless of size — see [Implement action](#implement-action) for why, and for `summarizeDiff`'s first real consumer.

## Memory Engine

Memory of **decisions**, not conversation. `src/memory/store.mjs` appends one distilled JSON record per completed pipeline run to `~/.contreex/memory/runs.jsonl` — objective, per-reviewer verdict/finding counts, refinement accept/reject counts. `src/memory/query.mjs`'s `findSimilarRuns()` does token-overlap similarity search (deliberately not embeddings — it only needs to be good enough to say "this looks like that palindrome-helper task from last week," not power a search engine) and is threaded into the `analyze` step's prompt automatically. `src/memory/stats.mjs`'s `agentStats()` aggregates verdict distribution and finding volume per agent over time — today it only exposes the numbers; using them to automatically weight or reorder reviewers is a natural next step once there's enough real history to trust.

A memory-write failure is caught and swallowed inside `runOrchestrator` — memory is a side channel that must never cause a pipeline run to fail.

## Language Engine

The first and last component in the request/response path — see the target architecture diagram in [`ROADMAP.md`](../ROADMAP.md). Everything between `languageEngine.toInternal()` and `languageEngine.toOutput()` operates in plain internal-language English, exactly as it did before this component existed; the rest of the platform never has to think about language at all.

- **`src/language/dictionary.mjs`** — protects technical terms from machine translation. A curated list (`Worktree`, `Agent`, `MCP`, `JSON Schema`, ...) plus regex-based auto-detection of code-shaped tokens (camelCase/PascalCase, `snake_case`, `file.ext`, `ALL_CAPS` acronyms, anything in backticks). Each protected term is swapped for a placeholder token (`TERMPLACEHOLDER0`, `TERMPLACEHOLDER1`, ...) before translation and restored afterward — verified empirically that this exact token shape survives Google Translate untouched in both directions.
- **`src/language/translation-provider.mjs`** — a `TranslationProvider` interface; `googleTranslateProvider` (the free, unofficial `translate.googleapis.com` endpoint used by browser extensions — no API key, no billing, no SLA) is the first implementation. Swapping in DeepL, Azure, or the paid Cloud Translation API is adding one entry to `TRANSLATION_PROVIDERS`.
- **`src/language/prompt-builder.mjs`** — assembles an objective plus optional context lines into one prompt string. Deliberately minimal until the Context Engine (ROADMAP.md #3) exists to decide *what* context belongs there; this module's job stays just formatting.
- **`src/language/prompt-optimizer.mjs`** — a `PromptOptimizerProvider` interface; `openRouterOptimizer` is the first implementation, asking a free-tier model to improve the English objective's clarity while preserving every technical term and identifier verbatim. If `OPENROUTER_API_KEY` isn't set, `optimize()` is a no-op that returns the prompt unchanged — an optional quality improvement must never be allowed to fail the pipeline over a missing credential.
- **`src/language/engine.mjs`** — `LanguageEngine` ties the above together: `toInternal(text, {input, internal})` protects terms, translates, restores terms, then optimizes; `toOutput(text, {internal, output})` protects terms, translates, restores terms (no optimization pass on the way back — the user should see their own agents' actual output, not a rephrased version of it).

`bin/contreex.mjs` is the only current caller: it reads `language` from the resolved config cascade (default `{input: en-US, internal: en-US, output: en-US}`, i.e. no translation at all unless configured), calls `toInternal()` on the objective before handing it to `runOrchestrator`, and `toOutput()` on the final summary before printing it. The AEP document itself records `request.language: {input, internal, output}` for provenance — the schema's `request` `$def` was extended from a flat `language: string` to this object shape.

Validated with a real round trip through the CLI: `"Adicione uma função isPalindrome no arquivo utils.js, que ignora maiúsculas e espaços."` translated to `"Add a isPalindrome function in the utils.js file, which ignores capital letters and spaces."` — `isPalindrome` and `utils.js` preserved exactly — ran the full pipeline, and the final summary came back in Portuguese (`Documento válido: verdadeiro`).

## Intent Analyzer

Found through a real scenario, not speculation: a request like "analyze these two applications" must never come back looking like the tool made an implementation decision nobody asked for. Before this existed, the pipeline was fixed regardless of what was actually asked.

`src/intent-analyzer.mjs`'s `classifyIntent(text, {optimizer})` runs on the **raw, untranslated** objective — `classifyByKeyword()` checks PT-BR/EN keyword patterns in order of specificity (`implement` before `plan` before `review-code` before `analyze`, so a message that mentions several verbs doesn't get misclassified toward the safest-sounding one). This needs no network call by default. If nothing matches, and an `optimizer` was supplied (reusing the exact same `openRouterOptimizer` from the Language Engine's `PromptOptimizer` — no separate provider abstraction was built for this), it asks the LLM to classify; without a configured API key or on an unrecognized answer, it falls through to a default of `plan` — deliberately neither `analysis-only` (would under-deliver on a real request) nor `implement`-level thoroughness (would over-deliver on one that wasn't asked for).

**Correction (2026-07-12, caught by the user immediately after shipping this):** the first version mapped `analyze`/`review-code` to the `analysis-only` preset, which skips `refine`. That was wrong — `refine` never touches code, it's the implementer synthesizing reviewer feedback into text/JSON, same as `analyze` or `review` themselves. The user wants analysis **and** refinement on every call, always, for a richer synthesized response. What actually needs gating is a hypothetical future code-writing `implement` action, which doesn't exist yet (see README "Known limitations") — there is currently zero risk of unrequested code changes, because nothing in this codebase can make one. So `profileForIntent()` now maps `analyze`/`review-code`/`plan` all to `review` (full analyze → review → refine); only `implement` gets extra scrutiny (`critical`, the double-review loop) in anticipation of that future action actually writing something. `bin/contreex.mjs` only runs this classification when the config cascade didn't already set `pipelineProfile:` explicitly — an explicit choice always wins over inference.

The user's own framing for the eventual `implement` action, worth preserving verbatim as a design constraint: it must fire only on an **explicit command** (e.g. a distinct `/implement` subcommand or flag), never purely from natural-language keyword inference — tracked as ROADMAP.md item 14.

A second, related addition shipped alongside this: the `analyze` action's `analysis` output can now include `clarifyingQuestions` — filled only when there's genuinely not enough information for a confident plan, never invented for their own sake. Verified directly: a real run of the exact migration scenario that motivated this whole feature (`"Analise essas duas aplicações..."`, C#/.NET legacy vs. a refactored Java version) correctly classified as `analyze` (despite the message also containing words like "desacoplar"/"migrar" that could read as implementation verbs), and — before the correction above — the Context Engine's real file listing (only a placeholder `README.md` existed in the test project) led the model to ask genuinely relevant clarifying questions instead of inventing a plan from nothing. Re-verified after the correction: the same kind of request now also runs `refine` (confirmed via a real call — the output included a `Refinement: 0 accepted, 0 rejected` line where it previously showed nothing).

## Terminal report

`src/report.mjs`'s `formatReport(doc, documentValid, {verbose})` replaces what used to be an ad-hoc `buildSummary()` inside `bin/contreex.mjs`. Design principle: the output should read like a consolidated report from a team of architects, not an AI chat transcript. Default output shows the objective, analysis (including clarifying questions when present), plan, each reviewer's verdict, and a "divergences resolved by the implementer" section built from `refinement.acceptedChanges`/`rejectedChanges` — but hides individual finding details and rejection reasons unless `--verbose`/`--show-reviews` is passed. Every number in the report traces to a real field on `doc`; nothing is computed just to look impressive (the ROADMAP.md item 7 rule).

## Event Bus

`src/event-bus.mjs` exports `EVENTS` (the event name constants) and a shared default `eventBus` (a plain `node:events` `EventEmitter` — no new dependency). In practice each `AgentManager` owns its own bus instance (`new AgentManager({ eventBus })`, defaulting to a fresh `EventEmitter` per manager) rather than everyone sharing the process-wide singleton — this avoids cross-talk if multiple pipelines ever run concurrently (see ROADMAP.md item 13).

`AgentManager.run()` emits `BeforeAgentRun` and `AfterAgentRun` around every call (including cache hits, marked `cached: true`), plus `RetryStarted` and `QuotaExceeded` during the retry loop. Callers can attach arbitrary metadata to a call via `eventMeta` (e.g. `orchestrator.mjs` passes `{ action: step.action }`), which gets merged into every event that call emits — `AgentManager` never has to know what a "pipeline action" is.

`orchestrator.mjs` no longer builds `doc.logs` by pushing to it directly — `runOrchestrator` registers a listener on `manager.eventBus` for `AfterAgentRun` that builds each log entry, and removes the listener when the run finishes. It also emits `ReviewAccepted`/`ReviewRejected` (one event per item in `refinement.acceptedChanges`/`rejectedChanges`) and `PipelineFinished` at the end. Anything wanting to observe a run — a future dashboard, tests, logging — listens to the same events real production code already emits, instead of needing its own hook into the orchestrator internals.

## Knowledge Base

Distinct from the Memory Engine above: Decision Memory is per-run statistics ("this run's verdict was APPROVE"), the Knowledge Base is durable, curated lessons that stay true across many runs ("Codex tends to miss async concurrency bugs"). `src/knowledge-base.mjs` — `addEntry({text, tags})`/`listEntries()`/`queryKnowledgeBase(text)`, stored at `~/.contreex/knowledge-base.jsonl`, using the same token-overlap similarity as `memory/query.mjs`'s `findSimilarRuns` rather than inventing a second technique. Promotion is deliberately manual for v1 — `addEntry()` is the real path; `suggestPromotions()` only surfaces candidates (agents with recurring findings across recorded runs) for a human to confirm, not an autonomous pipeline. Wired into the Context Engine: `analyze` and `review` steps both get relevant Knowledge Base entries alongside similar past tasks from Decision Memory.

## Consensus Engine

`refine` still exists and still does its own LLM-based synthesis — the Consensus Engine (`src/consensus.mjs`) is an additional, optional, deterministic gate a pipeline can run before it, at zero LLM cost, since it's pure computation over `doc.reviews`. Five strategies: `unanimity` (default — any `BLOCKED` wins, otherwise every reviewer must `APPROVE`), `majority`, `implementerDecides` (computes nothing, exists so a pipeline can name "no independent gate" explicitly), `weighted` (weighs each reviewer's vote by its historical approve rate from `agentStats()` — Decision Memory feeding back into how much a given agent's opinion counts), and `corporatePolicy` (a named indirection to another strategy, configurable per workspace, default `unanimity`).

Implemented as a new declarative action (`src/actions/consensus.mjs`, `{ local: true, compute, merge }`) rather than a bolt-on module — a pipeline includes it like any other step (`{ action: 'consensus', strategy: 'majority' }`, no `role`). `orchestrator.mjs`'s `runStep` checks `action.local` and, for these, skips `AgentManager`/worktree creation/any LLM call entirely, computing synchronously and still emitting through the same event bus (`agent: 'contreex'` in the resulting log line, to distinguish it from a real CLI call). AEP gained a `consensus: {strategy, verdict, rationale}` section. Verified with a real pipeline run (`analyze → review → consensus → refine`): the computed verdict matched the real reviewer's actual verdict, and the log line correctly read `consensus (contreex) ran action 'consensus' — ok`.

## Implement action

`src/actions/implement.mjs` is the only pipeline action that writes real files — every other action (`analyze`/`review`/`refine`/`consensus`) is text/JSON synthesis with no side effect. `cache: false` (a real write must happen every time it's asked for, never served stale from `~/.contreex/cache/`), `timeout: 120_000` (writing plus self-verification takes longer than a JSON-only turn). Uses `aepSchema.$defs.implementation`, which existed in `schema/aep.v1.schema.json` since the project's very first commit but had no consumer until now.

**The explicit-trigger constraint, verbatim from the user:** "então todo passa pelos revisadores e refine sempre, agora se vai implementar é só com a minha ordem" — everything always goes through reviewers and refine; actual implementation only fires on the user's explicit order. This is enforced at two independent points, both verified live:
- `src/intent-analyzer.mjs`'s `profileForIntent()` never maps any natural-language intent to a pipeline that includes the `implement` action — even the `implement` *intent* keyword only selects `critical` (extra review scrutiny, still zero writing).
- `bin/contreex.mjs` only ever loads the `implement` pipeline profile (`docs/examples/pipelines/implement.yaml`: `analyze → review×2 → refine → implement`) when the `--implement` CLI flag is passed, and that flag takes precedence over both a configured `pipelineProfile` and the Intent Analyzer.

Live test, same objective, both paths: `contreex "Add isPalindrome(str) to utils.js"` (no flag) classified as `plan` → `review` profile, no `implement` step anywhere in the executed pipeline. `contreex --implement "Add isPalindrome(str) to utils.js"` ran the full `implement` pipeline with Claude as implementer, and:
- `utils.js` inside `.worktrees/claude-implementer/` gained a real `isPalindrome` function and export.
- The real project's `utils.js` was verified byte-identical before and after, and `git status` in the real project directory stayed clean (only the untracked `.worktrees/` directory appeared) — the worktree-isolation guarantee from ROADMAP.md item 3, exercised end-to-end for the first time with an action that actually writes.
- `doc.implementation` (`status: "completed"`, `filesChanged`, `commands`) matched what the model reported; `src/compress.mjs`'s `summarizeDiff()`, run against the real worktree, independently confirmed the same file count and line counts (`+6/-1`) via `git diff --numstat` — the LLM's self-report and the ground truth agreed.

`src/report.mjs` renders all of this under an "IMPLEMENTAÇÃO" section: status, files changed with their one-line summaries, commands the implementer ran to self-verify, the real `git diff --numstat` totals, the worktree path, and explicit manual-merge instructions (`git log -p`, `git merge <branch>`) — merging into the real project is never automatic, matching the same human-in-the-loop principle worktree isolation was built on for reviewers.

`scripts/unit-test-implement.mjs` (10 tests, fake plugins, no API cost) covers the action's registration/config, its Context Engine wiring, `runOrchestrator` only surfacing `implementWorktree` after a validated successful `implement` step (not after a failed one, not when no such step ran at all), and every report section — added as the 12th file in `npm test`'s chain.

## Consensus loop (dynamic review<->refine rounds)

Added 2026-07-12 after the `critical`/`enterprise` presets' original fixed-2-round design turned out to have a real bug (see [Round-to-round context](#round-to-round-context) below) and the user gave an explicit weighting rule: base rule is unanimity, but the implementer ("chief engineer") carries more weight than any single reviewer, since reviewers can disagree over things that don't actually matter.

`src/orchestrator.mjs` gained a new pipeline step shape, `{ loop: { maxRounds, reviewers } }`, handled by `runConsensusLoop()`: each round runs the reviewers in parallel, then the existing `consensus` local action (`src/actions/consensus.mjs`, unchanged, reused as-is) computes `unanimity` over `doc.reviews`. Three ways a round can be the last one:
1. **Unanimous APPROVE** — the round stops immediately, `refine` doesn't even run (nothing to reconcile).
2. **`refinement.chiefEngineerOverride: true`** — a new field on the `refinement` AEP section. The implementer can end the loop without full reviewer agreement, but only by setting this explicitly and filling `overrideRationale` with a concrete justification (`src/actions/refine.mjs`'s prompt requires this, never a generic dismissal) — this is the "Claude carries more weight" rule made structural and auditable, not a silent default.
3. **`maxRounds` reached** — the loop ends anyway; the final round's `refine` is always the last word, and the report explicitly says consensus was *not* reached, so the decision comes back to the user rather than staying with the implementer alone.

`doc.consensus` (already existed since the Consensus Engine, ROADMAP.md item 10) gained `rounds`/`maxRounds`/`stopReason`, filled in after the loop ends. `docs/examples/pipelines/critical.yaml`/`enterprise.yaml` were rewritten to use `{ loop: { maxRounds: 3, reviewers: [...] } }` instead of their old hardcoded 2-round `review → refine → review → refine` shape.

Verified with real CLIs (`pipelineProfile: critical`, Claude implementer, Codex + Antigravity reviewers, an intentionally ambiguous "add unbounded caching" objective): ran 2 real rounds, converged by unanimous approval on round 2, and — notably — `refine` rejected one of the reviewer's suggestions with a *factually verified* rationale (it ran `grep`/`ls` against the real repo to confirm the reviewer's premise was wrong, rather than just asserting it). One open item, not yet diagnosed: in that same run, only one of the two configured reviewers appeared in the final `doc.reviews` — consistent with the graceful-degradation behavior documented since Phase 4 (one reviewer failing never blocks the pipeline), but the specific cause for that reviewer wasn't investigated this round.

### Round-to-round context

Bug found while building the loop: `refinement.updatedPlan` existed in the schema since day one but nothing ever filled or propagated it — `src/actions/refine.mjs`'s `merge()` now sets `doc.plan = data.updatedPlan` when the model provides one. Separately, `src/context-engine.mjs`'s `review` branch used to nest its `doc.refinement` context line inside `if (doc.plan)` — meaning a second review round would silently get no visibility into what the implementer already accepted/rejected whenever no plan had been set yet, and would build the *exact same prompt* as round 1 (a real correctness bug that also happened to look like a cache bug in testing — an identical prompt is, correctly, a cache hit, which is what made two genuinely different rounds return identical mocked responses in an early version of `scripts/unit-test-consensus-loop.mjs`). Fixed by un-nesting the refinement line so it fires independently of whether a plan exists.

## Reviewer prompt hardening

`src/actions/review.mjs`'s prompt now states explicitly: "you never create, edit, or modify any file, even if you are certain you know the fix." Before this, the only thing stopping a reviewer from writing was structural (permission mode / sandbox flags, worktree isolation) — for Antigravity and MimoCode, whose own flags don't actually block writes (Phase 0 finding), that structural layer was already load-bearing on its own; this adds an explicit instruction as defense in depth, cheap and unconditional.

## Image attachments

Motivated directly by the user's real workflow: they screenshot an error and paste it (Ctrl+V) straight into Claude Code's interactive terminal. Contreex is headless — one CLI invocation, no REPL to paste into — so there's no paste event to intercept; instead `src/clipboard.mjs`'s `saveClipboardImage(destDir)` reads the same Windows clipboard a paste would, via `powershell.exe` interop (`System.Windows.Forms.Clipboard` + `System.Drawing`, WSL2-only), saves it as a PNG, and translates the path with `wslpath -u`. Throws a clear `ClipboardError` if there's no image or interop isn't reachable — verified live for both cases.

`bin/contreex.mjs` gained `--from-clipboard` and `--image <path>` (repeatable), resolving into `doc.request.attachments` (new `request.attachments: string[]` field in the AEP schema). Only the `analyze` step gets images — `src/orchestrator.mjs`'s `runStep` passes `images: doc.request.attachments` to `manager.run()` only when `step.action === 'analyze'`; reviewers don't need it re-attached every round. `src/agent-manager.mjs`'s `run()` forwards `images` to `plugin.execute()` and folds it into the cache key (two calls with the same prompt but different images must never collide).

Two genuinely different code paths for the two verified CLIs:
- **Codex**: native flag, `-i/--image <FILE>...` (confirmed in `codex exec --help`, `supportsImages: true` since Phase 0 but had zero consumers until now) — `src/agents/codex-agent.mjs` appends `-i <path>` per image.
- **Claude Code**: no dedicated flag; works via the `Read` tool reading an absolute path referenced in the prompt text — `src/context-engine.mjs`'s `analyze` branch adds `Attached image(s) — look at them, they show what's actually happening: <path>`.

Verified live with a real image, not a placeholder: generated a synthetic screenshot via PowerShell containing the exact text `TypeError: cannot read cnpj9931 of undefi` (deliberately clipped at the canvas edge), set it as the real Windows clipboard image, then: (1) ran the full pipeline with `--from-clipboard` — Claude's analysis transcribed the text exactly, including correctly noting it was truncated rather than inventing the rest; (2) called `codexAgent.execute()` directly with `-i` pointed at the same file — returned the identical exact transcription. Neither agent hallucinated content; both genuinely read the image.

## Findings and gotchas per CLI

Collected here because they cost real time to discover and are easy to silently regress on:

- **Claude Code**: the headless-safe, deny-by-default permission mode is `--permission-mode dontAsk`, *not* `--permission-mode bypassPermissions`. `bypassPermissions` combined with `--disallowedTools` was tested directly and does **not** enforce the deny list (the file got written anyway; `permission_denials` came back empty in the JSON output). Without `dontAsk`, both the `default` and `plan` permission modes hang indefinitely in `-p` headless mode with no TTY to approve anything. Also: `--json-schema` requires a fully self-contained schema — a `$ref` to an external `$id` fails with "can't resolve reference."
- **Codex CLI**: `codex exec` reads additional prompt content from stdin, and hangs forever if stdin is a piped, unclosed stream — every headless invocation must call `child.stdin.end()` (this is why `src/exec.mjs` uses `spawn` instead of `execFile`). `--json` emits JSONL; the final reply is the last `{"type":"item.completed","item":{"type":"agent_message","text":...}}` event. `--sandbox read-only` correctly blocks writes.
- **Antigravity (`agy`)**: without `--add-dir <cwd>`, it ignores the working directory entirely and writes into its own scratch dir (`~/.gemini/antigravity-cli/scratch`) instead. `--mode plan` does not reliably block writes (see [Worktree isolation](#worktree-isolation)). Its native `--print-timeout` is only directionally accurate (~2x overhead observed against the requested value) — never rely on it alone, always wrap with an external timeout too.
- **MimoCode (`mimo`)**: `mimo run --format json` emits JSONL; the final reply is the last `{"type":"text","part":{"type":"text","text":...}}` event. No native structured-output enforcement and no confirmed write-blocking flag (see [Worktree isolation](#worktree-isolation)) — occasionally strays from a requested enum value (see the severity-synonym fix in [Normalizer + Validator](#normalizer--validator)).

## Development log

Every phase below was implemented and proven with real, live CLI calls during development — not fixtures.

| Phase | What | Proof |
|---|---|---|
| 0 | Capability probe across all 4 CLIs (`probe/`) | `reports/phase0-capabilities.json` |
| 1 | Headless JSON reliability | folded into Phase 0/2 |
| 2 | AEP v1 + Normalizer + Validator | `scripts/demo-phase2.mjs`, `demo-phase2-agy.mjs` |
| 3 | Agent Manager + worktree isolation, 2 plugins | `scripts/demo-phase3.mjs` |
| 4 | Orchestrator + pipeline DSL, parallel reviewers, 4th plugin (MimoCode) added mid-phase | `scripts/demo-phase4.mjs`, `demo-phase4-mimo.mjs` |
| 5 | Config cascade, mandatory explicit profile | `scripts/demo-phase5.mjs` |
| 6 | Cache, MCP Gateway, RTK-style compression | `scripts/demo-phase6.mjs` |
| 7 | Memory Engine | `scripts/demo-phase7.mjs` |
