// Minimal typings for the few node APIs the dev-only tests use (the project does not depend on @types/node).
declare module 'node:fs' {
  /** The part of node's Buffer used by the validation WAV reader. */
  export interface NodeBuffer extends Uint8Array<ArrayBuffer> {
    toString(encoding: 'ascii' | 'utf8', start?: number, end?: number): string;
    readUInt16LE(offset: number): number;
    readUInt32LE(offset: number): number;
    readInt16LE(offset: number): number;
    readInt32LE(offset: number): number;
    readIntLE(offset: number, byteLength: number): number;
    readFloatLE(offset: number): number;
    readDoubleLE(offset: number): number;
  }
  export function readFileSync(path: string): NodeBuffer;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
}
declare module 'node:os' {
  export function homedir(): string;
}
declare const process: { env: Record<string, string | undefined> };
