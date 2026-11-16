/**
 * A seat whose DM durable is gone (a broker outage or restore lost it) reconnects with a reason it
 * can act on. On a JWT-auth broker the seat binds the durable its launch created and cannot create
 * one, so `cotal_reconnect` and `cotal_connection_status` name the missing durable and the recovery
 * (restart or respawn the session) instead of a bare "consumer not found" with a promise of retries,
 * and the seat still creates nothing. On an open broker the same reconnect recreates the durable.
 *
 * Run: pnpm smoke:reconnect-missing-inbox:auth   (needs `nats-server` on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  CotalEndpoint,
  DEV_OWNER,
  DmDurableMissingError,
  createSpaceAuth,
  dmDurable,
  dmStream,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  seedChannelRegistry,
  serverConfig,
  setupSpaceStreams,
  standaloneConnectOpts,
} from "../../../packages/core/dist/index.js";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
const tool = async (agent: MeshAgent, config: AgentConfig, name: string) =>
  cotalToolSpecs(config, "smoke").find((s) => s.name === name)!.run(agent, config, {});
const status = async (agent: MeshAgent, config: AgentConfig): Promise<Record<string, unknown>> =>
  JSON.parse((await tool(agent, config, "cotal_connection_status")).text);
const hasDurable = (jsm: Awaited<ReturnType<typeof jetstreamManager>>, stream: string, durable: string) =>
  jsm.consumers.info(stream, durable).then(() => true, () => false);

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const stops: Array<() => Promise<unknown>> = [];
const brokers: Array<ReturnType<typeof spawn>> = [];
const releases: Array<() => void> = [];
const startBroker = (conf: string) => {
  const srv = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
  brokers.push(srv);
  releases.push(teardownOnSignal(srv, dir));
};

try {
  // ── 1. auth mode: the seat names the missing durable and the respawn route ───────────────────
  console.log("[1] an authenticated seat whose DM durable is gone");
  const port = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const space = `missing-inbox-${randomUUID().slice(0, 8)}`;
  const auth = await createSpaceAuth(space);
  writeFileSync(join(dir, "auth.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js-auth") }));
  startBroker(join(dir, "auth.conf"));
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provCreds });
  await seedChannelRegistry({ servers, space, creds: provCreds, file: { defaults: { replay: false } } });
  const mgr = new CotalEndpoint({ space, servers, creds: provCreds, card: { name: "mgr", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  mgr.on("error", () => {});
  await mgr.start();
  stops.push(() => mgr.stop());
  const ident = newIdentity();
  const uid = mintLifecycleUid();
  const creds = await provisionAgent(mgr, auth, ident, { subscribe: [], allowSubscribe: [], allowPublish: [], lifecycleUid: uid });
  // The provisioner is one-shot; the seat outlives it, so nothing below may need it again.
  await mgr.stop();
  const config: AgentConfig = { space, name: "seat", servers, creds, subscribe: [], allowSubscribe: [], allowPublish: [], kind: "agent", tls: false, id: ident.id, lifecycleUid: uid };
  const agent = new MeshAgent(config);
  agent.on("error", () => {});
  stops.push(() => agent.stop());
  await agent.start();
  check("1a the seat starts ready", (await status(agent, config)).state === "ready");

  // A broker restore that lost the durable, staged by the target-pinned teardown credential.
  const stream = dmStream(space);
  const durable = dmDurable(DEV_OWNER, ident.id, uid);
  const teardownCreds = await mintCreds(auth, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: ident.id, lifecycleUid: uid } });
  const teardown = await connect({ servers, ...standaloneConnectOpts({ creds: teardownCreds, tls: false }), maxReconnectAttempts: 0 });
  stops.push(() => teardown.close());
  const jsm = await jetstreamManager(teardown);
  await jsm.consumers.delete(stream, durable);
  check("1b the fixture removed the seat's DM durable", !(await hasDurable(jsm, stream, durable)));

  const reconnect = await tool(agent, config, "cotal_reconnect");
  check(
    "1c cotal_reconnect fails naming the missing inbox, its durable, and restart or respawn",
    reconnect.isError === true && reconnect.text.startsWith("Reconnect failed: this session's direct-message inbox is missing") &&
      reconnect.text.includes(`"${durable}"`) && reconnect.text.includes("Restart this session, or respawn it"),
    reconnect.text,
  );
  check(
    "1d it no longer offers a retry as the remedy",
    !reconnect.text.includes("consumer not found") && !reconnect.text.includes("run /reconnect"),
    reconnect.text,
  );
  const after = await status(agent, config);
  check(
    "1e cotal_connection_status reports the same reason as its connectionIssue",
    after.state === "disconnected" && typeof after.connectionIssue === "string" &&
      after.connectionIssue.includes(`"${durable}"`) && after.connectionIssue.includes("Restart this session, or respawn it"),
    after,
  );
  check(
    "1f the reconnect throws the typed missing-durable error from the endpoint",
    await agent.ep.reconnect().then(() => false, (e: unknown) => e instanceof DmDurableMissingError && e.code === "dm-durable-missing" && e.durable === durable),
  );
  await sleep(500);
  check("1g the seat created no durable of its own", !(await hasDurable(jsm, stream, durable)));

  // ── 2. open mode: the same reconnect recreates the durable ───────────────────────────────────
  console.log("[2] an open-mesh seat whose DM durable is gone");
  const openPort = await pickFreePort();
  const openServers = `nats://127.0.0.1:${openPort}`;
  const openSpace = `missing-inbox-open-${randomUUID().slice(0, 8)}`;
  writeFileSync(join(dir, "open.conf"), `host: 127.0.0.1\nport: ${openPort}\njetstream { store_dir: "${join(dir, "js-open")}" }\n`);
  startBroker(join(dir, "open.conf"));
  await awaitBrokerReady(() => isReachable(openServers), { servers: openServers, attempts: 50, delayMs: 200 });
  await setupSpaceStreams({ servers: openServers, space: openSpace });
  const openConfig: AgentConfig = { space: openSpace, name: "open-seat", servers: openServers, subscribe: [], allowSubscribe: [], allowPublish: [], kind: "agent", tls: false };
  const openAgent = new MeshAgent(openConfig);
  openAgent.on("error", () => {});
  stops.push(() => openAgent.stop());
  await openAgent.start();
  const admin = await connect({ servers: openServers, maxReconnectAttempts: 0 });
  stops.push(() => admin.close());
  const openJsm = await jetstreamManager(admin);
  const openStream = dmStream(openSpace);
  const names: string[] = [];
  for await (const c of openJsm.consumers.list(openStream)) names.push(c.name);
  check("2a the open seat created one DM durable", names.length === 1, names);
  await openJsm.consumers.delete(openStream, names[0]!);
  const openReconnect = await tool(openAgent, openConfig, "cotal_reconnect");
  check("2b cotal_reconnect succeeds", openReconnect.isError !== true && openReconnect.text.startsWith("Reconnected"), openReconnect.text);
  check("2c and the durable exists again", await hasDurable(openJsm, openStream, names[0]!));
  check("2d the seat reports ready with no connection issue", ((s) => s.state === "ready" && !("connectionIssue" in s))(await status(openAgent, openConfig)));
} catch (e) {
  check(`scenario threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  for (const stop of stops.reverse()) { try { await stop(); } catch { /* ignore */ } }
  for (const srv of brokers) { srv.kill("SIGKILL"); await awaitExit(srv); }
  rmSync(dir, { recursive: true, force: true });
  for (const release of releases) release();
  finish();
}
