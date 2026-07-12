// Antigravity CLI plugin — implements the Agent interface. No native structured
// output support (confirmed Phase 0), so the Normalizer does all the work here.
// role: 'reviewer' uses --mode plan — Phase 0 confirmed this does NOT reliably
// block writes, so this plugin leans entirely on worktree isolation (src/worktree.mjs)
// as the real safety guarantee, not on this flag.

import { exec } from '../exec.mjs';

export const agyAgent = {
  name: 'agy',

  async version() {
    const r = await exec('agy', ['--version'], { timeout: 15_000 });
    return r.ok ? r.stdout.trim() : null;
  },

  async health() {
    return (await this.version()) !== null;
  },

  capabilities() {
    return {
      headless: true,
      nativeJsonSchema: false,
      structuredOutput: false,
      sandboxed: false,
      writeBlockConfirmed: false, // --mode plan does NOT reliably block writes (Phase 0 finding)
      supportsJson: false, // no native structured output (verified Phase 0)
      supportsMcp: false, // no "mcp" subcommand/flag found in --help
      supportsImages: null, // not verified
      supportsToolCalling: true, // has Bash/file tools internally
      supportsStreaming: null, // not verified
      supportsPatch: null, // not verified
      supportsReadOnly: false, // --mode plan does not block writes (verified Phase 0)
      supportsSandbox: true, // top-level --sandbox flag ("terminal restrictions")
    };
  },

  async execute({ prompt, cwd, role = 'reviewer', timeout = 60_000 }) {
    const args = ['-p', prompt, '--add-dir', cwd, '--print-timeout', `${Math.ceil(timeout / 1000)}s`];
    if (role === 'implementer') args.push('--dangerously-skip-permissions');
    else args.push('--mode', 'plan');

    const r = await exec('agy', args, { cwd, timeout: timeout + 10_000 });
    if (!r.ok) {
      return { ok: false, raw: null, error: r.timedOut ? 'timeout' : (r.stderr || `exit ${r.code}`), rawResult: r };
    }

    return { ok: true, raw: r.stdout, meta: { ms: r.ms }, rawResult: r };
  },

  cancel() {},
};
