/**
 * A1 end-to-end: a machine joins a broker it does not run.
 *
 * The shape this proves is the whole point, so it is worth stating before the code. An always-on
 * box runs the broker AND the control plane (delivery daemon + manager). Another machine copies
 * the space's trust material, registers the mesh, and from then on its agents are ordinary peers.
 * It elects no lease and runs no daemon, which is not a limitation we tolerate but the design:
 * the manager is a per-space singleton whose lease TTL is 10s and whose renew-failure path tears
 * down its agents and exits, so a laptop holding it would destroy its own agents on any network
 * blip. Hosting agents on a joined machine is Track A2, not this.
 *
 * The two machines are simulated by two roots with two separate COTAL_HOME registries, because a
 * single-home test would silently share the registry and hide exactly the asymmetry under test.
 *
 * Ports are OS-assigned (`pickFreePort`), so this can never touch a real mesh on 4222.
 * Needs `nats-server` on PATH, as the rest of smoke:ci does.
 * Run: pnpm smoke:join-external:live
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hubHome = mkdtempSync(join(tmpdir(), "cotal-hub-home-"));
const joinHome = mkdtempSync(join(tmpdir(), "cotal-join-home-"));
process.env.COTAL_HOME = hubHome;
process.env.COTAL_NO_PROMPT = "1"; // the flag form's fail-loud sentences, never the wizard

// The CLI composition root registers the local-process descriptors (nats/manager/delivery
// pidfiles) that the "joiner runs no daemons" assertion reads. Import it exactly as the binary
// does, or that check has nothing to look at and passes vacuously.
await import("../src/index.js");
const {
  createSpaceAuth, mintCreds, newIdentity, provisionAgent, setupSpaceStreams,
  seedChannelRegistry, CotalEndpoint,
} = await import("@cotal-ai/core");
const {
  authDir, findMesh, loadMeshes, pruneMesh, removeMeshesByRoot, saveSpaceAuth,
} = await import("@cotal-ai/workspace");
const { meshes } = await import("../src/commands/meshes.js");
const { bootBroker } = await import("../../manager/smoke/_boot-broker.js");

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `cotal meshes …` in-process, capturing output and the exit code the operator would get. */
class ExitSignal extends Error {}
async function run(positionals: string[], values: Record<string, unknown>): Promise<{ out: string; code: number }> {
  const lines: string[] = [];
  const [log, err, exit] = [console.log, console.error, process.exit];
  let code = 0;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  process.exit = ((c?: number) => { code = c ?? 0; throw new ExitSignal(); }) as never;
  try {
    await meshes({ positionals, values, raw: [] } as never);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    console.log = log; console.error = err; process.exit = exit;
  }
  return { out: lines.join("\n"), code };
}

const SPACE = "main";
const boxRoot = mkdtempSync(join(tmpdir(), "cotal-box-root-"));
const joinRoot = mkdtempSync(join(tmpdir(), "cotal-join-root-"));
mkdirSync(join(boxRoot, ".cotal"), { recursive: true });
mkdirSync(join(joinRoot, ".cotal"), { recursive: true });

const auth = await createSpaceAuth(SPACE);
const broker = await bootBroker(auth);
const cleanup: Array<() => Promise<void> | void> = [() => broker.stop()];

try {
  // ── the always-on box: provision the space exactly as `cotal up` does ────────────────────────
  saveSpaceAuth(authDir(boxRoot), auth);
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: broker.servers, space: SPACE, creds: provisioner });
  await seedChannelRegistry({ servers: broker.servers, space: SPACE, creds: provisioner }, { channels: { general: {} } });
  console.log(`box: broker + streams up at ${broker.servers}`);

  // ── the joining machine: its OWN registry, and trust material copied over ────────────────────
  // This copy IS the P1 credential posture: the account signing seed lands on the joining
  // machine, which is authority to mint any identity in the space. Deployment-appropriate (one
  // owner, one private overlay), not architecturally right; the auth-callout mint deletes it.
  process.env.COTAL_HOME = joinHome;
  check("the joining machine starts with an empty registry", loadMeshes().length === 0);
  saveSpaceAuth(authDir(joinRoot), auth);

  // ── (iv) the dial policy, and that --force cannot waive it ───────────────────────────────────
  // Guard position is the assertion: --force means "the mesh is down right now", never "ship my
  // credentials across an untrusted network", so it must be refused on BOTH paths.
  const publicPlain = await run(["add", "hostile"], { server: "nats://203.0.113.7:4222", root: joinRoot });
  check("a public plaintext broker is refused", publicPlain.code === 1, publicPlain.out);
  check("  the refusal explains itself", /cannot encrypt|refused/i.test(publicPlain.out), publicPlain.out);
  const publicForced = await run(["add", "hostile"], { server: "nats://203.0.113.7:4222", root: joinRoot, force: true });
  check("--force does NOT waive the dial policy", publicForced.code === 1, publicForced.out);
  check("nothing was recorded for either attempt", findMesh("hostile") === undefined);
  const lanPlain = await run(["add", "cafe"], { server: "nats://192.168.1.10:4222", root: joinRoot });
  check("an RFC1918 address is refused (private is not safe)", lanPlain.code === 1, lanPlain.out);

  // ── (i) the real registration, against the live box broker ───────────────────────────────────
  const added = await run(["add", SPACE], { server: broker.servers, root: joinRoot });
  check("the joining machine registers the box's mesh", added.code === 0, added.out);
  const entry = findMesh(SPACE);
  check("  the record exists", entry !== undefined);
  check("  it points at the box's broker", entry?.server === broker.servers, entry?.server);
  check("  mode is auth (the credless probe proved the broker enforces)", entry?.mode === "auth", entry?.mode);
  check("  origin is manual — nothing here may auto-delete it", entry?.origin === "manual", entry?.origin);

  // ── (ii) an agent on the joining machine is an ordinary first-class peer ─────────────────────
  const boxIdent = newIdentity();
  const joinIdent = newIdentity();
  const supervisor = new CotalEndpoint({
    space: SPACE, servers: broker.servers, creds: await mintCreds(auth, newIdentity(), "supervisor"),
    card: { name: "sup", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false,
  });
  await supervisor.start();
  cleanup.push(() => supervisor.stop());

  const boxCreds = await provisionAgent(supervisor, auth, boxIdent, { subscribe: ["general"], allowSubscribe: ["general"] });
  const joinCreds = await provisionAgent(supervisor, auth, joinIdent, { subscribe: ["general"], allowSubscribe: ["general"] });

  const onBox = new CotalEndpoint({
    space: SPACE, servers: broker.servers, creds: boxCreds,
    card: { name: "on-box", kind: "agent", id: boxIdent.id }, channels: ["general"],
  });
  const onLaptop = new CotalEndpoint({
    space: SPACE, servers: entry!.server, creds: joinCreds,
    card: { name: "on-laptop", kind: "agent", id: joinIdent.id }, channels: ["general"],
  });
  await onBox.start();
  cleanup.push(() => onBox.stop());
  await onLaptop.start();
  cleanup.push(() => onLaptop.stop());

  const heard: string[] = [];
  onBox.on("message", (m: { text?: string }) => { if (m?.text) heard.push(m.text); });
  await wait(300);
  await onLaptop.dm("on-box", "hello from the machine that runs no broker");
  for (let i = 0; i < 40 && !heard.length; i++) await wait(100);
  check("a DM from the joining machine reaches an agent on the box", heard.length > 0, heard);
  check("  and it is the message that was sent", heard[0]?.includes("runs no broker"), heard[0]);

  // ── (iii) the joining machine elected nothing and runs nothing ───────────────────────────────
  for (const pidfile of ["nats.pid", "delivery.pid", "manager.pid"]) {
    check(`the joining root has no ${pidfile}`, !existsSync(join(joinRoot, ".cotal", pidfile)));
  }
  // The invariant that MAKES client-only correct rather than merely convenient: the manager lease
  // is a per-space singleton, so "every machine runs its own manager" is a contradiction, not a
  // configuration. Prove it here so nobody re-opens the question from first principles.
  const leaseA = new CotalEndpoint({
    space: SPACE, servers: broker.servers, creds: await mintCreds(auth, newIdentity(), "supervisor"),
    card: { name: "mgr-a", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false,
  });
  const leaseB = new CotalEndpoint({
    space: SPACE, servers: broker.servers, creds: await mintCreds(auth, newIdentity(), "supervisor"),
    card: { name: "mgr-b", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false,
  });
  await leaseA.start(); cleanup.push(() => leaseA.stop());
  await leaseB.start(); cleanup.push(() => leaseB.stop());
  await leaseA.acquireManagerLease({ holder: leaseA.ref().id, runtime: "pty", root: boxRoot, pid: process.pid });
  let secondRefused = false;
  try {
    await leaseB.acquireManagerLease({ holder: leaseB.ref().id, runtime: "pty", root: joinRoot, pid: process.pid });
  } catch {
    secondRefused = true;
  }
  check("a second manager cannot hold the space's lease (why joiners are client-only)", secondRefused);

  // ── (v) local teardown on the joining machine leaves the box's mesh alone ────────────────────
  // `cotal down` sweeps by root; `pruneMesh` is the liveness sweep. Neither may delete a record
  // describing a mesh on another machine, because nothing here could write it back.
  const swept = removeMeshesByRoot(joinRoot);
  check("a root sweep (cotal down) removes nothing", swept.length === 0, swept);
  check("  the record survives", findMesh(SPACE) !== undefined);
  check("a liveness prune refuses to drop it", pruneMesh(SPACE) === false);
  check("  the record still survives", findMesh(SPACE) !== undefined);

  console.log(`\njoin-external-broker: ${pass} checks passed`);
} finally {
  for (const stop of cleanup.reverse()) {
    try { await stop(); } catch { /* best effort */ }
  }
  for (const dir of [hubHome, joinHome, boxRoot, joinRoot]) rmSync(dir, { recursive: true, force: true });
}
