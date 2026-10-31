// Test helper: the real Rust core instantiated in Node (needs the built wasm: npm run build:wasm).
import { readFileSync } from 'node:fs';
import { Core } from './core-ffi';
import { decodePlan, type Plan } from './editor/rooms';
import { packWalls, type Wall } from './scene';

export const testCore = await Core.fromBytes(readFileSync(process.env.SNAPSHOT_WASM ?? 'src/wasm/core.wasm'));

/** Room analysis through the FFI, decoded as the UI does. */
export const analyzePlan = (walls: Pick<Wall, 'a' | 'b'>[]): Plan => decodePlan(testCore.planFaces(packWalls(walls as Wall[])));
