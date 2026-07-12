// Phase 6 demo: cache (real call vs cache hit), MCP gateway (workspace-scoped
// server filtering, no protocol reimplementation), and RTK-style diff compaction
// (real byte-size comparison, not a synthetic estimate).

import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentManager } from '../src/agent-manager.mjs';
import { claudeAgent } from '../src/agents/claude-agent.mjs';
import { resolveConfig } from '../src/config/load.mjs';
import { writeMcpConfigFile } from '../src/mcp-gateway.mjs';
import { summarizeDiff, expandDiff } from '../src/compress.mjs';
import { exec } from '../src/exec.mjs';

console.log('=== 1. Cache ===');
const projectDir = mkdtempSync(join(tmpdir(), 'contreex-phase6-'));
writeFileSync(join(projectDir, 'utils.js'), '// utils.js\nmodule.exports = {};\n');
writeFileSync(join(projectDir, '.contreex-profile'), 'profile: home\n');

const manager = new AgentManager({ maxRetries: 1 });
const callOpts = {
  projectDir,
  role: 'reviewer',
  prompt: 'You are a reviewer. Reply with ONLY a JSON object with "verdict" (APPROVE, CHANGES_NEEDED, or BLOCKED) and "findings" (array, can be empty). Task: trivial no-op review.',
  defName: 'review',
  timeout: 60_000,
};

const t1 = Date.now();
const first = await manager.run(claudeAgent, callOpts);
const ms1 = Date.now() - t1;
const t2 = Date.now();
const second = await manager.run(claudeAgent, callOpts);
const ms2 = Date.now() - t2;

console.log(`first call:  ${ms1}ms | cached: ${!!first.cached}`);
console.log(`second call: ${ms2}ms | cached: ${!!second.cached}`);
console.log(`speedup: ${(ms1 / Math.max(ms2, 1)).toFixed(0)}x`);

console.log('\n=== 2. MCP Gateway ===');
const home = resolveConfig(projectDir);
const homeGateway = writeMcpConfigFile(home.config.mcp);
console.log(`home workspace      -> servers: [${homeGateway.serverNames.join(', ')}] | missing: [${homeGateway.missing.join(', ')}]`);

const corpDir = mkdtempSync(join(tmpdir(), 'contreex-phase6-corp-'));
writeFileSync(join(corpDir, '.contreex-profile'), 'profile: corporate\n');
const corp = resolveConfig(corpDir);
const corpGateway = writeMcpConfigFile(corp.config.mcp);
console.log(`corporate workspace -> servers: [${corpGateway.serverNames.join(', ')}] | missing: [${corpGateway.missing.join(', ')}]`);
console.log('(missing = listed in the workspace but no ~/.contreex/mcp-servers/<name>.json defined yet — reported, not fatal)');
rmSync(corpDir, { recursive: true, force: true });

console.log('\n=== 3. RTK-style diff compaction ===');
const gitDir = mkdtempSync(join(tmpdir(), 'contreex-phase6-git-'));
await exec('git', ['-C', gitDir, 'init'], {});
await exec('git', ['-C', gitDir, 'config', 'user.email', 'demo@contreex'], {});
await exec('git', ['-C', gitDir, 'config', 'user.name', 'demo'], {});
writeFileSync(join(gitDir, 'big.js'), Array.from({ length: 200 }, (_, i) => `function stub${i}() { return ${i}; }`).join('\n') + '\n');
await exec('git', ['-C', gitDir, 'add', '-A'], {});
await exec('git', ['-C', gitDir, 'commit', '-m', 'initial'], {});
// Edit every line so the full diff is genuinely large.
writeFileSync(join(gitDir, 'big.js'), Array.from({ length: 200 }, (_, i) => `function stub${i}() { return ${i} * 2; }`).join('\n') + '\n');

const fullDiff = await exec('git', ['-C', gitDir, 'diff'], {});
const summary = await summarizeDiff(gitDir);
const summaryText = JSON.stringify(summary);

console.log(`full diff:    ${fullDiff.stdout.length} chars`);
console.log(`RTK summary:  ${summaryText.length} chars — ${summaryText}`);
console.log(`compaction:   ${(100 - (summaryText.length / fullDiff.stdout.length) * 100).toFixed(1)}% smaller`);

const expanded = await expandDiff(gitDir, 'big.js');
console.log(`\nexpandDiff('big.js') on demand returns the full ${expanded.length}-char diff for just that file — same content as the full diff here since there's only one file.`);

rmSync(projectDir, { recursive: true, force: true });
rmSync(gitDir, { recursive: true, force: true });
