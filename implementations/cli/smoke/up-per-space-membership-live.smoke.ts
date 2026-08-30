/**
 * PROBE for prerequisite P7 (design doc §5): the membership bundle is ROOT-scoped, so two tenants
 * on one broker cannot each hold their own.
 *
 * EXPECTED TO FAIL until P7 lands. Deliberately NOT registered in package.json / ci-suites.txt: a
 * probe that is red by design must not gate CI, and a `smoke:*` script that no suite reaches would
 * fail `pnpm smoke:gate-inventory`. Both registrations belong in the commit that fixes P7.
 * Run: npx tsx implementations/cli/smoke/up-per-space-membership-live.smoke.ts
 *
 * §5 says "a second space's `up` overwrites the first space's observer with one pinned to the wrong
 * data account". This probe checks that sentence against the code as merged, in two cells, because
 * the reachable failure is NOT the one the doc describes:
 *
 *  1. THE DOC'S SCENARIO IS UNREACHABLE THROUGH `up`. A root already belonging to other spaces
 *     refuses a `--space` it does not hold, at the WORKSPACE-ROOT identity check ("this folder is
 *     the root of ..., so it can't also run ..."), long before any trust write. So `up` cannot add a
 *     second tenant to an existing root and never reaches `provisionMembershipCreds` to do the
 *     overwriting. A multi-tenant root comes from `space add`, which does not exist yet.
 *
 *     Two deeper guards stand behind that one and this path never reaches either: the fresh branch
 *     would call `createSpaceAuth`, minting a WHOLE NEW BROKER OPERATOR, and `putSpaceAuth` ->
 *     `guardBrokerOverwrite` refuses a different operator outright. Asserted here as the message
 *     that ACTUALLY fires, not the deepest one that would: this probe first asserted the operator
 *     conflict and failed, because the root check answers first.
 *
 *  2. WHAT IS ACTUALLY REACHABLE IS INHERITANCE, NOT OVERWRITE. On a root shaped the way
 *     `space add` will produce one (one broker chain, two account records), NEITHER space takes the
 *     fresh branch, so `provisionMembershipCreds` never runs and only `healMembershipDataCreds`
 *     does. That writer is guarded (`!existsSync`, `store.get() === undefined`), so it writes only
 *     what is ABSENT. The first space to boot wins the root-scoped paths and the second silently
 *     runs on its sibling's: `membership.json` keeps naming the FIRST tenant's data account, and
 *     `membership-rw.creds` stays signed by it.
 *
 * Cell 2's last assertion is the P7 failure. It is written as the property P7 must establish - each
 * tenant's boot leaves the bundle naming ITS OWN account - so it flips to green when P7 lands.
 *
 * Sandboxes COTAL_HOME under a scratch base; kills only its own children. Needs `nats-server`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
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

const scratch = makeScratch("cotal-p7-membership-");
const home = mkdtempSync(join(scratch, "home-"));
const root = mkdtempSync(join(scratch, "root-"));
// A run started from a session already joined to a mesh inherits COTAL_* - a live credential path
// and broker URL - and the spawns below spread this process env into their children. Strip the
// inherited keys; the one the children need (COTAL_HOME) is set explicitly right after.
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
process.env.COTAL_HOME = home;

const { composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, mintCreds, newIdentity } = await import("@cotal-ai/core");
const { authDir, saveBrokerAuth, saveSpaceAccountAuth, spaceMaterialDir } = await import("@cotal-ai/workspace");

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
const output = new WeakMap<ChildProcess, () => string>();
const logOf = (cp: ChildProcess) => output.get(cp)?.() ?? "";

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

/** Boot one space, wait until its own cred reaches the broker, then stop the child. */
async function bootThenStop(port: number, space: string, creds: string): Promise<ChildProcess> {
  const cp = startUp(port, space);
  for (let i = 0; i < 200 && !(await connects(port, creds)); i++) {
    if (cp.exitCode !== null) break;
    await sleep(150);
  }
  ok(`\`up --space ${space}\` booted and its own cred reaches the broker`, await connects(port, creds), logOf(cp).slice(-1200));
  cp.kill("SIGTERM");
  await Promise.race([once(cp, "exit"), sleep(20_000)]);
  return cp;
}

/** The data account THIS TENANT's bundle names. Per-space as of P7, so the probe reads the tenant's
 *  own segment: reading `.cotal/membership.json` would now find nothing for either tenant and both
 *  cells below would go green on `undefined === undefined`, which is the false pass this probe
 *  exists to rule out. `spaceMaterialDir` resolves and migrates nothing — the probe must observe the
 *  layout `up` produced, never nudge it. */
const membershipAccount = (space: string): string | undefined => {
  const p = join(spaceMaterialDir(root, space), "membership.json");
  if (!existsSync(p)) return undefined;
  return (JSON.parse(readFileSync(p, "utf8")) as { accountId?: string }).accountId;
};

try {
  mkdirSync(join(root, ".cotal"), { recursive: true });
  assertScratchHeld(root, "P7 per-space membership probe fixture");

  // ONE broker trust chain, TWO tenants - the shape `cotal space add` will produce, built here
  // directly because that verb does not exist yet (the idiom of up-multi-space-render-live).
  const broker = await createBrokerAuth("p7");
  saveBrokerAuth(authDir(root), broker);
  const alpha = await createSpaceAccountAuth(broker, "alpha");
  const beta = await createSpaceAccountAuth(broker, "beta");
  for (const acct of [alpha, beta]) saveSpaceAccountAuth(authDir(root), acct);
  const alphaCreds = await mintCreds(composeSpaceAuth(broker, alpha), newIdentity(), "provisioner");
  const betaCreds = await mintCreds(composeSpaceAuth(broker, beta), newIdentity(), "provisioner");

  console.log("1) the doc's overwrite scenario: can `up` add a SECOND tenant to an existing root at all?");
  // A space whose account record this root does NOT hold takes the fresh branch, which mints a new
  // broker operator. The trust guard must refuse it rather than orphaning alpha and beta.
  const portFresh = await freePort();
  const stranger = startUp(portFresh, "gamma");
  let sErr = "";
  stranger.stdout?.on("data", (b: Buffer) => { sErr += b.toString(); });
  stranger.stderr?.on("data", (b: Buffer) => { sErr += b.toString(); });
  await Promise.race([once(stranger, "exit"), sleep(60_000)]);
  ok("a fresh space on a root that already has a broker REFUSES (non-zero)", stranger.exitCode !== 0, { code: stranger.exitCode });
  ok("…refusing at the ROOT-IDENTITY check, naming the tenants this folder already holds",
    /this folder is the root of/.test(sErr) && /alpha/.test(sErr) && /beta/.test(sErr), sErr.slice(-400));
  // Checked at BOTH spellings, and in gamma's own segment: after P7 the provisioner writes into
  // `.cotal/space.<hex>/`, so the flat check alone would pass on a refusal that had in fact written.
  ok("…so `provisionMembershipCreds` never ran: no $SYS observer was written",
    ![join(root, ".cotal"), spaceMaterialDir(root, "gamma"), spaceMaterialDir(root, "alpha"), spaceMaterialDir(root, "beta")]
      .some((d) => existsSync(join(d, "membership-observer.creds"))));

  console.log("\n2) the reachable defect: two EXISTING tenants share one root-scoped bundle");
  const port = await freePort();
  await bootThenStop(port, "alpha", alphaCreds);
  const afterAlpha = membershipAccount("alpha");
  ok("alpha's boot wrote membership.json naming ALPHA's data account",
    afterAlpha === alpha.account.pub, { got: afterAlpha, want: alpha.account.pub });

  const port2 = await freePort();
  await bootThenStop(port2, "beta", betaCreds);
  const afterBeta = membershipAccount("beta");

  // THE P7 ASSERTION. Stated as the property P7 must establish, so it goes green when P7 lands.
  ok("after beta's boot, the bundle beta runs on names BETA's data account, not its sibling's",
    afterBeta === beta.account.pub,
    { got: afterBeta, alpha: alpha.account.pub, beta: beta.account.pub,
      note: "root-scoped membership.json: the first tenant to boot wins it and the second inherits it" });
  // ...and alpha's is UNDISTURBED. The one-sided cell above also passes if beta's boot simply
  // OVERWROTE the shared bundle in the other direction, which is the same defect with the tenants
  // swapped. Segmentation is the claim that both are true at once.
  ok("…and alpha's bundle still names ALPHA: segmentation, not a swapped inheritance",
    membershipAccount("alpha") === alpha.account.pub, { got: membershipAccount("alpha"), want: alpha.account.pub });

  console.log(`\nP7 PROBE OK ✅  (${pass} passed) - P7 is CLOSED if this is green`);
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
