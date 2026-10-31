// Stereo pair: a source playing a stereo file becomes two point emitters (L / R) around its centre.

import type { P3, Source } from './scene';

/**
 * A pair is active when the source plays a loaded file with at least two channels and stereo is on.
 * (Generated signals and the microphone stay mono points; with stereo off the file is summed to mono.)
 */
export const isPairActive = (src: Pick<Source, 'signal' | 'stereo'>, fileChannels: number): boolean => src.signal === 'file' && src.stereo && fileChannels >= 2;

/**
 * Positions of the left and right speaker: the centre ± (width / 2) across the direction the pair faces
 * (`angle`, radians CCW from +x, like the listener's yaw). L is on the left of someone standing in front
 * of the pair and looking at it: facing +x, L is at −y. The pair keeps its placement when the listener
 * moves, like real loudspeakers. Same height for both.
 */
export function pairPositions(src: Pick<Source, 'pos' | 'width' | 'angle'>): { l: P3; r: P3 } {
  const h = src.width / 2;
  const lx = Math.sin(src.angle) * h;
  const ly = -Math.cos(src.angle) * h;
  return { l: [src.pos[0] + lx, src.pos[1] + ly, src.pos[2]], r: [src.pos[0] - lx, src.pos[1] - ly, src.pos[2]] };
}

/** Angle that turns a pair at `pos` to face the listener (used once, when a stereo file is loaded). */
export const facing = (pos: readonly number[], listener: readonly number[]): number =>
  Math.atan2(listener[1] - pos[1], listener[0] - pos[0]);

/** Angle in [0, 2π). */
export const wrapAngle = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
