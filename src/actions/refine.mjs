// The "refine" pipeline action — implementer reads reviewer feedback
// (supplied by the Context Engine, not this file) and decides what to
// accept or reject. No jsonSchema: `refinement.updatedPlan` uses an internal
// $ref that Claude Code's native --json-schema flag can't resolve (confirmed
// Phase 2) — validated only through our own Ajv Validator, which does
// resolve $id/$ref correctly.
//
// chiefEngineerOverride / overrideRationale (ROADMAP.md consensus-loop item,
// 2026-07-12): the user's explicit rule for the review<->refine loop is
// unanimity, but the implementer (Claude, "engenheiro-chefe") carries more
// weight than any single reviewer, because reviewers can push back over
// things that genuinely don't matter. This is how that weighting is
// expressed structurally: the implementer must actively declare an override
// (and justify it) to end a round early without full reviewer agreement —
// it's not a silent default, and it's fully auditable in the AEP document.

export const refineAction = {
  role: 'implementer',
  baseInstruction: () =>
    `You are the implementer, the chief engineer on this task. Decide what to accept or reject from the reviewer feedback below. If accepting feedback changes the plan's steps in a real way, also include "updatedPlan" (same shape as the original plan: {steps, filesToModify, tests, rollback}) reflecting the new plan — omit it if the plan didn't actually change. ` +
    `If reviewers have NOT unanimously approved but you judge their remaining pushback does not reflect a real problem, you may end the review loop early: set "chiefEngineerOverride" to true and fill "overrideRationale" with a specific, concrete justification (never a generic dismissal like "not important"). Leave "chiefEngineerOverride" false (or omit it) if you want another review round instead. ` +
    `Reply with ONLY a JSON object (no prose, no markdown fences) with "acceptedChanges" (array of strings), "rejectedChanges" (array of {suggestion, reason}), and optionally "updatedPlan", "chiefEngineerOverride", "overrideRationale".`,
  defName: 'refinement',
  merge: (doc, data) => {
    doc.refinement = data;
    if (data.updatedPlan) doc.plan = data.updatedPlan;
  },
};
