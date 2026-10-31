import type { BinResult, ComputeRequest, ComputeResult, HeatRequest, HeatResult, PlanRequest, PlanResult, ProgressMsg, RebinRequest, WorkerOut } from './protocol';

export class AcousticWorker {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  onresult: (r: ComputeResult) => void = () => {};
  onbin: (b: BinResult) => void = () => {};
  onprogress: (p: ProgressMsg) => void = () => {};
  onheat: (h: HeatResult) => void = () => {};
  onplan: (p: PlanResult) => void = () => {};
  onerror: (m: string) => void = () => {};

  constructor() {
    this.worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === 'result') this.onresult(m);
      else if (m.type === 'bin') this.onbin(m);
      else if (m.type === 'heat') this.onheat(m);
      else if (m.type === 'plan') this.onplan(m);
      else if (m.type === 'progress') this.onprogress(m);
      else if (m.type === 'error') this.onerror(m.message);
    };
    this.worker.onerror = (e) => this.onerror(e.message || 'worker error');
  }

  compute(req: Omit<ComputeRequest, 'type' | 'id'>): number {
    const id = this.nextId++;
    this.worker.postMessage({ type: 'compute', id, ...req } satisfies ComputeRequest);
    return id;
  }

  /** Binaural early IR of a slot for a new head yaw, from the worker's cached third-order IR; latest wins per slot. */
  rebin(slot: number, yaw: number) {
    this.worker.postMessage({ type: 'rebin', slot, yaw } satisfies RebinRequest);
  }

  heat(req: Omit<HeatRequest, 'type' | 'id'>): number {
    const id = this.nextId++;
    this.worker.postMessage({ type: 'heat', id, ...req } satisfies HeatRequest);
    return id;
  }

  /** Room analysis of the walls (packed rows); latest wins. */
  analyzePlan(walls: Float32Array): number {
    const id = this.nextId++;
    this.worker.postMessage({ type: 'plan', id, walls } satisfies PlanRequest);
    return id;
  }

  cancelHeat() {
    this.worker.postMessage({ type: 'heat-cancel' });
  }

  terminate() {
    this.worker.terminate();
  }
}
