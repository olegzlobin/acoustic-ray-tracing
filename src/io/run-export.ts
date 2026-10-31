// Export actions (processed audio, binaural IR, AmbiX IR) as plain async functions: they get what
// they need through `ExportInput` and return the notice to show, so the UI keeps no export logic.

import { channelBuffer, exportSource, renderBinaural, renderBinauralIR, type RenderSource } from '../audio/offline';
import { rotateFoaToListener } from '../audio/foa';
import type { Eq } from '../audio/eq';
import { srcName, t, tp } from '../i18n.svelte';
import type { Scene } from '../scene';
import { download, safeName } from './download';
import { encodeWav, peak, type WavBits } from './wav';

export interface Notice {
  kind: 'info' | 'error';
  text: string;
  details?: string[];
}

export type ExportKind = 'audio' | 'binaural-ir' | 'foa-ir';

/** A refined (final) full IR of one source. */
export interface FullIr {
  ir: Float32Array[];
  sampleRate: number;
  /**
   * Accurate-HRTF split of `ir` (direct sound + ISM through the third-order HRTFs): `foa` is `ir` without
   * the windowed ISM paths, `bin` their binaural [L, R] IR at the current yaw. Binaural renders use it
   * instead of `ir`; the AmbiX export always writes the plain `ir`.
   */
  accurate?: { foa: Float32Array[]; bin: Float32Array[] };
}

interface ExportInput {
  scene: Scene;
  /** Index of the selected source (its IR is exported for the IR kinds). */
  selected: number;
  /** Final IR of the selected source. */
  selectedIr: FullIr | null;
  /**
   * Audible sources that take part in an audio export, in scene order. `irR` is set (null while unfinished)
   * for an active stereo pair: `ir` is then the left speaker, `irR` the right one.
   */
  sources: { index: number; ir: FullIr | null; irR?: FullIr | null; file: AudioBuffer | null; gain: number; eq: Eq }[];
  dry: number;
  wet: number;
  onprogress: (p: number) => void;
}

/** Scale to 0.99 full scale when an integer WAV would clip. Returns the peak and a note. */
function fitForWav(out: Float32Array[], bits: WavBits, note: string): { pk: number; msg: string } {
  let pk = peak(out);
  let msg = '';
  if (bits !== 32 && pk > 0.99) {
    const g = 0.99 / pk;
    for (const c of out) for (let i = 0; i < c.length; i++) c[i] *= g;
    msg = ` (${t('exp.normalised', { db: (20 * Math.log10(g)).toFixed(1) })}${note})`;
    pk = 0.99;
  }
  return { pk, msg };
}

export async function runExport(what: ExportKind, bits: WavBits, d: ExportInput): Promise<Notice> {
  const base = safeName(d.scene.name);
  if (what !== 'audio') {
    const full = d.selectedIr;
    if (!full) throw new Error(t('exp.noIr'));
    if (what === 'foa-ir') {
      download(`${base}-ir-ambix.wav`, encodeWav(rotateFoaToListener(full.ir, d.scene.yaw), full.sampleRate, bits), 'audio/wav');
      return { kind: 'info', text: t('exp.foaDone', { name: srcName(d.scene.sources[d.selected].name) }) };
    }
    const out = await renderBinauralIR(full.accurate?.foa ?? full.ir, full.sampleRate, d.scene.yaw, d.onprogress, full.accurate?.bin);
    const { pk, msg } = fitForWav(out, bits, '');
    download(`${base}-ir-binaural.wav`, encodeWav(out, full.sampleRate, bits), 'audio/wav');
    return { kind: 'info', text: t('exp.binDone', { peak: pk.toFixed(3) }) + msg + '.' };
  }
  // Mix of all audible sources.
  const list: RenderSource[] = [];
  const skipped: string[] = [];
  let sr = 0;
  let mixed = 0; // sources (a stereo pair counts once)
  for (const s of d.sources) {
    const src = s.ir ? exportSource(d.scene.sources[s.index].signal, s.ir.sampleRate, s.file) : null;
    const pair = s.irR !== undefined;
    if (!s.ir || !src || (pair && (!s.irR || src.buffer.numberOfChannels < 2))) {
      skipped.push(srcName(d.scene.sources[s.index].name));
      continue;
    }
    sr = s.ir.sampleRate;
    mixed++;
    if (pair && s.irR) {
      // Stereo pair: channel 0 through the left speaker's IR, channel 1 through the right one's.
      list.push({ ir: s.ir.accurate?.foa ?? s.ir.ir, bin: s.ir.accurate?.bin, source: channelBuffer(src.buffer, 0, sr), repeat: src.repeat, gain: s.gain, eq: s.eq, pan: -1 });
      list.push({ ir: s.irR.accurate?.foa ?? s.irR.ir, bin: s.irR.accurate?.bin, source: channelBuffer(src.buffer, 1, sr), repeat: src.repeat, gain: s.gain, eq: s.eq, pan: 1 });
    } else list.push({ ir: s.ir.accurate?.foa ?? s.ir.ir, bin: s.ir.accurate?.bin, source: src.buffer, repeat: src.repeat, gain: s.gain, eq: s.eq });
  }
  if (!list.length) {
    return { kind: 'error', text: t('exp.nothing') };
  }
  const out = await renderBinaural({ sources: list, sampleRate: sr, yaw: d.scene.yaw, dry: d.dry, wet: d.wet, onprogress: d.onprogress });
  const { pk, msg } = fitForWav(out, bits, ' ' + t('exp.avoidClip'));
  download(`${base}-processed.wav`, encodeWav(out, sr, bits), 'audio/wav');
  return {
    kind: 'info',
    text: `${tp('exp.audioDone', mixed)}, ${t('exp.peak', { peak: pk.toFixed(3) })}${msg}.${skipped.length ? ' ' + t('exp.skipped', { names: skipped.join(', ') }) : ''}`,
  };
}
