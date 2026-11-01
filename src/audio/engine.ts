import Omnitone from 'omnitone';
import type { FOARenderer } from 'omnitone';
import { yawToRotation, type SignalKind } from '../scene';
import { GENERATED, isGenerated, type GeneratedKind } from './signals';
import { fileGain, WET_NORM } from './levels';
import { expose } from '../debug';
import { createEqChain, setEqGains, type Eq, FLAT_EQ } from './eq';
import { binBuffer, createBinConvolver, createFoaConvolvers, createMasterGains, monoBuffer } from './graph';

/**
 * Audio graph (per source `i`, all feeding ONE Omnitone FOA renderer):
 *   player -> srcGain_i (mono) -> EQ_i (4 biquads) -> bus_i -+-> dry (shared) -> destination
 *                                 +-> early chain_i: banks A/B of 4x Convolver (W,Y,Z,X) -> Merger(4) -> gain -+
 *                                 +-> late chain_i:  banks A/B, same                                -> gain -+-> Omnitone FOA -> wet -> destination
 *                                 +-> bin chain_i:   banks A/B of ONE stereo Convolver (direct sound + ISM through third-order HRTFs) -> gain -> wet
 * Each chain loads a new IR into its inactive bank and crossfades the bank gains: fast for the
 * early parts (30 ms), slow for the late part (200 ms). Bank swaps are rate-limited per chain so a
 * bank is never overwritten while still audible; only the newest queued IR is applied. The input of
 * an inactive bank is disconnected after its fade-out so idle convolvers cost no CPU
 * (4 sources x 2 chains x 2 banks x 4 convolvers would otherwise all run).
 *
 * Stereo pair (a stereo file on a source with a right-speaker partner channel): ONE player ->
 * ChannelSplitter(2) -> ch 0 into the left channel's srcGain, ch 1 into the partner's srcGain, so both stay
 * sample-synchronous. Each of the two channels has its own EQ / bus / early / late chains (own IRs); the dry
 * path of the pair is panned hard left / right (a stereo file's plain stereo, as before the room).
 * Every srcGain is mono (channelCount 1, explicit): a stereo file without a pair is summed to mono
 * (0.5 (L + R)) there, and nothing reaches the dry path as un-spatialized stereo any more.
 */

interface Bank {
  /** Fan-in node: the chain bus connects here only while the bank is (becoming) active. */
  input: GainNode;
  convs: ConvolverNode[];
  gain: GainNode;
}

/** `early`/`late`: total ms of the last assignment (4 convolvers); `*Max`: worst single task. */
const assignPerf = { early: 0, late: 0, bin: 0, earlyMax: 0, lateMax: 0, binMax: 0 };
expose('__arAssign', assignPerf);

class Chain {
  private banks: [Bank, Bank];
  private active = 0;
  private pending: Float32Array[] | null = null;
  /** Nothing audible assigned (initially, or the last request was `null`): repeated `null`s change nothing. */
  private silent = true;
  private lastSwap = 0;
  private timer: number | null = null;
  private busy = false;
  private offTimers: [number | null, number | null] = [null, null];

  constructor(
    private ctx: AudioContext,
    private bus: AudioNode,
    private name: 'early' | 'late' | 'bin',
    private xfadeS: number,
    private minGapMs: number,
  ) {
    const mk = (): Bank => {
      const input = ctx.createGain();
      const gain = ctx.createGain();
      if (name === 'bin') {
        const cv = createBinConvolver(ctx, input);
        cv.connect(gain);
        return { input, convs: [cv], gain };
      }
      const { convs, merger } = createFoaConvolvers(ctx, input);
      merger.connect(gain);
      return { input, convs, gain };
    };
    this.banks = [mk(), mk()];
    this.banks[0].gain.gain.value = 1;
    this.banks[1].gain.gain.value = 0;
  }

  connect(dest: AudioNode) {
    for (const b of this.banks) b.gain.connect(dest);
  }

  dispose() {
    if (this.timer !== null) clearTimeout(this.timer);
    for (const t of this.offTimers) if (t !== null) clearTimeout(t);
    for (const b of this.banks) {
      safeDisconnect(this.bus, b.input);
      b.gain.disconnect();
    }
  }

  /**
   * Queue an IR (FOA chains: 4 mono channels, bin chain: [L, R]); applied as soon as the rate limit allows.
   * `null`: silence (a one-sample zero IR).
   */
  set(ir: Float32Array[] | null) {
    if (!ir && this.silent) return;
    this.silent = !ir;
    this.pending = ir ?? Array.from({ length: this.name === 'bin' ? 2 : 4 }, () => new Float32Array(1));
    this.schedule();
  }

  /** Apply the pending IR now, or when the rate limit allows. */
  private schedule() {
    const wait = this.lastSwap + this.minGapMs - performance.now();
    if (wait <= 0) void this.swap();
    else if (this.timer === null) this.timer = window.setTimeout(() => void this.swap(), wait);
  }

  /**
   * Fill the inactive bank (one convolver per task, so the main thread is never blocked for the
   * whole 4 x FFT-partitioning of a long IR), then crossfade. The inactive bank is silent, so the
   * channels may be assigned at different times without audible effects.
   */
  private async swap() {
    this.timer = null;
    if (this.busy || !this.pending) return;
    this.busy = true;
    const ir = this.pending;
    this.pending = null;
    this.lastSwap = performance.now();
    const next = 1 - this.active;
    const bank = this.banks[next];
    if (this.offTimers[next] !== null) clearTimeout(this.offTimers[next]!);
    this.offTimers[next] = null;
    this.bus.connect(bank.input);
    let cost = 0;
    let worst = 0;
    if (this.name === 'bin') {
      const t0 = performance.now();
      bank.convs[0].buffer = binBuffer(this.ctx, ir);
      cost = worst = performance.now() - t0;
    } else
      for (let c = 0; c < ir.length; c++) {
        const t0 = performance.now();
        bank.convs[c].buffer = monoBuffer(this.ctx, ir[c]);
        const dt = performance.now() - t0;
        cost += dt;
        worst = Math.max(worst, dt);
        if (c < ir.length - 1) await new Promise<void>((r) => setTimeout(r, 0));
      }
    assignPerf[this.name] = cost;
    const maxKey = `${this.name}Max` as const;
    assignPerf[maxKey] = Math.max(assignPerf[maxKey], worst);
    const t = this.ctx.currentTime;
    const ramp = (g: AudioParam, to: number) => {
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(to, t + this.xfadeS);
    };
    const old = this.active;
    ramp(this.banks[old].gain.gain, 0);
    ramp(bank.gain.gain, 1);
    this.active = next;
    // Stop feeding the faded-out bank so its convolvers go idle.
    this.offTimers[old] = window.setTimeout(() => {
      safeDisconnect(this.bus, this.banks[old].input);
      this.offTimers[old] = null;
    }, this.xfadeS * 1000 + 80);
    this.lastSwap = performance.now();
    this.busy = false;
    if (this.pending) this.schedule(); // newer IR arrived meanwhile
  }
}

/** Disconnect `from` → `to`, tolerating a link that is already gone (inactive banks start unlinked). */
function safeDisconnect(from: AudioNode, to: AudioNode) {
  try {
    from.disconnect(to);
  } catch {
    // InvalidAccessError: not connected
  }
}

type Player = AudioBufferSourceNode | MediaStreamAudioSourceNode;

/** Everything belonging to one sound source. */
/** Setting the signal kind again must not restart a running player (e.g. on every source drag). */
export const signalNeedsRestart = (prev: SignalKind, next: SignalKind, hasPlayer: boolean) => prev !== next || !hasPlayer;

class SourceChannel {
  readonly input: GainNode; // per-source gain (mute / solo / level), mono
  readonly eqFilters: BiquadFilterNode[]; // per-source equalizer between input and bus
  readonly bus: GainNode;
  private dryPan: StereoPannerNode | null = null;
  readonly early: Chain;
  readonly late: Chain;
  /** Binaural early IR of the ISM paths (per-path HRTF); feeds `wet` directly, bypassing Omnitone and its rotation. */
  readonly bin: Chain;
  player: Player | null = null;
  kind: SignalKind = 'clap';
  file: AudioBuffer | null = null;
  /** Right speaker of a stereo pair led by this channel (it never plays by itself). */
  partner: { slot: number; ch: SourceChannel } | null = null;
  /** A right-speaker channel: fed by its leader's player. */
  follower = false;
  /** Splits the stereo player of a pair. */
  splitter: ChannelSplitterNode | null = null;

  constructor(readonly ctx: AudioContext, private dry: AudioNode, renderIn: AudioNode, wetIn: AudioNode, swapGap: number) {
    this.input = ctx.createGain();
    // Mono in: a stereo source is summed (0.5 (L + R)) here, a pair is split by the engine.
    this.input.channelCount = 1;
    this.input.channelCountMode = 'explicit';
    this.bus = ctx.createGain();
    const eq = createEqChain(ctx, FLAT_EQ);
    this.eqFilters = eq.filters;
    this.input.connect(eq.input);
    eq.output.connect(this.bus);
    this.bus.connect(dry);
    // Early: 30 ms crossfade, swaps >= 45 ms apart. Late: 200 ms crossfade, swaps >= 260 ms apart.
    this.early = new Chain(ctx, this.bus, 'early', 0.03, 45 * swapGap);
    this.late = new Chain(ctx, this.bus, 'late', 0.2, 260 * swapGap);
    this.bin = new Chain(ctx, this.bus, 'bin', 0.03, 45 * swapGap);
    this.early.connect(renderIn);
    this.late.connect(renderIn);
    this.bin.connect(wetIn);
  }

  /** Dry level of this channel: centred (null), or panned hard to a side (-1 left / +1 right) for a pair. */
  setDryPan(pan: number | null) {
    if (pan === null) {
      if (!this.dryPan) return;
      this.bus.disconnect(this.dryPan);
      this.dryPan.disconnect();
      this.dryPan = null;
      this.bus.connect(this.dry);
      return;
    }
    if (!this.dryPan) {
      this.bus.disconnect(this.dry);
      this.dryPan = this.ctx.createStereoPanner();
      this.bus.connect(this.dryPan);
      this.dryPan.connect(this.dry);
    }
    this.dryPan.pan.value = pan;
  }

  stop() {
    if (this.splitter) {
      this.splitter.disconnect();
      this.splitter = null;
    }
    if (this.player) {
      if (this.player instanceof AudioBufferSourceNode) this.player.stop();
      this.player.disconnect();
      this.player = null;
    }
  }

  dispose() {
    this.stop();
    this.early.dispose();
    this.late.dispose();
    this.bin.dispose();
    this.input.disconnect();
    for (const f of this.eqFilters) f.disconnect();
    this.bus.disconnect();
    this.dryPan?.disconnect();
    this.dryPan = null;
  }
}

export class AudioEngine {
  readonly ctx: AudioContext;
  private dry: GainNode;
  private wet: GainNode;
  private renderer!: FOARenderer;
  private channels = new Map<number, SourceChannel>();
  private yaw = 0;
  private mic: MediaStream | null = null;
  private swapGap = 1;
  playing = false;

  private constructor(ctx: AudioContext) {
    this.ctx = ctx;
    ({ dry: this.dry, wet: this.wet } = createMasterGains(ctx, 0, WET_NORM));
  }

  /** Must be called from a user gesture (creates/resumes the AudioContext). */
  static async create(lite = false): Promise<AudioEngine> {
    // Light mode: a larger output buffer (fewer dropouts) and rarer IR swaps (less work on the main thread).
    const ctx = new AudioContext({ latencyHint: lite ? 'playback' : 'interactive' });
    await ctx.resume();
    const e = new AudioEngine(ctx);
    e.swapGap = lite ? 3 : 1;
    // Omnitone 2.x: createFOARenderer(ctx) + initialize(); default channel map is ACN (AmbiX).
    e.renderer = Omnitone.createFOARenderer(ctx);
    await e.renderer.initialize();
    e.renderer.output.connect(e.wet);
    e.renderer.setRotationMatrix3(yawToRotation(e.yaw));
    return e;
  }

  get sampleRate() {
    return this.ctx.sampleRate;
  }

  /** Audio-thread load (0..1 average / peak) via AudioContext.renderCapacity where available (Chrome). */
  watchLoad(cb: (avg: number, peak: number) => void): boolean {
    const rc = (this.ctx as unknown as { renderCapacity?: { start(o: { updateInterval: number }): void; addEventListener(t: string, f: (e: { averageLoad: number; peakLoad: number }) => void): void } }).renderCapacity;
    if (!rc) return false;
    rc.addEventListener('update', (e) => cb(e.averageLoad, e.peakLoad));
    rc.start({ updateInterval: 1 });
    return true;
  }

  // ---- sources

  private ch(slot: number, follower = false): SourceChannel {
    let c = this.channels.get(slot);
    if (!c) {
      c = new SourceChannel(this.ctx, this.dry, this.renderer.input, this.wet, this.swapGap);
      c.follower = follower;
      this.channels.set(slot, c);
      if (this.playing && !follower) this.startChannel(c);
    }
    return c;
  }
  /**
   * Make `slot` a stereo pair with the right-speaker channel `rSlot` (null: back to a single point).
   * Idempotent. A running player restarts so the file is (not) split.
   */
  setPair(slot: number, rSlot: number | null) {
    const c = this.ch(slot);
    if (rSlot === null) {
      if (c.partner) this.removeSource(c.partner.slot); // unlinks and restarts the leader
      return;
    }
    if (c.partner?.slot === rSlot) return;
    if (c.partner) this.removeSource(c.partner.slot);
    let r = this.channels.get(rSlot);
    if (r) {
      // Already created by an early IR / gain call before the pair was declared: it must not play on its own.
      r.follower = true;
      r.stop();
    } else r = this.ch(rSlot, true);
    c.partner = { slot: rSlot, ch: r };
    c.setDryPan(-1);
    r.setDryPan(1);
    if (this.playing && c.kind === 'file') this.startChannel(c);
  }
  hasSlot(slot: number) {
    return this.channels.has(slot);
  }
  removeSource(slot: number) {
    const c = this.channels.get(slot);
    if (!c) return;
    const p = c.partner;
    c.partner = null;
    if (p) this.removeSource(p.slot); // a leader takes its right speaker along
    if (c.follower) {
      for (const l of this.channels.values()) {
        if (l.partner?.ch !== c) continue;
        l.partner = null;
        l.setDryPan(null);
        if (this.playing && l.kind === 'file') this.startChannel(l); // plays summed to mono now
      }
    }
    c.dispose();
    this.channels.delete(slot);
  }
  /** Drop every channel whose slot is not in `keep`. */
  prune(keep: Set<number>) {
    for (const s of [...this.channels.keys()]) if (!keep.has(s)) this.removeSource(s);
  }

  /** Early chain: FOA IR up to the split (already windowed, see `splitIR`); `null`: silence. */
  setEarly(slot: number, ir: Float32Array[] | null) {
    this.ch(slot).early.set(ir);
  }
  /** Binaural early chain: [L, R] IR of the direct sound + ISM reflections (windowed, see `windowEarly`); `null`: silence. */
  setEarlyBin(slot: number, ir: Float32Array[] | null) {
    this.ch(slot).bin.set(ir);
  }
  /** Late chain: IR from the split on (leading zeros kept, so it stays on the same timeline). */
  setLate(slot: number, ir: Float32Array[]) {
    this.ch(slot).late.set(ir);
  }
  /** Effective linear gain (mute/solo already applied). */
  setSourceGain(slot: number, g: number) {
    const c = this.ch(slot);
    c.input.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
  }

  /** Per-source equalizer (dB per band); applies live. */
  setSourceEq(slot: number, eq: Eq) {
    setEqGains(this.ch(slot).eqFilters, eq, this.ctx);
  }

  // ---- listener / levels

  setYaw(yaw: number) {
    this.yaw = yaw;
    this.renderer?.setRotationMatrix3(yawToRotation(yaw));
  }
  setDry(v: number) {
    this.dry.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }
  setWet(v: number) {
    this.wet.gain.setTargetAtTime(v * WET_NORM, this.ctx.currentTime, 0.02);
  }

  // ---- signals

  /** Decode an audio file with this context's sample rate. Rejects with a readable message. */
  async decodeFile(file: File): Promise<AudioBuffer> {
    try {
      const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
      // Level-match to the built-in signals (the decoded buffer is ours, scale it in place).
      const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
      const g = fileGain(chans, buf.sampleRate);
      for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] *= g;
      return buf;
    } catch {
      throw new Error(`"${file.name}" could not be decoded (unsupported or corrupt audio format)`);
    }
  }
  setFile(slot: number, buf: AudioBuffer | null) {
    const c = this.ch(slot);
    const changed = c.file !== buf;
    c.file = buf;
    if (changed && c.kind === 'file' && this.playing) this.startChannel(c); // new file under a running player
  }
  getFileBuffer(slot: number): AudioBuffer | null {
    return this.channels.get(slot)?.file ?? null;
  }
  hasFile(slot: number) {
    return !!this.channels.get(slot)?.file;
  }

  /** Ask for the microphone (echo cancellation, noise suppression and AGC off). Use headphones! */
  async enableMic(): Promise<void> {
    if (this.mic) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no microphone access (getUserMedia).');
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  }

  private cache = new Map<GeneratedKind, AudioBuffer>();
  /** Generated buffers are built once (the musical loops take a few ms to synthesize). */
  private generated(k: GeneratedKind): AudioBuffer {
    let b = this.cache.get(k);
    if (!b) this.cache.set(k, (b = GENERATED[k].make(this.ctx)));
    return b;
  }

  private startChannel(c: SourceChannel) {
    c.stop();
    let buf: AudioBuffer | null = null;
    if (isGenerated(c.kind)) buf = this.generated(c.kind);
    else if (c.kind === 'file') buf = c.file;
    else if (c.kind === 'mic' && this.mic) {
      const m = this.ctx.createMediaStreamSource(this.mic);
      m.connect(c.input);
      c.player = m;
      return;
    }
    if (!buf) return;
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    if (c.kind === 'file' && c.partner && buf.numberOfChannels >= 2) {
      // Stereo pair: channel 0 -> left speaker, channel 1 -> right speaker, from one sample-synchronous player.
      const sp = this.ctx.createChannelSplitter(2);
      s.connect(sp);
      sp.connect(c.input, 0);
      sp.connect(c.partner.ch.input, 1);
      c.splitter = sp;
    } else s.connect(c.input);
    // Musical loops share one tempo: start them in phase with the context clock.
    s.start(0, isGenerated(c.kind) && GENERATED[c.kind].sync ? this.ctx.currentTime % buf.duration : 0);
    c.player = s;
  }

  /** Select what a source plays (restarts it if the transport is running and the kind changed). Idempotent. */
  setSignal(slot: number, kind: SignalKind) {
    const c = this.ch(slot);
    const restart = signalNeedsRestart(c.kind, kind, !!c.player);
    c.kind = kind;
    if (restart && this.playing) this.startChannel(c);
  }

  /** Start all sources. */
  play() {
    this.playing = true;
    for (const c of this.channels.values()) if (!c.follower) this.startChannel(c);
  }

  stop() {
    for (const c of this.channels.values()) c.stop();
    this.playing = false;
  }
}
