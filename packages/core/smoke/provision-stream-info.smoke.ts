/**
 * `permissionsFor`'s agent-profile `$JS.API.STREAM.INFO` grant is ROLE-SCOPED on TASK and absent on
 * DM/DLV/EPC — proven end to end against a real JWT-auth nats-server, both polarities:
 *
 *   - a role-carrying agent (`role: "board"`) reads TASK stream state, because `STREAM.INFO.TASK`
 *     now sits inside the same `if (svcD)` gate as its other TASK grants;
 *   - a role-less agent — the default agent shape — reads NOTHING on TASK, so the role gate is the
 *     thing granting it, not the agent profile;
 *   - neither one reads DM, DLV, or EPC stream state. `subjects_filter` is a REQUEST-BODY field no
 *     ACL can narrow, so a `STREAM.INFO` there enumerates DM/delivery subject metadata (who DMed
 *     whom) across peers, and no agent-side caller needs it: DM and DLV are reached through a
 *     pre-created durable by name, EPC through a subject-scoped DIRECT.GET.
 *   - the consumer-create deny triple on DM/TASK/DLV survives all of it.
 *
 * Run: pnpm smoke:provision-stream-info
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import {
  isReachable,
  createSpaceAuth,
  mintCreds,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  seedChannelRegistry,
  provisionAgent,
  mintLifecycleUid,
  jwtFromCreds,
  CotalEndpoint,
  dmStream,
  dlvStream,
  taskStream,
} from "../src/index.js";
import { epcStreamName, ensureContractStore } from "../src/endpoint-binding.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

/** A denied STREAM.INFO must be denied by the ACL, not by the stream being absent — every stream
 *  probed here is created above, so "Permissions Violation" is the only shape a deny cell accepts. */
async function streamInfo(jsm: JetStreamManager, stream: string): Promise<{ ok: boolean; denied: boolean; msg?: string }> {
  try {
    await jsm.streams.info(stream);
    return { ok: true, denied: false };
  } catch (e) {
    const msg = (e as Error).message;
    return { ok: false, denied: /Permissions Violation/i.test(msg), msg };
  }
}

const streamInfoRows = (creds: string): string[] => {
  const jwt = jwtFromCreds(creds)!;
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as {
    nats?: { pub?: { allow?: string[] } };
  };
  return (payload.nats?.pub?.allow ?? []).filter((s) => s.startsWith("$JS.API.STREAM.INFO"));
};

const space = `stinfo-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const conns: NatsConnection[] = [];

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const DM = dmStream(space), TASK = taskStream(space), DLV = dlvStream(space), EPC = epcStreamName(space);

  const provId = newIdentity();
  const provCreds = await mintCreds(auth, provId, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
  await seedChannelRegistry({ servers: SERVERS, space, creds: provCreds, file: { channels: { general: {} } } });
  // The EPC contract store is not part of `setupSpaceStreams`; create it so the EPC deny cell below
  // reads a real stream and cannot pass on a stream-not-found.
  const provNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(provCreds)),
    inboxPrefix: `_INBOX_${provId.id}`,
  });
  conns.push(provNc);
  await ensureContractStore(await jetstreamManager(provNc), space);

  const prov = new CotalEndpoint({
    space, servers: SERVERS, creds: provCreds,
    card: { id: provId.id, name: "prov", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
  });
  await prov.start();

  const boardId = newIdentity();
  const boardCreds = await provisionAgent(prov, auth, boardId, {
    allowSubscribe: ["general"], allowPublish: [], role: "board", lifecycleUid: mintLifecycleUid(),
  });
  // The default agent shape: same profile, no role. Everything TASK-side must be off for it.
  const plainId = newIdentity();
  const plainCreds = await provisionAgent(prov, auth, plainId, {
    allowSubscribe: ["general"], allowPublish: [], lifecycleUid: mintLifecycleUid(),
  });
  await prov.stop();

  // ---- the grant, off the credentials themselves ----
  const boardRows = streamInfoRows(boardCreds), plainRows = streamInfoRows(plainCreds);
  check("STREAM.INFO TASK is granted in the role-carrying JWT", boardRows.includes(`$JS.API.STREAM.INFO.${TASK}`), boardRows);
  check("STREAM.INFO TASK is absent from the role-less JWT (the row is role-gated)",
    !plainRows.includes(`$JS.API.STREAM.INFO.${TASK}`), plainRows);
  for (const [label, stream] of [["DM", DM], ["DLV", DLV], ["EPC", EPC]] as const) {
    check(`STREAM.INFO ${label} is granted to neither JWT`,
      !boardRows.includes(`$JS.API.STREAM.INFO.${stream}`) && !plainRows.includes(`$JS.API.STREAM.INFO.${stream}`),
      { boardRows, plainRows });
  }
  check("no STREAM.INFO grant was widened to a wildcard",
    ![...boardRows, ...plainRows].some((s) => s.includes("*") || s.endsWith(">")), { boardRows, plainRows });

  const open = async (creds: string, id: string) => {
    const nc = await connect({
      servers: SERVERS,
      authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
      inboxPrefix: `_INBOX_${id}`,
      maxReconnectAttempts: 0,
    });
    conns.push(nc);
    return jetstreamManager(nc);
  };
  const boardJsm = await open(boardCreds, boardId.id);
  const plainJsm = await open(plainCreds, plainId.id);

  // ---- polarity 1: the role opens TASK, and only TASK ----
  const taskOk = await streamInfo(boardJsm, TASK);
  check("STREAM.INFO TASK succeeds for the role-carrying agent", taskOk.ok, taskOk.msg);
  for (const [label, stream] of [["DM", DM], ["DLV", DLV], ["EPC", EPC]] as const) {
    const r = await streamInfo(boardJsm, stream);
    check(`STREAM.INFO ${label} is denied to the role-carrying agent (no subject enumeration)`, r.denied, r.msg);
  }

  // ---- polarity 2: without a role there is no TASK reach at all ----
  const taskDenied = await streamInfo(plainJsm, TASK);
  check("STREAM.INFO TASK is denied to the role-less agent (the role gate is what grants it)", taskDenied.denied, taskDenied.msg);
  for (const [label, stream] of [["DM", DM], ["DLV", DLV], ["EPC", EPC]] as const) {
    const r = await streamInfo(plainJsm, stream);
    check(`STREAM.INFO ${label} is denied to the role-less agent`, r.denied, r.msg);
  }

  // ---- polarity 3: the consumer-create deny triple is untouched by any of it ----
  for (const [label, stream] of [["DM", DM], ["TASK", TASK], ["DLV", DLV]] as const) {
    let denied = false;
    try { await boardJsm.consumers.add(stream, { durable_name: "hostile" }); } catch (e) {
      denied = /Permissions Violation/.test((e as Error).message);
    }
    check(`CONSUMER.CREATE ${label} still denied (the deny triple's intent survives)`, denied);
  }

  console.log(`\nPROVISION STREAM.INFO SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  for (const nc of conns) await nc.drain().catch(() => {});
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
