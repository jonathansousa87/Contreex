// Phase 0 capability probe — adapter definitions for each candidate CLI.
// Each adapter only describes how to invoke the CLI; probe/run.mjs does the testing.

const JSON_PROBE_PROMPT =
  'Reply with nothing except this exact JSON object, no markdown fences, no extra text: {"status":"ok","value":42}';
const PLAIN_PROMPT = 'Reply with exactly one word: OK';
const WRITE_PROMPT = (filename) =>
  `Create a file named ${filename} in the current directory containing exactly the text OK. Do not ask for confirmation.`;

export const agents = [
  {
    name: 'claude',
    cmd: 'claude',
    versionArgs: ['--version'],
    headlessArgs: (prompt) => ['-p', prompt, '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--disallowedTools', 'Write Edit Bash'],
    jsonPromptFor: JSON_PROBE_PROMPT,
    plainArgs: (prompt) => ['-p', prompt, '--permission-mode', 'bypassPermissions', '--disallowedTools', 'Write Edit Bash'],
    plainPromptFor: PLAIN_PROMPT,
    badArgs: ['-p', 'hi', '--this-flag-does-not-exist'],
    allowWriteArgs: (filename) => ['-p', WRITE_PROMPT(filename), '--permission-mode', 'bypassPermissions'],
    // bypassPermissions ignores disallowedTools entirely (confirmed empirically) — dontAsk is the
    // headless-safe deny-by-default mode: denies anything not explicitly allowlisted, no hang, no bypass.
    denyWriteArgs: (filename) => ['-p', WRITE_PROMPT(filename), '--permission-mode', 'dontAsk'],
    // no native CLI-level timeout flag found in --help; relies on external wrapper
    nativeTimeoutArgs: null,
    extractJson: (stdout) => {
      // --output-format json wraps the whole turn; the model's reply text is usually in a "result" field.
      const outer = JSON.parse(stdout);
      const text = outer.result ?? outer.content ?? stdout;
      return typeof text === 'string' ? JSON.parse(extractJsonSubstring(text)) : text;
    },
  },
  {
    name: 'codex',
    cmd: 'codex',
    versionArgs: ['--version'],
    headlessArgs: (prompt, cwd) => ['exec', prompt, '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', cwd],
    jsonPromptFor: JSON_PROBE_PROMPT,
    plainArgs: (prompt, cwd) => ['exec', prompt, '--sandbox', 'read-only', '--skip-git-repo-check', '-C', cwd],
    plainPromptFor: PLAIN_PROMPT,
    badArgs: ['exec', 'hi', '--this-flag-does-not-exist'],
    allowWriteArgs: (filename, cwd) => ['exec', WRITE_PROMPT(filename), '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', cwd],
    denyWriteArgs: (filename, cwd) => ['exec', WRITE_PROMPT(filename), '--sandbox', 'read-only', '--skip-git-repo-check', '-C', cwd],
    nativeTimeoutArgs: null,
    extractJson: (stdout) => {
      // --json emits JSONL events; the final agent message is the last parseable
      // event carrying a "message"/"text"-shaped payload. Fall back to scanning all lines.
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const evt = JSON.parse(lines[i]);
          // real shape: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
          const text = evt.item?.type === 'agent_message' ? evt.item.text : (evt.msg?.message ?? evt.message ?? evt.text);
          if (typeof text === 'string') return JSON.parse(extractJsonSubstring(text));
        } catch {
          // not this line, keep scanning
        }
      }
      throw new Error('no parseable JSON event found in codex --json stream');
    },
  },
  {
    name: 'agy',
    cmd: 'agy',
    versionArgs: ['--version'],
    headlessArgs: (prompt) => ['-p', prompt, '--dangerously-skip-permissions', '--print-timeout', '60s'],
    jsonPromptFor: JSON_PROBE_PROMPT,
    plainArgs: (prompt) => ['-p', prompt, '--dangerously-skip-permissions', '--print-timeout', '60s'],
    plainPromptFor: PLAIN_PROMPT,
    badArgs: ['-p', 'hi', '--this-flag-does-not-exist'],
    // --add-dir scopes agy to this directory — without it, agy writes to its own
    // scratch dir (~/.gemini/antigravity-cli/scratch) regardless of cwd (confirmed empirically).
    allowWriteArgs: (filename, cwd) => ['-p', WRITE_PROMPT(filename), '--add-dir', cwd, '--dangerously-skip-permissions', '--print-timeout', '60s'],
    denyWriteArgs: (filename, cwd) => ['-p', WRITE_PROMPT(filename), '--add-dir', cwd, '--mode', 'plan', '--print-timeout', '60s'],
    // agy advertises a native timeout via --print-timeout; test it directly (see run.mjs)
    nativeTimeoutArgs: (prompt) => ['-p', prompt, '--dangerously-skip-permissions', '--print-timeout', '3s'],
    extractJson: (stdout) => JSON.parse(extractJsonSubstring(stdout)),
  },
];

function extractJsonSubstring(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1);
  return text;
}
