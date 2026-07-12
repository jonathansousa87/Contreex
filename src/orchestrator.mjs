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
// This module knows nothing about analyze/review/refine specifically — every
// action comes from src/actions/registry.mjs. What context goes with a step
// is the ContextEngine's job; turning that into one prompt string is
// language/prompt-builder.mjs's job (the same module the Language Engine
// uses). Orchestrator only sequences steps and merges validated results.
//
// doc.logs is built entirely from AgentManager's own events (via
// manager.eventBus), not by pushing directly here — anything else wanting to
// observe a run (future observability, a dashboard, tests) listens to the
// exact same events instead of needing its own hook into the orchestrator.

import { randomUUID } from 'node:crypto';
import { AgentManager } from './agent-manager.mjs';
import { validateAepDocument } from './aep/validate.mjs';
import { recordRun } from './memory/store.mjs';
import { ContextEngine } from './context-engine.mjs';
import { buildPrompt } from './language/prompt-builder.mjs';
import { resolveAction } from './actions/registry.mjs';
import { EVENTS } from './event-bus.mjs';

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

  const eventBus = manager.eventBus;
  const logListener = ({ agent, role, action, ok, error, cached }) => {
    doc.logs.push({
      timestamp: new Date().toISOString(),
      level: ok ? 'info' : 'error',
      message: `${role} (${agent}) ran action '${action}'${cached ? ' [cached]' : ''} — ${ok ? 'ok' : error || 'validation failed'}`,
      agent,
    });
  };
  eventBus.on(EVENTS.AFTER_AGENT_RUN, logListener);

  try {
    for (const step of pipeline) {
      if (step.parallel) {
        const outcomes = await Promise.all(step.parallel.map((s) => runStep(s, doc, roles, manager, projectDir, contextEngine)));
        for (const outcome of outcomes) applyOutcome(doc, outcome, eventBus);
      } else {
        const outcome = await runStep(step, doc, roles, manager, projectDir, contextEngine);
        applyOutcome(doc, outcome, eventBus);
      }
    }
  } finally {
    eventBus.off(EVENTS.AFTER_AGENT_RUN, logListener);
  }

  const documentValid = validateAepDocument(doc);
  // Memory is a side channel, not a pipeline dependency — a write failure here
  // must never surface as a failed run.
  try {
    recordRun(distillForMemory(doc, roles));
  } catch {
    // best-effort
  }

  eventBus.emit(EVENTS.PIPELINE_FINISHED, { requestId: doc.metadata.requestId, objective: doc.request.objective, valid: documentValid.valid });

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
  const action = resolveAction(step.action);

  // Local actions (e.g. "consensus") are pure computation — no agent call,
  // no worktree, no LLM cost. Still routed through the same event bus as
  // everything else, so the log listener and any external observer see it
  // exactly like any other step.
  if (action.local) {
    let result;
    try {
      result = { ok: true, data: action.compute(doc, step) };
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    manager.eventBus.emit(EVENTS.AFTER_AGENT_RUN, { agent: 'contreex', role: step.role ?? step.action, action: step.action, ok: result.ok, error: result.error });
    return { step, action, result };
  }

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
    eventMeta: { action: step.action },
  });

  return { step, action, result };
}

function applyOutcome(doc, { step, action, result }, eventBus) {
  if (!result.ok) return; // logged already; document simply lacks this section
  let data = result.data;
  if (action.validate) {
    const v = action.validate(result.raw);
    if (!v.valid) return;
    data = v.data;
  }
  action.merge(doc, data, step.role);

  if (step.action === 'refine' && eventBus) {
    for (const accepted of data.acceptedChanges ?? []) eventBus.emit(EVENTS.REVIEW_ACCEPTED, { suggestion: accepted });
    for (const rejected of data.rejectedChanges ?? []) eventBus.emit(EVENTS.REVIEW_REJECTED, rejected);
  }
}
