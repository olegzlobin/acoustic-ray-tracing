// Constants of the BRAS benchmark scenes RS1 (single reflection from an infinite plate) and RS5 (diffraction at
// an infinite wedge) used by the validation harness.
//
// Source: Brinkmann et al., "A benchmark for room acoustical simulation (BRAS)", TU Berlin, DOI 10.14279/depositonce-6726.3.
// Licence: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).
// Only the scene coordinates and the surface material numbers (octave means of the third-octave values of the
// BRAS surface database, bands 125 Hz .. 4 kHz) are reproduced here. The measured impulse responses are NOT part
// of the repository: they are read at runtime from the directory given by BRAS_DIR (default ~/data/bras).

import type { P3 } from '../scene';

/** Octave band centre frequencies of the engine (Hz). */
export const BAND_HZ = [125, 250, 500, 1000, 2000, 4000] as const;
export const NB = BAND_HZ.length;
export type Six = [number, number, number, number, number, number];

/** Speed of sound at 20.3 degC in the measurement room (m/s). The core uses 343.0. */
export const C_MEAS = 343.4;
export const C_CORE = 343.0;
export const FS = 44100;

export interface SurfaceMaterial {
  alpha: Six;
  s: Six;
}

/** Octave means (mean of the three third-octave values 2^(-1/3) fc, fc, 2^(1/3) fc) from the BRAS surface DB `initial_estimates`. */
export const MAT = {
  tiles: { alpha: [0.01, 0.012, 0.018, 0.022, 0.028, 0.026], s: [0.05, 0.05, 0.061, 0.085, 0.121, 0.171] },
  rockfon0: { alpha: [0.065, 0.161, 0.374, 0.619, 0.758, 0.782], s: [0.05, 0.05, 0.05, 0.06, 0.085, 0.121] },
  rockfon30: { alpha: [0.119, 0.244, 0.459, 0.739, 0.901, 0.869], s: [0.05, 0.05, 0.05, 0.06, 0.085, 0.121] },
  rockfon45: { alpha: [0.011, 0.177, 0.514, 0.759, 0.93, 0.92], s: [0.05, 0.05, 0.05, 0.06, 0.085, 0.121] },
  rockfon60: { alpha: [0.053, 0.134, 0.513, 0.86, 0.978, 0.981], s: [0.05, 0.05, 0.05, 0.06, 0.085, 0.121] },
  // MDF 12 mm structured diffuser: no scattering coefficients in the DB (s filled in by the caller).
  mdf12_30: { alpha: [0.033, 0.083, 0.152, 0.406, 0.535, 0.718] },
  mdf12_45: { alpha: [0.045, 0.176, 0.532, 0.518, 0.721, 0.616] },
  mdf12_60: { alpha: [0.072, 0.061, 0.082, 0.465, 0.756, 0.684] },
  mdf25: { alpha: [0.021, 0.022, 0.028, 0.031, 0.037, 0.051], s: [0.05, 0.05, 0.05, 0.05, 0.055, 0.076] },
} satisfies Record<string, { alpha: Six; s?: Six }>;

/** CSV file (in surface/3 Surface descriptions/_csv/initial_estimates) of every material above, for the runtime cross-check. */
export const MAT_CSV: Record<keyof typeof MAT, string> = {
  tiles: 'mat_Tiles.csv',
  rockfon0: 'mat_RockFonSonarG_00deg.csv',
  rockfon30: 'mat_RockFonSonarG_30deg.csv',
  rockfon45: 'mat_RockFonSonarG_45deg.csv',
  rockfon60: 'mat_RockFonSonarG_60deg.csv',
  mdf12_30: 'mat_MDF12mm_structured_30deg.csv',
  mdf12_45: 'mat_MDF12mm_structured_45deg.csv',
  mdf12_60: 'mat_MDF12mm_structured_60deg.csv',
  mdf25: 'mat_MDF25mmA_plane_00deg.csv',
};

/** Index of the 125 Hz ... 4 kHz third-octave centres in the 20 Hz .. 20 kHz CSV rows. */
export const CSV_OCTAVE_CENTRE_IDX = [8, 11, 14, 17, 20, 23] as const;

// ---------------------------------------------------------------- RS1

export type Rs1Variant = 'Rigid' | 'Absorbing' | 'Diffuse';
/** z offset (m) of all positions and of the reflecting surface above the floor. */
export const RS1_SURFACE_Z: Record<Rs1Variant, number> = { Rigid: 0, Absorbing: 0.02, Diffuse: 0.24 };

/** Rigid-variant positions in metres (BRAS x, y, z): x along the room, z up, floor at z = 0. */
export const RS1_LS: Record<number, P3> = { 1: [2.902, 2.985, 1.5], 2: [3.379, 2.985, 2.121], 3: [4.0, 2.985, 2.598] };
export const RS1_MP: Record<number, P3> = { 1: [8.098, 2.985, 1.5], 2: [7.621, 2.985, 2.121], 3: [7.0, 2.985, 2.598] };
/** Incidence angle from the normal (deg) of the specular pairs LSn-MPn. */
export const RS1_ANGLE: Record<number, 60 | 45 | 30> = { 1: 60, 2: 45, 3: 30 };

// ---------------------------------------------------------------- RS5

export const RS5_LS: Record<number, P3> = {
  1: [2.487, 2.985, 1.235],
  2: [2.487, 2.985, 2.0],
  3: [2.487, 2.985, 3.0],
  4: [2.487, 2.985, 0.135],
};
export const RS5_MP: Record<number, P3> = {
  1: [8.512, 2.985, 1.235],
  2: [8.512, 2.985, 0.006],
  3: [8.512, 2.985, 2.0],
  4: [8.512, 2.985, 3.0],
};
/** MDF 25 mm partition: x position and height (m). */
export const RS5_WALL_X = 5.487;
export const RS5_WALL_H = 2.066;
/** Reference pair of RS5: both at about 3 m from the partition, fully visible. */
export const RS5_REF = { ls: 3, mp: 4 } as const;

/** Anechoic surroundings of the simulated scenes (m). */
export const BOX = { x0: 0, x1: 11, y0: 0, y1: 6, h: 8 } as const;
