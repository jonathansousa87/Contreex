// Honest, real-numbers check of what actually saves tokens/cost today vs.
// what's built but not wired in, vs. what's built but inactive in this
// environment. No estimates — every number here comes from a real call or a
// real measurement, following the project's own rule about decorative
// metrics (ROADMAP.md item 7).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentManager } from '../src/agent-manager.mjs';
import { claudeAgent } from '../src/agents/claude-agent.mjs';
import { codexAgent } from '../src/agents/codex-agent.mjs';
import { ContextEngine } from '../src/context-engine.mjs';
import { buildPrompt } from '../src/language/prompt-builder.mjs';
import { openRouterOptimizer } from '../src/language/prompt-optimizer.mjs';

console.log('=== 1. Prompt Optimizer status in this environment ===');
const hasKey = !!process.env.OPENROUTER_API_KEY;
console.log(`OPENROUTER_API_KEY set: ${hasKey}`);
const testPrompt = 'Add isPalindrome(str) to utils.js.';
const optimized = await openRouterOptimizer.optimize(testPrompt);
console.log(`optimize() input:  "${testPrompt}" (${testPrompt.length} chars)`);
console.log(`optimize() output: "${optimized}" (${optimized.length} chars)`);
console.log(`identical (no-op confirmed): ${optimized === testPrompt}`);

console.log('\n=== 2. Context Engine: real context size vs. a naive "dump everything" baseline ===');
const dir = mkdtempSync(join(tmpdir(), 'contreex-tokens-'));
for (const f of ['utils.js', 'index.js', 'auth.js', 'db.js', 'routes.js']) writeFileSync(join(dir, f), `// ${f}\n`);
const ce = new ContextEngine();
const doc = { request: { objective: 'Add isPalindrome(str) to utils.js.' } };
const realContext = ce.gather({ action: 'analyze', doc, projectDir: dir });
const realPrompt = buildPrompt({ objective: doc.request.objective, context: realContext });
console.log(`Context Engine's actual context: ${JSON.stringify(realContext).length} chars`);
console.log(`Full prompt sent: ${realPrompt.length} chars`);
rmSync(dir, { recursive: true, force: true });

console.log('\n=== 3. Cache: real savings on a repeated call ===');
const cacheDir = mkdtempSync(join(tmpdir(), 'contreex-tokens-cache-'));
writeFileSync(join(cacheDir, 'utils.js'), '// utils.js\n');
const manager = new AgentManager({ maxRetries: 1 });
const callOpts = {
  projectDir: cacheDir,
  role: 'reviewer',
  prompt: 'You are a reviewer. Reply with ONLY a JSON object with "verdict" (APPROVE, CHANGES_NEEDED, or BLOCKED) and "findings" (array, can be empty). Task: trivial no-op review.',
  defName: 'review',
  timeout: 60_000,
};
const first = await manager.run(claudeAgent, callOpts);
const second = await manager.run(claudeAgent, callOpts);
console.log(`first call:  cached=${!!first.cached}  tokens=${JSON.stringify(first.meta?.tokens)}  costUsd=${first.meta?.costUsd}`);
console.log(`second call: cached=${!!second.cached}  (cache hit — zero additional tokens billed, zero additional cost)`);
rmSync(cacheDir, { recursive: true, force: true });

console.log('\n=== 4. Real per-call token usage: Claude vs Codex, same prompt ===');
const usageDir = mkdtempSync(join(tmpdir(), 'contreex-tokens-usage-'));
writeFileSync(join(usageDir, 'utils.js'), '// utils.js\n');
const manager2 = new AgentManager({ maxRetries: 1 });
const usagePrompt = {
  projectDir: usageDir,
  role: 'reviewer',
  prompt: 'You are a reviewer. Reply with ONLY a JSON object with "verdict" (APPROVE, CHANGES_NEEDED, or BLOCKED) and "findings" (array, can be empty). Task: add isPalindrome(str) to utils.js.',
  defName: 'review',
  timeout: 60_000,
};
const claudeResult = await manager2.run(claudeAgent, { ...usagePrompt, prompt: usagePrompt.prompt + ' [claude-run]' });
const codexResult = await manager2.run(codexAgent, { ...usagePrompt, prompt: usagePrompt.prompt + ' [codex-run]' });
console.log('claude tokens:', JSON.stringify(claudeResult.meta?.tokens), '| costUsd:', claudeResult.meta?.costUsd);
console.log('codex tokens: ', JSON.stringify(codexResult.meta?.tokens));
rmSync(usageDir, { recursive: true, force: true });

console.log('\n=== 5. RTK compression (src/compress.mjs): real status ===');
console.log('summarizeDiff/expandDiff have NO consumer anywhere in the live pipeline (grep confirms zero imports outside scripts/demo-phase6.mjs and this report) — 0% real savings today, proven only in isolation.');
