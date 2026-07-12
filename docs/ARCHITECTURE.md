# Architecture

This document explains what Contreex is built from, why each piece exists, and — where relevant — the empirical finding that drove the decision. It assumes the reader has read the [README](../README.md) once.

## Contents

- [Vision](#vision)
- [Roles, not vendors](#roles-not-vendors)
- [The Agent Exchange Protocol (AEP)](#the-agent-exchange-protocol-aep)
- [Normalizer + Validator](#normalizer--validator)
- [Worktree isolation](#worktree-isolation)
- [Agent Manager](#agent-manager)
- [Orchestrator + pipeline DSL](#orchestrator--pipeline-dsl)
- [Context Engine](#context-engine)
- [Configuration](#configuration)
- [Cache](#cache)
- [MCP Gateway](#mcp-gateway)
- [Compression (RTK-style)](#compression-rtk-style)
- [Memory Engine](#memory-engine)
- [Language Engine](#language-engine)
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

## Cache

`src/cache.mjs` is a content-addressable cache (`sha256(agent + role + prompt + jsonSchema)`), file-backed at `~/.contreex/cache/`, 15-minute TTL by default. Wired into `AgentManager.run()` with `cache: true` by default; callers pass `cache: false` for any action with a real side effect the caller genuinely needs to happen every time (nothing does yet — `analyze`/`review`/`refine` are all pure JSON generation).

Deliberately keyed on the prompt text, not the worktree `cwd` (a meaningless random `mkdtemp` path) — this assumes the prompt already encodes everything relevant, true for every action that exists today since they all embed the plan/reviews JSON directly in the prompt text.

## MCP Gateway

`src/mcp-gateway.mjs` does **not** reimplement the MCP protocol — that would duplicate mature, existing client/server implementations for no benefit. It does exactly one thing: given a workspace's `mcp` allowlist (from the config cascade), it filters `~/.contreex/mcp-servers/<name>.json` definitions down to only the allowed ones and emits a standard `{ mcpServers: {...} }` config file for a CLI's own native `--mcp-config` flag to consume. A server listed in the workspace but with no definition file yet is reported (`missing: [...]`), not fatal — this is the actual enforcement point: an agent running in the `home` workspace is structurally incapable of being handed the `corporate` workspace's Jira/Confluence servers, because the gateway never puts them in its generated config.

## Compression (RTK-style)

`src/compress.mjs`: `summarizeDiff(cwd)` runs `git diff --numstat` and returns per-file insertion/deletion counts instead of the full diff text; `expandDiff(cwd, filePath)` fetches the full diff for exactly one file, on demand. Verified with a real diff: 14,865 characters of full diff compacted to a 110-character summary (99.3% smaller) — the idea being a reviewer gets the compact form first and only pays the token cost of the full diff for files it actually needs to look closely at.

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
