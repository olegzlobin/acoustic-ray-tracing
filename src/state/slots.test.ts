import { describe, expect, it } from 'vitest';
import { makeSource, type Scene } from '../scene';
import { SlotMap, rKey } from './slots.svelte';
import type { SceneStore } from './scene-store.svelte';

// Effects do not run in the node test environment: `sync()` is the body of the effect.
function setup() {
  const scene = { sources: [makeSource(0, [1, 1, 1]), makeSource(1, [2, 2, 1])] } as unknown as Scene;
  const store = { selSrc: 0 } as SceneStore;
  const pair: Record<string, boolean> = {};
  const slots = new SlotMap(scene, store, (s) => !!pair[s.id]);
  slots.sync();
  return { scene, pair, slots };
}

describe('SlotMap stereo pair', () => {
  it('allocates the R slot only while the pair is active and frees it afterwards', () => {
    const { pair, slots } = setup();
    expect(slots.rSlotOf(0)).toBeUndefined();
    pair['s1'] = true;
    slots.sync();
    const r = slots.rSlotOf(0);
    expect(r).toBeDefined();
    expect(r).not.toBe(slots.slotOf(0));
    expect(r).not.toBe(slots.slotOf(1));
    expect(slots.peek(rKey('s1'))).toBe(r);
    expect(slots.allSlots().size).toBe(3);
    pair['s1'] = false;
    slots.sync();
    expect(slots.rSlotOf(0)).toBeUndefined();
    expect(slots.allSlots().size).toBe(2);
  });
  it('keeps main slots stable and frees the R slot when the source is removed', () => {
    const { scene, pair, slots } = setup();
    const main = slots.slotOf(1);
    pair['s2'] = true;
    slots.sync();
    expect(slots.slotOf(1)).toBe(main);
    expect(slots.rSlotOf(1)).toBeDefined();
    scene.sources = scene.sources.filter((s) => s.id !== 's2');
    slots.sync();
    expect(slots.peek(rKey('s2'))).toBeUndefined();
    expect(slots.allSlots().size).toBe(1);
  });
  it('reuses a freed slot number for the next pair', () => {
    const { pair, slots } = setup();
    pair['s1'] = true;
    slots.sync();
    const r = slots.rSlotOf(0);
    pair['s1'] = false;
    slots.sync();
    pair['s2'] = true;
    slots.sync();
    expect(slots.rSlotOf(1)).toBe(r);
  });
});
