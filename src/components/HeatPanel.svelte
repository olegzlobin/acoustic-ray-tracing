<script lang="ts">
  import { HEAT_METRICS, type HeatMetric } from '../heatmap';
  import { t } from '../i18n.svelte';

  interface Props {
    on: boolean;
    metric: HeatMetric;
    rays: number;
    opacity: number;
    status: string;
  }
  let { on, metric = $bindable(), rays = $bindable(), opacity = $bindable(), status }: Props = $props();
</script>

<!-- Map settings (the on/off checkbox is in ResultPanel); rendered inside a collapsed <details class="sub">. -->
<div class="row2">
  <label>{t('heat.metric')}
    <select bind:value={metric}>{#each HEAT_METRICS as m}<option value={m.id}>{t(m.label)}</option>{/each}</select>
  </label>
  <label>{t('heat.rays')}
    <select bind:value={rays}>
      <option value={20000}>20k</option>
      <option value={50000}>50k</option>
      <option value={100000}>100k</option>
      <option value={200000}>200k</option>
    </select>
  </label>
</div>
<label class="param"><span>{t('heat.opacity')}</span><span class="val">{opacity.toFixed(2)}</span>
  <input type="range" min="0.1" max="1" step="0.05" bind:value={opacity} />
</label>
{#if on}<p class="dim" role="status">{status}</p>{/if}
<p class="dim">{t('heat.desc')}</p>
