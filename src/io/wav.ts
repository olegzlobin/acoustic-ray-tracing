/** Minimal WAV encoder: 16/24-bit PCM or 32-bit float, any channel count (interleaved). */

export type WavBits = 16 | 24 | 32;

/** Quantise one sample (clipped to [-1, 1]); 16/24-bit use asymmetric full-scale (-32768..32767). */
export function clip(x: number): number {
  return x > 1 ? 1 : x < -1 ? -1 : x;
}

/**
 * `bits` 32 writes IEEE float (format 3 plus a `fact` chunk); 16/24 write integer PCM. More than two
 * channels use WAVE_FORMAT_EXTENSIBLE (as AmbiX .wav files do) with speaker mask 0.
 */
export function encodeWav(channels: Float32Array[], sampleRate: number, bits: WavBits): Uint8Array {
  const nch = channels.length;
  if (nch < 1) throw new Error('no channels');
  const n = channels[0].length;
  if (!channels.every((c) => c.length === n)) throw new Error('channel length mismatch');
  const bytes = bits / 8;
  const float = bits === 32;
  const ext = nch > 2;
  const fmtSize = ext ? 40 : 16;
  const dataSize = n * nch * bytes;
  const factSize = float ? 12 : 0;
  const total = 12 + 8 + fmtSize + factSize + 8 + dataSize + (dataSize & 1);
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  let o = 0;
  const str = (s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i));
  };
  const u32 = (x: number) => {
    v.setUint32(o, x, true);
    o += 4;
  };
  const u16 = (x: number) => {
    v.setUint16(o, x, true);
    o += 2;
  };
  str('RIFF');
  u32(total - 8);
  str('WAVE');
  str('fmt ');
  u32(fmtSize);
  u16(ext ? 0xfffe : float ? 3 : 1);
  u16(nch);
  u32(sampleRate);
  u32(sampleRate * nch * bytes);
  u16(nch * bytes);
  u16(bits);
  if (ext) {
    u16(22); // extension size
    u16(bits); // valid bits
    u32(0); // channel mask
    // sub-format GUID: first two bytes = format tag (1 PCM / 3 float), then the standard suffix
    u16(float ? 3 : 1);
    for (const b of [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]) v.setUint8(o++, b);
  }
  if (float) {
    str('fact');
    u32(4);
    u32(n);
  }
  str('data');
  u32(dataSize);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const x = clip(channels[c][i]);
      if (bits === 16) {
        v.setInt16(o, Math.round(x < 0 ? x * 32768 : x * 32767), true);
        o += 2;
      } else if (bits === 24) {
        const q = Math.round(x < 0 ? x * 8388608 : x * 8388607);
        v.setUint8(o, q & 0xff);
        v.setUint8(o + 1, (q >> 8) & 0xff);
        v.setUint8(o + 2, (q >> 16) & 0xff);
        o += 3;
      } else {
        v.setFloat32(o, channels[c][i], true); // float: stored as is (not clipped)
        o += 4;
      }
    }
  }
  return new Uint8Array(buf);
}

export function peak(channels: Float32Array[]): number {
  let p = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]));
  return p;
}
