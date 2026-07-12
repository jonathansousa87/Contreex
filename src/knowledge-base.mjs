// Knowledge Base — curated, permanent knowledge, distinct from Decision
// Memory (src/memory/): Decision Memory is per-run statistics ("this run's
// verdict was X"); the Knowledge Base is durable lessons that stay true
// across many runs ("Codex tends to miss async concurrency bugs"). Entries
// don't expire and aren't tied to any single objective.
//
// Promotion mechanism (deliberately simple for v1, per ROADMAP.md item 9):
// entries are added explicitly via addEntry() — there is no fully-automatic
// promotion from Decision Memory yet. suggestPromotions() below is a
// half-measure: it surfaces *candidates* (recurring finding themes across
// past runs) for a human to confirm via addEntry(), not an autonomous
// promotion pipeline. Fully automatic clustering/detection is real scope,
// not built here.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readAllRuns } from './memory/store.mjs';

const KB_DIR = join(homedir(), '.contreex');
const KB_FILE = join(KB_DIR, 'knowledge-base.jsonl');

export function addEntry({ text, tags = [] }) {
  if (!text || !text.trim()) throw new Error('Knowledge Base entry needs non-empty text');
  mkdirSync(KB_DIR, { recursive: true });
  const entry = { id: randomUUID(), text: text.trim(), tags, addedAt: new Date().toISOString() };
  appendFileSync(KB_FILE, JSON.stringify(entry) + '\n');
  return entry;
}

export function listEntries() {
  if (!existsSync(KB_FILE)) return [];
  return readFileSync(KB_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function tokenize(text) {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []));
}

function overlapScore(a, b) {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0) return 0;
  let common = 0;
  for (const t of setA) if (setB.has(t)) common++;
  return common / setA.size;
}

/**
 * Same token-overlap approach as memory/query.mjs's findSimilarRuns —
 * consistent, not a new technique — but a lower default threshold: KB
 * entries are prose lessons, not task objectives, so they naturally share
 * fewer exact tokens with a short query. Verified with a real case: "Add
 * isPalindrome(str) to utils.js" against a real prose lesson mentioning
 * "isPalindrome" scored 0.167 (1 shared token / 6 query tokens) — findSimilarRuns's
 * 0.25 threshold (tuned for objective-to-objective matches, which share far
 * more tokens) would have missed it; 0.15 catches it without an empty result.
 */
export function queryKnowledgeBase(text, { limit = 3, minScore = 0.15 } = {}) {
  return listEntries()
    .map((entry) => ({ entry, score: overlapScore(text, `${entry.text} ${entry.tags.join(' ')}`) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.entry.text);
}

/**
 * Surfaces candidate lessons from Decision Memory: findings whose summary
 * text recurs across multiple past runs, grouped loosely by shared keywords.
 * Returns suggestions only — nothing is added to the Knowledge Base
 * automatically. A human reviews and calls addEntry() for the ones worth
 * keeping permanently.
 */
export function suggestPromotions({ minOccurrences = 2 } = {}) {
  const runs = readAllRuns();
  const seen = new Map(); // normalized finding summary -> { count, agents: Set }
  for (const run of runs) {
    for (const review of Object.values(run.reviews ?? {})) {
      // Decision Memory only stores findingsCount today, not the finding
      // text itself — this can only count recurrence, not summarize theme,
      // until memory/store.mjs is extended to keep finding summaries too.
      if ((review.findingsCount ?? 0) > 0) {
        const key = review.agent ?? 'unknown';
        const existing = seen.get(key) ?? { count: 0 };
        existing.count += 1;
        seen.set(key, existing);
      }
    }
  }
  return [...seen.entries()]
    .filter(([, v]) => v.count >= minOccurrences)
    .map(([agent, v]) => `${agent} raised findings in ${v.count} of ${runs.length} recorded runs — worth a Knowledge Base entry once the pattern is understood, e.g. "codex tends to flag X"`);
}
