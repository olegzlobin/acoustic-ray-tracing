import { describe, expect, it } from 'vitest';
import { carrySources, PRESETS } from '../presets';
import { SceneStore } from './scene-store.svelte';

describe('undo covers the placement', () => {
  it('a source drag, a pair turn and the listener are single undo steps, redo brings them back', () => {
    const st = new SceneStore();
    const s0 = [...st.scene.sources[0].pos];
    st.beginEdit();
    st.moveSource(0, [s0[0] + 1, s0[1] + 0.5]);
    st.moveSource(0, [s0[0] + 2, s0[1] + 1]); // several moves during one drag
    st.endEdit();
    st.beginEdit();
    st.updateSource(0, { angle: 1.2 });
    st.endEdit();
    st.beginEdit();
    st.scene.listener = [1, 1, st.scene.listener[2]];
    st.endEdit();

    st.undo(); // listener
    expect(st.scene.listener.slice(0, 2)).not.toEqual([1, 1]);
    st.undo(); // pair turn
    expect(st.scene.sources[0].angle).toBe(0);
    expect(st.scene.sources[0].pos[0]).toBeCloseTo(s0[0] + 2);
    st.undo(); // the whole drag
    expect(st.scene.sources[0].pos.slice(0, 2)).toEqual(s0.slice(0, 2));
    st.redo();
    expect(st.scene.sources[0].pos[0]).toBeCloseTo(s0[0] + 2);
  });
  it('new and carried sources are speakers facing the listener', () => {
    const st = new SceneStore();
    const toward = (s: { pos: number[]; angle: number }) => {
      const want = Math.atan2(st.scene.listener[1] - s.pos[1], st.scene.listener[0] - s.pos[0]);
      return Math.cos(s.angle - want);
    };
    expect(st.scene.sources[0].directivity).toBe('speaker');
    expect(toward(st.scene.sources[0])).toBeCloseTo(1, 9);
    st.addSource();
    const added = st.scene.sources[st.scene.sources.length - 1];
    expect(added.directivity).toBe('speaker');
    expect(toward(added)).toBeCloseTo(1, 9);
  });
  it('a preset change keeps the facing angle and directivity of carried sources', () => {
    const st = new SceneStore();
    st.updateSource(0, { directivity: 'voice', angle: 3 });
    const old = st.scene.sources;
    const next = PRESETS[2].make();
    const carried = carrySources(old, next);
    expect(carried[0].directivity).toBe('voice');
    expect(carried[0].angle).toBe(3);
  });
  it('restores the surface detail', () => {
    const st = new SceneStore();
    const d = st.scene.detail;
    st.setDetail(0.2);
    st.endEdit();
    st.undo();
    expect(st.scene.detail).toBe(d);
  });
});
