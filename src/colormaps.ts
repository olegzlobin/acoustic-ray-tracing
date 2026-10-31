// Фирменные шкалы: 11 опорных точек (sRGB HEX), линейно в RGB точно для Ember; для Tide/Abyss в поле бери colormaps-256.json.
export const EMBER = ["#0A1121","#281E46","#542662","#853071","#BA3A71","#D74F65","#EF6856","#FE8D47","#FFB75E","#FCD795","#FAF2D8"];
export const TIDE = ["#05585F","#087982","#169CA7","#61BDAE","#BCD5B1","#F3EEE0","#EFC298","#F08B6C","#D95C59","#B23C3C","#8D1920"];
export const ABYSS = ["#76E1EC","#49B6C4","#0A8D9D","#026279","#183851","#101624","#442655","#922C59","#C94F4E","#E98471","#FEBCA5"];

export function colormap(stops: string[], t: number): [number, number, number] {
  const rgb = stops.map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
  const x = Math.min(stops.length - 1 - 1e-9, Math.max(0, t * (stops.length - 1)));
  const i = Math.floor(x), f = x - i;
  return [0, 1, 2].map(c => Math.round(rgb[i][c] + (rgb[i + 1][c] - rgb[i][c]) * f)) as [number, number, number];
}
