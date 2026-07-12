// Classifies what the user is actually asking for and picks the pipeline
// profile that matches. Runs on the RAW objective text, before translation —
// the keyword fallback works directly in whatever language the user typed,
// so classification never needs a network call by default.
//
// IMPORTANT correction (2026-07-12, caught by the user): the first version
// of this mapped "analyze" to the "analysis-only" preset, which skips
// "refine". That was wrong — "refine" never touches code, it's the
// implementer synthesizing reviewer feedback into text/JSON, the same as
// "analyze" or "review". The user wants analysis + refinement on EVERY call,
// for a richer, synthesized response — always. What actually needs gating is
// a hypothetical future code-writing "implement" action, which doesn't exist
// yet (see README "Known limitations") — there is currently zero risk of
// unrequested code changes, because nothing in this codebase can make one.
// So every intent gets the full analyze -> review -> refine treatment;
// "implement" just earns extra scrutiny (the double-review "critical"
// preset) in anticipation of that future action actually writing something.
const INTENT_PROFILES = {
  analyze: 'review',
  'review-code': 'review',
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
