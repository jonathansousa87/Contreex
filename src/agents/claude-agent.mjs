// Claude Code plugin — implements the Agent interface (execute/cancel/health/
// capabilities/version). role: 'implementer' gets bypassPermissions (needs to
// write); role: 'reviewer' gets dontAsk (deny-by-default, confirmed in Phase 0
// to be the only headless-safe mode that actually blocks unapproved tools).

import { exec } from '../exec.mjs';

export const claudeAgent = {
  name: 'claude',

  async version() {
    const r = await exec('claude', ['--version'], { timeout: 15_000 });
    return r.ok ? r.stdout.trim() : null;
  },

  async health() {
    return (await this.version()) !== null;
  },

  // Expanded contract (ROADMAP.md item 12): every field here is verified
  // against real --help output or Phase 0 empirical testing, never guessed.
  // `null` means genuinely not verified — not "false".
  capabilities() {
    return {
      headless: true,
      nativeJsonSchema: true,
      structuredOutput: true,
      sandboxed: false,
      supportsJson: true, // --json-schema, --output-format json
      supportsMcp: true, // --mcp-config (verified in --help)
      // No dedicated CLI flag (unlike Codex's -i/--image), so this stays null —
      // but verified live (2026-07-12): referencing an absolute image path in
      // the prompt text works via the Read tool, which reads images natively.
      // See src/context-engine.mjs's 'analyze' branch / src/clipboard.mjs.
      supportsImages: null,
      supportsToolCalling: true, // Read/Write/Bash tools are core to Claude Code
      supportsStreaming: true, // --output-format stream-json (verified in --help)
      supportsPatch: null, // not verified
      supportsReadOnly: true, // --permission-mode dontAsk (verified Phase 0)
      supportsSandbox: false, // no OS-level sandbox flag found
    };
  },

  /**
   * @param {object} task
   * @param {string} task.prompt
   * @param {string} task.cwd - worktree path (never the real project root)
   * @param {'implementer'|'reviewer'} [task.role]
   * @param {object} [task.jsonSchema] - self-contained JSON Schema (no external $ref)
   * @param {number} [task.timeout]
   */
  async execute({ prompt, cwd, role = 'reviewer', jsonSchema, timeout = 60_000 }) {
    const permissionMode = role === 'implementer' ? 'bypassPermissions' : 'dontAsk';
    const args = ['-p', prompt, '--permission-mode', permissionMode, '--output-format', 'json'];
    if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema));

    const r = await exec('claude', args, { cwd, timeout });
    if (!r.ok) {
      return { ok: false, raw: null, error: r.timedOut ? 'timeout' : (r.stderr || `exit ${r.code}`), rawResult: r };
    }

    let outer;
    try {
      outer = JSON.parse(r.stdout);
    } catch (e) {
      return { ok: false, raw: r.stdout, error: `--output-format json did not produce parseable JSON: ${e.message}`, rawResult: r };
    }

    return {
      ok: true,
      raw: outer.result,
      meta: {
        ms: r.ms,
        costUsd: outer.total_cost_usd ?? null,
        sessionId: outer.session_id ?? null,
        tokens: outer.usage
          ? {
              input: outer.usage.input_tokens ?? null,
              output: outer.usage.output_tokens ?? null,
              cacheRead: outer.usage.cache_read_input_tokens ?? null,
              cacheCreate: outer.usage.cache_creation_input_tokens ?? null,
            }
          : null,
      },
      rawResult: r,
    };
  },

  cancel() {
    // Not implemented at this layer — exec() does not currently expose the
    // child handle to callers. Revisit once the Agent Manager needs mid-flight
    // cancellation (e.g. a user-triggered abort).
  },
};
