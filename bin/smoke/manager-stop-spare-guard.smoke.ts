/**
 * After #964, a plain `Manager.stop()` detaches managed seats. A smoke that spawns a real
 * PTY child and then spare-stops leaks that child unless something else reaps it.
 *
 * This guard reddens a live-PTY smoke teardown that still calls `.stop()` without
 * `{ withAgents: true }`. Suites that ASSERT the spare path are named below; they are
 * the coverage, not the leak. A planted fixture proves the search can still see the
 * banned form: a grep that finds nothing and a grep that cannot find anything print
 * the same zero.
 *
 * livePty() inclusion (disclosed, measured at 7b88fb3bfe82b3642037d885df03fc8b50573f37):
 * a file is EXAMINED only when it has a literal `new Manager(` plus one of seven spawn
 * shapes (`.startAgent(`, `spawnSeat(`, `cmd("spawn")`, `spawnTool.run(`, `MeshHandler`,
 * `.startByName(`, `invokeService("manager", "spawn"`), is not `kind: "fake"`, and has
 * `runtime: "pty"` or `pty.spawn(`. That admitted 26 of 74 `new Manager(` smokes and
 * skipped 32 live-PTY files, 29 of which carry the banned spare-stop form. The spawn-shape
 * gate is kept; silence is not. Every skipped live-PTY file that still carries a candidate
 * stop is named in the suite output AND must appear on the frozen #1343 inventory below.
 * A new skipped candidate-stop path reds. A stale inventory path reds so the list can only
 * shrink. Truncating the examined set below the measured floor reds. The receiver-name list
 * below is a separate, disclosed boundary (#1310).
 *
 * Run: pnpm smoke:manager-stop-spare-guard
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SELF = "bin/smoke/manager-stop-spare-guard.smoke.ts";
const SKIP = new Set(["node_modules", "dist", ".git", ".changeset", "coverage", "build", ".internal"]);
const DEREGISTER = "implementations/manager/smoke/manager-deregister.smoke.ts";
/** Measured examined live-PTY population at 7b88fb3b. A later shrink of this set reds. */
const EXAMINED_FLOOR = 26;
/** Measured `new Manager(` population at 7b88fb3b. A later walk truncation reds. */
const NEW_MANAGER_FLOOR = 74;

/** Suites whose job is to prove the spare path. Each is named, not found by silence. */
const SPARE_COVERAGE = new Set([
  "bin/smoke/manager-stop-reaps-agents.smoke.ts",
  "implementations/manager/smoke/start-model-preflight.smoke.ts",
  "implementations/manager/smoke/preserve-state.smoke.ts",
  "implementations/manager/smoke/lease-loss-keeps-serving.smoke.ts",
]);

/**
 * Tracked deferral of skipped live-PTY files that still carry a candidate spare-stop.
 * Owned by issue #1343. These are not SPARE_COVERAGE and are not safe: livePty() never
 * examines them, so a spare-stop there stays green unless this inventory notices growth.
 * Do not add new paths here. Audit the file, admit it through the spawn-shape gate, or
 * change its teardown to `{ withAgents: true }` and delete the stale entry.
 */
const FROZEN_DROPPED = [
  "bin/smoke/manager-two-root-renewal.smoke.ts",
  "bin/smoke/persona-announce.smoke.ts",
  "bin/smoke/readiness-window-live.smoke.ts",
  "bin/smoke/run-host-live.smoke.ts",
  "bin/smoke/spawn-detach-live.smoke.ts",
  "extensions/connector-hermes/smoke/boot-requirement.smoke.ts",
  "implementations/cli/smoke/scatter-pinned-probe.smoke.ts",
  "implementations/manager/smoke/boot-self-heal-gate.smoke.ts",
  "implementations/manager/smoke/cli-on-instance-live.smoke.ts",
  "implementations/manager/smoke/describe-split-duplicate-effect.smoke.ts",
  "implementations/manager/smoke/goal-sibling-race.smoke.ts",
  "implementations/manager/smoke/instrument-instance-pin.smoke.ts",
  "implementations/manager/smoke/manager-coexist.smoke.ts",
  "implementations/manager/smoke/manager-deregister.smoke.ts",
  "implementations/manager/smoke/manager-on-route.smoke.ts",
  "implementations/manager/smoke/manager-restart-fence.smoke.ts",
  "implementations/manager/smoke/manager-restart-live.smoke.ts",
  "implementations/manager/smoke/manager-scatter.smoke.ts",
  "implementations/manager/smoke/manager-service-invoke.smoke.ts",
  "implementations/manager/smoke/manager-service-ops.smoke.ts",
  "implementations/manager/smoke/manager-service.smoke.ts",
  "implementations/manager/smoke/queue-win-distribution.smoke.ts",
  "implementations/manager/smoke/resolve-rtt-probe.smoke.ts",
  "implementations/manager/smoke/seat-input-live.smoke.ts",
  "implementations/manager/smoke/session-ledger-family.smoke.ts",
  "implementations/manager/smoke/sibling-mint-fence.smoke.ts",
  "implementations/manager/smoke/spawn-action-auth.smoke.ts",
  "implementations/manager/smoke/spawn-action.smoke.ts",
  "implementations/manager/smoke/turn-relay-auth.smoke.ts",
] as const;

let pass = 0, fail = 0;
const check = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};

function smokeSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) smokeSources(p, out);
    else if (p.endsWith(".ts") && /(^|\/)smoke\//.test(relative(ROOT, p)) && !relative(ROOT, p).startsWith("bin/smoke/fixtures/") && relative(ROOT, p) !== SELF) out.push(p);
  }
  return out;
}

/** A Manager.stop / mgr.stop / m1?.stop call whose argument list does not pass withAgents: true.
 *  Identifier class is the manager-shaped names smokes actually use. delivery/broker/ep stops
 *  are not this hazard. Conventional names only: `supervisor`, `boss`, `managerB`, `mBoot`, and
 *  a destructured or helper-returned handle are outside this regex. */
const SPARE_STOP = /(?:await\s+)?(?:manager|mgr|mgr[0-9A-Z]|m[0-9]|adopting|openMgr|hung|first|next|live|corpse|booting|replacement)\??\.stop\(\s*(?:\{\s*(?!.*withAgents\s*:\s*true)[^}]*\}\s*)?\)/g;

const SPAWN_SHAPES = [
  /\.startAgent\s*\(/,
  /\bspawnSeat\s*\(/,
  /cmd\(\s*"spawn"\s*\)/,
  /\bspawnTool\.run\s*\(/,
  /\bMeshHandler\b/,
  /\.startByName\s*\(/,
  /invokeService\(\s*"manager"\s*,\s*"spawn"/,
] as const;

function hasNewManager(text: string): boolean {
  return /\bnew\s+Manager\s*\(/.test(text);
}
function hasEnumeratedSpawn(text: string): boolean {
  return SPAWN_SHAPES.some((re) => re.test(text));
}
function isFakeKind(text: string): boolean {
  return /\bkind:\s*"fake"/.test(text);
}
function hasLivePtyRuntime(text: string): boolean {
  return /\bruntime:\s*"pty"/.test(text) || /\bpty\.spawn\s*\(/.test(text);
}
function livePty(text: string): boolean {
  return hasNewManager(text) && hasEnumeratedSpawn(text) && !isFakeKind(text) && hasLivePtyRuntime(text);
}
function livePtySkippedBySpawnShape(text: string): boolean {
  return hasNewManager(text) && hasLivePtyRuntime(text) && !isFakeKind(text) && !hasEnumeratedSpawn(text);
}

function spareStops(text: string): string[] {
  return [...text.matchAll(SPARE_STOP)].map((m) => m[0].replace(/\s+/g, " ").trim());
}

const files = smokeSources(ROOT);
check("the walk finds a non-trivial population of smoke sources", files.length >= 50, `found ${files.length}`);

const planted = join(ROOT, "bin", "smoke", "fixtures", "manager-stop-spare.planted.ts");
const plantedText = readFileSync(planted, "utf8");
check("the planted control looks like a live-PTY Manager smoke", livePty(plantedText), plantedText.slice(0, 120));
check("the planted control carries a spare stop and the regex sees it", spareStops(plantedText).length > 0, spareStops(plantedText));

const hits: string[] = [];
const examined: string[] = [];
const newManagerFiles: string[] = [];
const droppedWithStop: string[] = [];
for (const f of files) {
  const rel = relative(ROOT, f);
  const text = readFileSync(f, "utf8");
  if (hasNewManager(text)) newManagerFiles.push(rel);
  if (livePty(text)) examined.push(rel);
  if (livePtySkippedBySpawnShape(text) && spareStops(text).length && !SPARE_COVERAGE.has(rel)) {
    droppedWithStop.push(`${rel}: ${spareStops(text).join(" | ")}`);
  }
  if (SPARE_COVERAGE.has(rel)) continue;
  if (!livePty(text)) continue;
  const found = spareStops(text);
  if (found.length) hits.push(`${rel}: ${found.join(" | ")}`);
}

const droppedPaths = droppedWithStop.map((row) => {
  const cut = row.indexOf(": ");
  return cut < 0 ? row : row.slice(0, cut);
});
const droppedPathSet = new Set(droppedPaths);
const frozenSet = new Set<string>(FROZEN_DROPPED);
const newDropped = droppedPaths.filter((p) => !frozenSet.has(p));
const staleFrozen = FROZEN_DROPPED.filter((p) => !droppedPathSet.has(p));
const frozenOnSpare = FROZEN_DROPPED.filter((p) => SPARE_COVERAGE.has(p));

console.log(`examined live-PTY Manager smokes: ${examined.length} of ${newManagerFiles.length} new Manager( files (floor ${EXAMINED_FLOOR})`);
console.log(`dropped-with-candidate-stop (live PTY, not fake, spawn-shape miss): ${droppedWithStop.length}`);
for (const row of droppedWithStop) console.log(`  skip ${row}`);

check(
  `the walk still sees at least ${NEW_MANAGER_FLOOR} smokes that construct new Manager(`,
  newManagerFiles.length >= NEW_MANAGER_FLOOR,
  `found ${newManagerFiles.length}`,
);
check(
  `examined live-PTY Manager smokes stay at or above the measured floor (${EXAMINED_FLOOR})`,
  examined.length >= EXAMINED_FLOOR,
  `examined ${examined.length}`,
);
check(`no live-PTY smoke spare-stops a Manager (${examined.length} files examined)`, hits.length === 0, hits);
check(
  "frozen #1343 dropped inventory is not SPARE_COVERAGE and is not a safe list",
  frozenOnSpare.length === 0,
  frozenOnSpare,
);
check(
  "a new dropped-with-candidate-stop path is not on the frozen #1343 inventory",
  newDropped.length === 0,
  newDropped,
);
check(
  "frozen #1343 dropped inventory has no stale paths",
  staleFrozen.length === 0,
  staleFrozen,
);

const deregPath = join(ROOT, DEREGISTER);
const deregText = readFileSync(deregPath, "utf8");
const deregDropped = droppedWithStop.some((row) => row.startsWith(`${DEREGISTER}:`));
check("manager-deregister is present in the walk", files.some((f) => relative(ROOT, f) === DEREGISTER), DEREGISTER);
check("manager-deregister constructs a live-PTY Manager (not kind fake)", hasNewManager(deregText) && hasLivePtyRuntime(deregText) && !isFakeKind(deregText), DEREGISTER);
check("manager-deregister carries a banned spare-stop form", spareStops(deregText).length > 0, spareStops(deregText));
check("manager-deregister is not hidden on SPARE_COVERAGE", !SPARE_COVERAGE.has(DEREGISTER), DEREGISTER);
check(
  "manager-deregister is examined or named as a dropped-with-candidate-stop exclusion",
  livePty(deregText) || deregDropped,
  { livePty: livePty(deregText), named: deregDropped, stops: spareStops(deregText) },
);

for (const named of SPARE_COVERAGE) {
  check(`spare-coverage suite is present: ${named}`, files.some((f) => relative(ROOT, f) === named), named);
}

console.log(`\nMANAGER-STOP-SPARE-GUARD ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
