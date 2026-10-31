// View-dependent sizing: scale bar, ruler ticks, adaptive grid, zoom-aware icon and line sizes.

/** 1-2-5 sequence from 1 cm to 1 km. */
const NICE_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
/** Lengths offered by the scale bar. */
const SCALE_LENGTHS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];

/** Scale-bar length (m) whose on-screen width (s px per metre) is closest to ~110 px (aims for 80..150 px). */
export function niceScaleLength(s: number): { len: number; px: number } {
  let best = SCALE_LENGTHS[0];
  let bd = Infinity;
  for (const l of SCALE_LENGTHS) {
    const d = Math.abs(Math.log((l * s) / 110));
    if (d < bd) {
      bd = d;
      best = l;
    }
  }
  return { len: best, px: best * s };
}

/** Smallest 1-2-5 step that is at least `minPx` wide on screen. */
function niceStep(s: number, minPx: number): number {
  return NICE_STEPS.find((v) => v * s >= minPx) ?? NICE_STEPS[NICE_STEPS.length - 1];
}

export const fmtMeters = (v: number, step: number) => {
  const dec = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step) - 1e-9));
  const t = v.toFixed(dec);
  return t === '-0' ? '0' : t;
};

interface Tick {
  v: number;
  major: boolean;
  label: string;
}

/** Ruler ticks covering [lo, hi] metres: labelled majors >= 60 px apart, minors in between when they are >= 7 px apart. */
export function rulerTicks(lo: number, hi: number, s: number): Tick[] {
  const major = niceStep(s, 60);
  const mant = Math.round(major / Math.pow(10, Math.floor(Math.log10(major))));
  const div = mant === 2 ? 4 : 5;
  const minor = major / div;
  const withMinor = minor * s >= 7;
  const step = withMinor ? minor : major;
  const out: Tick[] = [];
  const i0 = Math.ceil(lo / step - 1e-9);
  const i1 = Math.floor(hi / step + 1e-9);
  if (i1 - i0 > 2000) return out;
  for (let i = i0; i <= i1; i++) {
    const v = i === 0 ? 0 : i * step;
    const isMajor = !withMinor || i % div === 0;
    out.push({ v, major: isMajor, label: isMajor ? fmtMeters(v, major) : '' });
  }
  return out;
}

/** Grid display: dots every `minor` (a power-of-two multiple of the snap step, >= 9 px) and lines every `major` (1-2-5, >= 50 px). */
export function gridLevels(gridStep: number, s: number): { minor: number; major: number } {
  let minor = gridStep;
  while (minor * s < 9 && minor < 1e4) minor *= 2;
  const major = Math.max(niceStep(s, 50), minor);
  return { minor, major };
}

// ---- zoom-aware icons: physical size with an on-screen minimum (the old fixed pixel size)
const SPEAKER_M = 0.3;
const HEAD_M = 0.2;
const SPEAKER_PX = 28;
export const HEAD_PX = 20;

/** Multiplier of the minimum-size icon (drawn at `minPx`) so that it covers `physicalM` metres at `s` px/m, never below 1. */
const iconScale = (physicalM: number, minPx: number, s: number) => Math.max(1, (physicalM * s) / minPx);
export const speakerScale = (s: number) => iconScale(SPEAKER_M, SPEAKER_PX, s);
export const headScale = (s: number) => iconScale(HEAD_M, HEAD_PX, s);

/** Wall line width in px: constant when zoomed out, slightly thicker when zoomed in (capped). */
export const wallWidthPx = (s: number) => Math.min(7, Math.max(4, 4 + (s - 80) / 80));
