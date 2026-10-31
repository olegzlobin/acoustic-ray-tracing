<script lang="ts">
  import type { ExportKind, Notice } from '../io/run-export';
  import type { WavBits } from '../io/wav';
  import { t } from '../i18n.svelte';

  interface Props {
    busy: boolean;
    progress: number | null;
    canExport: boolean;
    exportHint: string;
    notice: Notice | null;
    shareUrl: string;
    onsave: () => void;
    onload: (f: File) => void;
    onshare: () => void;
    onexport: (what: ExportKind, bits: WavBits) => void;
  }
  let { busy, progress, canExport, exportHint, notice, shareUrl, onsave, onload, onshare, onexport }: Props = $props();
  let bits = $state<WavBits>(24);
</script>

<div class="ep">
  <div class="row3">
    <button onclick={onsave}>{t('file.save')}</button>
    <label class="filebtn">{t('file.load')}<input type="file" accept="application/json,.json" onchange={(e) => { const f = e.currentTarget.files?.[0]; if (f) onload(f); e.currentTarget.value = ''; }} /></label>
    <button onclick={onshare}>{t('file.share')}</button>
  </div>
  {#if shareUrl}<input class="url" type="text" readonly value={shareUrl} onfocus={(e) => e.currentTarget.select()} />{/if}

  <label>{t('file.wav')}
    <select bind:value={bits}>
      <option value={16}>{t('file.pcm16')}</option>
      <option value={24}>{t('file.pcm24')}</option>
      <option value={32}>{t('file.float32')}</option>
    </select>
  </label>
  <div class="row3">
    <button disabled={!canExport || busy} title={t('file.audioTip')} onclick={() => onexport('audio', bits)}>{t('file.audio')}</button>
    <button disabled={!canExport || busy} title={t('file.irBinTip')} onclick={() => onexport('binaural-ir', bits)}>{t('file.irBin')}</button>
    <button disabled={!canExport || busy} title={t('file.irFoaTip')} onclick={() => onexport('foa-ir', bits)}>{t('file.irFoa')}</button>
  </div>
  {#if !canExport}<p class="dim">{exportHint}</p>{/if}
  {#if progress !== null}<progress max="1" value={progress}></progress>{/if}
  {#if notice}
    <p class={notice.kind === 'error' ? 'err' : 'ok'}>{notice.text}</p>
    {#if notice.details}<ul class="err">{#each notice.details as d}<li>{d}</li>{/each}</ul>{/if}
  {/if}
</div>

<style>
  .ep { display: flex; flex-direction: column; gap: 8px; }
  .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  button, .filebtn { font-size: 12px; padding: 4px; text-align: center; }
  .filebtn { background: var(--raise); border: 1px solid var(--line); border-radius: var(--radius); cursor: pointer; display: flex; align-items: center; justify-content: center; min-height: 32px; color: var(--fg); font-weight: 600; }
  .filebtn:hover { border-color: var(--muted); }
  .filebtn input { display: none; }
  .url { font: 11px var(--font-mono); width: 100%; min-width: 0; }
  progress { width: 100%; accent-color: var(--fg); }
  .dim { color: var(--muted); font-size: 12px; margin: 0; }
  .err { color: var(--err); margin: 0; font-size: 12px; }
  ul.err { padding-left: 16px; }
  .ok { color: var(--ok); margin: 0; font-size: 12px; }
</style>
