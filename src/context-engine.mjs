// Context Engine — decides WHAT goes into a given pipeline step's prompt:
// which project files, which past decisions (Decision Memory), which
// Knowledge Base entries (not built yet — ROADMAP.md #7). Feeds the result
// to language/prompt-builder.mjs, which only formats it. Before this existed,
// every ACTION in orchestrator.mjs hardcoded its own context inline — this
// is that decision made explicit and in one place.

import { readdirSync, existsSync } from 'node:fs';
import { findSimilarRuns } from './memory/query.mjs';

const MAX_FILES_LISTED = 40;

export class ContextEngine {
  constructor({ memoryLookup = findSimilarRuns } = {}) {
    this.memoryLookup = memoryLookup;
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
    }

    if (action === 'review' && doc.plan) {
      context.push(`Plan under review: ${JSON.stringify(doc.plan)}`);
    }

    if (action === 'refine') {
      if (doc.plan) context.push(`Original plan: ${JSON.stringify(doc.plan)}`);
      if (doc.reviews) context.push(`Reviewer feedback: ${JSON.stringify(doc.reviews)}`);
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
