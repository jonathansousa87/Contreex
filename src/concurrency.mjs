// A simple counting semaphore limiting how many agent CLI subprocesses can
// be in flight at once. Deliberately NOT a full Scheduler (queue, priority,
// distributed execution) — that's real scope with no real use case yet
// (ROADMAP.md "Adiado indefinidamente"). This solves the actual problem
// that exists today: a pipeline's `parallel` block can spawn several CLI
// processes at once via Promise.all, and nothing currently caps that.
//
// A shared default instance covers the whole process (the real risk is too
// many subprocesses system-wide, regardless of which AgentManager triggered
// them); pass a custom instance to AgentManager for test isolation.

export class Semaphore {
  constructor(limit) {
    if (!(limit > 0)) throw new Error('Semaphore limit must be a positive number');
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
  }

  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// Override with CONTREEX_MAX_CONCURRENT_AGENTS if the default doesn't fit a
// given machine — 4 concurrent CLI subprocesses is a reasonable default for
// a personal workstation, not derived from any measurement.
const envLimit = Number(process.env.CONTREEX_MAX_CONCURRENT_AGENTS);
export const DEFAULT_CONCURRENCY_LIMIT = Number.isInteger(envLimit) && envLimit > 0 ? envLimit : 4;

export const defaultSemaphore = new Semaphore(DEFAULT_CONCURRENCY_LIMIT);
