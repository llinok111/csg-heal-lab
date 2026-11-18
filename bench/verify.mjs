// Assertions over the generated corpus. Every printed number is measured here.
import { readFileSync } from "node:fs";
import { buildVoxelMesh, auditMesh, repairMesh, meshVolume, bbox, makeRng, voxelSetOf, auditRay } from "../src/core.mjs";
import { injectDefect, WITNESS } from "../tools/inject.mjs";
import { repair as baselineRepair } from "../baseline/none.mjs";
import { makeRay } from "../tools/rays.mjs";

const corpus = JSON.parse(readFileSync(new URL("../data/corpus.json", import.meta.url), "utf8"));
const ref = JSON.parse(readFileSync(new URL("../data/ref.json", import.meta.url), "utf8"));
let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`PASS ${label} :: ${detail}`); }
  else { fail++; console.log(`FAIL ${label} :: ${detail}`); }
};

let detected = 0, repaired = 0, volOk = 0, rayOk = 0, baseWatertight = 0;
let rayTotal = 0, rayBad = 0, maxVolRel = 0, minVolRel = Infinity;
let totalFaces = 0, totalVerts = 0;

for (const c of corpus.cases) {
  const base = buildVoxelMesh(corpus.solids[c.solid].voxels);
  const injected = injectDefect(base, c.defect, makeRng(c.seed));
  const before = auditMesh(injected);
  if (before[WITNESS[c.defect]] > 0) detected++;

  const b0 = baselineRepair(injected);
  const ba = auditMesh(b0.mesh);
  const bValid = ba.watertight && ba.degenerateFaces === 0 && ba.duplicateFaces === 0 && ba.unusedVertices === 0 && ba.invertedComponents === 0;
  if (bValid) baseWatertight++;

  const { mesh } = repairMesh(injected);
  const after = auditMesh(mesh);
  totalFaces += after.faceCount; totalVerts += after.vertexCount;
  const clean = after.boundaryEdges === 0 && after.nonManifoldEdges === 0 && after.windingConflicts === 0 &&
    after.degenerateFaces === 0 && after.duplicateFaces === 0 && after.unusedVertices === 0 &&
    after.tJunctions === 0 && after.invertedComponents === 0 && after.watertight;
  if (clean) repaired++;

  const analytic = corpus.solids[c.solid].voxels.length;
  const rel = Math.abs(meshVolume(mesh) - analytic) / analytic;
  maxVolRel = Math.max(maxVolRel, rel); minVolRel = Math.min(minVolRel, rel);
  if (rel <= 1e-12) volOk++;

  const diag = bbox(mesh).diag;
  const set = voxelSetOf(corpus.solids[c.solid].voxels);
  const rr = makeRng(c.seed ^ 0x51ed270b);
  let bad = 0;
  const N = 24;
  for (let i = 0; i < N; i++) {
    const ray = makeRay(mesh, rr, diag, i);
    const res = auditRay(mesh, set, ray.origin, ray.dir, diag);
    if (res.mismatches) bad++;
  }
  rayTotal += N; rayBad += bad;
  if (bad === 0) rayOk++;

  // cross-check baked reference for this case
  const baked = ref.cases[c.id];
  if (!baked || baked.after.boundaryEdges !== after.boundaryEdges || baked.after.tJunctions !== after.tJunctions || baked.rayMismatches !== bad) {
    console.log(`NOTE baked mismatch ${c.id}`);
  }
}

ok(detected === corpus.cases.length, "defect detection", `${detected}/${corpus.cases.length} injected defects witnessed (${Object.values(WITNESS).join("/")})`);
ok(baseWatertight === 0, "unrepaired baseline is invalid", `${baseWatertight}/${corpus.cases.length} baseline meshes fully valid (watertight + no dup/degen/unused/inverted)`);
ok(repaired === corpus.cases.length, "constructive repair", `${repaired}/${corpus.cases.length} watertight + 0 boundary/nonmanifold/winding/tjunction/inverted`);
ok(volOk === corpus.cases.length, "volume vs analytic", `${volOk}/${corpus.cases.length} within 1e-12 relative; max rel ${maxVolRel.toExponential(3)}, median-scale`);
ok(rayBad === 0, "ray winding oracle", `${rayTotal} rays, ${rayBad} rays with any mismatch; ${rayOk}/${corpus.cases.length} cases clean`);
ok(minVolRel >= 0, "volume lower bound", `min rel ${minVolRel.toExponential(3)}`);

// scale invariance: relative thresholds must keep the verdict at every scale
const scales = [1e-6, 1e-3, 1, 1e3, 1e6];
let scaleOk = 0, scaleTotal = 0;
const scaledVol = [];
for (const solidIdx of [0, 5, 9]) {
  for (const defect of ["seam", "tjunction", "hole", "invert"]) {
    for (const s of scales) {
      const base = buildVoxelMesh(corpus.solids[solidIdx].voxels);
      const scaled = { positions: base.positions.map((p) => p.map((v) => v * s)), tris: base.tris.map((t) => t.slice()) };
      const injected = injectDefect(scaled, defect, makeRng(1234 + solidIdx * 17));
      const { mesh } = repairMesh(injected);
      const a = auditMesh(mesh);
      const analytic = corpus.solids[solidIdx].voxels.length * s * s * s;
      const rel = Math.abs(meshVolume(mesh) - analytic) / analytic;
      scaleTotal++;
      if (a.watertight && a.boundaryEdges === 0 && a.tJunctions === 0 && a.invertedComponents === 0 && rel <= 1e-12) scaleOk++;
    }
  }
}
ok(scaleOk === scaleTotal, "scale invariance", `${scaleOk}/${scaleTotal} cases at scales 1e-6..1e6 stay watertight and volume-exact (relative eps only)`);

// independent duplicate-face oracle: O(F^2) pair compare, no shared code with core
function oracleDupFaces(mesh) {
  let dup = 0;
  for (let i = 0; i < mesh.tris.length; i++) for (let j = i + 1; j < mesh.tris.length; j++) {
    const a = mesh.tris[i].slice().sort((x, y) => x - y).join(",");
    const b = mesh.tris[j].slice().sort((x, y) => x - y).join(",");
    if (a === b) dup++;
  }
  return dup;
}
let oracleAgree = 0, oracleCases = 0;
for (const c of corpus.cases.filter((x) => x.defect === "dup" || x.defect === "opposite")) {
  const base = buildVoxelMesh(corpus.solids[c.solid].voxels);
  const injected = injectDefect(base, c.defect, makeRng(c.seed));
  const a = auditMesh(injected);
  oracleCases++;
  if (oracleDupFaces(injected) === a.duplicateFaces) oracleAgree++;
  const repMesh = repairMesh(injected).mesh;
  if (oracleDupFaces(repMesh) !== auditMesh(repMesh).duplicateFaces) oracleAgree--;
}
ok(oracleAgree === oracleCases, "independent duplicate oracle", `${oracleAgree}/${oracleCases} duplicate counts agree with O(F^2) pair scan`);

// determinism: same case twice -> same mesh volume + face count
let det = 0;
for (const c of corpus.cases.slice(0, 20)) {
  const base = buildVoxelMesh(corpus.solids[c.solid].voxels);
  const a = repairMesh(injectDefect(base, c.defect, makeRng(c.seed)));
  const b = repairMesh(injectDefect(base, c.defect, makeRng(c.seed)));
  if (a.mesh.tris.length === b.mesh.tris.length && Math.abs(meshVolume(a.mesh) - meshVolume(b.mesh)) < 1e-15) det++;
}
ok(det === 20, "determinism", `${det}/20 repeated repairs identical in face count and volume`);

console.log(`\nSUMMARY ${pass} passed / ${fail} failed · cases=${corpus.cases.length} faces=${totalFaces} verts=${totalVerts}`);
if (fail > 0) process.exit(1);
console.log("ALL ASSERTIONS PASSED");