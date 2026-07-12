// Context Engine — decides WHAT goes into a given pipeline step's prompt:
// which project files, which past decisions (Decision Memory), which
// Knowledge Base entries. Feeds the result to language/prompt-builder.mjs,
// which only formats it. Before this existed, every ACTION in
// orchestrator.mjs hardcoded its own context inline — this is that decision
// made explicit and in one place.

import { readdirSync, existsSync } from 'node:fs';
import { findSimilarRuns } from './memory/query.mjs';
import { queryKnowledgeBase } from './knowledge-base.mjs';

const MAX_FILES_LISTED = 40;

export class ContextEngine {
  constructor({ memoryLookup = findSimilarRuns, knowledgeLookup = queryKnowledgeBase } = {}) {
    this.memoryLookup = memoryLookup;
    this.knowledgeLookup = knowledgeLookup;
  }

  /**
   * @param {object} opts
   * @param {string} opts.action - the pipeline action name (analyze/review/refine/...)
   * @param {object} opts.doc - the AEP document accumulated so far
   * @param {string} opts.projectDir - the real project root (never a worktree)
   * @returns {string[]} flat context lines — PromptBuilder's job is just formatting them
   */
  gather({ action, doc, projectDir }) {
    const context = [];

    if (action === 'analyze') {
      context.push(...this.listProjectFiles(projectDir));
      context.push(...this.similarPastTasks(doc.request.objective));
      context.push(...this.relevantKnowledge(doc.request.objective));
      // Codex gets these structurally too (-i/--image, see agent-manager.mjs's
      // `images` param) — this text line is what makes it work for Claude,
      // which has no native attach flag but can Read an absolute file path.
      if (doc.request.attachments?.length) {
        context.push(`Attached image(s) — look at them, they show what's actually happening: ${doc.request.attachments.join(', ')}`);
      }
    }

    if (action === 'review') {
      if (doc.plan) context.push(`Plan under review: ${JSON.stringify(doc.plan)}`);
      // Present in a second-or-later review round after refine ran — without
      // this, reviewers would re-review the exact same plan blind to what the
      // implementer already accepted/rejected/updated in response to round 1.
      // Deliberately not nested under `doc.plan` above: a round can have
      // refinement history even when the plan itself never changed shape, and
      // this must never be silently dropped (doing so also collapses two
      // genuinely different rounds into an identical, cacheable prompt).
      if (doc.refinement) {
        context.push(`Implementer's prior refinement round (what was accepted/rejected and why — still under review, not final): ${JSON.stringify(doc.refinement)}`);
      }
      context.push(...this.relevantKnowledge(doc.request.objective));
    }

    if (action === 'refine') {
      if (doc.plan) context.push(`Original plan: ${JSON.stringify(doc.plan)}`);
      if (doc.reviews) context.push(`Reviewer feedback: ${JSON.stringify(doc.reviews)}`);
    }

    if (action === 'implement') {
      context.push(...this.listProjectFiles(projectDir));
      if (doc.plan) context.push(`Plan to implement: ${JSON.stringify(doc.plan)}`);
      if (doc.refinement) context.push(`Refinement — apply accepted changes, skip rejected ones: ${JSON.stringify(doc.refinement)}`);
    }

    return context;
  }

  listProjectFiles(projectDir) {
    if (!projectDir || !existsSync(projectDir)) return [];
    try {
      const files = readdirSync(projectDir).filter((f) => !f.startsWith('.') && f !== 'node_modules');
      if (!files.length) return [];
      const shown = files.slice(0, MAX_FILES_LISTED);
      const suffix = files.length > MAX_FILES_LISTED ? ` (+${files.length - MAX_FILES_LISTED} more)` : '';
      return [`Project files: ${shown.join(', ')}${suffix}`];
    } catch {
      return [];
    }
  }

  relevantKnowledge(objective) {
    const entries = this.knowledgeLookup(objective);
    if (!entries.length) return [];
    return [`Known lessons from past experience (Knowledge Base, apply if relevant): ${JSON.stringify(entries)}`];
  }

  similarPastTasks(objective) {
    const priorRuns = this.memoryLookup(objective);
    if (!priorRuns.length) return [];
    return [
      `Similar past tasks (for context only, use your own judgement): ${JSON.stringify(
        priorRuns.map((r) => ({
          objective: r.objective,
          accepted: r.refinement?.acceptedCount ?? 0,
          rejected: r.refinement?.rejectedCount ?? 0,
          reviewVerdicts: Object.values(r.reviews ?? {}).map((rv) => rv.verdict),
        })),
      )}`,
    ];
  }
}
