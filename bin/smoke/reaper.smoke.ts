/**
 * The leaked-broker reaper: it must kill a broker whose OWNER IS DEAD, and must not touch anything
 * else, including a broker that carries the token but whose owner is still running.
 *
 * THE NEGATIVE CONTROLS ARE THE POINT OF THIS SUITE, and there are two of them because there are two
 * ways to kill too much. A reaper that kills too much is worse than no reaper: it would take out a
 * developer's real mesh, or another lane's live broker, while reporting success.
 *
 *   1. UNTOKENED, OWNER IRRELEVANT. A broker nobody minted through the kit is never ours to claim.
 *   2. TOKENED, OWNER ALIVE. This is the one that matters and the one an earlier version of this
 *      file did not cover. Marking the broker was never enough: the token says which suite minted
 *      the tree, not that the suite is finished with it. Two lanes run smokes on a shared box
 *      constantly, and a prefix-only reaper was reproduced listing a live lane's broker for the kill.
 *      The untokened control could not have caught it, because the victim is tokened. Only the
 *      owner's liveness separates them.
 *
 * The positive control therefore has to produce a genuinely orphaned broker rather than a fixture:
 * a child process mints the dir under its own pid, spawns the broker, and is SIGKILLed, which is the
 * exact case the teardown helper cannot cover and the only case the reaper may act on.
 */
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_PREFIX as KIT_PREFIX, SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { SMOKE_BROKER_PREFIX, listNatsServers, reapSmokeBrokers } from "./reap-smoke-brokers.mjs";
// The whole namespace as well, because the declaration is checked against the module's ACTUAL
// export set and a named import list would only ever confirm the names already written here.
import * as reaper from "./reap-smoke-brokers.mjs";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}${detail ? ` (${detail})` : ""}`); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> => new Promise((res, rej) => {
  const s = createServer();
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

console.log("\n── smoke broker reaper ─────────────────────────\n");

// The reaper duplicates the prefix as a literal because it runs from the CI runner before any
// workspace build. That duplication is only safe if it cannot drift, which is what this asserts.
check("the reaper's prefix literal is the one the kit mints", SMOKE_BROKER_PREFIX === KIT_PREFIX, `${SMOKE_BROKER_PREFIX} vs ${KIT_PREFIX}`);
// And the minted token must actually carry this process's pid, or the owner check has nothing to read.
check("the kit's token stamps the owning pid into the dir name", SMOKE_BROKER_TOKEN === `${KIT_PREFIX}${process.pid}-`, SMOKE_BROKER_TOKEN);

// ── the declaration file is a second source of truth, so check it against the module ──────────
//
// `reap-smoke-brokers.mjs` stays plain JavaScript because it runs on the CI runner before any
// workspace build, so its types live in a hand written `reap-smoke-brokers.d.mts` beside it. A
// declaration file is BELIEVED, never checked: rename an export, add a required parameter, or drop
// a field from `ReapReport` and the declaration keeps compiling, this suite keeps passing, and the
// mismatch surfaces only at runtime in the one job whose purpose is to clean up after other jobs.
// The typecheck gate cannot close this; only reading the declaration back and comparing it to the
// live module can.
//
// The declaration is PARSED rather than transcribed. A hand copied list of expected names here
// would be a THIRD source of truth, free to agree with neither file.
const declText = readFileSync(new URL("./reap-smoke-brokers.d.mts", import.meta.url), "utf8");
// Comments first: `ReapReport` documents one of its fields inline, and prose is full of words that
// look like field names.
const declBody = declText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const declaredValues = [...declBody.matchAll(/export\s+declare\s+const\s+(\w+)/g)].map((m) => m[1]);
const declaredFns = [...declBody.matchAll(/export\s+declare\s+function\s+(\w+)\s*\(([^]*?)\)\s*:/g)]
  .map((m) => ({ name: m[1], params: m[2] }));
const reportFields = (() => {
  const m = /export\s+interface\s+ReapReport\s*\{([^]*?)\n\}/.exec(declBody);
  if (!m) return [];
  return [...m[1].matchAll(/^\s*(\w+)\s*\??\s*:/gm)].map((f) => f[1]);
})();

// THE PARSER IS AN INSTRUMENT, so prove it read something before trusting what it did not find.
// An expression that silently yields nothing passes every set comparison below.
check("the declaration parser found the declared value exports", declaredValues.length > 0, `${declaredValues.length}`);
check("the declaration parser found the declared function exports", declaredFns.length > 0, `${declaredFns.length}`);
check("the declaration parser found ReapReport's fields", reportFields.length > 0, `${reportFields.length}`);

const declaredNames = [...declaredValues, ...declaredFns.map((f) => f.name)].sort();
const actualNames = Object.keys(reaper).sort();
check("every name the declaration exports exists on the module", declaredNames.every((n) => actualNames.includes(n)), `missing: ${declaredNames.filter((n) => !actualNames.includes(n)).join(", ") || "none"}`);
check("the module exports nothing the declaration omits", actualNames.every((n) => declaredNames.includes(n)), `undeclared: ${actualNames.filter((n) => !declaredNames.includes(n)).join(", ") || "none"}`);

// Arity is compared on REQUIRED parameters, because that is what `Function.length` counts: a
// parameter with a default is not in it. `reapSmokeBrokers({ dryRun = false } = {})` therefore has
// length 0 and its declaration `(opts?: { dryRun?: boolean })` has zero required parameters, which
// agree. Adding a required parameter on either side breaks that agreement, which is the drift worth
// catching.
const requiredParams = (params: string): number => {
  let depth = 0, current = "", n = 0;
  const finish = () => { const t = current.trim(); if (t && !/^\w+\s*\?/.test(t) && !t.includes("=")) n++; current = ""; };
  for (const ch of params) {
    if ("({[<".includes(ch)) depth++;
    else if (")}]>".includes(ch)) depth--;
    if (ch === "," && depth === 0) { finish(); continue; }
    current += ch;
  }
  finish();
  return n;
};
for (const fn of declaredFns) {
  const live = (reaper as unknown as Record<string, unknown>)[fn.name];
  const want = requiredParams(fn.params);
  check(`${fn.name} takes the number of required parameters the declaration gives it`, typeof live === "function" && (live as (...a: unknown[]) => unknown).length === want, `declared ${want}, module ${typeof live === "function" ? (live as (...a: unknown[]) => unknown).length : "not a function"}`);
}

// And the report shape, from a REAL call rather than a literal written here. `dryRun` reads the
// process table and signals nothing, so this is safe to run before the scenario builds its brokers.
const shape = Object.keys(reapSmokeBrokers({ dryRun: true })).sort();
check("a real ReapReport carries every field the declaration gives it", reportFields.every((f) => shape.includes(f)), `missing: ${reportFields.filter((f) => !shape.includes(f)).join(", ") || "none"}`);
check("a real ReapReport carries no field the declaration omits", shape.every((f) => reportFields.includes(f)), `undeclared: ${shape.filter((f) => !reportFields.includes(f)).join(", ") || "none"}`);

const dirs: string[] = [];
const kids: ChildProcess[] = [];
const releases: Array<() => void> = [];
const startBroker = async (prefix: string): Promise<ChildProcess> => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  const port = await freePort();
  writeFileSync(join(dir, "server.conf"), `port: ${port}\njetstream { store_dir: "${join(dir, "js")}" }\n`);
  const child = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  kids.push(child);
  releases.push(teardownOnSignal(child, dir));
  return child;
};

let ownerPid: number | undefined, orphanPid: number | undefined, orphanDir: string | undefined;
let owner: ChildProcess | undefined;
try {
  // (1) A broker this process owns and is still using. Tokened, owner alive: must survive.
  const ownedLive = await startBroker(SMOKE_BROKER_TOKEN);
  // (2) A broker nobody minted through the kit: must survive for a different reason.
  const untokened = await startBroker("cotal-reaper-control-");
  // (3) A genuine orphan: a child mints under ITS pid, spawns a broker, then is SIGKILLed.
  // `.bin/tsx` is a shell wrapper, not a JS file, so it is EXECUTED, never passed to node.
  const tsx = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsx");
  owner = spawn(tsx, [join(import.meta.dirname, "fixtures", "reaper-owner-child.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  owner.stdout!.on("data", (b: Buffer) => { out += b.toString(); });
  owner.stderr!.on("data", (b: Buffer) => { out += b.toString(); });
  for (let i = 0; i < 120 && !out.includes("brokerPid"); i++) await wait(250);
  const parsed = /\{"ownerPid".*\}/.exec(out);
  check("the owner fixture reported its pids", parsed !== null, out.slice(-300));
  if (!parsed) throw new Error("owner fixture never reported");
  ({ ownerPid, brokerPid: orphanPid, dir: orphanDir } = JSON.parse(parsed[0]) as { ownerPid: number; brokerPid: number; dir: string });
  if (orphanDir) dirs.push(orphanDir);

  await wait(800);
  check("all three fixture brokers are running before the reaper", alive(ownedLive.pid!) && alive(untokened.pid!) && alive(orphanPid!));

  const listed = listNatsServers();
  check("the enumerator is supported on this platform", listed !== undefined);
  const pids = (listed ?? []).map((r) => r.pid);
  check("the enumerator sees all three", pids.includes(ownedLive.pid!) && pids.includes(untokened.pid!) && pids.includes(orphanPid!));

  // Kill the OWNER only. Its broker is a plain child, so it survives and is reparented: a real orphan.
  process.kill(ownerPid!, "SIGKILL");
  for (let i = 0; i < 40 && alive(ownerPid!); i++) await wait(100);
  check("the orphan's owner is dead", !alive(ownerPid!), `owner ${ownerPid}`);
  check("the orphan's broker outlived its owner, which is what makes it an orphan", alive(orphanPid!), `broker ${orphanPid}`);

  const result = reapSmokeBrokers();
  await wait(500);

  check("the reaper reports the platform as supported", result.supported);
  check("POSITIVE CONTROL: the broker whose owner is DEAD is killed", !alive(orphanPid!), `pid ${orphanPid} survived`);
  check("NEGATIVE CONTROL: a tokened broker whose owner is ALIVE is untouched", alive(ownedLive.pid!), `pid ${ownedLive.pid} was killed`);
  check("NEGATIVE CONTROL: the untokened broker is untouched", alive(untokened.pid!), `pid ${untokened.pid} was killed`);
  check("the killed broker is named in the report, not just counted", result.reaped.some((r) => r.pid === orphanPid));
  check("the report names the dead owner it acted on", result.reaped.some((r) => r.owner === ownerPid), JSON.stringify(result.reaped.map((r) => r.owner)));
  check("neither survivor is named as reaped", !result.reaped.some((r) => r.pid === ownedLive.pid || r.pid === untokened.pid));
  // The counts are what keep a quiet run honest: "0 reaped" reads the same on a clean box and on a
  // box where every candidate was declined, so the declines are reported rather than implied.
  check("the live-owner broker is counted as owned, not silently skipped", result.ownedLive >= 1, `ownedLive=${result.ownedLive}`);
  check("the report counts what it deliberately did not claim", result.unclaimable >= 2, `unclaimable=${result.unclaimable}`);
  check("the report counts everything it inspected", result.inspected >= 3, `inspected=${result.inspected}`);

  // Running again with the orphan already gone must be a clean no-op: the reaper runs after every
  // suite in the chain, so the quiet path is the common one.
  const second = reapSmokeBrokers();
  check("a second run reaps nothing and does not throw", second.reaped.every((r) => r.pid !== orphanPid));
  check("both survivors are still alive after the second run", alive(ownedLive.pid!) && alive(untokened.pid!));
} catch (e) {
  fail++;
  console.log(`  ✗ FAIL: scenario threw: ${(e as Error).message}`);
} finally {
  if (ownerPid !== undefined && alive(ownerPid)) { try { process.kill(ownerPid, "SIGKILL"); } catch { /* gone */ } }
  if (orphanPid !== undefined && alive(orphanPid)) { try { process.kill(orphanPid, "SIGKILL"); } catch { /* gone */ } }
  if (owner) await killAndAwaitExit(owner, "SIGKILL");
  for (const k of kids) await killAndAwaitExit(k, "SIGKILL");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const r of releases) r();
}

console.log(`\n${pass} passed, ${fail} failed  (${pass + fail} cells ran)\n`);
process.exit(fail > 0 ? 1 : 0);
