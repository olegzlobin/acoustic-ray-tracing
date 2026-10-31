// Generic cooperative job queue of the compute worker. Pure (no worker globals, no clock) so it can be unit-tested.
//
// * One live job per key: submitting a job under a key replaces (and cancels) the previous one, i.e. latest wins.
// * Lowest priority number runs first; jobs of equal priority are served round-robin (a job that is not finished
//   goes to the back), one-shot jobs therefore run in submission order.
// * A job is run in small `step()` units; the queue yields to the event loop after every unit so newer requests
//   (queued as messages) can replace or cancel jobs before the next unit starts.

/** A job's `step` returns true when finished, false to be called again, or a successor job (same key) that replaces it. */
export type StepResult = boolean | Job;

export interface Job {
  /** Latest-wins slot, e.g. `compute:0`, `heat`. */
  key: string;
  /** Lower runs first. */
  priority: number;
  /** One unit of work (should take about a chunk, ~10 ms). */
  step(): StepResult;
  /** Called when the job is replaced or cancelled before it finished. */
  cancel?(): void;
}

export interface QueueOptions {
  /** Let the event loop run (the worker uses a MessageChannel macrotask). */
  yield: () => Promise<void>;
  /** A step threw; the job has been dropped already. */
  onError?: (e: unknown, job: Job) => void;
}

export class JobQueue {
  private jobs = new Map<string, Job>();
  private loop: Promise<void> | null = null;
  private running = false;

  constructor(private opts: QueueOptions) {}

  get size() {
    return this.jobs.size;
  }
  has(key: string) {
    return this.jobs.has(key);
  }

  /** Add a job, replacing (and cancelling) a live job with the same key. A replaced job keeps its queue position. */
  submit(job: Job) {
    const old = this.jobs.get(job.key);
    this.jobs.set(job.key, job);
    if (old && old !== job) old.cancel?.();
  }

  cancel(key: string) {
    const j = this.jobs.get(key);
    if (!j) return;
    this.jobs.delete(key);
    j.cancel?.();
  }

  /** Cancel every job matching the predicate (error recovery, shutdown). */
  cancelWhere(pred: (j: Job) => boolean) {
    for (const j of [...this.jobs.values()]) if (pred(j)) this.cancel(j.key);
  }

  /** Next job: lowest priority number, first in queue order among equals. */
  private pick(): Job | undefined {
    let best: Job | undefined;
    for (const j of this.jobs.values()) if (!best || j.priority < best.priority) best = j;
    return best;
  }

  private stepOne(job: Job) {
    let r: StepResult;
    try {
      r = job.step();
    } catch (e) {
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      this.opts.onError?.(e, job);
      return;
    }
    if (this.jobs.get(job.key) !== job) return; // replaced or cancelled while it ran
    if (r === true) this.jobs.delete(job.key);
    else if (r === false) {
      this.jobs.delete(job.key); // round-robin: to the back
      this.jobs.set(job.key, job);
    } else {
      if (r.key === job.key) this.jobs.set(job.key, r); // keeps the queue position
      else {
        this.jobs.delete(job.key);
        this.opts.onError?.(new Error(`successor key ${r.key} differs from ${job.key}`), job);
      }
    }
  }

  /** Run until the queue is empty. Returns the running loop if there is one already. Call after every submit. */
  run(): Promise<void> {
    if (!this.running) {
      this.running = true;
      this.loop = this.drain();
    }
    return this.loop!;
  }

  private async drain() {
    try {
      for (let j = this.pick(); j; j = this.pick()) {
        this.stepOne(j);
        await this.opts.yield();
      }
    } finally {
      this.running = false; // also when the queue was empty and nothing awaited
    }
  }
}

/** Adaptive unit size: grows or shrinks the work per step so one step takes about `targetMs`. */
export class Chunker {
  size: number;
  constructor(private o: { init: number; min: number; max: number; targetMs: number; now: () => number }) {
    this.size = o.init;
  }
  /** Run `work(n)` with n = min(size, remaining) and adapt the size to the measured duration. */
  step<R>(remaining: number, work: (n: number) => R): R {
    const t = this.o.now();
    const r = work(Math.min(this.size, remaining));
    const dt = this.o.now() - t;
    this.size = Math.max(this.o.min, Math.min(this.o.max, Math.round(this.size * (this.o.targetMs / Math.max(dt, 0.5)))));
    return r;
  }
}
