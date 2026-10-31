import { describe, expect, it } from 'vitest';
import { Chunker, JobQueue, type Job, type StepResult } from './job-queue';

/** Job that runs `n` steps and records each step in `log`. */
function job(log: string[], key: string, priority: number, n = 1, extra: Partial<Job> = {}): Job {
  let left = n;
  return { key, priority, step: () => (log.push(key), --left <= 0), ...extra };
}

function setup(onYield?: (n: number) => void) {
  let yields = 0;
  const errors: unknown[] = [];
  const q = new JobQueue({
    yield: async () => {
      yields++;
      onYield?.(yields);
    },
    onError: (e) => errors.push(e),
  });
  return { q, errors, yields: () => yields };
}

describe('JobQueue', () => {
  it('runs lower priority numbers first, one-shot jobs of equal priority in submission order', async () => {
    const log: string[] = [];
    const { q } = setup();
    q.submit(job(log, 'prewarm', 3));
    q.submit(job(log, 'a', 0));
    q.submit(job(log, 'heat', 2));
    q.submit(job(log, 'b', 0));
    q.submit(job(log, 'tail', 1));
    await q.run();
    expect(log).toEqual(['a', 'b', 'tail', 'heat', 'prewarm']);
    expect(q.size).toBe(0);
  });

  it('serves jobs of equal priority round-robin', async () => {
    const log: string[] = [];
    const { q } = setup();
    q.submit(job(log, 'x', 1, 3));
    q.submit(job(log, 'y', 1, 2));
    await q.run();
    expect(log).toEqual(['x', 'y', 'x', 'y', 'x']);
  });

  it('a higher priority job submitted while another runs goes next, the lower one resumes afterwards', async () => {
    const log: string[] = [];
    const { q } = setup((n) => {
      if (n === 1) q.submit(job(log, 'early', 0));
    });
    q.submit(job(log, 'tail', 1, 3));
    await q.run();
    expect(log).toEqual(['tail', 'early', 'tail', 'tail']);
  });

  it('yields to the event loop after every unit', async () => {
    const log: string[] = [];
    const { q, yields } = setup();
    q.submit(job(log, 'a', 0, 4));
    await q.run();
    expect(yields()).toBe(4);
  });

  it('latest wins per key: the replaced job is cancelled and never steps again', async () => {
    const log: string[] = [];
    const cancelled: string[] = [];
    const { q } = setup();
    q.submit(job(log, 'slot0', 1, 3, { cancel: () => cancelled.push('old') }));
    q.submit(job(log, 'other', 1, 1));
    const fresh = job([], 'slot0', 1, 1);
    q.submit(fresh);
    expect(cancelled).toEqual(['old']);
    expect(q.size).toBe(2);
    await q.run();
    expect(log).toEqual(['other']); // the replaced job never ran
  });

  it('a replaced job keeps its queue position', async () => {
    const log: string[] = [];
    const { q } = setup();
    q.submit(job(log, 'a', 0));
    q.submit(job(log, 'b', 0));
    q.submit(job(log, 'a', 0)); // replaces a, still first
    await q.run();
    expect(log).toEqual(['a', 'b']);
  });

  it('a job replaced by a newer one during its own step is not re-queued', async () => {
    const log: string[] = [];
    const { q } = setup();
    const old: Job = {
      key: 'k',
      priority: 0,
      step: () => {
        log.push('old');
        q.submit(job(log, 'k', 0, 1)); // newer request arrives mid-step
        return false;
      },
    };
    q.submit(old);
    await q.run();
    expect(log).toEqual(['old', 'k']);
  });

  it('cancels by key and by predicate and calls cancel hooks', () => {
    const cancelled: string[] = [];
    const { q } = setup();
    for (const [key, p] of [['a', 0], ['b', 1], ['c', 2], ['d', 3]] as const) q.submit({ key, priority: p, step: () => true, cancel: () => cancelled.push(key) });
    q.cancel('a');
    q.cancel('missing');
    q.cancelWhere((j) => j.priority >= 2 && j.priority < 3);
    expect(cancelled).toEqual(['a', 'c']);
    expect(q.has('b') && q.has('d') && !q.has('a') && !q.has('c')).toBe(true);
  });

  it('a cancelled job is not stepped', async () => {
    const log: string[] = [];
    const { q } = setup((n) => {
      if (n === 1) q.cancel('tail');
    });
    q.submit(job(log, 'tail', 1, 5));
    await q.run();
    expect(log).toEqual(['tail']);
  });

  it('a successor takes over the key and queue position, with its own priority', async () => {
    const log: string[] = [];
    const { q } = setup();
    const tail = job(log, 'k', 1, 2);
    q.submit({ key: 'k', priority: 0, step: (): StepResult => (log.push('early'), tail) });
    q.submit(job(log, 'heat', 2));
    q.submit(job(log, 'mid', 0));
    await q.run();
    expect(log).toEqual(['early', 'mid', 'k', 'k', 'heat']);
  });

  it('drops a throwing job, reports it and keeps running the rest', async () => {
    const log: string[] = [];
    const { q, errors } = setup();
    q.submit({ key: 'bad', priority: 0, step: () => { throw new Error('boom'); } });
    q.submit(job(log, 'good', 1));
    await q.run();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('boom');
    expect(log).toEqual(['good']);
  });

  it('run() on an empty queue resolves and does not wedge later runs', async () => {
    const log: string[] = [];
    const { q } = setup();
    await q.run();
    q.submit(job(log, 'a', 0));
    await q.run();
    expect(log).toEqual(['a']);
  });

  it('run() while running returns the same loop; a later submit after draining can run again', async () => {
    const log: string[] = [];
    const { q } = setup();
    q.submit(job(log, 'a', 0));
    const p = q.run();
    expect(q.run()).toBe(p);
    await p;
    q.submit(job(log, 'b', 0));
    await q.run();
    expect(log).toEqual(['a', 'b']);
  });
});

describe('Chunker', () => {
  const clock = (dt: number) => {
    let t = 0;
    return { now: () => t, work: () => { t += dt; } };
  };

  it('grows the unit when work is fast and shrinks it when slow, within bounds', () => {
    const c = clock(1);
    const ch = new Chunker({ init: 1000, min: 250, max: 5000, targetMs: 12, now: c.now });
    ch.step(1e9, c.work); // 1 ms for 1000 -> x12
    expect(ch.size).toBe(5000); // clamped to max
    const slow = clock(120);
    const ch2 = new Chunker({ init: 1000, min: 250, max: 5000, targetMs: 12, now: slow.now });
    ch2.step(1e9, slow.work); // 120 ms -> x0.1
    expect(ch2.size).toBe(250); // clamped to min (100 < 250)
    const mid = clock(6);
    const ch3 = new Chunker({ init: 1000, min: 250, max: 5000, targetMs: 12, now: mid.now });
    ch3.step(1e9, mid.work);
    expect(ch3.size).toBe(2000);
  });

  it('limits the unit to the remaining work and passes the count through', () => {
    const c = clock(12);
    const ch = new Chunker({ init: 1000, min: 250, max: 5000, targetMs: 12, now: c.now });
    let seen = 0;
    const r = ch.step(300, (n) => ((seen = n), c.work(), 'ok'));
    expect(seen).toBe(300);
    expect(r).toBe('ok');
  });

  it('treats sub-0.5 ms steps as 0.5 ms (bounded growth)', () => {
    const c = clock(0);
    const ch = new Chunker({ init: 100, min: 10, max: 1e9, targetMs: 12, now: c.now });
    ch.step(1e9, c.work);
    expect(ch.size).toBe(2400);
  });
});
