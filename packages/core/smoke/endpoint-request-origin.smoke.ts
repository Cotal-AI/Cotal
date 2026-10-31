import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, headers } from "@nats-io/transport-node";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { createUser, fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  createSpaceAuth, serverConfig, isReachable, openRecordsBucket,
  registerServiceInstance, authorizeServeGrant, compileContract, contractDigest, VOID_SCHEMA,
  mintLifecycleUid, serveEndpoint, epRequestSubject, type EpGateState, type EpIssuanceBarrier,
} from "../src/index.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, emitSentinel } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

// Exercise the public server boundary with native transport headers, not a copy of its filter.
// Registry authority and the empty-family barrier are fixture seams, as in endpoint-serve.smoke.ts.
const space = "requestorigin", endpoint = "test.example.origin", owner = "local";
const instanceId = "i".repeat(26), uid = "u".repeat(26);
const enc = (value: string) => new TextEncoder().encode(value);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let passed = 0, failed = 0;
function check(name: string, value: boolean) {
  if (value) passed++;
  else { failed++; console.error(`FAIL: ${name}`); }
}
const auth = await createSpaceAuth(space), port = await pickFreePort();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], {
  host: "127.0.0.1", port, storeDir: join(dir, "js"), transport: { kind: "plaintext" },
}), { mode: 0o600 });
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const exited = new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
const releaseBroker = teardownOnSignal(broker, dir);
let nc: Awaited<ReturnType<typeof connect>> | undefined;
let service: ReturnType<typeof serveEndpoint> | undefined;
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${port}`); if (!up) await wait(20); }
  assert.ok(up, "private broker started");
  const key = createUser();
  const jwt = await encodeUser("origin-fixture", fromPublic(key.getPublicKey()), fromPublic(auth.account.pub), {
    pub: { allow: [">"] }, sub: { allow: [">"] },
  }, { signer: fromSeed(enc(auth.account.signingSeed)), exp: Math.floor(Date.now() / 1000) + 300 });
  nc = await connect({ servers: `nats://127.0.0.1:${port}`, authenticator: credsAuthenticator(fmtCreds(jwt, key)), maxReconnectAttempts: 0 });
  const contract = compileContract({ root: VOID_SCHEMA });
  const doc = { urn: "ai.example.origin", revision: 1, attributes: [], events: [], commands: [
    { name: "probe", class: "ephemeral", targeted: false, capability: "test.call", inputDigest: contract.closureDigest, outputDigest: contract.closureDigest },
  ] };
  const rootDigest = contractDigest(doc), manifest = { v: 1, root: rootDigest, members: [] };
  const clusterDigest = contractDigest(manifest);
  const artifacts = new Map<string, unknown>([[rootDigest, doc], [clusterDigest, manifest]]);
  const authority = { authorize: (name: string, who: string) => ({ authorized: name === endpoint && who === owner, revision: 0 }) };
  let gate: EpGateState = { space, endpoint, lifecycleUid: instanceId, principal: "local.fixture", state: "open", generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0, revision: 1 };
  const op = { opId: mintLifecycleUid(), kind: "registration" as const };
  const barrier: EpIssuanceBarrier = {
    observe: () => ({ ...gate }),
    freeze: (revision) => { if (gate.state !== "open" || gate.revision !== revision) return null; gate = { ...gate, state: "frozen", op, revision: revision + 1 }; return revision + 1; },
    enumerate: () => [], revoke: () => {}, evict: (holders) => holders.map(() => true),
    reopen: (token, successor) => {
      if (gate.state !== "frozen" || gate.revision !== token) return false;
      const { op: _op, ...rest } = gate;
      gate = { ...rest, state: "open", generation: successor.generation, processEpoch: successor.processEpoch, registrationRevision: successor.registrationRevision, nameAuthorityRevision: successor.nameAuthorityRevision, revision: token + 1 };
      return true;
    },
  };
  const kv = await openRecordsBucket(nc, space, { create: true });
  const readClusterArtifact = (digest: string) => artifacts.get(digest);
  await registerServiceInstance(kv, { space, spec: { endpoint, owner, clusterDigests: [clusterDigest], protocol: { v: 1 } }, instanceId, registrant: { owner }, authority, barrier, readClusterArtifact });
  const grant = await authorizeServeGrant(kv, { space, endpoint, instanceId, epoch: gate.processEpoch, holder: { owner }, authority, readProcessEpoch: () => gate.processEpoch, readClusterArtifact });
  const calls: string[] = [], describeCalls: string[] = [], replies: string[] = [], observed: string[] = [];
  service = serveEndpoint(nc, space, grant, [{ command: "probe", contract: { input: contract, output: contract }, handler: (ctx) => { calls.push(ctx.request.id); return null; } }], {
    view: (_caller, context) => { describeCalls.push(context!.fingerprint); return { commands: ["probe"] }; },
  });
  const tap = nc.subscribe(`cotal.${space}.>`, { callback: (_error, msg) => {
    if (!msg.data.length) return;
    try {
      const value = JSON.parse(new TextDecoder().decode(msg.data));
      if (typeof value.id !== "string") return;
      if (msg.subject.includes(".reply.")) replies.push(value.id);
      else if (msg.headers) observed.push(value.id);
    } catch { /* unrelated fixture records are not request envelopes */ }
  } });
  await nc.flush();
  const positive: string[] = [], negative: string[] = [];
  let sequence = 0;
  for (const generation of [undefined, "a".repeat(32)]) {
    const caller = { owner, actor: "fixture", uid, ...(generation === undefined ? {} : { generation }) };
    for (const route of [{ mode: "one" }, { mode: "all" }, { mode: "inst", instanceId }] as const) {
      for (const replyExpected of [true, false]) {
        const publish = (prefix: string, header?: string, value = "fixture") => {
          const id = `${prefix}-${sequence++}`;
          const subject = epRequestSubject(space, { route, endpoint, command: "probe", caller, nonce: `n${String(sequence).padStart(23, "0")}` });
          const body = { v: 1, id, op: { endpoint, command: "probe", inputDigest: contract.closureDigest, outputDigest: contract.closureDigest }, class: "ephemeral", replyExpected, deadlineMs: 2000, args: null, from: { id: "local.fixture", name: "fixture" } };
          const hdrs = header === undefined ? undefined : headers();
          if (hdrs) hdrs.set(header!, value);
          nc!.publish(subject, enc(JSON.stringify(body)), hdrs ? { headers: hdrs } : undefined);
          return id;
        };
        for (const header of [undefined, "traceparent", "Nats-Msg-Id"]) positive.push(publish("positive", header));
        for (const header of ["Nats-Stream", "Nats-Subject", "Nats-Sequence", "Nats-Time-Stamp", "nats-stream", "NATS-SUBJECT"])
          negative.push(publish("negative", header));
        // Presence alone is provenance; an empty value must not turn the marker off.
        negative.push(publish("negative-empty", "Nats-Stream", ""));
      }
    }
  }
  await nc.flush();
  for (let i = 0; i < 100 && observed.length < negative.length + positive.length * 2 / 3; i++) await wait(20);
  check("all marked input frames actually reached the transport witness", negative.every((id) => observed.includes(id)));
  await service.stop(); service = undefined;
  await nc.flush();
  for (const id of positive) check(`direct request still dispatches: ${id}`, calls.filter((row) => row === id).length === 1);
  for (const id of negative) {
    check(`stored-message provenance never dispatches: ${id}`, !calls.includes(id));
    check(`untrusted origin generates no derived reply: ${id}`, !replies.includes(id));
  }
  check("probe requests never invoke the describe authority", describeCalls.length === 0);
  check("matrix covers both rails, all routes, calls and casts", positive.length === 36 && negative.length === 84);
  tap.unsubscribe();
} finally {
  if (service) await service.stop();
  if (nc) await nc.close();
  if (broker.exitCode === null && broker.signalCode === null) broker.kill("SIGTERM");
  if (!await Promise.race([exited.then(() => true), wait(2000).then(() => false)])) { broker.kill("SIGKILL"); await exited; }
  rmSync(dir, { recursive: true, force: true }); releaseBroker();
}
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
