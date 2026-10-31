<script lang="ts">
  import { DIRECTIVITIES } from '../directivity';
  import { MAX_SOURCES, MAX_WIDTH, MIN_WIDTH, type SignalKind, type Source } from '../scene';
  import { GENERATED, type GeneratedKind } from '../audio/signals';
  import { EQ_BANDS, EQ_MAX_DB, EQ_MIN_DB, EQ_STEP_DB, FLAT_EQ, isFlat } from '../audio/eq';
  import { srcName, t, td } from '../i18n.svelte';
  import { persistOpen } from '../ui-open';
  const DIR_LABEL = { omni: 'src.dir.omni', speaker: 'src.dir.speaker', voice: 'src.dir.voice' } as const;
  const MUSIC: GeneratedKind[] = ['guitar', 'marimba', 'drums'];
  const TESTS: GeneratedKind[] = ['clap', 'noise'];

  interface Props {
    sources: Source[];
    /** Per source: plays as a stereo pair. */
    pairs: boolean[];
    /** Channel count of the file loaded into source `i` (0: none). */
    fileChannels: (i: number) => number;
    /** Room height (m): upper limit of the source height slider. */
    height: number;
    selected: number;
    fileName: (i: number) => string;
    decoding: string;
    onselect: (i: number) => void;
    onupdate: (i: number, patch: Partial<Source>) => void;
    onadd: () => void;
    onremove: (i: number) => void;
    onsignal: (i: number, kind: SignalKind) => void;
    onfile: (e: Event) => void;
  }
  let { sources, pairs, fileChannels, height, selected, fileName, decoding, onselect, onupdate, onadd, onremove, onsignal, onfile }: Props = $props();

  let fileInput = $state<HTMLInputElement>();
  /** "Own audio file" without a loaded file opens the picker; the signal switches once a file is decoded. */
  function pickSignal(el: HTMLSelectElement) {
    const kind = el.value as SignalKind;
    if (kind === 'file' && !fileName(selected)) {
      el.value = sources[selected].signal;
      fileInput?.click();
    } else onsignal(selected, kind);
  }
  const sel = $derived(sources[selected] ?? sources[0]);
  /** "+3.0 dB", "−4.5 dB" (real minus sign), "0.0 dB". */
  const fmtDb = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} ${t('u.db')}`;
  const fmtHz = (f: number) => `${f} ${t('u.hz')}`;
</script>

<!-- Content of the "Sound" group (the group itself is in App.svelte): source list, signal, gain; EQ and position are collapsed. -->
<div class="srcs" role="radiogroup" aria-label={t('src.list')} title={t('src.selNote')}>
  {#each sources as s, i}
    <div class="srow" class:sel={i === selected}>
      <span class="sw" style="background:{s.color}"></span>
      <button class="nm" role="radio" aria-checked={i === selected} onclick={() => onselect(i)}>{srcName(s.name)}</button>
      <span class="marks">
        {#if !isFlat(s.eq)}<span title={t('src.eqOn')}>EQ</span>{/if}
        {#if pairs[i]}<span title={t('src.pairOn')}>ST</span>{/if}
      </span>
      <button class="tog" class:on={s.muted} aria-pressed={s.muted} aria-label={t('src.muteAria', { name: srcName(s.name) })} title={t('src.mute')} onclick={() => onupdate(i, { muted: !s.muted })}>M</button>
      <button class="tog" class:on={s.solo} aria-pressed={s.solo} aria-label={t('src.soloAria', { name: srcName(s.name) })} title={t('src.solo')} onclick={() => onupdate(i, { solo: !s.solo })}>S</button>
      <button class="tog del" disabled={sources.length <= 1} aria-label={t('src.remove', { name: srcName(s.name) })} title={sources.length <= 1 ? t('src.removeLast') : t('src.removeTip')} onclick={() => onremove(i)}>×</button>
    </div>
  {/each}
</div>
{#if sources.length < MAX_SOURCES}<button onclick={onadd}>{t('src.add')}</button>{/if}
{#if sel}
  <label>{t('src.signal')}
    <select value={sel.signal} onchange={(e) => pickSignal(e.currentTarget)}>
      <optgroup label={t('sig.music')}>
        {#each MUSIC as k}<option value={k}>{t(GENERATED[k].labelKey)}</option>{/each}
      </optgroup>
      <optgroup label={t('sig.tests')}>
        {#each TESTS as k}<option value={k}>{t(GENERATED[k].labelKey)}</option>{/each}
      </optgroup>
      <option value="file" selected={sel.signal === 'file'}>{fileName(selected) ? t('sig.fileNamed', { name: fileName(selected) }) : t('sig.fileChoose')}</option>
      <option value="mic">{t('sig.mic')}</option>
    </select>
  </label>
  <label class="filebtn" class:loaded={!!fileName(selected)} title={fileName(selected) ? t('src.fileReplaceTip') : t('src.fileTip')}>
    {fileName(selected) ? t('src.fileReplace', { name: fileName(selected) }) : t('src.fileChoose')}
    <input bind:this={fileInput} type="file" accept="audio/*" onchange={onfile} aria-label={t('src.fileAria')} />
  </label>
  <span class="dim">{t('src.fileDrop')}</span>
  {#if decoding}<p class="dim" role="status">{decoding}</p>{/if}
  {#if fileChannels(selected) >= 2}
    <label class="chk" title={t('src.stereoTip')}><input type="checkbox" checked={sel.stereo} onchange={(e) => onupdate(selected, { stereo: e.currentTarget.checked })} />{t('src.stereo')}</label>
    {#if sel.stereo}
      <label class="param"><span>{t('src.width')}</span><span class="val">{sel.width.toFixed(1)}&thinsp;{t('u.m')}</span>
        <input type="range" min={MIN_WIDTH} max={MAX_WIDTH} step="0.1" value={sel.width} oninput={(e) => onupdate(selected, { width: +e.currentTarget.value })} />
      </label>
      <label class="param" title={t('src.angleTip')}><span>{t('src.angle')}</span><span class="val">{Math.round((sel.angle * 180) / Math.PI) % 360}&thinsp;°</span>
        <input type="range" min="0" max="359" step="1" value={Math.round((sel.angle * 180) / Math.PI) % 360} oninput={(e) => onupdate(selected, { angle: (+e.currentTarget.value * Math.PI) / 180 })} />
      </label>
    {:else}
      <p class="dim">{t('src.stereoOff')}</p>
    {/if}
  {:else if fileChannels(selected) === 1}
    <p class="dim">{t('src.monoFile')}</p>
  {/if}
  {#if sel.signal === 'mic'}<p class="warn" role="alert">{t('src.micWarn')}</p>{/if}
  <label class="param"><span>{t('src.gain')}</span><span class="val">{sel.gain.toFixed(2)}</span>
    <input type="range" min="0" max="2" step="0.01" value={sel.gain} oninput={(e) => onupdate(selected, { gain: +e.currentTarget.value })} />
  </label>
  <div class="dirbox" title={t('src.directivityTip')}>
    <span class="dirlabel" id="dir-label">{t('src.directivity')}</span>
    <div class="segs" role="group" aria-labelledby="dir-label">
      {#each DIRECTIVITIES as k}
        <button aria-pressed={sel.directivity === k} onclick={() => onupdate(selected, { directivity: k })}>{t(DIR_LABEL[k])}</button>
      {/each}
    </div>
  </div>
  {#if sel.directivity !== 'omni' && !pairs[selected]}
    <label class="param" title={t('src.facingTip')}><span>{t('src.facing')}</span><span class="val">{Math.round((sel.angle * 180) / Math.PI) % 360}&thinsp;°</span>
      <input type="range" min="0" max="359" step="1" value={Math.round((sel.angle * 180) / Math.PI) % 360} oninput={(e) => onupdate(selected, { angle: (+e.currentTarget.value * Math.PI) / 180 })} />
    </label>
  {/if}
  <details class="sub" use:persistOpen={'sound.eq'}>
    <summary>{t('src.eq')}</summary>
    <div class="eqhead">
      <span class="dim">{isFlat(sel.eq) ? t('src.eqFlat') : t('src.eqOn')}</span>
      <button class="mini" disabled={isFlat(sel.eq)} onclick={() => onupdate(selected, { eq: { ...FLAT_EQ } })}>{t('src.eqReset')}</button>
    </div>
    {#each EQ_BANDS as b}
      <label class="param"><span>{td('eq', b.id, b.label)} · {fmtHz(b.freq)}</span><span class="val eqval">{fmtDb(sel.eq[b.id])}</span>
        <input type="range" min={EQ_MIN_DB} max={EQ_MAX_DB} step={EQ_STEP_DB} value={sel.eq[b.id]} oninput={(e) => onupdate(selected, { eq: { ...sel.eq, [b.id]: +e.currentTarget.value } })} />
      </label>
    {/each}
  </details>
  <details class="sub" use:persistOpen={'sound.pos'}>
    <summary>{t('src.pos')}</summary>
    <label>{t('src.name')}
      <input class="nameinput" type="text" maxlength="30" value={srcName(sel.name)} oninput={(e) => onupdate(selected, { name: e.currentTarget.value || t('src.defaultName') })} />
    </label>
    <label class="param"><span>{t('src.height')}</span><span class="val">{sel.pos[2].toFixed(1)}&thinsp;{t('u.m')}</span>
      <input type="range" min="0.1" max={Math.max(0.2, height - 0.1)} step="0.1" value={sel.pos[2]} oninput={(e) => onupdate(selected, { pos: [sel.pos[0], sel.pos[1], +e.currentTarget.value] })} />
    </label>
  </details>
{/if}

<style>
  .srcs { display: flex; flex-direction: column; gap: 4px; }
  .srow { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto auto auto auto; gap: 4px; align-items: center; padding: 4px; border-radius: var(--radius); border: 1px solid transparent; }
  .srow.sel { border-color: var(--fg); background: var(--raise); }
  .srow .nm { text-align: left; background: none; border: 0; padding: 4px; min-height: 28px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .srow .nm:hover:not(:disabled) { border: 0; }
  .srow .sw { width: 16px; height: 16px; border-radius: var(--radius); border: 1px solid var(--line); }
  .srow button.tog { min-height: 28px; padding: 0 8px; font-size: 12px; }
  .srow button.del { color: var(--muted); }
  .srow button.del:hover:not(:disabled) { color: var(--err); border-color: var(--err); }
  /* EQ / ST markers share one cell that collapses when empty, so the name keeps the room */
  .srow .marks { display: flex; gap: 4px; padding-right: 4px; font: 10px var(--font-mono); color: var(--muted); letter-spacing: .05em; }
  .dirbox { display: flex; flex-direction: column; gap: 4px; }
  .dirlabel { color: var(--muted); font-size: 12px; }
  .segs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
  .segs button { padding: 4px 6px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .eqhead { display: flex; align-items: center; justify-content: space-between; }
  .eqhead button.mini { min-height: 24px; padding: 0 8px; font-size: 12px; }
  .eqval { display: inline-block; min-width: 9ch; text-align: right; }
  .filebtn { display: block; min-height: 32px; padding: 6px 12px; background: var(--raise); border: 1px solid var(--line); border-radius: var(--radius); color: var(--fg); font-weight: 600; text-align: center; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .filebtn:hover { border-color: var(--muted); }
  .filebtn.loaded { font-weight: 400; color: var(--muted); }
  .filebtn:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
  .filebtn input { position: absolute; width: 1px; height: 1px; opacity: 0; }
</style>
