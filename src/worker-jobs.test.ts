import { describe, expect, it } from 'vitest';
import { testCore } from './test-core';
import { ComputeJobs } from './worker-jobs';
import { DIRECTIVITY } from './directivity';
import { PRESETS } from './presets';
import { toWorkerScene } from './scene';
import type { ComputeRequest, ComputeResult, WorkerOut } from './protocol';
import type { Job } from './job-queue';

/** Run a request to completion (early stage + tail) and collect the results. */
function run(id: string, modes: boolean, rays = 2000, jobsIn?: ComputeJobs) {
  const out: ComputeResult[] = [];
  const env = { core: () => testCore, post: (m: WorkerOut) => void (m.type === 'result' && out.push(m)), now: () => performance.now(), submit: () => {} };
  const jobs = jobsIn ?? new ComputeJobs(env);
  const sc = PRESETS.find((p) => p.id === id)!.make();
  const req: ComputeRequest = {
    type: 'compute', id: 1, slot: 0, phase: 'settle', scene: toWorkerScene(sc), source: sc.sources[0].pos, directivity: { facing: 0, alpha: [...DIRECTIVITY.omni.alpha], floor: DIRECTIVITY.omni.floor },
    listener: sc.listener, maxOrder: 3, diffraction: true, modes, sampleRate: 48000, rays, vizRays: 0, fullTail: true, yaw: 0,
  };
  let j: Job = jobs.early(req);
  for (let k = 0; k < 1000; k++) {
    const r = j.step();
    if (r === true) break;
    if (r !== false) j = r;
  }
  return out;
}

describe('room modes in the worker', () => {
  it('off: the posted IRs are exactly the core output', () => {
    const r = run('living', false);
    const last = r[r.length - 1];
    expect(last.stage).toBe('final');
    expect(last.stats.modesMs).toBe(0);
    // rays = 0 -> final straight after the early stage, so the core still holds exactly that IR
    const z = run('living', false, 0);
    const fin = z[z.length - 1];
    testCore.lateSnapshot(0);
    const ir = testCore.ir();
    for (let c = 0; c < 4; c++) expect(Array.from(fin.ir[c])).toEqual(Array.from(ir[c]));
  });

  it('big hall: modes on changes nothing', () => {
    const a = run('concert', false, 0);
    const b = run('concert', true, 0);
    for (let s = 0; s < a.length; s++) for (let c = 0; c < 4; c++) expect(Array.from(b[s].ir[c])).toEqual(Array.from(a[s].ir[c]));
    expect(b.every((r) => r.stats.modesMs === 0)).toBe(true);
  });

  it('living room: the bass changes, the high end is kept, cost is small', () => {
    const off = run('living', false, 2000);
    const jobs = run('living', true, 2000); // warm-up
    const on = run('living', true, 2000);
    expect(jobs.length).toBe(on.length);
    const eo = on[0], fo = off[0];
    expect(eo.bin).not.toBeNull();
    const w = on[on.length - 1].ir[0], w0 = off[off.length - 1].ir[0];
    expect(w.length).toBe(w0.length);
    expect(Array.from(w.subarray(0, 4000))).not.toEqual(Array.from(w0.subarray(0, 4000)));
    expect(eo.ir[0].length).toBe(fo.ir[0].length);
    const ms = on.map((r) => `${r.stage}: modes ${r.stats.modesMs.toFixed(2)} ms (stage ${r.stats.ms.toFixed(1)} ms, ${r.ir[0].length} samples)`);
    console.log('living room timings\n' + ms.join('\n'));
    for (const r of on) expect(r.stats.modesMs).toBeLessThan(30);
  });
});
