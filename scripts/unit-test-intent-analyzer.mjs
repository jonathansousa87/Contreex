import assert from 'node:assert/strict';
import { classifyByKeyword, classifyIntent, profileForIntent } from '../src/intent-analyzer.mjs';

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
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (e) {
    console.log(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

check('PT-BR "analise" classifies as analyze', () => {
  assert.equal(classifyByKeyword('Analise essas duas aplicações e me diga o que falta.'), 'analyze');
});

check('the real migration scenario from the roadmap discussion classifies as analyze, not implement', () => {
  const text =
    'Analise essas duas aplicações uma é legada em c# dot net e a outra é refatorado em java mas com menos funções, preciso pegar o restante das funções e também desacoplar esse projeto do banco de dados sql server';
  assert.equal(classifyByKeyword(text), 'analyze');
});

check('PT-BR "implemente" classifies as implement', () => {
  assert.equal(classifyByKeyword('Implemente a função isPalindrome em utils.js'), 'implement');
});

check('PT-BR "crie um plano" classifies as plan', () => {
  assert.equal(classifyByKeyword('Crie um plano de migração para o novo banco'), 'plan');
});

check('EN "review the code" classifies as review-code', () => {
  assert.equal(classifyByKeyword('Please review the code in utils.js'), 'review-code');
});

check('no keyword match returns null (caller decides fallback)', () => {
  assert.equal(classifyByKeyword('utils.js needs some love'), null);
});

check('profileForIntent maps every known intent to a real preset name', () => {
  assert.equal(profileForIntent('analyze'), 'analysis-only');
  assert.equal(profileForIntent('review-code'), 'analysis-only');
  assert.equal(profileForIntent('plan'), 'review');
  assert.equal(profileForIntent('implement'), 'critical');
});

await checkAsync('classifyIntent without an optimizer defaults to "plan" when ambiguous', async () => {
  const { intent, method } = await classifyIntent('utils.js needs some love');
  assert.equal(intent, 'plan');
  assert.equal(method, 'default');
});

await checkAsync('classifyIntent skips the optimizer entirely when a keyword already matched', async () => {
  let called = false;
  const optimizer = { optimize: async () => { called = true; return 'plan'; } };
  const { intent, method } = await classifyIntent('Analise este código', { optimizer });
  assert.equal(intent, 'analyze');
  assert.equal(method, 'keyword');
  assert.equal(called, false);
});

console.log(`\n${passed} passed`);
if (process.exitCode) console.log('SOME TESTS FAILED');
