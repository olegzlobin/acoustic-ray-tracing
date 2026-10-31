import { t } from './i18n.svelte';

export const BAND_NAMES = ['125', '250', '500', '1k', '2k', '4k', 'All'];
export const BAND_COLORS = ['#E15151', '#E8BF3A', '#0A9BA6', '#5882EF', '#BC5CC5', '#FF958F', '#F0E8CF'];

/** Localized band name: "125" .. "4k" (ru: "4к"), the last one is the broadband row. */
export const bandName = (i: number) => (i === BAND_NAMES.length - 1 ? t('band.all') : BAND_NAMES[i].replace('k', t('band.k')));
