<script lang="ts">
  import { t } from '../i18n.svelte';
  import { EMBER_CSS, type HeatLayer, type HeatMetric } from '../heatmap';

  interface Props {
    heat: HeatLayer;
    metric: HeatMetric;
    /** Value under the cursor, already formatted. */
    hover: string;
  }
  let { heat, metric, hover }: Props = $props();
  const digits = $derived(metric === 'd50' ? 1 : 0);
</script>

<div class="legend" aria-label={t('heat.legend')}>
  <div class="lbl">{heat.label}{heat.progress < 1 ? ` · ${Math.round(heat.progress * 100)}%` : ''}</div>
  <div class="scale">
    <div class="grad" style="background:{EMBER_CSS}"></div>
    <span>{heat.vmin.toFixed(digits)} … {heat.vmax.toFixed(digits)}{heat.unit ? ` ${heat.unit}` : ''}</span>
  </div>
  {#if hover}<div class="hov">{hover}</div>{/if}
</div>

<style>
  .legend { position: absolute; right: 10px; bottom: 10px; display: flex; flex-direction: column; gap: 4px; padding: 4px 8px; border-radius: var(--radius); background: rgba(16, 22, 36, .72); font: 600 11px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fg); max-width: 60%; pointer-events: none; }
  .scale { display: flex; gap: 8px; align-items: center; }
  .grad { width: 90px; height: 8px; border-radius: 2px; flex: none; }
</style>
