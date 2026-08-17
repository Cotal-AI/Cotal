/**
 * The leaked-broker reaper: it must kill what carries the token and must not touch anything else.
 *
 * THE NEGATIVE CONTROL IS THE POINT OF THIS SUITE. A reaper that kills too much is worse than no
 * reaper, because it would take out a developer's real mesh or another suite's live broker while
 * reporting success. Every cell that proves a kill is paired with one that proves a survival, and the
 * survivor is spawned from the same code path as the victim so the only difference between them is
 * the token in the path.
 *
 * Both brokers are spawned as CHILDREN of this suite and torn down here, so a suite about leaked
 * brokers does not leak one. The reaper does not care about parentage, it matches argv, so testing it
 * on children tests exactly the same code path an orphan would take.
 */
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN as KIT_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { SMOKE_BROKER_TOKEN, listNatsServers, reapSmokeBrokers } from "./reap-smoke-brokers.mjs";

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

// The reaper duplicates the token as a literal because it runs from the CI runner before any
// workspace build. That duplication is only safe if it cannot drift, which is what this asserts.
check("the reaper's token literal is the one the kit mints", SMOKE_BROKER_TOKEN === KIT_TOKEN, `${SMOKE_BROKER_TOKEN} vs ${KIT_TOKEN}`);

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

try {
  // The victim carries the token; the survivor is identical in every other way, including being a
  // real nats-server under the OS temp dir with a JetStream store.
  const victim = await startBroker(SMOKE_BROKER_TOKEN);
  const survivor = await startBroker("cotal-reaper-control-");
  await wait(1500);

  check("both fixture brokers are running before the reaper", alive(victim.pid!) && alive(survivor.pid!), `${victim.pid} ${survivor.pid}`);

  const listed = listNatsServers();
  check("the enumerator is supported on this platform", listed !== undefined);
  const pids = (listed ?? []).map((r) => r.pid);
  check("the enumerator sees the token-carrying broker", pids.includes(victim.pid!), `pid ${victim.pid}`);
  check("the enumerator sees the untokened broker too, so the filter is what excludes it later", pids.includes(survivor.pid!), `pid ${survivor.pid}`);

  const result = reapSmokeBrokers();
  await wait(500);

  check("the reaper reports the platform as supported", result.supported);
  check("POSITIVE CONTROL: the token-carrying broker is killed", !alive(victim.pid!), `pid ${victim.pid} survived`);
  check("NEGATIVE CONTROL: the untokened broker is untouched", alive(survivor.pid!), `pid ${survivor.pid} was killed`);
  check("the killed broker is named in the report, not just counted", result.reaped.some((r) => r.pid === victim.pid), JSON.stringify(result.reaped.map((r) => r.pid)));
  check("the survivor is NOT named as reaped", !result.reaped.some((r) => r.pid === survivor.pid));
  // The number that keeps a quiet run honest: a reaper that claims nothing must still say how much it
  // looked at and declined, or "0 reaped" reads the same on a clean box and a wholly unmigrated one.
  check("the report counts what it deliberately did not claim", result.unclaimable >= 1, `unclaimable=${result.unclaimable}`);
  check("the report counts everything it inspected", result.inspected >= 2, `inspected=${result.inspected}`);

  // Running it again with the victim already dead must be a clean no-op, not a second kill or a throw:
  // the reaper runs after every suite in the chain, so the quiet path is the common one.
  const second = reapSmokeBrokers();
  check("a second run reaps nothing and does not throw", second.reaped.every((r) => r.pid !== victim.pid));
  check("the survivor is still alive after the second run", alive(survivor.pid!));
} catch (e) {
  fail++;
  console.log(`  ✗ FAIL: scenario threw: ${(e as Error).message}`);
} finally {
  for (const k of kids) await killAndAwaitExit(k, "SIGKILL");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const r of releases) r();
}

console.log(`\n${pass} passed, ${fail} failed  (${pass + fail} cells ran)\n`);
process.exit(fail > 0 ? 1 : 0);
