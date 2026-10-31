<script lang="ts">
  import { hasClip } from '../editor/clipboard';
  import { clampInt, type SelectionActions } from '../editor/plan/actions';
  import { drawing, isShape, SHAPES, type PlanProps, type ToolId } from '../editor/plan/types';
  import type { PlanUi } from '../editor/plan/ui.svelte';
  import type { Viewport } from '../editor/plan/viewport.svelte';
  import { MAX_CIRCLE_SEGS, MAX_SIDES, MIN_SIDES, STAMPS } from '../editor/shapes';
  import { matName, t, td } from '../i18n.svelte';

  interface Props {
    props: PlanProps;
    ui: PlanUi;
    actions: SelectionActions;
    vp: Viewport;
    matColor: Map<string, string>;
    /** Top-left offset (ruler width) in px. */
    pad: number;
  }
  let { props, ui, actions, vp, matColor, pad }: Props = $props();

  const tool = $derived(props.tool);
  const drawMat = $derived(props.drawMat);
  const grid = $derived(props.grid);
  const matNameOf = (id: string) => {
    const m = props.scene.materials.find((x) => x.id === id);
    return m ? matName(m) : id;
  };
</script>

<div class="top" style="top:{pad + 8}px; left:{pad + 8}px">
  <div class="toolbar">
    {#if props.lead}<span class="lead">{@render props.lead()}</span>{/if}
    <button class:on={tool === 'select'} aria-pressed={tool === 'select'} aria-label={t('tb.selectAria')} title={t('tb.selectTip')} onclick={() => props.ontool('select')}>{t('tb.select')}</button>
    <button class:on={tool === 'draw'} aria-pressed={tool === 'draw'} aria-label={t('tb.drawAria')} title={t('tb.drawTip')} onclick={() => props.ontool('draw')}>{t('tb.draw')}</button>
    <select class="shapes" class:on={isShape(tool)} aria-label={t('tb.shapes')} title={t('tb.shapesTip')} value={isShape(tool) ? tool : ''} onchange={(e) => props.ontool(e.currentTarget.value as ToolId)}>
      <option value="" disabled selected={!isShape(tool)}>{t('tb.shapes')}</option>
      {#each SHAPES as s}<option value={s.id} selected={s.id === tool}>{td('shape', s.id, s.name)} ({s.key})</option>{/each}
    </select>
    <button class:on={tool === 'measure'} aria-pressed={tool === 'measure'} aria-label={t('tb.measureAria')} title={t('tb.measureTip')} onclick={() => props.ontool('measure')}>{t('tb.measure')}</button>
    {#if ui.clipN > 0 || hasClip()}
      <button aria-label={t('tb.paste')} title={t('tb.pasteTip')} onclick={actions.pasteClipboard}>{t('tb.paste')}</button>
    {/if}
    <button aria-label={t('tb.undo')} title={t('tb.undoTip')} disabled={!props.canUndo} onclick={props.onundo}>{t('tb.undo')}</button>
    <button aria-label={t('tb.redo')} title={t('tb.redoTip')} disabled={!props.canRedo} onclick={props.onredo}>{t('tb.redo')}</button>
    <button aria-label={t('tb.fitAria')} title={t('tb.fitAria')} onclick={() => vp.userFit(props.scene)}>{t('tb.fit')}</button>
    <button aria-label={t('tb.help')} aria-expanded={ui.showHelp} title={t('tb.help')} class:on={ui.showHelp} onclick={() => (ui.showHelp = !ui.showHelp)}>?</button>
    <span class="sep"></span>
    <button class="minor" class:on={grid} aria-pressed={grid} aria-label={t('tb.gridAria')} title={t('tb.gridTip')} onclick={() => props.ongrid(!grid)}>{t('tb.grid')}</button>
    <button class="minor" class:on={ui.showRuler} aria-pressed={ui.showRuler} aria-label={t('tb.rulerAria')} title={t('tb.rulerTip')} onclick={() => (ui.showRuler = !ui.showRuler)}>{t('tb.ruler')}</button>
  </div>

  {#if drawing(tool) || tool === 'measure'}
    <div class="toolbar opts">
      {#if drawing(tool)}
        <span class="matpick">
          <button class="matbtn" aria-haspopup="listbox" aria-expanded={ui.matMenu} aria-label={t('tb.matAria', { name: matNameOf(drawMat) })} title={t('tb.matTip')} onclick={() => (ui.matMenu = !ui.matMenu)}>
            <span class="sw" style="background:{matColor.get(drawMat) ?? 'var(--muted)'}"></span>{matNameOf(drawMat)} ▾
          </button>
          {#if ui.matMenu}
            <div class="menu" role="listbox" aria-label={t('tb.matMenu')}>
              {#each props.scene.materials as m, i}
                <button role="option" aria-selected={m.id === drawMat} class:on={m.id === drawMat} onclick={() => { props.ondrawmat(m.id); ui.matMenu = false; }}>
                  <span class="sw" style="background:{m.color}"></span>{matName(m)}{#if i < 9}<kbd>{i + 1}</kbd>{/if}
                </button>
              {/each}
            </div>
          {/if}
        </span>
      {/if}
      {#if tool === 'polygon'}
        <label class="opt" title={t('tb.sidesTip')}>{t('tb.sides')}
          <input type="number" min={MIN_SIDES} max={MAX_SIDES} value={ui.params.sides} oninput={(e) => (ui.params.sides = clampInt(+e.currentTarget.value, MIN_SIDES, MAX_SIDES))} /></label>
      {:else if tool === 'circle' || tool === 'ellipse'}
        <label class="opt" title={t('tb.segsCircleTip')}>{t('tb.segments')}
          <input type="number" min="0" max={MAX_CIRCLE_SEGS} placeholder={t('tb.auto')} value={ui.params.circleSegs || ''} oninput={(e) => (ui.params.circleSegs = e.currentTarget.value === '' ? 0 : clampInt(+e.currentTarget.value, 0, MAX_CIRCLE_SEGS))} /></label>
      {:else if tool === 'arc'}
        <label class="opt" title={t('tb.segsArcTip')}>{t('tb.segments')}
          <input type="number" min="0" max={MAX_CIRCLE_SEGS} placeholder={t('tb.auto')} value={ui.params.arcSegs || ''} oninput={(e) => (ui.params.arcSegs = e.currentTarget.value === '' ? 0 : clampInt(+e.currentTarget.value, 0, MAX_CIRCLE_SEGS))} /></label>
      {:else if tool === 'stamp'}
        <select aria-label={t('tb.stamp')} value={ui.params.stamp} onchange={(e) => (ui.params.stamp = e.currentTarget.value)}>
          {#each STAMPS as s}<option value={s.id}>{td('stamp', s.id, s.name)}</option>{/each}
        </select>
      {/if}
      <button class:on={ui.shiftLock} aria-pressed={ui.shiftLock} aria-label={t('tb.shiftAria')} title={t('tb.shiftTip')} onclick={() => (ui.shiftLock = !ui.shiftLock)}>⇧ Shift</button>
      {#if tool === 'draw'}<span class="dim">{t('tb.hintDraw')}</span>
      {:else if tool === 'arc'}<span class="dim">{t('tb.hintArc')}</span>
      {:else if tool === 'stamp'}<span class="dim">{t('tb.hintStamp')}</span>
      {:else if tool === 'measure'}<span class="dim">{t('tb.hintMeasure')}</span>
      {:else}<span class="dim">{t('tb.hintShape')}</span>{/if}
    </div>
  {/if}

  {#if ui.showHelp}
    <div class="help" role="dialog" aria-label={t('help.title')}>
      <div>{@html t('help.tools')}</div>
      <div>{@html t('help.drawing')}</div>
      <div>{@html t('help.select')}</div>
      <div>{@html t('help.clipboard')}</div>
      <div>{@html t('help.view')}</div>
    </div>
  {/if}
</div>

<style>
  .top { position: absolute; right: 8px; display: flex; flex-direction: column; gap: 4px; pointer-events: none; align-items: flex-start; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; pointer-events: none; max-width: 100%; }
  .toolbar > * { pointer-events: auto; }
  .toolbar button, .toolbar select { padding: 4px 8px; min-height: 28px; font-size: 12px; }
  .toolbar select { width: auto; }
  .sep { width: 1px; height: 16px; background: var(--line); margin: 0 4px; pointer-events: none; }
  .toolbar select.on { border-color: var(--fg); }
  .toolbar button.minor { color: var(--muted); border-color: transparent; background: transparent; padding: 4px; }
  .toolbar button.minor:hover:not(:disabled) { color: var(--fg); }
  .toolbar button.minor.on { color: var(--fg); background: var(--raise); }
  .lead { display: flex; gap: 4px; margin-right: 8px; pointer-events: auto; }
  .opts { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 4px 8px; pointer-events: auto; }
  .opt { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); }
  .opt input { width: 64px; min-height: 28px; padding: 4px 8px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .matpick { position: relative; }
  .matbtn { display: inline-flex; align-items: center; gap: 8px; }
  .menu { position: absolute; left: 0; top: 100%; margin-top: 4px; z-index: 5; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 4px; max-height: 60vh; overflow-y: auto; min-width: 180px; }
  .menu button { display: flex; align-items: center; gap: 8px; text-align: left; border: 0; background: transparent; }
  .menu button.on { background: var(--fg); color: var(--bg); }
  .menu button.on kbd { color: var(--bg); border-color: var(--bg); }
  kbd { margin-left: auto; font: 600 11px var(--font-mono); border: 1px solid var(--line); border-radius: var(--radius); padding: 0 4px; color: var(--muted); }
  .help { pointer-events: auto; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 8px 12px; font-size: 12px; color: var(--muted); max-height: calc(100vh - 160px); overflow-y: auto; }
  .help div + div { margin-top: 4px; }
  .help :global(b) { color: var(--fg); margin-right: 4px; }
  .help :global(kbd) { margin: 0 1px; color: var(--fg); font: 600 11px var(--font-mono); border: 1px solid var(--line); border-radius: var(--radius); padding: 0 4px; }
  .sw { width: 16px; height: 16px; border-radius: var(--radius); border: 1px solid var(--line); flex: none; display: inline-block; }
  .dim { color: var(--muted); font-size: 12px; }
</style>
