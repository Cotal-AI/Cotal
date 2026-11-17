/**
 * A retirement removes every durable membership row of the lifecycle it retires (#5638), against a
 * REAL operator-mode nats-server, the REAL authority plane ({@link openAuthAuthorityPlane}) and a
 * REAL delivery daemon. The rows are written by the daemon's own ACL-fenced join, on three shapes
 * the read grant allows: a channel it names, a family it names, and a channel only a wildcard
 * covers. Only the first is a concrete name in the grant.
 *
 *   A. a chat session opened and retired through the plane leaves no membership row of its uid,
 *      and its retirement completes.
 *   B. a managed agent enrolled and prepared for retirement through the plane, by a manager whose
 *      registration the real gate holds, leaves no membership row of its uid.
 *
 * The evictor is the barrier's smoke override: the session never connects, so there is nothing to
 * evict, and eviction is not what this suite measures.
 *
 * Run: pnpm smoke:retire-member-rows:auth   (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import {
  CotalEndpoint, createEndpointStreams, createSpaceAuth, ensureAuthorityStores, epAuthBucket, epgateKey, isReachable, listLifecycleMemberChannels,
  managedRetirementOpId, membersBucket, mintCreds, mintLifecycleUid, newIdentity, principalKey, remoteManagerActors, serverConfig, setupSpaceStreams, standaloneConnectOpts, type EvictionResult,
} from "@cotal-ai/core";
import { deriveOwnerToken, newActorToken, openAuthAuthorityPlane, remoteManagerCurrentRegistrationProof } from "../src/index.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { chatHolderHash } from "../src/chat-session-authority.js";
import { CHAT_PARENT_ACTOR } from "../src/chat-parent-pin.js";
import { grantActor } from "../src/ledger.js";
import { openLifecycleRegistry } from "../src/lifecycle-registry.js";
import { ensureRootCredential } from "../src/root-credential.js";
import type { EvictPrincipal } from "../src/credential-ledger.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, emitSentinel, teardownOnSignal } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra)); }
};

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `rmr${randomUUID().slice(0, 6)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const dir = join(tmp, "state");
mkdirSync(dir, { recursive: true });
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, host: "127.0.0.1", storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);

const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const lines: string[] = [];
const okEvictor: EvictPrincipal = async (principal) => ({ principal, kicked: 0, remaining: 0, verifiedGone: true, scanComplete: true } satisfies EvictionResult);
/** The read grant: one named channel, one named family, one wildcard. */
const READ = ["plain", "rev.>", "wild.*"];
/** The rows the daemon joins: one per shape, and only `plain` is a concrete name in READ. */
const JOINED = ["plain", "rev.>", "wild.x"];

const endpoints: CotalEndpoint[] = [];
const closers: (() => Promise<unknown>)[] = [];
try {
  for (let i = 0; i < 100 && !(await isReachable(SERVERS)); i++) await wait(100);
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provisioner });
  // The stores a real deployment creates at space setup, written as barrier-plane's seed does.
  const writer = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `cotal:auth-mint:${space}`, grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
  closers.push(() => writer.close());
  await ensureAuthorityStores(await jetstreamManager(writer.nc), new Kvm(writer.nc), space);
  await createEndpointStreams(await jetstreamManager(writer.nc), new Kvm(writer.nc), space);

  const daemon = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: true, registerPresence: false, card: { name: "delivery", role: "delivery", kind: "endpoint" } });
  daemon.on("error", () => {});
  await daemon.start();
  endpoints.push(daemon);
  await daemon.startPlane3((owner, lifecycleUid) => daemon.aclForOwner(owner, lifecycleUid));
  const membership = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "delivery"), tls: false }) });
  closers.push(() => membership.close());
  const members = await new Kvm(membership).open(membersBucket(space));

  const plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, identityRoot: dir, dataAccount, log: (l) => lines.push(l), probeEvictor: okEvictor });
  closers.push(() => plane.close());

  // ---- A. a chat session ----
  console.log("A. a chat session retired through the authority plane:");
  // The signed-in human's own interactive row, which every chat session hangs off, and its lifecycle.
  const parentUid = mintLifecycleUid();
  // It is also the spawner B's managed agent is enrolled under.
  grantActor(dir, { owner: OWNER, actor: CHAT_PARENT_ACTOR, scope: ["spawn", "supervise"], allowSubscribe: READ, allowPublish: [], lifecycleUid: parentUid });
  await ensureRootCredential(await openLifecycleRegistry(writer.nc, space), { owner: OWNER, actor: CHAT_PARENT_ACTOR, lifecycleUid: parentUid, managerInstance: "smoke" });
  const holderProof = randomUUID();
  const admitted = await plane.openChatSession({ owner: OWNER, holderHash: chatHolderHash(holderProof), read: READ, post: [], ttlSec: 600 });
  const chatPrincipal = principalKey(OWNER, admitted.actor).key;
  for (const channel of JOINED) await daemon.durableJoinFor(chatPrincipal, channel, admitted.lifecycleUid, { aclFence: true });
  const joined = (await listLifecycleMemberChannels(members, chatPrincipal, admitted.lifecycleUid)).sort();
  check("the rig: the daemon joined the session on a named channel, a named family and a wildcard-covered channel", JSON.stringify(joined) === JSON.stringify([...JOINED].sort()), joined);
  const retired = await plane.retireChatSession({ owner: OWNER, actor: admitted.actor, lifecycleUid: admitted.lifecycleUid, holderProof });
  check("the chat session retires", retired.outcome === "retired", retired);
  const left = await listLifecycleMemberChannels(members, chatPrincipal, admitted.lifecycleUid);
  check("no membership row of the retired session's uid is left, of the 3 it held", left.length === 0, { left, deferred: lines.filter((l) => l.includes("deferred")) });

  // ---- B. a managed agent ----
  console.log("\nB. a managed agent enrolled and prepared for retirement through the authority plane:");
  // One manager registration at the real gate, as managed-agent-enrollment's harness builds it.
  const instanceId = mintLifecycleUid(), managerLifecycleUid = mintLifecycleUid(), serveEpoch = 4, registrationRevision = 9;
  const identities = { supervisor: { id: newIdentity().id }, executor: { id: newIdentity().id }, serve: { id: newIdentity().id }, goalWriter: { id: newIdentity().id }, sessionLedger: { id: newIdentity().id } };
  await (await new Kvm(writer.nc).open(epAuthBucket(space))).put(epgateKey("manager", instanceId), new TextEncoder().encode(JSON.stringify({
    state: "open", principal: `${OWNER}.${remoteManagerActors(instanceId).serve}`, processEpoch: serveEpoch, registrationRevision, generation: 1, nameAuthorityRevision: 0,
  })));
  const registrationProof = remoteManagerCurrentRegistrationProof(dataAccount.signingSeed, OWNER, { space, actor: CHAT_PARENT_ACTOR, instanceId, managerLifecycleUid, identities }, { registrationRevision, processEpoch: serveEpoch });
  const manager = { v: 1 as const, space, actor: CHAT_PARENT_ACTOR, instanceId, managerLifecycleUid, registrationProof, serveEpoch, identities };
  const enrolled = await plane.enrollManagedAgent({
    owner: OWNER, scope: ["supervise"], sentinelCreds: "unused", agentBearerExchangeUrl: "http://127.0.0.1:9/unused",
    request: { ...manager, kind: "manager-managed-agent-enrollment", requestId: `enroll${mintLifecycleUid()}`, target: { actor: "worker", tokenHash: newActorToken().tokenHash, subscribe: [], allowSubscribe: READ, allowPublish: [] } },
  });
  const workerUid = enrolled.material.lifecycleUid;
  const workerPrincipal = principalKey(OWNER, "worker").key;
  for (const channel of JOINED) await daemon.durableJoinFor(workerPrincipal, channel, workerUid, { aclFence: true });
  const workerJoined = (await listLifecycleMemberChannels(members, workerPrincipal, workerUid)).sort();
  check("the rig: the daemon joined the managed agent on the same three shapes", JSON.stringify(workerJoined) === JSON.stringify([...JOINED].sort()), workerJoined);
  const prepared = await plane.prepareManagedAgentRetirement({
    owner: OWNER, scope: ["supervise"],
    request: { ...manager, kind: "manager-managed-agent-prepare-retirement", requestId: `prepare${mintLifecycleUid()}`, target: { owner: OWNER, actor: "worker", lifecycleUid: workerUid }, opId: managedRetirementOpId(workerUid) },
  });
  check("the managed agent's retirement is prepared", prepared.kind === "manager-managed-agent-prepare-retirement" && prepared.target.lifecycleUid === workerUid, prepared);
  const workerLeft = await listLifecycleMemberChannels(members, workerPrincipal, workerUid);
  check("no membership row of the prepared agent's uid is left, of the 3 it held", workerLeft.length === 0, workerLeft);
} catch (e) {
  check(`the scenario ran without throwing: ${(e as Error).message}`, false, (e as Error).stack);
} finally {
  for (const ep of endpoints) await ep.stop().catch(() => {});
  for (const close of closers.reverse()) await close().catch(() => {});
  srv.kill("SIGKILL");
  releaseBroker();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nretire-member-rows: ${pass} passed, ${fail} failed`);
emitSentinel({ passed: pass, failed: fail, cells: pass + fail });
process.exit(fail ? 1 : 0);
