// PromptOptimizerProvider interface: { name, optimize(prompt) -> Promise<string> }.
// OpenRouter (a free-tier-capable model) is the first implementation. If no
// API key is configured, optimize() is a no-op that returns the prompt
// unchanged — optimization is a quality improvement, never something a
// missing credential should be allowed to fail the whole pipeline over.
// Swap models/providers (DeepSeek, GLM, Qwen, a local model) by adding an
// entry to PROMPT_OPTIMIZER_PROVIDERS.

const SYSTEM_PROMPT =
  'You improve English technical prompts for clarity and unambiguous instructions to an AI coding agent. Reply with ONLY the improved prompt text — no preamble, no explanation, no markdown fences. Preserve every technical term, file name, and code identifier exactly as given, character for character.';

export const openRouterOptimizer = {
  name: 'openrouter',
  async optimize(prompt, { model = 'deepseek/deepseek-chat-v3-0324:free' } = {}) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return prompt;

    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return prompt;
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() || prompt;
    } catch {
      return prompt; // network hiccup, timeout, whatever — degrade to the unoptimized prompt
    }
  },
};

export const PROMPT_OPTIMIZER_PROVIDERS = { openrouter: openRouterOptimizer };

export function resolvePromptOptimizer(name = 'openrouter') {
  const provider = PROMPT_OPTIMIZER_PROVIDERS[name];
  if (!provider) throw new Error(`Unknown prompt optimizer provider '${name}'. Known: ${Object.keys(PROMPT_OPTIMIZER_PROVIDERS).join(', ')}`);
  return provider;
}
