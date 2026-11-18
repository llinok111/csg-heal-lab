// Deterministic ray construction shared by gen-sample and verify/bench.
import { bbox } from "../src/core.mjs";

export function makeRay(mesh, rng, diag, i = 0) {
  const b = bbox(mesh);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const z = rng() * 2 - 1, th = rng() * Math.PI * 2, r = Math.sqrt(Math.max(0, 1 - z * z));
  const u = [r * Math.cos(th), r * Math.sin(th), z];
  const origin = [cx + u[0] * 2 * diag, cy + u[1] * 2 * diag, cz + u[2] * 2 * diag];
  let target;
  const mode = i % 5;
  if (mode === 0) {
    const t = mesh.tris[Math.floor(rng() * mesh.tris.length)];
    const a = mesh.positions[t[0]], bb = mesh.positions[t[1]];
    target = [(a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2, (a[2] + bb[2]) / 2];
  } else if (mode === 1) {
    const t = mesh.tris[Math.floor(rng() * mesh.tris.length)];
    const a = mesh.positions[t[0]], bb = mesh.positions[t[1]], cc = mesh.positions[t[2]];
    target = [(a[0] + bb[0] + cc[0]) / 3, (a[1] + bb[1] + cc[1]) / 3, (a[2] + bb[2] + cc[2]) / 3];
  } else {
    target = [b.min[0] + rng() * (b.max[0] - b.min[0]), b.min[1] + rng() * (b.max[1] - b.min[1]), b.min[2] + rng() * (b.max[2] - b.min[2])];
  }
  const d = [target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]];
  const L = Math.hypot(...d);
  return { origin, dir: [d[0] / L, d[1] / L, d[2] / L] };
}
