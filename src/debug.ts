/** Diagnostics are exposed on `window` only with `?debug` in the URL. */
const DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');

export function expose(name: string, value: unknown) {
  if (DEBUG) (window as unknown as Record<string, unknown>)[name] = value;
}
