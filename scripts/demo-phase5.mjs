// Phase 5 demo: cascading config (Global -> Workspace -> Project), explicit
// profile selection (never a silent default), and a full pipeline run driven
// entirely from YAML instead of hardcoded JS — proving config-driven role
// swapping (home uses agy for reviewer2, corporate uses mimo) works end to end.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, NoProfileError } from '../src/config/load.mjs';
import { resolveRoles } from '../src/agents/registry.mjs';
import { runOrchestrator } from '../src/orchestrator.mjs';
import { AgentManager } from '../src/agent-manager.mjs';

function makeProject(profileYaml) {
  const dir = mkdtempSync(join(tmpdir(), 'contreex-phase5-'));
  writeFileSync(join(dir, 'utils.js'), '// utils.js\nmodule.exports = {};\n');
  if (profileYaml !== null) writeFileSync(join(dir, '.contreex-profile'), profileYaml);
  return dir;
}

console.log('--- 1. no .contreex-profile at all: must throw, never assume a default ---');
const noProfileDir = makeProject(null);
try {
  resolveConfig(noProfileDir);
  console.log('FAIL: should have thrown');
} catch (e) {
  console.log(`threw as expected: ${e instanceof NoProfileError ? 'NoProfileError' : e.constructor.name} — "${e.message.slice(0, 90)}..."`);
}
rmSync(noProfileDir, { recursive: true, force: true });

console.log('\n--- 2. cascade resolution: home vs corporate ---');
const homeDir = makeProject('profile: home\n');
const corpDir = makeProject('profile: corporate\nreviewMode: critical\n');

const homeResolved = resolveConfig(homeDir);
const corpResolved = resolveConfig(corpDir);

console.log('home      :', JSON.stringify({ profile: homeResolved.profile, reviewMode: homeResolved.config.reviewMode, mcp: homeResolved.config.mcp, reviewer2: homeResolved.config.roles.reviewer2 }));
console.log('corporate :', JSON.stringify({ profile: corpResolved.profile, reviewMode: corpResolved.config.reviewMode, mcp: corpResolved.config.mcp, reviewer2: corpResolved.config.roles.reviewer2 }));
console.log('\n(reviewMode: corporate overrides the global default at the project layer; reviewer2 differs because the corporate WORKSPACE layer overrides it — same global config.yaml, two different resolved outcomes)');

console.log('\n--- 3. full pipeline run, driven entirely by the resolved home config (no hardcoded roles/pipeline) ---');
const roles = resolveRoles(homeResolved.config.roles);
const startedAt = Date.now();
const { doc, documentValid } = await runOrchestrator({
  projectDir: homeDir,
  objective: 'Add isPalindrome(str) to utils.js — case-insensitive, ignore spaces.',
  pipeline: homeResolved.config.pipeline,
  roles,
  manager: new AgentManager({ maxRetries: 1 }),
});
console.log(`wall time: ${Date.now() - startedAt}ms | document valid: ${documentValid.valid}`);
console.log('reviews collected from:', Object.keys(doc.reviews));

rmSync(homeDir, { recursive: true, force: true });
rmSync(corpDir, { recursive: true, force: true });
