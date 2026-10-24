/** Native custody guard acceptance on an owned loopback broker. Service rows are explicit
 * test-operator fixtures because public main has no service admission writer. The operations
 * under test are the actual lifecycle/root/ledger entrypoints, not copied implementations.
 * No tenant account, production credential or service admission is used. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { createAccount } from "@nats-io/nkeys";
import { canonicalJson, contractDigest, createEndpointStreams, epAuthBucket, isReachable, mintLifecycleUid, recordsBucket, parseNativeUidCustody, gateCreateFrozen as coreGateCreateFrozen, uidReadReservation, runActivationSagaAtUid, createRecordEntry } from "@cotal-ai/core";
import { openConnectReader, authorizeConnectCredential } from "../src/connect-reader.js";
import type { ValidatedUserToken } from "../src/token.js";
import { openLifecycleRegistry, createGateFrozen, observeGate, activateLifecycleAtUid, setCurrentRootCredential, advanceEpochWithinTakeover, beginHeadRetirementWithinBarrier, completeHeadRetirementWithinBarrier, resumeActivation } from "../src/lifecycle-registry.js";
import { ensureRootCredential } from "../src/root-credential.js";
import { markLedgerRowRevoked, stageAgentMint } from "../src/credential-ledger.js";
import { staticLifecycleTransport, appendStaticCredentialRow, revokeStaticCredentialRows } from "../../manager/src/static-lifecycle.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const port = await pickFreePort();
const servers = `nats://fixture:local-only@127.0.0.1:${port}`;
const root = process.env.JCODE_SCRATCH_DIR ?? process.env.HOME ?? ".";
const dir = mkdtempSync(join(root, SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), `listen: 127.0.0.1:${port}\njetstream { store_dir: ${JSON.stringify(join(dir, "js"))} }\nauthorization { users = [ { user: "fixture", password: "local-only" } ] }\n`);
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
const space = "servicecustody";
const accountPublicKey = createAccount().getPublicKey();
const owner = `u_${"a".repeat(26)}`;
const endpoint = "example.service";
const instanceId = mintLifecycleUid();
const hash = createHash("sha256").update(canonicalJson([1, accountPublicKey, space, owner, endpoint, instanceId, "serve"])).digest("hex");
const actor = `svc_${BigInt(`0x${hash}`).toString(36).padStart(50, "0")}`;
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nc: NatsConnection | undefined;
let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.log(`FAIL ${label}`, detail ?? ""); }
};
const refuses = async (label: string, action: () => Promise<unknown>, expected = /service custody|immutable service|unknown field "serviceCustody"/) => {
  try { await action(); check(label, false, "ordinary entrypoint accepted service custody"); }
  catch (e) { check(label, expected.test((e as Error).message), (e as Error).message); console.log(`  refusal: ${(e as Error).message}`); }
};
try {
  for (let n = 0; !(await isReachable(servers)); n++) {
    if (n >= 50) throw new Error("owned fixture broker failed readiness");
    await pause(100);
  }
  nc = await connect({ servers: `nats://127.0.0.1:${port}`, user: "fixture", pass: "local-only", reconnect: false });
  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), space);
  const reg = await openLifecycleRegistry(nc, space);
  const records = await new Kvm(nc).open(recordsBucket(space));
  const auth = await new Kvm(nc).open(epAuthBucket(space));
  const uid = mintLifecycleUid();
  const custody = { v: 1, kind: "native-service-uid", native: { accountPublicKey, space, lifecycleUid: uid }, assignment: { owner, actor, endpoint, instanceId, duty: "serve" }, creation: { operationId: mintLifecycleUid(), requestDigest: `sha256:${"a".repeat(64)}` } };
  await records.create(`uid.${uid}`, enc(custody));
  const digest = contractDigest(custody);
  const parsed = parseNativeUidCustody(enc(custody), uid);
  check("valid service UID parses without ordinary identity projection", parsed.kind === "service" && parsed.uidDigest === digest && !("owner" in parsed));
  const transport = staticLifecycleTransport(records, auth);
  await refuses("ordinary UID reader never projects service identity", () => uidReadReservation(transport, uid));
  for (const [label, patch] of [
    ["flat owner downgrade", { ...custody, owner }],
    ["unknown creation field", { ...custody, creation: { ...custody.creation, extra: true } }],
    ["wrong derived actor", { ...custody, assignment: { ...custody.assignment, actor: "svc_wrong" } }],
    ["wrong embedded UID", { ...custody, native: { ...custody.native, lifecycleUid: mintLifecycleUid() } }],
  ] as const) {
    await refuses(`malformed custody refuses: ${label}`, async () => parseNativeUidCustody(enc(patch), uid), /custody/);
  }

  console.log(`fixture source=public-main native-service-uid digest=${digest} no service admission writer claimed`);
  await refuses("ordinary gate birth refuses nested service reservation before writing", () => createGateFrozen(reg, { lifecycleUid: uid, op: { opId: mintLifecycleUid(), kind: "activation" } }));
  check("no ordinary gate written for service UID", (await auth.get(`gate.${uid}`)) === null);

  // Existing old-style head/root residue must never make the fast path bypass immutable UID custody.
  const cred = mintLifecycleUid();
  await records.create(`lifecycle.${owner}.${actor}`, enc({ owner, actor, lifecycleUid: uid, managerInstance: "fixture", processEpoch: 1, state: "active", currentCredentialId: cred }));
  await auth.create(`cred.${uid}.${cred}`, enc({ credentialId: cred, holderPrincipal: `${owner}.${actor}`, lifecycleUid: uid, sourceChain: ["root"], state: "active", exp: Date.now() + 60_000 }));
  await refuses("root ensure refuses service UID before its stamped-root fast return", () => ensureRootCredential(reg, { owner, actor, lifecycleUid: uid, managerInstance: "fixture" }));
  await refuses("same-UID ordinary activation refuses before open-gate convergence", () => activateLifecycleAtUid(reg, { owner, actor, lifecycleUid: uid, managerInstance: "fixture" }));
  const fakeOp = mintLifecycleUid();
  await refuses("ordinary stamp idempotence cannot bypass custody", () => setCurrentRootCredential(reg, { owner, actor, lifecycleUid: uid, credentialId: cred }));
  await refuses("ordinary epoch advance refuses before root stamp clearing", () => advanceEpochWithinTakeover(reg, { owner, actor, lifecycleUid: uid, fromEpoch: 1, opId: fakeOp }));
  await refuses("ordinary retirement begin refuses service custody", () => beginHeadRetirementWithinBarrier(reg, { owner, actor, lifecycleUid: uid, opId: fakeOp }));
  await refuses("ordinary retirement complete refuses service custody", () => completeHeadRetirementWithinBarrier(reg, { owner, actor, lifecycleUid: uid, opId: fakeOp }));
  await refuses("activation boot resume refuses service custody before settled return", () => resumeActivation(reg, { owner, actor, lifecycleUid: uid, opId: fakeOp }));
  await refuses("fresh ordinary candidate cannot replace a service-owned alias", () => activateLifecycleAtUid(reg, { owner, actor, lifecycleUid: mintLifecycleUid(), managerInstance: "fixture" }));
  await refuses("ordinary static root write refuses before staging", () => appendStaticCredentialRow(transport, { lifecycleUid: uid, credentialId: mintLifecycleUid(), holderPrincipal: `${owner}.${actor}`, exp: Date.now() + 60_000 }));
  await refuses("ordinary static root revoke refuses even missing mirror", () => revokeStaticCredentialRows(transport, uid, [cred], () => {}));
  await refuses("ordinary agent mint refuses before staged row", () => stageAgentMint(reg, { lifecycleUid: uid, credentialId: mintLifecycleUid(), holderPrincipal: `${owner}.${actor}`, sourceChain: ["root"], exp: Date.now() + 60_000 }));
  const connectReader = await openConnectReader(nc, space);
  const token = { owner, act: { actor, lifecycleUid: uid, credentialId: cred } } as ValidatedUserToken;
  await refuses("ordinary root connect refuses immutable service UID with missing mirrors", () => authorizeConnectCredential(connectReader, token, Date.now));
  const descendant = mintLifecycleUid();
  await auth.create(`cred.${uid}.${descendant}`, enc({ credentialId: descendant, holderPrincipal: `${owner}.${actor}`, lifecycleUid: uid, sourceChain: ["handle.issuer.grant"], state: "active", exp: Date.now() + 60_000 }));
  await refuses("ordinary descendant connect refuses service UID without relying on root-head check", () => authorizeConnectCredential(connectReader, { ...token, act: { ...token.act, credentialId: descendant } }, Date.now));

  // A marked root is also protected at the raw shared revocation seam, including already-revoked.
  const marked = mintLifecycleUid();
  await auth.create(`cred.${uid}.${marked}`, enc({ credentialId: marked, holderPrincipal: `${owner}.${actor}`, lifecycleUid: uid, sourceChain: ["root"], state: "revoked", exp: Date.now() + 60_000, serviceCustody: { v: 1, uidDigest: digest } }));
  await refuses("raw revoke refuses marked root before already-revoked idempotence", () => markLedgerRowRevoked(auth, `cred.${uid}.${marked}`));

  // Force a service reservation to win after the ordinary guard's initial absent snapshot.
  const racedUid = mintLifecycleUid();
  const racedCustody = { ...custody, native: { ...custody.native, lifecycleUid: racedUid } };
  let firstRead = true;
  const racingTransport = { ...transport, async getRecord(key: string) {
    if (key === `uid.${racedUid}` && firstRead) {
      firstRead = false;
      await records.create(key, enc(racedCustody));
      return undefined;
    }
    return transport.getRecord(key);
  } };
  await refuses("reservation won after absent read still blocks ordinary gate birth", () => coreGateCreateFrozen(racingTransport, { lifecycleUid: racedUid, op: { opId: mintLifecycleUid(), kind: "activation" } }));
  check("forced reservation race leaves no gate", (await auth.get(`gate.${racedUid}`)) === null);
  const racedOrdinaryUid = mintLifecycleUid();
  const ordinaryReservation = { owner, actor, mintedBy: "fixture" };
  await createRecordEntry(records, `uid.${racedOrdinaryUid}`, ordinaryReservation);
  await refuses("ordinary reservation winner cannot be promoted to service custody", () => createRecordEntry(records, `uid.${racedOrdinaryUid}`, { ...custody, native: { ...custody.native, lifecycleUid: racedOrdinaryUid } }), /lost its CAS/);
  check("ordinary winner bytes remain unchanged", new TextDecoder().decode((await records.get(`uid.${racedOrdinaryUid}`))!.value) === JSON.stringify(ordinaryReservation));
  let changedCustody = false;
  await runActivationSagaAtUid(transport, { owner, actor: "ordinary_race", lifecycleUid: racedOrdinaryUid, managerInstance: "fixture" }).catch(() => { changedCustody = true; });
  check("foreign ordinary reservation does not promote to another alias", changedCustody);
  const ordinary = { owner: `u_${"b".repeat(26)}`, actor: "cli", lifecycleUid: mintLifecycleUid(), managerInstance: "fixture" };
  const ordinaryRoot = await ensureRootCredential(reg, ordinary);
  check("ordinary root issuance still works", typeof ordinaryRoot === "string");
  check("ordinary stamped-root retry remains same ID", await ensureRootCredential(reg, ordinary) === ordinaryRoot);
  check("ordinary gate remains open", (await observeGate(reg, ordinary.lifecycleUid))?.row.state === "open");
  await records.delete(`uid.${racedUid}`);
  await refuses("deleted custody reservation never becomes reusable absence", () => coreGateCreateFrozen(transport, { lifecycleUid: racedUid, op: { opId: mintLifecycleUid(), kind: "activation" } }), /marker/);
  check("restore or deletion refusal does not create a gate", (await auth.get(`gate.${racedUid}`)) === null);
  check("custody guards never write a terminal frontier", (await records.get(`frontier.${uid}`)) === null);
} finally {
  await nc?.close();
  broker.kill("SIGTERM");
  await new Promise<void>((r) => { if (broker.exitCode !== null) r(); else broker.once("exit", () => r()); });
  releaseBroker();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`SERVICE-CUSTODY native guards: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
