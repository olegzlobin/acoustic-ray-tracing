import { describe, expect, it } from 'vitest';
import { clip, encodeWav, peak } from './wav';

const str = (v: DataView, o: number, n: number) => String.fromCharCode(...Array.from({ length: n }, (_, i) => v.getUint8(o + i)));

describe('encodeWav', () => {
  it('writes a 16-bit stereo PCM header and interleaves channels', () => {
    const out = encodeWav([Float32Array.from([0, 0.5, -0.5]), Float32Array.from([1, -1, 0.25])], 44100, 16);
    const v = new DataView(out.buffer);
    expect(str(v, 0, 4)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(out.length - 8);
    expect(str(v, 8, 8)).toBe('WAVEfmt ');
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint32(28, true)).toBe(44100 * 4); // byte rate
    expect(v.getUint16(32, true)).toBe(4); // block align
    expect(v.getUint16(34, true)).toBe(16);
    expect(str(v, 36, 4)).toBe('data');
    expect(v.getUint32(40, true)).toBe(3 * 4);
    // interleaved L0 R0 L1 R1 ...
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(46, true)).toBe(32767);
    expect(v.getInt16(48, true)).toBe(Math.round(0.5 * 32767));
    expect(v.getInt16(50, true)).toBe(-32768);
    expect(v.getInt16(52, true)).toBe(Math.round(-0.5 * 32768));
  });

  it('writes 24-bit samples little-endian', () => {
    const out = encodeWav([Float32Array.from([1, -1, 0.5])], 48000, 24);
    const v = new DataView(out.buffer);
    expect(v.getUint16(34, true)).toBe(24);
    expect(v.getUint16(32, true)).toBe(3);
    expect(v.getUint32(40, true)).toBe(9);
    const s24 = (o: number) => ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16)) << 8) >> 8;
    expect(s24(44)).toBe(8388607);
    expect(s24(47)).toBe(-8388608);
    expect(s24(50)).toBe(Math.round(0.5 * 8388607));
  });

  it('writes 32-bit float with a fact chunk', () => {
    const out = encodeWav([Float32Array.from([0.25, -2])], 48000, 32);
    const v = new DataView(out.buffer);
    expect(v.getUint16(20, true)).toBe(3);
    expect(str(v, 36, 4)).toBe('fact');
    expect(v.getUint32(44, true)).toBe(2); // frames
    expect(str(v, 48, 4)).toBe('data');
    expect(v.getFloat32(56, true)).toBe(0.25);
    expect(v.getFloat32(60, true)).toBe(-2); // floats are not clipped
  });

  it('uses WAVE_FORMAT_EXTENSIBLE for 4 channels (AmbiX)', () => {
    const ch = [0, 1, 2, 3].map((c) => Float32Array.from([c / 10, -c / 10]));
    const out = encodeWav(ch, 48000, 32);
    const v = new DataView(out.buffer);
    expect(v.getUint16(20, true)).toBe(0xfffe);
    expect(v.getUint16(22, true)).toBe(4);
    expect(v.getUint32(16, true)).toBe(40);
    expect(v.getUint16(36, true)).toBe(22);
    expect(v.getUint16(44, true)).toBe(3); // float sub-format
    // data: frame 0 = [0, .1, .2, .3]
    const dataAt = out.length - 2 * 4 * 4;
    expect(v.getFloat32(dataAt + 4, true)).toBeCloseTo(0.1, 6);
    expect(v.getFloat32(dataAt + 12, true)).toBeCloseTo(0.3, 6);
    expect(v.getFloat32(dataAt + 16, true)).toBeCloseTo(0, 6);
    expect(v.getFloat32(dataAt + 20, true)).toBeCloseTo(-0.1, 6);
  });

  it('clips out-of-range integer samples', () => {
    const out = encodeWav([Float32Array.from([3, -3])], 8000, 16);
    const v = new DataView(out.buffer);
    expect(v.getInt16(44, true)).toBe(32767);
    expect(v.getInt16(46, true)).toBe(-32768);
    expect(clip(5)).toBe(1);
    expect(peak([Float32Array.from([0.2, -0.9])])).toBeCloseTo(0.9);
  });

  it('rejects mismatched channels', () => {
    expect(() => encodeWav([new Float32Array(2), new Float32Array(3)], 8000, 16)).toThrow();
  });
});
