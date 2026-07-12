// Language Engine — the first and last component in the request/response
// path (see ROADMAP.md target architecture). Everything between toInternal()
// and toOutput() operates in the internal language (English by default);
// this module is where all translation/optimization complexity lives, so the
// rest of the platform never has to think about language at all.

import { buildTermList, protect, restore } from './dictionary.mjs';
import { resolveTranslationProvider } from './translation-provider.mjs';
import { resolvePromptOptimizer } from './prompt-optimizer.mjs';

// BCP-47-ish tags in config (pt-BR, en-US) vs. the two-letter codes the free
// Google endpoint actually wants (pt, en) — kept as an explicit map rather
// than a substring hack so adding a third language is a one-line change.
const LANG_CODE = { 'pt-BR': 'pt', 'en-US': 'en' };

export class LanguageEngine {
  constructor({ translationProvider = 'google', optimizerProvider = 'openrouter', customTerms = [] } = {}) {
    this.translator = resolveTranslationProvider(translationProvider);
    this.optimizer = resolvePromptOptimizer(optimizerProvider);
    this.terms = buildTermList(customTerms);
  }

  /** User's language -> optimized internal-language text, ready for the AEP pipeline. */
  async toInternal(text, { input = 'pt-BR', internal = 'en-US' } = {}) {
    if (input === internal) return text;
    const { protectedText, placeholders } = protect(text, this.terms);
    const translated = await this.translator.translate(protectedText, { from: LANG_CODE[input], to: LANG_CODE[internal] });
    const restored = restore(translated, placeholders);
    return this.optimizer.optimize(restored);
  }

  /** Internal-language AEP text -> user's language, preserving technical terms. */
  async toOutput(text, { internal = 'en-US', output = 'pt-BR' } = {}) {
    if (internal === output || !text) return text;
    const { protectedText, placeholders } = protect(text, this.terms);
    const translated = await this.translator.translate(protectedText, { from: LANG_CODE[internal], to: LANG_CODE[output] });
    return restore(translated, placeholders);
  }
}
