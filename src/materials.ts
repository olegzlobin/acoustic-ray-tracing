export interface Material {
  id: string;
  name: string;
  /** Absorption in octave bands 125, 250, 500, 1k, 2k, 4k Hz. */
  alpha: number[];
  /** Scattering coefficient per octave band (125 Hz .. 4 kHz), ISO 17497-1 sense: the share of the reflected energy that leaves diffusely. */
  s: number[];
  /**
   * Sound transmission loss TL in dB for the same octave bands (energy transmission coefficient
   * tau = 10^(-TL/10)). Alpha is the share of energy NOT reflected and includes the transmitted part,
   * so the core uses alpha_eff = max(alpha, tau).
   */
  tl: number[];
  /** Swatch colour used for walls on the plan. */
  color: string;
  /** Library material (read-only; duplicate it to customise). */
  builtin?: boolean;
}

const m = (id: string, name: string, alpha: number[], s: number[], tl: number[], color: string): Material => ({ id, name, alpha, s, tl, color, builtin: true });

// Typical transmission losses (dB) of the usual constructions, 125 Hz .. 4 kHz.
const TL_CONCRETE = [40, 45, 52, 58, 63, 67]; // 150 mm
const TL_MASONRY = [35, 40, 45, 50, 55, 58]; // brick / plastered wall
const TL_DRYWALL = [15, 24, 33, 40, 44, 38]; // single stud, coincidence dip at 4 kHz
const TL_GLASS = [20, 24, 28, 32, 30, 27]; // 6 mm
const TL_WOOD = [15, 18, 22, 25, 27, 25]; // panel / door
const TL_SOLID = [40, 45, 50, 55, 60, 60]; // finishes that sit on a solid backing

// Scattering per band: it grows with frequency once the surface relief (panelling, books, seats, pilasters)
// becomes comparable to the wavelength; smooth walls stay near 0.05-0.1 throughout. The QRD diffuser only
// works above its design cutoff (~500 Hz), hence the steep rise there. Mid bands stay close to the former scalars.
export const BUILTIN_MATERIALS: Material[] = [
  m('concrete', 'Concrete', [0.01, 0.01, 0.02, 0.02, 0.02, 0.03], [0.05, 0.05, 0.05, 0.06, 0.08, 0.1], TL_CONCRETE, '#9aa0a6'),
  m('plaster', 'Plaster', [0.01, 0.02, 0.02, 0.03, 0.04, 0.05], [0.05, 0.07, 0.1, 0.1, 0.12, 0.15], TL_MASONRY, '#d9d4c7'),
  m('wood', 'Wood panel', [0.28, 0.22, 0.17, 0.09, 0.1, 0.11], [0.08, 0.1, 0.13, 0.15, 0.18, 0.2], TL_WOOD, '#c08552'),
  m('carpet', 'Carpet', [0.02, 0.06, 0.14, 0.37, 0.6, 0.65], [0.1, 0.12, 0.15, 0.2, 0.25, 0.3], TL_SOLID, '#7a5c8f'),
  m('panel', 'Acoustic panel', [0.25, 0.6, 0.9, 0.95, 0.95, 0.9], [0.1, 0.15, 0.25, 0.3, 0.35, 0.4], [2, 3, 5, 8, 10, 12], '#4caf8a'),
  m('glass', 'Glass', [0.35, 0.25, 0.18, 0.12, 0.07, 0.04], [0.03, 0.03, 0.04, 0.05, 0.05, 0.05], TL_GLASS, '#7fd1ff'),
  m('brick', 'Brick', [0.03, 0.03, 0.03, 0.04, 0.05, 0.07], [0.05, 0.06, 0.08, 0.1, 0.15, 0.2], TL_MASONRY, '#b5533c'),
  m('tiles', 'Ceramic tiles', [0.01, 0.01, 0.01, 0.02, 0.02, 0.02], [0.02, 0.02, 0.03, 0.03, 0.04, 0.05], TL_SOLID, '#e8f1f2'),
  m('drape', 'Heavy drape', [0.14, 0.35, 0.55, 0.72, 0.7, 0.65], [0.1, 0.15, 0.25, 0.35, 0.45, 0.5], [1, 2, 3, 4, 5, 6], '#a23b5a'),
  m('seats', 'Audience / upholstered seats', [0.39, 0.57, 0.8, 0.94, 0.92, 0.87], [0.3, 0.4, 0.5, 0.6, 0.7, 0.7], TL_SOLID, '#d4a017'),
  m('marble', 'Marble / hard stone', [0.01, 0.01, 0.01, 0.01, 0.02, 0.02], [0.02, 0.02, 0.03, 0.03, 0.03, 0.04], TL_SOLID, '#f2f2f2'),
  m('stone', 'Rough stone', [0.02, 0.02, 0.03, 0.04, 0.05, 0.05], [0.05, 0.08, 0.12, 0.18, 0.25, 0.3], TL_SOLID, '#8d8577'),
  m('drywall', 'Drywall partition', [0.29, 0.1, 0.05, 0.04, 0.07, 0.09], [0.03, 0.04, 0.05, 0.05, 0.06, 0.07], TL_DRYWALL, '#e9e4d8'),
  m('door', 'Door (wood)', [0.14, 0.1, 0.06, 0.08, 0.1, 0.1], [0.05, 0.06, 0.08, 0.1, 0.12, 0.15], TL_WOOD, '#8b5a2b'),
  // Furniture. Tall pieces are full-height boxes; low ones are boxes with a real height (wall z0 / z1).
  // The "floor with ..." materials are the old way to fold low furniture into the floor; presets no longer
  // use them, they stay for scenes saved earlier.
  m('books', 'Bookshelf (books)', [0.3, 0.35, 0.4, 0.45, 0.5, 0.5], [0.3, 0.5, 0.6, 0.7, 0.8, 0.8], TL_WOOD, '#6f4e37'),
  m('furnished', 'Floor with furniture (rug, sofa, tables)', [0.12, 0.18, 0.28, 0.38, 0.42, 0.45], [0.2, 0.3, 0.45, 0.55, 0.65, 0.7], TL_SOLID, '#a08e74'),
  m('desks', 'Floor with desks and chairs', [0.08, 0.12, 0.16, 0.2, 0.24, 0.25], [0.2, 0.3, 0.45, 0.55, 0.6, 0.6], TL_SOLID, '#b8a27f'),
  m('pews', 'Floor with wooden pews', [0.1, 0.12, 0.14, 0.18, 0.18, 0.16], [0.2, 0.3, 0.45, 0.55, 0.6, 0.6], TL_SOLID, '#7b5b3a'),
  m('diffuser', 'Wooden diffuser (QRD)', [0.15, 0.2, 0.2, 0.2, 0.2, 0.2], [0.2, 0.5, 0.8, 0.9, 0.9, 0.85], TL_WOOD, '#c9b28a'),
  // Soft solid furniture (sofa, armchair, bed): a low box with an absorbing, scattering top and sides.
  m('upholstery', 'Upholstered furniture', [0.35, 0.45, 0.6, 0.7, 0.75, 0.75], [0.2, 0.3, 0.45, 0.6, 0.7, 0.7], [10, 12, 15, 18, 20, 22], '#8a6a7d'),
];

export const DEFAULT_MATERIAL_ID = 'plaster';

export function builtinById(id: string): Material | undefined {
  return BUILTIN_MATERIALS.find((x) => x.id === id);
}

export const cloneMaterial = (x: Material): Material => ({ ...x, alpha: [...x.alpha], s: [...x.s], tl: [...x.tl] });

/** TL used for custom materials of files that do not carry transmission data (v1/v2). */
export const DEFAULT_TL = 50;
export const MAX_TL = 70;

/** Energy transmission coefficient of a transmission loss in dB. */
export const tlToTau = (tl: number) => Math.pow(10, -Math.max(0, tl) / 10);

/** Per band: true where tau = 10^(-TL/10) exceeds alpha, so the core raises alpha to tau. */
export const alphaRaised = (m: Pick<Material, 'alpha' | 'tl'>): boolean[] => m.alpha.map((a, i) => tlToTau(m.tl[i]) > a + 1e-9);

const SWATCHES = ['#FF958F', '#F4CD52', '#58CBD6', '#97B6FE', '#E893EF', '#F56D69', '#DAB332', '#25B2BE'];
export const swatchFor = (n: number) => SWATCHES[n % SWATCHES.length];
