import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 90_000;

// Shared headless-invocation primitive for every agent CLI. Uses spawn (not
// execFile) so stdin can be closed immediately — Codex (and possibly others)
// read additional prompt content from stdin and hang forever waiting for EOF
// if it's left open. Confirmed in Phase 0; this is now a standing rule for
// any future Agent Manager code, not a one-off probe workaround.
export function exec(cmd, args, { cwd, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        code,
        signal,
        stdout,
        stderr,
        ms: Date.now() - started,
        timedOut,
      });
    });
  });
}
