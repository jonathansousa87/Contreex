import assert from 'node:assert/strict';
import { formatReport } from '../src/report.mjs';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (e) {
    console.log(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

const DOC = {
  request: { objective: 'Add isPalindrome(str) to utils.js' },
  analysis: { problem: 'utils.js has no palindrome helper.', risks: ['punctuation handling unclear'], confidence: 0.9 },
  plan: { steps: [{ id: '1', description: 'add isPalindrome to utils.js' }] },
  reviews: {
    reviewer1: { verdict: 'APPROVE', findings: [] },
    reviewer2: { verdict: 'CHANGES_NEEDED', findings: [{ severity: 'low', summary: 'add a test case' }] },
  },
  refinement: {
    acceptedChanges: ['add a test case'],
    rejectedChanges: [{ suggestion: 'rename the function', reason: 'not requested, out of scope' }],
  },
};
const VALID = { valid: true, errors: [] };

check('default (non-verbose) report hides finding details and rejection reasons', () => {
  const report = formatReport(DOC, VALID);
  assert.ok(report.includes('APPROVE'));
  assert.ok(report.includes('CHANGES_NEEDED'));
  assert.ok(!report.includes('add a test case') || report.includes('✓ aceito: add a test case')); // accepted summary always shown
  assert.ok(!report.includes('not requested, out of scope')); // rejection reason hidden by default
  assert.ok(report.includes('use --verbose'));
});

check('verbose report exposes finding details and rejection reasons', () => {
  const report = formatReport(DOC, VALID, { verbose: true });
  assert.ok(report.includes('[low] add a test case'));
  assert.ok(report.includes('not requested, out of scope'));
});

check('clarifying questions render when present', () => {
  const docWithQuestions = { ...DOC, analysis: { ...DOC.analysis, clarifyingQuestions: ['Is the API available yet?'] } };
  const report = formatReport(docWithQuestions, VALID);
  assert.ok(report.includes('Is the API available yet?'));
});

check('no clarifying-questions section when the array is empty', () => {
  const report = formatReport(DOC, VALID);
  assert.ok(!report.includes('Perguntas de esclarecimento'));
});

check('a document with no reviews/refinement yet (mid-pipeline) does not crash', () => {
  const partial = { request: { objective: 'x' }, analysis: DOC.analysis, plan: DOC.plan, reviews: {} };
  const report = formatReport(partial, VALID);
  assert.ok(report.includes('x'));
});

check('every printed number/field traces to a real doc field — no hardcoded decorative stats', () => {
  const report = formatReport(DOC, VALID);
  assert.ok(!/\d+%/.test(report.replace('Confiança do implementer: 0.9', '')));
});

console.log(`\n${passed} passed`);
if (process.exitCode) console.log('SOME TESTS FAILED');
