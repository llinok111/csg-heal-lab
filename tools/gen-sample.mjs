// Deterministic sample generator: CSG (grid-aligned box union/difference)
// solids -> voxel sets -> a corpus of injected-defect cases + node-baked ref.
import { writeFileSync, mkdirSync } from "node:fs";
import { buildVoxelMesh, auditMesh, repairMesh, meshVolume, bbox, makeRng, voxelSetOf, auditRay } from "../src/core.mjs";
import { DEFECTS, WITNESS, injectDefect } from "./inject.mjs";
import { makeRay } from "./rays.mjs";

const CANDIDATES = [
  [{ op: "u", box: [0, 0, 0, 3, 3, 3] }],
  [{ op: "u", box: [0, 0, 0, 4, 2, 2] }, { op: "u", box: [2, 1, 0, 3, 4, 2] }],
  [{ op: "u", box: [0, 0, 0, 4, 4, 2] }, { op: "d", box: [1, 1, 0, 2, 2, 2] }],
  [{ op: "u", box: [0, 0, 0, 4, 2, 2] }, { op: "u", box: [0, 0, 0, 2, 4, 2] }],
  [{ op: "u", box: [0, 0, 0, 5, 2, 2] }, { op: "u", box: [4, 0, 0, 5, 4, 2] }, { op: "u", box: [0, 0, 0, 1, 4, 2] }],
  [{ op: "u", box: [0, 0, 0, 4, 4, 3] }, { op: "d", box: [1, 1, 0, 3, 3, 1] }],
  [{ op: "u", box: [0, 0, 0, 3, 3, 3] }, { op: "u", box: [3, 0, 0, 5, 1, 1] }],
  [{ op: "u", box: [0, 0, 0, 5, 3, 1] }, { op: "u", box: [0, 0, 0, 1, 5, 1] }, { op: "d", box: [2, 1, 0, 3, 2, 1] }],
  [{ op: "u", box: [0, 0, 0, 2, 2, 5] }],
  [{ op: "u", box: [0, 0, 0, 4, 2, 3] }, { op: "u", box: [1, 0, 2, 3, 2, 5] }],
  [{ op: "u", box: [0, 0, 0, 3, 3, 3] }, { op: "d", box: [0, 0, 1, 1, 1, 2] }],
  [{ op: "u", box: [0, 0, 0, 5, 2, 2] }, { op: "u", box: [1, 0, 0, 4, 4, 2] }],
  [{ op: "u", box: [0, 0, 0, 1, 1, 1] }, { op: "u", box: [2, 0, 0, 3, 1, 1] }],
  [{ op: "u", box: [0, 0, 0, 4, 4, 2] }, { op: "d", box: [1, 1, 0, 3, 3, 2] }],
  [{ op: "u", box: [0, 0, 0, 2, 1, 1] }, { op: "u", box: [3, 0, 0, 5, 1, 1] }, { op: "u", box: [0, 0, 1, 5, 1, 2] }],
];

function raster(ops) {
  const cells = [];
  for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) for (let z = 0; z < 6; z++) {
    let inside = false;
    for (const { op, box } of ops) {
      const [x0, y0, z0, x1, y1, z1] = box;
      if (x >= x0 && x < x1 && y >= y0 && y < y1 && z >= z0 && z < z1) inside = op === "u";
    }
    if (inside) cells.push([x, y, z]);
  }
  return cells;
}

function validSolid(voxels) {
  const mesh = buildVoxelMesh(voxels);
  const a = auditMesh(mesh);
  return a.boundaryEdges === 0 && a.nonManifoldEdges === 0 && a.windingConflicts === 0 && a.invertedComponents === 0 && mesh.tris.length >= 8 && mesh.tris.length <= 600 ? mesh : null;
}

const solids = [];
for (const ops of CANDIDATES) {
  const voxels = raster(ops);
  if (validSolid(voxels)) solids.push({ voxels, ops });
  if (solids.length === 12) break;
}
if (solids.length < 12) throw new Error(`only ${solids.length} valid solids`);

const cases = [];
let seed = 0xC5A11;
for (let s = 0; s < solids.length; s++) {
  for (const d of DEFECTS) {
    cases.push({ id: `s${String(s).padStart(2, "0")}-${d}`, solid: s, defect: d, seed: seed++ });
  }
}

// node-baked reference values for the browser HUD (same core, same case)
const refCases = {};
for (const c of cases) {
  const base = buildVoxelMesh(solids[c.solid].voxels);
  const rng = makeRng(c.seed);
  const injected = injectDefect(base, c.defect, rng);
  const before = auditMesh(injected);
  const { mesh, log } = repairMesh(injected);
  const after = auditMesh(mesh);
  const diag = bbox(mesh).diag;
  const set = voxelSetOf(solids[c.solid].voxels);
  const r2 = makeRng(c.seed ^ 0x9e3779b9);
  let mism = 0;
  const RAYS = 120;
  for (let i = 0; i < RAYS; i++) {
    const ray = makeRay(mesh, r2, diag, i);
    const r = auditRay(mesh, set, ray.origin, ray.dir, diag);
    if (r.mismatches) mism += 1;
  }
  refCases[c.id] = {
    before: pickAudit(before),
    after: pickAudit(after),
    volume: meshVolume(mesh),
    analyticVolume: solids[c.solid].voxels.length,
    rayMismatches: mism,
    rays: RAYS,
    log,
  };
}

function pickAudit(a) {
  return {
    vertexCount: a.vertexCount, faceCount: a.faceCount,
    boundaryEdges: a.boundaryEdges, nonManifoldEdges: a.nonManifoldEdges,
    windingConflicts: a.windingConflicts, degenerateFaces: a.degenerateFaces,
    duplicateFaces: a.duplicateFaces, unusedVertices: a.unusedVertices,
    tJunctions: a.tJunctions, invertedComponents: a.invertedComponents,
    watertight: a.watertight,
  };
}

mkdirSync(new URL("../data", import.meta.url), { recursive: true });
writeFileSync(new URL("../data/corpus.json", import.meta.url), JSON.stringify({
  generatedBy: "tools/gen-sample.mjs",
  solids: solids.map((s, i) => ({ id: i, ops: s.ops, voxels: s.voxels })),
  cases,
}, null, 1) + "\n");
writeFileSync(new URL("../data/ref.json", import.meta.url), JSON.stringify({
  generatedBy: "tools/gen-sample.mjs",
  cases: refCases,
  solids: solids.map((s, i) => {
    const m = buildVoxelMesh(s.voxels);
    const a = auditMesh(m);
    return { id: i, voxels: s.voxels.length, faces: m.tris.length, volume: meshVolume(m), watertight: a.watertight };
  }),
}, null, 1) + "\n");
console.log(`solids=${solids.length} cases=${cases.length}`);
console.log(`solid faces: ${solids.map((s) => buildVoxelMesh(s.voxels).tris.length).join(",")}`);
let bad = 0;
for (const [id, r] of Object.entries(refCases)) {
  if (!r.after.watertight || r.rayMismatches || Math.abs(r.volume - r.analyticVolume) > 1e-9 * r.analyticVolume) { bad++; console.log("FAIL", id, JSON.stringify(r)); }
}
console.log(`ref sanity: ${Object.keys(refCases).length - bad}/${Object.keys(refCases).length} clean`);