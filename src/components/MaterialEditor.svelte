<script lang="ts">
  import { matName, t } from '../i18n.svelte';
  import { MAX_TL, alphaRaised, swatchFor, tlToTau, type Material } from '../materials';

  interface Props {
    materials: Material[];
    usage: Map<string, number>;
    onadd: (copyFrom?: string) => string;
    onupdate: (id: string, patch: Partial<Material>) => void;
    oncommit: () => void;
    ondelete: (id: string) => void;
  }
  let { materials, usage, onadd, onupdate, oncommit, ondelete }: Props = $props();

  const BANDS = ['125', '250', '500', '1k', '2k', '4k'];
  const bandLabel = (b: string) => b.replace('k', t('band.k'));
  let currentId = $state('plaster');
  const cur = $derived(materials.find((m) => m.id === currentId) ?? materials[0]);
  const used = $derived(usage.get(cur?.id ?? '') ?? 0);

  function setAlpha(i: number, v: number) {
    const a = [...cur.alpha];
    a[i] = v;
    onupdate(cur.id, { alpha: a });
  }
  function setScatter(i: number, v: number) {
    const s = [...cur.s];
    s[i] = v;
    onupdate(cur.id, { s });
  }
  function setTl(i: number, v: number) {
    const t = [...cur.tl];
    t[i] = v;
    onupdate(cur.id, { tl: t });
  }
  // Bands where tau = 10^(-TL/10) exceeds alpha: the core raises alpha to tau there (energy that is
  // transmitted is not reflected).
  const raised = $derived(alphaRaised(cur).flatMap((r, i) => (r ? [BANDS[i]] : [])));
  const tauText = (tl: number) => {
    const t = tlToTau(tl);
    return t >= 0.01 ? t.toFixed(2) : t.toExponential(0);
  };
</script>

{#if cur}
  <div class="me">
    <div class="row">
      <span class="sw" style="background:{cur.color}"></span>
      <select bind:value={currentId}>
        {#each materials as m}<option value={m.id}>{m.builtin ? '' : '★ '}{matName(m)}</option>{/each}
      </select>
    </div>
    <div class="row btns">
      <button onclick={() => (currentId = onadd())}>{t('mat.new')}</button>
      <button onclick={() => (currentId = onadd(cur.id))}>{t('mat.duplicate')}</button>
      <button disabled={cur.builtin} title={cur.builtin ? t('mat.deleteLib') : used ? t('mat.deleteUsed', { n: used }) : t('mat.delete')} onclick={() => { const id = cur.id; currentId = 'plaster'; ondelete(id); }}>{t('mat.delete')}</button>
    </div>
    {#if cur.builtin}
      <p class="dim">{t('mat.libNote')}</p>
    {:else}
      <div class="row">
        <input type="text" value={cur.name} maxlength="40" oninput={(e) => onupdate(cur.id, { name: e.currentTarget.value || t('mat.customName') })} onchange={oncommit} />
        <input type="color" value={cur.color} oninput={(e) => onupdate(cur.id, { color: e.currentTarget.value })} onchange={oncommit} />
      </div>
    {/if}
    <div class="sliders">
      {#each BANDS as b, i}
        <label class="param"><span>{bandLabel(b)} {t('u.hz')} α</span><span class="val">{cur.alpha[i].toFixed(2)}</span>
          <input type="range" min="0.01" max="0.99" step="0.01" value={cur.alpha[i]} disabled={cur.builtin} oninput={(e) => setAlpha(i, +e.currentTarget.value)} onchange={oncommit} />
        </label>
      {/each}
    </div>
    <div class="sliders" title={t('mat.scatterTip')}>
      {#each BANDS as b, i}
        <label class="param"><span>{bandLabel(b)} {t('u.hz')} s</span><span class="val">{cur.s[i].toFixed(2)}</span>
          <input type="range" min="0" max="1" step="0.01" value={cur.s[i]} disabled={cur.builtin} oninput={(e) => setScatter(i, +e.currentTarget.value)} onchange={oncommit} />
        </label>
      {/each}
    </div>
    <div class="sliders" title={t('mat.tlTip')}>
      {#each BANDS as b, i}
        <label class="param"><span>{bandLabel(b)} {t('u.hz')} TL <span class="dim num">τ {tauText(cur.tl[i])}</span></span><span class="val">{cur.tl[i].toFixed(0)}&thinsp;{t('u.db')}</span>
          <input type="range" min="0" max={MAX_TL} step="1" value={cur.tl[i]} disabled={cur.builtin} oninput={(e) => setTl(i, +e.currentTarget.value)} onchange={oncommit} />
        </label>
      {/each}
    </div>
    {#if raised.length}
      <p class="dim">{t('mat.raised', { bands: raised.map(bandLabel).join(', '), hz: t('u.hz') })}</p>
    {/if}
  </div>
{/if}

<style>
  .me { display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row select, .row input[type='text'] { flex: 1; min-width: 0; }
  /* three equal buttons that fit the 300px panel in any language */
  .row.btns { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .row.btns button { padding: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  input[type='color'] { width: 40px; height: 32px; padding: 0; background: none; border: 1px solid var(--line); border-radius: var(--radius); }
  .btns button { flex: 1; }
  .sw { width: 16px; height: 16px; border-radius: var(--radius); border: 1px solid var(--line); flex: none; }
  .sliders { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; }
  .dim { color: var(--muted); font-size: 12px; margin: 0; }
</style>
