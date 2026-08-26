// Cotal galaxy — GPU mesh visualization (cosmos.gl).
//
// Why this stays light where the old 2D graph blew up: every buffer is FIXED-SIZE and reused.
// Pulses are not objects — an SSE "act" frame just sets heat=1 on a few indices; the render loop
// decays heat and writes one node-color + one node-size + one link-color buffer per frame. So
// per-frame work scales with what's ON SCREEN (nodes+links), never with the message rate. The
// force layout itself runs entirely on the GPU.
import { Graph } from "https://esm.sh/@cosmos.gl/graph@3.0.0";

const stage = document.getElementById("stage");
const tip = document.getElementById("tip");

// Colour = ROLE (the agent's type). Five colour-blind-safe Okabe-Ito hues; channel hubs are cyan.
const TEAM_SIZE = 100; // mirrors swarm.ts: agent a<gi> is in team floor(gi/TEAM_SIZE) — used to detect cross-team bridges
const ROLE = {
  planner: [0.0, 0.447, 0.698],     // #0072B2 blue
  builder: [0.0, 0.620, 0.451],     // #009E73 green
  reviewer: [0.941, 0.894, 0.259],  // #F0E442 yellow
  researcher: [0.8, 0.475, 0.655],  // #CC79A7 purple
  ops: [0.835, 0.369, 0.0],         // #D55E00 vermillion
};
const CHANNEL = [0.43, 0.86, 0.95]; // bright cyan — channel hubs
const UNKNOWN = [0.6, 0.66, 0.71];
const baseRGB = (n) => (n.kind === "channel" ? CHANNEL : (ROLE[n.role] || UNKNOWN));
function communityOf(n) { // team index, only for detecting cross-team bridge edges (warm-coloured)
  if (n.kind === "channel") { const m = /team(\d+)/.exec(n.label || n.id); return m ? +m[1] : -1; }
  const m = /^a(\d+)$/.exec(n.id); return m ? Math.floor(+m[1] / TEAM_SIZE) : -1;
}

// model
const idIndex = new Map(); const nodes = [];
const linkSet = new Set(); const links = [];
const status = new Map();
let dirty = false;

function addNode(n) {
  const i = idIndex.get(n.id);
  if (i !== undefined) { if (n.role && !nodes[i].role) { nodes[i].role = n.role; dirty = true; } return; }
  idIndex.set(n.id, nodes.length); nodes.push(n); dirty = true;
}
function addLink(a, b) { const k = a < b ? a + "|" + b : b + "|" + a; if (linkSet.has(k)) return; linkSet.add(k); links.push([a, b]); dirty = true; }
function setStat(id, s) { if (status.get(id) !== s) { status.set(id, s); dirty = true; } } // only dirty on a real change

// gpu buffers
let positions = new Float32Array(0), base = new Float32Array(0), baseSize = new Float32Array(0), psize = new Float32Array(0), colors = new Float32Array(0);
let linkArr = new Float32Array(0), linkBase = new Float32Array(0), linkCol = new Float32Array(0), linkW = new Float32Array(0), linkKind = new Uint8Array(0);
let heat = new Float32Array(0), heatL = new Float32Array(0);
let degArr = new Int32Array(0), commArr = new Int32Array(0);
const posById = new Map();

// click-to-isolate: when a node is focused, these hold the survivors; everything else dims.
let focusNodes = null, focusLinks = null;

// "messages delivered" odometer: server gives an authoritative total + rate every 0.5s; we count
// up smoothly between updates (rate × dt) so the number visibly streams instead of jumping.
let msgTotal = 0, msgRate = 0, msgShown = 0, lastMsgT = performance.now();
let perf = { lat: 0, cpu: 0, mem: 0, conns: 0, dm: 0, chan: 0, any: 0 }; // latency + broker stats + per-mode rates

const graph = new Graph(stage, {
  backgroundColor: "#0a0e18", // lifted off harsh black; the #vignette overlay darkens the edges for depth
  spaceSize: 8192,
  pointDefaultColor: "#9aa6b5", linkDefaultColor: "#33405a",
  pointSizeScale: 1.0, scalePointsOnZoom: true, linkWidthScale: 1.0,
  // A real org: channel hubs gather each team into a tight lobe, DM springs bind collaborators,
  // repulsion pushes teams apart so the ~50 lobes separate, gravity holds the whole galaxy centered
  // and compact (so it stays framed). It SETTLES and stops — no drift; the staggered fits below frame
  // it as it expands and onSimulationEnd frames the final extent.
  simulationGravity: 0.045, simulationCenter: 0, simulationRepulsion: 2.8, simulationRepulsionTheta: 1.5,
  simulationLinkSpring: 0.5, simulationLinkDistance: 55, simulationFriction: 0.85, simulationDecay: 6000,
  fitViewOnInit: false,
  onSimulationEnd: () => { if (!userControl && !focusNodes) graph.fitView(700, 0.18, false); settled = true; }, // layout reached its extent → stop auto-framing
  // discovery without UI tax: hover for a tooltip, click a node to isolate it + its edges.
  renderHoveredPointRing: true, hoveredPointRingColor: "#eaf1ff", hoveredPointCursor: "pointer",
  onPointMouseOver: (i) => showTip(i),
  onPointMouseOut: () => hideTip(),
  onPointClick: (i) => setFocus(i),
  onBackgroundClick: () => clearFocus(),
});

function setFocus(i) {
  const nbrs = graph.getNeighboringPointIndices(i) || [];
  focusNodes = new Set([i, ...nbrs]);
  focusLinks = new Set(graph.getConnectedLinkIndices(i) || []);
}
function clearFocus() { if (focusNodes) { focusNodes = null; focusLinks = null; graph.fitView(700, 0.18, false); } }

// auto-frame the galaxy as it assembles & settles — but the MOMENT the viewer touches the view
// (scroll/drag), hand over control PERMANENTLY so we never yank their zoom/pan again. (The earlier
// bug: streaming nodes kept re-enabling auto-fit, so it fought the user's zoom.)
let userControl = false, settled = false;
const takeControl = () => { userControl = true; };
["wheel", "pointerdown"].forEach((ev) => stage.addEventListener(ev, takeControl, { passive: true }));
// Re-frame ONLY while the layout is still settling, and NEVER run physics during the camera move
// (enableSimulation=false). Otherwise framing perpetually re-heats the sim and nothing ever stops.
setInterval(() => { if (!userControl && !focusNodes && !settled) graph.fitView(600, 0.18, false); }, 1500);

// tooltip follows the cursor (robust to whatever event type cosmos hands the callback)
let mx = 0, my = 0;
addEventListener("mousemove", (e) => { mx = e.clientX; my = e.clientY; if (tip.style.opacity === "1") place(); });
function place() { tip.style.left = Math.min(mx + 14, innerWidth - 200) + "px"; tip.style.top = (my + 14) + "px"; }
function showTip(i) {
  const n = nodes[i]; if (!n) return;
  const deg = degArr[i] || 0, c = commArr[i];
  tip.innerHTML = n.kind === "channel"
    ? `<b>${n.label}</b><br>team channel · ${deg} member${deg === 1 ? "" : "s"}`
    : `<b>${n.label}</b><br>${c >= 0 ? "team " + c + " · " : ""}${n.role || "agent"} · ${deg} peer${deg === 1 ? "" : "s"}`;
  tip.style.opacity = "1"; place();
}
function hideTip() { tip.style.opacity = "0"; }

function rebuild() {
  const cur = graph.getPointPositions();
  if (cur && cur.length) for (let i = 0; i < nodes.length && i * 2 + 1 < cur.length; i++) posById.set(nodes[i].id, [cur[2 * i], cur[2 * i + 1]]);
  const N = nodes.length, L = links.length;
  positions = new Float32Array(2 * N); base = new Float32Array(4 * N); baseSize = new Float32Array(N); psize = new Float32Array(N); colors = new Float32Array(4 * N);
  const nh = new Float32Array(N); nh.set(heat.subarray(0, Math.min(heat.length, N))); heat = nh;
  const deg = new Int32Array(N), comm = new Int32Array(N); // degree → size; community → colour
  for (let i = 0; i < L; i++) { deg[links[i][0]]++; deg[links[i][1]]++; }
  degArr = deg; commArr = comm;
  for (let i = 0; i < N; i++) {
    const n = nodes[i]; comm[i] = communityOf(n);
    const p = posById.get(n.id) || [(Math.random() - 0.5) * 1400, (Math.random() - 0.5) * 1400];
    positions[2 * i] = p[0]; positions[2 * i + 1] = p[1];
    const c = baseRGB(n); // colour by role (agents) / cyan (channel hubs)
    const off = status.get(n.id) === "offline", o = 4 * i;
    base[o] = c[0]; base[o + 1] = c[1]; base[o + 2] = c[2]; base[o + 3] = off ? 0.22 : 1;
    baseSize[i] = n.kind === "channel" ? 6 + Math.min(14, Math.sqrt(deg[i]) * 1.3) : 2 + Math.min(7, Math.sqrt(deg[i]) * 1.1);
  }
  linkArr = new Float32Array(2 * L); linkBase = new Float32Array(4 * L); linkCol = new Float32Array(4 * L); linkW = new Float32Array(L); linkKind = new Uint8Array(L);
  const nhl = new Float32Array(L); nhl.set(heatL.subarray(0, Math.min(heatL.length, L))); heatL = nhl;
  for (let i = 0; i < L; i++) {
    const a = links[i][0], b = links[i][1], o = 4 * i; linkArr[2 * i] = a; linkArr[2 * i + 1] = b;
    const isChan = nodes[a].kind === "channel" || nodes[b].kind === "channel";
    const ca = comm[a], cb = comm[b];
    if (isChan) {
      // channel-membership spoke: soft cyan, draws the lobe around its hub
      linkKind[i] = 1; linkBase[o] = 0.30; linkBase[o + 1] = 0.72; linkBase[o + 2] = 0.82; linkBase[o + 3] = 0.13; linkW[i] = 0.6;
    } else if (ca !== cb && ca >= 0 && cb >= 0) {
      // cross-team BRIDGE — the small-world backbone, WARM amber over the cool communities: glows
      // across the dark gaps, instantly legible, and gorgeous against the nebula palette
      linkKind[i] = 2; linkBase[o] = 1.0; linkBase[o + 1] = 0.72; linkBase[o + 2] = 0.34; linkBase[o + 3] = 0.26; linkW[i] = 1.2;
    } else {
      // in-team DM: dim, faded by connectivity so degree-1 stragglers vanish
      const md = Math.min(deg[a], deg[b]); const alpha = md <= 1 ? 0.05 : Math.min(0.26, 0.09 + md * 0.012);
      linkBase[o] = 0.55; linkBase[o + 1] = 0.62; linkBase[o + 2] = 0.85; linkBase[o + 3] = alpha; linkW[i] = md <= 1 ? 0.5 : 0.7;
    }
  }
  graph.setPointPositions(positions); graph.setPointSizes(baseSize); graph.setLinks(linkArr); graph.setLinkWidths(linkW);
  graph.start(0.6); settled = false; // new data → re-layout; allow re-framing until it settles again
}

// render loop — bounded, one color + one size upload per frame
let fps = 0, fa = 0, ft = performance.now();
function frame() {
  if (dirty) { dirty = false; rebuild(); }
  const N = heat.length, L = heatL.length, fa_ = focusNodes;
  for (let i = 0; i < N; i++) {
    heat[i] *= 0.94; const h = heat[i], k = h * 0.9, o = 4 * i;     // linger longer so more lit at once
    colors[o] = base[o] + (1 - base[o]) * k; colors[o + 1] = base[o + 1] + (1 - base[o + 1]) * k;
    colors[o + 2] = base[o + 2] + (1 - base[o + 2]) * k; colors[o + 3] = Math.min(1, base[o + 3] + h * 0.6);
    psize[i] = baseSize[i] * (1 + h * 0.7);                          // talking nodes swell, then relax
    if (fa_ && !fa_.has(i)) { colors[o] *= 0.3; colors[o + 1] *= 0.3; colors[o + 2] *= 0.3; colors[o + 3] = 0.08; }
  }
  for (let i = 0; i < L; i++) {
    heatL[i] *= 0.965; const h = heatL[i], o = 4 * i;              // edges glow ~3× longer → reads alive at 20k density
    linkCol[o] = linkBase[o] + (1 - linkBase[o]) * h; linkCol[o + 1] = linkBase[o + 1] + (1 - linkBase[o + 1]) * h;
    linkCol[o + 2] = linkBase[o + 2] + (1 - linkBase[o + 2]) * h;
    linkCol[o + 3] = Math.min(0.95, linkBase[o + 3] + h * (linkKind[i] === 1 ? 0.85 : 0.75));
    if (focusLinks) linkCol[o + 3] = focusLinks.has(i) ? Math.min(0.95, 0.5 + h * 0.5) : 0.02;
  }
  if (N) { graph.setPointColors(colors); graph.setPointSizes(psize); }
  if (L) graph.setLinkColors(linkCol);
  graph.render();
  // smooth message odometer
  const now = performance.now(), dt = (now - lastMsgT) / 1000; lastMsgT = now;
  msgShown = Math.max(msgShown + msgRate * dt, msgShown);
  if (msgShown < msgTotal) msgShown = Math.min(msgTotal, msgShown + (msgTotal - msgShown) * 0.2);
  fa++;
  if (now - ft >= 250) { fps = Math.round((fa * 1000) / (now - ft)); fa = 0; ft = now; hud(); }
  requestAnimationFrame(frame);
}
function hud() {
  document.getElementById("nodes").textContent = nodes.reduce((a, n) => a + (n.kind === "agent" ? 1 : 0), 0).toLocaleString();
  document.getElementById("links").textContent = links.length.toLocaleString();
  document.getElementById("fps").textContent = fps;
  document.getElementById("msgs").textContent = Math.floor(msgShown).toLocaleString();
  document.getElementById("rate").textContent = msgRate.toLocaleString();
  document.getElementById("lat").textContent = perf.lat < 10 ? perf.lat.toFixed(2) : Math.round(perf.lat);
  document.getElementById("dm").textContent = perf.dm.toLocaleString();
  document.getElementById("chan").textContent = perf.chan.toLocaleString();
  document.getElementById("any").textContent = perf.any.toLocaleString();
  document.getElementById("bcpu").textContent = perf.cpu;
  document.getElementById("bmem").textContent = perf.mem.toLocaleString();
  document.getElementById("bconn").textContent = perf.conns.toLocaleString();
}

// SSE
const es = new EventSource("/feed");
// snapshot is re-sent on every SSE reconnect — addNode/addLink/setStat dedup, so a reconnect that
// changes nothing leaves dirty=false and triggers NO rebuild (the old unconditional dirty=true here
// re-built the whole 20k/123k graph on each reconnect → multi-second freeze → missed SSE → reconnect loop).
es.addEventListener("snapshot", (e) => { const d = JSON.parse(e.data); for (const n of d.nodes) addNode(n); for (const l of d.links) addLink(l[0], l[1]); for (const [id, s] of Object.entries(d.status || {})) setStat(id, s); });
es.addEventListener("nodes", (e) => { for (const n of JSON.parse(e.data)) addNode(n); });
es.addEventListener("links", (e) => { for (const l of JSON.parse(e.data)) addLink(l[0], l[1]); });
es.addEventListener("status", (e) => { for (const [id, s] of Object.entries(JSON.parse(e.data))) setStat(id, s); });
es.addEventListener("act", (e) => { const d = JSON.parse(e.data); for (const i of d.p) if (i < heat.length) heat[i] = 1; for (const i of d.l) if (i < heatL.length) heatL[i] = 1; });
es.addEventListener("meta", (e) => { const d = JSON.parse(e.data); if (d.msgs >= msgTotal) msgTotal = d.msgs; msgRate = d.rate; if (msgShown === 0) msgShown = d.msgs; perf = { lat: d.lat ?? 0, cpu: d.cpu ?? 0, mem: d.mem ?? 0, conns: d.conns ?? 0, dm: d.dm ?? 0, chan: d.chan ?? 0, any: d.any ?? 0 }; });

addEventListener("resize", () => graph.render());
// press "h" to hide all chrome (HUD/legend/title) for a clean hero capture
addEventListener("keydown", (e) => { if (e.key === "h" || e.key === "H") document.body.classList.toggle("chrome-off"); });
requestAnimationFrame(frame);
