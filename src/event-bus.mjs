// Event Bus — a single, plain node:events EventEmitter. Nothing above this
// module depends on who's listening; logging, future observability, and any
// external consumer all hook in the same way, without the orchestrator or
// agent-manager knowing they exist. No new dependency: node:events is built in.

import { EventEmitter } from 'node:events';

export const EVENTS = Object.freeze({
  BEFORE_AGENT_RUN: 'BeforeAgentRun',
  AFTER_AGENT_RUN: 'AfterAgentRun',
  RETRY_STARTED: 'RetryStarted',
  QUOTA_EXCEEDED: 'QuotaExceeded',
  REVIEW_ACCEPTED: 'ReviewAccepted',
  REVIEW_REJECTED: 'ReviewRejected',
  PIPELINE_FINISHED: 'PipelineFinished',
});

// A shared default instance is enough for a single-process CLI — every
// caller importing this module gets the same bus. A per-run instance can be
// passed explicitly (see AgentManager/runOrchestrator's `eventBus` option)
// for tests or for isolating concurrent runs later (ROADMAP.md item 13).
export const eventBus = new EventEmitter();
eventBus.setMaxListeners(50);
