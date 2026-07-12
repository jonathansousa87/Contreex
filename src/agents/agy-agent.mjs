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
    return { headless: true, nativeJsonSchema: false, structuredOutput: false, sandboxed: false };
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
