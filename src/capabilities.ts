/** Browser capability checks (the app still loads and explains when they fail). */
export const wasmOk = typeof WebAssembly !== 'undefined' && typeof Worker !== 'undefined';
export const audioOk = typeof AudioContext !== 'undefined' && typeof OfflineAudioContext !== 'undefined';
