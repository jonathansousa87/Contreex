// The "review" pipeline action — a reviewer produces its own `review`
// section. Runs once per reviewer role, typically inside a `parallel` block.

import { aepSchema } from '../aep/schema.mjs';

const REVIEW_SCHEMA = { type: 'object', ...aepSchema.$defs.review };

export const reviewAction = {
  role: 'reviewer',
  baseInstruction: (doc) =>
    `You are a reviewer. Objective: ${doc.request.objective}\nReply with ONLY a JSON object (no prose, no markdown fences) with "verdict" (exactly one of: "APPROVE", "CHANGES_NEEDED", "BLOCKED") and "findings" (array of {severity, summary}, where severity is exactly one of: "low", "medium", "high", "critical" — no other words).`,
  jsonSchema: REVIEW_SCHEMA,
  defName: 'review',
  merge: (doc, data, roleName) => {
    doc.reviews[roleName] = data;
  },
};
