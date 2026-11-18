// Defect injection for the repair test harness. Deterministic (seeded).
// This module is deliberately NOT imported by src/core.mjs: core stays a pure
// repair/measure library, injection lives in the test/tool layer.

export const DEFECTS = [
  "seam", "crack", "tjunction", "flip", "dup",
  "degen", "hole", "unused", "invert", "opposite",
];

// class -> audit field that must be > 0 before repair
export const WITNESS = {
  seam: "boundaryEdges", crack: "boundaryEdges", hole: "boundaryEdges",
  tjunction: "tJunctions", flip: "windingConflicts",
  dup: "duplicateFaces", opposite: "duplicateFaces",
  degen: "degenerateFaces", unused: "unusedVertices",
  invert: "invertedComponents",
};

export function diagOf(mesh) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of mesh.positions) for (let k = 0; k < 3; k++) {
    if (p[k] < mn[k]) mn[k] = p[k];
    if (p[k] > mx[k]) mx[k] = p[k];
  }
  return Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
}

const edgesOf = (mesh) => {
  const m = new Map();
  for (let f = 0; f < mesh.tris.length; f++) {
    const t = mesh.tris[f];
    for (let e = 0; e < 3; e++) {
      const u = t[e], v = t[(e + 1) % 3];
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push({ f, e });
    }
  }
  return m;
};

export function injectDefect(base, defect, rng) {
  const positions = base.positions.map((p) => p.slice());
  let tris = base.tris.map((t) => t.slice());
  const diag = diagOf(base);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of positions) for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; }

  if (defect === "seam" || defect === "crack") {
    const cut = (mn[0] + mx[0]) / 2;
    const delta = defect === "crack" ? 5e-7 * diag : 0;
    const dup = new Map();
    const n0 = positions.length;
    for (let i = 0; i < n0; i++) {
      if (positions[i][0] >= cut - 1e-9) {
        dup.set(i, positions.length);
        positions.push([positions[i][0] + delta, positions[i][1], positions[i][2]]);
      }
    }
    tris = tris.map((t) => (t.every((v) => dup.has(v)) ? t.map((v) => dup.get(v)) : t));
    return { positions, tris };
  }

  if (defect === "tjunction") {
    const em = edgesOf(base);
    const cand = [...em.entries()].filter(([, inc]) => inc.length === 2);
    const pick = cand[Math.floor(rng() * cand.length)];
    const [key] = pick;
    const [u, v] = key.split(",").map(Number);
    const A = positions[u], B = positions[v];
    const w = positions.length;
    positions.push([(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2]);
    const inc = pick[1];
    const { f, e } = inc[0];
    const t = tris[f];
    const uu = t[e], vv = t[(e + 1) % 3], o = t[(e + 2) % 3];
    if (uu === u && vv === v) tris.splice(f, 1, [u, w, o], [w, v, o]);
    else tris.splice(f, 1, [v, w, o], [w, u, o]);
    return { positions, tris };
  }

  if (defect === "flip") {
    const f = Math.floor(rng() * tris.length);
    tris[f] = [tris[f][0], tris[f][2], tris[f][1]];
    return { positions, tris };
  }

  if (defect === "dup" || defect === "opposite") {
    const f = Math.floor(rng() * tris.length);
    const t = tris[f];
    tris.push(defect === "dup" ? [t[0], t[1], t[2]] : [t[0], t[2], t[1]]);
    return { positions, tris };
  }

  if (defect === "degen") {
    const t = tris[Math.floor(rng() * tris.length)];
    tris.push([t[0], t[1], t[1]]);
    return { positions, tris };
  }

  if (defect === "hole") {
    const f = Math.floor(rng() * tris.length);
    tris.splice(f, 1);
    return { positions, tris };
  }

  if (defect === "unused") {
    positions.push([mx[0] + diag, mx[1] + diag, mx[2] + diag]);
    return { positions, tris };
  }

  if (defect === "invert") {
    tris = tris.map((t) => [t[0], t[2], t[1]]);
    return { positions, tris };
  }

  throw new Error(`unknown defect ${defect}`);
}