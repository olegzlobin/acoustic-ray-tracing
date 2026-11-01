// Light mode for phones: on by default on a small touch screen, the user's choice is remembered.

const KEY = 'art.lite.v1';

export const isPhone = (coarsePointer: boolean, shortSide: number) => coarsePointer && shortSide < 768;

/** Analysis settings of each mode: paths of order 3 are most of the cost of a position change. */
export const analysisFor = (lite: boolean) => (lite ? { maxOrder: 2, rays: 10000 } : { maxOrder: 3, rays: 20000 });

/** Canvas resolution limit in light mode: 3x screens fill nine times the pixels for little visible gain. */
const LITE_MAX_DPR = 1.5;

function initial(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v === '1' || v === '0') return v === '1';
  } catch {
    /* storage unavailable: detect */
  }
  return typeof matchMedia === 'function' && isPhone(matchMedia('(pointer: coarse)').matches, Math.min(screen.width, screen.height));
}

class PerfMode {
  lite = $state(initial());
  set(on: boolean) {
    this.lite = on;
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
  }
}
export const perf = new PerfMode();

export const canvasDpr = () => {
  const dpr = window.devicePixelRatio || 1;
  return perf.lite ? Math.min(dpr, LITE_MAX_DPR) : dpr;
};
