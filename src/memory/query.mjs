// Similarity search over past runs — deliberately simple (token overlap, no
// embeddings/vector DB) since it only needs to be good enough to say "this
// looks like that palindrome-helper task from last week," not power a search
// engine. Revisit with real embeddings only if this proves too coarse in practice.

import { readAllRuns } from './store.mjs';

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

export function findSimilarRuns(objective, { limit = 3, minScore = 0.25 } = {}) {
  return readAllRuns()
    .map((run) => ({ run, score: overlapScore(objective, run.objective ?? '') }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ ...x.run, similarity: Math.round(x.score * 100) / 100 }));
}
