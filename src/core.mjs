// Pure geometry core for CSG result repair. No three.js, no DOM, no I/O.
// Mesh representation: { positions: [[x,y,z],...], tris: [[a,b,c],...] }
// All tolerances are RELATIVE to the mesh bbox diagonal (scale invariant).

export function bbox(mesh) {
  const p = mesh.positions;
  if (p.length === 0) return { min: [0, 0, 0], max: [0, 0, 0], diag: 0 };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of p) for (let k = 0; k < 3; k++) {
    if (v[k] < min[k]) min[k] = v[k];
    if (v[k] > max[k]) max[k] = v[k];
  }
  const dx = max[0] - min[0], dy = max[1] - min[1], dz = max[2] - min[2];
  return { min, max, diag: Math.sqrt(dx * dx + dy * dy + dz * dz) };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a) => Math.sqrt(dot(a, a));

export function triArea2(mesh, t) {
  const a = mesh.positions[t[0]], b = mesh.positions[t[1]], c = mesh.positions[t[2]];
  const n = cross(sub(b, a), sub(c, a));
  return dot(n, n);
}

export function meshVolume(mesh) {
  let v = 0;
  for (const [a, b, c] of mesh.tris) {
    const A = mesh.positions[a], B = mesh.positions[b], C = mesh.positions[c];
    v += dot(A, cross(B, C));
  }
  return v / 6;
}

// ---------- voxel-aligned CSG solid -> exact boundary mesh ----------
// voxels: Array<[x,y,z]> of filled integer cells. The analytic solid is the
// union of those unit cells; its volume is exactly voxels.length.
export function buildVoxelMesh(voxels) {
  const filled = new Set(voxels.map((v) => `${v[0]},${v[1]},${v[2]}`));
  const posIndex = new Map();
  const positions = [];
  const tris = [];
  const vid = (x, y, z) => {
    const k = `${x},${y},${z}`;
    let i = posIndex.get(k);
    if (i === undefined) {
      i = positions.length;
      posIndex.set(k, i);
      positions.push([x, y, z]);
    }
    return i;
  };
  const quad = (a, b, c, d) => {
    const ia = vid(...a), ib = vid(...b), ic = vid(...c), id = vid(...d);
    tris.push([ia, ib, ic], [ia, ic, id]);
  };
  for (const [x, y, z] of voxels) {
    if (!filled.has(`${x + 1},${y},${z}`)) quad([x + 1, y, z], [x + 1, y + 1, z], [x + 1, y + 1, z + 1], [x + 1, y, z + 1]);
    if (!filled.has(`${x - 1},${y},${z}`)) quad([x, y, z], [x, y, z + 1], [x, y + 1, z + 1], [x, y + 1, z]);
    if (!filled.has(`${x},${y + 1},${z}`)) quad([x, y + 1, z], [x, y + 1, z + 1], [x + 1, y + 1, z + 1], [x + 1, y + 1, z]);
    if (!filled.has(`${x},${y - 1},${z}`)) quad([x, y, z], [x + 1, y, z], [x + 1, y, z + 1], [x, y, z + 1]);
    if (!filled.has(`${x},${y},${z + 1}`)) quad([x, y, z + 1], [x + 1, y, z + 1], [x + 1, y + 1, z + 1], [x, y + 1, z + 1]);
    if (!filled.has(`${x},${y},${z - 1}`)) quad([x, y, z], [x, y + 1, z], [x + 1, y + 1, z], [x + 1, y, z]);
  }
  return { positions, tris };
}

export function insideVoxels(voxelSet, p) {
  return voxelSet.has(`${Math.floor(p[0])},${Math.floor(p[1])},${Math.floor(p[2])}`);
}

// ---------- audit ----------
export function auditMesh(mesh, opts = {}) {
  const diag = bbox(mesh).diag || 1;
  const areaEps = (opts.areaRel ?? 1e-12) * diag * diag;
  const ptEps = (opts.pointRel ?? 1e-9) * diag;
  const nV = mesh.positions.length;
  const edges = new Map(); // "u,v" -> [{f, dir}]
  const faceKeys = new Map();
  const degenerate = [];
  const duplicate = [];
  const used = new Set();
  for (let f = 0; f < mesh.tris.length; f++) {
    const t = mesh.tris[f];
    const [a, b, c] = t;
    used.add(a); used.add(b); used.add(c);
    if (a === b || b === c || a === c || triArea2(mesh, t) <= areaEps * areaEps) {
      degenerate.push(f);
      continue;
    }
    const k = [a, b, c].slice().sort((x, y) => x - y).join(",");
    if (faceKeys.has(k)) { duplicate.push(f); continue; }
    faceKeys.set(k, f);
    for (let e = 0; e < 3; e++) {
      const u = t[e], v = t[(e + 1) % 3];
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push({ f, dir: u < v ? 1 : -1 });
    }
  }
  const boundary = [], nonManifold = [], winding = [];
  for (const [key, inc] of edges) {
    if (inc.length === 1) boundary.push(key);
    else if (inc.length > 2) nonManifold.push(key);
    else if (inc[0].dir === inc[1].dir) winding.push(key);
  }
  // T-junctions: a vertex strictly inside an undirected edge.
  const tj = [];
  const seen = new Set();
  for (const key of edges.keys()) {
    const [u, v] = key.split(",").map(Number);
    const A = mesh.positions[u], B = mesh.positions[v];
    const L = len(sub(B, A));
    const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
    for (let w = 0; w < nV; w++) {
      if (w === u || w === v) continue;
      const P = mesh.positions[w];
      const wx = P[0] - A[0], wy = P[1] - A[1], wz = P[2] - A[2];
      const t = (wx * dx + wy * dy + wz * dz) / (L * L);
      if (t <= 0 || t >= 1) continue;
      const px = A[0] + t * dx, py = A[1] + t * dy, pz = A[2] + t * dz;
      const d2 = (P[0] - px) ** 2 + (P[1] - py) ** 2 + (P[2] - pz) ** 2;
      if (d2 <= ptEps * ptEps) {
        const sig = `${key}:${w}`;
        if (!seen.has(sig)) { seen.add(sig); tj.push([u, v, w]); }
      }
    }
  }
  // Inverted connected components via signed volume per face component.
  const comp = componentIds(mesh, edges);
  const compVol = new Map();
  for (let f = 0; f < mesh.tris.length; f++) {
    if (degenerate.includes(f) || duplicate.includes(f)) continue;
    const c = comp[f];
    const A = mesh.positions[mesh.tris[f][0]], B = mesh.positions[mesh.tris[f][1]], C = mesh.positions[mesh.tris[f][2]];
    compVol.set(c, (compVol.get(c) ?? 0) + dot(A, cross(B, C)) / 6);
  }
  const inverted = [...compVol.entries()].filter(([, v]) => v < 0).map(([c]) => c);
  const unused = [];
  for (let v = 0; v < nV; v++) if (!used.has(v)) unused.push(v);
  return {
    vertexCount: nV, faceCount: mesh.tris.length,
    boundaryEdges: boundary.length, boundaryList: boundary,
    nonManifoldEdges: nonManifold.length, nonManifoldList: nonManifold,
    windingConflicts: winding.length, windingList: winding,
    degenerateFaces: degenerate.length, degenerateList: degenerate,
    duplicateFaces: duplicate.length, duplicateList: duplicate,
    unusedVertices: unused.length, unusedList: unused,
    tJunctions: tj.length, tJunctionList: tj,
    invertedComponents: inverted.length,
    watertight: boundary.length === 0 && nonManifold.length === 0 && winding.length === 0,
    volume: meshVolume(mesh),
  };
}

function componentIds(mesh, edges) {
  const parent = new Array(mesh.tris.length).fill(0).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  for (const inc of edges.values()) {
    for (let i = 1; i < inc.length; i++) union(inc[0].f, inc[i].f);
  }
  return parent.map((_, i) => find(i));
}

// ---------- repair ----------
export function repairMesh(input, opts = {}) {
  const diag = bbox(input).diag || 1;
  const weldTol = (opts.weldRel ?? 1e-6) * diag;
  const ptEps = (opts.pointRel ?? 1e-9) * diag;
  const areaEps = (opts.areaRel ?? 1e-12) * diag * diag;
  const log = { welded: 0, degenerateRemoved: 0, duplicateRemoved: 0, tSplits: 0, holesFilled: 0, flippedFaces: 0, flippedComponents: 0 };

  // 1. weld near-duplicate vertices with a spatial hash
  let mesh = weldVertices(input, weldTol, log);
  // 2. drop degenerate + duplicate faces
  mesh = dropBadFaces(mesh, areaEps, log);
  // 3. consistent orientation
  mesh = orientMesh(mesh, log);
  // 4. split T-junctions (iterate to fixed point)
  for (let it = 0; it < 4; it++) {
    const before = log.tSplits;
    mesh = splitTJunctions(mesh, ptEps, log);
    if (log.tSplits === before) break;
  }
  // 5. fill boundary loops with centroid fans
  mesh = fillBoundaryLoops(mesh, log);
  // 6. compact vertices
  mesh = compact(mesh);
  return { mesh, log };
}

function weldVertices(mesh, tol, log) {
  const out = [];
  const oldToNew = new Array(mesh.positions.length);
  const grid = new Map();
  const cellOf = (p) => p.map((c) => Math.floor(c / tol)).join(",");
  for (let i = 0; i < mesh.positions.length; i++) {
    const p = mesh.positions[i];
    const c = p.map((v) => Math.floor(v / tol));
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) for (let dy = -1; dy <= 1 && found < 0; dy++) for (let dz = -1; dz <= 1 && found < 0; dz++) {
      const bucket = grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`);
      if (!bucket) continue;
      for (const j of bucket) {
        const q = out[j];
        const d2 = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (d2 <= tol * tol) { found = j; break; }
      }
    }
    if (found < 0) {
      found = out.length;
      out.push([p[0], p[1], p[2]]);
      const key = cellOf(p);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(found);
    } else if (p[0] !== out[found][0] || p[1] !== out[found][1] || p[2] !== out[found][2]) {
      log.welded++;
    }
    oldToNew[i] = found;
  }
  const tris = [];
  for (const t of mesh.tris) {
    const a = oldToNew[t[0]], b = oldToNew[t[1]], c = oldToNew[t[2]];
    if (a === b || b === c || a === c) { log.degenerateRemoved++; continue; }
    tris.push([a, b, c]);
  }
  return { positions: out, tris };
}

function dropBadFaces(mesh, areaEps, log) {
  const seen = new Set();
  const tris = [];
  for (const t of mesh.tris) {
    const [a, b, c] = t;
    if (a === b || b === c || a === c || triArea2(mesh, t) <= areaEps * areaEps) { log.degenerateRemoved++; continue; }
    const k = [a, b, c].slice().sort((x, y) => x - y).join(",");
    if (seen.has(k)) { log.duplicateRemoved++; continue; }
    seen.add(k);
    tris.push(t);
  }
  return { positions: mesh.positions, tris };
}

function orientMesh(mesh, log) {
  const nF = mesh.tris.length;
  const edges = new Map();
  for (let f = 0; f < nF; f++) {
    const t = mesh.tris[f];
    for (let e = 0; e < 3; e++) {
      const u = t[e], v = t[(e + 1) % 3];
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push({ f, dir: u < v ? 1 : -1 });
    }
  }
  const flip = new Array(nF).fill(-1);
  for (let s = 0; s < nF; s++) {
    if (flip[s] !== -1) continue;
    flip[s] = 0;
    const stack = [s];
    while (stack.length) {
      const f = stack.pop();
      const t = mesh.tris[f];
      for (let e = 0; e < 3; e++) {
        const u = t[e], v = t[(e + 1) % 3];
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        const inc = edges.get(key) || [];
        if (inc.length !== 2) continue;
        const other = inc[0].f === f ? inc[1] : inc[0];
        const selfDir = inc[0].f === f ? inc[0].dir : inc[1].dir;
        if (flip[other.f] !== -1) continue;
        flip[other.f] = selfDir === other.dir ? 1 - flip[f] : flip[f];
        stack.push(other.f);
      }
    }
  }
  const out = mesh.tris.map((t, i) => (flip[i] === 1 ? [t[0], t[2], t[1]] : t));
  const flips = flip.filter((x) => x === 1).length;
  log.flippedFaces += flips;
  // per-component volume sign
  const edges2 = new Map();
  for (let f = 0; f < out.length; f++) {
    const t = out[f];
    for (let e = 0; e < 3; e++) {
      const u = t[e], v = t[(e + 1) % 3];
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      if (!edges2.has(key)) edges2.set(key, []);
      edges2.get(key).push({ f });
    }
  }
  const comp = componentIds({ tris: out }, edges2);
  const compVol = new Map();
  for (let f = 0; f < out.length; f++) {
    const [a, b, c] = out[f];
    const A = mesh.positions[a], B = mesh.positions[b], C = mesh.positions[c];
    compVol.set(comp[f], (compVol.get(comp[f]) ?? 0) + dot(A, cross(B, C)) / 6);
  }
  const inward = new Set([...compVol.entries()].filter(([, v]) => v < 0).map(([c]) => c));
  const final = out.map((t, f) => (inward.has(comp[f]) ? [t[0], t[2], t[1]] : t));
  log.flippedComponents += new Set([...comp].filter((c) => inward.has(c))).size;
  return { positions: mesh.positions, tris: final };
}

function splitTJunctions(mesh, ptEps, log) {
  let positions = mesh.positions.slice();
  let tris = mesh.tris;
  const nV = positions.length;
  const edgeSet = new Map();
  for (const t of tris) for (let e = 0; e < 3; e++) {
    const u = t[e], v = t[(e + 1) % 3];
    edgeSet.set(u < v ? `${u},${v}` : `${v},${u}`, [u < v ? u : v, u < v ? v : u]);
  }
  const splits = new Map(); // edgeKey -> w
  for (const [key, [u, v]] of edgeSet) {
    const A = positions[u], B = positions[v];
    const L = len(sub(B, A));
    if (L === 0) continue;
    for (let w = 0; w < nV; w++) {
      if (w === u || w === v) continue;
      const P = positions[w];
      const wx = P[0] - A[0], wy = P[1] - A[1], wz = P[2] - A[2];
      const t = (wx * (B[0] - A[0]) + wy * (B[1] - A[1]) + wz * (B[2] - A[2])) / (L * L);
      if (t <= 0 || t >= 1) continue;
      const px = A[0] + t * (B[0] - A[0]), py = A[1] + t * (B[1] - A[1]), pz = A[2] + t * (B[2] - A[2]);
      if ((P[0] - px) ** 2 + (P[1] - py) ** 2 + (P[2] - pz) ** 2 <= ptEps * ptEps) {
        splits.set(key, w);
        break;
      }
    }
  }
  if (splits.size === 0) return { positions, tris };
  const out = [];
  for (const t of tris) {
    let replaced = false;
    for (let e = 0; e < 3 && !replaced; e++) {
      const u = t[e], v = t[(e + 1) % 3], other = t[(e + 2) % 3];
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      const w = splits.get(key);
      if (w === undefined) continue;
      // preserve cyclic order
      // t[e]===u and t[(e+1)%3]===v, so cyclic u->v->other splits into
      // u->w->other and w->v->other, preserving orientation.
      if (t[e] === u) out.push([u, w, other], [w, v, other]);
      else out.push([v, w, other], [w, u, other]);
      replaced = true;
    }
    if (!replaced) out.push(t);
  }
  // When an edge is traversed as (v,u) by a face, the two child faces must keep
  // the original orientation: (v,u,o) -> (v,w,o) + (w,u,o).
  // The branch above emits exactly that for t[e]===v.
  log.tSplits += splits.size;
  return { positions, tris: out };
}

function fillBoundaryLoops(mesh, log) {
  const tris = mesh.tris.slice();
  const positions = mesh.positions.slice();
  for (let pass = 0; pass < 8; pass++) {
    const count = new Map();
    const dir = new Map();
    for (let f = 0; f < tris.length; f++) {
      const t = tris[f];
      for (let e = 0; e < 3; e++) {
        const u = t[e], v = t[(e + 1) % 3];
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        count.set(key, (count.get(key) ?? 0) + 1);
        dir.set(key, [u, v]);
      }
    }
    const outs = new Map();
    let boundary = 0;
    for (const [key, c] of count) {
      if (c !== 1) continue;
      boundary++;
      const [u, v] = dir.get(key);
      if (!outs.has(u)) outs.set(u, []);
      outs.get(u).push(v);
    }
    if (boundary === 0) break;
    let filled = 0;
    const visited = new Set();
    for (const [u0] of outs) {
      if (visited.has(u0)) continue;
      let u = u0;
      const loop = [];
      for (let guard = 0; guard < 100000; guard++) {
        if (visited.has(u)) break;
        visited.add(u);
        const nxt = (outs.get(u) || []).find((v) => !visited.has(v)) ?? (outs.get(u) || [])[0];
        if (nxt === undefined) break;
        loop.push([u, nxt]);
        u = nxt;
        if (u === u0) break;
      }
      if (loop.length < 3) continue;
      // centroid fan; reverse each directed boundary edge so the patch is
      // oriented consistently with the existing surface.
      let cx = 0, cy = 0, cz = 0;
      const vs = new Set(loop.map(([a, b]) => a).concat(loop.map(([, b]) => b)));
      for (const v of vs) { const P = positions[v]; cx += P[0]; cy += P[1]; cz += P[2]; }
      const cIdx = positions.length;
      positions.push([cx / vs.size, cy / vs.size, cz / vs.size]);
      for (const [a, b] of loop) tris.push([b, a, cIdx]);
      filled += loop.length;
    }
    log.holesFilled += filled;
    if (filled === 0) break;
  }
  return { positions, tris };
}

function compact(mesh) {
  const used = new Set();
  for (const t of mesh.tris) for (const v of t) used.add(v);
  const map = new Map();
  const positions = [];
  for (let i = 0; i < mesh.positions.length; i++) {
    if (!used.has(i)) continue;
    map.set(i, positions.length);
    positions.push(mesh.positions[i]);
  }
  return { positions, tris: mesh.tris.map((t) => t.map((v) => map.get(v))) };
}

// ---------- ray / volume oracles ----------
function rayTriangle(o, d, a, b, c, relEps) {
  const e1 = sub(b, a), e2 = sub(c, a);
  const p = cross(d, e2);
  const det = dot(e1, p);
  const scale = len(e1) * len(e2) * Math.max(1, len(d));
  if (Math.abs(det) <= relEps * scale) return null;
  const inv = 1 / det;
  const s = sub(o, a);
  const u = dot(s, p) * inv;
  if (u < -relEps || u > 1 + relEps) return null;
  const q = cross(s, e1);
  const v = dot(d, q) * inv;
  if (v < -relEps || u + v > 1 + relEps) return null;
  return dot(e2, q) * inv;
}

export function rayHits(mesh, origin, dir, relEps = 1e-12) {
  const ts = [];
  for (const [ia, ib, ic] of mesh.tris) {
    const t = rayTriangle(origin, dir, mesh.positions[ia], mesh.positions[ib], mesh.positions[ic], relEps);
    if (t !== null) ts.push(t);
  }
  ts.sort((a, b) => a - b);
  return ts;
}

// Unique crossings: merge t values within tolDt (edge/vertex hits produce
// coincident t from two or more triangles; they are one crossing).
export function uniqueCrossings(ts, tolDt) {
  const out = [];
  for (const t of ts) {
    if (out.length === 0 || Math.abs(t - out[out.length - 1]) > tolDt) out.push(t);
  }
  return out;
}

function signedHits(mesh, origin, dir, relEps) {
  const hits = [];
  for (const [ia, ib, ic] of mesh.tris) {
    const a = mesh.positions[ia], b = mesh.positions[ib], c = mesh.positions[ic];
    const t = rayTriangle(origin, dir, a, b, c, relEps);
    if (t === null || t <= 0) continue;
    // outward normal n; entering the solid means dir . n < 0 -> +1
    const n = cross(sub(b, a), sub(c, a));
    hits.push({ t, s: dot(dir, n) < 0 ? 1 : -1 });
  }
  hits.sort((x, y) => x.t - y.t);
  return hits;
}

// Winding-number crossing count: a tangential edge/vertex touch contributes
// +1 and -1 at (nearly) the same t, which cancels. This is robust to exact
// boundary hits, unlike naive parity-with-dedup.
export function crossingChanges(mesh, origin, dir, tolDt, relEps = 1e-12) {
  const hits = signedHits(mesh, origin, dir, relEps);
  const groups = [];
  for (const h of hits) {
    if (groups.length && Math.abs(h.t - groups[groups.length - 1].t) <= tolDt) {
      groups[groups.length - 1].pos += h.s > 0 ? 1 : 0;
      groups[groups.length - 1].neg += h.s < 0 ? 1 : 0;
    } else {
      groups.push({ t: h.t, pos: h.s > 0 ? 1 : 0, neg: h.s < 0 ? 1 : 0 });
    }
  }
  // Coincident hits: entry through an edge gives two front-facing triangles
  // (count once); a tangential graze gives one front + one back (count zero).
  return groups
    .map((g) => ({ t: g.t, delta: g.neg === 0 ? 1 : g.pos === 0 ? -1 : 0 }))
    .filter((c) => c.delta !== 0);
}

export function pointInsideByRay(mesh, p, dir, relEps = 1e-12, tolDt = 1e-9) {
  const ch = crossingChanges(mesh, p, dir, tolDt, relEps);
  let w = 0;
  for (const c of ch) w += c.delta;
  return w !== 0;
}

// Compare mesh winding against the analytic voxel solid along a ray.
export function auditRay(mesh, voxelSet, origin, dir, diag, opts = {}) {
  const tolDt = (opts.dtRel ?? 1e-9) * diag;
  const ch = crossingChanges(mesh, origin, dir, tolDt, opts.relEps ?? 1e-12);
  let mismatches = 0;
  let samples = 0;
  // before the first change: outside
  const check = (p, expected) => { samples++; if (insideVoxels(voxelSet, p) !== expected) mismatches++; };
  if (ch.length === 0) {
    check([origin[0] + dir[0], origin[1] + dir[1], origin[2] + dir[2]], false);
    return { crossings: 0, samples, mismatches };
  }
  check([origin[0] + dir[0] * ch[0].t * 0.5, origin[1] + dir[1] * ch[0].t * 0.5, origin[2] + dir[2] * ch[0].t * 0.5], false);
  let w = 0;
  for (let i = 0; i < ch.length; i++) {
    w += ch[i].delta;
    const t1 = i + 1 < ch.length ? ch[i + 1].t : ch[i].t + Math.max(1e-6 * diag, 1);
    const mid = (ch[i].t + t1) / 2;
    check([origin[0] + dir[0] * mid, origin[1] + dir[1] * mid, origin[2] + dir[2] * mid], w !== 0);
  }
  return { crossings: ch.length, samples, mismatches, winding: w };
}

export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function voxelSetOf(voxels) {
  return new Set(voxels.map((v) => `${v[0]},${v[1]},${v[2]}`));
}