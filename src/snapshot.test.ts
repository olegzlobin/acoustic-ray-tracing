// Regression snapshot of the whole core through the real C ABI: for every preset, ISM path count, IR
// digests, T30/C50 per band, Sabine/Eyring, heat-map digest and tail timing at a fixed seed and ray count.
// Not part of the normal run; produce a file with
//   npm run build:wasm && SNAPSHOT_OUT=/tmp/before.json npx vitest run src/snapshot.test.ts
// (SNAPSHOT_WASM=<file> selects another core build), then diff two files: timings are written under
// "bench", everything else must match exactly.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { Core } from './core-ffi';
import { PRESETS } from './presets';
import { toWorkerScene } from './scene';

const OUT = process.env.SNAPSHOT_OUT;
const RAYS = 20000;
const FS = 48000;

/** FNV-1a over the bit patterns of all given arrays, in order. */
function fnv(...arrays: Float32Array[]): string {
  let h = 0x811c9dc5;
  for (const a of arrays) {
    const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
    for (let i = 0; i < u.length; i++) {
      h ^= u[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, '0');
}

describe.skipIf(!OUT)('core snapshot', () => {
  it('writes the snapshot', async () => {
    const c = await Core.fromBytes(readFileSync(process.env.SNAPSHOT_WASM ?? 'src/wasm/core.wasm'));
    const out: Record<string, unknown> = {};
    const bench: Record<string, number> = {};
    for (const preset of PRESETS) {
      for (const tx of [true, false]) {
        const name = `${preset.name}${tx ? '' : ' (opaque)'}`;
        const sc = preset.make();
        c.setScene(toWorkerScene(sc, tx));
        const src = sc.sources[0].pos;
        const lis = sc.listener;
        const paths = c.computeEarly(0, src, lis, FS, 3);
        const early = { paths, irLen: c.ir()[0].length, total: c.totalSamples(), split: c.splitSec(), ir: fnv(...c.ir()), viz: fnv(c.paths()) };
        let best = Infinity;
        for (let rep = 0; rep < 3; rep++) {
          c.lateBegin(0, src, lis, 3, RAYS, 0, 50);
          const t = performance.now();
          c.lateStep(0, RAYS);
          best = Math.min(best, performance.now() - t);
        }
        bench[name] = best;
        c.lateSnapshot(0);
        const m = c.metrics();
        const col = (j: number) => Array.from({ length: 7 }, (_, r) => m[r * 8 + j]);
        const full = {
          ir: fnv(...c.ir()),
          irLen: c.ir()[0].length,
          metrics: fnv(m),
          t30: col(2),
          c50: col(3),
          sabine: col(6),
          eyring: col(7),
          plot: fnv(c.plot()),
          rayviz: fnv(c.rayPaths()),
        };
        const g = c.heatBegin(src, lis[2], RAYS, 0.5, 4000);
        c.heatStep(RAYS);
        const heat = { grid: g ? g.nx * 65536 + g.ny : 0, digest: fnv(c.heatSnapshot()) };
        out[name] = { early, full, heat };
      }
    }
    writeFileSync(OUT!, JSON.stringify({ snapshot: out, bench }, null, 1));
  }, 600000);
});
