// Omnitone 2.0.0 ships no type definitions; minimal surface we use.
declare module 'omnitone' {
  export interface FOARenderer {
    input: AudioNode;
    output: AudioNode;
    initialize(): Promise<void>;
    /** 3x3 column-major rotation applied to the sound field (GL axes: x right, y up, z back). */
    setRotationMatrix3(m: ArrayLike<number>): void;
    setRotationMatrix4(m: ArrayLike<number>): void;
  }
  const Omnitone: {
    createFOARenderer(ctx: BaseAudioContext, config?: { channelMap?: number[]; renderingMode?: string }): FOARenderer;
  };
  export default Omnitone;
}
