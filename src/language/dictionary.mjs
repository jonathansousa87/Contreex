// Technical term preservation across machine translation. Terms get swapped
// for placeholder tokens before translation — verified empirically that a
// token like TERMPLACEHOLDER0 survives Google Translate untouched in both
// directions — and restored to their original text afterward.

const DEFAULT_TERMS = [
  'Worktree',
  'Agent',
  'Reviewer',
  'Implementer',
  'Orchestrator',
  'Pipeline',
  'Pipeline Engine',
  'Context Engine',
  'Consensus Engine',
  'Language Engine',
  'Knowledge Base',
  'Decision Memory',
  'Prompt Builder',
  'Prompt Optimizer',
  'Prompt Engineering',
  'MCP',
  'AEP',
  'API',
  'CLI',
  'JSON',
  'YAML',
  'JSON Schema',
  'git',
  'npm',
  'Node.js',
  'JavaScript',
  'TypeScript',
];

// Auto-detects code-shaped tokens the curated list can't enumerate in advance:
// anything in backticks, camelCase/PascalCase identifiers, snake_case, ALL_CAPS
// acronyms, and file.ext names.
const CODE_TOKEN_RE =
  /`[^`]+`|\b[a-z]+[A-Z][a-zA-Z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*\b|\b\w+_\w+\b|\b[a-zA-Z0-9_-]+\.[a-zA-Z]{1,5}\b|\b[A-Z]{2,}\b/g;

export function buildTermList(customTerms = []) {
  return [...new Set([...DEFAULT_TERMS, ...customTerms])];
}

export function protect(text, terms) {
  const placeholders = new Map(); // placeholder token -> original text
  let counter = 0;
  let out = text;

  // Longest-first so e.g. "JSON Schema" is claimed before a lone "JSON" would be.
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi');
    out = out.replace(re, (match) => {
      const token = `TERMPLACEHOLDER${counter++}`;
      placeholders.set(token, match);
      return token;
    });
  }

  out = out.replace(CODE_TOKEN_RE, (match) => {
    const clean = match.replace(/^`|`$/g, '');
    const token = `TERMPLACEHOLDER${counter++}`;
    placeholders.set(token, clean);
    return token;
  });

  return { protectedText: out, placeholders };
}

export function restore(text, placeholders) {
  let out = text;
  for (const [token, original] of placeholders) {
    // MT occasionally lowercases a token or adds a space inside it — cover the common variants.
    out = out
      .replaceAll(token, original)
      .replaceAll(token.toLowerCase(), original)
      .replaceAll(token.replace(/(\d+)$/, ' $1'), original);
  }
  return out;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
