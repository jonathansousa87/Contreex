// Normalizer — turns raw, possibly markdown-wrapped CLI stdout into a clean
// JSON string ready for JSON.parse(). Every agent adapter's raw text passes
// through here before validation; no downstream code ever sees CLI-specific
// formatting quirks.

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i;

export function normalize(rawText) {
  const unfenced = stripFence(rawText);
  return extractBalancedJson(unfenced);
}

function stripFence(text) {
  const m = text.match(FENCE_RE);
  return m ? m[1].trim() : text.trim();
}

// Finds the first { or [ and returns the matching balanced substring,
// tracking string literals so braces inside string values don't miscount.
function extractBalancedJson(text) {
  const startIdx = findFirstJsonStart(text);
  if (startIdx === -1) return text;

  const startChar = text[startIdx];
  const endChar = startChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === startChar) depth++;
    else if (ch === endChar) {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  // Unterminated — return best-effort slice; JSON.parse will raise a clear error.
  return text.slice(startIdx);
}

function findFirstJsonStart(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') return i;
  }
  return -1;
}

// Agents without native schema enforcement (agy, mimo) sometimes reply with a
// plausible-but-wrong severity word instead of the exact enum we asked for —
// e.g. mimo returned "major" where the AEP "review" schema requires one of
// low/medium/high/critical. Rather than fail validation on a synonym, map
// known variants to the canonical value before the Validator ever sees it.
const SEVERITY_SYNONYMS = {
  minor: 'low',
  info: 'low',
  informational: 'low',
  moderate: 'medium',
  major: 'high',
  blocker: 'critical',
  urgent: 'critical',
  severe: 'critical',
};

export function canonicalizeReviewSeverities(data) {
  if (!data || !Array.isArray(data.findings)) return data;
  for (const finding of data.findings) {
    if (typeof finding?.severity !== 'string') continue;
    const key = finding.severity.trim().toLowerCase();
    if (SEVERITY_SYNONYMS[key]) finding.severity = SEVERITY_SYNONYMS[key];
  }
  return data;
}
