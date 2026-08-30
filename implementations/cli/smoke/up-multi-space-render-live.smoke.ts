/**
 * LIVE: `cotal up` on a broker root that holds SEVERAL tenants must render `server.conf` from the
 * VALIDATED INVENTORY, not from the one space it was asked to boot.
 *
 * The MEMORY resolver is a whole-broker map, so the rendered config IS the tenant list. Rendering
 * only the booted space therefore does not "leave the others alone" - it EVICTS them: their accounts
 * are absent from the resolver, every cred minted under them is refused, and the eviction is silent
 * (the broker starts, the booted space works, nothing prints). This is the correctness gap under the
 * per-space lifecycle work: a `cotal up` for one tenant would undo the provisioning of every other.
 *
 * Driven through the REAL command, as a subprocess, against a REAL broker:
 *
 *  1. a root with two tenants (alpha, beta) under ONE broker trust chain, booted with
 *     `cotal up --space alpha`, renders BOTH accounts into `resolver_preload`.
 *  2. beta - the tenant this `up` never mentions - can still CONNECT to the broker that boot
 *     started. Text in a config file is not the claim; being trusted by the running server is.
 *  3. alpha connects too (the booted tenant is not traded away for the sibling).
 *  4. an UNREADABLE record in the account namespace REFUSES the boot, rather than rendering a
 *     config that silently drops whatever tenant it may have been.
 *
 * Sandboxes COTAL_HOME under a scratch base with proven-clean `.cotal` ancestry; kills only its own
 * child. Needs `nats-server` on PATH.
 * Run: pnpm smoke:up-multi-space-render:live
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { makeScratch, assertScratchHeld } from "../../../bin/smoke/_scratch.js";

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });

const scratch = makeScratch("cotal-up-multispace-");
const home = mkdtempSync(join(scratch, "home-"));
const root = mkdtempSync(join(scratch, "root-"));
// A run started from a session that is itself joined to a mesh inherits COTAL_* — a live
// credential path and broker URL — and the spawns below spread this process env into their
// children. Strip the inherited keys first; the one variable the children need (COTAL_HOME)
// is set explicitly right after, pointing at this smoke's own sandbox.
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
process.env.COTAL_HOME = home;

const { composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, mintCreds, newIdentity } = await import("@cotal-ai/core");
const { authDir, saveBrokerAuth, saveSpaceAccountAuth, spaceAccountPath } = await import("@cotal-ai/workspace");

const WT = resolvePath(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");

let pass = 0;
const kids: ChildProcess[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start a FOREGROUND `cotal up` for one space and wait until its broker answers. */
function startUp(port: number, space: string): ChildProcess {
  const cp = spawn(TSX, [CLI, "up", "--space", space, "--server", `nats://127.0.0.1:${port}`], {
    cwd: root,
    env: { ...process.env, COTAL_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  kids.push(cp);
  let log = "";
  cp.stdout?.on("data", (b: Buffer) => { log += b.toString(); });
  cp.stderr?.on("data", (b: Buffer) => { log += b.toString(); });
  output.set(cp, () => log);
  return cp;
}
const output = new WeakMap<ChildProcess, () => string>();
const logOf = (cp: ChildProcess) => output.get(cp)?.() ?? "";

/** Can this cred reach the broker? The only question that matters about the rendered resolver. */
async function connects(port: number, creds: string): Promise<boolean> {
  try {
    const nc = await connect({
      servers: `nats://127.0.0.1:${port}`,
      authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
      maxReconnectAttempts: 0,
      timeout: 3_000,
    });
    await nc.close();
    return true;
  } catch {
    return false;
  }
}

try {
  mkdirSync(join(root, ".cotal"), { recursive: true });
  assertScratchHeld(root, "up multi-space render fixture");

  // ONE broker trust chain, TWO tenants - the shape `cotal space add` will produce, built here
  // directly because that verb does not exist yet.
  const broker = await createBrokerAuth("multi");
  saveBrokerAuth(authDir(root), broker);
  const alpha = await createSpaceAccountAuth(broker, "alpha");
  const beta = await createSpaceAccountAuth(broker, "beta");
  for (const acct of [alpha, beta]) saveSpaceAccountAuth(authDir(root), acct);
  const betaCreds = await mintCreds(composeSpaceAuth(broker, beta), newIdentity(), "provisioner");
  const alphaCreds = await mintCreds(composeSpaceAuth(broker, alpha), newIdentity(), "provisioner");

  console.log("1) `cotal up --space alpha` renders every tenant the auth dir holds");
  const port = await freePort();
  const child = startUp(port, "alpha");
  const confPath = join(authDir(root), "server.conf");
  let conf = "";
  for (let i = 0; i < 200 && !(await connects(port, alphaCreds)); i++) {
    if (child.exitCode !== null) break;
    await sleep(150);
  }
  ok("the booted broker answers", await connects(port, alphaCreds), logOf(child).slice(-1500));
  conf = readFileSync(confPath, "utf8");
  ok("server.conf preloads the BOOTED tenant's account", conf.includes(alpha.account.pub));
  ok("server.conf preloads the SIBLING tenant's account (not evicted by a boot that never named it)",
    conf.includes(beta.account.pub), conf.split("resolver_preload")[1]?.slice(0, 400));

  console.log("\n2) the sibling is trusted by the RUNNING broker, not merely present in the file");
  ok("a cred minted under beta connects to the broker alpha's `up` started", await connects(port, betaCreds));
  ok("…and alpha still connects (the sibling was not traded for the booted tenant)", await connects(port, alphaCreds));

  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), sleep(20_000)]);

  console.log("\n3) an unreadable account record REFUSES the boot (never a silently narrowed resolver)");
  writeFileSync(spaceAccountPath(authDir(root), "gamma"), JSON.stringify({ space: "gamma" })); // no account material
  const before = readFileSync(confPath, "utf8");
  const port2 = await freePort();
  const refused = startUp(port2, "alpha");
  let err = "";
  refused.stderr?.on("data", (b: Buffer) => { err += b.toString(); });
  refused.stdout?.on("data", (b: Buffer) => { err += b.toString(); });
  await Promise.race([once(refused, "exit"), sleep(60_000)]);
  ok("the boot exited non-zero", refused.exitCode !== 0, { code: refused.exitCode });
  ok("…naming the unreadable record and why it refuses", /unreadable|not fully readable/.test(err), err.slice(-600));
  ok("…and left the previous config untouched (no partially-rendered tenant list)",
    readFileSync(confPath, "utf8") === before);

  console.log(`\nUP MULTI-SPACE RENDER SMOKE OK ✅  (${pass} passed)`);
} catch (e) {
  console.error("  ✗ FAIL:", (e as Error).message);
  process.exitCode = 1;
} finally {
  for (const cp of kids) if (cp.exitCode === null) cp.kill("SIGKILL");
  await sleep(500);
  // Every runtime record this root holds, whatever space each belongs to. The records are
  // space-keyed now (`manager.<hex>.pid`), and a teardown running after a failure cannot assume
  // which spaces got as far as writing one, so it matches the SHAPE rather than a fixed name list.
  // The pre-segmentation root-scoped spelling matches too, so a root an older build left behind is
  // still swept.
  for (const name of readdirSync(join(root, ".cotal")).filter((n) => /^(nats|manager|delivery)\.([^.]+\.)?pid$/.test(n))) {
    const pid = Number.parseInt(readFileSync(join(root, ".cotal", name), "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  rmSync(scratch, { recursive: true, force: true });
}
