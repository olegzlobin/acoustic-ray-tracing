import { afterEach, describe, expect, it } from 'vitest';
import { en } from './locales/en';
import { ru } from './locales/ru';
import { PRESETS } from './presets';
import { BUILTIN_MATERIALS } from './materials';
import { matName, pluralIndex, setLang, srcName, t, td, tp } from './i18n.svelte';

describe('i18n', () => {
  afterEach(() => setLang('ru'));

  it('has the same keys and placeholders in both languages', () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    const ph = (s: string) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort().join();
    for (const k of Object.keys(en) as (keyof typeof en)[]) expect(ph(ru[k]), k).toBe(ph(en[k]));
  });

  it('names every preset and library material', () => {
    for (const p of PRESETS) expect(`preset.${p.id}` in en, p.id).toBe(true);
    for (const m of BUILTIN_MATERIALS) expect(`mat.${m.id}` in en, m.id).toBe(true);
  });

  it('interpolates and switches language', () => {
    setLang('en');
    expect(t('src.n', { n: 2 })).toBe('Source 2');
    expect(srcName('Source 3')).toBe('Source 3');
    setLang('ru');
    expect(t('src.n', { n: 2 })).toBe('Источник 2');
    expect(srcName('Source 3')).toBe('Источник 3');
    expect(srcName('Моя колонка')).toBe('Моя колонка');
    expect(matName({ id: 'carpet', name: 'Carpet', builtin: true })).toBe('Ковёр');
    expect(matName({ id: 'c1', name: 'Mine' })).toBe('Mine');
    expect(td('preset', 'nope', 'fallback')).toBe('fallback');
  });

  it('picks Russian plural forms', () => {
    const idx = [1, 2, 4, 5, 11, 12, 21, 22, 25, 111].map((n) => pluralIndex('ru', n));
    expect(idx).toEqual([0, 1, 1, 2, 2, 2, 0, 1, 2, 2]);
    setLang('ru');
    expect(tp('sel.count', 1)).toBe('1 стена выбрана');
    expect(tp('sel.count', 3)).toBe('3 стены выбраны');
    expect(tp('sel.count', 5)).toBe('5 стен выбрано');
    setLang('en');
    expect(tp('sel.count', 1)).toBe('1 wall selected');
    expect(tp('sel.count', 2)).toBe('2 walls selected');
  });
});
