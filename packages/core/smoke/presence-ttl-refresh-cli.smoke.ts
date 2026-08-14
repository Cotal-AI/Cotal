/**
 * #286 — the TTL reconcile reaches a mesh that is ALREADY RUNNING, driven through the PUBLIC CLI.
 *
 * This suite exists because the sibling one was not enough, and the way it was not enough is the
 * lesson. `presence-ttl-migration-auth.smoke.ts` calls `setupSpaceStreams` DIRECTLY. It proves the
 * reconcile works; it never proves anything a user runs reaches it. It passed 15/15 while
 * `cotal up` against an already-running mesh returned success at `up.ts` WITHOUT reconciling
 * anything — because that branch returns before `postStart`, and `postStart` is the only CLI route
 * to `setupSpaceStreams`. So the fix was green, gated, and absent from the one deployment shape it
 * was written for: an old mesh, already up, whose buckets predate the TTLs.
 *
 * A drifted bucket only exists on a mesh that has been running since before the TTLs. Reconciling
 * only on the CREATE path repairs the deployments that never had the defect.
 *
 * So this drives the real binary twice with drift staged in between: `cotal up` → set `max_age: 0`
 * on all three TTL'd buckets → `cotal up` AGAIN from the same root and server → the TTLs must be
 * back. Nothing here calls the reconcile itself; if the public path stops reaching it, this reddens.
 *
 * Third invocation grades the steady state: a mesh already at the right TTLs must reconcile NOTHING
 * and say nothing, so a repeat `cotal up` does not become a write against a healthy production mesh.
 *
 * Needs `nats-server` on PATH. Run: pnpm smoke:presence-ttl-refresh-cli
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connect, nanos } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { mintCreds, newIdentity, standaloneConnectOpts, presenceBucket, deliveryBucket, managerBucket } from "../src/index.js";
import { getSpaceAuth, workspaceSecretStore } from "../../workspace/src/index.js";
import { pickFreePort } from "./_free-port.js";
import { assertEphemeralBroker, scrubAmbientBrokerEnv } from "./_ephemeral-only.js";
import { foreignRootFor, killManagerAtRoot, makeScratch } from "../../../bin/smoke/_scratch.js";

// FENCE LAYER 4, FIRST STATEMENT OF THE SUITE. This operator environment carries the LIVE broker in
// COTAL_SERVERS (and live COTAL_CREDS / COTAL_SPACE). This suite spawns the real `cotal` binary,
// which resolves its target from the environment when not told otherwise — so a URL fence alone
// would never be consulted. Scrub the ambient values out of the process the children inherit, THEN
// assert the target. Scrub before assert, because asserting a URL says nothing about what a child
// reads from the environment behind it.
scrubAmbientBrokerEnv();

const PRESENCE_MS = 6_000, DELIVERY_MS = 30_000, MANAGER_MS = 10_000;
const scratch = makeScratch("cotal-ttlrefresh-");
const cleanScratch = (e: unknown): never => {
  rmSync(scratch, { recursive: true, force: true });
  throw new Error(`fixture setup failed (scratch removed): ${(e as Error).message}`, { cause: e });
};
let home!: string, root!: string, SERVER!: string;
try {
  home = mkdtempSync(join(scratch, "home-"));
  process.env.COTAL_HOME = home;
  root = mkdtempSync(join(scratch, "root-"));
  // Anchor BEFORE any product command: `findCotalRoot` walks to `/`, so without this the child
  // resolves to whatever ancestor owns a `.cotal` — under $HOME that is the live credential store,
  // under /tmp it is the one every unanchored tree on this box shares.
  mkdirSync(join(root, ".cotal"), { recursive: true });
  SERVER = `nats://127.0.0.1:${await pickFreePort()}`;
} catch (e) { cleanScratch(e); }
assertEphemeralBroker(SERVER);

const SPACE = `ttlrefresh-${Math.floor(Math.random() * 1e6)}`;
const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");
const DRAIN_MS = 1_500;

let pass = 0, fail = 0;
const check = (n: string, v: boolean, x?: unknown) => { v ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ FAIL: ${n}`, x ?? "")); };

type Run = { status: number | null; out: string; timedOut: boolean; signal: NodeJS.Signals | null; launchError?: string };
function cotal(args: string[], timeoutMs = 120_000): Promise<Run> {
  return new Promise((res) => {
    const child = spawn("npx", ["tsx", BIN, ...args], { cwd: root, env: { ...process.env, COTAL_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", timedOut = false, settled = false, exited = false;
    let status: number | null = null, signal: NodeJS.Signals | null = null, drain: NodeJS.Timeout | undefined;
    const done = (r: Run) => { if (settled) return; settled = true; clearTimeout(cmd); clearTimeout(drain); res(r); };
    const giveUp = () => { child.stdout?.destroy(); child.stderr?.destroy(); done({ status, out, timedOut, signal }); };
    const cmd = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); if (exited) giveUp(); else drain = setTimeout(giveUp, DRAIN_MS); }, timeoutMs);
    child.on("error", (e) => done({ status: null, out, timedOut, signal: null, launchError: e.message }));
    child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
    // Detached descendants keep the inherited pipes open after the child exits, so record the
    // outcome at `exit` and bound the drain rather than waiting on `close` forever.
    child.on("exit", (s, sg) => { exited = true; status = s; signal = sg; drain = setTimeout(giveUp, DRAIN_MS); });
    child.on("close", (s, sg) => done({ status: s ?? status, out, timedOut, signal: sg ?? signal }));
  });
}
/** A child that was killed, timed out or never launched produces the same `status` shape as a
 *  product failure. Refuse to grade those as either. */
function mustHaveRun(r: Run, what: string): void {
  const why = r.launchError ? `never launched (${r.launchError})` : r.timedOut ? "was SIGKILLed by this suite's timeout" : r.signal ? `was killed by ${r.signal}` : "";
  if (why) { process.exitCode = 1; throw new Error(`FIXTURE FAILURE, not a product defect: ${what} ${why}.`); }
}

/** Read the three buckets' `max_age`, as the provisioner. */
async function maxAges(creds: string): Promise<Record<string, number>> {
  const nc = await connect({ servers: SERVER, ...standaloneConnectOpts({ creds, tls: false }) });
  try {
    const jsm = await jetstreamManager(nc);
    const out: Record<string, number> = {};
    for (const b of [presenceBucket(SPACE), deliveryBucket(SPACE), managerBucket(SPACE)])
      out[b] = (await jsm.streams.info(`KV_${b}`)).config.max_age;
    return out;
  } finally { await nc.drain(); }
}

let upAttempted = false;
try {
  const anchored = existsSync(join(root, ".cotal"));
  check("the fixture root OWNS its .cotal (the anchor exists)", anchored, root);
  if (!anchored) { process.exitCode = 1; throw new Error("FIXTURE FAILURE: no anchor, so no product command below can be trusted to root here."); }
  const captor = foreignRootFor(root);
  check("...and therefore outranks any ancestor", captor === null, captor);
  if (captor) { process.exitCode = 1; throw new Error(`FIXTURE FAILURE: ${root} resolves to ${captor}.`); }

  console.log("\n1) cotal up — the mesh that will be 'already running' for the rest of this suite");
  upAttempted = true;
  const up1 = await cotal(["up", "--detach", "--server", SERVER, "--space", SPACE]);
  mustHaveRun(up1, "`cotal up`");
  check("`cotal up` exits 0 — checked FIRST so a fixture failure is distinguishable from a product one", up1.status === 0, up1.out.slice(-700));
  if (up1.status !== 0) { process.exitCode = 1; throw new Error("FIXTURE FAILURE: no mesh came up, so the refresh path was never exercised."); }

  console.log("\n2) stage the OLD-DEPLOYMENT shape: strip max_age from all three TTL'd buckets");
  const auth = await getSpaceAuth(workspaceSecretStore(root), SPACE);
  if (!auth) { process.exitCode = 1; throw new Error("FIXTURE FAILURE: no space auth under the fixture root."); }
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  {
    const nc = await connect({ servers: SERVER, ...standaloneConnectOpts({ creds, tls: false }) });
    try {
      const jsm = await jetstreamManager(nc);
      for (const b of [presenceBucket(SPACE), deliveryBucket(SPACE), managerBucket(SPACE)])
        await jsm.streams.update(`KV_${b}`, { max_age: 0 });
    } finally { await nc.drain(); }
  }
  const drifted = await maxAges(creds);
  // The fixture must PROVE it built the defective prior state. Without these, a suite that silently
  // failed to strip the TTLs would "pass" step 4 on buckets that were never drifted.
  check("presence bucket now has NO expiry (max_age=0) — the pre-TTL deployment shape", drifted[presenceBucket(SPACE)] === 0, drifted[presenceBucket(SPACE)]);
  check("delivery-lease bucket now has NO expiry (max_age=0)", drifted[deliveryBucket(SPACE)] === 0, drifted[deliveryBucket(SPACE)]);
  check("manager-lease bucket now has NO expiry (max_age=0)", drifted[managerBucket(SPACE)] === 0, drifted[managerBucket(SPACE)]);

  console.log("\n3) cotal up AGAIN, same root and server — the ALREADY-RUNNING refresh path");
  const up2 = await cotal(["up", "--detach", "--server", SERVER, "--space", SPACE]);
  mustHaveRun(up2, "the second `cotal up`");
  check("the refresh exits 0", up2.status === 0, up2.out.slice(-700));
  check("...and it took the already-running branch (not a fresh start)", /already running/.test(up2.out), up2.out.slice(-300));

  console.log("\n4) THE CELL: the public path reconciled the drifted TTLs");
  const after = await maxAges(creds);
  check("presence max_age reconciled to 6s BY `cotal up` (not by calling the function)", after[presenceBucket(SPACE)] === nanos(PRESENCE_MS), after[presenceBucket(SPACE)] / 1e6);
  check("delivery-lease max_age reconciled to 30s by `cotal up`", after[deliveryBucket(SPACE)] === nanos(DELIVERY_MS), after[deliveryBucket(SPACE)] / 1e6);
  check("manager-lease max_age reconciled to 10s by `cotal up`", after[managerBucket(SPACE)] === nanos(MANAGER_MS), after[managerBucket(SPACE)] / 1e6);
  // A config write on a running mesh that the operator cannot see is the silent behaviour this
  // change exists to remove — so the CLI must SAY it acted, not just act.
  check("...and the CLI SAID it reconciled, rather than writing silently", /reconciled .*TTL/.test(up2.out), up2.out.slice(-400));

  console.log("\n5) steady state: a third `cotal up` must reconcile NOTHING and say nothing");
  const up3 = await cotal(["up", "--detach", "--server", SERVER, "--space", SPACE]);
  mustHaveRun(up3, "the third `cotal up`");
  check("the steady-state refresh exits 0", up3.status === 0, up3.out.slice(-500));
  // Read-first: matching TTLs are skipped, so a healthy mesh takes no write. Without this, the fix
  // would turn every repeat `cotal up` into three STREAM.UPDATEs against a live production mesh.
  check("a mesh already at the right TTLs reports NO reconcile (read-first, no write)", !/reconciled .*TTL/.test(up3.out), up3.out.slice(-400));
  const steady = await maxAges(creds);
  check("...and the TTLs are still correct after the no-op pass", steady[presenceBucket(SPACE)] === nanos(PRESENCE_MS), steady[presenceBucket(SPACE)] / 1e6);

  console.log(`\nPRESENCE-TTL-REFRESH-CLI SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
} finally {
  // TEARDOWN, rewritten after this suite leaked EIGHT brokers in one evening.
  //
  // The original swallowed `cotal down`'s failure with a `.catch`, fell back to killing the MANAGER
  // (which is not the broker), and then removed the scratch unconditionally. That last step is the
  // one that did the damage: `rm -rf` does not stop a process, it orphans it with a deleted cwd —
  // the surviving `nats-server` holds a port and a JetStream store, and the directory that named it
  // is gone, so nothing can attribute it afterwards. Measured: eight of them alive 9-15 minutes
  // later, only identifiable because /proc still remembered the deleted path.
  //
  // So: stop it, PROVE it stopped, and only then delete. If it did not stop, keep the scratch —
  // its `.cotal` holds the pidfiles that are the only way to find what is still running.
  let meshStopped = !upAttempted;
  if (upAttempted) {
    // `cotal down` re-resolves its root from cwd. Without our own anchor it could signal a mesh this
    // suite never started, which is worse than not tearing down at all.
    if (!existsSync(join(root, ".cotal"))) {
      console.error(`  ! refusing \`cotal down\`: ${root} owns no .cotal, so the child would resolve elsewhere and could signal processes this suite never started`);
    } else {
      const down = await cotal(["down"], 60_000);
      // A timeout, a signal death and a launch failure all resolve here too — an unchecked await
      // would read every one of them as a successful stop.
      if (down.launchError || down.timedOut || down.signal) console.error(`  ! \`cotal down\` did not run cleanly: ${down.launchError ?? (down.timedOut ? "timed out" : String(down.signal))}`);
      else if (down.status !== 0) console.error(`  ! \`cotal down\` exited ${down.status}: ${down.out.slice(-300)}`);
      else meshStopped = true;
    }
    if (!meshStopped) { try { await killManagerAtRoot(root); } catch { /* reported below */ } }
  }
  // Independent of what `down` CLAIMED: no broker may still be holding this fixture's scratch.
  // Exact-name matched, and matched to OUR scratch — never a bare name sweep, which on this box
  // would reach other lanes' ephemeral brokers.
  const survivors = execFileSync("bash", ["-c", `for p in $(pgrep -x nats-server 2>/dev/null); do c=$(readlink /proc/$p/cwd 2>/dev/null); case "$c" in ${scratch}*) echo $p;; esac; done`], { encoding: "utf8" }).trim();
  if (survivors) {
    meshStopped = false;
    console.error(`  ! broker(s) still alive under this fixture after teardown: ${survivors.split("\n").join(", ")}`);
    for (const p of survivors.split("\n")) { try { process.kill(Number(p), "SIGKILL"); } catch { /* already gone */ } }
    console.error(`  ! SIGKILLed them; the scratch is preserved so the leak stays attributable`);
  }
  if (meshStopped) rmSync(scratch, { recursive: true, force: true });
  else { process.exitCode = 1; console.error(`  ! PRESERVING ${scratch}: its .cotal holds the pidfiles needed to find anything still running`); }
}
process.exit(fail === 0 && !process.exitCode ? 0 : 1);
