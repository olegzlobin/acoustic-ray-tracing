// Per-source equalizer: 4 fixed bands in series, gain in dB. Shapes the source signal itself (before the
// dry/wet split), so it colours both the direct sound and the room response.

export type EqBand = 'low' | 'lowMid' | 'highMid' | 'high';
export type Eq = Record<EqBand, number>;

export const EQ_MIN_DB = -12;
export const EQ_MAX_DB = 12;
export const EQ_STEP_DB = 0.5;

export const EQ_BANDS: { id: EqBand; label: string; type: 'lowshelf' | 'peaking' | 'highshelf'; freq: number; q: number }[] = [
  { id: 'low', label: 'Low', type: 'lowshelf', freq: 150, q: 1 },
  { id: 'lowMid', label: 'Low-mid', type: 'peaking', freq: 500, q: 1 },
  { id: 'highMid', label: 'High-mid', type: 'peaking', freq: 2000, q: 1 },
  { id: 'high', label: 'High', type: 'highshelf', freq: 6000, q: 1 },
];

export const FLAT_EQ: Eq = { low: 0, lowMid: 0, highMid: 0, high: 0 };

export const isFlat = (eq: Eq) => EQ_BANDS.every((b) => eq[b.id] === 0);

/** Series of biquads; `input` and `output` are the ends of the chain (the caller connects both). */
export function createEqChain(ctx: BaseAudioContext, eq: Eq): { input: AudioNode; output: AudioNode; filters: BiquadFilterNode[] } {
  const filters = EQ_BANDS.map((b) => {
    const f = ctx.createBiquadFilter();
    f.type = b.type;
    f.frequency.value = b.freq;
    f.Q.value = b.q; // ignored by the shelves
    f.gain.value = eq[b.id];
    return f;
  });
  filters.forEach((f, i) => i > 0 && filters[i - 1].connect(f));
  return { input: filters[0], output: filters[filters.length - 1], filters };
}

/** Live update: ramp the gains so slider drags do not click. */
export function setEqGains(filters: BiquadFilterNode[], eq: Eq, ctx: BaseAudioContext) {
  EQ_BANDS.forEach((b, i) => filters[i].gain.setTargetAtTime(eq[b.id], ctx.currentTime, 0.02));
}
