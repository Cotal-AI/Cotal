/**
 * A once Jcode seat's launched tree is proved gone after its host exits, by the evidence the host
 * recorded under the seat's uid.
 *
 * The host records each native launch under its uid before the launch, a bridge relaunch included.
 * `retireAfterExit` stops what that evidence names once the recorded host is gone, and answers with
 * proof only when nothing it names survives; the proof is kept as a receipt, so asking again gives
 * the same answer until the manager discards it. Missing or malformed evidence and a live recorded
 * host PID each throw. A same-name successor's tree is never touched.
 *
 * Run: pnpm smoke:jcode-once-retire
 */
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintLifecycleUid } from "@cotal-ai/core";
import { captureProcessIdentity, discardOnceReceipt, recordOnceLaunch, retireOnceTree } from "../src/private-lifecycle.js";
import { jcodeConnector } from "../src/extension.js";
import { jcodeSeatHome } from "../src/session-fork.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const rejects = async (p: Promise<unknown>, pattern: RegExp): Promise<string | undefined> => {
  try { await p; return undefined; } catch (e) { const m = (e as Error).message; return pattern.test(m) ? m : `unexpected: ${m}`; }
};

const started: ChildProcess[] = [];
/** A process in its own group, as the real Jcode daemon is, carrying `identity` when given. */
const sleeper = (identity?: string): ChildProcess => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  if (identity) env.JCODE_COTAL_LAUNCH_IDENTITY = identity;
  else delete env.JCODE_COTAL_LAUNCH_IDENTITY;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { env, stdio: "ignore", detached: true });
  child.unref();
  started.push(child);
  return child;
};
const running = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = async (pid: number, ms = 5_000): Promise<boolean> => {
  for (const until = Date.now() + ms; Date.now() < until;) {
    if (!running(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !running(pid);
};
const nonce = () => `smoke-${randomBytes(12).toString("base64url")}`;

const root = mkdtempSync(join(tmpdir(), "cotal-jcode-once-retire-"));
try {
  if (process.platform !== "linux") throw new Error("this suite proves process identity through /proc and runs on Linux only");
  const space = "smoke", name = "helper";
  const home = jcodeSeatHome(root, space, name);
  mkdirSync(home, { recursive: true });
  const uid = mintLifecycleUid();

  console.log("1. no evidence, malformed evidence and a live host each refuse");
  check("a seat with no evidence cannot be proved retired", (await rejects(retireOnceTree(home, uid), /has no launch evidence/u))?.startsWith("jcode") === true);
  const bad = mintLifecycleUid();
  writeFileSync(join(home, `cotal-once-${bad}.json`), JSON.stringify({ uid: bad, host: { pid: 1 }, launches: [] }));
  check("malformed evidence is refused, not read as retired", (await rejects(retireOnceTree(home, bad), /not well formed/u))?.startsWith("jcode") === true);
  check("a uid that is not a lifecycle token never becomes a path", (await rejects(retireOnceTree(home, "../x"), /not a lifecycle uid/u))?.startsWith("jcode") === true);

  const host = sleeper();
  const first = nonce(), second = nonce();
  recordOnceLaunch(home, uid, { identity: first, host: captureProcessIdentity(host.pid!) });
  const bridge = sleeper(first);
  // The bridge relaunch: a second identity under the same uid and host.
  recordOnceLaunch(home, uid, { identity: second, host: captureProcessIdentity(host.pid!) });
  const daemon = sleeper(second);
  const other = sleeper();
  check("evidence from another host is refused", (() => { try { recordOnceLaunch(home, uid, { identity: nonce(), host: captureProcessIdentity(other.pid!) }); return false; } catch (e) { return /another host/u.test((e as Error).message); } })());
  check("a live recorded host refuses the proof", (await rejects(retireOnceTree(home, uid), /recorded host PID \d+ is alive/u))?.startsWith("jcode") === true);
  check("...and signals nothing", running(bridge.pid!) && running(daemon.pid!));

  console.log("\n2. once the host is gone, every launch the uid recorded is stopped and proved gone");
  // A same-name successor: another uid, its own launch, alive.
  const successorUid = mintLifecycleUid();
  const successorHost = sleeper();
  const successorIdentity = nonce();
  recordOnceLaunch(home, successorUid, { identity: successorIdentity, host: captureProcessIdentity(successorHost.pid!) });
  const successorTree = sleeper(successorIdentity);
  process.kill(host.pid!, "SIGKILL");
  await gone(host.pid!);
  const seat = { space, name, lifecycleUid: uid, workspaceRoot: root };
  let proof: { discard(): Promise<void> } | undefined;
  try { proof = await jcodeConnector.retireAfterExit!(seat); } catch (e) { console.log(`    (retire threw: ${(e as Error).message})`); }
  check("the connector proves the seat retired", proof !== undefined);
  check("...after stopping both launches' processes", await gone(bridge.pid!) && await gone(daemon.pid!));
  check("the same-name successor's tree is untouched", running(successorTree.pid!) && running(successorHost.pid!));
  const receipt = (() => { try { return JSON.parse(readFileSync(join(home, `cotal-once-${uid}.json`), "utf8")) as unknown; } catch { return undefined; } })();
  check("the proof is kept as a receipt", JSON.stringify(receipt) === JSON.stringify({ uid, retired: true }), receipt);
  let again = false;
  try { await jcodeConnector.retireAfterExit!(seat); again = true; } catch { /* reported below */ }
  check("asking again returns the same proof from the receipt", again);
  check("a launch under a retired uid is refused", (() => { try { recordOnceLaunch(home, uid, { identity: nonce(), host: captureProcessIdentity(successorHost.pid!) }); return false; } catch (e) { return /already proved retired/u.test((e as Error).message); } })());

  console.log("\n3. the receipt is discarded only after the proof, and live evidence never is");
  check("live evidence is not discarded", (() => { try { discardOnceReceipt(home, successorUid); return false; } catch (e) { return /not a retirement receipt/u.test((e as Error).message); } })());
  await proof?.discard();
  check("discarding the receipt removes it", !existsSync(join(home, `cotal-once-${uid}.json`)));
  check("...and the seat can no longer be proved retired from it", (await rejects(retireOnceTree(home, uid), /has no launch evidence/u))?.startsWith("jcode") === true);

  console.log("\n4. a once launch carries its marker and needs a uid");
  const launch = jcodeConnector.buildLaunch({ space, name, servers: "nats://127.0.0.1:1", workspaceRoot: root, lifecycleUid: uid, once: true } as Parameters<typeof jcodeConnector.buildLaunch>[0]);
  check("a once launch tells the host it is a once seat", launch.env?.COTAL_JCODE_ONCE === "1");
  check("a once launch without a lifecycle uid is refused", (() => { try { jcodeConnector.buildLaunch({ space, name, servers: "nats://127.0.0.1:1", workspaceRoot: root, once: true } as Parameters<typeof jcodeConnector.buildLaunch>[0]); return false; } catch (e) { return /needs its lifecycle uid/u.test((e as Error).message); } })());
} finally {
  for (const child of started) { try { process.kill(child.pid!, "SIGKILL"); } catch { /* already gone */ } }
  rmSync(root, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nJCODE ONCE RETIRE SMOKE PASSED ✅ (${pass} checks)` : `\nJCODE ONCE RETIRE SMOKE FAILED ❌ (${pass} passed, ${fail} failed)`);
console.log(`COTAL_SMOKE_SENTINEL cells=${pass + fail} passed=${pass} failed=${fail}`);
process.exit(fail === 0 ? 0 : 1);
