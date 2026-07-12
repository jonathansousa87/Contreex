// MimoCode CLI (Xiaomi) plugin — implements the Agent interface. `mimo run
// --format json` emits JSONL events; the model's final reply is the last
// {"type":"text","part":{"type":"text","text":...}} event.
//
// Permission control: tested both --dangerously-skip-permissions and the
// default (no flag) in headless `mimo run` — both wrote the probe file. No
// working deny-by-default mechanism found (same posture as agy). This plugin
// still branches by role for interface consistency and least-privilege intent,
// but — like agy — leans entirely on git worktree isolation (src/worktree.mjs)
// as the actual safety guarantee, not on any mimo flag.

import { exec } from '../exec.mjs';

export const mimoAgent = {
  name: 'mimo',

  async version() {
    const r = await exec('mimo', ['--version'], { timeout: 15_000 });
    return r.ok ? r.stdout.trim() : null;
  },

  async health() {
    return (await this.version()) !== null;
  },

  capabilities() {
    return { headless: true, nativeJsonSchema: false, structuredOutput: false, sandboxed: false, writeBlockConfirmed: false };
  },

  async execute({ prompt, cwd, role = 'reviewer', timeout = 60_000 }) {
    const args = ['run', prompt, '--format', 'json'];
    if (role === 'implementer') args.push('--dangerously-skip-permissions');

    const r = await exec('mimo', args, { cwd, timeout });
    if (!r.ok) {
      return { ok: false, raw: null, error: r.timedOut ? 'timeout' : (r.stderr || `exit ${r.code}`), rawResult: r };
    }

    const raw = extractLastText(r.stdout);
    if (raw === null) {
      return { ok: false, raw: null, error: 'no text event found in mimo --format json stream', rawResult: r };
    }

    return { ok: true, raw, meta: { ms: r.ms }, rawResult: r };
  },

  cancel() {},
};

function extractLastText(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const evt = JSON.parse(lines[i]);
      if (evt.type === 'text' && evt.part?.type === 'text' && typeof evt.part.text === 'string') return evt.part.text;
    } catch {
      // not a parseable line, keep scanning backward
    }
  }
  return null;
}
