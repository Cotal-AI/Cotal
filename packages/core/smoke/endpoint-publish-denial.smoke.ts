/**
 * A broker publish violation on an instance-pinned rail must surface as
 * `permission-denied` naming the refused subject, not as an unanswered deadline.
 * Covers describe AND invoke/`epCall`. Does not mint `ep.inst.*` grants.
 *
 * Run: pnpm smoke:ep-publish-denial:auth
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  compileContract, createSpaceAuth, describeEndpoint, DEV_OWNER, EpEnvelopeError, epCall,
  invokeCommand, isReachable, mintCreds, mintLifecycleUid, newIdentity, serverConfig,
  standaloneConnectOpts, unansweredRequest, type EpCaller, type ResolvedService,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = "eppubdenial";
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const IID = "i".repeat(26);
const empty = compileContract({ root: { type: "null" } });
const DEADLINE_MS = 800;

const caught = async (fn: () => Promise<unknown>): Promise<{ code: string; message: string; elapsed: number; err: unknown }> => {
  const started = Date.now();
  try {
    await fn();
    return { code: "ok", message: "", elapsed: Date.now() - started, err: undefined };
  } catch (e) {
    return {
      code: e instanceof EpEnvelopeError ? e.code : (e as Error).name,
      message: e instanceof Error ? e.message : String(e),
      elapsed: Date.now() - started,
      err: e,
    };
  }
};

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVERS); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");

  const id = newIdentity();
  const uid = mintLifecycleUid();
  const caller: EpCaller = { owner: DEV_OWNER, actor: id.id, uid };
  // Class-rail instrument only. Pinning `ep.inst.*` is out of scope for this cell.
  const creds = await mintCreds(auth, id, "control-caller-privileged", { lifecycleUid: uid });
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });

  console.log("1. a class-rail credential's instance-addressed describe is a refused publish, not silence");
  const describe = await caught(() => describeEndpoint(nc, space, "manager", caller, { deadlineMs: DEADLINE_MS, instanceId: IID }));
  check("describe is permission-denied, not a deadline", describe.code === "permission-denied", describe);
  check("describe names the refused instance-rail subject", describe.message.includes(`.ep.inst.manager.${IID}.describe.`), describe.message.slice(0, 280));
  check("describe settles well inside the deadline (a timeout masquerade waits it out)", describe.elapsed < DEADLINE_MS / 2, describe.elapsed);
  check("describe is not marked unanswered", !unansweredRequest(describe.err), describe.err);

  console.log("2. the same hole on invoke/epCall: a pinned command publish must not wait out the budget");
  const service: ResolvedService = {
    endpoint: "manager",
    owner: DEV_OWNER,
    caller,
    responder: { instanceId: IID, epoch: 1 },
    pinnedInstanceId: IID,
    commands: new Map([["status", {
      command: "status",
      contract: { input: empty, output: empty },
      class: "ephemeral",
      targeted: false,
      modes: [],
      capability: "status",
    }]]),
  };
  const invoke = await caught(() => invokeCommand(nc, space, service, "status", undefined, { deadlineMs: DEADLINE_MS }));
  check("invoke is permission-denied, NOT a deadline", invoke.code === "permission-denied", invoke);
  check("invoke names the refused instance-rail subject", invoke.message.includes(`.ep.inst.manager.${IID}.status.`), invoke.message.slice(0, 280));
  check("invoke settles well inside the deadline", invoke.elapsed < DEADLINE_MS / 2, invoke.elapsed);
  check("invoke is not marked unanswered", !unansweredRequest(invoke.err), invoke.err);
  check("invoke says the responder may be healthy (the wrong conclusion is the expensive one)",
    /REFUSED BY THE BROKER/.test(invoke.message) && /grant is what is missing/.test(invoke.message),
    invoke.message.slice(0, 280));

  const direct = await caught(() => epCall(nc, space, { mode: "inst", instanceId: IID, epoch: 1 }, {
    endpoint: "manager", command: "status", contract: { input: empty, output: empty }, caller,
  }, { deadlineMs: DEADLINE_MS }));
  check("epCall on the inst rail is the same permission-denied, not a second clock",
    direct.code === "permission-denied" && direct.message.includes(`.ep.inst.manager.${IID}.status.`) && direct.elapsed < DEADLINE_MS / 2,
    direct);

  console.log("3. the call's permission watch does not leak a status listener per invoke");
  const listeners = (): number =>
    ((nc as unknown as { protocol?: { listeners?: unknown[] } }).protocol?.listeners ?? []).length;
  check("the internal listener registry is reachable (else this cell proves nothing)",
    Array.isArray((nc as unknown as { protocol?: { listeners?: unknown[] } }).protocol?.listeners), listeners());
  const before = listeners();
  const ROUNDS = 12;
  for (let i = 0; i < ROUNDS; i++)
    await invokeCommand(nc, space, service, "status", undefined, { deadlineMs: DEADLINE_MS }).catch(() => {});
  const after = listeners();
  console.log(`   listeners before=${before} after ${ROUNDS} denied invokes=${after}`);
  check(`${ROUNDS} denied invokes leave the listener count where they found it`, after === before, { before, after });

  await nc.drain().catch(() => nc.close());
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
} finally {
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}

console.log(`\nENDPOINT PUBLISH DENIAL SMOKE ${fail === 0 ? "OK ✅" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
