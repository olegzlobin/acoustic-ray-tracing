// Source directivity presets. The core only evaluates the pattern it is given (`Core.setDirectivity`), so the
// numbers live here and nowhere else.
//   g_b(cos θ) = max(α_b + (1 − α_b)·cos θ, floor)     per octave band 125 Hz .. 4 kHz, amplitude
// θ is the angle between the emission direction and the source's facing axis (`Source.angle`, horizontal).
// α = 1 is omnidirectional; smaller α narrows the beam (a cardioid-like family); `floor` keeps a little sound behind.

import type { Source } from './scene';

export type Directivity = 'omni' | 'speaker' | 'voice';
export const DIRECTIVITIES: Directivity[] = ['omni', 'speaker', 'voice'];

export interface DirectivityPattern {
  /** One value per band, 125 Hz .. 4 kHz. */
  alpha: readonly number[];
  floor: number;
}

export const DIRECTIVITY: Record<Directivity, DirectivityPattern> = {
  omni: { alpha: [1, 1, 1, 1, 1, 1], floor: 0 },
  speaker: { alpha: [0.95, 0.85, 0.7, 0.55, 0.4, 0.3], floor: 0.1 },
  voice: { alpha: [1.0, 0.95, 0.85, 0.7, 0.6, 0.5], floor: 0.25 },
};

/** Amplitude gain of band `band` (0..5) at `cosTheta` = cos(angle to the facing axis). */
export function directivityGain(kind: Directivity, band: number, cosTheta: number): number {
  const { alpha, floor } = DIRECTIVITY[kind];
  return Math.max(alpha[band] + (1 - alpha[band]) * cosTheta, floor);
}

/** What a compute / heat request carries to the core for a source. */
export interface DirectivityArgs {
  /** Facing azimuth, radians CCW from +x. */
  facing: number;
  alpha: number[];
  floor: number;
}

export function directivityArgs(src: Pick<Source, 'directivity' | 'angle'>): DirectivityArgs {
  const p = DIRECTIVITY[src.directivity];
  return { facing: src.angle, alpha: [...p.alpha], floor: p.floor };
}

/** A mono source with a pattern is drawn and handled turned (arrow + handle on the plan); omni looks as before. */
export const isDirectional = (src: Pick<Source, 'directivity'>): boolean => src.directivity !== 'omni';
