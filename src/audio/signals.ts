// Built-in test signals (generated, no bundled audio). All loop seamlessly.

export type { SignalKind } from '../scene';

/** Hand clap: a few quick noise bursts (several palms, not quite together) and a short tail, band-limited around 1.2 kHz, once per 1.5 s. */
export function makeClap(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.round(1.5 * sr), sr);
  const d = buf.getChannelData(0);
  const rand = rng(23);
  const len = Math.round(0.19 * sr);
  const env = (t: number) => {
    let e = 0.55 * Math.exp(-Math.max(0, t - 0.03) / 0.032) * Math.min(1, t / 0.03);
    for (const [at, a] of [[0, 0.7], [0.011, 0.85], [0.021, 0.75], [0.03, 1]]) if (t >= at) e = Math.max(e, a * Math.exp(-(t - at) / 0.0035));
    return e;
  };
  for (let i = 0; i < len; i++) d[i] = rand() * env(i / sr);
  biquad(d, bandpass(sr, 1200, 0.9));
  biquad(d, shelf(sr, 'low', 500, -4));
  biquad(d, shelf(sr, 'high', 5000, 4));
  let m = 0;
  for (const v of d) m = Math.max(m, Math.abs(v));
  for (let i = 0; i < d.length; i++) d[i] *= 0.7 / m;
  return buf;
}

/** Pink-ish (Paul Kellet) noise bursts: 250 ms with 10 ms fades, once per second. */
export function makeNoiseBursts(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, sr, sr);
  const d = buf.getChannelData(0);
  const len = Math.round(0.25 * sr);
  const fade = Math.round(0.01 * sr);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
    const env = Math.min(1, i / fade, (len - 1 - i) / fade);
    d[i] = pink * env * 0.8;
  }
  return buf;
}

// ------------------------------------------------------------ musical loops
// All three share one tempo and key (96 BPM, A minor: Am – F – C – G), so sources play together
// in time. Loop lengths divide 10 s; the engine starts them at `currentTime % duration` to lock phase.

const BPM = 96;
const EIGHTH = 30 / BPM; // s
const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

/** Deterministic noise (mulberry32), so a loop sounds the same every time and in exports. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** Mixes `note` into `d` at `start` samples, wrapping past the end (seamless loop tails). */
function mixWrapped(d: Float32Array, note: Float32Array, start: number, gain: number) {
  for (let i = 0; i < note.length; i++) d[(start + i) % d.length] += note[i] * gain;
}

/** Scales to an RMS level (dBFS), never letting the peak exceed `peak`. Background-music levels, not "full scale". */
function normalize(d: Float32Array, rmsDb: number, peak = 0.5) {
  let m = 0, ss = 0;
  for (const v of d) {
    m = Math.max(m, Math.abs(v));
    ss += v * v;
  }
  if (m === 0) return;
  const k = Math.min(peak / m, 10 ** (rmsDb / 20) / Math.sqrt(ss / d.length));
  for (let i = 0; i < d.length; i++) d[i] *= k;
}

// ------------------------------------------------------------ fixed tone of a signal (RBJ biquads, same shapes as a WebAudio BiquadFilterNode)

type Coefs = [b0: number, b1: number, b2: number, a1: number, a2: number];

function norm(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Coefs {
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function shelf(sr: number, side: 'low' | 'high', hz: number, db: number): Coefs {
  const A = 10 ** (db / 40);
  const w = (2 * Math.PI * hz) / sr;
  const c = Math.cos(w);
  const k = 2 * Math.sqrt(A) * (Math.sin(w) / 2) * Math.SQRT2;
  return side === 'low'
    ? norm(A * (A + 1 - (A - 1) * c + k), 2 * A * (A - 1 - (A + 1) * c), A * (A + 1 - (A - 1) * c - k), A + 1 + (A - 1) * c + k, -2 * (A - 1 + (A + 1) * c), A + 1 + (A - 1) * c - k)
    : norm(A * (A + 1 + (A - 1) * c + k), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - k), A + 1 - (A - 1) * c + k, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - k);
}
function peaking(sr: number, hz: number, q: number, db: number): Coefs {
  const A = 10 ** (db / 40);
  const w = (2 * Math.PI * hz) / sr;
  const al = Math.sin(w) / (2 * q);
  return norm(1 + al * A, -2 * Math.cos(w), 1 - al * A, 1 + al / A, -2 * Math.cos(w), 1 - al / A);
}
function bandpass(sr: number, hz: number, q: number): Coefs {
  const w = (2 * Math.PI * hz) / sr;
  const al = Math.sin(w) / (2 * q);
  return norm(al, 0, -al, 1 + al, -2 * Math.cos(w), 1 - al);
}
/** Filters `d` in place, once around the loop to settle first, so the result still loops seamlessly. */
function biquad(d: Float32Array, [b0, b1, b2, a1, a2]: Coefs) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let pass = 0; pass < 2; pass++)
    for (let i = 0; i < d.length; i++) {
      const x = d[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      if (pass) d[i] = y;
    }
}
const scale = (d: Float32Array, db: number) => {
  const k = 10 ** (db / 20);
  for (let i = 0; i < d.length; i++) d[i] *= k;
};

/** Karplus-Strong plucked string with a fractional delay and a soft, low-passed pluck. */
function pluck(sr: number, hz: number, dur: number, t60: number, rand: () => number): Float32Array {
  const n = Math.round(dur * sr);
  const y = new Float32Array(n);
  const D = sr / hz - 0.5; // the two-tap average adds half a sample
  const g = 0.001 ** (1 / (hz * t60));
  const p = Math.ceil(D) + 1;
  let lp = 0;
  for (let i = 0; i < Math.min(p, n); i++) y[i] = lp += 0.3 * (rand() - lp); // low-passed: a finger, not a pick
  const at = (x: number) => {
    const i = Math.floor(x);
    return i < 0 ? 0 : y[i] + (y[i + 1] - y[i]) * (x - i);
  };
  for (let i = p; i < n; i++) y[i] += g * 0.5 * (at(i - D) + at(i - D - 1));
  const fade = Math.round(0.05 * sr);
  for (let i = 0; i < fade; i++) y[n - 1 - i] *= i / fade;
  return y;
}

const CHORDS = [
  [45, 52, 57, 60, 64], // Am
  [41, 48, 53, 57, 60], // F
  [48, 55, 60, 64, 67], // C
  [43, 50, 55, 59, 62], // G
];

/** Fingerpicked guitar arpeggio over Am – F – C – G, 4 bars (10 s). */
export function makeGuitar(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.round(32 * EIGHTH * sr), sr);
  const d = buf.getChannelData(0);
  const rand = rng(7);
  const pattern = [0, 2, 3, 4, 1, 3, 4, 3];
  CHORDS.forEach((chord, bar) =>
    pattern.forEach((k, step) => {
      const m = chord[k];
      const note = pluck(sr, midiHz(m), k === 0 ? 3 : 2, k === 0 ? 4 : 2.5, rand);
      mixWrapped(d, note, Math.round((bar * 8 + step) * EIGHTH * sr), k === 0 ? 0.7 : 0.55);
    }),
  );
  normalize(d, -32);
  scale(d, -9);
  return buf;
}

/** Marimba bar: inharmonic partials 1 : 3.9 : 9.2, the higher ones dying first. */
function mallet(sr: number, hz: number): Float32Array {
  const tau = Math.min(0.9, 0.5 * Math.sqrt(440 / hz));
  const y = new Float32Array(Math.round(tau * 6 * sr));
  const atk = 0.004 * sr; // soft rubber mallet
  for (const [r, a, ta] of [[1, 1, tau], [3.9, 0.18, tau / 4], [9.2, 0.05, tau / 10]]) {
    if (r * hz >= sr / 2) continue;
    // Damped phasor: rotate and shrink each sample instead of sin/exp per sample.
    const w = (2 * Math.PI * r * hz) / sr;
    const k = Math.exp(-1 / (ta * sr));
    const c = Math.cos(w) * k, sn = Math.sin(w) * k;
    let re = a, im = 0;
    for (let i = 0; i < y.length; i++) {
      y[i] += im * Math.min(1, i / atk);
      const t = re * c - im * sn;
      im = re * sn + im * c;
      re = t;
    }
  }
  return y;
}

/** Marimba melody (A minor pentatonic) with a bass bar per chord, 4 bars (10 s). */
export function makeMarimba(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.round(32 * EIGHTH * sr), sr);
  const d = buf.getChannelData(0);
  const _ = 0;
  // prettier-ignore
  const melody = [
    69, _, 72, 74, 76, _, 74, 72,
    69, _, 67, 69, 72, _, _, _,
    76, _, 79, 76, 74, _, 72, 74,
    76, 74, 72, 69, 67, _, 69, _,
  ];
  const cache = new Map<number, Float32Array>();
  const tone = (m: number) => cache.get(m) ?? cache.set(m, mallet(sr, midiHz(m))).get(m)!;
  melody.forEach((m, i) => m && mixWrapped(d, tone(m), Math.round(i * EIGHTH * sr), i % 2 ? 0.45 : 0.55));
  CHORDS.forEach((c, bar) => {
    mixWrapped(d, tone(c[0] + 12), Math.round(bar * 8 * EIGHTH * sr), 0.45);
    mixWrapped(d, tone(c[0] + 12), Math.round((bar * 8 + 5) * EIGHTH * sr), 0.3);
  });
  normalize(d, -29);
  biquad(d, peaking(sr, 500, 1, -12)); // low-mid, after the level: the tone must not be normalized away
  return buf;
}

/** Drum groove: kick, snare, hi-hats, 2 bars (5 s). */
export function makeDrums(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const step = EIGHTH / 2;
  const buf = ctx.createBuffer(1, Math.round(32 * step * sr), sr);
  const d = buf.getChannelData(0);
  const rand = rng(11);
  const render = (dur: number, f: (t: number, i: number) => number) => {
    const y = new Float32Array(Math.round(dur * sr));
    for (let i = 0; i < y.length; i++) y[i] = f(i / sr, i);
    return y;
  };
  let ph = 0;
  const kick = render(0.5, (t) => {
    ph += (2 * Math.PI * (48 + 40 * Math.exp(-t / 0.04))) / sr;
    return Math.sin(ph) * Math.exp(-t / 0.1) * Math.min(1, t / 0.004); // no click, soft attack
  });
  let lp = 0;
  const snare = render(0.3, (t) => {
    lp += 0.35 * (rand() - lp); // band-limited noise: a brushed rim rather than a crack
    return 0.4 * lp * Math.exp(-t / 0.06) + 0.35 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t / 0.035);
  });
  const hat = (tau: number) => {
    let a = 0;
    return render(tau * 6, (t) => {
      const w = rand();
      const hp = w - a; // first difference: airy, not hissy
      a = w;
      return 0.2 * hp * Math.exp(-t / tau);
    });
  };
  const closed = hat(0.012);
  const open = hat(0.09);
  const at = (s: number) => Math.round(s * step * sr);
  for (const s of [0, 8, 10, 16, 22, 24, 27]) mixWrapped(d, kick, at(s), s % 8 ? 0.6 : 0.8);
  for (const s of [4, 12, 20, 28]) mixWrapped(d, snare, at(s), 0.5);
  for (const s of [15, 31]) mixWrapped(d, snare, at(s), 0.12); // ghost notes
  for (let s = 0; s < 32; s += 2) if (s !== 30) mixWrapped(d, closed, at(s), s % 4 ? 0.25 : 0.4);
  mixWrapped(d, open, at(30), 0.3);
  normalize(d, -27);
  biquad(d, shelf(sr, 'low', 150, -6)); // after the level: the tone must not be normalized away
  biquad(d, shelf(sr, 'high', 6000, 10));
  return buf;
}

/** Generated signals: menu label (dictionary key), builder, loops in an export, phase-locked start. */
export const GENERATED = {
  guitar: { labelKey: 'sig.guitar' as const, make: makeGuitar, repeat: 2, sync: true },
  marimba: { labelKey: 'sig.marimba' as const, make: makeMarimba, repeat: 2, sync: true },
  drums: { labelKey: 'sig.drums' as const, make: makeDrums, repeat: 4, sync: true },
  clap: { labelKey: 'sig.clap' as const, make: makeClap, repeat: 3, sync: false },
  noise: { labelKey: 'sig.noise' as const, make: makeNoiseBursts, repeat: 3, sync: false },
} as const;
export type GeneratedKind = keyof typeof GENERATED;
export const isGenerated = (k: string): k is GeneratedKind => k in GENERATED;
