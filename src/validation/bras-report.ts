// Markdown / JSON report of the BRAS validation.

import { BAND_HZ, C_CORE, C_MEAS } from './bras-constants';
import { LONG_GUARD, LONG_POST_MAX, POST, PRE, RS5_LONG_POST } from './bras-analysis';
import { SIM_VARIANT_TEXT, type Rs1Result, type Rs5Result } from './bras-run';

const f1 = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(1);
const ms = (s: number) => (s * 1000).toFixed(3);
const bandHead = (valid: boolean[]) => BAND_HZ.map((f, b) => (valid[b] ? `${f}` : `${f}*`)).join(' | ');
const cells = (m: number[], s: number[], e: number[], valid: boolean[]) =>
  m.map((_, b) => `${f1(m[b])} / ${f1(s[b])} / ${f1(e[b])}${valid[b] ? '' : '*'}`).join(' | ');

export interface ReportInput {
  rs1: Rs1Result;
  rs5: Rs5Result;
  materialCheck: Record<string, number> | null;
  libraryS: number[];
}

export function markdownReport({ rs1, rs5, materialCheck, libraryS }: ReportInput): string {
  const o: string[] = [];
  o.push('# BRAS validation: RS1 and RS5', '');
  o.push(
    `Measured: BRAS omni RIRs, 44.1 kHz, c = ${C_MEAS} m/s. Simulated: ISM through the core (c = ${C_CORE} m/s), omni source, anechoic box, no ray tail.`,
    `Cell format: **measured / simulated / error (sim - meas)**, dB. \`*\` = band not reliable for that window (the window is shorter than 2.4 ms * 500 Hz / fc, or 125 Hz).`,
    `Windows: short = Hann half-windows ${PRE * 1000} ms before / ${POST * 1000} ms after the peak; RS1 long = starts ${LONG_GUARD * 1000} ms after the direct peak, ends min(same length, ${LONG_POST_MAX * 1000} ms) after the reflection peak; RS5 long = ${PRE * 1000} ms before / ${RS5_LONG_POST * 1000} ms after the first-arrival peak.`,
    '',
  );
  if (materialCheck) {
    o.push('Material constants vs CSV octave means (max abs deviation): ' + Object.entries(materialCheck).map(([k, v]) => `${k} ${v.toFixed(4)}`).join(', '), '');
  }
  o.push(`Library "diffuser" s (variant c): [${libraryS.join(', ')}]`, '');

  o.push('## RS1: level change against the rigid floor, dL = 10 log10(E_variant / E_rigid)', '');
  o.push('Sim variants: ' + Object.entries(SIM_VARIANT_TEXT).map(([k, v]) => `**${k}** ${v}`).join('; '), '');
  for (const variant of ['Absorbing', 'Diffuse'] as const) {
    for (const simVariant of variant === 'Absorbing' ? ['a', 'b'] : ['c', 'd']) {
      for (const window of ['short', 'long'] as const) {
        const rows = rs1.rows.filter((r) => r.variant === variant && r.simVariant === simVariant && r.window === window);
        if (!rows.length) continue;
        o.push(`### ${variant}, sim ${simVariant}, ${window} window`, '');
        o.push(`| pair | angle | ${bandHead(rows[0].valid)} |`, `|---|---|${BAND_HZ.map(() => '---').join('|')}|`);
        for (const r of rows.sort((x, y) => x.ls - y.ls || x.mp - y.mp)) {
          o.push(`| LS${r.ls}-MP${r.mp}${r.specular ? '' : ' (non-spec.)'} | ${r.angle.toFixed(0)} deg | ${cells(r.meas, r.sim, r.err, r.valid)} |`);
        }
        o.push('');
      }
    }
  }

  o.push('### RS1 peak times (ms) and direct-sound exclusion', '');
  o.push('| variant | pair | direct meas / sim | refl expected | refl meas / sim | meas - sim refl | window start - direct peak, short meas / sim | long window pre/post | SNR meas (refl peak / pre-noise rms) |', '|---|---|---|---|---|---|---|---|---|');
  for (const c of rs1.cases) {
    const s = c.sim[Object.keys(c.sim)[0]];
    const exp = c.geo.rRefl / C_MEAS;
    o.push(
      `| ${c.variant} | LS${c.ls}-MP${c.mp} | ${ms(c.meas.tDirect)} / ${ms(s.tDirect)} | ${ms(exp)} | ${ms(c.meas.tRefl)} / ${ms(s.tRefl)} | ${((c.meas.tRefl - s.tRefl) * 1000).toFixed(3)} | ${ms(c.meas.marginShort)} / ${ms(s.marginShort)}${c.meas.marginShort < 0.001 ? ' (!)' : ''} | ${c.meas.long ? `${ms(c.meas.longPre)} / ${ms(c.meas.longPost)}` : 'n/a'} | ${c.meas.snr.toFixed(1)} |`,
    );
  }
  o.push('');
  if (rs1.skipped.length) o.push('Skipped: ' + rs1.skipped.join('; '), '');

  o.push('## RS5: attenuation against free field A = L(pair) - L(ref) + 20 log10(r / r_ref), ref = LS3-MP4 direct sound, short window', '');
  for (const window of ['short', 'long'] as const) {
    o.push(`### ${window} window`, '');
    const valid = BAND_HZ.map((_, b) => b >= 1);
    o.push(`| pair | path | clearance (m) | r (m) | ${bandHead(valid)} |`, `|---|---|---|---|${BAND_HZ.map(() => '---').join('|')}|`);
    for (const p of rs5.pairs) {
      const a = p.A[window];
      o.push(`| LS${p.ls}-MP${p.mp} | ${p.visible ? 'visible' : 'shadow'} | ${p.clearance >= 0 ? '+' : ''}${p.clearance.toFixed(3)} | ${p.r.toFixed(3)} | ${cells(a.meas, a.sim, a.err, valid)} |`);
    }
    o.push('');
  }
  o.push('### RS5 first-arrival times (ms)', '');
  o.push('| pair | expected meas (c=343.4) / sim (c=343) | peak meas | peak sim | meas - sim | SNR meas | sim paths (with energy / total) |', '|---|---|---|---|---|---|---|');
  for (const p of rs5.pairs) {
    o.push(`| LS${p.ls}-MP${p.mp} | ${ms(p.tExpectedMeas)} / ${ms(p.tExpectedSim)} | ${ms(p.meas.t)} | ${ms(p.sim.t)} | ${((p.meas.t - p.sim.t) * 1000).toFixed(3)} | ${p.meas.snr.toFixed(1)} | ${p.simAudiblePaths} / ${p.simPaths} |`);
  }
  o.push('');
  o.push(
    '## Notes', '',
    '- Simulated IR = W channel of `computeEarly` (ISM only), omni source, zero-phase octave band filters, linear 2-tap fractional delay (up to ~0.7 dB loss at the top of the 4 kHz band for a half-sample delay; cancels in RS1 dL, not in RS5 A).',
    '- RS5: the sim has exactly one path with energy per pair (direct or diffracted over the top edge). Floor-reflected paths pass through the opaque partition below its top and are removed; floor-reflected paths diffracted over the top edge do not exist in the model (diffraction is applied to the direct sound only).',
    '- RS5 peak times in the shadow: the measured peak lags the geometric arrival (low-passed diffracted pulse); the test allows 0.5 ms there instead of 0.3 ms.',
    '',
  );
  return o.join('\n');
}

/** JSON-safe copy (Infinity -> null). */
export const jsonReport = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 1);
