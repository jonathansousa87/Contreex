// Classifies what the user is actually asking for and picks the pipeline
// profile that matches — the concrete fix for an analysis-only request never
// being allowed to look like an unrequested implementation decision
// (ROADMAP.md item 6, found through a real scenario). Runs on the RAW
// objective text, before translation — the keyword fallback works directly
// in whatever language the user typed, so classification never needs a
// network call by default.
//
// Honest limitation: "implement" intent maps to the most thorough available
// preset (critical), not to an actual code-writing pipeline action — there
// isn't one yet (see README "Known limitations"). Classifying intent as
// "implement" today still only produces analysis/plan/review/refinement
// text, same as everything else.

const INTENT_PROFILES = {
  analyze: 'analysis-only',
  'review-code': 'analysis-only', // no dedicated code-review action yet — analysis-only is the closest honest fit
  plan: 'review',
  implement: 'critical',
};

// PT-BR and EN keywords, checked directly on the raw objective. Order
// matters — most consequential intent checked first, so a message that
// mentions several verbs (a real, common case: "analyze this, and also we'll
// eventually need to fix X") doesn't get misclassified toward the safer one.
const KEYWORD_RULES = [
  { intent: 'implement', re: /\b(implemente|implementar|corrija|corrigir|arrume|conserte|implement|fix|build)\b/i },
  { intent: 'plan', re: /\b(crie um plano|criar um plano|plano de migra[cç][aã]o|planeje|planejar|migration plan|create a plan)\b/i },
  { intent: 'review-code', re: /\b(revis(e|ar) (esse|este|o) c[oó]digo|code review|review (the|this) code)\b/i },
  { intent: 'analyze', re: /\b(analise|analisar|an[aá]lise|analyze|analysis|analyse)\b/i },
];

export function classifyByKeyword(text) {
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(text)) return rule.intent;
  }
  return null;
}

/**
 * @param {string} text - the raw, untranslated objective
 * @param {{optimize(prompt: string): Promise<string>}} [optimizer] - reused
 *   from src/language/prompt-optimizer.mjs; same graceful no-op behavior
 *   without an API key applies here (falls through to the default intent).
 */
export async function classifyIntent(text, { optimizer } = {}) {
  const byKeyword = classifyByKeyword(text);
  if (byKeyword) return { intent: byKeyword, method: 'keyword' };

  if (optimizer) {
    const raw = await optimizer.optimize(
      `Classify the user's intent for this software engineering request into exactly one of: analyze, plan, implement, review-code. Reply with ONLY the single word, nothing else.\n\nRequest: ${text}`,
    );
    const cleaned = raw.trim().toLowerCase();
    if (INTENT_PROFILES[cleaned]) return { intent: cleaned, method: 'llm' };
  }

  // Ambiguous and no LLM classifier available (or it didn't return a known
  // label) — "plan" is the safest default: not silently analysis-only
  // (would under-deliver on a real request), not implementation (would
  // over-deliver on one that wasn't asked for).
  return { intent: 'plan', method: 'default' };
}

export function profileForIntent(intent) {
  return INTENT_PROFILES[intent] ?? 'review';
}
