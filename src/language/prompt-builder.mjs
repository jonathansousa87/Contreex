// PromptBuilder: assembles an objective plus optional context lines into one
// prompt string. Deliberately minimal today — its job is just formatting.
// Once the Context Engine (ROADMAP.md #3) exists, it decides WHAT context to
// include (which files, which memory, which Knowledge Base entries); this
// module's responsibility doesn't grow, it just formats whatever it's given.

export function buildPrompt({ objective, context = [] }) {
  if (!context.length) return objective;
  return `${objective}\n\nContext:\n${context.map((c) => `- ${c}`).join('\n')}`;
}
