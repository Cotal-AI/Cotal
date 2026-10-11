import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import * as core from "@cotal-ai/core";
import * as authApi from "@cotal-ai/auth";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, teardownPathOnSignal, awaitBrokerReady, killAndAwaitExit, emitSentinel } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

// REAL broker and native KV. Ordinary baseline only. Mutation admission remains blocked.
// The composition follows endpoint-authority-native.smoke.ts, without its races or workers.
type Phase = "setup" | "first" | "renewal";
type Store = "accepted" | "source" | "auth" | "issued";
type Operation = "get" | "create" | "update" | "stage" | "release" | "resolve" | "confirm";
type Witness = { phase: Phase; store: Store; operation: Operation; args: unknown[]; outcome: "pending" | "returned" | "threw"; value?: unknown };
const witnesses: Witness[] = [];
let phase: Phase = "setup", overflow = false;
function forward<A extends unknown[], R>(receiver: unknown, method: (...args: A) => Promise<R>, store: Store, operation: Operation, args: A): Promise<R> {
  // Only two caller invocations are witnessed. No callback supplied to shipped authority code.
  const record: Witness | undefined = phase === "setup" ? undefined : witnesses.length < 256
    ? { phase, store, operation, args, outcome: "pending" } : undefined;
  if (phase !== "setup" && !record) overflow = true;
  if (record) witnesses.push(record);
  let result: Promise<R>;
  try { result = Reflect.apply(method, receiver, args); }
  catch (error) { if (record) { record.outcome = "threw"; record.value = error; } throw error; }
  if (record) void result.then(value => { record.outcome = "returned"; record.value = value; }, error => { record.outcome = "threw"; record.value = error; });
  return result; // Original promise, not the observer's promise. Original receiver/args/error.
}
function observedKv(target: KV, store: "accepted" | "source" | "auth"): KV {
  return new Proxy(target, { get(receiver, property) {
    if (property === "get") { const method = receiver.get; return (...args: Parameters<KV["get"]>) => forward(receiver, method, store, "get", args); }
    if (property === "create") { const method = receiver.create; return (...args: Parameters<KV["create"]>) => forward(receiver, method, store, "create", args); }
    if (property === "update") { const method = receiver.update; return (...args: Parameters<KV["update"]>) => forward(receiver, method, store, "update", args); }
    const value = Reflect.get(receiver, property, receiver);
    return typeof value === "function" ? value.bind(receiver) : value;
  } });
}
function observedIssued(target: core.IssuedStore): core.IssuedStore {
  // The native store is frozen, so do not replace its nonconfigurable methods through a Proxy.
  return {
    stage: (...args) => forward(target, target.stage, "issued", "stage", args),
    release: (...args) => forward(target, target.release, "issued", "release", args),
    resolve: (...args) => forward(target, target.resolve, "issued", "resolve", args),
    confirm: (...args) => forward(target, target.confirm, "issued", "confirm", args),
    retire: (...args) => Reflect.apply(target.retire, target, args),
    retireSource: (...args) => Reflect.apply(target.retireSource, target, args),
  };
}
const cells = [
  "CR01-genuine-holder-activation", "CR02-authorized-bearer-roundtrip",
  "CR03-first-canonical-accepted-row", "CR04-first-native-active-evidence",
  "CR05-live-unchanged-source-policy-before-renewal", "CR06-same-nonce-renewal-must-return",
  "CR07-same-accepted-generation", "CR08-byte-identical-recorded-ceiling",
  "CR09-existing-arm-resolve-confirm", "CR10-no-fresh-material-on-renewal",
  "CR11-live-source-policy-after-renewal", "CR12-owned-cleanup",
] as const;
let passed = 0, failed = 0, attempted = 0, activeCell: string | null = null;
let failure: unknown, failureCell: string | null = null, renewalError: unknown, renewalRejected = false;
type SetupState = "not-reached" | "entered" | "returned" | "threw";
const setup: Record<"caller-authorize" | "caller-issue" | "caller-validate" | "caller-predicate", SetupState> = {
  "caller-authorize": "not-reached", "caller-issue": "not-reached", "caller-validate": "not-reached", "caller-predicate": "not-reached",
};
function cell(name: typeof cells[number], value: unknown) {
  attempted++; activeCell = name;
  if (!value) { failed++; failureCell ??= name; console.log(JSON.stringify({ cell: name, passed: false })); assert.ok(value, name); }
  passed++; activeCell = null; console.log(JSON.stringify({ cell: name, passed: true }));
}
const enc = new TextEncoder(), dec = new TextDecoder();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "-canonical-renewal-"));
const releasePath = teardownPathOnSignal(dir), connections: NatsConnection[] = [];
let broker: ReturnType<typeof spawn> | undefined, releaseBroker: (() => void) | undefined;
let authority: ReturnType<typeof authApi.createEndpointAuthority> | undefined;
const deadline = setTimeout(() => process.kill(process.pid, "SIGTERM"), 150000);
try {
  const root = await core.createBrokerAuth("canonical-renewal-native"), space = "renewal" + core.mintLifecycleUid();
  const accountAuth = await core.createSpaceAccountAuth(root, space), auth = core.composeSpaceAuth(root, accountAuth);
  const port = await pickFreePort(), servers = `nats://127.0.0.1:${port}`;
  const config = join(dir, "nats.conf");
  writeFileSync(config, core.serverConfig(root, [auth], { host: "127.0.0.1", transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }), { mode: 0o600 });
  broker = spawn("nats-server", ["-c", config], { stdio: "ignore" }); releaseBroker = teardownOnSignal(broker, dir);
  await awaitBrokerReady(() => core.isReachable(servers), { servers, attempts: 60, delayMs: 50 });
  await core.setupSpaceStreams({ servers, space, creds: await core.mintCreds(auth, core.newIdentity(), "provisioner") });
  const signer = fromSeed(enc.encode(auth.account.signingSeed!)), hostId = core.newIdentity();
  const endpoint = "test.example.shared", buckets = [core.epAuthBucket(space), core.recordsBucket(space), core.issuedBucket(space), core.acceptedBucket(space)];
  // Existing trusted native fixture custody. These grants never become participant material.
  const rows = { pub: { allow: ["$JS.API.INFO", ...buckets.flatMap(b => [`$KV.${b}.>`, `$JS.API.STREAM.INFO.KV_${b}`, `$JS.API.STREAM.MSG.GET.KV_${b}`, `$JS.API.CONSUMER.CREATE.KV_${b}.>`, `$JS.API.CONSUMER.INFO.KV_${b}.>`, `$JS.API.CONSUMER.DELETE.KV_${b}.>`, `$JS.API.DIRECT.GET.KV_${b}.>`]), `cotal.${space}.epc.*`, `$JS.API.DIRECT.GET.${core.epcStreamName(space)}.cotal.${space}.epc.>`, "$JS.FC.>"] }, sub: { allow: [`_INBOX_${hostId.id}.>`, `cotal.${space}.ep.v1.inst.test_example_shared.>`] } };
  const hostJwt = await encodeUser("native-renewal-fixture", fromPublic(hostId.id), fromPublic(auth.account.pub), rows, { signer, exp: Math.floor(Date.now() / 1000) + 180 });
  const host = await connect({ servers, ...core.standaloneConnectOpts({ tls: false, creds: dec.decode(fmtCreds(hostJwt, fromSeed(enc.encode(hostId.seed)))) }), maxReconnectAttempts: 0 }); connections.push(host);
  const kvm = new Kvm(host), authKv = await kvm.open(core.epAuthBucket(space)), recordsKv = await kvm.open(core.recordsBucket(space));
  const sourceKv = await kvm.open(core.issuedBucket(space)), acceptedKv = await kvm.open(core.acceptedBucket(space));
  const sourceWitness = observedKv(sourceKv, "source"), acceptedWitness = observedKv(acceptedKv, "accepted");
  const nativeIssued = core.openIssuedStore(sourceWitness, await jetstreamManager(host), space);
  const issued = observedIssued(nativeIssued), store = await core.contractStoreContext(host, space);
  const account = { space, accountPublicKey: auth.account.pub, assignmentRevision: 1 };
  const input = { type: "null" }, output = { type: "null" };
  const contract = { input: core.compileContract({ root: input }), output: core.compileContract({ root: output }) };
  const cluster = { urn: endpoint, revision: 1, attributes: [], events: [], commands: [{ name: "increment", class: "ephemeral", effect: "write", targeted: false, capability: "testcall", inputDigest: contract.input.closureDigest, outputDigest: contract.output.closureDigest }] };
  const manifest = { ...core.singleDocumentClosure(cluster).manifest };
  const artifacts = [input, { ...core.singleDocumentClosure(input).manifest }, cluster, manifest].map(value => ({ digest: core.contractDigest(value), value }));
  const closures = [core.contractDigest(manifest)], decisions = new Map<string, core.EndpointInstanceAuthorityRequest>();
  const key = await authApi.generateSigningKey(), issuerName = "https://canonical-renewal.test";
  const issuer = authApi.createUserTokenIssuer({ issuer: issuerName, key });
  const principal = { owner: authApi.deriveOwnerForIdpSubject("native-component-renewal-secret-for-test-only-32bytes", "https://idp.test", "renewal"), actor: "serve", uid: core.mintLifecycleUid() };
  const token = await authApi.validateUserToken(await issuer.issue({ owner: principal.owner, actor: principal.actor, space, lifecycleUid: principal.uid, scope: [], ttlSec: 120 }), { issuer: issuerName, audience: space, key: issuer.localKeySet() });
  const namespace = { account, endpoint, governor: principal.owner, namespaceRevision: 1, policyRevision: 1, clusterDigests: closures };
  const ceiling = { routes: { kind: "instance" as const }, resources: { kind: "ephemeral-only" as const }, expiresAt: token.exp };
  const currentChecks = { first: 0, renewal: 0 }, sourcePolicyChecks = { first: 0, renewal: 0 };
  const policy: authApi.EndpointAuthorityPolicy = {
    namespace: async name => { assert.equal(name, endpoint); return namespace; },
    actorIsCurrent: async candidate => { if (phase !== "setup") currentChecks[phase]++; return core.canonicalJson(candidate) === core.canonicalJson(principal); },
    serving: async (candidate, allocated) => {
      const binding = { account, holder: { owner: candidate.owner, actor: candidate.actor, lifecycleUid: candidate.uid, publicKey: allocated.publicKey }, authority: { namespaceRevision: 1, policyRevision: 1, delegationId: core.mintLifecycleUid(), delegationRevision: 1 }, ceiling };
      decisions.set(allocated.instanceId, { account, endpoint, instanceId: allocated.instanceId, holder: binding.holder, clusterDigests: closures, expected: binding.authority, ceiling }); return binding;
    },
    authorizeInstance: async request => { const expected = decisions.get(request.instanceId); return expected && core.canonicalJson(expected) === core.canonicalJson(request) ? { authorized: true, governor: namespace.governor, ref: request.expected, ceiling: request.ceiling } : { authorized: false }; },
    caller: async (candidate, request) => {
      if (phase !== "setup") sourcePolicyChecks[phase]++;
      assert.equal(core.canonicalJson(candidate), core.canonicalJson(principal));
      assert.ok(decisions.has(request.instanceId) && request.endpoint === endpoint && core.canonicalJson(request.commands) === core.canonicalJson(["increment"]));
      return { capabilities: [{ endpoint, command: "increment" }], expiresAt: ceiling.expiresAt };
    },
  };
  await core.provisionEndpointPolicyHead(authKv, endpoint, 1);
  authority = authApi.createEndpointAuthority({ account, auth, authKv: observedKv(authKv, "auth"), recordsKv, sourceKv: sourceWitness, acceptedKv: acceptedWitness, issued, nc: host, signing: key, issuer: issuerName, policy,
    publishArtifact: async artifact => { await core.publishContractArtifact(store, core.contractArtifactCanonicalBytes(artifact.value)); },
    readArtifact: async digest => { const bytes = await core.fetchContractArtifact(store, core.contractRefToHex(digest)); return bytes ? JSON.parse(dec.decode(bytes)) : undefined; },
  });
  const holder = core.newIdentity();
  const reservation = await authority.prepare(token, { operationId: core.mintLifecycleUid(), endpoint, holderPublicKey: holder.id });
  const operationId = core.mintLifecycleUid(), content = { action: "activate" as const, registrationRevision: 0 as const, processEpoch: 0 as const, contractArtifacts: artifacts };
  const challenge = await authority.challenge(token, { operationId, instanceId: reservation.instanceId, content });
  const signature = Buffer.from(fromSeed(enc.encode(holder.seed)).sign(enc.encode(core.canonicalJson(challenge)))).toString("base64url");
  const active = await authority.activate(token, { operationId, instanceId: reservation.instanceId, content, signature });
  cell(cells[0], active.reservation.state === "active" && active.registrationRevision > 0 && active.processEpoch === 0);
  setup["caller-authorize"] = "entered";
  const grant = await authority.authorizeCallerBearer(token, { endpoint, instanceId: reservation.instanceId, commands: ["describe", "increment"] });
  setup["caller-authorize"] = "returned";
  setup["caller-issue"] = "entered";
  // The original nested call looked up the validator before awaiting issuer.issue.
  const validateCaller = authApi.validateUserToken;
  const callerBearer = await issuer.issue({ owner: grant.principal.owner, actor: grant.principal.actor, space, lifecycleUid: grant.principal.uid, scope: [], view: "endpoint-caller", endpointGrant: { grantId: grant.grantId, grantRevision: grant.grantRevision, policyRevision: grant.policyRevision }, ttlSec: grant.expiresAt - Math.floor(Date.now() / 1000) });
  setup["caller-issue"] = "returned";
  setup["caller-validate"] = "entered";
  const callerToken = await validateCaller.call(authApi, callerBearer, { issuer: issuerName, audience: space, key: issuer.localKeySet() });
  setup["caller-validate"] = "returned";
  setup["caller-predicate"] = "entered";
  cell(cells[1], callerToken.act.view === "endpoint-caller" && callerToken.act.endpointGrant?.grantId === grant.grantId && callerToken.act.lifecycleUid === principal.uid);
  setup["caller-predicate"] = "returned";
  const nonce = core.newIdentity().id, acceptedToken = core.connectionAcceptedToken(nonce), canonicalKey = core.acceptedKey(acceptedToken);
  const source: core.IssuedSourceRef = { space, bucket: core.issuedBucket(space), key: `endpoint-grant.${grant.grantId}.${grant.grantRevision}` };
  phase = "first";
  const first = await authority.issueCallerConnection(callerToken, nonce);
  phase = "setup";
  const before = await acceptedKv.get(canonicalKey); assert.ok(before && before.operation === "PUT");
  const firstRef = await core.readAcceptedRow(host, space, acceptedToken);
  cell(cells[2], firstRef.owner === principal.owner && firstRef.actor === principal.actor && firstRef.uid === principal.uid && witnesses.some(w => w.phase === "first" && w.store === "accepted" && w.operation === "create" && w.args[0] === canonicalKey && w.outcome === "returned"));
  const firstEvidenceEntry = await sourceKv.get(core.issuedEvidenceKey(firstRef)), firstAttemptEntry = await sourceKv.get(core.issuedAttemptKey(firstRef));
  assert.ok(firstEvidenceEntry && firstAttemptEntry);
  const firstEvidence = JSON.parse(dec.decode(firstEvidenceEntry.value)) as core.IssuedEvidence;
  cell(cells[3], core.canonicalJson(firstEvidence.ref) === core.canonicalJson(firstRef) && core.canonicalJson(firstEvidence.permissions) === core.canonicalJson(core.importNativeSubjectPermissions(first)) && JSON.parse(dec.decode(firstAttemptEntry.value)).state === "active" && (await sourceKv.get(core.issuedSourceIndexKey(source, firstRef)))?.operation === "PUT");
  const sourceBefore = await sourceKv.get(source.key), policyBefore = await authKv.get(core.endpointPolicyKey(endpoint));
  assert.ok(sourceBefore && policyBefore);
  cell(cells[4], callerToken.exp > Math.floor(Date.now() / 1000) && firstEvidence.expiresAt! > Math.floor(Date.now() / 1000) && sourceBefore.operation === "PUT" && JSON.parse(dec.decode(sourceBefore.value)).expiresAt > Math.floor(Date.now() / 1000) && JSON.parse(dec.decode(policyBefore.value)).state === "open" && currentChecks.first > 0 && sourcePolicyChecks.first > 0);
  phase = "renewal";
  let renewed: Record<string, unknown> | undefined;
  try { renewed = await authority.issueCallerConnection(callerToken, nonce); }
  catch (error) { renewalRejected = true; renewalError = error; }
  finally { phase = "setup"; }
  // All reads below use original handles, outside the witnessed caller invocation.
  const after = await acceptedKv.get(canonicalKey), policyAfter = await authKv.get(core.endpointPolicyKey(endpoint)), sourceAfter = await sourceKv.get(source.key);
  const selected = witnesses.filter(w => w.phase === "renewal");
  const stages = selected.filter(w => w.store === "issued" && w.operation === "stage");
  const fresh = stages.map(w => w.args[0] as core.IssuedEvidence);
  const freshEffects = await Promise.all(fresh.map(async evidence => {
    const evidenceEntry = await sourceKv.get(core.issuedEvidenceKey(evidence.ref));
    const attemptEntry = await sourceKv.get(core.issuedAttemptKey(evidence.ref));
    const indexEntry = await sourceKv.get(core.issuedSourceIndexKey(source, evidence.ref));
    return { evidence: evidenceEntry?.operation === "PUT", active: attemptEntry?.operation === "PUT" && JSON.parse(dec.decode(attemptEntry.value)).state === "active", index: indexEntry?.operation === "PUT" };
  }));
  const creates = selected.filter(w => w.store === "accepted" && w.operation === "create" && w.args[0] === canonicalKey);
  const head = policyAfter?.operation === "PUT" ? JSON.parse(dec.decode(policyAfter.value)) : null;
  const policyUpdates = selected.filter(w => w.store === "auth" && w.operation === "update" && w.args[0] === core.endpointPolicyKey(endpoint));
  const heldUpdates = policyUpdates.filter(w => JSON.parse(dec.decode(w.args[1] as Uint8Array)).state === "held");
  const openUpdates = policyUpdates.filter(w => JSON.parse(dec.decode(w.args[1] as Uint8Array)).state === "open");
  const nativeCollision = (w: Witness) => w.outcome === "threw" && (core.isCasLoss(w.value) || (w.value as { code?: unknown } | null)?.code === 10077);
  console.log(JSON.stringify({ oracle: "canonical-renewal-native", bounded: !overflow && witnesses.every(w => w.outcome !== "pending"), renewalReturned: !renewalRejected && renewed !== undefined,
    canonicalRowStillPresent: after?.operation === "PUT", canonicalRowBytesUnchanged: !!after && dec.decode(after.value) === dec.decode(before.value),
    bareLookupCount: selected.filter(w => w.store === "accepted" && w.operation === "get" && w.args[0] === acceptedToken).length,
    bareLookupAbsentCount: selected.filter(w => w.store === "accepted" && w.operation === "get" && w.args[0] === acceptedToken && w.outcome === "returned" && w.value === null).length,
    canonicalLookupCount: selected.filter(w => w.store === "accepted" && w.operation === "get" && w.args[0] === canonicalKey).length,
    stageCount: stages.length, releaseCount: selected.filter(w => w.store === "issued" && w.operation === "release").length,
    resolveCount: selected.filter(w => w.store === "issued" && w.operation === "resolve").length, confirmCount: selected.filter(w => w.store === "issued" && w.operation === "confirm").length,
    freshGenerationDifferentCount: fresh.filter(e => e.ref.generation !== firstRef.generation).length,
    freshEvidenceCount: freshEffects.filter(e => e.evidence).length, freshActiveCount: freshEffects.filter(e => e.active).length, freshIndexCount: freshEffects.filter(e => e.index).length,
    canonicalCreateCount: creates.length, canonicalCreateRejectedCount: creates.filter(w => w.outcome === "threw").length,
    nativeCanonicalCreateCollisionCount: creates.filter(nativeCollision).length,
    originalCreateErrorIsRenewalError: renewalRejected && creates.some(w => w.outcome === "threw" && w.value === renewalError),
    originalPredicateRenewalRejected: renewalRejected, policyOpenAfter: head?.state === "open", policyHeldAfter: head?.state === "held",
    policyAcquireUpdateCount: heldUpdates.length, policyOpenUpdateCount: openUpdates.length,
    policyOpenUpdateRejectedCount: openUpdates.filter(w => w.outcome === "threw").length,
    heldPolicyMatchesAcquiredOperation: head?.state === "held" && heldUpdates.some(w => w.outcome === "returned" && JSON.parse(dec.decode(w.args[1] as Uint8Array)).operation.id === head.operation?.id),
    sourceBytesUnchanged: !!sourceAfter && dec.decode(sourceAfter.value) === dec.decode(sourceBefore.value),
    currentnessCheckedDuringRenewal: currentChecks.renewal > 0, sourcePolicyCheckedDuringRenewal: sourcePolicyChecks.renewal > 0,
  }));
  cell(cells[5], !renewalRejected && renewed !== undefined); // Normative RED, not an expected-denial PASS.
  const renewedRef = await core.readAcceptedRow(host, space, acceptedToken);
  cell(cells[6], core.canonicalJson(renewedRef) === core.canonicalJson(firstRef) && after?.revision === before.revision);
  cell(cells[7], core.canonicalJson(core.importNativeSubjectPermissions(renewed)) === core.canonicalJson(firstEvidence.permissions));
  cell(cells[8], selected.filter(w => w.store === "issued" && w.operation === "resolve" && w.outcome === "returned" && core.canonicalJson(w.args[0]) === core.canonicalJson(firstRef)).length === 1 && selected.filter(w => w.store === "issued" && w.operation === "confirm" && w.outcome === "returned" && core.canonicalJson(w.args[0]) === core.canonicalJson(firstRef) && core.canonicalJson(w.args[1]) === core.canonicalJson(firstEvidence.permissions)).length === 1);
  cell(cells[9], !overflow && witnesses.every(w => w.outcome !== "pending") && stages.length === 0 && creates.length === 0 && selected.filter(w => w.store === "source" && (w.operation === "create" || w.operation === "update")).length === 0);
  cell(cells[10], head?.state === "open" && head.operation === undefined && !!sourceAfter && sourceAfter.revision === sourceBefore.revision && currentChecks.renewal > 0 && sourcePolicyChecks.renewal > 0);
} catch (error) {
  failure = error; // Preserve original object privately. No raw message, key, reason or stack output.
  for (const stage of Object.keys(setup) as (keyof typeof setup)[]) if (setup[stage] === "entered") setup[stage] = "threw";
  if (activeCell === null) { failed++; attempted++; failureCell ??= "CR00-setup-or-observation"; console.log(JSON.stringify({ cell: "CR00-setup-or-observation", passed: false })); }
} finally {
  console.log(JSON.stringify({ oracle: "canonical-renewal-setup", stages: setup }));
  let cleanup = true;
  try { await authority?.close(); } catch { cleanup = false; }
  for (const nc of connections) try { await nc.close(); if (await nc.closed() !== undefined) cleanup = false; } catch { cleanup = false; }
  try { if (broker) { await killAndAwaitExit(broker); if (broker.exitCode === null && broker.signalCode === null) cleanup = false; } if (cleanup) releaseBroker?.(); } catch { cleanup = false; }
  if (cleanup) try { rmSync(dir, { recursive: true, force: true }); releasePath(); } catch { cleanup = false; }
  clearTimeout(deadline);
  try { cell(cells[11], cleanup); } catch (error) { failure ??= error; }
}
console.log(JSON.stringify({ summary: "canonical-renewal-native", planned: cells.length, attempted, passed, failed, failureCell, originalRenewalRejected: renewalRejected, failureRetained: failure !== undefined, mutationProof: "blocked-unfulfilled", componentOnly: true }));
emitSentinel({ cells: attempted, passed, failed });
if (failure !== undefined || failed > 0) process.exitCode = 1;
