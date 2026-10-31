<script lang="ts">
  import { BAND_COLORS, bandName } from '../bands';
  import { t } from '../i18n.svelte';
  import { persistOpen } from '../ui-open';

  interface Props {
    maxOrder: number;
    showOrders: boolean[];
    rays: number;
    showRays: boolean;
    transmission: boolean;
    diffraction: boolean;
    accurateHrtf: boolean;
    modes: boolean;
    showBands: boolean[];
    showEtc: boolean;
    showSchroeder: boolean;
  }
  let {
    maxOrder = $bindable(), showOrders = $bindable(), rays = $bindable(), showRays = $bindable(), transmission = $bindable(), diffraction = $bindable(), accurateHrtf = $bindable(), modes = $bindable(),
    showBands = $bindable(), showEtc = $bindable(), showSchroeder = $bindable(),
  }: Props = $props();
</script>

<details class="group" use:persistOpen={'calc'}>
  <summary>{t('calc.title')}</summary>
  <label>{t('calc.maxOrder')}
    <select bind:value={maxOrder}>{#each [0, 1, 2, 3] as o}<option value={o}>{o}</option>{/each}</select>
  </label>
  <div class="inline">
    <span class="dim">{t('calc.showOrders')}</span>
    {#each showOrders as _, o}
      <label class="chk c{o}"><input type="checkbox" bind:checked={showOrders[o]} />{o}</label>
    {/each}
  </div>
  <label>{t('calc.rays')}
    <select bind:value={rays}>
      <option value={0}>{t('calc.raysOff')}</option>
      <option value={2000}>2k</option>
      <option value={10000}>10k</option>
      <option value={20000}>20k</option>
      <option value={50000}>50k</option>
    </select>
  </label>
  <label class="chk"><input type="checkbox" bind:checked={showRays} />{t('calc.drawRays')}</label>
  <label class="chk" title={t('calc.transmissionTip')}><input type="checkbox" bind:checked={transmission} />{t('calc.transmission')}</label>
  <label class="chk" title={t('calc.diffractionTip')}><input type="checkbox" bind:checked={diffraction} />{t('calc.diffraction')}</label>
  <label class="chk" title={t('calc.accurateHrtfTip')}><input type="checkbox" bind:checked={accurateHrtf} />{t('calc.accurateHrtf')}</label>
  <label class="chk" title={t('calc.modesTip')}><input type="checkbox" bind:checked={modes} />{t('calc.modes')}</label>
  <div class="bands" title={t('calc.bandsTip')}>
    {#each BAND_COLORS as color, i}
      <label class="chk" style="color:{color}"><input type="checkbox" bind:checked={showBands[i]} />{bandName(i)}</label>
    {/each}
  </div>
  <div class="bands">
    <label class="chk" title={t('calc.etcTip')}><input type="checkbox" bind:checked={showEtc} />ETC</label>
    <label class="chk"><input type="checkbox" bind:checked={showSchroeder} />{t('calc.schroeder')}</label>
  </div>
</details>

<style>
  .inline { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
  .c0 { color: var(--series-2); } .c1 { color: var(--series-3); } .c2 { color: var(--series-4); } .c3 { color: var(--series-5); }
</style>
