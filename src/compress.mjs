// RTK-inspired context compaction: give an agent a compact summary first
// (files changed + insertion/deletion counts), expand to the full diff for
// one file only on demand. A 5000-line diff dumped straight into a reviewer
// prompt burns tokens the reviewer usually doesn't need in full.

import { exec } from './exec.mjs';

function parseNumstat(stdout) {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [ins, del, path] = line.split('\t');
      return { path, insertions: ins === '-' ? null : Number(ins), deletions: del === '-' ? null : Number(del) };
    });
}

export async function summarizeDiff(cwd, { staged = false } = {}) {
  const args = ['-C', cwd, 'diff', ...(staged ? ['--staged'] : []), '--numstat'];
  const r = await exec('git', args, { timeout: 15_000 });
  if (!r.ok) throw new Error(`git diff --numstat failed: ${r.stderr.trim()}`);
  const files = parseNumstat(r.stdout);
  const totals = files.reduce(
    (acc, f) => ({ insertions: acc.insertions + (f.insertions || 0), deletions: acc.deletions + (f.deletions || 0) }),
    { insertions: 0, deletions: 0 },
  );
  return { files, totalFiles: files.length, ...totals };
}

export async function expandDiff(cwd, filePath, { staged = false } = {}) {
  const args = ['-C', cwd, 'diff', ...(staged ? ['--staged'] : []), '--', filePath];
  const r = await exec('git', args, { timeout: 15_000 });
  if (!r.ok) throw new Error(`git diff failed: ${r.stderr.trim()}`);
  return r.stdout;
}
