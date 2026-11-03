/** Drives the built browser helpers and the shipped render functions. No broker or pixel claims.
 * Run: pnpm smoke:web-presence-ages. Browser layout is checked separately against PAGE routes. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { formatAge } from "@cotal-ai/core/presence-ages";
import { PAGE } from "../dist/web.js";

const helper = await import(new URL("../dist/web/presence.js", import.meta.url).href);
const now = 1_800_000_000_000;
let cells = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected, name);
  cells++;
}
const read = (route: string) => readFileSync(PAGE[route]!.path, "utf8");
eq("served formatter is the canonical core module, byte for byte", read("/presence-ages.js"),
  readFileSync(fileURLToPath(import.meta.resolve("@cotal-ai/core/presence-ages")), "utf8"));
for (const [ms, text] of [[0, "0s"], [999, "0s"], [1000, "1s"], [44999, "44s"],
  [59999, "59s"], [60000, "1m"], [90000, "1m"], [119999, "1m"], [120000, "2m"],
  [3599999, "59m"], [3600000, "1h"], [7199999, "1h"], [86399999, "23h"],
  [86400000, "1d"], [172799999, "1d"], [172800000, "2d"]] as const) {
  eq(`canonical boundary ${ms}`, helper.ago(now - ms, now), text);
  eq(`browser/core agreement ${ms}`, helper.ago(now - ms, now), formatAge(ms));
}
for (const stamp of [undefined, null, NaN, Infinity, -Infinity, "12"])
  eq(`invalid timestamp ${String(stamp)}`, helper.ago(stamp, now), "unknown");
eq("future heartbeat clamps", helper.ago(now + 1000, now), "0s");
eq("missing presence ages omitted", helper.presenceFacts({}, now), "");
eq("cleared activity does not keep its old age", helper.presenceFacts({ activity: "", activitySince: now - 1000 }, now), "");
eq("condition with unknown stamp stays undated", helper.presenceFacts({ condition: { code: "rate_limit", since: null } }, now), "rate_limit");
eq("future facts clamp", helper.presenceFacts({ activity: "work", condition: { code: "rate_limit", since: now + 1 }, statusSince: now + 1, activitySince: now + 1, activeAt: now + 1 }, now),
  "rate_limit for 0s · unchanged for 0s · active 0s ago · activity set 0s ago");

// Parse and execute the actual functions, including their projection into sidebar/graph rows.
// Dependencies outside rendering (DOM, graph physics, badges) are narrow fixtures.
function functions(route: string, names: string[]) {
  const source = read(route);
  const ast = ts.createSourceFile(route, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text))
      found.set(node.name.text, node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const name of names) assert.ok(found.has(name), `${route} must define ${name}`);
  return [...found.values()].join("\n");
}
const row = {
  card: { id: "fixture.peer", name: "AgeProbe", kind: "agent", role: "worker" },
  status: "waiting", ts: now - 90000, activity: "Waiting for quota reset",
  condition: { code: "rate_limit", since: now - 2400000 },
  statusSince: now - 2400000, activitySince: now - 1800000, activeAt: now - 2400000,
};
const elements = new Map<string, { innerHTML: string; classList: { add(): void; remove(): void } }>();
const ctx = createContext({
  roster: [row], agentSel: row.card.id, STATUS: ["working", "waiting", "idle", "offline"],
  GLYPH: { waiting: "◐", working: "●" },
  ago: (stamp: unknown) => helper.ago(stamp, now),
  presenceFacts: (p: unknown) => helper.presenceFacts(p, now),
  harnessBadge: () => "", attentionChip: () => "", attMark: () => "", recentRows: () => "",
  $: (id: string) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", classList: { add() {}, remove() {} } });
    return elements.get(id);
  },
  agents: new Map(), edges: new Map(), dms: new Map(), sel: null,
  ensureAgent: (card: Record<string, unknown>) => {
    const agents = ctx.agents as Map<string, Record<string, unknown>>;
    const id = card.id as string;
    if (!agents.has(id)) agents.set(id, { ...card, kind: "agent" });
    return agents.get(id);
  },
  reheat: () => {}, closeDetail: () => {},
});
ctx.window = ctx;
runInContext(read("/parts.js"), ctx);
runInContext("const esc = window.COTAL_PARTS.esc;", ctx);
runInContext(functions("/app.js", ["rosterRows", "peerRow", "waitingCards", "cardHTML", "renderAgentDetail"]), ctx);
runInContext(functions("/graph.js", ["updateRoster", "renderDetail"]), ctx);
function render() {
  const roster = runInContext("rosterRows().map(peerRow).join('')", ctx) as string;
  const waiting = runInContext("waitingCards().map(cardHTML).join('')", ctx) as string;
  runInContext("renderAgentDetail(); updateRoster(roster); sel = agents.get(agentSel); renderDetail();", ctx);
  return { roster, waiting, detail: elements.get("center")!.innerHTML, graph: elements.get("detail")!.innerHTML };
}
const shown = render();
for (const [surface, html] of Object.entries(shown)) {
  for (const fact of ["rate_limit for 40m", "unchanged for 40m", "active 40m ago", "activity set 30m ago"])
    eq(`${surface} shows ${fact}`, html.includes(fact), true);
  eq(`${surface} uses the wrapping fact class`, html.includes('class="presence-facts"'), true);
}
eq("waiting heartbeat floors rather than rounding", shown.waiting.includes("seen 1m"), true);
eq("detail heartbeat floors rather than rounding", shown.detail.includes("heartbeat 1m ago"), true);
row.condition.code = '<img src=x onerror="alert(1)">';
for (const [surface, html] of Object.entries(render())) {
  eq(`${surface} escapes condition text`, html.includes("&lt;img"), true);
  eq(`${surface} never inserts raw condition markup`, html.includes("<img"), false);
}
ctx.roster = [{ card: row.card, status: "waiting", ts: now - 90000 }];
for (const [surface, html] of Object.entries(render()))
  eq(`${surface} clears missing facts, including the previously dated graph row`, html.includes('class="presence-facts"'), false);
ctx.roster = [{ ...row, status: "working" }];
eq("working peer leaves waiting rail", runInContext("waitingCards().length", ctx), 0);
for (const [page, consumer] of [["/", "/app.js"], ["/graph", "/graph.js"]]) {
  eq(`${page} loads its consumer as a native module`, read(page!).includes(`<script type="module" src="${consumer}"></script>`), true);
  eq(`${consumer} imports the served shared helper`, read(consumer!).includes('from "./presence.js"'), true);
  eq(`${page} wraps facts rather than using ellipsis`, /\.presence-facts\s*\{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere/s.test(read(page!)), true);
}
eq("helper imports the served canonical module", read("/presence.js").includes('from "./presence-ages.js"'), true);
assert.equal(cells, 86, "the suite must execute every named check");
console.log(`web presence ages: ${cells}/${cells} checks passed`);
