/**
 * INSTRUMENT INSTANCE PIN (#397) — `--on <instanceId>` reaches the MINT, so the one-shot operator
 * instrument is issued the exact instance rails for the invocation it was minted for.
 *
 * The defect was a parameter stopping one layer short. The client always routed an
 * instance-addressed request onto the `ep.inst` rail; every serve credential always subscribed it;
 * and the mint site already documented this exact case — `operatorInstrumentCapabilities` says the
 * non-scatter reads stay `one`-only "or `inst` when a resolve pins `--on`". That `inst` case could
 * not happen: the emitter builds an instance row only for a capability carrying an `instanceId`,
 * and nothing upstream ever passed one. `resolveControlTarget` took a profile and no instance, and
 * neither did the mint beneath it. The absence produced no error — just an unminted row, a refused
 * publish, and a client that renders that refusal as a describe timeout. Nothing to notice.
 *
 * The fix threads the instance the resolve already chose down into the mint. It is EXACT-ARITY: the
 * credential gets `ep.inst.<endpoint>.<thatInstance>.<command>` and no wildcard instance is minted
 * anywhere. That is what keeps `inst-route-grant`'s denied arm intact, and CELL 1 below asserts it
 * rather than assuming it — a wildcard row would satisfy every live check in this file while
 * quietly destroying the boundary, so the boundary is checked directly.
 *
 * COVERAGE BOUNDARY, stated so this is not over-read. This suite builds its own inputs: it calls
 * `instancePinnedInstrumentCapabilities` and mints directly. So it proves the GRANT SHAPING and the
 * live rails end to end — a pinned instrument reaches the instance it names, an unpinned one still
 * cannot, and no ordinary credential gains a route. It does NOT prove the CLI actually threads
 * `--on` down to the mint: `agents.ts`/`spawn.ts` → `resolveControlTarget` → `connectOrExit` is
 * covered by typecheck and by the golden flag inventory, not by an executing test. A defect that
 * dropped the argument anywhere along that chain would leave this suite green. Closing it needs a
 * CLI-level `--on` end-to-end against a two-manager mesh; named here rather than left implicit,
 * because "the pin works" and "the flag reaches the pin" are different claims and only the first
 * one is evidenced below.
 *
 * Run: pnpm smoke:instrument-instance-pin
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, DEV_OWNER, EpEnvelopeError,
  resolveService, invokeCommand, permissionsFor,
  instancePinnedInstrumentCapabilities,
  type EpCaller,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, recordMesh } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;

const LIVE_HOST = "broker.cotal.ai";
for (const k of ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE"]) delete process.env[k];
for (const [k, v] of Object.entries(process.env))
  if (typeof v === "string" && v.includes(LIVE_HOST)) throw new Error(`refusing to run: ${k} points at the live broker (${v})`);
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) throw new Error(`this probe only runs against an ephemeral loopback broker; got ${SERVERS}`);
console.log(`broker-url guard: ${SERVERS} is ephemeral loopback; no env var references ${LIVE_HOST}\n`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const space = `pin-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-pin-"));
const mkRoot = (tag: string): string => {
  const r = join(dir, tag);
  mkdirSync(join(r, ".cotal", "agents"), { recursive: true });
  saveSpaceAuth(authDir(r), auth);
  return r;
};
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

type MgrPriv = { managerInstanceId: string };
let m1: InstanceType<typeof Manager> | undefined;
let m2: InstanceType<typeof Manager> | undefined;

// Built the same way inst-route-grant builds it, deliberately: `permissionsFor` is called directly
// rather than through `mintCreds`, so nothing assembles the principal for us — `instrumentEpRows`
// reads `pr.lifecycleUid` and fails loud without it, and the inbox guard needs a connId of at
// least 8 safe characters.
const pubRows = (profile: string, actor: string, opts: Record<string, unknown>): string[] => {
  const pr = {
    owner: DEV_OWNER, actor, connId: `conn${actor.replace(/[^A-Za-z0-9]/g, "")}0000`,
    ...(opts.lifecycleUid ? { lifecycleUid: opts.lifecycleUid as string } : {}),
  };
  const perms = permissionsFor(profile as never, space, pr as never, opts as never) as
    { pub?: { allow?: string[] } };
  return perms.pub?.allow ?? [];
};
const instRows = (rows: string[]): string[] => rows.filter((r) => r.includes(".ep.inst."));

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const root1 = mkRoot("ws1"), root2 = mkRoot("ws2");
  for (const r of [root1, root2]) recordMesh({ space, server: SERVERS, root: r, mode: "auth", ts: new Date().toISOString() });
  m1 = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root1 });
  m2 = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root2 });
  await m1.start();
  await m2.start();
  const IID1 = (m1 as unknown as MgrPriv).managerInstanceId;
  const IID2 = (m2 as unknown as MgrPriv).managerInstanceId;
  check("two managers registered distinct instance ids", IID1 !== IID2, { IID1, IID2 });

  // ---- 1. THE BOUNDARY THIS FIX MUST NOT MOVE -------------------------------------------------
  // Mirrors inst-route-grant's denied arm. A wildcard fix would pass every LIVE check below while
  // destroying exactly this, so it is asserted here too rather than left to another suite.
  console.log("\n1. the denied arm is untouched — no ordinary credential gains an instance route");
  for (const [who, opts] of [
    ["agent/plainagent", { lifecycleUid: "cc11dd22ee33ff4455aa66bb77" }],
    ["agent/spawneragent", { lifecycleUid: "dd11ee22ff33aa4455bb66cc77", capabilities: ["spawn"] }],
  ] as const) {
    const rows = instRows(pubRows("agent", who.split("/")[1], opts as Record<string, unknown>));
    check(`${who} still holds NO instance route`, rows.length === 0, rows.slice(0, 3));
  }
  const unpinnedInstrument = instRows(pubRows("control-caller-privileged", "unpinnedinstr", { lifecycleUid: "aa11bb22cc33dd44ee55ff6677" }));
  check("an instrument minted WITHOUT a pin also holds none (the pin is opt-in, not implicit)",
    unpinnedInstrument.length === 0, unpinnedInstrument.slice(0, 3));

  // ---- 2. THE PIN IS EXACT, NEVER A WILDCARD ---------------------------------------------------
  console.log("\n2. a pinned mint yields EXACT-instance rows only");
  const pinnedRows = instRows(pubRows("control-caller-privileged", "pinnedinstr",
    { lifecycleUid: "bb11cc22dd33ee44ff5566aa77", endpointCapabilities: instancePinnedInstrumentCapabilities("privileged", IID1) }));
  check("it gains instance rows", pinnedRows.length > 0, pinnedRows.length);
  check("EVERY one names the exact instance — no `.ep.inst.*.` wildcard anywhere",
    pinnedRows.every((r) => r.includes(`.ep.inst.manager.${IID1}.`)), pinnedRows.filter((r) => !r.includes(IID1)).slice(0, 3));
  check("it includes the pinned DESCRIBE (without it the resolve that must precede an invoke is refused)",
    pinnedRows.some((r) => r.includes(`.ep.inst.manager.${IID1}.describe.`)), pinnedRows.slice(0, 4));
  check("the pin does NOT reach the other live instance", pinnedRows.every((r) => !r.includes(IID2)), IID2);
  let malformed = "accepted";
  try { instancePinnedInstrumentCapabilities("privileged", "not a valid token!"); } catch { malformed = "refused"; }
  check("a malformed instance id is refused AT MINT, never widened into a subject", malformed === "refused", malformed);

  // ---- 3. LIVE: the pinned instrument works; the unpinned one is the before-state ---------------
  const liveResolve = async (label: string, pin: boolean, iid: string): Promise<{ ok: boolean; why?: string; answered?: string }> => {
    const id = newIdentity(); const uid = mintLifecycleUid();
    const caller: EpCaller = { owner: DEV_OWNER, actor: id.id, uid };
    const creds = await mintCreds(auth, id, "control-caller-privileged", {
      lifecycleUid: uid,
      ...(pin ? { endpointCapabilities: instancePinnedInstrumentCapabilities("privileged", iid) } : {}),
    });
    const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
    try {
      const svc = await resolveService(nc, space, MANAGER_ENDPOINT, caller, { deadlineMs: 8_000, instanceId: iid });
      const reply = await invokeCommand(nc, space, svc, "status", undefined, { deadlineMs: 8_000 });
      return { ok: true, answered: reply.responder.instanceId };
    } catch (e) {
      return { ok: false, why: e instanceof EpEnvelopeError ? `${e.code}` : (e as Error).message.slice(0, 60) };
    } finally { await nc.drain().catch(() => nc.close()); }
  };

  console.log("\n3. live: pinned describe + pinned invoke, on a real two-manager mesh");
  const withPin = await liveResolve("pinned", true, IID1);
  console.log(`   pinned instrument   -> ${withPin.ok ? `OK, answered by ${withPin.answered === IID1 ? "the instance it named" : withPin.answered}` : withPin.why}`);
  check("a PINNED instrument resolves and invokes on the instance rail", withPin.ok, withPin.why);
  check("...and the answer comes from the instance it named, not the class queue",
    withPin.answered === IID1, { want: IID1, got: withPin.answered });
  const pinB = await liveResolve("pinnedB", true, IID2);
  check("the same holds for the OTHER instance (not an artefact of which manager started first)",
    pinB.ok && pinB.answered === IID2, pinB.ok ? pinB.answered : pinB.why);

  // The negative control: the exact state this change fixes. Same code path, same profile, same
  // instance — only the pin removed. It must still fail, or phase 3 proves nothing about the pin.
  const noPin = await liveResolve("unpinned", false, IID1);
  console.log(`   unpinned instrument -> ${noPin.ok ? "OK (UNEXPECTED)" : noPin.why}`);
  check("an UNPINNED instrument still cannot address an instance — the fix is the pin, not the plumbing",
    !noPin.ok, noPin.answered);

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
} finally {
  await m1?.stop().catch(() => {});
  await m2?.stop().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
