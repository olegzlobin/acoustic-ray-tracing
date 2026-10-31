<script lang="ts">
  import { t } from '../i18n.svelte';
  let { ondismiss }: { ondismiss: () => void } = $props();
</script>

<div class="hintbox" role="dialog" aria-label={t('qs.title')}>
  <ul>
    <li>{@html t('qs.headphones')}</li>
    <li>{@html t('qs.play')}</li>
    <li>{@html t('qs.drag')}</li>
  </ul>
  <button onclick={ondismiss}>{t('qs.ok')}</button>
</div>

<style>
  .hintbox { position: absolute; z-index: 5; left: 50%; top: 48px; transform: translateX(-50%); width: min(92%, 520px); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; font-size: 13px; }
  ul { margin: 0 0 12px; padding-left: 16px; color: var(--muted); }
</style>
