import Omnitone from 'omnitone';
import { yawToRotation } from '../scene';
import { WET_NORM } from './levels';
export { rotateFoaToListener } from './foa';
import { GENERATED, isGenerated } from './signals';
import type { SignalKind } from '../scene';
import { createEqChain, FLAT_EQ, type Eq } from './eq';
import { binBuffer, createBinConvolver, createFoaConvolvers, createMasterGains, monoBuffer } from './graph';

/**
 * Offline renders. Omnitone's FOA renderer works on an OfflineAudioContext (it only needs a
 * BaseAudioContext and decodes its embedded HRIRs through it), so the export graph is the live
 * graph without the early/late split:
 *   source -> mono -> EQ (4 biquads) -> bus -+-> dry -> destination
 *                                   +-> 4x Convolver (full IR, W,Y,Z,X) -> Merger -> Omnitone FOA (yaw) -> wet -> destination
 *                                   +-> stereo Convolver (binaural early IR, if any; yaw already applied) -> wet
 */

export interface RenderSource {
  ir: Float32Array[]; // FOA IR of this source, ACN W,Y,Z,X (with a `bin` IR: without the ISM paths, which `bin` carries)
  /** Binaural [L, R] early IR (direct sound + ISM reflections through the third-order HRTFs) at the export yaw. */
  bin?: Float32Array[];
  source: AudioBuffer;
  /** Repeat the source (generated test signals loop in the live app). */
  repeat: number;
  /** Effective linear gain (mute/solo already applied). */
  gain: number;
  /** Per-source equalizer (flat for the IR export). */
  eq: Eq;
  /** Speaker of a stereo pair: the dry path is panned hard left (-1) / right (1), like the live graph. */
  pan?: -1 | 1;
}

interface RenderOptions {
  sources: RenderSource[];
  sampleRate: number;
  yaw: number;
  dry: number;
  wet: number;
  onprogress?: (p: number) => void;
}

/** Source buffer for export: the loaded file or a generated test signal (3 loops). */
/** Generated signals and files only: the microphone cannot be exported (returns null). */
export function exportSource(kind: SignalKind, sampleRate: number, file: AudioBuffer | null): { buffer: AudioBuffer; repeat: number } | null {
  const probe = new OfflineAudioContext(1, 1, sampleRate);
  if (isGenerated(kind)) return { buffer: GENERATED[kind].make(probe), repeat: GENERATED[kind].repeat };
  return file ? { buffer: file, repeat: 1 } : null;
}

/** One channel of `buf` as a mono buffer (the two speakers of a stereo pair are rendered as separate sources). */
export function channelBuffer(buf: AudioBuffer, channel: number, sampleRate: number): AudioBuffer {
  const probe = new OfflineAudioContext(1, 1, sampleRate);
  const out = probe.createBuffer(1, buf.length, buf.sampleRate);
  out.copyToChannel(buf.getChannelData(channel), 0);
  return out;
}

/** Mix of all given sources through their own IRs into ONE Omnitone renderer (like the live graph). */
export async function renderBinaural(o: RenderOptions): Promise<Float32Array[]> {
  const length = Math.max(...o.sources.map((s) => s.source.length * s.repeat + Math.max(s.ir[0].length, s.bin?.[0].length ?? 0))) + 4096; // + HRIR length
  const ctx = new OfflineAudioContext(2, length, o.sampleRate);
  const renderer = Omnitone.createFOARenderer(ctx);
  await renderer.initialize();
  renderer.setRotationMatrix3(yawToRotation(o.yaw));
  const { dry, wet } = createMasterGains(ctx, o.dry, o.wet * WET_NORM);
  renderer.output.connect(wet);

  for (const s of o.sources) {
    const srcLen = s.source.length * s.repeat;
    const buf = ctx.createBuffer(s.source.numberOfChannels, srcLen, o.sampleRate);
    for (let c = 0; c < s.source.numberOfChannels; c++) {
      const d = s.source.getChannelData(c);
      const out = buf.getChannelData(c);
      for (let r = 0; r < s.repeat; r++) out.set(d, r * d.length);
    }
    const bus = ctx.createGain();
    bus.gain.value = s.gain;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const eq = createEqChain(ctx, s.eq);
    // Mono in, like the live graph: a stereo source without a pair is summed (0.5 (L + R)).
    const mono = ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    src.connect(mono);
    mono.connect(eq.input);
    eq.output.connect(bus);
    if (s.pan === undefined) bus.connect(dry);
    else {
      const pan = ctx.createStereoPanner();
      pan.pan.value = s.pan;
      bus.connect(pan);
      pan.connect(dry);
    }
    const { convs, merger } = createFoaConvolvers(ctx, bus);
    s.ir.forEach((ch, c) => (convs[c].buffer = monoBuffer(ctx, ch)));
    merger.connect(renderer.input); // inputs of several sources sum
    if (s.bin) {
      const cv = createBinConvolver(ctx, bus);
      cv.buffer = binBuffer(ctx, s.bin);
      cv.connect(wet);
    }
    src.start(0);
  }

  // Progress: suspend at a few points (must be scheduled before rendering starts). Firefox has no
  // OfflineAudioContext.suspend: there the export just runs without intermediate progress.
  const steps = typeof ctx.suspend === 'function' ? 8 : 0;
  for (let i = 1; i <= steps; i++) {
    const t = (length * i) / (steps + 1) / o.sampleRate;
    ctx.suspend(t).then(() => {
      o.onprogress?.(i / (steps + 1));
      void ctx.resume();
    }, () => {});
  }
  const rendered = await ctx.startRendering();
  o.onprogress?.(1);
  return [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()];
}

/** Binaural IR: a unit impulse through the wet path (wet level = WET_NORM, like the live graph at wet = 1). */
export async function renderBinauralIR(ir: Float32Array[], sampleRate: number, yaw: number, onprogress?: (p: number) => void, bin?: Float32Array[]): Promise<Float32Array[]> {
  const probe = new OfflineAudioContext(1, 1, sampleRate);
  const impulse = probe.createBuffer(1, 1, sampleRate);
  impulse.getChannelData(0)[0] = 1;
  return renderBinaural({ sources: [{ ir, bin, source: impulse, repeat: 1, gain: 1, eq: FLAT_EQ }], sampleRate, yaw, dry: 0, wet: 1, onprogress });
}
