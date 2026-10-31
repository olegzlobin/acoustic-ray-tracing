<script lang="ts">
  import { bandName } from '../bands';
  import { METRIC_COLS } from '../layout';
  import { t } from '../i18n.svelte';

  let { metrics }: { metrics: Float32Array | null } = $props();

  const COLS = ['EDT', 'T20', 'T30', 'C50', 'C80', 'D50', 'Sab', 'Eyr'];
  const UNITS = ['u.s', 'u.s', 'u.s', 'u.db', 'u.db', '', 'u.s', 'u.s'] as const;
  const TIPS = ['tip.edt', 'tip.t20', 'tip.t30', 'tip.c50', 'tip.c80', 'tip.d50', 'tip.sab', 'tip.eyr'] as const;
  const DEC = [2, 2, 2, 1, 1, 2, 2, 2];
  const fmt = (v: number | undefined, c: number) =>
    v === undefined || !isFinite(v) ? '–' : v.toFixed(DEC[c]);
</script>

<div class="scroll">
  <table>
    <thead>
      <tr><th>{t('u.hz')}</th>{#each COLS as c, i}<th title={t(TIPS[i])}>{c}<small>{UNITS[i] ? t(UNITS[i]) : ''}</small></th>{/each}</tr>
    </thead>
    <tbody>
      {#each Array(7) as _, r}
        <tr class:all={r === 6}>
          <th>{bandName(r)}</th>
          {#each COLS as __, c}<td>{fmt(metrics?.[r * METRIC_COLS + c], c)}</td>{/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .scroll { overflow-x: auto; max-width: 100%; }
  table { border-collapse: collapse; width: 100%; font: 11px var(--font-mono); font-variant-numeric: tabular-nums; }
  th, td { padding: 4px 1px; text-align: right; white-space: nowrap; }
  thead th { color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--line); }
  thead small { display: block; font-size: 11px; opacity: .7; }
  tbody th { color: var(--muted); text-align: left; font-weight: 600; }
  tr.all td, tr.all th { border-top: 1px solid var(--line); color: var(--fg); }
</style>
