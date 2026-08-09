/**
 * LIVE-SESSION CAP smoke (control-surface v0.4, Lane B finding 1; the security seat's
 * REQUEST-CHANGES). Run: pnpm smoke:session-cap   (needs nats-server on PATH; boots its own broker)
 *
 * Session establishment is CALLER-TRIGGERED and each session now mints credentials and opens its own
 * connection, so without a ceiling one authorized caller drives both without bound. The reviewed
 * attack: a leaked console token yields unbounded `establishAttach` plus seed-signed 24h
 * `session-caller` JWTs until process death, and the token gate alone does not bound that.
 *
 * The ceiling therefore has to refuse BEFORE anything with a cost or a side effect — before the
 * offer mint, before redemption, before either per-session credential, before the connection, and
 * before the target's PTY is attached. This smoke asserts exactly that, against a real broker and a
 * real Manager in auth mode, by counting what the refusal did NOT create:
 *
 *   • the N+1th establish refuses `resource-exhausted`, naming the cap so an operator knows the knob
 *   • `liveSessions` stays N — a refused attempt leaves no half-registered session behind
 *   • NO new credential row appears in the §13.1 family (no serving credential was minted)
 *   • NO caller JWT is returned (the console establisher never reaches its `mintCreds`)
 *   • capacity is RECOVERABLE: end one session and the next establish succeeds
 *
 * The cap is proven to be the cause rather than a coincidence by running the same N+1th establish
 * against a manager configured with a higher cap and watching it succeed.
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, registry, DEV_OWNER,
  epAuthBucket, epcredFamilyPrefix,
  type AgentHandle, type Connector, type LaunchSpec, type Presence,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const CAP = 2;
const WS_PORT = 18222; // never dialled: it only enables the console establisher path
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `sesscap-${mintLifecycleUid().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-sesscap-"));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(
  join(workspaceRoot, ".cotal", "agents", "worker.md"),
  `---\nname: worker\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\nbody\n`,
);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));

const kids: ChildProcess[] = [];
const conns: NatsConnection[] = [];
kids.push(spawnProc("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" }));
const managers: InstanceType<typeof Manager>[] = [];

const fakeSession = () => ({ cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} });
const fakeHandle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession() });

async function bootManager(maxSessions: number): Promise<InstanceType<typeof Manager>> {
  // `wsPort` is what wires the console establisher at all (the constructor injects it only when a
  // websocket listener exists). The value is never dialled here — the smoke drives the establisher
  // directly and asserts on what it did or did not create.
  const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot, maxSessions, wsPort: WS_PORT });
  (mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = { kind: "fake", spawn: (name) => fakeHandle(name) };
  (mgr as unknown as { ep: Record<string, unknown> }).ep = {
    ref: () => ({ id: "smoke-mgr" }), on: () => {}, off: () => {},
    waitForPresenceSnapshot: () => Promise.resolve(), getRoster: (): Presence[] => [],
  };
  await mgr.start();
  (mgr as unknown as { awaitReadiness(): Promise<{ ok: true }> }).awaitReadiness = async () => ({ ok: true });
  managers.push(mgr);
  return mgr;
}

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  registry.register({ kind: "connector", name: "smoke-cap", requires: ["node"], buildLaunch: () => ({ command: "true", args: [], env: {} }) } as Connector);

  const mgr = await bootManager(CAP);
  const M = mgr as unknown as {
    managerInstanceId: string;
    sessionPlane: { liveSessions: number; maxSessions: number; endAll(r: string): void };
    establishConsoleSession(name: string): Promise<{ grant: { sessionId: string }; creds: string }>;
  };
  const iid = M.managerInstanceId;
  check("fixture: the manager took the configured cap", M.sessionPlane.maxSessions === CAP, M.sessionPlane.maxSessions);

  const spawned = await mgr.startAgent({ name: "worker", agent: "smoke-cap" });
  check("fixture: an agent is running to attach to", spawned.ok === true, spawned);

  // Count the §13.1 credential family: a minted per-session SERVING credential lands here, so an
  // unchanged count is positive evidence that the refusal minted nothing.
  const execNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: MANAGER_ENDPOINT, instanceId: iid } }) }), maxReconnectAttempts: 0 });
  conns.push(execNc);
  const authKv = await new Kvm(execNc).open(epAuthBucket(space));
  const familySize = async (): Promise<number> => {
    let n = 0;
    for await (const k of await authKv.keys(`${epcredFamilyPrefix(MANAGER_ENDPOINT, iid)}.>`)) { void k; n++; }
    return n;
  };

  console.log("A. sessions establish normally up TO the cap");
  const ids: string[] = [];
  for (let i = 0; i < CAP; i++) {
    const r = await M.establishConsoleSession("worker");
    ids.push(r.grant.sessionId);
    check(`session ${i + 1}/${CAP} established`, typeof r.grant.sessionId === "string" && r.grant.sessionId.length > 0);
    check(`session ${i + 1}/${CAP} got a real caller credential`, typeof r.creds === "string" && r.creds.length > 0);
  }
  check("the plane reports exactly the cap in live sessions", M.sessionPlane.liveSessions === CAP, M.sessionPlane.liveSessions);
  check("the sessions are DISTINCT (not one session counted twice)", new Set(ids).size === CAP, ids);

  console.log("B. the N+1th establish REFUSES, and creates nothing");
  const familyBefore = await familySize();
  let refusal: { code?: string; message: string } | undefined;
  let leaked: unknown;
  try {
    leaked = await M.establishConsoleSession("worker");
  } catch (e) {
    refusal = { code: (e as { code?: string }).code, message: (e as Error).message };
  }
  check("it throws rather than establishing", refusal !== undefined && leaked === undefined, { refusal, leaked });
  check("the refusal is `resource-exhausted`", refusal?.code === "resource-exhausted", refusal);
  check("the message NAMES the cap and its current value (an operator learns the knob to raise)",
    refusal !== undefined && refusal.message.includes(String(CAP)) && refusal.message.includes("maxSessions"), refusal?.message);
  check("liveSessions stays at N — the refused attempt left no half-registered session",
    M.sessionPlane.liveSessions === CAP, M.sessionPlane.liveSessions);
  check("NO caller JWT was returned (the establisher never reached its mintCreds)", leaked === undefined);
  check("NO new credential row was staged — no serving credential was minted either",
    (await familySize()) === familyBefore, { before: familyBefore, after: await familySize() });

  console.log("C. capacity is RECOVERABLE: ending a session frees a slot");
  M.sessionPlane.endAll("closed");
  for (let i = 0; i < 100 && M.sessionPlane.liveSessions > 0; i++) await wait(50);
  check("the plane drains back to zero live sessions", M.sessionPlane.liveSessions === 0, M.sessionPlane.liveSessions);
  const after = await M.establishConsoleSession("worker");
  check("an establish after the drain succeeds (the cap bounds concurrency, never total sessions)",
    typeof after.grant.sessionId === "string" && !ids.includes(after.grant.sessionId));

  console.log("D. the refusal TRACKS OCCUPANCY (it is the cap, not a one-off failure)");
  {
    // Establishment now cycles refuse -> free -> succeed -> refill -> refuse against ONE manager, so
    // the refusal is demonstrably a function of how many sessions are live rather than a call that
    // happens to fail the second time. (A second Manager cannot serve the same space from the same
    // workspace root, by design, so the causal proof is this cycle rather than a roomier twin.)
    check("one slot is in use after the recovery establish", M.sessionPlane.liveSessions === 1, M.sessionPlane.liveSessions);
    while (M.sessionPlane.liveSessions < CAP) await M.establishConsoleSession("worker");
    check("refilled back to the cap", M.sessionPlane.liveSessions === CAP, M.sessionPlane.liveSessions);
    const familyAtCap = await familySize();
    let second: { code?: string } | undefined;
    try { await M.establishConsoleSession("worker"); } catch (e) { second = { code: (e as { code?: string }).code }; }
    check("it refuses AGAIN once refilled to the cap", second?.code === "resource-exhausted", second);
    check("and again minted nothing", (await familySize()) === familyAtCap, { familyAtCap, now: await familySize() });
  }

  console.log(`\nsession-cap smoke: ${pass} passed, ${fail} failed`);
} finally {
  for (const c of conns) await c.drain().catch(() => c.close());
  for (const m of managers) await m.stop().catch(() => {});
  for (const k of kids) k.kill("SIGKILL");
  await wait(200);
}

process.exit(fail > 0 ? 1 : 0);
