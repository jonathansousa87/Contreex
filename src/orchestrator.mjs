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
//
// Each ACTION only supplies a `baseInstruction` (what to ask) — deciding WHAT
// context goes with it is the ContextEngine's job, and turning that into one
// prompt string is language/prompt-builder.mjs's job (the same module the
// Language Engine uses). Neither of those two concerns lives here anymore.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AgentManager } from './agent-manager.mjs';
import { validateAepDocument } from './aep/validate.mjs';
import { parseAndValidateSection } from './aep/index.mjs';
import { recordRun } from './memory/store.mjs';
import { ContextEngine } from './context-engine.mjs';
import { buildPrompt } from './language/prompt-builder.mjs';

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
  },
  review: {
    role: 'reviewer',
    baseInstruction: (doc) =>
      `You are a reviewer. Objective: ${doc.request.objective}\nReply with ONLY a JSON object (no prose, no markdown fences) with "verdict" (exactly one of: "APPROVE", "CHANGES_NEEDED", "BLOCKED") and "findings" (array of {severity, summary}, where severity is exactly one of: "low", "medium", "high", "critical" — no other words).`,
    jsonSchema: REVIEW_SCHEMA,
    defName: 'review',
    merge: (doc, data, roleName) => {
      doc.reviews[roleName] = data;
    },
  },
  refine: {
    role: 'implementer',
    baseInstruction: () =>
      `You are the implementer. Decide what to accept or reject from the reviewer feedback below. Reply with ONLY a JSON object (no prose, no markdown fences) with "acceptedChanges" (array of strings) and "rejectedChanges" (array of {suggestion, reason}).`,
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

export async function runOrchestrator({ projectDir, objective, pipeline, roles, manager = new AgentManager(), language, contextEngine = new ContextEngine() }) {
  const doc = {
    protocol: { name: 'Agent Exchange Protocol', version: '1.0.0' },
    metadata: { requestId: randomUUID(), role: 'orchestrator', createdAt: new Date().toISOString() },
    // `objective` here is already internal-language (English) text — translation
    // happens one layer up, in the Language Engine, before this is ever called.
    // `language` just records provenance so the AEP document is self-describing.
    request: language ? { objective, language } : { objective },
    reviews: {},
    logs: [],
  };

  for (const step of pipeline) {
    if (step.parallel) {
      const outcomes = await Promise.all(step.parallel.map((s) => runStep(s, doc, roles, manager, projectDir, contextEngine)));
      for (const outcome of outcomes) applyOutcome(doc, outcome);
    } else {
      const outcome = await runStep(step, doc, roles, manager, projectDir, contextEngine);
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

  return { doc, documentValid };
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

async function runStep(step, doc, roles, manager, projectDir, contextEngine) {
  const action = ACTIONS[step.action];
  if (!action) throw new Error(`Unknown pipeline action: ${step.action}`);
  const plugin = roles[step.role];
  if (!plugin) throw new Error(`No provider configured for role '${step.role}'`);

  const context = contextEngine.gather({ action: step.action, doc, projectDir });
  const prompt = buildPrompt({ objective: action.baseInstruction(doc), context });

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
