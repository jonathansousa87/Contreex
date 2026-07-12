// Agent Manager — the only thing in Contreex that knows how to run an agent
// plugin safely: worktree isolation, retry classification, state tracking.
// Orchestrator (not built yet) will call this; it never spawns a CLI directly.

import { createWorktree } from './worktree.mjs';
import { parseAndValidateSection } from './aep/index.mjs';
import { getCached, setCached } from './cache.mjs';

export const AgentState = Object.freeze({
  READY: 'READY',
  RUNNING: 'RUNNING',
  RETRYING: 'RETRYING',
  FAILED: 'FAILED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  OFFLINE: 'OFFLINE',
  DISABLED: 'DISABLED',
});

// Heuristic classification from stderr text — refine as real failures are
// observed in production. Terminal failures are never retried: retrying a
// quota-exceeded or auth-expired call only burns time waiting for a result
// that cannot change.
const TERMINAL_PATTERNS = [
  { state: AgentState.QUOTA_EXCEEDED, re: /quota|rate.?limit exceeded|billing|insufficient credit/i },
  { state: AgentState.AUTH_EXPIRED, re: /unauthorized|auth.*(expired|invalid|failed)|not logged in|401/i },
];

function classifyFailure(result) {
  if (result.error && !result.rawResult?.timedOut) {
    for (const { state, re } of TERMINAL_PATTERNS) {
      if (re.test(result.error)) return { retriable: false, state };
    }
  }
  if (result.rawResult?.timedOut) return { retriable: true, state: AgentState.RETRYING };
  return { retriable: true, state: AgentState.RETRYING }; // unknown failures default to retriable
}

export class AgentManager {
  constructor({ maxRetries = 2, retryDelayMs = 1_000 } = {}) {
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
    this.states = new Map(); // agentName -> AgentState
  }

  getState(agentName) {
    return this.states.get(agentName) ?? AgentState.READY;
  }

  /**
   * Runs one agent plugin for one role, inside its own worktree, with retry
   * classification, then normalizes+validates the raw reply against an AEP
   * section (skipped if defName is omitted).
   *
   * @param {object} plugin - an Agent-interface object (see claude-agent.mjs / codex-agent.mjs)
   * @param {object} opts
   * @param {string} opts.projectDir - the real project root (never touched directly)
   * @param {string} opts.role - worktree/branch name AND passed through to plugin.execute() as role
   * @param {string} opts.prompt
   * @param {string} [opts.defName] - AEP $def to validate the reply against
   * @param {object} [opts.jsonSchema] - forwarded to plugins that support native schema constraints
   * @param {number} [opts.timeout]
   * @param {boolean} [opts.cache] - reuse an identical prior call within the TTL window (default true).
   *   Only safe for side-effect-free actions (analyze/review/refine today); pass `cache: false` for any
   *   action that performs a real write the caller needs to actually happen every time (e.g. 'implement').
   */
  async run(plugin, { projectDir, role, prompt, defName, jsonSchema, timeout, cache = true }) {
    const cacheParts = { agent: plugin.name, role, prompt, jsonSchema };
    if (cache) {
      const hit = getCached(cacheParts);
      if (hit) return { ...hit, cached: true };
    }

    const cwd = await createWorktree(projectDir, `${plugin.name}-${role}`);
    this.states.set(plugin.name, AgentState.RUNNING);

    let attempt = 0;
    let lastResult;
    while (attempt <= this.maxRetries) {
      lastResult = await plugin.execute({ prompt, cwd, role, jsonSchema, timeout });
      if (lastResult.ok) {
        this.states.set(plugin.name, AgentState.READY);
        break;
      }

      const { retriable, state } = classifyFailure(lastResult);
      this.states.set(plugin.name, state);
      if (!retriable || attempt === this.maxRetries) break;

      attempt++;
      this.states.set(plugin.name, AgentState.RETRYING);
      await sleep(this.retryDelayMs * attempt);
    }

    if (!lastResult.ok) {
      return { ok: false, agent: plugin.name, role, cwd, attempts: attempt + 1, state: this.getState(plugin.name), error: lastResult.error };
    }

    const validated = defName ? parseAndValidateSection(lastResult.raw, defName) : { parsed: true, valid: true, data: lastResult.raw };

    const result = {
      ok: validated.valid,
      agent: plugin.name,
      role,
      cwd,
      attempts: attempt + 1,
      state: this.getState(plugin.name),
      raw: lastResult.raw,
      data: validated.data,
      validationErrors: validated.valid ? [] : validated.errors,
      meta: lastResult.meta,
    };

    if (cache && result.ok) setCached(cacheParts, result);
    return result;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
