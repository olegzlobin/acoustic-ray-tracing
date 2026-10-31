// Minimal WAV reader (data only, never executes anything): PCM 16/24/32 and IEEE float 32/64, first channel.
import { readFileSync } from 'node:fs';

export interface Wav {
  fs: number;
  channels: number;
  x: Float32Array;
}

export function readWav(path: string): Wav {
  const b = readFileSync(path);
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not a RIFF/WAVE file`);
  let fmt: { tag: number; ch: number; fs: number; bits: number } | null = null;
  let pos = 12;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      let tag = b.readUInt16LE(body);
      if (tag === 0xfffe && size >= 26) tag = b.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE: sub-format
      fmt = { tag, ch: b.readUInt16LE(body + 2), fs: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new Error(`${path}: data before fmt`);
      const bytes = fmt.bits / 8;
      const n = Math.floor(Math.min(size, b.length - body) / (bytes * fmt.ch));
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const o = body + i * fmt.ch * bytes;
        if (fmt.tag === 3 && fmt.bits === 32) x[i] = b.readFloatLE(o);
        else if (fmt.tag === 3 && fmt.bits === 64) x[i] = b.readDoubleLE(o);
        else if (fmt.tag === 1 && fmt.bits === 16) x[i] = b.readInt16LE(o) / 32768;
        else if (fmt.tag === 1 && fmt.bits === 24) x[i] = b.readIntLE(o, 3) / 8388608;
        else if (fmt.tag === 1 && fmt.bits === 32) x[i] = b.readInt32LE(o) / 2147483648;
        else throw new Error(`${path}: unsupported format tag ${fmt.tag}, ${fmt.bits} bit`);
      }
      return { fs: fmt.fs, channels: fmt.ch, x };
    }
    pos = body + size + (size & 1);
  }
  throw new Error(`${path}: no data chunk`);
}
