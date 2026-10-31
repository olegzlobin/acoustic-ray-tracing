/**
 * FOA IR in the LISTENER frame: the world-frame IR rotated by -yaw about the vertical axis, i.e.
 * what a head-fixed AmbiX microphone facing `yaw` would record. Channels stay ACN W,Y,Z,X (SN3D).
 * X' = X cos(yaw) + Y sin(yaw), Y' = -X sin(yaw) + Y cos(yaw); W and Z are unchanged.
 */
export function rotateFoaToListener(ir: Float32Array[], yaw: number): Float32Array[] {
  const [w, y, z, x] = ir;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const x2 = new Float32Array(x.length);
  const y2 = new Float32Array(y.length);
  for (let i = 0; i < x.length; i++) {
    x2[i] = x[i] * c + y[i] * s;
    y2[i] = -x[i] * s + y[i] * c;
  }
  return [w, y2, z, x2];
}
