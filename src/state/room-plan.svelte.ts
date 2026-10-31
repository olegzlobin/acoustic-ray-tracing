import { decodePlan } from '../editor/rooms';
import { packWalls, type Scene } from '../scene';
import type { AcousticWorker } from '../worker-client';
import type { SceneStore } from './scene-store.svelte';

/**
 * Keeps `store.plan` in sync with the walls: every change posts the walls to the worker (latest wins), the
 * result of the Rust room analysis replaces the plan. Construct during component initialisation.
 */
export class RoomPlan {
  private lastId = 0;

  constructor(worker: AcousticWorker, scene: Scene, store: SceneStore) {
    worker.onplan = (p) => {
      if (p.id < this.lastId) return;
      this.lastId = p.id;
      store.plan = decodePlan(p.faces);
      store.planReady = true;
    };
    $effect(() => {
      worker.analyzePlan(packWalls(scene.walls));
    });
  }
}
