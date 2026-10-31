// Pieces of the audio graph shared by the live engine (engine.ts) and the offline renderer
// (offline.ts), so both build exactly the same signal path:
//   bus -> 4x Convolver (W,Y,Z,X) -> Merger(4) -> Omnitone FOA renderer -> wet -> destination
//   bus -> 1x stereo Convolver (binaural early IR, per-path HRTF) ----------------------> wet
//   bus ----------------------------------------------------------> dry -> destination

import { BIN_GAIN } from './levels';

/** Four mono convolvers (ACN W,Y,Z,X, no normalisation) fed from `input`, merged into one 4-channel node. */
export function createFoaConvolvers(ctx: BaseAudioContext, input: AudioNode): { convs: ConvolverNode[]; merger: ChannelMergerNode } {
  const merger = ctx.createChannelMerger(4);
  const convs = [0, 1, 2, 3].map((c) => {
    const cv = ctx.createConvolver();
    cv.normalize = false; // must be set before the buffer is assigned
    cv.channelCount = 1;
    cv.channelCountMode = 'explicit';
    input.connect(cv);
    cv.connect(merger, 0, c);
    return cv;
  });
  return { convs, merger };
}

/** One convolver for a 2-channel (L, R) IR: mono in, stereo out, no normalisation; fed from `input`. */
export function createBinConvolver(ctx: BaseAudioContext, input: AudioNode): ConvolverNode {
  const cv = ctx.createConvolver();
  cv.normalize = false; // must be set before the buffer is assigned
  cv.channelCount = 1;
  cv.channelCountMode = 'explicit';
  input.connect(cv);
  return cv;
}

/** Stereo AudioBuffer [L, R] times BIN_GAIN, at the context's sample rate. */
export function binBuffer(ctx: BaseAudioContext, bin: Float32Array[]): AudioBuffer {
  const buf = ctx.createBuffer(2, bin[0].length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = bin[c][i] * BIN_GAIN;
  }
  return buf;
}

/** Mono AudioBuffer holding `data` at the context's sample rate. */
export function monoBuffer(ctx: BaseAudioContext, data: Float32Array): AudioBuffer {
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
  return buf;
}

/** Dry and wet output gains, both connected to the destination (the renderer's output feeds `wet`). */
export function createMasterGains(ctx: BaseAudioContext, dryGain: number, wetGain: number): { dry: GainNode; wet: GainNode } {
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  dry.gain.value = dryGain;
  wet.gain.value = wetGain;
  dry.connect(ctx.destination);
  wet.connect(ctx.destination);
  return { dry, wet };
}
