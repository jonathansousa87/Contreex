// Consensus strategies — given the AEP document's `reviews`, compute an
// aggregate verdict. Decoupled from the "refine" action: refine still does
// its own LLM-based synthesis regardless of what runs here. This is an
// additional, optional, deterministic gate a pipeline can insert before
// refine — pure computation, no agent call, no LLM cost.

import { agentStats } from './memory/stats.mjs';

function tally(doc) {
  const verdicts = Object.values(doc.reviews ?? {}).map((r) => r.verdict);
  return {
    total: verdicts.length,
    approve: verdicts.filter((v) => v === 'APPROVE').length,
    changesNeeded: verdicts.filter((v) => v === 'CHANGES_NEEDED').length,
    blocked: verdicts.filter((v) => v === 'BLOCKED').length,
  };
}

export const strategies = {
  unanimity(doc) {
    const t = tally(doc);
    if (t.total === 0) return { verdict: 'CHANGES_NEEDED', rationale: 'no reviews to reach consensus over' };
    if (t.blocked > 0) return { verdict: 'BLOCKED', rationale: `${t.blocked}/${t.total} reviewer(s) blocked` };
    if (t.approve === t.total) return { verdict: 'APPROVE', rationale: `${t.approve}/${t.total} reviewers approved unanimously` };
    return { verdict: 'CHANGES_NEEDED', rationale: `${t.approve}/${t.total} approved — unanimity required` };
  },

  majority(doc) {
    const t = tally(doc);
    if (t.total === 0) return { verdict: 'CHANGES_NEEDED', rationale: 'no reviews to reach consensus over' };
    if (t.blocked > t.total / 2) return { verdict: 'BLOCKED', rationale: `${t.blocked}/${t.total} reviewer(s) blocked` };
    if (t.approve > t.total / 2) return { verdict: 'APPROVE', rationale: `${t.approve}/${t.total} reviewers approved (majority)` };
    return { verdict: 'CHANGES_NEEDED', rationale: `${t.approve}/${t.total} approved — majority not reached` };
  },

  // No independent computation — exists so a pipeline can name this strategy
  // explicitly rather than silently having no consensus step. The real
  // decision still happens in the "refine" action's own LLM judgement.
  implementerDecides() {
    return { verdict: null, rationale: 'deferred to implementer refinement — no independent consensus computed' };
  },

  // Weights each reviewer's vote by its historical approve rate from
  // Decision Memory (agentStats()) instead of counting every reviewer
  // equally. An agent with no history yet gets neutral weight (1).
  weighted(doc) {
    const stats = agentStats();
    const reviews = Object.entries(doc.reviews ?? {});
    if (!reviews.length) return { verdict: 'CHANGES_NEEDED', rationale: 'no reviews to reach consensus over' };
    let approveWeight = 0;
    let totalWeight = 0;
    for (const [role, review] of reviews) {
      const agentName = review.agent ?? role;
      const s = stats[agentName];
      const weight = s && s.reviews > 0 ? Math.max(0.1, s.verdicts.APPROVE / s.reviews) : 1;
      totalWeight += weight;
      if (review.verdict === 'APPROVE') approveWeight += weight;
    }
    const ratio = totalWeight > 0 ? approveWeight / totalWeight : 0;
    return ratio > 0.5
      ? { verdict: 'APPROVE', rationale: `weighted approval ratio ${ratio.toFixed(2)} (weights from historical reliability)` }
      : { verdict: 'CHANGES_NEEDED', rationale: `weighted approval ratio ${ratio.toFixed(2)} below 0.5` };
  },

  // Not a new rule — a workspace names which underlying strategy "corporate
  // policy" maps to via config (default: unanimity, the strictest option).
  corporatePolicy(doc, { policy = 'unanimity' } = {}) {
    const impl = strategies[policy];
    return impl ? impl(doc) : strategies.unanimity(doc);
  },
};

export function decide(doc, strategyName = 'unanimity', opts = {}) {
  const strategy = strategies[strategyName];
  if (!strategy) throw new Error(`Unknown consensus strategy '${strategyName}'. Known: ${Object.keys(strategies).join(', ')}`);
  return { strategy: strategyName, ...strategy(doc, opts) };
}
