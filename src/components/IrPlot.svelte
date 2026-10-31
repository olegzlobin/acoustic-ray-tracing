<script lang="ts">
  import { BAND_COLORS } from '../bands';
  import { LINE, MONO_FONT, MUTED } from '../theme';
  import { i18n, t } from '../i18n.svelte';

  interface Props {
    /** [nbins, ETC dB (7 x nbins), Schroeder dB (7 x nbins)], 1 ms bins; row 6 = broadband. */
    plot: Float32Array | null;
    show: boolean[];
    showEtc: boolean;
    showSchroeder: boolean;
  }
  let { plot, show, showEtc, showSchroeder }: Props = $props();



  const RANGE_DB = 80;

  let canvas: HTMLCanvasElement;
  let box = $state({ w: 300, h: 180 });

  $effect(() => {
    const ro = new ResizeObserver(([e]) => {
      box = { w: e.contentRect.width, h: e.contentRect.height };
    });
    ro.observe(canvas.parentElement!);
    return () => ro.disconnect();
  });

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(box.w * dpr));
    const H = Math.max(1, Math.round(box.h * dpr));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, box.w, box.h);
    const L = 34, R = 8, T = 8, B = 20;
    const pw = box.w - L - R, ph = box.h - T - B;
    g.font = `11px ${MONO_FONT}`;
    g.fillStyle = MUTED;
    g.strokeStyle = LINE;
    g.lineWidth = 1;
    if (!plot || plot.length < 2) {
      g.fillText(t('ir.computing'), L + 8, T + 16);
      return;
    }
    const nb = plot[0];
    const etc = (r: number, k: number) => plot[1 + r * nb + k];
    const sch = (r: number, k: number) => plot[1 + (7 + r) * nb + k];

    // ETC is shown in dB re its overall maximum (visible rows) = 0 dB.
    let top = -Infinity;
    for (let r = 0; r < 7; r++) {
      if (!show[r]) continue;
      for (let k = 0; k < nb; k++) top = Math.max(top, etc(r, k));
    }
    if (!isFinite(top)) top = 0;

    const x = (k: number) => L + (k / nb) * pw;
    const y = (db: number) => T + (-db / RANGE_DB) * ph;

    // Grid
    for (let db = 0; db >= -RANGE_DB; db -= 20) {
      g.beginPath();
      g.moveTo(L, y(db));
      g.lineTo(L + pw, y(db));
      g.stroke();
      g.fillText(db === 0 ? `0 ${t('u.db')}` : String(db), 4, y(db) + 3);
    }
    const tsec = nb / 1000;
    const step = tsec > 3 ? 1 : tsec > 1.2 ? 0.5 : tsec > 0.5 ? 0.2 : 0.1;
    for (let sec = 0; sec <= tsec + 1e-9; sec += step) {
      const px = x(sec * 1000);
      g.beginPath();
      g.moveTo(px, T);
      g.lineTo(px, T + ph);
      g.stroke();
      g.fillText(sec.toFixed(1) + t('u.s'), px - 8, box.h - 6);
    }

    g.save();
    g.beginPath();
    g.rect(L, T, pw, ph);
    g.clip();

    const cols = Math.max(1, Math.floor(pw));
    // Energy-domain average per pixel column (min. 2 ms) keeps the 1 ms-bin noise readable.
    const etcLine = (r: number) => {
      g.beginPath();
      let started = false;
      for (let c = 0; c < cols; c++) {
        const k0 = Math.floor((c / cols) * nb), k1 = Math.max(k0 + 2, Math.floor(((c + 1) / cols) * nb));
        let e = 0, n = 0;
        for (let k = k0; k < Math.min(k1, nb); k++) {
          e += Math.pow(10, (etc(r, k) - top) / 10);
          n++;
        }
        const db = 10 * Math.log10(Math.max(e / Math.max(n, 1), 1e-12));
        const px = L + c, py = y(Math.max(db, -RANGE_DB - 5));
        if (started) g.lineTo(px, py);
        else g.moveTo(px, py);
        started = true;
      }
      g.stroke();
    };
    if (showEtc) {
      for (let r = 0; r < 7; r++) {
        if (!show[r]) continue;
        g.strokeStyle = BAND_COLORS[r];
        g.globalAlpha = r === 6 ? 0.95 : 0.6;
        g.lineWidth = r === 6 ? 1.6 : 1.1;
        etcLine(r);
      }
    }
    if (showSchroeder) {
      g.setLineDash([5, 3]);
      g.globalAlpha = 0.9;
      g.lineWidth = 1.3;
      for (let r = 0; r < 7; r++) {
        if (!show[r]) continue;
        g.strokeStyle = BAND_COLORS[r];
        g.beginPath();
        for (let c = 0; c < cols; c++) {
          const k = Math.min(nb - 1, Math.floor((c / cols) * nb));
          const px = L + c, py = y(Math.max(sch(r, k), -RANGE_DB - 5));
          if (c) g.lineTo(px, py);
          else g.moveTo(px, py);
        }
        g.stroke();
      }
      g.setLineDash([]);
    }
    g.restore();
    g.globalAlpha = 1;
  }

  $effect(() => {
    void [plot, show, showEtc, showSchroeder, box, i18n.lang];
    draw();
  });
</script>

<div class="wrap"><canvas bind:this={canvas} aria-label={t('ir.aria')}></canvas></div>

<style>
  .wrap { position: relative; width: 100%; height: 100%; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
</style>
