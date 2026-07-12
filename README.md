# Contreex

A terminal-only orchestrator for AI coding CLIs. One agent — the **implementer** — analyzes, plans, and implements. One or more other agents act purely as **reviewers**: they critique the plan, they never implement. Every agent exchanges structured JSON validated against a shared schema (the **AEP**, Agent Exchange Protocol) instead of free text, so nothing gets lost or hallucinated in translation between agents.

Today Contreex drives four CLIs through the same plugin interface: [Claude Code](https://claude.com/claude-code), [Codex CLI](https://github.com/openai/codex), [Antigravity CLI](https://antigravity.google) (`agy`), and [MimoCode CLI](https://mimo.xiaomi.com) (`mimo`). Adding a fifth is a config change, not a code change — see [Architecture](#architecture).

## Status

**Working alpha.** All 18 planned items in [`ROADMAP.md`](ROADMAP.md) are implemented and were validated with real, live CLI calls during development — not fixtures or mocks. There's a `contreex` CLI entrypoint; it supports writing objectives in Portuguese (or any language pair) via a built-in Language Engine (agents still work internally in English, where they perform best); it automatically picks how thorough a run should be based on what you actually asked for (an analysis-only request never turns into an unrequested implementation); real code-writing only happens with `--implement`, always inside an isolated git worktree, never the real project directory; reviewers get a dynamic consensus loop instead of a fixed round count (unanimity, with an explicit, justified override the implementer can use — see [ROADMAP.md item 17](ROADMAP.md)); and you can attach a screenshot with `--from-clipboard` or `--image <path>` for the implementer to actually look at. A handful of known gaps are tracked in [Known limitations](#known-limitations).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design, the empirical findings behind key decisions, and a phase-by-phase log of what was built and how it was proven to work. See [`ROADMAP.md`](ROADMAP.md) for what's done and what's next, in priority order.

## Requirements

- Node.js ≥ 20 (this project deliberately avoids Python — see [Why Node-only](#why-node-only))
- `git`
- At least one supported agent CLI installed and authenticated:
  - [`claude`](https://claude.com/claude-code) — Claude Code
  - [`codex`](https://github.com/openai/codex) — Codex CLI
  - [`agy`](https://antigravity.google) — Antigravity CLI
  - [`mimo`](https://mimo.xiaomi.com) — MimoCode CLI

## Install

```sh
npm install
```

## Configure

Contreex never assumes a default workspace. Before running anything in a project, that project needs a `.contreex-profile` file naming an explicit profile:

```yaml
# <your-project>/.contreex-profile
profile: home
```

That profile resolves through a cascade — **Global → Workspace → Project** — each layer able to override the one before it:

| Layer | File | Purpose |
|---|---|---|
| Global | `~/.contreex/config.yaml` | Defaults for every project: default `roles`, default `pipeline`. |
| Workspace | `~/.contreex/workspaces/<profile>.yaml` | Which MCP servers are allowed, per-workspace role overrides. |
| Project | `.contreex-profile` (found by walking up from cwd, like `.git`) | Selects the workspace; can override anything above it. |

A repo-local example lives in `docs/examples/` — see [`docs/ARCHITECTURE.md#configuration`](docs/ARCHITECTURE.md#configuration) for the full cascade example (including the Home/Corporate split this was designed around).

## Usage

```sh
# expose the `ctx` command globally (also aliased as `contreex`) — pick whichever works on your setup:
npm link                                                    # needs a user-writable npm global prefix
# or, more portable (no npm global config required):
ln -s "$(pwd)/bin/contreex.mjs" ~/.local/bin/ctx              # make sure ~/.local/bin is on PATH

cd <your-project>  # needs a .contreex-profile — see Configure above
ctx "Add isPalindrome(str) to utils.js — case-insensitive, ignore spaces."
```

See [`manual-pt_br.md`](manual-pt_br.md) for a from-scratch setup walkthrough in Portuguese.

```
Usage: ctx "<objective>" [options]   (alias: contreex)

Options:
  --dir <path>            Project directory to run in (default: current directory)
  --json                  Also print the full AEP document as JSON
  --verbose, --show-reviews   Show full reviewer findings and rejection reasons
  --implement             Actually write code — requires this explicit flag, never inferred.
                          Writes only inside the implementer's own git worktree; merging into
                          the real project is a manual step you do yourself. See the report.
  --from-clipboard        Attach the current Windows clipboard image (WSL2 only) — screenshot,
                          then run with this flag, same as pasting into an interactive CLI.
  --image <path>          Attach an image file by path instead (repeatable).
  -h, --help              Show this help
```

By default the objective is treated as English with no translation. To write in Portuguese (or any other language pair the free Google Translate endpoint supports), add a `language` block to your `.contreex-profile` or workspace config:

```yaml
language:
  input: pt-BR      # what you write in
  internal: en-US   # what the agents actually see — this is where they perform best
  output: pt-BR      # what you get back
```

```sh
ctx "Adicione uma função isPalindrome no arquivo utils.js, que ignora maiúsculas e espaços."
```

The CLI prints both the original and the translated-and-optimized objective before running, and translates the final summary back — technical terms and code identifiers (`isPalindrome`, `utils.js`, `MCP`, ...) are protected from translation on both legs via a technical dictionary (`src/language/dictionary.mjs`). See [`docs/ARCHITECTURE.md#language-engine`](docs/ARCHITECTURE.md#language-engine) for how it works.

Driving a pipeline from your own script instead of the CLI works the same way `bin/contreex.mjs` does internally:

```js
import { resolveConfig } from './src/config/load.mjs';
import { resolveRoles } from './src/agents/registry.mjs';
import { runOrchestrator } from './src/orchestrator.mjs';

const resolved = resolveConfig(process.cwd()); // throws if no .contreex-profile is found
const roles = resolveRoles(resolved.config.roles);

const { doc, documentValid } = await runOrchestrator({
  projectDir: resolved.projectRoot,
  objective: 'Add isPalindrome(str) to utils.js — case-insensitive, ignore spaces.',
  pipeline: resolved.config.pipeline,
  roles,
});
```

`scripts/demo-phase5.mjs` and `scripts/demo-phase7.mjs` are runnable, working examples of exactly this.

## Project structure

```
schema/aep.v1.schema.json   AEP v1 — the JSON Schema every agent's structured output is validated against
src/
  exec.mjs                  shared headless-spawn primitive (closes stdin, external SIGKILL timeout)
  worktree.mjs               git worktree isolation — every agent runs in its own disposable worktree
  agent-manager.mjs          retry classification, agent state machine, cache integration, semaphore gating
  orchestrator.mjs           pipeline DSL executor (sequential + parallel steps)
  cache.mjs                  content-addressable response cache
  concurrency.mjs            process-count semaphore (default 4 concurrent agent CLI spawns)
  mcp-gateway.mjs            workspace-scoped MCP server config generation (not a protocol reimplementation)
  compress.mjs               diff summarization (git diff --numstat) with on-demand full-diff expansion
  event-bus.mjs              plain node:events EventEmitter + EVENTS constants; doc.logs built from it
  report.mjs                 formats an AEP document into a consolidated terminal report
  consensus.mjs               deterministic, zero-LLM-cost review-gate strategies
  context-engine.mjs          decides what goes into each pipeline step's prompt
  intent-analyzer.mjs         keyword (+ optional LLM) classification of what pipeline thoroughness a request needs
  knowledge-base.mjs          durable, curated cross-run lessons (distinct from per-run decision memory)
  aep/                       normalize (raw CLI text -> JSON) + validate (Ajv) + combined pipeline
  agents/                    one plugin per CLI (claude, codex, agy, mimo) + a name->plugin registry
  actions/                   one file per pipeline action (analyze/review/refine/implement/consensus) + registry
  config/                    cascading config loader (Global -> Workspace -> Project) + named pipeline profiles
  language/                  PT-BR<->EN translation engine with a technical-term dictionary
  memory/                    decision memory: record runs, similarity search, per-agent stats
probe/                       Phase 0 capability probe — the empirical groundwork everything else is based on
reports/phase0-capabilities.json   raw findings from that probe
scripts/                    unit tests (scripts/unit-test-*.mjs) + one runnable demo per early phase
```

## Architecture

Full detail, including *why* each decision was made and the real CLI quirks discovered along the way, is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Short version:

- **Roles, not vendors.** The orchestrator only ever sees role names (`implementer`, `reviewer1`, ...); `src/agents/registry.mjs` is the only place that knows Claude/Codex/Antigravity/MimoCode exist.
- **AEP v1** — one versioned JSON Schema (`schema/aep.v1.schema.json`), not a fragmented family of sub-protocols. Sections are effectively immutable: a reviewer only ever writes to its own `reviews.<role>` key.
- **Worktree isolation is the real safety guarantee**, not per-CLI permission flags. Testing showed at least two of the four CLIs (Antigravity, MimoCode) have no flag that reliably blocks writes — so every agent, implementer or reviewer, runs in its own disposable `git worktree`, and only the implementer's worktree is ever meant to be merged.
- **Real code writes are explicit-command-only.** `analyze -> review -> refine` always runs in full for a rich response, regardless of wording — only the `implement` action (the one action with a real side effect) requires the `--implement` flag; no natural-language phrasing can trigger it.
- **Config cascade with mandatory explicit profile selection** — a personal project can never silently inherit a corporate workspace's MCP servers or credentials.
- **Memory of decisions, not conversation** — a lightweight, token-overlap similarity search over past runs, plus per-agent verdict/finding stats, both file-backed under `~/.contreex/`.

### Why Node-only

Python is effectively unavailable in the primary target environment (a corporate workstation), so every piece of this project — including the Phase 0 capability probe — is plain Node.js with a minimal dependency set (`ajv`, `ajv-formats`, `yaml`).

## Development

```sh
npm test                       # unit tests (scripts/unit-test-*.mjs) — AEP, language, intent, compress,
                                # report, event bus, knowledge base, consensus, MCP capabilities, concurrency,
                                # implement, consensus loop
node scripts/demo-phase2.mjs   # real Claude Code call, native --json-schema + our Validator agreeing
node scripts/demo-phase3.mjs   # Agent Manager + worktree isolation stress test
node scripts/demo-phase4.mjs   # full pipeline: analyze -> parallel review -> refine
node scripts/demo-phase5.mjs   # config cascade + pipeline driven entirely from YAML
node scripts/demo-phase6.mjs   # cache hit, MCP gateway filtering, diff compaction — with real numbers
node scripts/demo-phase7.mjs   # memory: similarity search + per-agent stats across two related tasks
```

Each demo script talks to real, installed CLIs and will incur whatever API cost those CLIs normally incur — they are not free to run repeatedly.

## Known limitations

- The CLI entrypoint is still minimal — no config subcommands (e.g. `contreex init`), no streaming output.
- The Language Engine's `PromptOptimizer` (OpenRouter) silently no-ops without an `OPENROUTER_API_KEY` — translation still works, but the English objective sent to agents won't get the extra clarity pass.
- Google Translate (the only `TranslationProvider` today) is an unofficial free endpoint with no SLA and an undocumented length limit — fine for objectives/summaries, not verified for long documents.
- The technical dictionary's code-token auto-detection is regex-based (camelCase/PascalCase/snake_case/file.ext/ALL_CAPS/backticks) — an unusual identifier style could slip through untranslated-unprotected and get mangled by MT.
- `Agent.cancel()` is a stub on every plugin; `exec()` doesn't currently expose the underlying child process handle, so there's no real mid-flight abort yet.
- The plugin interface (`execute/cancel/health/capabilities/version`) works for four real CLIs but has no formal contract/test suite of its own yet.
- The pipeline DSL (both inline and the named profiles under `~/.contreex/pipelines/`) has no formal schema/validator of its own yet (unlike AEP, which has one) — a malformed profile fails at load time, not with a dedicated error message.
- Credential storage per workspace is unaddressed — `~/.contreex/workspaces/*.yaml` currently only lists *which* MCP servers/roles/capabilities are allowed, not how their secrets are kept safe across Linux/WSL/Windows.
- `AgentManager`'s retry classification (retriable vs. terminal failure) is regex-heuristic over stderr text, built before any real quota/auth failures were observed in practice — expect to revise it once real ones happen.
- `capabilities().sandboxed`/`writeBlockConfirmed` metadata exists per plugin (see Phase 0) but the `implement` action doesn't read it yet — worktree isolation is the actual safety guarantee today, this metadata is informational only.
- No formal contract test suite for the config cascade / pipeline-profile loader beyond what the unit tests happen to exercise indirectly.

## License

[MIT](LICENSE)
