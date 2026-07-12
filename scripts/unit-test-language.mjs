import assert from 'node:assert/strict';
import { buildTermList, protect, restore } from '../src/language/dictionary.mjs';
import { buildPrompt } from '../src/language/prompt-builder.mjs';

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

check('curated multi-word term gets protected and restored', () => {
  const terms = buildTermList();
  const { protectedText, placeholders } = protect('Explain how JSON Schema validation works.', terms);
  assert.ok(!protectedText.includes('JSON Schema'));
  assert.ok(protectedText.includes('TERMPLACEHOLDER0'));
  assert.equal(restore(protectedText, placeholders), 'Explain how JSON Schema validation works.');
});

check('code-shaped tokens (camelCase, file.ext, ALL_CAPS) are auto-detected', () => {
  const terms = buildTermList();
  const { protectedText, placeholders } = protect('Add isPalindrome to utils.js and update the MCP config.', terms);
  assert.ok(!protectedText.includes('isPalindrome'));
  assert.ok(!protectedText.includes('utils.js'));
  assert.equal(placeholders.size, 3); // isPalindrome, utils.js, MCP
  assert.equal(restore(protectedText, placeholders), 'Add isPalindrome to utils.js and update the MCP config.');
});

check('backtick-wrapped code is protected without the backticks leaking into output', () => {
  const terms = buildTermList();
  const { protectedText, placeholders } = protect('Rename `oldFunc` to something clearer.', terms);
  assert.ok(!protectedText.includes('oldFunc'));
  const restored = restore(protectedText, placeholders);
  assert.ok(restored.includes('oldFunc'));
});

check('custom terms extend, not replace, the default list', () => {
  const terms = buildTermList(['Contreex']);
  assert.ok(terms.includes('Contreex'));
  assert.ok(terms.includes('Worktree')); // default list still present
});

check('text with no protectable terms passes through with zero placeholders', () => {
  const terms = buildTermList();
  const { protectedText, placeholders } = protect('Please review this plan carefully.', terms);
  assert.equal(protectedText, 'Please review this plan carefully.');
  assert.equal(placeholders.size, 0);
});

check('buildPrompt with no context returns the objective unchanged', () => {
  assert.equal(buildPrompt({ objective: 'Add a helper.' }), 'Add a helper.');
});

check('buildPrompt with context appends a formatted block', () => {
  const result = buildPrompt({ objective: 'Add a helper.', context: ['utils.js exists', 'no tests yet'] });
  assert.ok(result.includes('Add a helper.'));
  assert.ok(result.includes('- utils.js exists'));
  assert.ok(result.includes('- no tests yet'));
});

console.log(`\n${passed} passed`);
if (process.exitCode) console.log('SOME TESTS FAILED');
