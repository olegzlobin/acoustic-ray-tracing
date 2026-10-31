<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import PlanCanvas from './components/PlanCanvas.svelte';
  import type { ToolId } from './editor/plan/types';
  import IrPlot from './components/IrPlot.svelte';
  import SourcesPanel from './components/SourcesPanel.svelte';
  import RoomPanel from './components/RoomPanel.svelte';
  import ResultPanel from './components/ResultPanel.svelte';
  import AnalysisPanel from './components/AnalysisPanel.svelte';
  import AudioPanel from './components/AudioPanel.svelte';
  import QuickStart from './components/QuickStart.svelte';
  import { i18n, presetNameNow, setLang, srcName, t } from './i18n.svelte';
  import { persistOpen } from './ui-open';
  import { SceneStore } from './state/scene-store.svelte';
  import { HeatController } from './state/heat.svelte';
  import MaterialEditor from './components/MaterialEditor.svelte';
  import ExportPanel from './components/ExportPanel.svelte';
  import { RoomPlan } from './state/room-plan.svelte';
  import { AudioController } from './state/audio.svelte';
  import { ComputeController } from './state/compute.svelte';
  import { SlotMap } from './state/slots.svelte';
  import { audioOk, wasmOk } from './capabilities';
  import { decodeSceneHash, encodeSceneHash, MAX_HASH_CHARS, parseScene, serializeScene, type Pt } from './scene';
  import { planWarnings } from './editor/rooms';
  import { locateAt } from './editor/obstacles';
import { pairPositions, wrapAngle } from './stereo';
  import { download, safeName } from './io/download';
  import { runExport, type ExportKind, type Notice } from './io/run-export';
  import type { WavBits } from './io/wav';

  const STORAGE_KEY = 'art.scene.v1';
  const HINT_KEY = 'art.hint.v1';

  // ------------------------------------------------------------ scene + editing
  const store = new SceneStore();
  const scene = store.scene;
  const { beginEdit, endEdit, undo, redo, commitWalls, effGain, updateSource, moveSource, addSource } = store;
  let tool = $state<ToolId>('select');
  let grid = $state(true);

  // ------------------------------------------------------------ sources, compute, audio
  let error = $state('');
  // The slot map decides on the pair through the audio controller (declared next; read only inside effects).
  const slots: SlotMap = new SlotMap(scene, store, (s): boolean => audio.pairActive(s));
  const { slotOf } = slots;
  const audio = new AudioController({ scene, store, slots, setError: (m) => (error = m) });
  const compute = new ComputeController({ scene, store, slots, engine: () => audio.engine, setError: (m) => (error = m) });
  new RoomPlan(compute.worker, scene, store);
  const cur = $derived(compute.cur);
  /** Paths drawn on the plan: a stereo pair shows those of both speakers (the analysis panel stays on L). */
  const shownPaths = $derived.by(() => {
    const r = slots.rSlotOf(store.selSrc);
    const rp = r === undefined ? null : compute.analysis[r]?.paths;
    if (!rp?.length || !cur.paths?.length) return cur.paths;
    const both = new Float32Array(cur.paths.length + rp.length);
    both.set(cur.paths);
    both.set(rp, cur.paths.length);
    return both;
  });

  function removeSource(i: number) {
    const id = store.removeSource(i);
    const slot = id === null ? undefined : slots.peek(id);
    if (slot !== undefined) {
      audio.removeSlot(slot);
      compute.removeSlot(slot);
    }
  }

  /** Per source: plays as a stereo pair (two speakers). */
  const pairs = $derived(scene.sources.map((s) => audio.pairActive(s)));

  // Non-blocking warnings
  const warnings = $derived(
    !store.planReady
      ? []
      : planWarnings(store.plan, [
          ...scene.sources.flatMap((s, i): { name: string; p: Pt; z: number }[] => {
            if (!pairs[i]) return [{ name: srcName(s.name), p: [s.pos[0], s.pos[1]], z: s.pos[2] }];
            const { l, r } = pairPositions(s);
            return [
              { name: `${srcName(s.name)} L`, p: [l[0], l[1]], z: l[2] },
              { name: `${srcName(s.name)} R`, p: [r[0], r[1]], z: r[2] },
            ];
          }),
          { name: t('warn.listener'), p: [scene.listener[0], scene.listener[1]] as Pt, z: scene.listener[2] },
        ], (p, z) => locateAt(store.plan, store.obstacles, p, z ?? 0)),
  );

  // Autosave (all storage access guarded)
  $effect(() => {
    const json = JSON.stringify(serializeScene(scene));
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, json);
      } catch {
        /* private mode / quota: the app works without storage */
      }
    }, 600);
    return () => clearTimeout(t);
  });

  // ------------------------------------------------------------ heat map
  const heat = new HeatController({ worker: compute.worker, scene, plan: () => store.plan, transmission: () => compute.transmission, source: () => store.selSrc });

  // ------------------------------------------------------------ save / load / share / export
  let notice = $state<Notice | null>(null);
  let shareUrl = $state('');
  let exporting = $state(false);
  let exportProgress = $state<number | null>(null);

  function saveFile() {
    download(`${safeName(scene.name)}.json`, JSON.stringify(serializeScene(scene), null, 1), 'application/json');
    notice = { kind: 'info', text: t('notice.saved') };
  }
  // ------------------------------------------------------------ drag and drop: audio -> selected source, JSON -> scene
  let dropKind = $state<'audio' | 'scene' | null>(null);
  const isScene = (type: string, name = '') => type === 'application/json' || name.toLowerCase().endsWith('.json');
  const isAudio = (type: string, name = '') => type.startsWith('audio/') || /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|webm)$/i.test(name);
  function onDragOver(e: DragEvent) {
    const item = e.dataTransfer?.items?.[0];
    if (!item || item.kind !== 'file') return;
    e.preventDefault();
    // names are hidden until the drop; the MIME type is usually known (audio/*, application/json)
    dropKind = isScene(item.type) ? 'scene' : 'audio';
  }
  function onDrop(e: DragEvent) {
    const f = e.dataTransfer?.files?.[0];
    dropKind = null;
    if (!f) return;
    e.preventDefault();
    if (isScene(f.type, f.name)) void loadFile(f);
    else if (isAudio(f.type, f.name)) void audio.loadFile(f);
    else error = t('drop.unsupported', { name: f.name });
  }

  async function loadFile(f: File) {
    try {
      const r = parseScene(JSON.parse(await f.text()));
      if (!r.scene) {
        notice = { kind: 'error', text: t('notice.invalid', { name: f.name }), details: r.errors.slice(0, 8) };
        return;
      }
      store.presetIdx = -1;
      store.loadScene(r.scene);
      notice = { kind: 'info', text: t('notice.loaded', { name: r.scene.name }) };
    } catch (e) {
      notice = { kind: 'error', text: t('notice.readFail', { name: f.name, err: String(e) }) };
    }
  }
  async function share() {
    const h = await encodeSceneHash(scene);
    if (h.length > MAX_HASH_CHARS) {
      notice = { kind: 'error', text: t('notice.tooLarge', { n: h.length, max: MAX_HASH_CHARS }) };
      shareUrl = '';
      return;
    }
    shareUrl = `${location.origin}${location.pathname}#s=${h}`;
    try {
      window.history.replaceState(null, '', shareUrl);
      await navigator.clipboard.writeText(shareUrl);
      notice = { kind: 'info', text: t('notice.linkCopied', { n: h.length }) };
    } catch {
      notice = { kind: 'info', text: t('notice.linkReady', { n: h.length }) };
    }
  }

  async function loadHash() {
    const m = /^#s=(.+)$/.exec(location.hash);
    if (!m) return;
    const r = await decodeSceneHash(m[1]);
    if (r.scene) {
      store.presetIdx = -1;
      store.loadScene(r.scene);
      notice = { kind: 'info', text: t('notice.sharedLoaded', { name: r.scene.name }) };
    } else notice = { kind: 'error', text: t('notice.badLink'), details: r.errors };
  }

  // Sources that take part in an audio export: audible, with a refined IR (microphones never).
  const exportable = $derived.by(() => {
    const out: { i: number; slot: number; rSlot?: number }[] = [];
    scene.sources.forEach((s, i) => {
      if (effGain(s) > 0 && s.signal !== 'mic') out.push({ i, slot: slotOf(i), rSlot: slots.rSlotOf(i) });
    });
    return out;
  });
  // A stereo pair is ready only when both speakers are final.
  const allFinal = (list: { slot: number; rSlot?: number }[]) => list.length > 0 && list.every((x) => compute.isFinal(x.slot) && (x.rSlot === undefined || compute.isFinal(x.rSlot)));
  const canExport = $derived(allFinal(exportable) || allFinal([{ slot: slotOf(store.selSrc), rSlot: slots.rSlotOf(store.selSrc) }]));
  const exportHint = $derived(
    scene.sources.every((s) => s.signal === 'mic' || effGain(s) === 0)
      ? t('export.nothing')
      : t('export.wait'),
  );

  async function doExport(what: ExportKind, bits: WavBits) {
    if (exporting) return;
    exporting = true;
    exportProgress = 0;
    notice = null;
    try {
      notice = await runExport(what, bits, {
        scene,
        selected: store.selSrc,
        selectedIr: compute.exportIr(slotOf(store.selSrc)),
        sources: exportable.map(({ i, slot, rSlot }) => ({ index: i, ir: compute.exportIr(slot), irR: rSlot === undefined ? undefined : compute.exportIr(rSlot), file: audio.engine?.getFileBuffer(slot) ?? null, gain: effGain(scene.sources[i]), eq: scene.sources[i].eq })),
        dry: audio.dry,
        wet: audio.wet,
        onprogress: (p) => (exportProgress = p),
      });
    } catch (e) {
      notice = { kind: 'error', text: t('notice.exportFail', { err: e instanceof Error ? e.message : String(e) }) };
    } finally {
      exporting = false;
      exportProgress = null;
    }
  }

  // ------------------------------------------------------------ onboarding hint
  let showHint = $state(false);
  function dismissHint() {
    showHint = false;
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      /* ignore */
    }
  }
  onMount(() => {
    void loadHash();
    try {
      showHint = !localStorage.getItem(HINT_KEY);
    } catch {
      showHint = true;
    }
  });

  // ------------------------------------------------------------ keyboard (undo / redo)
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text'))) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((k === 'z' && e.shiftKey) || k === 'y') {
      e.preventDefault();
      redo();
    }
  }

  // A failed load / export must not stay hidden in the collapsed file group.
  let fileGroup = $state<HTMLDetailsElement>();
  $effect(() => {
    if (notice?.kind === 'error' && fileGroup) fileGroup.open = true;
  });

  // A scene still named after a preset follows the language switch.
  $effect(() => {
    void i18n.lang;
    untrack(() => {
      const n = presetNameNow(scene.name);
      if (n !== null && n !== scene.name) scene.name = n;
    });
  });

  const deg = $derived((((scene.yaw * 180) / Math.PI) % 360 + 360) % 360);
  const sel = $derived(scene.sources[store.selSrc] ?? scene.sources[0]);
  const setZ = (which: 'listener', z: number) => (scene[which] = [scene[which][0], scene[which][1], z]);
</script>

<svelte:window onkeydown={onKey} ondragover={onDragOver} ondrop={onDrop} ondragleave={(e) => { if (!e.relatedTarget) dropKind = null; }} />

{#if !wasmOk}
  <div class="fatal">
    <b>{t('fatal.title')}</b><br />
    {t('fatal.body')}
  </div>
{:else}
<div class="app">
  {#if dropKind}
    <div class="drop" aria-live="polite">{dropKind === 'scene' ? t('drop.scene') : t('drop.audio', { name: srcName(sel.name) })}</div>
  {/if}
  <header>
    <h1>{t('app.title')}</h1>
    <nav>
      <span class="lang" role="group" aria-label={t('lang.aria')}>
        <button class="linkbtn" aria-pressed={i18n.lang === 'ru'} onclick={() => setLang('ru')}>RU</button><span aria-hidden="true">|</span><button class="linkbtn" aria-pressed={i18n.lang === 'en'} onclick={() => setLang('en')}>EN</button>
      </span>
      <button class="linkbtn" onclick={() => (showHint = true)}>{t('nav.help')}</button>
    </nav>
  </header>

  <div class="body">
    <aside>
      <!-- Re-mount on a language switch: selects keep stale choices when only their option labels change -->
      {#key i18n.lang}
      {#if warnings.length}
        <div class="warn" role="status">{#each warnings as w}<div>⚠ {w}</div>{/each}</div>
      {/if}

      <RoomPanel
        name={scene.name} presetIdx={store.presetIdx} materials={scene.materials} floorMat={scene.floorMat} ceilMat={scene.ceilMat}
        height={scene.height} earHeight={scene.listener[2]} yawDeg={deg}
        onname={(n) => (scene.name = n)} onpreset={(i) => store.loadPreset(i)} onclear={() => store.clearWalls()}
        onfloor={(id) => store.setFloor(id)} onceiling={(id) => store.setCeiling(id)}
        onheight={(h) => store.setHeight(h)} onheightend={endEdit} detail={scene.detail} ondetail={(d) => store.setDetail(d)} onear={(z) => store.setEarHeight(z)}
        onyaw={(d) => (scene.yaw = (d * Math.PI) / 180)} />

      <details class="group" open use:persistOpen={'sound'}>
        <summary>{t('snd.title')}</summary>
        <SourcesPanel
          sources={scene.sources} pairs={pairs} fileChannels={(i) => audio.fileChannels(slotOf(i))} height={scene.height} selected={store.selSrc} fileName={audio.fileName} decoding={audio.decoding}
          onselect={(i) => (store.selSrc = i)} onupdate={updateSource} onadd={addSource} onremove={removeSource} onsignal={audio.onSignalChange} onfile={audio.onFile} />
        <AudioPanel audioOk={audioOk} loadInfo={audio.loadInfo} bind:dry={audio.dry} bind:wet={audio.wet} />
      </details>

      <ResultPanel metrics={cur.metrics} bind:heatOn={heat.on} bind:heatMetric={heat.metric} bind:heatRays={heat.rays} bind:heatOpacity={heat.opacity} heatStatus={heat.status} />

      <details class="group" use:persistOpen={'materials'}>
        <summary>{t('mat.title')}</summary>
        <MaterialEditor materials={scene.materials} usage={store.usage} onadd={store.addMaterial} onupdate={store.updateMaterial} oncommit={endEdit} ondelete={store.deleteMaterial} />
        <p class="dim">{t('mat.assignNote')}</p>
      </details>

      <AnalysisPanel
        bind:maxOrder={compute.maxOrder} bind:showOrders={compute.showOrders} bind:rays={compute.rays} bind:showRays={compute.showRays} bind:transmission={compute.transmission} bind:diffraction={compute.diffraction} bind:accurateHrtf={compute.accurateHrtf} bind:modes={compute.modes} bind:showBands={compute.showBands} bind:showEtc={compute.showEtc} bind:showSchroeder={compute.showSchroeder} />

      <details class="group" use:persistOpen={'file'} bind:this={fileGroup}>
        <summary>{t('file.title')}</summary>
        <ExportPanel busy={exporting} progress={exportProgress} {canExport} {exportHint} {notice} {shareUrl}
          onsave={saveFile} onload={loadFile} onshare={share} onexport={doExport} />
      </details>
      {#if error}<p class="err" role="alert">{error}</p>{/if}
      {/key}
    </aside>

    <main>
      <section class="plan">
        <PlanCanvas
          {scene} obstacles={store.obstacles} {tool} selection={store.selection} drawMat={store.drawMat} selectedSource={store.selSrc} pairActive={pairs} heat={heat.layer} heatMetric={heat.metric} {grid} gridStep={0.25} paths={shownPaths} rayPaths={cur.rayPaths} showRays={compute.showRays} showOrders={compute.showOrders} fitToken={store.fitToken} canUndo={store.canUndo} canRedo={store.canRedo}
          onsource={moveSource}
          onselectsource={(i) => (store.selSrc = i)}
          onremovesource={removeSource}
          onrotatesource={(i, a) => updateSource(i, { angle: wrapAngle(a) })}
          onlistener={(p) => (scene.listener = [p[0], p[1], scene.listener[2]])}
          onyaw={(y) => (scene.yaw = y)}
          onrelease={compute.settleNow}
          ontool={(t) => (tool = t)}
          ongrid={(g) => (grid = g)}
          onselection={(ids) => (store.selection = ids)}
          ondrawmat={(id) => (store.drawMat = id)}
          onbeginedit={beginEdit}
          onliveedit={(w) => (scene.walls = w)}
          onendedit={endEdit}
          oncommit={commitWalls}
          onundo={undo}
          onredo={redo}
        >
          {#snippet lead()}<button class="primary" disabled={audio.busy || !audioOk} onclick={audio.togglePlay}>{audio.playing ? t('play.stop') : t('play.play')}</button>{/snippet}
        </PlanCanvas>
        {#if showHint}<QuickStart ondismiss={dismissHint} />{/if}
      </section>
      <section class="ir"><IrPlot plot={cur.plot} show={compute.showBands} showEtc={compute.showEtc} showSchroeder={compute.showSchroeder} /></section>
      <footer class="status" aria-live="polite">
        {#if cur.stats}<span>{t('status.render')} <b>{cur.stats.tMs.toFixed(0)}&thinsp;{t('u.ms')}</b></span><span>{t('status.paths')} <b>{cur.stats.pathCount}</b></span><span><b>{compute.refineText}</b></span><span>{t('status.ir')} <b>{(cur.stats.irSamples / (audio.engine?.sampleRate ?? 48000) * 1000).toFixed(0)}&thinsp;{t('u.ms')}</b></span>{:else}{t('status.loading')}{/if}
      </footer>
    </main>
  </div>
</div>
{/if}

<style>
  .app { display: grid; grid-template-rows: 40px minmax(0, 1fr); height: 100%; min-height: 0; background: var(--bg); color: var(--fg); }
  header { display: flex; align-items: center; gap: 12px; padding: 0 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
  h1 { margin: 0; font: 800 14px var(--font-display); }
  nav { margin-left: auto; display: flex; gap: 16px; }
  .lang { display: flex; align-items: center; gap: 4px; font: 400 11px var(--font-mono); color: var(--muted); }
  .linkbtn { background: none; border: 0; padding: 2px 4px; min-height: 0; font: 600 11px var(--font-mono); color: var(--muted); }
  .linkbtn:hover:not(:disabled):not([aria-pressed='true']) { color: var(--fg); }
  .linkbtn[aria-pressed='true'] { background: var(--fg); color: var(--bg); }
  .body { display: grid; grid-template-columns: 300px minmax(0, 1fr); min-height: 0; }
  aside { background: var(--panel); border-right: 1px solid var(--line); overflow-y: auto; padding: 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-content: start; min-width: 0; min-height: 0; }
  main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .plan { position: relative; flex: 1; min-height: 200px; min-width: 0; overflow: hidden; }
  .ir { position: relative; height: 160px; flex: none; border-top: 1px solid var(--line); background: var(--panel); }
  .status { flex: none; display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: center; min-height: 28px; padding: 4px 16px; border-top: 1px solid var(--line); background: var(--panel); font: 600 11px var(--font-mono); color: var(--muted); font-variant-numeric: tabular-nums; }
  .status b { color: var(--fg); font-weight: 600; }
  .drop { position: fixed; inset: 8px; z-index: 20; display: flex; align-items: center; justify-content: center; border: 2px dashed var(--fg); border-radius: 8px; background: rgba(16, 22, 36, .72); font: 800 22px var(--font-display); color: var(--fg); pointer-events: none; }
  .fatal { padding: 24px; max-width: 560px; margin: 48px auto; border: 1px solid var(--err); background: var(--raise); border-radius: 8px; color: var(--err); }
  @media (max-width: 767px) {
    .app { display: block; height: auto; min-height: 100%; }
    header { height: 40px; }
    .body { display: flex; flex-direction: column; }
    main { order: 1; }
    aside { order: 2; border-right: 0; border-top: 1px solid var(--line); overflow: visible; }
    .plan { flex: none; width: 100%; aspect-ratio: 1; min-height: 0; }
    .status { order: 1; }
    .ir { order: 2; }
  }
</style>
