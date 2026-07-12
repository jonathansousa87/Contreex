// Same demo, but against agy — which has NO native structured-output flag.
// This is the real test of whether the Normalizer earns its keep, not just
// agreement with an already-constrained native JSON mode.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from '../src/exec.mjs';
import { parseAndValidateSection } from '../src/aep/index.mjs';

const TASK = 'Add a function isPalindrome(str) to a JavaScript utils file that returns true if str reads the same forwards and backwards (case-insensitive, ignore spaces).';

const prompt = `You are the "implementer" role in a multi-agent pipeline. Analyze this task and reply with ONLY a JSON object (no markdown fences, no prose) with keys "problem" (string), "risks" (array of strings) and "confidence" (0-1 number) describing your analysis. Task: ${TASK}`;

const cwd = mkdtempSync(join(tmpdir(), 'contreex-demo-agy-'));
console.log(`sandbox: ${cwd}`);
console.log('invoking agy (no native schema support)...');

const result = await exec('agy', ['-p', prompt, '--add-dir', cwd, '--dangerously-skip-permissions', '--print-timeout', '60s'], {
  cwd,
  timeout: 70_000,
});

rmSync(cwd, { recursive: true, force: true });

if (!result.ok) {
  console.error('agy invocation failed:', result.timedOut ? 'TIMED OUT' : `exit ${result.code}`);
  console.error(result.stderr.slice(0, 500));
  process.exit(1);
}

console.log('\nraw model reply (pre-normalize):');
console.log(result.stdout);

const { parsed, valid, errors, data } = parseAndValidateSection(result.stdout, 'analysis');

console.log('\n=== Normalizer + Validator result ===');
console.log(`parsed: ${parsed} | valid against AEP "analysis" schema: ${valid}`);
if (!valid) console.log('errors:', JSON.stringify(errors, null, 2));
else console.log('data:', JSON.stringify(data, null, 2));
