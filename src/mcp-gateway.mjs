// MCP Gateway — decides WHICH MCP servers an agent is allowed to see, given
// the active workspace's `mcp` allowlist. Deliberately does not implement the
// MCP protocol itself (transport, handshake, tool discovery) — that's what
// each CLI's own --mcp-config support already does. Reinventing that would
// duplicate mature, existing implementations for no benefit; the actual
// value Contreex adds here is enforcement (a reviewer in the "home" workspace
// physically cannot be handed the corporate Jira/Confluence servers, because
// the gateway never puts them in its generated config) and an audit point.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const MCP_SERVERS_DIR = join(homedir(), '.contreex', 'mcp-servers');

/**
 * Looks up each allowed server name's definition (~/.contreex/mcp-servers/<name>.json,
 * standard { command, args, env } shape used by MCP client configs) and returns
 * only the ones that actually exist. Missing definitions are reported, not thrown —
 * a workspace listing a server nobody has configured yet shouldn't crash a run.
 */
export function buildMcpConfig(allowedServerNames) {
  const mcpServers = {};
  const missing = [];
  for (const name of allowedServerNames ?? []) {
    const defPath = join(MCP_SERVERS_DIR, `${name}.json`);
    if (!existsSync(defPath)) {
      missing.push(name);
      continue;
    }
    mcpServers[name] = JSON.parse(readFileSync(defPath, 'utf8'));
  }
  return { mcpServers, missing };
}

/**
 * Writes a ready-to-use --mcp-config file scoped to exactly the allowed
 * servers, in a fresh temp dir (never the project or worktree — this file is
 * gateway-owned, not agent-owned). Returns the path plus an audit summary.
 */
export function writeMcpConfigFile(allowedServerNames) {
  const { mcpServers, missing } = buildMcpConfig(allowedServerNames);
  const dir = mkdtempSync(join(tmpdir(), 'contreex-mcp-'));
  const file = join(dir, 'mcp-config.json');
  writeFileSync(file, JSON.stringify({ mcpServers }, null, 2));
  return { file, serverNames: Object.keys(mcpServers), missing };
}

/**
 * MCP as a capability, not a literal server name (ROADMAP.md item 11): a
 * caller asks for "git" or "issueTracker", never a specific server — the
 * active workspace decides which concrete server (if any) actually provides
 * that capability, via its `capabilities` map (e.g.
 * `capabilities: { git: corporate-git, issueTracker: jira }` in a workspace
 * YAML). A capability with no mapping in the current workspace is reported
 * as unavailable, not an error — a project asking for "issueTracker" at
 * home, where no such mapping exists, should degrade gracefully, not crash.
 */
export function resolveCapabilities(capabilityNames, capabilityMap = {}) {
  const serverNames = [];
  const unavailable = [];
  for (const capability of capabilityNames ?? []) {
    const server = capabilityMap[capability];
    if (server) serverNames.push(server);
    else unavailable.push(capability);
  }
  return { serverNames, unavailable };
}

/** Same as writeMcpConfigFile, but the caller names capabilities, never servers. */
export function writeMcpConfigForCapabilities(capabilityNames, capabilityMap) {
  const { serverNames, unavailable: unavailableCapabilities } = resolveCapabilities(capabilityNames, capabilityMap);
  const result = writeMcpConfigFile(serverNames);
  return { ...result, unavailableCapabilities };
}
