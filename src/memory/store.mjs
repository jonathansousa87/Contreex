// Memory of decisions, not conversation. One JSONL record per completed
// pipeline run — distilled, not the full AEP document (that already lives
// wherever the caller wants to keep it; memory only needs enough to answer
// "have we seen something like this before, and how did it go").

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MEMORY_DIR = join(homedir(), '.contreex', 'memory');
const RUNS_FILE = join(MEMORY_DIR, 'runs.jsonl');

export function recordRun(record) {
  mkdirSync(MEMORY_DIR, { recursive: true });
  appendFileSync(RUNS_FILE, JSON.stringify(record) + '\n');
}

export function readAllRuns() {
  if (!existsSync(RUNS_FILE)) return [];
  return readFileSync(RUNS_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
