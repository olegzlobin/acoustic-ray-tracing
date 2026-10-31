/** 1500 -> "1.5k". */
export const kfmt = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));
