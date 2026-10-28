/**
 * LIVE PROBE (#4510): a refused `down --preserve-state` leaves the delivery daemon running.
 *
 * The cut stops the delivery daemon as its Plane 3 fence BEFORE it asks the manager for the
 * inventory, and the live-unmanaged-endpoint check runs after that. The refusal's catch aborted the
 * manager's fence and cleared the intent, and its comment promised "a running, unfenced mesh" - but
 * it never started the daemon it had stopped, so the mesh it left could not spawn, retire or join
 * until the next `cotal up`. `cotal status` read "Delivery responder: NOT BOUND". The refusal was
 * also a bare Error, reported as an unknown outcome with no next step.
 *
 * Driven through the REAL command, as a subprocess, against a REAL static-auth broker (the
 * sibling probe in up-restore-reentry-live boots `--open`, where no delivery daemon exists, so it
 * cannot see this):
 *
 *  1. CONTROL - boot a static-auth stack and prove its delivery daemon is running.
 *  2. CONTROL - an endpoint the manager did not spawn joins the roster with its own minted creds.
 *  3. SUBJECT - the cut refuses as a classified refusal (exit 2, a Next line, no unknown outcome),
 *     the manager answers `ps` unfenced, and the delivery daemon is running again.
 *
 * Sandboxes COTAL_HOME under a scratch base with proven-clean `.cotal` ancestry; kills only its own
 * children. Needs `nats-server` on PATH. Run: pnpm smoke:down-preserve-refusal:live
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { CotalEndpoint, mintCreds, mintLifecycleUid, newIdentity, provisionAgent } from "@cotal-ai/core";
import { getSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { makeScratch, assertScratchHeld } from "../../../bin/smoke/_scratch.js";

const scratch = makeScratch("cotal-down-preserve-refusal-");
const home = mkdtempSync(join(scratch, "home-"));
const root = mkdtempSync(join(scratch, "root-"));
const configDir = join(home, "xdg");
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
process.env.COTAL_HOME = home;

const WT = resolvePath(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");
const coreDist = join(WT, "packages", "core", "dist", "index.js");

// An endpoint the manager did not spawn: the idle-endpoint shape from up-restore-reentry-live, with
// the creds this smoke minted for it (a static-auth broker admits nothing bare).
const UNMANAGED_CHILD = [
  "const{pathToFileURL}=require('node:url');const{readFileSync}=require('node:fs');",
  "import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,",
  "creds:readFileSync(process.env.CREDS_FILE,'utf8'),lifecycleUid:process.env.LIFECYCLE_UID,",
  "channels:[],consume:false,registerPresence:true,watchPresence:false,",
  "card:{id:process.env.CARD_ID,name:process.env.COTAL_NAME,kind:'agent',role:'worker'}});",
  "ep.on('error',()=>{});await ep.start();setInterval(()=>{},1000);});",
].join("");

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The ambient environment with every `COTAL_` key stripped, then this smoke's own sandbox put back
 *  (see up-restore-reentry-live for why: the child is the real CLI, and a caller's live mesh would
 *  otherwise pass as this sandbox). Enforced by bin/smoke/suite-ambient-env.smoke.ts. */
const baseEnv = (() => {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) if (key.startsWith("COTAL_")) delete copy[key];
  return { ...copy, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
})();

/** Blocking `cotal <args>`, the way an operator runs it. */
function runSync(args: string[], extraEnv: Record<string, string> = {}) {
  const options = { cwd: root, env: { ...baseEnv, ...extraEnv }, encoding: "utf8" as const, timeout: 240_000 };
  assertSmokeSandboxDown(sandbox, args, options);
  return spawnSync(TSX, [CLI, ...args], options);
}
const tail = (r: { stdout?: string; stderr?: string }) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

let bystander: ReturnType<typeof spawn> | undefined;
try {
  mkdirSync(join(root, ".cotal"), { recursive: true });
  assertScratchHeld(root, "down preserve refusal fixture");
  // The in-process reads below (the folder's creds, the delivery record) resolve the root from cwd,
  // as the command does.
  process.chdir(root);
  const { deliveryUp } = await import("../src/lib/delivery-proc.js");
  const { readPresenceWithoutConsumer } = await import("../src/commands/down.js");

  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "preserve_alpha";

  console.log("1) CONTROL: a static-auth stack with its delivery daemon running");
  const first = runSync(["up", "--detach", "--server", server, "--space", space]);
  ok("the static-auth boot exited 0", first.status === 0, tail(first).slice(-1500));
  let railsUp = false;
  for (let i = 0; i < 30 && !railsUp; i++) {
    if (runSync(["channel", "set", "railprobe", "--desc", "rails", "--space", space]).status === 0) railsUp = true;
    else await sleep(5_000);
  }
  ok("the manager answers on the ep rails before the cut", railsUp);
  let deliveryBefore = false;
  for (let i = 0; i < 30 && !deliveryBefore; i++) {
    if (deliveryUp(space, root)) deliveryBefore = true;
    else await sleep(1_000);
  }
  ok("the delivery daemon is running before the cut", deliveryBefore);

  console.log("\n2) CONTROL: an endpoint the manager did not spawn joins the roster");
  const auth = await getSpaceAuth(workspaceSecretStore(root), space);
  ok("the folder holds the space's signer", auth !== undefined);
  // Provisioned for real (its dm_ durable must exist: presence is refused for an incarnation whose
  // uid has no provisioned resources, SPEC 13.1), by a one-shot provisioner endpoint, not by the
  // manager - that is what makes it unmanaged.
  const identity = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  const credsFile = join(root, "bystander.creds");
  const provisioner = new CotalEndpoint({ space, servers: server, creds: await mintCreds(auth!, newIdentity(), "provisioner"), channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
  provisioner.on("error", () => {});
  await provisioner.start();
  try { writeFileSync(credsFile, await provisionAgent(provisioner, auth!, identity, { lifecycleUid }), { mode: 0o600 }); }
  finally { await provisioner.stop(); }
  const bystanderLog = join(scratch, "bystander.log");
  const bystanderOut = openSync(bystanderLog, "a");
  bystander = spawn(process.execPath, ["-e", UNMANAGED_CHILD], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", CORE_DIST: coreDist, COTAL_SPACE: space, COTAL_SERVERS: server, COTAL_NAME: "bystander", CREDS_FILE: credsFile, LIFECYCLE_UID: lifecycleUid, CARD_ID: identity.id },
    stdio: ["ignore", bystanderOut, bystanderOut],
    detached: true,
  });
  bystander.unref();
  let onRoster = false;
  let names: string[] = [];
  for (let i = 0; i < 30 && !onRoster; i++) {
    const observed = await readPresenceWithoutConsumer(space, server);
    names = observed.roster.map((presence) => presence.card.name);
    if (names.includes("bystander")) onRoster = true;
    else await sleep(1_000);
  }
  ok("the unmanaged endpoint reaches the roster", onRoster, { names, child: readFileSync(bystanderLog, "utf8").slice(-1500) });

  console.log("\n3) SUBJECT: the refused cut names its refusal and leaves the delivery daemon running");
  const refused = runSync(["down", "--preserve-state"]);
  const log = tail(refused);
  ok("a live unmanaged endpoint refuses the cut",
    refused.status !== 0 && /cannot preserve while unmanaged endpoints are live: bystander/.test(log),
    { status: refused.status, log: log.slice(-1500) });
  let deliveryAfter = false;
  for (let i = 0; i < 45 && !deliveryAfter; i++) {
    if (deliveryUp(space, root)) deliveryAfter = true;
    else await sleep(1_000);
  }
  ok("the refused cut leaves the delivery daemon running (started again after the fence)", deliveryAfter, log.slice(-1500));
  ok("…and the refusal said it started the daemon again", /delivery daemon started again after the refused cut/.test(log), log.slice(-1500));
  ok("the refusal is classified (exit 2), not an unknown outcome",
    refused.status === 2 && !/OPERATION_UNKNOWN|Outcome unconfirmed/.test(log), { status: refused.status, log: log.slice(-1500) });
  ok("the refusal carries its next step", /run `cotal down --preserve-state` again/.test(log), log.slice(-1500));
  const ps = runSync(["ps", "--space", space, "--server", server]);
  ok("the refused prepare leaves the manager answering ps, not fenced",
    ps.status === 0 && !/preserving mode/.test(tail(ps)), { status: ps.status, log: tail(ps).slice(-1200) });

  console.log(`\nDOWN PRESERVE REFUSAL SMOKE OK ✅  (${pass} passed)`);
} catch (e) {
  console.error("  ✗ FAIL:", (e as Error).message);
  process.exitCode = 1;
} finally {
  if (bystander?.pid) try { process.kill(bystander.pid, "SIGKILL"); } catch { /* already gone */ }
  try { runSync(["down"]); } catch { /* best effort */ }
  await sleep(500);
  // Every runtime record this root holds, matched by shape (space-keyed and the older root-scoped
  // spelling), as the sibling probe does.
  for (const name of readdirSync(join(root, ".cotal")).filter((n) => /^(nats|manager|delivery)\.([^.]+\.)?pid$/.test(n))) {
    const pid = Number.parseInt(readFileSync(join(root, ".cotal", name), "utf8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  rmSync(scratch, { recursive: true, force: true });
}
