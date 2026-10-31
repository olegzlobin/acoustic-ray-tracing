import type { Scene, Source } from '../scene';
import type { SceneStore } from './scene-store.svelte';

/** Map key of the right-channel slot of a stereo pair. */
export const rKey = (id: string) => `${id}:R`;

/**
 * Runtime slot of each source (up to 4) = its pipeline in the worker and its channel in the audio engine.
 * Slots are stable for a source's lifetime; a removed source frees its slot. A source whose stereo pair is
 * active owns a second slot (key `${id}:R`) for the right speaker, allocated only while the pair is active.
 * Construct during component initialisation (registers an effect).
 */
export class SlotMap {
  private map = $state<Record<string, number>>({});

  constructor(
    private scene: Scene,
    private store: SceneStore,
    /** Whether the source currently plays as a stereo pair (see stereo.ts). */
    private isPair: (s: Source) => boolean = () => false,
  ) {
    $effect(() => this.sync());
  }

  /** Keep the map in sync with the scene: new ids get a slot, removed ids (and an inactive pair's R key) free theirs. */
  sync() {
    const { scene } = this;
    const keys = new Set<string>();
    for (const s of scene.sources) {
      keys.add(s.id);
      this.slotFor(s.id);
    }
    for (const s of scene.sources) {
      if (!this.isPair(s)) continue;
      keys.add(rKey(s.id));
      this.slotFor(rKey(s.id));
    }
    for (const k of Object.keys(this.map)) if (!keys.has(k)) delete this.map[k];
    if (this.store.selSrc >= scene.sources.length) this.store.selSrc = Math.max(0, scene.sources.length - 1);
  }

  slotFor(id: string): number {
    if (this.map[id] !== undefined) return this.map[id];
    const used = new Set(Object.values(this.map));
    let s = 0;
    while (used.has(s)) s++;
    this.map[id] = s;
    return s;
  }
  /** Slot of the i-th source (0 when unknown). */
  slotOf = (i: number) => this.map[this.scene.sources[i]?.id ?? ''] ?? 0;
  /** Slot of the right speaker of the i-th source, only while its pair is active. */
  rSlotOf = (i: number): number | undefined => this.map[rKey(this.scene.sources[i]?.id ?? '')];
  /** Slot of a source id (or of a key such as `rKey(id)`) without allocating one. */
  peek(id: string): number | undefined {
    return this.map[id];
  }
  /** Slots of all current sources (left / centre slots only). */
  slots(): Set<number> {
    return new Set(this.scene.sources.map((s) => this.slotFor(s.id)));
  }
  /** Every allocated slot, right-channel slots included. */
  allSlots(): Set<number> {
    return new Set(Object.values(this.map));
  }
}
