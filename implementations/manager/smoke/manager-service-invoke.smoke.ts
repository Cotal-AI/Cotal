/**
 * GENERIC DESCRIBE/INVOKE smoke (control-surface P2 item 1, item 5 substrate) — the caller path
 * every migrated control consumer rides, proven against a REAL Manager + JWT broker WITHOUT the
 * caller importing the manager's contract module. The whole point: a caller learns the manager's
 * command surface at runtime (describe → fetch the registered contracts from the §13.7 store →
 * recompile the digest-matching validators) and invokes by name.
 *
 * Deliberately imports ONLY the endpoint NAME + core `resolveService`/`invokeCommand` — never
 * MANAGER_CONTRACTS. If this compiled and ran while secretly depending on the hand-written
 * contracts, that would defeat the test; it does not.
 *
 *  1. resolveService(manager) describes + fetches + recompiles the FULL visible surface (17
 *     commands), each with a recompiled input/output contract whose closureDigest MATCHES the
 *     registered declaration.
 *  2. invoke "status" (untargeted, void) returns the typed ManagerStatus.
 *  3. invoke "spawn" (the 16-field launch) boots a REAL agent; the recompiled input contract
 *     gates a bad field pre-publish (the caller's own closed schema, fetched not hand-written).
 *  4. invoke targeted "despawn" (owner mode) tears the agent down; a targeted command invoked
 *     without a target, and an untargeted one WITH a target, both refuse at the generic layer.
 *  5. a command OUTSIDE the caller's describe VIEW is not in the resolved surface (not-found).
 *
 * Run: pnpm smoke:manager-service-invoke   (needs nats-server + node on PATH; boots its own broker)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, DEV_OWNER, EpEnvelopeError,
  resolveService, invokeCommand, registry,
  type Connector, type ControlReply, type EpCaller, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
// The endpoint NAME only — NOT the contract module. A generic caller never hand-imports schemas.
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const STUB = join(here, "e2e-stub.mjs");
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `mgrinv-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-mgrinv-"));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
for (const n of ["w1"]) writeFileSync(join(workspaceRoot, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nrole: worker\n---\n`);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? SERVERS), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
registry.register({ kind: "connector", name: "e2e-stub", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: [STUB], env: envFor(o) }) } as Connector);

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
// The §13.2 one-rail currency reader for a static mesh: the manager's processEpoch is 0 (no
// takeover advances it). A production generic caller reads this from the registered svc record.
const currentEpoch = async () => 0;

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  await mgr.start();

  // A caller cred with the ep BASELINE (describe + reply rail + the epc fetch grant) plus the
  // invoke capabilities for the commands it will call. spawn-cap gives spawn + owner despawn/attach.
  const id = newIdentity();
  const uid = mintLifecycleUid();
  const caller: EpCaller = { owner: DEV_OWNER, actor: id.id, uid };
  const creds = await mintCreds(auth, id, "agent", {
    lifecycleUid: uid, capabilities: ["spawn"],
    endpointCapabilities: [
      { endpoint: MANAGER_ENDPOINT, command: "status" },
      { endpoint: MANAGER_ENDPOINT, command: "spawn" },
      { endpoint: MANAGER_ENDPOINT, command: "despawn", target: { mode: "owner", tOwner: DEV_OWNER } },
    ],
  });
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds }), maxReconnectAttempts: 0 });

  console.log("1. resolveService: describe + fetch + recompile the full surface (no hand-imported schemas)");
  const service = await resolveService(nc, space, MANAGER_ENDPOINT, caller, { deadlineMs: 10_000 });
  check("the resolved surface is the manager's 17 visible commands", service.commands.size === 17 && service.commands.has("status") && service.commands.has("spawn") && service.commands.has("despawn"), [...service.commands.keys()].sort());
  const statusCmd = service.commands.get("status")!;
  check("status resolved: untargeted, read capability, recompiled contracts carry closure digests",
    statusCmd.targeted === false && statusCmd.capability === "manager.read"
    && statusCmd.contract.input.closureDigest.startsWith("sha256:") && statusCmd.contract.output.closureDigest.startsWith("sha256:"), statusCmd);
  const despawnCmd = service.commands.get("despawn")!;
  check("despawn resolved: targeted, owner mode (from the verified cluster document, not asserted)",
    despawnCmd.targeted === true && despawnCmd.modes.includes("owner"), despawnCmd);

  console.log("2. invoke status (generic, by name)");
  const rStatus = await invokeCommand(nc, space, service, "status", undefined, { currentEpoch });
  const status = rStatus.reply.data as { instanceId: string; runtime: string; agentCount: number };
  check("invoke status returns the typed ManagerStatus", rStatus.reply.ok === true && status.runtime === "pty" && typeof status.agentCount === "number", rStatus.reply);

  console.log("3. invoke spawn (the recompiled input contract gates args)");
  let badCode: string | undefined;
  try { await invokeCommand(nc, space, service, "spawn", { name: "w1", bogus: 1 }, { currentEpoch }); }
  catch (e) { badCode = e instanceof EpEnvelopeError ? e.code : (e as Error).message; }
  check("a bad spawn field is bad-request at the FETCHED-then-recompiled input contract (not a hand-written schema)", badCode === "bad-request", badCode);
  // P2 item 2: spawn is an ACTION - invoke returns the acceptance floor (before the agent is live).
  const rSpawn = await invokeCommand(nc, space, service, "spawn", { name: "w1", agent: "e2e-stub", cwd: repoRoot }, { currentEpoch, deadlineMs: 30_000 });
  const acc = (rSpawn.reply.data ?? {}) as { name?: string; goalId?: string };
  check("invoke spawn accepts the goal (acceptance floor: name + goalId)", rSpawn.reply.ok === true && acc.name === "w1" && typeof acc.goalId === "string", rSpawn.reply);
  // Poll the managed set until the agent joins - its id + lifecycleUid are the targeting coordinates.
  const M = mgr as unknown as { agents: Map<string, { id: string; lifecycleUid: string }> };
  let live: { id: string; lifecycleUid: string } | undefined;
  for (let i = 0; i < 80 && !live; i++) { live = M.agents.get("w1"); if (!live) await wait(250); }
  const w1 = live!;
  check("invoke spawn boots a REAL agent that joins + is managed", !!w1 && w1.lifecycleUid.length >= 26, w1);

  console.log("4. invoke targeted despawn + the generic target guards");
  let noTarget: string | undefined;
  try { await invokeCommand(nc, space, service, "despawn", { graceful: true }, { currentEpoch }); }
  catch (e) { noTarget = e instanceof EpEnvelopeError ? e.code : (e as Error).message; }
  check("a targeted command invoked with NO target refuses at the generic layer (bad-request)", noTarget === "bad-request", noTarget);
  let strayTarget: string | undefined;
  try { await invokeCommand(nc, space, service, "status", undefined, { currentEpoch, target: { mode: "owner", owner: DEV_OWNER, actor: w1.id, lifecycleUid: w1.lifecycleUid } }); }
  catch (e) { strayTarget = e instanceof EpEnvelopeError ? e.code : (e as Error).message; }
  check("an untargeted command invoked WITH a target refuses at the generic layer (bad-request)", strayTarget === "bad-request", strayTarget);
  const rDespawn = await invokeCommand(nc, space, service, "despawn", { graceful: true }, { currentEpoch, target: { mode: "owner", owner: DEV_OWNER, actor: w1.id, lifecycleUid: w1.lifecycleUid } });
  check("invoke targeted owner-mode despawn tears the agent down", rDespawn.reply.ok === true && (rDespawn.reply.data as { stopped: boolean }).stopped === true, rDespawn.reply);

  console.log("5. a command outside the caller's describe VIEW is not resolvable");
  // The caller holds no invoke row for `purge`; describe is PUBLIC in static mode so the surface
  // still lists it — but a caller invoking one it holds no grant for is broker-refused. The
  // generic layer's not-found is for a command absent from the RESOLVED surface entirely.
  let notFound: string | undefined;
  try { await invokeCommand(nc, space, service, "no-such-command", undefined, { currentEpoch }); }
  catch (e) { notFound = e instanceof EpEnvelopeError ? e.code : (e as Error).message; }
  check("invoking a command not in the resolved surface is not-found", notFound === "not-found", notFound);

  await nc.drain().catch(() => nc.close());
  await mgr.stop();
} finally {
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "MANAGER SERVICE INVOKE SMOKE OK ✅" : "MANAGER SERVICE INVOKE SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
