// Audio controller: engine lifecycle (created on the first user gesture), play/stop, microphone and file
// signals, levels and the per-source sync with the scene. Construct during component initialisation
// (it registers effects).

import { AudioEngine } from '../audio/engine';
import { audioOk } from '../capabilities';
import { expose } from '../debug';
import { t } from '../i18n.svelte';
import type { Eq } from '../audio/eq';
import type { Scene, SignalKind, Source } from '../scene';
import { isPairActive } from '../stereo';
import type { SceneStore } from './scene-store.svelte';
import { rKey, type SlotMap } from './slots.svelte';

interface AudioDeps {
  scene: Scene;
  store: SceneStore;
  slots: SlotMap;
  /** Shown to the user (and cleared with ''). */
  setError: (message: string) => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class AudioController {
  engine = $state<AudioEngine | null>(null);
  busy = $state(false);
  playing = $state(false);
  dry = $state(0);
  wet = $state(1);
  loadInfo = $state<{ avg: number; peak: number } | null>(null);
  /** Non-empty while an audio file is being decoded. */
  decoding = $state('');
  readonly audioOk = audioOk;

  private fileNames = new Map<number, string>();
  private fileChans = new Map<number, number>();
  private fileNamesVer = $state(0);

  constructor(private deps: AudioDeps) {
    const { scene, slots } = deps;
    // Listener yaw, levels, per-source gain, equalizer and signal kinds
    $effect(() => {
      this.engine?.setYaw(scene.yaw);
    });
    $effect(() => this.engine?.setDry(this.dry));
    $effect(() => this.engine?.setWet(this.wet));
    $effect(() => {
      const e = this.engine;
      if (!e) return;
      const entries = JSON.parse(this.syncKey) as [string, number, SignalKind, Eq, boolean][];
      const keep = new Set<number>();
      for (const [id, , , , pair] of entries) {
        keep.add(slots.slotFor(id));
        if (pair) keep.add(slots.slotFor(rKey(id)));
      }
      e.prune(keep);
      for (const [id, gain, signal, eq, pair] of entries) this.syncEntry(e, id, gain, signal, eq, pair);
    });
    $effect(() => expose('__arEngine', this.engine));
  }

  /**
   * Only what the audio side needs per source (id, effective gain, signal kind, eq), as a string so that the
   * derived value stays equal, and the sync effect does not run, when a source merely moves.
   */
  private syncKey = $derived.by(() => JSON.stringify(this.deps.scene.sources.map((s) => [s.id, this.deps.store.effGain(s), s.signal, s.eq, this.pairActive(s)])));

  /** Whether the source plays as a stereo pair: a loaded file with two or more channels and stereo on. */
  pairActive = (s: Source): boolean => {
    const slot = this.deps.slots.peek(s.id);
    return isPairActive(s, slot === undefined ? 0 : this.fileChannels(slot));
  };
  /** Channel count of the file loaded into a slot (0: none). */
  fileChannels = (slot: number) => (this.fileNamesVer >= 0 ? this.fileChans.get(slot) ?? 0 : 0);

  /** Gain, equalizer, signal and pair wiring of one source (the right speaker gets the same gain and EQ). */
  private syncEntry(e: AudioEngine, id: string, gain: number, signal: SignalKind, eq: Eq, pair: boolean) {
    const { slots } = this.deps;
    const slot = slots.slotFor(id);
    if (pair) {
      const r = slots.slotFor(rKey(id));
      e.setPair(slot, r); // before anything addresses the right channel
      e.setSourceGain(r, gain);
      e.setSourceEq(r, eq);
    } else e.setPair(slot, null);
    e.setSourceGain(slot, gain);
    e.setSourceEq(slot, eq);
    e.setSignal(slot, signal);
  }

  private syncSource(e: AudioEngine, s: Source) {
    this.syncEntry(e, s.id, this.deps.store.effGain(s), s.signal, s.eq, this.pairActive(s));
  }

  async ensureEngine() {
    if (!this.engine) {
      if (!audioOk) throw new Error(t('err.noWebAudio'));
      this.engine = await AudioEngine.create(); // needs a user gesture
      this.engine.watchLoad((avg, peak) => (this.loadInfo = { avg, peak }));
    }
    return this.engine;
  }

  togglePlay = async () => {
    this.deps.setError('');
    try {
      this.busy = true;
      const e = await this.ensureEngine();
      if (this.playing) {
        e.stop();
        this.playing = false;
      } else {
        // Sync every source before starting (the sync effect may not have run yet).
        for (const s of this.deps.scene.sources) this.syncSource(e, s);
        for (const s of this.deps.scene.sources) {
          if (s.signal === 'mic') await e.enableMic();
        }
        e.play();
        this.playing = true;
      }
    } catch (e) {
      this.deps.setError(t('err.audio', { msg: message(e) }));
    } finally {
      this.busy = false;
    }
  };

  /** File input: decode and attach to the selected source. */
  onFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (f) await this.loadFile(f);
  };

  /** Decode an audio file into the selected source and switch it to the file signal (picker or drop). */
  loadFile = async (f: File) => {
    const { store, slots, setError } = this.deps;
    setError('');
    try {
      this.decoding = t('src.decoding', { name: f.name });
      const eng = await this.ensureEngine();
      const buf = await eng.decodeFile(f);
      const slot = slots.slotOf(store.selSrc);
      eng.setFile(slot, buf);
      this.fileNames.set(slot, f.name);
      this.fileChans.set(slot, buf.numberOfChannels);
      this.fileNamesVer++;
      store.updateSource(store.selSrc, { signal: 'file' });
      if (this.playing) eng.setSignal(slot, 'file');
    } catch (err) {
      setError(message(err));
    } finally {
      this.decoding = '';
    }
  };

  onSignalChange = async (i: number, kind: SignalKind) => {
    this.deps.setError('');
    if (kind === 'mic') {
      try {
        const eng = await this.ensureEngine();
        await eng.enableMic();
      } catch (e) {
        this.deps.setError(t('err.mic', { msg: message(e) }));
        return;
      }
    }
    this.deps.store.updateSource(i, { signal: kind });
  };

  fileName = (i: number) => (this.fileNamesVer >= 0 ? this.fileNames.get(this.deps.slots.slotOf(i)) ?? '' : '');

  /** A source was removed: free its channel. */
  removeSlot(slot: number) {
    this.engine?.removeSource(slot);
    this.fileNames.delete(slot);
    this.fileChans.delete(slot);
  }
}
