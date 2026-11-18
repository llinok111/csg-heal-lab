// Baseline: "fix nothing", i.e. ship the raw CSG result. This is the honest
// comparison point for the repair claims (it is not a strawman algorithm).
export function repair(mesh) {
  return { mesh: { positions: mesh.positions.map((p) => p.slice()), tris: mesh.tris.map((t) => t.slice()) }, log: { identity: true } };
}
