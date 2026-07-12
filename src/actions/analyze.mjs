// The "analyze" pipeline action — implementer produces analysis + plan in
// one call. Lives on its own so adding a new action never means editing
// orchestrator.mjs (see src/actions/registry.mjs).

import { aepSchema } from '../aep/schema.mjs';

// Self-contained (no internal $ref) — safe to hand to a plugin's native
// structured-output flag. See registry.mjs for why "refinement" doesn't get
// the same treatment.
const ANALYZE_SCHEMA = {
  type: 'object',
  required: ['analysis', 'plan'],
  additionalProperties: false,
  properties: { analysis: aepSchema.$defs.analysis, plan: aepSchema.$defs.plan },
};

function normalizeFallback(raw) {
  // analyze's combined shape isn't one of the single named $defs, so reuse
  // the same fence-stripping the section validators use internally.
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : raw).trim();
}

export const analyzeAction = {
  role: 'implementer',
  baseInstruction: (doc) =>
    `You are the implementer. Objective: ${doc.request.objective}\nReply with ONLY a JSON object (no prose, no markdown fences) with two keys: "analysis" (problem/rootCause/risks/assumptions/confidence) and "plan" (steps: array of {id, description}).`,
  jsonSchema: ANALYZE_SCHEMA,
  validate: (raw) => {
    // analyze produces one combined object; validate the whole thing against
    // the ad-hoc combined shape instead of two separate section calls.
    let data;
    try {
      data = JSON.parse(normalizeFallback(raw));
    } catch {
      return { valid: false, errors: [{ path: '(root)', message: 'not parseable JSON' }], data: null };
    }
    const planOk = data?.plan?.steps?.length > 0;
    const analysisOk = typeof data?.analysis?.problem === 'string';
    return { valid: planOk && analysisOk, errors: planOk && analysisOk ? [] : [{ path: '(root)', message: 'missing analysis.problem or plan.steps' }], data };
  },
  merge: (doc, data) => {
    doc.analysis = data.analysis;
    doc.plan = data.plan;
  },
};
