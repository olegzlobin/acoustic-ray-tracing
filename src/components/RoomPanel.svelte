<script lang="ts">
  import type { Material } from '../materials';
  import { PRESETS } from '../presets';
  import { MAX_DETAIL } from '../scene';
  import { matName, t, td } from '../i18n.svelte';
  import { persistOpen } from '../ui-open';

  interface Props {
    name: string;
    presetIdx: number;
    materials: Material[];
    floorMat: string;
    ceilMat: string;
    height: number;
    earHeight: number;
    /** Listener yaw in degrees, 0..359. */
    yawDeg: number;
    onname: (name: string) => void;
    onpreset: (i: number) => void;
    onclear: () => void;
    onfloor: (id: string) => void;
    onceiling: (id: string) => void;
    /** Slider drag: begins an undoable edit; `onheightend` commits it. */
    onheight: (h: number) => void;
    onheightend: () => void;
    /** Extra absorption of all surfaces (0..MAX_DETAIL); committed with `onheightend`. */
    detail: number;
    ondetail: (d: number) => void;
    onear: (z: number) => void;
    onyaw: (deg: number) => void;
  }
  let { name, presetIdx, materials, floorMat, ceilMat, height, earHeight, yawDeg, onname, onpreset, onclear, onfloor, onceiling, onheight, onheightend, detail, ondetail, onear, onyaw }: Props = $props();
</script>

<details class="group" open use:persistOpen={'room'}>
  <summary>{t('room.title')}</summary>
  <select aria-label={t('room.preset')} value={presetIdx} onchange={(e) => onpreset(+e.currentTarget.value)}>
    <!-- `selected` on the options: re-rendered labels (language switch) would otherwise reset the choice -->
    <option value={-1} disabled selected={presetIdx === -1}>{t('room.custom', { name })}</option>
    {#each PRESETS as p, i}<option value={i} selected={i === presetIdx}>{td('preset', p.id, p.name)}</option>{/each}
  </select>
  <p class="dim hint">{t('room.help')}</p>
  <details class="sub" use:persistOpen={'room.params'}>
    <summary>{t('room.params')}</summary>
    <label>{t('room.name')}
      <input class="nameinput" type="text" maxlength="60" value={name} oninput={(e) => onname(e.currentTarget.value)} aria-label={t('room.nameAria')} />
    </label>
    <label>{t('room.floor')}
      <select value={floorMat} onchange={(e) => onfloor(e.currentTarget.value)}>{#each materials as m}<option value={m.id}>{matName(m)}</option>{/each}</select>
    </label>
    <label>{t('room.ceiling')}
      <select value={ceilMat} onchange={(e) => onceiling(e.currentTarget.value)}>{#each materials as m}<option value={m.id}>{matName(m)}</option>{/each}</select>
    </label>
    <label class="param"><span>{t('room.height')}</span><span class="val">{height.toFixed(1)}&thinsp;{t('u.m')}</span>
      <input type="range" min="1.5" max="40" step="0.1" value={height} oninput={(e) => onheight(+e.currentTarget.value)} onchange={onheightend} />
    </label>
    <label class="param" title={t('room.detailTip')}><span>{t('room.detail')}</span><span class="val">+{detail.toFixed(2)}&thinsp;α</span>
      <input type="range" min="0" max={MAX_DETAIL} step="0.01" value={detail} oninput={(e) => ondetail(+e.currentTarget.value)} onchange={onheightend} />
    </label>
    <label class="param"><span>{t('room.ear')}</span><span class="val">{earHeight.toFixed(1)}&thinsp;{t('u.m')}</span>
      <input type="range" min="0.1" max={Math.max(0.2, height - 0.1)} step="0.1" value={earHeight} oninput={(e) => onear(+e.currentTarget.value)} />
    </label>
    <label class="param"><span>{t('room.yaw')}</span><span class="val">{yawDeg.toFixed(0)}&thinsp;°</span>
      <input type="range" min="0" max="359" step="1" value={yawDeg} oninput={(e) => onyaw(+e.currentTarget.value)} />
    </label>
    <button onclick={onclear} title={t('room.clearTip')}>{t('room.clear')}</button>
  </details>
</details>
