// Binary layouts of the data crossing the wasm boundary. The Rust side (core/src/lib.rs) exports the
// same constants through `layout(i)`; `checkLayout` compares them when the core is loaded, so a
// change on one side only fails loudly instead of corrupting data.

/** Octave bands 125 Hz .. 4 kHz. */
const N_BANDS = 6;
/** Floats per wall: x1, y1, x2, y2, material index, z0, z1 (z1 huge = up to the ceiling). */
export const WALL_STRIDE = 7;
/** Floats per material: 6 absorption coefficients, 6 scattering coefficients, 6 transmission losses (dB). */
export const MATERIAL_STRIDE = 3 * N_BANDS;
/** Floats before the polyline of a packed ISM path: order, energy, nPts, crossedWalls. */
export const PATH_HEADER = 4;
/** Metrics table: columns EDT, T20, T30, C50, C80, D50, Sabine, Eyring; rows 6 bands + broadband. */
export const METRIC_COLS = 8;
const METRIC_ROWS = N_BANDS + 1;
/** Heat-map accumulators per cell: E(<50 ms), E(50-80 ms), E(>=80 ms) after the direct sound. */
export const HEAT_BINS = 3;
/** Floats before the ring of a packed room-analysis face: region (0 room, 1 obstacle), depth, net area, nPts. */
export const PLAN_FACE_HEADER = 4;
/** Independent source pipelines in the core. */
const MAX_SLOTS = 16;

/** Output buffers of the core, read with `out_ptr(kind)` / `out_len(kind)` (f32 elements). */
export const OutKind = { IR: 0, PATHS: 1, METRICS: 2, PLOT: 3, RAYVIZ: 4, HEAT: 5, PLAN: 6, BIN: 7 } as const;

/** Same order as the core's `layout(i)`. */
export const LAYOUT = [
  N_BANDS, WALL_STRIDE, MATERIAL_STRIDE, PATH_HEADER, METRIC_COLS, METRIC_ROWS, HEAT_BINS, MAX_SLOTS,
  OutKind.IR, OutKind.PATHS, OutKind.METRICS, OutKind.PLOT, OutKind.RAYVIZ, OutKind.HEAT, OutKind.PLAN, PLAN_FACE_HEADER, OutKind.BIN,
] as const;

/** Throws if the loaded core disagrees with the constants above. */
export function checkLayout(layout: (i: number) => number) {
  LAYOUT.forEach((v, i) => {
    if (layout(i) !== v) throw new Error(`core/UI layout mismatch at constant ${i}: core ${layout(i)}, UI ${v} (rebuild with npm run build:wasm)`);
  });
}

/**
 * Walk a packed ISM path list ([order, energy, nPts, crossedWalls, x0, y0, ...] per path). `visit`
 * gets the index of the path's header and the number of polyline points; the point k is at
 * `buf[i + PATH_HEADER + 2k]`, `buf[i + PATH_HEADER + 2k + 1]`.
 */
export function forEachPath(buf: Float32Array, visit: (i: number, nPts: number) => void) {
  for (let i = 0; i < buf.length; ) {
    const n = buf[i + 2];
    visit(i, n);
    i += PATH_HEADER + 2 * n;
  }
}

/** Walk packed ray polylines ([nPts, x0, y0, ...]); the point k is at `buf[i + 1 + 2k]`, `buf[i + 2 + 2k]`. */
export function forEachRay(buf: Float32Array, visit: (i: number, nPts: number) => void) {
  for (let i = 0; i < buf.length; ) {
    const n = buf[i];
    visit(i, n);
    i += 1 + 2 * n;
  }
}
