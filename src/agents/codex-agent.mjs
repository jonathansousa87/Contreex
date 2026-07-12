// Codex CLI plugin — implements the Agent interface. role: 'implementer' gets
// --sandbox workspace-write; role: 'reviewer' gets --sandbox read-only, which
// Phase 0 confirmed actually blocks writes (unlike agy's --mode plan). Worktree
// isolation still applies regardless — this is defense in depth, not a
// substitute for it.

import { exec } from '../exec.mjs';

export const codexAgent = {
  name: 'codex',

  async version() {
    const r = await exec('codex', ['--version'], { timeout: 15_000 });
    return r.ok ? r.stdout.trim() : null;
  },

  async health() {
    return (await this.version()) !== null;
  },

  capabilities() {
    return { headless: true, nativeJsonSchema: true, structuredOutput: true, sandboxed: true };
  },

  /**
   * @param {object} task
   * @param {string} task.prompt
   * @param {string} task.cwd - worktree path
   * @param {'implementer'|'reviewer'} [task.role]
   * @param {object} [task.outputSchema] - passed to --output-schema as a temp file path by the caller if needed (not wired yet — see note below)
   * @param {number} [task.timeout]
   */
  async execute({ prompt, cwd, role = 'reviewer', timeout = 60_000 }) {
    const sandbox = role === 'implementer' ? 'workspace-write' : 'read-only';
    const args = ['exec', prompt, '--json', '--sandbox', sandbox, '--skip-git-repo-check', '-C', cwd];

    const r = await exec('codex', args, { cwd, timeout });
    if (!r.ok) {
      return { ok: false, raw: null, error: r.timedOut ? 'timeout' : (r.stderr || `exit ${r.code}`), rawResult: r };
    }

    const raw = extractLastAgentMessage(r.stdout);
    if (raw === null) {
      return { ok: false, raw: null, error: 'no agent_message event found in codex --json stream', rawResult: r };
    }

    return { ok: true, raw, meta: { ms: r.ms, tokens: extractTokenUsage(r.stdout) }, rawResult: r };
  },

  cancel() {},
};

// codex exec --json emits JSONL events; the model's final reply is the last
// {"type":"item.completed","item":{"type":"agent_message","text":...}} event.
// Confirmed against codex-cli 0.144.1 in Phase 0.
function extractLastAgentMessage(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const evt = JSON.parse(lines[i]);
      if (evt.item?.type === 'agent_message' && typeof evt.item.text === 'string') return evt.item.text;
    } catch {
      // not a parseable line, keep scanning backward
    }
  }
  return null;
}

// The last {"type":"turn.completed","usage":{...}} event carries real token
// counts for the whole turn — confirmed shape against codex-cli 0.144.1.
function extractTokenUsage(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const evt = JSON.parse(lines[i]);
      if (evt.type === 'turn.completed' && evt.usage) {
        return {
          input: evt.usage.input_tokens ?? null,
          output: evt.usage.output_tokens ?? null,
          cacheRead: evt.usage.cached_input_tokens ?? null,
          reasoning: evt.usage.reasoning_output_tokens ?? null,
        };
      }
    } catch {
      // keep scanning backward
    }
  }
  return null;
}
