<script lang="ts">
  import type { HeatMetric } from '../heatmap';
  import { METRIC_COLS } from '../layout';
  import { t } from '../i18n.svelte';
  import { persistOpen } from '../ui-open';
  import HeatPanel from './HeatPanel.svelte';
  import MetricsTable from './MetricsTable.svelte';

  interface Props {
    /** Metrics of the selected source: rows = 6 bands + broadband, columns EDT T20 T30 C50 C80 D50 Sab Eyr. */
    metrics: Float32Array | null;
    heatOn: boolean;
    heatMetric: HeatMetric;
    heatRays: number;
    heatOpacity: number;
    heatStatus: string;
  }
  let { metrics, heatOn = $bindable(), heatMetric = $bindable(), heatRays = $bindable(), heatOpacity = $bindable(), heatStatus }: Props = $props();

  const ALL_ROW = 6, R500 = 2, R1K = 3;
  const T20 = 1, T30 = 2, C50 = 3, D50 = 5;
  const val = (c: number, row = ALL_ROW) => {
    const v = metrics?.[row * METRIC_COLS + c];
    return v === undefined || !Number.isFinite(v) ? null : v;
  };
  /**
   * Single-number reverberation time as ISO 3382 reports it: the mean of the 500 Hz and 1 kHz bands.
   * Furnished rooms decay unevenly at low frequencies, so the broadband T30 fit often fails or wanders;
   * the mid bands stay stable. Falls back to T20 when T30 cannot be fitted.
   */
  const mid = (c: number) => {
    const a = val(c, R500), b = val(c, R1K);
    return a === null || b === null ? null : (a + b) / 2;
  };
  const rt = $derived.by(() => {
    const t30 = mid(T30);
    if (t30 !== null) return { v: t30, key: 'res.t30' as const };
    const t20 = mid(T20);
    return t20 === null ? null : { v: t20, key: 'res.t20' as const };
  });
  const thin = ' ';
  const c50 = $derived(val(C50));
  const d50 = $derived(val(D50));
</script>

<details class="group" open use:persistOpen={'result'}>
  <summary>{t('res.title')}</summary>
  <div class="kpis">
    <div class="kpi" title={t('res.t30Tip')}><span>{t(rt?.key ?? 'res.t30')}</span><span class="val">{rt === null ? '–' : `${rt.v.toFixed(2)}${thin}${t('u.s')}`}</span></div>
    <div class="kpi" title={t('res.c50Tip')}><span>{t('res.c50')}</span><span class="val">{c50 === null ? '–' : `${c50 < 0 ? '−' : ''}${Math.abs(c50).toFixed(1)}${thin}${t('u.db')}`}</span></div>
    <div class="kpi" title={t('res.d50Tip')}><span>{t('res.d50')}</span><span class="val">{d50 === null ? '–' : `${Math.round(d50 * 100)}${thin}%`}</span></div>
  </div>
  <label class="chk" title={t('res.heatTip')}><input type="checkbox" bind:checked={heatOn} />{t('res.heat')}</label>
  <details class="sub" use:persistOpen={'result.bands'}>
    <summary>{t('res.bands')}</summary>
    <MetricsTable {metrics} />
  </details>
  <details class="sub" use:persistOpen={'result.map'}>
    <summary>{t('res.map')}</summary>
    <HeatPanel on={heatOn} bind:metric={heatMetric} bind:rays={heatRays} bind:opacity={heatOpacity} status={heatStatus} />
  </details>
</details>

<style>
  .kpis { display: flex; flex-direction: column; gap: 4px; }
  .kpi { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 13px; }
  .val { font: 600 13px var(--font-mono); font-variant-numeric: tabular-nums; }
</style>
