/**
 * Early/late split of an FOA IR at `splitSec`: the early part is the IR times a raised-cosine
 * fade-out of 10 ms ending at the split, the late part is the IR times the complementary fade-in,
 * so early + late equals the full IR exactly. The late IR keeps its leading zero region, so it is
 * correctly delayed on the same timeline.
 */
export const SPLIT_FADE_S = 0.01;

/**
 * The early window for an IR of `n` samples: 1 up to `splitSec - SPLIT_FADE_S`, then a raised-cosine
 * fade to 0 at `splitSec`; length min(n, split) samples (the early part ends there).
 */
export function earlyWindow(n: number, fs: number, splitSec: number): Float32Array {
  const iEnd = Math.min(n, Math.ceil(splitSec * fs));
  const iStart = Math.max(0, Math.round((splitSec - SPLIT_FADE_S) * fs));
  const wins = new Float32Array(iEnd);
  for (let i = 0; i < iEnd; i++) wins[i] = i < iStart ? 1 : 0.5 * (1 + Math.cos((Math.PI * (i - iStart)) / Math.max(1, iEnd - iStart)));
  return wins;
}

/** Channels times the early window, cut at the split (what `splitIR` returns as `early`). */
export function windowEarly(ir: Float32Array[], fs: number, splitSec: number): Float32Array[] {
  const wins = earlyWindow(ir[0].length, fs, splitSec);
  return ir.map((ch) => {
    const e = new Float32Array(wins.length);
    for (let i = 0; i < wins.length; i++) e[i] = ch[i] * wins[i];
    return e;
  });
}

/** `full` minus the windowed ISM IR over the early region: everything but the paths rendered with the HRTF. */
export function subtractEarlyIsm(full: Float32Array[], ism: Float32Array[], fs: number, splitSec: number): Float32Array[] {
  const wins = earlyWindow(full[0].length, fs, splitSec);
  return full.map((ch, c) => {
    const o = ch.slice();
    const m = Math.min(wins.length, ism[c].length);
    for (let i = 0; i < m; i++) o[i] -= ism[c][i] * wins[i];
    return o;
  });
}

export function splitIR(
  ir: Float32Array[],
  fs: number,
  splitSec: number,
  withLate: boolean,
): { early: Float32Array[]; late: Float32Array[] | null } {
  const n = ir[0].length;
  const wins = earlyWindow(n, fs, splitSec);
  const iEnd = wins.length;
  const iStart = Math.max(0, Math.round((splitSec - SPLIT_FADE_S) * fs));
  const early = ir.map((ch) => {
    const e = new Float32Array(iEnd);
    for (let i = 0; i < iEnd; i++) e[i] = ch[i] * wins[i];
    return e;
  });
  if (!withLate) return { early, late: null };
  const late = ir.map((ch) => {
    const l = new Float32Array(n);
    for (let i = iStart; i < iEnd; i++) l[i] = ch[i] * (1 - wins[i]);
    l.set(ch.subarray(iEnd), iEnd);
    return l;
  });
  return { early, late };
}
