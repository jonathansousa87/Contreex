// Maps provider names (as written in YAML config) to plugin instances. This
// is the one place that knows all four concrete CLIs exist — everything else
// (orchestrator, agent-manager, pipeline config) only ever sees role names.

import { claudeAgent } from './claude-agent.mjs';
import { codexAgent } from './codex-agent.mjs';
import { agyAgent } from './agy-agent.mjs';
import { mimoAgent } from './mimo-agent.mjs';

export const AGENT_REGISTRY = {
  claude: claudeAgent,
  codex: codexAgent,
  agy: agyAgent,
  mimo: mimoAgent,
};

export function resolveRoles(rolesConfig) {
  const resolved = {};
  for (const [roleName, providerName] of Object.entries(rolesConfig ?? {})) {
    const plugin = AGENT_REGISTRY[providerName];
    if (!plugin) {
      throw new Error(`Unknown provider '${providerName}' for role '${roleName}'. Known providers: ${Object.keys(AGENT_REGISTRY).join(', ')}`);
    }
    resolved[roleName] = plugin;
  }
  return resolved;
}
