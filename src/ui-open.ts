// Remembers which <details> of the side panel are open (localStorage 'art.ui.open.v1'); new users get the markup defaults.

const KEY = 'art.ui.open.v1';

let saved: Record<string, boolean> = {};
try {
  const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (typeof v === 'boolean') saved[k] = v;
} catch {
  /* storage unavailable or corrupt: defaults */
}

/** Svelte action: `<details use:persistOpen={'room'}>`. */
export function persistOpen(node: HTMLDetailsElement, id: string) {
  if (id in saved) node.open = saved[id];
  const onToggle = () => {
    saved[id] = node.open;
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {
      /* ignore */
    }
  };
  node.addEventListener('toggle', onToggle);
  return { destroy: () => node.removeEventListener('toggle', onToggle) };
}
