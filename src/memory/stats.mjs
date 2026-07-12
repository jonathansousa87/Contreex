// Aggregate per-agent signal across recorded runs — the "Codex tends to catch
// concurrency issues" idea from the original design, generalized to whatever
// pattern the data actually shows rather than a hardcoded rule. v1 just
// computes and exposes the numbers; using them to auto-adjust pipeline
// ordering/weight is a later step, once there's enough real history to trust.

import { readAllRuns } from './store.mjs';

export function agentStats() {
  const stats = {};
  for (const run of readAllRuns()) {
    for (const review of Object.values(run.reviews ?? {})) {
      const agent = review.agent ?? 'unknown';
      stats[agent] ??= { reviews: 0, verdicts: { APPROVE: 0, CHANGES_NEEDED: 0, BLOCKED: 0 }, totalFindings: 0 };
      stats[agent].reviews++;
      if (review.verdict) stats[agent].verdicts[review.verdict] = (stats[agent].verdicts[review.verdict] ?? 0) + 1;
      stats[agent].totalFindings += review.findingsCount ?? 0;
    }
  }
  return stats;
}
