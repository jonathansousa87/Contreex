// The "implement" pipeline action — the only action that writes real files.
// Not reachable from natural-language intent classification (see
// src/intent-analyzer.mjs — "implement" intent maps to the "critical" review
// preset, never to this action); it only runs when a pipeline explicitly
// includes it, which today only happens via the "implement" pipeline profile
// selected with the CLI's `--implement` flag. This was an explicit
// constraint from the user: real implementation must fire on an explicit
// command, never be inferred.
//
// The implementer writes in its own worktree (src/worktree.mjs), never the
// real project — merging that worktree's branch into the real one is a
// separate, manual step the user does themselves (see the report's
// "Próximos passos" section). Never cached: a real side effect must happen
// every time it's asked for, not be served from a stale prior result.

import { aepSchema } from '../aep/schema.mjs';

const IMPLEMENTATION_SCHEMA = { type: 'object', ...aepSchema.$defs.implementation };

export const implementAction = {
  role: 'implementer',
  cache: false,
  timeout: 120_000, // real file writes + self-verification take longer than a JSON-only turn
  baseInstruction: (doc) =>
    `You are the implementer. Based on the plan and any refinement above, actually implement the change now: create or edit the necessary files in the current directory to make it real. Do not ask for confirmation. After making the changes, reply with ONLY a JSON object (no prose, no markdown fences) with "status" (one of "completed", "partial", "failed"), "filesChanged" (array of {path, diffSummary — a one-line description of what changed in that file}), and "commands" (array of any shell commands you ran, e.g. to verify the change).`,
  jsonSchema: IMPLEMENTATION_SCHEMA,
  defName: 'implementation',
  merge: (doc, data) => {
    doc.implementation = data;
  },
};
