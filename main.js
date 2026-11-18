import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildVoxelMesh, auditMesh, repairMesh, bbox } from "./src/core.mjs";
import { injectDefect, DEFECTS } from "./tools/inject.mjs";

const view = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(view.clientWidth, view.clientHeight);
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);
const camera = new THREE.PerspectiveCamera(45, view.clientWidth / view.clientHeight, 0.1, 500);
camera.position.set(9, -11, 9);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 2);
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));
const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(6, 10, 12); scene.add(dl);
const grid = new THREE.GridHelper(20, 20, 0x263041, 0x151b24); scene.add(grid);

const corpus = await (await fetch("./data/corpus.json")).json();
const ref = await (await fetch("./data/ref.json")).json();
const $s = document.getElementById("solid"), $d = document.getElementById("defect");
corpus.solids.forEach((s, i) => $s.add(new Option(`solid ${i} (${s.voxels.length} cells)`, i)));
DEFECTS.forEach((d) => $d.add(new Option(d, d)));
let group = null;

function meshObject(mesh, color, opacity = 1) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions.flat(), 3));
  g.setIndex(mesh.tris.flat());
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, flatShading: true, metalness: 0.15, roughness: 0.55, transparent: opacity < 1, opacity, side: THREE.DoubleSide }));
}
function render(mesh, color) {
  if (group) { scene.remove(group); group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); }
  group = new THREE.Group(); group.add(meshObject(mesh, color)); scene.add(group);
  const b = bbox(mesh); controls.target.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
}
function seedsFrom(id, d) { let h = 2166136261; for (const ch of id + d) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rngOf(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function run(repair = true) {
  const si = +$s.value, defect = $d.value;
  const caseId = `s${String(si).padStart(2, "0")}-${defect}`;
  const base = buildVoxelMesh(corpus.solids[si].voxels);
  const injected = injectDefect(base, defect, rngOf(seedsFrom(caseId, defect)));
  const before = auditMesh(injected);
  const out = repair ? repairMesh(injected).mesh : injected;
  const after = auditMesh(out);
  render(out, repair ? 0x62d39b : 0xd06a5a);
  const rows = [
    ["mode", repair ? "repaired" : "raw CSG"],
    ["boundary edges", after.boundaryEdges],
    ["non-manifold", after.nonManifoldEdges],
    ["winding conflicts", after.windingConflicts],
    ["T-junctions", after.tJunctions],
    ["inverted shells", after.invertedComponents],
    ["volume", after.volume.toFixed(6)],
    ["analytic volume", ref.cases[caseId]?.analyticVolume ?? "?"],
    ["before (boundary/T-j)", `${before.boundaryEdges}/${before.tJunctions}`],
  ];
  document.getElementById("hud").innerHTML = rows.map(([k, v]) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`).join("");
  const baked = ref.cases[caseId];
  const match = baked && repair && baked.after.boundaryEdges === after.boundaryEdges && baked.after.tJunctions === after.tJunctions && Math.abs(baked.volume - after.volume) < 1e-9;
  document.getElementById("match").textContent = repair
    ? (match ? `MATCHES node-baked reference (${caseId})` : `live values differ from ref (${caseId})`)
    : `raw CSG: ${before.boundaryEdges} boundary edges, ${before.tJunctions} T-junctions`;
}
$s.onchange = () => run(false); $d.onchange = () => run(false);
document.getElementById("heal").onclick = () => run(true);
document.getElementById("raw").onclick = () => run(false);
addEventListener("resize", () => { renderer.setSize(view.clientWidth, view.clientHeight); camera.aspect = view.clientWidth / view.clientHeight; camera.updateProjectionMatrix(); });
run(false);
