// Timing + 250,000-ray oracle sweep. Writes bench/result.json.
import { readFileSync, writeFileSync } from "node:fs";
import { buildVoxelMesh, auditMesh, repairMesh, meshVolume, bbox, makeRng, voxelSetOf, auditRay } from "../src/core.mjs";
import { injectDefect } from "../tools/inject.mjs";
import { repair as baselineRepair } from "../baseline/none.mjs";
import { makeRay } from "../tools/rays.mjs";

const corpus = JSON.parse(readFileSync(new URL("../data/corpus.json", import.meta.url), "utf8"));
const cases = corpus.cases;

function buildCase(c) {
  const base = buildVoxelMesh(corpus.solids[c.solid].voxels);
  return injectDefect(base, c.defect, makeRng(c.seed));
}
const injected = cases.map(buildCase);

// cold start: first repair call on a fresh process
const tCold0 = performance.now();
const first = repairMesh(injected[0]);
const coldStartMs = performance.now() - tCold0;

const repairTimes = [];
for (let rep = 0; rep < 8; rep++) {
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < cases.length; i++) {
    const r = repairMesh(injected[i]);
    acc += auditMesh(r.mesh).faceCount;
  }
  repairTimes.push(performance.now() - t0);
}
const warm = repairTimes.slice(1);
const median = (a) => { const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const stddev = (a) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));
const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };

// 250,000-ray dual-oracle sweep on repaired meshes and on the identity baseline
const repaired = injected.map((m) => repairMesh(m).mesh);
const RAYS = 250000;
let mismatches = 0, baselineMismatches = 0, samples = 0, crossings = 0;
const rayT0 = performance.now();
const rayMeshes = repaired;
for (let i = 0; i < RAYS; i++) {
  const ci = i % cases.length;
  const m = rayMeshes[ci];
  const diag = bbox(m).diag;
  const r = makeRay(m, makeRng(0x9e3779b9 ^ i), diag, i);
  const set = voxelSetOf(corpus.solids[cases[ci].solid].voxels);
  const a = auditRay(m, set, r.origin, r.dir, diag);
  samples += a.samples; crossings += a.crossings;
  if (a.mismatches) mismatches++;
  const bm = injected[ci];
  const b = auditRay(bm, set, r.origin, r.dir, diag);
  if (b.mismatches) baselineMismatches++;
}
const rayMs = performance.now() - rayT0;

let volMaxRel = 0;
for (let i = 0; i < cases.length; i++) {
  const analytic = corpus.solids[cases[i].solid].voxels.length;
  volMaxRel = Math.max(volMaxRel, Math.abs(meshVolume(repaired[i]) - analytic) / analytic);
}

const result = {
  generatedBy: "bench/bench.mjs",
  node: process.version,
  cases: cases.length,
  solids: corpus.solids.length,
  repair: {
    coldStartMs: +coldStartMs.toFixed(3),
    samples: repairTimes.length,
    warmupRuns: 1,
    minMs: +Math.min(...warm).toFixed(3),
    medianMs: +median(warm).toFixed(3),
    p95Ms: +q(warm, 0.95).toFixed(3),
    stddevMs: +stddev(warm).toFixed(3),
    rsdPct: +((stddev(warm) / mean(warm)) * 100).toFixed(2),
    perCaseMedianMs: +(median(warm) / cases.length).toFixed(4),
  },
  rays: {
    count: RAYS,
    mismatchedRays: mismatches,
    baselineMismatchedRays: baselineMismatches,
    samples: samples,
    crossings: crossings,
    totalMs: +rayMs.toFixed(1),
    nsPerRay: +((rayMs * 1e6) / RAYS).toFixed(1),
  },
  volume: { maxRelativeError: volMaxRel, tolerance: 1e-12 },
  firstRepair: { faces: first.mesh.tris.length, log: first.log },
};
writeFileSync(new URL("./result.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));