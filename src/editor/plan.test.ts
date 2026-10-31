import { describe, expect, it } from 'vitest';
import plansText from '../../core/testdata/plans.txt?raw';
import type { Pt, Wall } from '../scene';
import { analyzePlan } from '../test-core';
import { locateAt, obstacleInfo } from './obstacles';
import { hasRoom, locate, type Region } from './rooms';

interface Case {
  name: string;
  walls: Wall[];
  rooms: number;
  obstacles: number;
  area: number;
  probes: [Pt, Region][];
}

/** Cases shared with the Rust tests (core/src/plan.rs): same file, same expectations. */
function loadCases(): Case[] {
  const cases: Case[] = [];
  let c: Case | null = null;
  for (const line of plansText.split('\n').map((l: string) => l.trim())) {
    if (!line || line.startsWith('#')) continue;
    const t = line.split(/\s+/);
    const n = (i: number) => parseFloat(t[i]);
    if (t[0] === 'case') c = { name: t[1], walls: [], rooms: 0, obstacles: 0, area: 0, probes: [] };
    else if (!c) throw new Error('fixture: keyword outside a case');
    else if (t[0] === 'wall') c.walls.push({ a: [n(1), n(2)], b: [n(3), n(4)], mat: 'plaster' });
    else if (t[0] === 'rooms') [c.rooms, c.obstacles] = [n(1), n(2)];
    else if (t[0] === 'area') c.area = n(1);
    else if (t[0] === 'probe') c.probes.push([[n(1), n(2)], t[3] as Region]);
    else if (t[0] === 'end') cases.push(c);
  }
  return cases;
}

// The analysis runs in the Rust core (also tested natively against the same fixture); this checks the FFI path
// (packing, decoding) and the UI-side point classification on its results.
describe('plan analysis through the FFI (shared fixture)', () => {
  const cases = loadCases();
  it('has the expected number of cases', () => expect(cases.length).toBeGreaterThanOrEqual(15));
  for (const c of cases) {
    it(c.name, () => {
      const plan = analyzePlan(c.walls);
      const rooms = plan.faces.filter((f) => f.region === 'room');
      expect(rooms.length).toBe(c.rooms);
      expect(plan.faces.length - rooms.length).toBe(c.obstacles);
      expect(rooms.reduce((s, f) => s + f.area, 0)).toBeCloseTo(c.area, 4) // areas travel as f32;
      expect(hasRoom(plan)).toBe(c.rooms > 0);
      for (const [p, r] of c.probes) expect(locate(plan, p), `probe ${p}`).toBe(r);
    });
  }
});

describe('plan analysis on the presets', () => {
  it('every preset is closed; multi-room presets have several rooms of the full floor area', async () => {
    const { PRESETS } = await import('../presets');
    const rooms = Object.fromEntries(
      PRESETS.map((p) => {
        const sc = p.make();
        const plan = analyzePlan(sc.walls);
        expect(hasRoom(plan), p.name).toBe(true);
        // furniture boxes are the only obstacles: one per closed 4-wall box
        expect(plan.faces.filter((f) => f.region === 'obstacle').length, p.name).toBeLessThanOrEqual(sc.walls.length / 4);
        // height-aware: a source on a stage or a listener above a table top is in the room, one inside a closed box is not
        const obs = obstacleInfo(plan, sc.walls, sc.height);
        const [sx, sy, sz] = sc.sources[0].pos;
        expect(locateAt(plan, obs, [sx, sy], sz), `${p.name}: source`).toBe('room');
        expect(locateAt(plan, obs, [sc.listener[0], sc.listener[1]], sc.listener[2]), `${p.name}: listener`).toBe('room');
        return [p.name, plan.faces.filter((f) => f.region === 'room').length];
      }),
    );
    expect(rooms['Apartment (3 rooms, doors)']).toBe(3);
    expect(rooms['Curtain-divided room']).toBe(1);
    expect(rooms['Two rooms + doorway']).toBe(1);
    expect(rooms['L-shaped room']).toBe(1);
  });
});

describe('room change keeps the sources', () => {
  it('every preset takes 4 sources inside its room, with their settings', async () => {
    const { PRESETS, carrySources } = await import('../presets');
    const { makeSource } = await import('../scene');
    const old = [0, 1, 2, 3].map((i) => ({ ...makeSource(i, [1, 1, 1.5]), gain: 0.5 + i / 10, signal: 'drums' as const, eq: { low: i, lowMid: 0, highMid: 0, high: 0 } }));
    for (const p of PRESETS) {
      const sc = p.make();
      const out = carrySources(old, sc);
      const plan = analyzePlan(sc.walls);
      expect(out.map((s) => s.id), p.name).toEqual(old.map((s) => s.id));
      expect(out[0].pos.slice(0, 2), p.name).toEqual(sc.sources[0].pos.slice(0, 2));
      out.forEach((s, i) => {
        expect(locateAt(plan, obstacleInfo(plan, sc.walls, sc.height), [s.pos[0], s.pos[1]], s.pos[2]), `${p.name}: source ${i}`).toBe('room');
        expect(s.pos[2]).toBeLessThan(sc.height);
        expect(s.gain).toBe(old[i].gain);
        expect(s.eq.low).toBe(i);
      });
      const keys = new Set(out.map((s) => s.pos.slice(0, 2).map((v) => v.toFixed(2)).join()));
      expect(keys.size, `${p.name}: distinct spots`).toBe(out.length);
    }
  });
});
