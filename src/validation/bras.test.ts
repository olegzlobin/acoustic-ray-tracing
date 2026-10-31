// BRAS validation against the measured RIRs (RS1, RS5). Skipped unless the data directory exists:
//   npm run validate:bras        (BRAS_DIR = data dir, default ~/data/bras; BRAS_OUT = report .md, JSON written next to it)
// Asserts sanity only (finite numbers, peaks where expected); the report is for interpretation.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { testCore } from '../test-core';
import { jsonReport, markdownReport } from './bras-report';
import { braConfigDir, braDataPresent, checkMaterials, libraryDiffuserS, runRs1, runRs5, type Rs1Result, type Rs5Result } from './bras-run';

const SCRATCH = '/tmp/claude-1000/-home-oleg-projects/4b016bfb-6c87-442a-b1da-96ffa429af7c/scratchpad';
const OUT = process.env.BRAS_OUT ?? join(SCRATCH, 'bras-report.md');
// Sim vs measured peak time. Shadow pairs get the search range of the peak finder: a diffracted pulse is low-passed and
// its measured peak lags the geometric arrival by up to ~0.4 ms in the deep shadow (the sim has no such lag).
const PEAK_DIFF = 0.0003;
const PEAK_DIFF_SHADOW = 0.0005;

describe.skipIf(!braDataPresent())('BRAS validation', () => {
  let rs1: Rs1Result;
  let rs5: Rs5Result;
  const materialCheck = checkMaterials(braConfigDir());

  it('RS1: single reflection, rigid / absorbing / diffuse', () => {
    rs1 = runRs1(testCore);
    expect(rs1.cases.length).toBeGreaterThan(0);
    expect(rs1.rows.length).toBeGreaterThan(0);
    for (const c of rs1.cases) {
      const tag = `${c.variant} LS${c.ls}-MP${c.mp}`;
      expect(Number.isFinite(c.meas.tRefl) && c.meas.short.every(Number.isFinite), tag).toBe(true);
      for (const [k, s] of Object.entries(c.sim)) {
        expect(s.short.every(Number.isFinite), `${tag} sim ${k}`).toBe(true);
        expect(Math.abs(s.tRefl - c.meas.tRefl), `${tag} sim ${k} reflection time`).toBeLessThanOrEqual(PEAK_DIFF);
        expect(Math.abs(s.tDirect - c.meas.tDirect), `${tag} sim ${k} direct time`).toBeLessThanOrEqual(PEAK_DIFF);
      }
    }
    for (const r of rs1.rows) {
      expect([...r.meas, ...r.sim, ...r.err].every(Number.isFinite), `${r.variant} ${r.simVariant} LS${r.ls}-MP${r.mp} ${r.window}`).toBe(true);
    }
  });

  it('RS5: partition, 16 pairs', () => {
    rs5 = runRs5(testCore);
    expect(rs5.pairs).toHaveLength(16);
    for (const p of rs5.pairs) {
      const tag = `LS${p.ls}-MP${p.mp}`;
      for (const w of ['short', 'long'] as const) expect([...p.A[w].meas, ...p.A[w].sim].every(Number.isFinite), `${tag} ${w}`).toBe(true);
      expect(Math.abs(p.sim.t - p.meas.t), `${tag} first arrival`).toBeLessThanOrEqual(p.visible ? PEAK_DIFF : PEAK_DIFF_SHADOW);
    }
  });

  it('constants match the BRAS surface CSV octave means', () => {
    if (materialCheck) for (const [k, dev] of Object.entries(materialCheck)) expect(dev, k).toBeLessThan(0.0006);
  });

  // The report is written even when a sanity assertion above fails, so the numbers can be inspected.
  afterAll(() => {
    if (!rs1 || !rs5) return;
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, markdownReport({ rs1, rs5, materialCheck, libraryS: libraryDiffuserS() }));
    writeFileSync(OUT.replace(/\.md$/, '') + '.json', jsonReport({ rs1, rs5, materialCheck }));
    console.log(`BRAS report: ${OUT}`);
  });
});
