// Content-addressable cache for agent responses. Keyed on {agent, role, prompt,
// jsonSchema} — deliberately NOT on the worktree cwd path (which is a random
// mkdtemp name with no meaning of its own). This assumes the prompt fully
// encodes the relevant context, which holds for Contreex's current actions
// (analyze/review/refine all embed plan/review JSON directly in the prompt
// text) — revisit once an action depends on file contents the prompt doesn't
// already include.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CACHE_DIR = join(homedir(), '.contreex', 'cache');
const DEFAULT_TTL_MS = 15 * 60 * 1000; // long enough to dedupe a dev-loop rerun, short enough to not serve a stale review

function cacheKey(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function getCached(parts, ttlMs = DEFAULT_TTL_MS) {
  const file = join(CACHE_DIR, `${cacheKey(parts)}.json`);
  if (!existsSync(file)) return null;
  const entry = JSON.parse(readFileSync(file, 'utf8'));
  if (Date.now() - entry.cachedAt > ttlMs) return null;
  return entry.value;
}

export function setCached(parts, value) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `${cacheKey(parts)}.json`), JSON.stringify({ cachedAt: Date.now(), value }, null, 2));
}
