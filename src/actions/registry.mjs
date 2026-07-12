// Maps pipeline action names to their implementation. Mirrors
// src/agents/registry.mjs's pattern exactly: this is the only file that
// knows all currently-defined actions exist — orchestrator.mjs just asks for
// an action by name and executes whatever it gets back. Adding a new action
// (securityReview, documentationReview, consensus, ...) means adding one
// file here, never touching orchestrator.mjs.

import { analyzeAction } from './analyze.mjs';
import { reviewAction } from './review.mjs';
import { refineAction } from './refine.mjs';
import { consensusAction } from './consensus.mjs';

export const ACTION_REGISTRY = {
  analyze: analyzeAction,
  review: reviewAction,
  refine: refineAction,
  consensus: consensusAction,
};

export function resolveAction(name) {
  const action = ACTION_REGISTRY[name];
  if (!action) throw new Error(`Unknown pipeline action '${name}'. Known: ${Object.keys(ACTION_REGISTRY).join(', ')}`);
  return action;
}
