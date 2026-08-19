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
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SMOKE_BROKER_PREFIX as KIT_PREFIX, SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { SMOKE_BROKER_PREFIX, listNatsServers, reapSmokeBrokers } from "./reap-smoke-brokers.mjs";
import { DECLARATION_PATH, MODULE_PATH, checkDeclarationConsumer, readCommittedDeclaration, renderReaperDeclaration, transpileConsumer } from "./gen-reaper-dts.mjs";

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

// ── the declaration beside the module is emitted from it, so it cannot describe a different one ──
//
// `reap-smoke-brokers.mjs` stays plain JavaScript because it runs on the CI runner before any
// workspace build, so its `.ts` consumers need a declaration beside it. A hand written declaration
// is a SECOND source of truth, and a guard that reads one is an enumeration of the shapes whoever
// wrote it thought of. This suite shipped two such guards and both failed GREEN over real drift: a
// regex version scored `(cb: () => void, n: number)` as zero required parameters and called an arity
// mismatch agreement, and the AST version that replaced it walked variable statements and function
// declarations only, so `export { X as Y }`, `export default`, a namespace and a declaration merge
// landed in neither the parse NOR `Object.keys(module)` and agreed by both being absent. Neither
// version compared a single TYPE, so a `pid` that became a string was agreement too.
//
// So the declaration is no longer written by hand and there is nothing left to recognise. It is
// emitted from the module by the compiler, and this asserts the committed file is exactly what the
// compiler emits today. Any change to the module that the declaration does not follow changes these
// bytes, whatever kind of change it is: a renamed export, a parameter added after a defaulted one, a
// re-export under an alias, a default export, a merged namespace, a field whose type moved. The
// generator refuses to emit over a type error, so `// @ts-check` in the module makes its own JSDoc
// part of what this cell defends.
const committed = readCommittedDeclaration();
// A module that no longer typechecks has no declaration to compare, and that is a RED rather than a
// crash: the generator refuses to emit over a type error, and this cell is where that refusal is
// read. Throwing here would end the run before the banner, which grades INCONCLUSIVE instead.
let emitted: string | undefined;
let emitError = "";
try { emitted = renderReaperDeclaration(); } catch (e) { emitError = (e as Error).message; }
check(
  "the committed declaration is what the compiler emits from the module",
  emitted !== undefined && emitted === committed,
  emitted === undefined
    ? emitError
    : committed === undefined
      ? `${DECLARATION_PATH} is missing; run \`pnpm gen:reaper-dts\``
      : `run \`pnpm gen:reaper-dts\`; first difference at byte ${[...emitted].findIndex((c, i) => committed[i] !== c)}`,
);

// That cell defends the module's JSDoc only while the module is CHECKED, and the generator's options
// set `allowJs` and never `checkJs`, so the whole type path hangs on the module opting in. This
// suite read `// @ts-check` off the top of the file for that, and a read of one spelling is an
// enumeration of one, which is the same mistake as the two guards above. Measured on this tree: put
// `// @ts-nocheck` on line 2 and drift `pid` to a string, and `pnpm gen:reaper-dts` stops refusing
// (exit 0, the same 4722 bytes, because those types are read from the JSDoc the compiler is no
// longer reading), the cell above goes GREEN, and the pragma read goes GREEN too, because the file
// does still open with `// @ts-check`. Only two live-pid behavioural cells red, and a drift with no
// runtime signature would have had nothing red at all.
//
// So the property is checked instead of the spelling: a deliberate type error is put into the
// module's text and the emit must REFUSE it. That refusal exists only while the JSDoc is being read,
// so this reds wherever the check is actually turned off: a deleted `// @ts-check`, a
// `// @ts-nocheck` in the module's LEADING TRIVIA, and any later way of disabling it, none of which
// it needs to know about. Leading trivia is the whole of it, and measured rather than assumed: a
// `// @ts-nocheck` ABOVE the import reds this cell, while one AFTER the import or at EOF leaves the
// suite 23 of 23. That is correct rather than a hole, because TypeScript ignores the pragma in
// those positions too, so checking is still ON and there is nothing to catch. An earlier version of
// this sentence said "anywhere", which was wrong; two reviews executed the positions.
// The probe is content-only, at the module's own path, and writes nothing.
//
// A mutation row DOES reach this now, which is the point of making the guard behavioural: the
// textual read it replaced could only be anchored on a comment, and `pnpm smoke:mutation-fixtures`
// refuses a `find` that spans prose, so no row could announce that someone had disabled it. The
// anchor is code, the module's `import` line, and the row is in `reaper-declaration.json`. The
// control cell below is what makes the refusal attributable, since a probe that refuses everything
// proves nothing.
const moduleSource = readFileSync(MODULE_PATH, "utf8").replace(/\r\n/g, "\n");
const TYPE_ERROR = '\n/** @type {number} */\nconst __checkProbe = "not a number";\nvoid __checkProbe;\n';
let probeEmitted: string | undefined;
let probeError = "";
try { probeEmitted = renderReaperDeclaration(moduleSource + TYPE_ERROR); } catch (e) { probeError = (e as Error).message; }
check(
  "the module's JSDoc is really being checked: a deliberate type error in it stops the emit",
  probeEmitted === undefined && probeError.includes("does not typecheck"),
  probeEmitted === undefined
    ? `the emit refused, but not over the type error: ${probeError}`
    : `${MODULE_PATH} emitted a declaration over a string assigned to a \`number\`, so its JSDoc is not being read; it must carry \`// @ts-check\` and no \`// @ts-nocheck\``,
);
// The control on that zero: the same override path, with the module's own text and nothing added,
// must emit exactly what reading the file emits. What it covers is a probe that refuses for a
// reason that is not the injected error, which is the way this guard could go green while proving
// nothing: an environment where the module ITSELF stops typechecking refuses either text, and the
// probe cannot tell that refusal from the one it is asking for.
//
// It does NOT cover an override that never reaches the module, and a review was right to say so.
// Measured: with the path test forced to `false` the probe RED and this control GREEN, because a
// probe whose injected error never reached the compiler emits a declaration and reds on that. So
// the two cells cover different halves, no bypass leaves both green, and this comment used to
// claim the wrong half.
let controlEmitted: string | undefined;
let controlError = "";
try { controlEmitted = renderReaperDeclaration(moduleSource); } catch (e) { controlError = (e as Error).message; }
check(
  "and that probe is a valid program: the module's own text through the same path emits the same declaration",
  controlEmitted !== undefined && controlEmitted === emitted,
  controlEmitted === undefined
    ? `the override path refused the module's own text, so the cell above proves nothing: ${controlError}`
    : "the override path emitted a different declaration from the file read, so the probe is not running against this module",
);

// ---- and the declaration is honest about the RUNTIME, not only about the module's own JSDoc -----
//
// Everything above ties the declaration to the module's JSDoc and proves that JSDoc is checked.
// Neither says the promise is TRUE of the running code, and a security review built the bypass that
// lives in the gap: change `reportReaped`'s `@param {string} label` to `{number}`, and defeat the
// check locally with `/** @type {string} */ (/** @type {unknown} */ (label))` before a string-only
// use. `pnpm gen:reaper-dts` exits 0, the committed declaration becomes
// `reportReaped(label: number, ...)`, and this suite stayed at 23 of 23 while a consumer passing
// the declared `number` compiled and then threw `printableLabel.slice is not a function` at
// runtime. Reproduced first-party at 23 of 23 before these two cells existed. A double cast is the
// one thing `// @ts-check` cannot see through, so no amount of checking the module against itself
// closes this; only the runtime can answer it.
//
// So one consumer text is used twice. It calls every export the way the declaration says they may
// be called, and it is both COMPILED against the declaration alone (`allowJs` off, so the module's
// text is not a resolution target) and EXECUTED against the real module. The bypass above reds the
// first cell, because a consumer written to a `string` label no longer typechecks. Drift in the
// other direction, a declaration that stays honest-looking while the runtime moves under it, reds
// the second, and that is the one a mutation row drives: `reaper-declaration.json` makes
// `reportReaped` demand a number of a value the declaration still promises as a string.
const CONSUMER = `import type { NatsServerRow, ReapReport, ReapedBroker } from "./reap-smoke-brokers.mjs";
import { SMOKE_BROKER_PREFIX, listNatsServers, reapSmokeBrokers, reportReaped } from "./reap-smoke-brokers.mjs";

const rows: NatsServerRow[] | undefined = listNatsServers();
const report: ReapReport = reapSmokeBrokers({ dryRun: true });
const owners: number[] = report.reaped.map((r: ReapedBroker) => r.owner);
const label: string = \`contract probe \${SMOKE_BROKER_PREFIX}\`;
reportReaped(label, report);
console.log(\`__CONSUMER_RAN__ rows=\${rows === undefined ? "none" : rows.length} inspected=\${report.inspected} owners=\${owners.length}\`);
`;
const consumerDiagnostics = checkDeclarationConsumer(CONSUMER);
check(
  "a consumer written to what the declaration promises compiles against the declaration alone",
  consumerDiagnostics.length === 0,
  consumerDiagnostics.slice(0, 3).join(" | "),
);
// `dryRun` so the executed half claims nothing: it enumerates and reports, and signals no process.
const ranPath = join(dirname(MODULE_PATH), `.declaration-consumer.${process.pid}.mjs`);
let ran = { status: -1, output: "" };
try {
  writeFileSync(ranPath, transpileConsumer(CONSUMER));
  const r = spawnSync(process.execPath, [ranPath], { encoding: "utf8" });
  ran = { status: r.status ?? -1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
} finally {
  rmSync(ranPath, { force: true });
}
check(
  "and that same consumer RUNS against the module, so the declaration describes the code and not just its comments",
  ran.status === 0 && ran.output.includes("__CONSUMER_RAN__"),
  `exit ${ran.status}: ${ran.output.split("\n").find((l) => /Error/.test(l)) ?? ran.output.trim().slice(-200)}`,
);

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
