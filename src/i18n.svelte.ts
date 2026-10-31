// UI localization: Russian (default) and English. Dictionaries live in src/locales (the English one defines the
// keys, `Dict`, so a missing Russian key fails the type check). `t()` reads the reactive language, so every
// template, `$derived` and `$effect` that calls it re-runs when the language is switched.

import { en, type Dict } from './locales/en';
import { ru } from './locales/ru';

export type Lang = 'ru' | 'en';
export type Key = keyof Dict;

const LANG_KEY = 'art.lang.v1';
const DICTS: Record<Lang, Dict> = { ru, en };

function initialLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === 'ru' || v === 'en') return v;
  } catch {
    /* storage unavailable: default language */
  }
  return 'ru';
}

/** Reactive language state (`i18n.lang`). */
export const i18n = $state<{ lang: Lang }>({ lang: initialLang() });

function applyDocument() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = i18n.lang;
  document.title = DICTS[i18n.lang]['app.title'];
}
applyDocument();

export function setLang(l: Lang) {
  i18n.lang = l;
  applyDocument();
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {
    /* ignore */
  }
}

type Params = Record<string, string | number>;
const fill = (s: string, params?: Params) => (params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s);

/** Translate `key`, replacing `{name}` placeholders with `params`. */
export function t(key: Key, params?: Params): string {
  return fill(DICTS[i18n.lang][key] ?? en[key], params);
}

/** Index of the plural form for `n`: ru one / few / many, en one / other. */
export function pluralIndex(lang: Lang, n: number): number {
  const k = Math.abs(Math.round(n));
  if (lang === 'en') return k === 1 ? 0 : 1;
  const m10 = k % 10, m100 = k % 100;
  if (m10 === 1 && m100 !== 11) return 0;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 1;
  return 2;
}

/** Plural-aware translation: the entry holds the forms separated by `|`; `{n}` is filled in. */
export function tp(key: Key, n: number, params?: Params): string {
  const forms = t(key).split('|');
  return fill(forms[Math.min(pluralIndex(i18n.lang, n), forms.length - 1)], { n, ...params });
}

/** Translate a dynamic key (`mat.<id>`, `preset.<id>`, ...); `fallback` when the dictionary has none. */
export function td(prefix: string, id: string, fallback: string): string {
  const k = `${prefix}.${id}`;
  return k in en ? t(k as Key) : fallback;
}

/** Display name of a material: library ones are translated, custom ones keep the user's name. */
export const matName = (m: { id: string; name: string; builtin?: boolean }) => (m.builtin ? td('mat', m.id, m.name) : m.name);

/** Display name of a source: the generated "Source N" follows the language, edited names stay. */
export function srcName(name: string): string {
  const m = /^(?:Source|Источник) (\d+)$/.exec(name);
  return m ? t('src.n', { n: m[1] }) : name;
}

/** If `name` is a preset's name in some language, its name in the current one (else null). */
export function presetNameNow(name: string): string | null {
  for (const l of ['ru', 'en'] as const)
    for (const k of Object.keys(en) as Key[]) if (k.startsWith('preset.') && DICTS[l][k] === name) return t(k);
  return null;
}
