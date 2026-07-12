// The "refine" pipeline action — implementer reads reviewer feedback
// (supplied by the Context Engine, not this file) and decides what to
// accept or reject. No jsonSchema: `refinement.updatedPlan` uses an internal
// $ref that Claude Code's native --json-schema flag can't resolve (confirmed
// Phase 2) — validated only through our own Ajv Validator, which does
// resolve $id/$ref correctly.

export const refineAction = {
  role: 'implementer',
  baseInstruction: () =>
    `You are the implementer. Decide what to accept or reject from the reviewer feedback below. Reply with ONLY a JSON object (no prose, no markdown fences) with "acceptedChanges" (array of strings) and "rejectedChanges" (array of {suggestion, reason}).`,
  defName: 'refinement',
  merge: (doc, data) => {
    doc.refinement = data;
  },
};
