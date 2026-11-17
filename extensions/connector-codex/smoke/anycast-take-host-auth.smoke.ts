/**
 * The Codex host's drive and steer around a role request's take (SPEC §8.1), live: on a JWT-auth
 * broker with a real delivery daemon, the real host process takes a role request before it drives or
 * steers it. The daemon reaches the broker through a proxy that delays what the broker sends it, so a
 * take is still in flight while the suite's fake app-server starts a turn this host did not start, as
 * the attached TUI does when a human types. A drive whose take outlasts that start sends no
 * `turn/start` into it, and a steer whose take outlasts the host's own turn steers nothing into it:
 * the request goes out once, at that turn's boundary.
 *
 * Run: pnpm smoke:codex-anycast-take-host:auth   (needs `nats-server` on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  CotalEndpoint,
  DEV_OWNER,
  createSpaceAuth,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  serverConfig,
  setupSpaceStreams,
  takeServeFilter,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, skipSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";

if (process.platform === "win32") skipSuite("managed Codex agents are POSIX-only");

const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = `codex-take-${randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (read: () => boolean, ms = 8000): Promise<boolean> => {
  for (const deadline = Date.now() + ms; !read(); ) {
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
  return true;
};
const { check, finish } = createSuite();

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const stops: Array<() => Promise<unknown> | void> = [];
const LOG = join(dir, "fake.log.jsonl");
const mark = (name: string) => join(dir, `mark-${name}`);
type Entry = { ev: string; method?: string; params?: { input?: { text?: string }[] } };
const journal = (): Entry[] => (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry) : []);
const carries = (e: Entry, text: string) =>
  e.ev === "recv" && (e.method === "turn/start" || e.method === "turn/steer") && (e.params?.input ?? []).some((i) => i.text?.includes(text));
/** The fake's turn events and every RPC that carried `text`, in the order the fake saw them. */
const order = (text: string): string[] =>
  journal().filter((e) => ["ownEnd", "foreignStart", "foreignEnd"].includes(e.ev) || carries(e, text)).map((e) => (e.ev === "recv" ? e.method! : e.ev));
let host: ReturnType<typeof spawn> | undefined;

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provCreds });
  const mgr = new CotalEndpoint({ space, servers, creds: provCreds, card: { name: "mgr", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  mgr.on("error", () => {});
  await mgr.start();
  stops.push(() => mgr.stop());

  // What the broker sends the daemon arrives 200 ms late, so a take takes about a second.
  const proxyPort = await freePort();
  const proxy = createServer((client) => {
    const upstream = netConnect(port, "127.0.0.1");
    client.on("data", (d) => upstream.write(d));
    upstream.on("data", (d) => setTimeout(() => { if (!client.destroyed) client.write(d); }, 200));
    const end = () => { client.destroy(); upstream.destroy(); };
    for (const s of [client, upstream]) { s.on("error", end); s.on("close", end); }
  });
  await new Promise<void>((resolve) => proxy.listen(proxyPort, "127.0.0.1", resolve));
  stops.push(() => new Promise((resolve) => proxy.close(() => resolve(undefined))));
  const daemon = new CotalEndpoint({ space, servers: `nats://127.0.0.1:${proxyPort}`, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "delivery", role: "delivery", kind: "endpoint" } });
  daemon.on("error", () => {});
  daemon.on("warning", () => {});
  await daemon.start();
  await daemon.acquireDeliveryLease(0);
  await daemon.startPlane3((owner, uid) => daemon.aclForOwner(owner, uid));
  stops.push(() => daemon.stop());

  const sIdent = newIdentity();
  const sUid = mintLifecycleUid();
  const sender = new CotalEndpoint({ space, servers, creds: await provisionAgent(mgr, auth, sIdent, { subscribe: [], allowSubscribe: [], allowPublish: [], lifecycleUid: sUid }), card: { name: "sender", kind: "agent", id: sIdent.id }, channels: [], lifecycleUid: sUid });
  sender.on("error", () => {});
  await sender.start();
  stops.push(() => sender.stop());

  // Every take on the wire, so a turn can start while one is in flight.
  const takes: number[] = [];
  const watchNc = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, newIdentity(), "delivery"))), maxReconnectAttempts: 0 });
  stops.push(() => watchNc.close());
  watchNc.subscribe(takeServeFilter(space), { callback: () => { takes.push(Date.now()); } });
  await watchNc.flush();

  const ident = newIdentity();
  const uid = mintLifecycleUid();
  const credsFile = join(dir, "seat.creds");
  writeFileSync(credsFile, await provisionAgent(mgr, auth, ident, { subscribe: [], allowSubscribe: [], allowPublish: [], role: "coder", lifecycleUid: uid }), { mode: 0o600 });
  const BIN = join(dir, "fake-codex");
  writeFileSync(BIN, `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("./fake-codex.mjs", import.meta.url))}" "$@"\n`);
  chmodSync(BIN, 0o755);
  // Scrub any ambient COTAL_* so the host sees only the identity this suite assigns.
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) if (k.startsWith("COTAL_")) delete cleanEnv[k];
  host = spawn(fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url)), [fileURLToPath(new URL("../src/host-main.ts", import.meta.url))], {
    env: {
      ...cleanEnv,
      COTAL_SPACE: space,
      COTAL_NAME: "codex_seat",
      COTAL_ID: ident.id,
      COTAL_SERVERS: servers,
      COTAL_ROLE: "coder",
      COTAL_CREDS: credsFile,
      COTAL_LIFECYCLE_UID: uid,
      COTAL_CODEX_BIN: BIN,
      COTAL_CODEX_HOME: dir,
      FAKE_CODEX_LOG: LOG,
      COTAL_MODEL: "fake-model",
      COTAL_VARIANT: "high",
      FAKE_CODEX_END_MARK: mark("own-end"),
      FAKE_CODEX_FOREIGN_MARK: mark("foreign"),
      FAKE_CODEX_FOREIGN_END: mark("foreign-end"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const hostLog: string[] = [];
  host.stderr!.on("data", (d) => hostLog.push(String(d)));
  const seatId = `${DEV_OWNER}.${ident.id}`;
  const ready = await until(() => journal().some((e) => e.ev === "recv" && e.method === "thread/start") && sender.getRoster().some((p) => p.card.id === seatId), 30_000);
  if (!ready) throw new Error(`the host did not come up: ${hostLog.join("").slice(-1500)}`);
  await sleep(1000);

  // ── 1. a drive whose take outlasts the start of a turn this host did not start ────────────
  console.log("[1] a drive whose take is in flight when another turn starts waits for that turn's boundary");
  let before = takes.length;
  await sender.anycastAttributed("coder", "DRIVE-WINDOW request");
  await until(() => takes.length > before, 10_000);
  writeFileSync(mark("foreign"), "1");
  await sleep(3000);
  writeFileSync(mark("foreign-end"), "1");
  await until(() => journal().some((e) => carries(e, "DRIVE-WINDOW")), 10_000);
  await sleep(1000);
  const drive = order("DRIVE-WINDOW");
  check(
    "1a the drive sends no turn/start while the other turn runs, and starts one at its boundary",
    drive.indexOf("turn/start") > drive.indexOf("foreignEnd") && drive.indexOf("foreignEnd") > drive.indexOf("foreignStart"),
    drive,
  );
  check("1b the request is carried once", drive.filter((m) => m === "turn/start" || m === "turn/steer").length === 1, drive);

  // ── 2. a steer whose take outlasts the host's own turn ────────────────────────────────────
  console.log("[2] a steer whose take is in flight when the host's turn ends steers nothing into the next turn");
  rmSync(mark("foreign"), { force: true });
  rmSync(mark("foreign-end"), { force: true });
  await sleep(200);
  await sender.unicast(seatId, "WAITEND the host's own turn");
  await until(() => journal().some((e) => carries(e, "WAITEND the host's own turn")), 10_000);
  await sleep(500);
  before = takes.length;
  await sender.anycastAttributed("coder", "STEER-WINDOW request");
  await until(() => takes.length > before, 10_000);
  writeFileSync(mark("own-end"), "1");
  await until(() => journal().some((e) => e.ev === "ownEnd"), 3000);
  await sleep(100);
  writeFileSync(mark("foreign"), "1");
  await sleep(3000);
  writeFileSync(mark("foreign-end"), "1");
  await until(() => journal().some((e) => carries(e, "STEER-WINDOW") && e.method === "turn/start"), 10_000);
  await sleep(1000);
  const steer = order("STEER-WINDOW");
  check("2a nothing is steered into the turn this host did not start", !steer.includes("turn/steer"), steer);
  check(
    "2b the request is carried once, by the turn started at that turn's boundary",
    steer.filter((m) => m === "turn/start" || m === "turn/steer").length === 1 && steer.indexOf("turn/start") > steer.lastIndexOf("foreignEnd"),
    steer,
  );
} catch (e) {
  check(`scenario threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  if (host && host.exitCode === null) {
    host.kill("SIGTERM");
    await sleep(1500);
    if (host.exitCode === null) host.kill("SIGKILL");
  }
  for (const stop of stops.reverse()) { try { await stop(); } catch { /* ignore */ } }
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  finish();
}
process.exit(process.exitCode ?? 0);
