// The simulated BRAS scenes through the real core (Node): anechoic box, reflecting floor material and, for RS5,
// the partial-height partition. Coordinates: BRAS x -> plan x, BRAS y -> plan y, BRAS z -> height.

import type { Core } from '../core-ffi';
import { MATERIAL_STRIDE, WALL_STRIDE } from '../layout';
import { TO_CEILING, type P3, type WorkerScene } from '../scene';
import { BOX, FS, MAT, RS5_WALL_H, RS5_WALL_X, type Six } from './bras-constants';

export interface SimMaterial {
  alpha: Six;
  s: Six;
}

const TL_OPAQUE: Six = [60, 60, 60, 60, 60, 60];
const ANECHOIC: SimMaterial = { alpha: [1, 1, 1, 1, 1, 1], s: [0, 0, 0, 0, 0, 0] };

/** Scene: index 0 floor material, 1 anechoic (walls, ceiling), 2 partition. `partition` adds the RS5 plate. */
export function buildScene(floor: SimMaterial, partition: boolean, yRange: [number, number] = [BOX.y0, BOX.y1]): WorkerScene {
  const mats = [floor, ANECHOIC, { alpha: MAT.mdf25.alpha, s: MAT.mdf25.s }];
  const materials = new Float32Array(mats.length * MATERIAL_STRIDE);
  mats.forEach((m, i) => materials.set([...m.alpha, ...m.s, ...TL_OPAQUE], i * MATERIAL_STRIDE));
  const [y0, y1] = yRange;
  const rows: number[][] = [
    [BOX.x0, y0, BOX.x1, y0, 1, 0, TO_CEILING],
    [BOX.x1, y0, BOX.x1, y1, 1, 0, TO_CEILING],
    [BOX.x1, y1, BOX.x0, y1, 1, 0, TO_CEILING],
    [BOX.x0, y1, BOX.x0, y0, 1, 0, TO_CEILING],
  ];
  if (partition) rows.push([RS5_WALL_X, y0, RS5_WALL_X, y1, 2, 0, RS5_WALL_H]);
  const walls = new Float32Array(rows.length * WALL_STRIDE);
  rows.forEach((r, i) => walls.set(r, i * WALL_STRIDE));
  return { height: BOX.h, walls, materials, floorMat: 0, ceilMat: 1, transmission: false };
}

/** W channel (omni pressure) of the ISM impulse response, padded to `lenS` seconds, and the number of paths. */
export function simulate(core: Core, scene: WorkerScene, src: P3, lis: P3, order: number, diffraction: boolean, lenS = 0.12) {
  core.setScene(scene);
  core.setDiffraction(diffraction);
  core.setDirectivity(0, [1, 1, 1, 1, 1, 1], 0);
  const paths = core.computeEarly(0, src, lis, FS, order, lenS);
  const w = core.ir()[0];
  const x = new Float32Array(Math.round(lenS * FS));
  x.set(w.subarray(0, Math.min(w.length, x.length)));
  return { x, paths, packed: core.paths() };
}
