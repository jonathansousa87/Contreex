// Orchestrator — walks a pipeline definition (plain JS array for now; YAML
// loading is a Phase 5 config-cascade concern, this executor is format-agnostic)
// and drives the AgentManager per step, accumulating one AEP document.
//
// Pipeline shape:
//   [
//     { role: 'implementer', action: 'analyze' },
//     { parallel: [{ role: 'reviewer1', action: 'review' }, { role: 'reviewer2', action: 'review' }] },
//     { role: 'implementer', action: 'refine' },
//   ]
//
// `roles` maps a pipeline role name to a concrete plugin, e.g.
//   { implementer: claudeAgent, reviewer1: codexAgent, reviewer2: agyAgent }

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AgentManager } from './agent-manager.mjs';
import { validateAepDocument } from './aep/validate.mjs';
import { parseAndValidateSection } from './aep/index.mjs';
import { findSimilarRuns } from './memory/query.mjs';
import { recordRun } from './memory/store.mjs';

const schema = JSON.parse(readFileSync(new URL('../schema/aep.v1.schema.json', import.meta.url), 'utf8'));

// Self-contained (no internal $ref) — safe to hand to a plugin's native
// structured-output flag. "refinement" is deliberately excluded: its
// updatedPlan field uses $ref internally, which Claude Code's --json-schema
// can't resolve (confirmed Phase 2) — it's only validated via our own Ajv
// Validator, which does resolve $id/$ref correctly.
const ANALYZE_SCHEMA = {
  type: 'object',
  required: ['analysis', 'plan'],
  additionalProperties: false,
  properties: { analysis: schema.$defs.analysis, plan: schema.$defs.plan },
};
const REVIEW_SCHEMA = { type: 'object', ...schema.$defs.review };

const ACTIONS = {
  analyze: {
    role: 'implementer',
    buildPrompt: (doc, { priorRuns = [] } = {}) => {
      const memoryNote = priorRuns.length
        ? `\nMemory — similar past tasks (for context only, use your own judgement): ${JSON.stringify(
            priorRuns.map((r) => ({
              objective: r.objective,
              accepted: r.refinement?.acceptedCount ?? 0,
              rejected: r.refinement?.rejectedCount ?? 0,
              reviewVerdicts: Object.values(r.reviews ?? {}).map((rv) => rv.verdict),
            })),
          )}\n`
        : '';
      return `You are the implementer. Objective: ${doc.request.objective}${memoryNote}\nReply with ONLY a JSON object (no prose, no markdown fences) with two keys: "analysis" (problem/rootCause/risks/assumptions/confidence) and "plan" (steps: array of {id, description}).`;
    },
    jsonSchema: ANALYZE_SCHEMA,
    validate: (raw) => {
      const analysis = parseAndValidateSection(raw, 'analysis');
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
  },
  review: {
    role: 'reviewer',
    buildPrompt: (doc) =>
      `You are a reviewer. Objective: ${doc.request.objective}\nPlan under review: ${JSON.stringify(doc.plan)}\nReply with ONLY a JSON object (no prose, no markdown fences) with "verdict" (exactly one of: "APPROVE", "CHANGES_NEEDED", "BLOCKED") and "findings" (array of {severity, summary}, where severity is exactly one of: "low", "medium", "high", "critical" — no other words).`,
    jsonSchema: REVIEW_SCHEMA,
    defName: 'review',
    merge: (doc, data, roleName) => {
      doc.reviews[roleName] = data;
    },
  },
  refine: {
    role: 'implementer',
    buildPrompt: (doc) =>
      `You are the implementer. Original plan: ${JSON.stringify(doc.plan)}\nReviewer feedback: ${JSON.stringify(doc.reviews)}\nDecide what to accept or reject. Reply with ONLY a JSON object (no prose, no markdown fences) with "acceptedChanges" (array of strings) and "rejectedChanges" (array of {suggestion, reason}).`,
    defName: 'refinement',
    merge: (doc, data) => {
      doc.refinement = data;
    },
  },
};

function normalizeFallback(raw) {
  // analyze's combined shape isn't one of the single named $defs, so reuse
  // the same fence-stripping the section validators use internally.
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : raw).trim();
}

export async function runOrchestrator({ projectDir, objective, pipeline, roles, manager = new AgentManager() }) {
  const doc = {
    protocol: { name: 'Agent Exchange Protocol', version: '1.0.0' },
    metadata: { requestId: randomUUID(), role: 'orchestrator', createdAt: new Date().toISOString() },
    request: { objective },
    reviews: {},
    logs: [],
  };

  const priorRuns = findSimilarRuns(objective);

  for (const step of pipeline) {
    if (step.parallel) {
      const outcomes = await Promise.all(step.parallel.map((s) => runStep(s, doc, roles, manager, projectDir, priorRuns)));
      for (const outcome of outcomes) applyOutcome(doc, outcome);
    } else {
      const outcome = await runStep(step, doc, roles, manager, projectDir, priorRuns);
      applyOutcome(doc, outcome);
    }
  }

  const documentValid = validateAepDocument(doc);
  // Memory is a side channel, not a pipeline dependency — a write failure here
  // must never surface as a failed run.
  try {
    recordRun(distillForMemory(doc, roles));
  } catch {
    // best-effort
  }

  return { doc, documentValid, priorRunsUsed: priorRuns };
}

function distillForMemory(doc, roles) {
  const reviews = {};
  for (const [roleName, review] of Object.entries(doc.reviews ?? {})) {
    reviews[roleName] = { agent: roles[roleName]?.name ?? roleName, verdict: review.verdict, findingsCount: review.findings?.length ?? 0 };
  }
  return {
    requestId: doc.metadata.requestId,
    createdAt: doc.metadata.createdAt,
    objective: doc.request.objective,
    reviews,
    refinement: doc.refinement
      ? { acceptedCount: doc.refinement.acceptedChanges?.length ?? 0, rejectedCount: doc.refinement.rejectedChanges?.length ?? 0 }
      : null,
  };
}

async function runStep(step, doc, roles, manager, projectDir, priorRuns = []) {
  const action = ACTIONS[step.action];
  if (!action) throw new Error(`Unknown pipeline action: ${step.action}`);
  const plugin = roles[step.role];
  if (!plugin) throw new Error(`No provider configured for role '${step.role}'`);

  const prompt = action.buildPrompt(doc, { priorRuns });
  const result = await manager.run(plugin, {
    projectDir,
    role: step.role,
    prompt,
    defName: action.defName,
    jsonSchema: action.jsonSchema,
    timeout: 60_000,
  });

  doc.logs.push({
    timestamp: new Date().toISOString(),
    level: result.ok ? 'info' : 'error',
    message: `${step.role} (${plugin.name}) ran action '${step.action}' — ${result.ok ? 'ok' : result.error || 'validation failed'}`,
    agent: plugin.name,
  });

  return { step, action, result };
}

function applyOutcome(doc, { step, action, result }) {
  if (!result.ok) return; // logged already; document simply lacks this section
  let data = result.data;
  if (action.validate) {
    const v = action.validate(result.raw);
    if (!v.valid) return;
    data = v.data;
  }
  action.merge(doc, data, step.role);
}
