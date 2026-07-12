// Context compaction: give an agent a compact summary first (files changed +
// insertion/deletion counts), expand to the full diff for one file only on
// demand. A 5000-line diff dumped straight into a reviewer prompt burns
// tokens the reviewer usually doesn't need in full.
//
// CORRECTION (2026-07-12): the previous version of this file called itself
// "RTK-inspired" without the author ever having actually looked at the real
// RTK project (github.com/rtk-ai/rtk) the user named as inspiration in the
// very first message of this whole project — that was a mistake, caught by
// the user, not verified by the author first.
//
// Fixed properly, and re-verified twice after an initial re-check was ALSO
// wrong (source-reading alone was not enough — see below):
//   - RTK's real `git diff` wrapper (src/cmds/git/git.rs, compact_diff) caps
//     each hunk at 100 shown +/- lines and truncates the rest with
//     "... (N lines truncated)" by default. Tested directly against a real
//     100-line change in this repo: RTK's binary silently dropped every
//     single "+" (added) line once the 100-line cap was hit on the "-" side
//     — genuinely lossy above that threshold, not just "smaller." Only
//     recoverable via an explicit `rtk git diff --no-compact` the caller has
//     to know to ask for.
//   - For a small, realistic diff well under that cap, RTK's real output WAS
//     complete (every +/- and context line present) — savings there are
//     modest (~5%), mostly from replacing the `diff --git`/`index`/`---`/`+++`
//     header block with a one-line filename + stat summary.
// condenseDiff() below borrows the safe part of that technique (strip the
// header boilerplate) but deliberately does NOT reimplement RTK's hunk
// truncation — it never drops a single +/- line, at any diff size, trading
// some compaction ratio for the correctness guarantee this project actually
// needs (a reviewer must see every changed line, always). No external `rtk`
// binary dependency either way, by explicit preference — this project only
// borrows the technique, verified firsthand, not the binary.
//
// pxpipe (github.com/teamchong/pxpipe, the other reference from that same
// first message) was investigated properly this time too, including its own
// FINDINGS.md: it renders bulky context as PNGs for a vision-language model
// to read, and its own extensive internal research is unusually candid that
// this is fundamentally lossy in a specific, dangerous way — a VLM reading
// an image is not OCR, there's no confidence signal, so misreads are silent
// and confident rather than visibly garbled, and exact byte-level content
// (hashes, ids, paths) is exactly the content type that fails, while prose
// reads fine. Their own numbers show this is highly model-dependent (10%
// exact-match on one model, 13/15 on another, 0/15 on others) — every model
// needs its own extensive validation before it's safe. Contreex orchestrates
// four heterogeneous agent CLIs and the AEP protocol depends on JSON
// surviving byte-exact — the precise worst case for this technique. Not
// adopted; documented in detail in docs/ARCHITECTURE.md's token economy
// section.

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

/**
 * Strips unified-diff metadata and unchanged context lines, keeping only the
 * actual +/- changed lines. Same guarantee RTK's own code makes ("never
 * worse than the original"): falls back to the raw diff if condensing
 * somehow didn't shrink it (e.g. a near-empty diff where there's nothing to
 * strip).
 */
export function condenseDiff(rawDiff) {
  const kept = rawDiff
    .split('\n')
    .filter((line) => (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---')));
  const condensed = kept.join('\n');
  return condensed && condensed.length < rawDiff.length ? condensed : rawDiff;
}

export async function expandDiff(cwd, filePath, { staged = false } = {}) {
  const args = ['-C', cwd, 'diff', ...(staged ? ['--staged'] : []), '--', filePath];
  const r = await exec('git', args, { timeout: 15_000 });
  if (!r.ok) throw new Error(`git diff failed: ${r.stderr.trim()}`);
  return condenseDiff(r.stdout);
}
