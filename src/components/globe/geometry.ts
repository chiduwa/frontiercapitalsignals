export const focusMarkets = [
  { name: "Ghana", currency: "GHS", lon: -1.02, lat: 7.95, labelX: 6, labelY: 342 },
  { name: "Nigeria", currency: "NGN", lon: 8.68, lat: 9.08, labelX: 18, labelY: 174 },
  { name: "Kenya", currency: "KES", lon: 37.91, lat: 0.02, labelX: 478, labelY: 322 },
  { name: "Malawi", currency: "MWK", lon: 34.3, lat: -13.25, labelX: 446, labelY: 432 },
  { name: "Uganda", currency: "UGX", lon: 32.29, lat: 1.37, labelX: 474, labelY: 212 },
] as const;

const radians = Math.PI / 180;
export function toVector(lon: number, lat: number) {
  return [Math.cos(lat * radians) * Math.sin(lon * radians), Math.sin(lat * radians), Math.cos(lat * radians) * Math.cos(lon * radians)] as const;
}

/** Orthographic projection of a real sphere, centred on Africa. */
export function project(vector: readonly number[], yaw = 20, pitch = 8) {
  return projector(yaw, pitch)(vector);
}

/** Same projection with the rotation's sines and cosines worked out once,
 *  for drawing thousands of points per frame. */
export function projector(yaw = 20, pitch = 8) {
  const y = yaw * radians, p = pitch * radians;
  const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p);
  return (vector: readonly number[]) => {
    const x = vector[0] * cy - vector[2] * sy;
    const z = vector[0] * sy + vector[2] * cy;
    return { x: 300 + 210 * x, y: 278 - 210 * (vector[1] * cp - z * sp), z: vector[1] * sp + z * cp };
  };
}
