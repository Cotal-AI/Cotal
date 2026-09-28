import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  AUTH_ENDPOINT, EP_CMD_RETIRE_LIFECYCLE, epgateKey, epAuthBucket,
  createEndpointStreams, createSpaceAuth, ensureAuthorityStores, isReachable, DEV_OWNER,
  mintCreds, managedRetirementOpId, mintLifecycleUid, newIdentity, principalKey, serverConfig,
  resolveService, invokeCommand, idFromCreds,
} from "@cotal-ai/core";
import { deriveOwnerToken, openAuthAuthorityPlane } from "../src/index.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { ensureRootCredential } from "../src/root-credential.js";
import { openLifecycleRegistry } from "../src/lifecycle-registry.js";

const MAXP = Number(process.argv[2] ?? 608);
const PORT = 34568;
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `probe2-${randomUUID().slice(0,6)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), "fx116probe2-"));
const dir = join(tmp, "state");
mkdirSync(dir, { recursive: true });
let conf = serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") });
conf += `\nmax_payload: ${MAXP}\n`;
writeFileSync(join(tmp, "server.conf"), conf);
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
let plane, wide;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await new Promise(r=>setTimeout(r,100)); }
  if (!up) throw new Error("broker did not come up");
  const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
  const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
  const MGR_SERVE = newIdentity();
  const MGR = { owner: DEV_OWNER, actor: MGR_SERVE.id, uid: mintLifecycleUid() };
  const MGR_KEY = principalKey(DEV_OWNER, MGR_SERVE.id).key;
  const MGR_INST = mintLifecycleUid();
  const SERVE_EPOCH = 1;

  wide = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: "probe2", grants: (id) => (void id, { publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
  const jsm = await jetstreamManager(wide.nc);
  const kvm = new Kvm(wide.nc);
  await ensureAuthorityStores(jsm, kvm, space);
  await createEndpointStreams(jsm, kvm, space);
  const epKv = await kvm.open(epAuthBucket(space));
  const row = { state: "open", generation: 1, processEpoch: SERVE_EPOCH, registrationRevision: 1, nameAuthorityRevision: 1, principal: MGR_KEY };
  await epKv.put(epgateKey("manager", MGR_INST), new TextEncoder().encode(JSON.stringify(row)));

  plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: () => {} });
  const wreg = await openLifecycleRegistry(wide.nc, space);
  console.log("bootstrap ok, maxPayload:", wide.nc.info.max_payload);

  const uid1 = mintLifecycleUid();
  await ensureRootCredential(wreg, { owner: OWNER, actor: "wprobe", lifecycleUid: uid1, managerInstance: "smoke" });
  const target = { owner: OWNER, actor: "wprobe", lifecycleUid: uid1 };
  const creds = await mintCreds(auth, newIdentity(), "retirement-requester", { retirementRequester: { ...MGR, target } });
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${idFromCreds(creds)}`, maxReconnectAttempts: 0 });
  try {
    console.log("client-side connection maxPayload:", nc.info.max_payload);
    const service = await resolveService(nc, space, AUTH_ENDPOINT, MGR, { deadlineMs: 10_000 });
    console.log("resolveService ok");
    const origPublish = nc.publish.bind(nc);
    let capturedLen = 0;
    nc.publish = (subj, data, opts) => { capturedLen = data.length; return origPublish(subj, data, opts); };
    const resolvedCmd = service.commands.get(EP_CMD_RETIRE_LIFECYCLE);
    console.log("input digest", resolvedCmd.contract.input.closureDigest); console.log("output digest", resolvedCmd.contract.output.closureDigest);
    const opId = managedRetirementOpId(uid1);
    const attributed = await invokeCommand(nc, space, service, EP_CMD_RETIRE_LIFECYCLE,
      { opId, serveEndpoint: "manager", serveInstanceId: MGR_INST, serveEpoch: SERVE_EPOCH },
      { target: { mode: "exact", owner: target.owner, actor: target.actor, lifecycleUid: target.lifecycleUid }, deadlineMs: 8_000 });
    console.log("invokeCommand ok, reply.ok=", attributed.reply.ok, JSON.stringify(attributed.reply.data ?? attributed.reply.error));
    console.log("WIRE_BODY_BYTES", capturedLen);
  } finally {
    await nc.close().catch(()=>{});
  }
} catch (e) {
  console.log("FAILED:", e.message);
} finally {
  await plane?.close().catch(()=>{});
  await wide?.close().catch(()=>{});
  srv.kill("SIGTERM");
  await new Promise(r=>setTimeout(r,300));
  rmSync(tmp, { recursive: true, force: true });
}
