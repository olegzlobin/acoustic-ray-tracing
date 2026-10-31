<script lang="ts">
  import type { SelectionActions } from '../editor/plan/actions';
  import type { PlanProps } from '../editor/plan/types';
  import { totalLength } from '../editor/transform';
  import { isPartialWall, wallRange } from '../scene';
  import { matName, t, tp } from '../i18n.svelte';

  interface Props {
    props: PlanProps;
    actions: SelectionActions;
    matColor: Map<string, string>;
    /** Left offset (ruler width) in px. */
    pad: number;
  }
  let { props, actions, matColor, pad }: Props = $props();

  const selMats = $derived([...new Set(props.selection.map((i) => props.scene.walls[i]?.mat).filter(Boolean))]);
  const selLen = $derived(totalLength(props.scene.walls, props.selection));

  // Height of the selection: full (floor to ceiling) or a bottom / top in metres.
  const roomH = $derived(props.scene.height);
  const sel = $derived(props.selection.map((i) => props.scene.walls[i]).filter(Boolean));
  const fullN = $derived(sel.filter((w) => !isPartialWall(w, roomH)).length);
  const allFull = $derived(fullN === sel.length);
  /** Bottom (0) or top (1) shared by all selected walls, null when they differ. */
  const common = (k: 0 | 1): number | null => {
    const v = sel.map((w) => wallRange(w, roomH)[k]);
    return v.length && v.every((x) => Math.abs(x - v[0]) < 5e-3) ? v[0] : null;
  };
  const shown = (k: 0 | 1) => {
    const c = common(k);
    return c === null ? '' : c.toFixed(2);
  };
  let bad = $state<0 | 1 | null>(null);
  function applyZ(e: Event & { currentTarget: HTMLInputElement }, k: 0 | 1) {
    const el = e.currentTarget;
    const v = el.value.trim() === '' ? NaN : Math.round(Number(el.value) * 100) / 100;
    const same = common(k) !== null && Math.abs(common(k)! - v) < 5e-3;
    if (same || !Number.isFinite(v)) bad = null;
    else bad = actions.setSelectionHeight(k === 0 ? v : undefined, k === 1 ? v : undefined) ? null : k;
    if (bad !== null || same || !Number.isFinite(v)) el.value = shown(k); // rejected: back to the current value
  }
</script>

{#if props.selection.length}
  <div class="selpanel" style="left:{pad + 8}px">
    <b>{tp('sel.count', props.selection.length)}</b>
    <span class="sw" style="background:{selMats.length === 1 ? matColor.get(selMats[0]) ?? 'var(--muted)' : 'var(--muted)'}"></span>
    <select aria-label={t('sel.matAria')} value={selMats.length === 1 ? selMats[0] : ''} onchange={(e) => actions.setSelectionMat(e.currentTarget.value)}>
      {#if selMats.length !== 1}<option value="" disabled>{t('sel.mixed')}</option>{/if}
      {#each props.scene.materials as m}<option value={m.id}>{matName(m)}</option>{/each}
    </select>
    <span class="dim">{selLen.toFixed(2)}&thinsp;{t('u.m')}</span>
    <label class="full" title={t('sel.fullTip')}>
      <input type="checkbox" checked={allFull} indeterminate={!allFull && fullN > 0} onchange={(e) => actions.setSelectionFull(e.currentTarget.checked)} />
      {t('sel.full')}
    </label>
    {#if !allFull}
      <label class="z">{t('sel.zLow')}
        <input type="number" min="0" max={roomH} step="0.05" placeholder="—" aria-label={t('sel.zLowAria')} aria-invalid={bad === 0} value={shown(0)} onchange={(e) => applyZ(e, 0)} />
      </label>
      <label class="z">{t('sel.zTop')}
        <input type="number" min="0" max={roomH} step="0.05" placeholder="—" aria-label={t('sel.zTopAria')} aria-invalid={bad === 1} value={shown(1)} onchange={(e) => applyZ(e, 1)} />
      </label>
      <span class="dim">{t('u.m')}</span>
    {/if}
    <button aria-label={t('sel.copy')} title={t('sel.copyTip')} onclick={actions.copySelection}>{t('sel.copy')}</button>
    <button aria-label={t('sel.duplicate')} title={t('sel.duplicateTip')} onclick={actions.duplicateSelection}>{t('sel.duplicate')}</button>
    <button aria-label={t('sel.rotCcwAria')} title={t('sel.rotCcwTip')} onclick={() => actions.rotateSelection(90)}>⟲ 90°</button>
    <button aria-label={t('sel.rotCwAria')} title={t('sel.rotCwTip')} onclick={() => actions.rotateSelection(-90)}>⟳ 90°</button>
    <button aria-label={t('sel.flipHAria')} title={t('sel.flipHTip')} onclick={() => actions.flipSelection('h')}>{t('sel.flipH')}</button>
    <button aria-label={t('sel.flipVAria')} title={t('sel.flipVTip')} onclick={() => actions.flipSelection('v')}>{t('sel.flipV')}</button>
    <button aria-label={t('sel.deleteAria')} title={t('sel.deleteTip')} onclick={actions.deleteSelection}>{t('sel.delete')}</button>
  </div>
{/if}

<style>
  .selpanel { position: absolute; bottom: 48px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 8px; max-width: calc(100% - 16px); font-size: 12px; }
  .selpanel select { width: auto; min-height: 28px; padding: 4px 8px; }
  .selpanel button { min-height: 28px; padding: 4px 8px; }
  .sw { width: 16px; height: 16px; border-radius: var(--radius); border: 1px solid var(--line); flex: none; display: inline-block; }
  .dim { color: var(--muted); font-size: 12px; }
  .full, .z { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; }
  .full input { margin: 0; }
  .z input { width: 64px; min-height: 28px; padding: 4px 6px; font: 12px var(--font-mono); font-variant-numeric: tabular-nums; }
  .z input[aria-invalid='true'] { border-color: var(--warn); }
  .selpanel .dim { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
</style>
