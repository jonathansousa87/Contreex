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
// A `loop` step runs review -> consensus -> refine repeatedly (see
// runConsensusLoop below) instead of a fixed number of rounds:
//   { loop: { maxRounds: 3, reviewers: [{ role: 'reviewer1', action: 'review' }, ...] } }
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

export async function runOrchestrator({ projectDir, objective, pipeline, roles, manager = new AgentManager(), language, attachments, contextEngine = new ContextEngine() }) {
  const doc = {
    protocol: { name: 'Agent Exchange Protocol', version: '1.0.0' },
    metadata: { requestId: randomUUID(), role: 'orchestrator', createdAt: new Date().toISOString() },
    // `objective` here is already internal-language (English) text — translation
    // happens one layer up, in the Language Engine, before this is ever called.
    // `language` just records provenance so the AEP document is self-describing.
    // `attachments` — absolute image paths (see src/clipboard.mjs / bin/contreex.mjs's
    // --from-clipboard/--image) — only reaches the 'analyze' step's context/images;
    // reviewers/refine don't see them today, see docs/ARCHITECTURE.md.
    request: { objective, ...(language ? { language } : {}), ...(attachments?.length ? { attachments } : {}) },
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

  // Not part of the AEP document (top-level additionalProperties: false
  // forbids it) — this is purely local plumbing so the CLI can point the
  // Compress module at the real worktree an implement step actually wrote
  // to, for a real diff summary in the report.
  let implementWorktree = null;

  try {
    for (const step of pipeline) {
      if (step.loop) {
        await runConsensusLoop(step.loop, doc, roles, manager, projectDir, contextEngine, eventBus);
      } else if (step.parallel) {
        const outcomes = await Promise.all(step.parallel.map((s) => runStep(s, doc, roles, manager, projectDir, contextEngine)));
        for (const outcome of outcomes) applyOutcome(doc, outcome, eventBus);
      } else {
        const outcome = await runStep(step, doc, roles, manager, projectDir, contextEngine);
        applyOutcome(doc, outcome, eventBus);
        if (step.action === 'implement' && outcome.result.ok) implementWorktree = outcome.result.cwd;
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

  return { doc, documentValid, implementWorktree };
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

// Review -> consensus -> refine, repeated up to maxRounds. Stops early on
// either of two conditions, both real signals the user asked for, not a
// silent default: (1) reviewers unanimously APPROVE — nothing left to
// reconcile, refine doesn't even run that round; (2) the implementer
// ("chief engineer") explicitly declares chiefEngineerOverride — the user's
// rule is unanimity, but Claude carries more weight than any one reviewer
// because reviewers can push back over things that don't actually matter,
// so an explicit, justified override can end the loop without full
// agreement. If neither fires by maxRounds, the loop ends anyway — the
// final round's refine is always the last word, and the report surfaces
// that consensus was NOT reached so the decision comes back to the user,
// not silently to Claude alone.
async function runConsensusLoop({ reviewers, maxRounds = 3 }, doc, roles, manager, projectDir, contextEngine, eventBus) {
  let round = 0;
  let stopReason = 'max rounds reached without consensus';

  while (round < maxRounds) {
    round++;
    const outcomes = await Promise.all(reviewers.map((s) => runStep(s, doc, roles, manager, projectDir, contextEngine)));
    for (const outcome of outcomes) applyOutcome(doc, outcome, eventBus);

    const consensusOutcome = await runStep({ action: 'consensus', strategy: 'unanimity' }, doc, roles, manager, projectDir, contextEngine);
    applyOutcome(doc, consensusOutcome, eventBus);

    if (doc.consensus?.verdict === 'APPROVE') {
      stopReason = 'unanimous reviewer approval';
      break;
    }

    const refineOutcome = await runStep({ role: 'implementer', action: 'refine' }, doc, roles, manager, projectDir, contextEngine);
    applyOutcome(doc, refineOutcome, eventBus);

    if (doc.refinement?.chiefEngineerOverride === true) {
      stopReason = 'chief engineer override';
      break;
    }
  }

  if (doc.consensus) {
    doc.consensus.rounds = round;
    doc.consensus.maxRounds = maxRounds;
    doc.consensus.stopReason = stopReason;
  }
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
    timeout: action.timeout ?? 60_000,
    cache: action.cache !== false,
    // Only 'analyze' gets images today — that's the step the user actually
    // needs to point at a screenshot ("what's happening on screen"); reviewers
    // reviewing a plan don't need it re-attached every round.
    images: step.action === 'analyze' ? doc.request.attachments : undefined,
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
