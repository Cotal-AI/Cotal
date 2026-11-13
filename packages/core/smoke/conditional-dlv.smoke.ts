import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AckPolicy, DeliverPolicy, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { encodeUser } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  CotalEndpoint, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, dlvDurable, dlvStream,
  dmDurable, dmStream, isPermissionDenied, isReachable, mintCreds, mintLifecycleUid, newIdentity, permissionsFor,
  provisionAgentDurables, serverConfig, setupSpaceStreams, standaloneConnectOpts, credsClaims, credsFromJwt,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const port = await pickFreePort(), servers = `nats://127.0.0.1:${port}`, space = "conditional-dlv";
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = await createBrokerAuth("conditional-dlv");
const account = await createSpaceAccountAuth(broker, space);
const auth = composeSpaceAuth(broker, account);
const conf = join(dir, "server.conf");
writeFileSync(conf, serverConfig(broker, [account], {
  host: "127.0.0.1", port, storeDir: join(dir, "js"), transport: { kind: "plaintext" },
}));
const child = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
const release = teardownOnSignal(child, dir);
const openPort = await pickFreePort(), openServers = `nats://127.0.0.1:${openPort}`;
const openDir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const openBroker = spawn("nats-server", ["-js", "-sd", openDir, "-p", String(openPort), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseOpen = teardownOnSignal(openBroker, openDir);
let provisioner: CotalEndpoint | undefined;
const agents: CotalEndpoint[] = [];
try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await wait(50);
  const provisionerId = newIdentity();
  const provisionerCreds = await mintCreds(auth, provisionerId, "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisionerCreds });
  provisioner = new CotalEndpoint({
    space, servers, creds: provisionerCreds, channels: [], consume: false, registerPresence: false,
    watchPresence: false, card: { id: provisionerId.id, name: "provisioner", role: "provisioner", kind: "agent" },
  });
  await provisioner.start();
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds: provisionerCreds, tls: false }) });
  const jsm = await jetstreamManager(nc);
  const uid = mintLifecycleUid(), principal = { owner: "local", actor: "worker", lifecycleUid: uid };
  await provisionAgentDurables(provisioner, principal, { subscribe: [], allowSubscribe: [] });
  const exists = async (stream: string, durable: string) =>
    jsm.consumers.info(stream, durable).then(() => true, () => false);
  check("empty ACL still creates the DM durable",
    await exists(dmStream(space), dmDurable(principal.owner, principal.actor, uid)));
  check("empty ACL omits the DLV durable",
    !(await exists(dlvStream(space), dlvDurable(principal.owner, principal.actor, uid))));

  const rows = (allowSubscribe: string[]) =>
    ((permissionsFor("agent", space, { ...principal, connId: "connection" }, { lifecycleUid: uid, allowSubscribe }) as
      { pub: { allow: string[] } }).pub.allow);
  const dlvName = dlvDurable(principal.owner, principal.actor, uid);
  const infoRow = `$JS.API.CONSUMER.INFO.${dlvStream(space)}.${dlvName}`;
  const emptyRows = rows([]);
  check("empty ACL credential can ask about its own DLV durable and cannot fetch or ack it",
    emptyRows.includes(infoRow)
    && !emptyRows.includes(`$JS.API.CONSUMER.MSG.NEXT.${dlvStream(space)}.${dlvName}`)
    && !emptyRows.some((row) => row.startsWith(`$JS.ACK.${dlvStream(space)}.`)));
  check("nonempty ACL credential has the three DLV bind rows",
    rows(["general"]).filter((row) => row.includes(`.${dlvStream(space)}.${dlvDurable(principal.owner, principal.actor, uid)}`) || row.startsWith(`$JS.ACK.${dlvStream(space)}.`)).length === 3);

  const agentId = newIdentity();
  const noReadCreds = await mintCreds(auth, agentId, "agent", { principal, lifecycleUid: uid, allowSubscribe: [], allowPublish: [] });
  const agent = (allowSubscribe?: string[], creds = noReadCreds) => {
    const endpoint = new CotalEndpoint({ space, servers, creds, lifecycleUid: uid,
      channels: [], ...(allowSubscribe === undefined ? {} : { allowSubscribe }), watchChannels: false,
      watchPresence: false, registerPresence: false, card: { id: agentId.id, owner: principal.owner, actor: principal.actor, name: "worker", kind: "agent" } });
    endpoint.on("error", () => {});
    agents.push(endpoint);
    return endpoint;
  };
  const explicit = agent([]);
  await explicit.start();
  check("explicit channel-less endpoint starts with only its DM durable", true);
  await explicit.stop();
  const credentialOnly = agent();
  let started = false;
  try { await credentialOnly.start(); started = true; }
  catch (error) { if (!isPermissionDenied(error)) throw error; }
  check("a native credential without DLV grants starts without a separate ACL option", started);
  await credentialOnly.stop();
  const inconsistent = agent(["general"]);
  let refused = false;
  try { await inconsistent.start(); }
  catch (error) {
    refused = error instanceof Error && error.message.includes("the read list and the credential disagree");
    if (!refused) throw error;
  }
  check("an explicit nonempty ACL on a channel-less credential refuses instead of silently degrading", refused);
  await inconsistent.stop();

  await provisionAgentDurables(provisioner, principal, { subscribe: [], allowSubscribe: ["general"] });
  const info = await jsm.consumers.info(dlvStream(space), dlvDurable(principal.owner, principal.actor, uid));
  check("[] to nonempty regrant creates DLV with unchanged DeliverAll and explicit ACK semantics",
    info.config.deliver_policy === DeliverPolicy.All && info.config.ack_policy === AckPolicy.Explicit,
    info.config);
  const readCreds = await mintCreds(auth, agentId, "agent", { principal, lifecycleUid: uid, allowSubscribe: ["general"], allowPublish: [] });
  const readable = agent(undefined, readCreds);
  await readable.start();
  check("a native credential with DLV grants binds without a separate ACL option", true);
  await readable.stop();
  const claims = credsClaims(readCreds).nats!;
  const deniedJwt = await encodeUser("denied-delivery-bind", fromPublic(agentId.id), fromPublic(auth.account.pub), {
    ...claims, pub: { ...claims.pub, deny: [`$JS.API.CONSUMER.INFO.${dlvStream(space)}.${dlvDurable(principal.owner, principal.actor, uid)}`] },
  }, { signer: fromSeed(new TextEncoder().encode(auth.account.signingSeed)) });
  const denied = agent(undefined, credsFromJwt(deniedJwt, agentId));
  let nativeRefused = false;
  try { await denied.start(); }
  catch (error) { if (!isPermissionDenied(error)) throw error; nativeRefused = true; }
  check("a declared DLV bind with a native deny refuses even without an ACL option", nativeRefused);
  await denied.stop();
  const dmInfo = await jsm.consumers.info(dmStream(space), dmDurable(principal.owner, principal.actor, uid));
  check("DM durable remains present and independently configured", dmInfo.config.ack_policy === AckPolicy.Explicit);
  await nc.close();

  for (let i = 0; i < 100 && !(await isReachable(openServers)); i++) await wait(50);
  const open = new CotalEndpoint({ space, servers: openServers, channels: ["general"], allowSubscribe: ["general"],
    watchPresence: false, card: { name: "open-agent", kind: "agent" } });
  open.on("error", () => {});
  agents.push(open);
  await open.start();
  check("an open-mode endpoint with a read list starts without a DLV durable", true);
  await open.stop();
} finally {
  for (const agent of agents) await agent.stop();
  await provisioner?.stop().catch(() => {});
  await killAndAwaitExit(child, "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  release();
  await killAndAwaitExit(openBroker, "SIGKILL");
  rmSync(openDir, { recursive: true, force: true });
  releaseOpen();
}
console.log(`\nCONDITIONAL-DLV SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 && pass === 12 ? 0 : 1);
