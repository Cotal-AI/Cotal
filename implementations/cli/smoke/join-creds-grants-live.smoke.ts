/** Credential joins diagnose missing read grants and mismatched lifecycles (#6009).
 * Runs the published command entry with credentials minted by `auth mint --provision`,
 * against a real authenticated broker and bound delivery responder. */
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CotalEndpoint, createSpaceAuth, mintCreds, mintLifecycleUid,
  newIdentity, seedChannelRegistry, setupSpaceStreams,
} from "@cotal-ai/core";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { emitSentinel, killAndAwaitExit } from "@cotal-ai/smoke-kit";
import { bootBroker } from "../../manager/smoke/_boot-broker.js";

const tree = resolve(import.meta.dirname, "../../..");
const dir = mkdtempSync(join(tmpdir(), "join-creds-grants-"));
const project = join(dir, "project");
mkdirSync(project);
const space = "join-creds-grants";
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
Object.assign(env, { COTAL_HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_PROMPT: "1", COTAL_TELEMETRY: "off" });
// The parent also writes only this fixture's registry.
process.env.COTAL_HOME = env.COTAL_HOME;
const children = new Set<ChildProcess>();
function cli(...args: string[]) {
  const proc = spawn(process.execPath, ["--import", "tsx", join(tree, "bin/cotal.ts"), ...args], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(proc);
  let text = "";
  proc.stdout.on("data", (b: Buffer) => { text += b.toString(); });
  proc.stderr.on("data", (b: Buffer) => { text += b.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => { children.delete(proc); resolve(code); });
  });
  return { proc, exited, output: () => text.replace(/\x1b\[[0-9;]*m/g, "") };
}
async function until(cond: () => boolean, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(cond(), "CLI did not reach a terminal or ready state before its deadline");
}
let passed = 0;
function check(name: string, condition: boolean, detail?: string) {
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
  passed++;
  console.log(`  ✓ ${name}`);
}

const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
let daemon: CotalEndpoint | undefined;
try {
  saveSpaceAuth(authDir(project), auth);
  recordMesh({ space, server: broker.servers, root: project, mode: "auth", ts: new Date().toISOString() });
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: broker.servers, space, creds: provisioner });
  await seedChannelRegistry({ servers: broker.servers, space, creds: provisioner, file: { channels: { general: {}, "review.code": {} } } });
  daemon = new CotalEndpoint({ space, servers: broker.servers, creds: await mintCreds(auth, newIdentity(), "delivery"), consume: false, registerPresence: false, card: { name: "delivery", kind: "endpoint" } });
  daemon.on("error", () => {});
  await daemon.start();
  const lease = await daemon.acquireDeliveryLease(0);
  await daemon.startPlane3((owner, uid) => daemon!.aclForOwner(owner, uid));
  await daemon.markDeliveryLeaseReady(0, lease);
  check("delivery responder has bound and marked its lease ready", true);

  async function mint(name: string, ...grants: string[]) {
    const file = join(dir, `${name}.creds`);
    const run = cli("auth", "mint", name, "--space", space, "--provision", "--role", "reviewer", ...grants, "--out", file);
    await until(() => run.proc.exitCode !== null);
    const code = await run.exited;
    check(`${name}: real auth mint --provision succeeds`, code === 0, run.output());
    const uid = /^\s*Lifecycle:\s+(\S+)/m.exec(run.output())?.[1];
    assert.ok(uid, "mint did not report its lifecycle UID");
    return { file, uid };
  }
  async function refused(name: string, file: string, uid: string, expected: RegExp) {
    const run = cli("join", "--space", space, "--creds", file, "--lifecycle-uid", uid, "--name", name, "--channel", "general");
    await until(() => run.proc.exitCode !== null);
    const code = await run.exited;
    const out = run.output();
    console.log(`${name}: exit ${code}\n${out}`);
    check(`${name}: classified permission refusal`, code === 2 && /Code: +PERMISSION_DENIED/.test(out), out);
    check(`${name}: names the specific cause and remedy`, expected.test(out), out);
    check(`${name}: does not blame delivery or leak a broker permission error`, !/DELIVERY DAEMON|Permissions Violation|at Object\./i.test(out), out);
  }

  const empty = await mint("no_read");
  await refused("no-read", empty.file, empty.uid, /does not grant read access to #general[\s\S]*--allow-subscribe general/);
  const allowed = await mint("allowed", "--allow-subscribe", "general", "--allow-publish", "general");
  const wrongUid = mintLifecycleUid();
  await refused("wrong-uid", allowed.file, wrongUid, new RegExp(`does not grant inbox access for lifecycle ${wrongUid}[\\s\\S]*lifecycle UID.*mint`));
  const other = await mint("other_channel", "--allow-subscribe", "review.>");
  await refused("other-channel", other.file, other.uid, /does not grant read access to #general[\s\S]*--allow-subscribe general/);

  async function joins(name: string, file: string, uid: string, channel: string) {
    const run = cli("join", "--space", space, "--creds", file, "--lifecycle-uid", uid, "--name", name, "--channel", channel);
    await until(() => run.output().includes("holding presence") || run.proc.exitCode !== null);
    check(`${name}: matching lifecycle and read grant join successfully`, run.proc.exitCode === null && run.output().includes("holding presence"), run.output());
    await killAndAwaitExit(run.proc);
    await run.exited;
  }
  await joins("allowed", allowed.file, allowed.uid, "general");
  // Read grants alone suffice for joining, and wildcard coverage must not be mistaken for denial.
  await joins("wildcard", other.file, other.uid, "review.code");
  const unpaired = cli("join", "--space", space, "--creds", allowed.file);
  await until(() => unpaired.proc.exitCode !== null);
  check("missing lifecycle explains pairing and the provisioning mint", await unpaired.exited === 1 && /lifecycle-paired/.test(unpaired.output()) && /--lifecycle-uid/.test(unpaired.output()) && /auth mint.*--provision/.test(unpaired.output()), unpaired.output());
  emitSentinel({ passed, failed: 0 });
} finally {
  for (const child of children) await killAndAwaitExit(child);
  await daemon?.stop();
  await broker.stop();
  rmSync(dir, { recursive: true, force: true });
}
