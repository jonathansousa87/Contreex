// TranslationProvider interface: { name, translate(text, {from, to}) -> Promise<string> }.
// Google's unofficial free endpoint (no API key, no billing) is the first
// implementation — the same one browser extensions use. No SLA, and it has an
// undocumented per-request length limit (fine for prompts/summaries; a long
// document would need chunking, not implemented yet). Swap in a paid provider
// (Cloud Translation API, DeepL, Azure) by adding an entry to
// TRANSLATION_PROVIDERS — nothing else in the codebase needs to change.

export const googleTranslateProvider = {
  name: 'google',
  async translate(text, { from, to }) {
    if (!text || !text.trim()) return text;
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Google Translate request failed: ${res.status}`);
    const data = await res.json();
    // data[0] is an array of [translatedChunk, originalChunk, ...] segments.
    return data[0].map((segment) => segment[0]).join('');
  },
};

export const TRANSLATION_PROVIDERS = { google: googleTranslateProvider };

export function resolveTranslationProvider(name = 'google') {
  const provider = TRANSLATION_PROVIDERS[name];
  if (!provider) throw new Error(`Unknown translation provider '${name}'. Known: ${Object.keys(TRANSLATION_PROVIDERS).join(', ')}`);
  return provider;
}
