/** Global wet normalisation: direct sound at 1 m has FOA amplitude 1.0 -> about 0.5 at the output. */
export const WET_NORM = 0.5;

/**
 * Gain of the binaural early IR (direct sound + ISM reflections through the third-order HRTFs), matched to the
 * Omnitone FOA decoder level so the two paths into `wet` are balanced: an impulse from 48 directions
 * (4 elevations × 12 azimuths) through both decoders, energy averaged; the shipped third-order filters
 * come out 0.65 dB quieter, hence √(E_foa / E_toa) = 1.078.
 */
export const BIN_GAIN = 1.078;

/** Level of loaded files, in line with the generated loops (−27…−32 dBFS RMS). */
export const FILE_RMS_DB = -29;
const FILE_PEAK = 0.5;

/**
 * Gain that brings a loaded file to FILE_RMS_DB. Mastered music sits around −10 dBFS RMS, 20 dB
 * above the built-in signals, and a reverberant room adds its tail on top. RMS is measured over
 * 400 ms blocks, ignoring blocks below −50 dBFS, so silence and fades don't count; the peak is capped.
 */
export function fileGain(channels: Float32Array[], sampleRate: number): number {
  const block = Math.max(1, Math.round(0.4 * sampleRate));
  const n = channels[0]?.length ?? 0;
  let sum = 0, count = 0, peak = 0;
  for (let s = 0; s < n; s += block) {
    let e = 0;
    const end = Math.min(n, s + block);
    for (const ch of channels)
      for (let i = s; i < end; i++) {
        e += ch[i] * ch[i];
        peak = Math.max(peak, Math.abs(ch[i]));
      }
    const ms = e / ((end - s) * channels.length);
    if (ms > 1e-5) {
      sum += ms;
      count++;
    }
  }
  if (!count || !peak) return 1;
  return Math.min(10 ** (FILE_RMS_DB / 20) / Math.sqrt(sum / count), FILE_PEAK / peak);
}
