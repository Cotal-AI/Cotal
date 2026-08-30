/**
 * `permissionsFor`'s agent-profile grant template must include a `$JS.API.STREAM.INFO` grant for
 * every stream family it also emits the consumer-create deny triple for (DM/TASK/DLV), plus the
 * EPC contract store — proven end to end against a real JWT-auth nats-server, both polarities:
 * the read path works, and the deny triple's "no consumer-create" intent survives.
 *
 * Run: pnpm smoke:provision-stream-info
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
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
import { epcStreamName } from "../src/endpoint-binding.js";
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

const space = `stinfo-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

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
  const prov = new CotalEndpoint({
    space, servers: SERVERS, creds: provCreds,
    card: { id: provId.id, name: "prov", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
  });
  await prov.start();

  const boardId = newIdentity();
  const uid = mintLifecycleUid();
  const boardCreds = await provisionAgent(prov, auth, boardId, {
    allowSubscribe: ["general"], allowPublish: [], role: "board", lifecycleUid: uid,
  });
  await prov.stop();

  // The grant, off the credential itself: EPC has no deny triple of its own, so its polarity is
  // a single positive check, alongside the minimality check that no STREAM.INFO grant was widened
  // to a wildcard to get there.
  const jwt = jwtFromCreds(boardCreds)!;
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as {
    nats?: { pub?: { allow?: string[] } };
  };
  const pubAllow = payload.nats?.pub?.allow ?? [];
  check("STREAM.INFO EPC granted in the minted JWT", pubAllow.includes(`$JS.API.STREAM.INFO.${EPC}`), pubAllow);
  check("no STREAM.INFO grant was widened to a wildcard",
    !pubAllow.some((s) => s.startsWith("$JS.API.STREAM.INFO") && s.includes("*")), pubAllow);

  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(boardCreds)),
    inboxPrefix: `_INBOX_${boardId.id}`,
    maxReconnectAttempts: 0,
  });
  const jsm = await jetstreamManager(nc);

  // ---- polarity 1: the read path now works ----
  for (const [label, stream] of [["DM", DM], ["TASK", TASK], ["DLV", DLV]] as const) {
    let threw: string | undefined;
    try { await jsm.streams.info(stream); } catch (e) { threw = (e as Error).message; }
    check(`STREAM.INFO ${label} succeeds`, threw === undefined, threw);
  }

  // ---- polarity 2: the consumer-create deny triple survives ----
  for (const [label, stream] of [["DM", DM], ["TASK", TASK], ["DLV", DLV]] as const) {
    let denied = false;
    try { await jsm.consumers.add(stream, { durable_name: "hostile" }); } catch (e) {
      denied = /Permissions Violation/.test((e as Error).message);
    }
    check(`CONSUMER.CREATE ${label} still denied (the deny triple's intent survives the fix)`, denied);
  }

  await nc.drain().catch(() => {});

  console.log(`\nPROVISION STREAM.INFO SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
