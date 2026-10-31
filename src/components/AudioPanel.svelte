<script lang="ts">
  import { t } from '../i18n.svelte';
  import { persistOpen } from '../ui-open';

  interface Props {
    audioOk: boolean;
    loadInfo: { avg: number; peak: number } | null;
    dry: number;
    wet: number;
  }
  let { audioOk, loadInfo, dry = $bindable(), wet = $bindable() }: Props = $props();
</script>

<!-- Tail of the "Sound" group (the group itself is in App.svelte). -->
{#if !audioOk}<p class="err">{t('mix.noAudio')}</p>{/if}
<details class="sub" use:persistOpen={'sound.mix'}>
  <summary>{t('mix.title')}</summary>
  <label class="param"><span>{t('mix.dry')}</span><span class="val">{dry.toFixed(2)}</span><input type="range" min="0" max="1" step="0.01" bind:value={dry} /></label>
  <label class="param"><span>{t('mix.wet')}</span><span class="val">{wet.toFixed(2)}</span><input type="range" min="0" max="1.5" step="0.01" bind:value={wet} /></label>
  {#if loadInfo}<span class="dim num" title="AudioContext.renderCapacity">{t('mix.load', { avg: Math.round(loadInfo.avg * 100), peak: Math.round(loadInfo.peak * 100) })}</span>{/if}
  <p class="dim hint">{t('mix.headphones')}</p>
</details>
