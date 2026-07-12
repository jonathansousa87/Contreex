# Contreex

*(working name — not finalized, see [Status](#status))*

A terminal-only orchestrator for AI coding CLIs. One agent — the **implementer** — analyzes, plans, and implements. One or more other agents act purely as **reviewers**: they critique the plan, they never implement. Every agent exchanges structured JSON validated against a shared schema (the **AEP**, Agent Exchange Protocol) instead of free text, so nothing gets lost or hallucinated in translation between agents.

Today Contreex drives four CLIs through the same plugin interface: [Claude Code](https://claude.com/claude-code), [Codex CLI](https://github.com/openai/codex), [Antigravity CLI](https://antigravity.google) (`agy`), and [MimoCode CLI](https://mimo.xiaomi.com) (`mimo`). Adding a fifth is a config change, not a code change — see [Architecture](#architecture).

## Status

**Working alpha.** All 8 planned phases (0–7) are implemented and were validated with real, live CLI calls during development — not fixtures or mocks. It is not yet production-hardened: there's no single `contreex` CLI entrypoint yet (usage today is via the library modules and the demo scripts under `scripts/`), and a handful of known gaps are tracked in [Known limitations](#known-limitations).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design, the empirical findings behind key decisions, and a phase-by-phase log of what was built and how it was proven to work.

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

There is no packaged `contreex` binary yet. Today, driving a pipeline looks like this:

```js
import { resolveConfig } from './src/config/load.mjs';
import { resolveRoles } from './src/agents/registry.mjs';
import { runOrchestrator } from './src/orchestrator.mjs';

const resolved = resolveConfig(process.cwd()); // throws if no .contreex-profile is found
const roles = resolveRoles(resolved.config.roles);

const { doc, documentValid } = await runOrchestrator({
  projectDir: process.cwd(),
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
  agent-manager.mjs          retry classification, agent state machine, cache integration
  orchestrator.mjs           pipeline DSL executor (sequential + parallel steps)
  cache.mjs                  content-addressable response cache
  mcp-gateway.mjs            workspace-scoped MCP server config generation (not a protocol reimplementation)
  compress.mjs               RTK-style diff summarization with on-demand expansion
  aep/                       normalize (raw CLI text -> JSON) + validate (Ajv) + combined pipeline
  agents/                    one plugin per CLI (claude, codex, agy, mimo) + a name->plugin registry
  config/load.mjs            cascading config loader (Global -> Workspace -> Project)
  memory/                    decision memory: record runs, similarity search, per-agent stats
probe/                       Phase 0 capability probe — the empirical groundwork everything else is based on
reports/phase0-capabilities.json   raw findings from that probe
scripts/                    unit tests + one runnable demo per phase (2 through 7)
```

## Architecture

Full detail, including *why* each decision was made and the real CLI quirks discovered along the way, is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Short version:

- **Roles, not vendors.** The orchestrator only ever sees role names (`implementer`, `reviewer1`, ...); `src/agents/registry.mjs` is the only place that knows Claude/Codex/Antigravity/MimoCode exist.
- **AEP v1** — one versioned JSON Schema (`schema/aep.v1.schema.json`), not a fragmented family of sub-protocols. Sections are effectively immutable: a reviewer only ever writes to its own `reviews.<role>` key.
- **Worktree isolation is the real safety guarantee**, not per-CLI permission flags. Testing showed at least two of the four CLIs (Antigravity, MimoCode) have no flag that reliably blocks writes — so every agent, implementer or reviewer, runs in its own disposable `git worktree`, and only the implementer's worktree is ever meant to be merged.
- **Config cascade with mandatory explicit profile selection** — a personal project can never silently inherit a corporate workspace's MCP servers or credentials.
- **Memory of decisions, not conversation** — a lightweight, token-overlap similarity search over past runs, plus per-agent verdict/finding stats, both file-backed under `~/.contreex/`.

### Why Node-only

Python is effectively unavailable in the primary target environment (a corporate workstation), so every piece of this project — including the Phase 0 capability probe — is plain Node.js with a minimal dependency set (`ajv`, `ajv-formats`, `yaml`).

## Development

```sh
npm test                       # 9 unit tests over the AEP schema/normalizer/validator
node scripts/demo-phase2.mjs   # real Claude Code call, native --json-schema + our Validator agreeing
node scripts/demo-phase3.mjs   # Agent Manager + worktree isolation stress test
node scripts/demo-phase4.mjs   # full pipeline: analyze -> parallel review -> refine
node scripts/demo-phase5.mjs   # config cascade + pipeline driven entirely from YAML
node scripts/demo-phase6.mjs   # cache hit, MCP gateway filtering, diff compaction — with real numbers
node scripts/demo-phase7.mjs   # memory: similarity search + per-agent stats across two related tasks
```

Each demo script talks to real, installed CLIs and will incur whatever API cost those CLIs normally incur — they are not free to run repeatedly.

## Known limitations

- No packaged CLI entrypoint yet (`bin/contreex.mjs` or similar) — see [Usage](#usage).
- `Agent.cancel()` is a stub on every plugin; `exec()` doesn't currently expose the underlying child process handle, so there's no real mid-flight abort yet.
- The plugin interface (`execute/cancel/health/capabilities/version`) works for four real CLIs but has no formal contract/test suite of its own yet.
- The pipeline DSL is a plain JS array today; there's no formal YAML schema or validator for it (unlike AEP, which has one).
- Credential storage per workspace is unaddressed — `~/.contreex/workspaces/*.yaml` currently only lists *which* MCP servers/roles are allowed, not how their secrets are kept safe across Linux/WSL/Windows.
- `AgentManager`'s retry classification (retriable vs. terminal failure) is regex-heuristic over stderr text, built before any real quota/auth failures were observed in practice — expect to revise it once real ones happen.
- Retry/cache/worktree code has been exercised through the demo scripts, not a dedicated test suite — `npm test` only covers the AEP schema layer.

## License

Not yet chosen.
