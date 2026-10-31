import wasmUrl from './wasm/core.wasm?url';
import { Core } from './core-ffi';
import { JobQueue } from './job-queue';
import { ComputeJobs, computeKey, HEAT_KEY, PRIORITY } from './worker-jobs';
import type { WorkerIn, WorkerOut } from './protocol';

const scope = self as unknown as {
  postMessage(msg: WorkerOut, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};

// MessageChannel macrotask: yields to the event loop without setTimeout's clamping, so newer
// requests (already queued as messages) are delivered between work units.
const chan = new MessageChannel();
let yieldResolve: (() => void) | null = null;
chan.port1.onmessage = () => {
  const r = yieldResolve;
  yieldResolve = null;
  r?.();
};
const yieldMacro = () =>
  new Promise<void>((res) => {
    yieldResolve = res;
    chan.port2.postMessage(0);
  });

// Requests are latest-wins per key (source slot / heat map). Priority: early stages > ray-tail chunks > heat map chunks > prewarm.
const queue = new JobQueue({
  yield: yieldMacro,
  onError(e) {
    scope.postMessage({ type: 'error', message: String(e) });
    queue.cancelWhere((j) => j.priority >= PRIORITY.TAIL && j.priority < PRIORITY.PREWARM); // refinements restart from the next request
  },
});

let core: Core | null = null;
// Jobs only touch the core inside their steps, so requests that arrive while the wasm loads are queued.
const jobs = new ComputeJobs({ core: () => core!, post: (msg, tr) => scope.postMessage(msg, tr ?? []), now: () => performance.now(), submit: (j) => queue.submit(j) });

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'compute') queue.submit(jobs.early(m));
  else if (m.type === 'rebin') queue.submit(jobs.rebin(m));
  else if (m.type === 'plan') queue.submit(jobs.plan(m));
  else if (m.type === 'heat') queue.submit(jobs.heat(m));
  else if (m.type === 'heat-cancel') queue.cancel(HEAT_KEY);
  if (core) void queue.run();
};

Core.load(wasmUrl).then(
  (c) => {
    core = c;
    scope.postMessage({ type: 'ready' });
    void queue.run();
  },
  (e) => scope.postMessage({ type: 'error', message: 'wasm load failed: ' + String(e) }),
);
