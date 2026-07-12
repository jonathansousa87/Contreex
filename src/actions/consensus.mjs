// The "consensus" pipeline action — pure computation over doc.reviews, no
// agent call, no LLM cost. `local: true` tells orchestrator.mjs to skip the
// AgentManager entirely for this step (see runStep in orchestrator.mjs).

import { decide } from '../consensus.mjs';

export const consensusAction = {
  local: true,
  compute: (doc, step) => decide(doc, step.strategy, step.strategyOptions),
  merge: (doc, data) => {
    doc.consensus = data;
  },
};
