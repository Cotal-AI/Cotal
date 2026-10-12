import assert from "node:assert/strict";
import { spawn, fork, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, PermissionViolationError, jwtAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import * as core from "@cotal-ai/core";
import * as authApi from "@cotal-ai/auth";
import { openHostedEndpointAuthority } from "../src/endpoint-authority-hosted.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, teardownPathOnSignal, awaitBrokerReady, killAndAwaitExit, emitSentinel } from "@cotal-ai/smoke-kit";
const hostedPrepare = process.argv.includes("--prepare-refusal-serving");
if (hostedPrepare && (process.argv.slice(2).length !== 1 || process.env.ENDPOINT_U12_REPORT !== undefined || process.env.ENDPOINT_PREPARE_REFUSAL !== undefined)) throw new Error("hosted prepare entry requires only --prepare-refusal-serving without report or mode overrides");
const hostedReportDir = hostedPrepare ? mkdtempSync(join(tmpdir(), "endpoint-prepare-report-")) : undefined;
const reportPath = hostedReportDir ? join(hostedReportDir, "result.json") : process.env.ENDPOINT_U12_REPORT;
if (!reportPath) throw new Error("owned report required");
const prepareRefusal = hostedPrepare ? "serving" : process.env.ENDPOINT_PREPARE_REFUSAL;
if (prepareRefusal !== undefined && !["serving", "holder", "instance"].includes(prepareRefusal)) throw new Error("ENDPOINT_PREPARE_REFUSAL must be serving, holder or instance");
const prepareChecks: string[] = [];
let prepareProbeActive = false;
const prepareWriteAttempts: string[] = [], prepareDurableWrites: string[] = [];
const checks: string[] = [], enc = new TextEncoder();
let namedControlsAttempted = 0;
let activePrepareCell: string | undefined;
function cell(name: string, value: unknown) { if (hostedPrepare) namedControlsAttempted++; assert.ok(value, name); checks.push(name); console.log(JSON.stringify({ cell: name, passed: true, scope: "native-host-client-component" })); }
async function refused(name: string, action: () => Promise<unknown>, pattern: RegExp) { try { await action(); throw new Error("unexpected success"); } catch (e) { cell(name, pattern.test(String(e))); } }
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "-endpoint-u12-"));
const releasePath = teardownPathOnSignal(dir), connections: NatsConnection[] = [], handles: core.EpServeHandle[] = [];
let broker: ReturnType<typeof spawn> | undefined, releaseBroker: (() => void) | undefined;
let authority: ReturnType<typeof authApi.createEndpointAuthority> | undefined, failure: unknown;
const effects = [0, 0], cleanupErrors: string[] = [];
let hostedObserver: Awaited<ReturnType<typeof openHostedEndpointAuthority>> | undefined;
const workers: { child: ChildProcess; messages: Record<string, unknown>[]; exit: Promise<number | null> }[] = [];
async function waitFor(test: () => boolean, label: string) { const until = Date.now() + 8000; while (!test()) { if (Date.now() > until) throw new Error(label + " timed out"); await new Promise(resolve => setTimeout(resolve, 20)); } }
const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), 150000);
try {
  const root = await core.createBrokerAuth("endpoint-u12-native"), space = "u12" + Date.now();
  const accountAuth = await core.createSpaceAccountAuth(root, space), auth = core.composeSpaceAuth(root, accountAuth);
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve()));
  const servers = `nats://127.0.0.1:${port}`;
  const config = join(dir, "nats.conf"); writeFileSync(config, core.serverConfig(root, [auth], { host: "127.0.0.1", transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }), { mode: 0o600 });
  broker = spawn("nats-server", ["-c", config], { stdio: "ignore" }); releaseBroker = teardownOnSignal(broker, dir);
  await awaitBrokerReady(() => core.isReachable(servers), { servers, attempts: 60, delayMs: 50 });
  await core.setupSpaceStreams({ servers, space, creds: await core.mintCreds(auth, core.newIdentity(), "provisioner") });
  const signer = fromSeed(enc.encode(auth.account.signingSeed!));
  async function connectRows(rows: { pub: { allow: string[] }; sub: { allow: string[] } }, identity = core.newIdentity()) {
    const jwt = await encodeUser("native-component-fixture", fromPublic(identity.id), fromPublic(auth.account.pub), rows, { signer, exp: Math.floor(Date.now() / 1000) + 180 });
    const nc = await connect({ servers, ...core.standaloneConnectOpts({ tls: false, creds: new TextDecoder().decode(fmtCreds(jwt, fromSeed(enc.encode(identity.seed)))) }), maxReconnectAttempts: 0 }); connections.push(nc); return nc;
  }
  const hostId = core.newIdentity(), buckets = [core.epAuthBucket(space), core.recordsBucket(space), core.issuedBucket(space), core.acceptedBucket(space)];
  // Trusted authority fixture custody only. Explicit account-store/contract/observe grants are not participant material.
  const host = await connectRows({ pub: { allow: ["$JS.API.INFO", ...buckets.flatMap(b => [`$KV.${b}.>`, `$JS.API.STREAM.INFO.KV_${b}`, `$JS.API.STREAM.MSG.GET.KV_${b}`, `$JS.API.CONSUMER.CREATE.KV_${b}.>`, `$JS.API.CONSUMER.INFO.KV_${b}.>`, `$JS.API.CONSUMER.DELETE.KV_${b}.>`, `$JS.API.DIRECT.GET.KV_${b}.>`]), `cotal.${space}.epc.*`, `$JS.API.DIRECT.GET.${core.epcStreamName(space)}.cotal.${space}.epc.>`, "$JS.FC.>"] }, sub: { allow: [`_INBOX_${hostId.id}.>`, `cotal.${space}.ep.v1.inst.test_example_shared.>`, `cotal.${space}.ep.v1.inst.auth.>`] } }, hostId);
  const kvm = new Kvm(host), authKv = await kvm.open(core.epAuthBucket(space)), recordsKv = await kvm.open(core.recordsBucket(space)), sourceKv = await kvm.open(core.issuedBucket(space)), acceptedKv = await kvm.open(core.acceptedBucket(space));
  const jsm = await jetstreamManager(host), issued = core.openIssuedStore(sourceKv, jsm, space), store = await core.contractStoreContext(host, space);
  const endpoint = "test.example.shared", account = { space, accountPublicKey: auth.account.pub, assignmentRevision: 1 };
  await core.provisionEndpointPolicyHead(authKv, endpoint, 1);
  // Test scheduling only. Both original leader reads finish before either real CAS starts.
  let raceActive = false, rendezvousArmed = false;
  const readRevisions: number[] = [], casCodes: number[] = [];
  let casWins = 0, releaseReaders = () => {};
  let readersReady: Promise<void>;
  const admissionKv = new Proxy(authKv, { get(target, property) {
    if (property === "create") return async (...args: Parameters<typeof authKv.create>) => {
      const probe = prepareProbeActive;
      if (probe) prepareWriteAttempts.push(args[0]);
      const revision = await target.create(...args);
      if (probe) prepareDurableWrites.push(args[0]);
      return revision;
    };
    if (property === "get") return async (...args: Parameters<typeof authKv.get>) => {
      const entry = await target.get(...args);
      if (rendezvousArmed && args[0] === core.endpointPolicyKey(endpoint)) {
        assert.ok(entry && entry.operation === "PUT", "C01-real-policy-entry");
        assert.equal(JSON.parse(new TextDecoder().decode(entry.value)).state, "open", "C01-real-policy-open");
        readRevisions.push(entry.revision);
        if (readRevisions.length === 2) { rendezvousArmed = false; releaseReaders(); }
        await readersReady;
      }
      return entry;
    };
    if (property === "update") return async (...args: Parameters<typeof authKv.update>) => {
      const probe = prepareProbeActive;
      if (probe) prepareWriteAttempts.push(args[0]);
      const acquisition = raceActive && args[0] === core.endpointPolicyKey(endpoint) &&
        JSON.parse(new TextDecoder().decode(args[1] as Uint8Array)).state === "held";
      try {
        const revision = await target.update(...args);
        if (probe) prepareDurableWrites.push(args[0]);
        if (acquisition) casWins++;
        return revision;
      } catch (error) {
        if (acquisition) {
          const code = (error as { code?: unknown }).code;
          if (code === 10071 || code === 10164) casCodes.push(code);
        }
        throw error;
      }
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const input = { type: "null" }, output = { type: "object", properties: { effects: { type: "integer" }, owner: { type: "string" } }, required: ["effects", "owner"], additionalProperties: false };
  const contract = { input: core.compileContract({ root: input }), output: core.compileContract({ root: output }) };
  const cluster = { urn: "test.example.shared", revision: 1, attributes: [], events: [], commands: ["increment", "other"].map(name => ({ name, class: "ephemeral", effect: "write", targeted: false, capability: "testcall", inputDigest: contract.input.closureDigest, outputDigest: contract.output.closureDigest })) };
  const manifest = { ...core.singleDocumentClosure(cluster).manifest };
  const artifacts = [input, output, { ...core.singleDocumentClosure(input).manifest }, { ...core.singleDocumentClosure(output).manifest }, cluster, manifest].map(value => ({ digest: core.contractDigest(value), value }));
  const closures = [core.contractDigest(manifest)], decisions = new Map<string, core.EndpointInstanceAuthorityRequest>();
  const key = await authApi.generateSigningKey(), issuer = authApi.createUserTokenIssuer({ issuer: "https://endpoint-u12.test", key });
  const ownerSecret = "native-component-owner-secret-for-test-only-32bytes";
  const principals = ["a", "b"].map(label => ({ owner: authApi.deriveOwnerForIdpSubject(ownerSecret, "https://idp.test", label), actor: "serve", uid: core.mintLifecycleUid() }));
  const tokens = await Promise.all(principals.map(async principal => authApi.validateUserToken(await issuer.issue({ owner: principal.owner, actor: principal.actor, space, lifecycleUid: principal.uid, scope: [], ttlSec: 120 }), { issuer: "https://endpoint-u12.test", audience: space, key: issuer.localKeySet() })));
  const namespace = { account, endpoint, governor: principals[0].owner, namespaceRevision: 1, policyRevision: 1, clusterDigests: closures };
  const ceiling = { routes: { kind: "instance" as const }, resources: { kind: "ephemeral-only" as const }, expiresAt: Math.floor(Date.now() / 1000) + 120 };
  const policy: authApi.EndpointAuthorityPolicy = {
    namespace: async name => { assert.equal(name, endpoint); return namespace; },
    actorIsCurrent: async principal => principals.some(p => p.owner === principal.owner && p.actor === principal.actor && p.uid === principal.uid),
    serving: async (principal, allocated) => {
      if (prepareProbeActive && prepareRefusal === "serving") throw new Error("prepare policy denied");
      const binding = { account, holder: { owner: principal.owner, actor: principal.actor, lifecycleUid: principal.uid, publicKey: allocated.publicKey }, authority: { namespaceRevision: 1, policyRevision: 1, delegationId: core.mintLifecycleUid(), delegationRevision: 1 }, ceiling };
      if (prepareProbeActive && prepareRefusal === "holder") binding.holder.publicKey = core.newIdentity().id;
      decisions.set(allocated.instanceId, { account, endpoint, instanceId: allocated.instanceId, holder: binding.holder, clusterDigests: closures, expected: binding.authority, ceiling }); return binding;
    },
    authorizeInstance: async request => { if (prepareProbeActive && prepareRefusal === "instance") return { authorized: false }; const expected = decisions.get(request.instanceId); return expected && core.canonicalJson(expected) === core.canonicalJson(request) ? { authorized: true, governor: namespace.governor, ref: request.expected, ceiling: request.ceiling } : { authorized: false }; },
    caller: async (principal, request) => { const row = decisions.get(request.instanceId); if (!row || row.holder.owner !== principal.owner || request.commands.some(c => c !== "increment")) throw new Error("caller policy denied"); return { capabilities: [{ endpoint, command: "increment" }], expiresAt: ceiling.expiresAt }; },
  };
  let pauseRelease = false;
  let announcePause!: () => void, resumeRelease!: () => void;
  const releasePaused = new Promise<void>(resolve => { announcePause = resolve; });
  const releaseResume = new Promise<void>(resolve => { resumeRelease = resolve; });
  const observationFilters: string[] = [];
  const pinnedHost = new Proxy(host, { get(target, key) {
    if (key === "subscribe") return (...args: Parameters<typeof host.subscribe>) => {
      const subscription = target.subscribe(...args); observationFilters.push(args[0]); return subscription;
    };
    if (key === "flush") return async () => { if (pauseRelease) { announcePause(); await releaseResume; } return target.flush(); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  authority = authApi.createEndpointAuthority({ account, auth, authKv: admissionKv, recordsKv, sourceKv, acceptedKv, issued, nc: pinnedHost, signing: key, issuer: "https://endpoint-u12.test", policy, publishArtifact: async artifact => { await core.publishContractArtifact(store, core.contractArtifactCanonicalBytes(artifact.value)); }, readArtifact: async digest => { const bytes = await core.fetchContractArtifact(store, core.contractRefToHex(digest)); return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : undefined; } });
  if (prepareRefusal !== undefined) {
    // Each selected mode uses the original native broker and policy CAS. The observer delegates
    // every write unchanged. It never repairs a held head or retries a refused operation.
    const prepareCell = (name: string, value: unknown) => { if (hostedPrepare) namedControlsAttempted++; activePrepareCell = name; assert.ok(value, name); activePrepareCell = undefined; prepareChecks.push(name); console.log(JSON.stringify({ cell: name, passed: true, scope: "native-prepare-validation-refusal" })); };
    const policyKey = core.endpointPolicyKey(endpoint), operationId = core.mintLifecycleUid();
    const before = await authKv.get(policyKey);
    assert.ok(before && before.operation === "PUT" && JSON.parse(new TextDecoder().decode(before.value)).state === "open", "PREPARE-original-native-policy-open");
    const pattern = prepareRefusal === "serving" ? /prepare policy denied/ : prepareRefusal === "holder" ? /serving policy substituted holder or account/ : /serving instance is not delegated to this holder\/contract\/account/;
    prepareProbeActive = true;
    try {
      await assert.rejects(authority.prepare(tokens[0], { operationId, endpoint, holderPublicKey: core.newIdentity().id }), pattern, "PREPARE-selected-validation-refusal");
    } finally { prepareProbeActive = false; }
    prepareCell("PREPARE01-selected-validation-refused-" + prepareRefusal, true);
    const onlyPolicy = (key: string) => key === policyKey;
    prepareCell("PREPARE02-denial-zero-material-write-attempts-and-durable-writes", prepareWriteAttempts.length > 0 && prepareDurableWrites.length > 0 && prepareWriteAttempts.every(onlyPolicy) && prepareDurableWrites.every(onlyPolicy) && effects.every(value => value === 0));
    const after = await authKv.get(policyKey);
    const head = after && after.operation === "PUT" ? JSON.parse(new TextDecoder().decode(after.value)) : null;
    console.log(JSON.stringify({ oracle: "PREPARE03", mode: prepareRefusal, operationId, beforeRevision: before.revision, afterRevision: after?.revision ?? null, policyState: head?.state ?? null, policyOperationId: head?.operation?.id ?? null, writeAttempts: prepareWriteAttempts, durableWrites: prepareDurableWrites }));
    prepareCell("PREPARE03-validation-only-refusal-releases-native-policy-head", head?.state === "open" && head.operation === undefined && after!.revision > before.revision);
    const permitted = await authority.prepare(tokens[0], { operationId: core.mintLifecycleUid(), endpoint, holderPublicKey: core.newIdentity().id });
    const permittedHead = await authKv.get(policyKey);
    prepareCell("PREPARE04-subsequent-permitted-prepare-succeeds-with-open-head", permitted.state === "prepared" && permitted.endpoint === endpoint && permitted.binding.holder.owner === principals[0].owner && permittedHead && JSON.parse(new TextDecoder().decode(permittedHead.value)).state === "open" && effects.every(value => value === 0));
    if (hostedPrepare) {
      // Labelled fault injection stays on real broker writes. Each case owns a separate policy
      // head so an intentionally retained uncertain hold never gets repaired for the next test.
      for (const scenario of ["serving", "holder", "instance", "before-write", "after-write", "release-cas", "foreign-operation"] as const) {
        const safetyEndpoint = "test.example.prepare." + scenario.replaceAll("-", "");
        const safetyKey = core.endpointPolicyKey(safetyEndpoint), safetyOperation = core.mintLifecycleUid();
        const foreignOperation = core.mintLifecycleUid(), denial = new Error("labelled prepare validation denial");
        const attempts: string[] = [], committed: string[] = [];
        let releaseFailure: unknown;
        await core.provisionEndpointPolicyHead(authKv, safetyEndpoint, 1);
        const safetyKv = new Proxy(authKv, { get(target, property) {
          if (property === "create") return async (...args: Parameters<typeof authKv.create>) => {
            attempts.push(args[0]);
            const reservation = args[0].startsWith("endpoint-reservation.");
            if (reservation && scenario === "before-write") throw new Error("labelled write reply failed before broker commit");
            const revision = await target.create(...args); committed.push(args[0]);
            if (reservation && scenario === "after-write") throw new Error("labelled write reply failed after broker commit");
            return revision;
          };
          if (property === "update") return async (...args: Parameters<typeof authKv.update>) => {
            attempts.push(args[0]);
            const releasing = args[0] === safetyKey && JSON.parse(new TextDecoder().decode(args[1] as Uint8Array)).state === "open";
            try {
              // Force the real server's revision rejection, not a fabricated CAS response.
              const revision = await target.update(args[0], args[1], releasing && scenario === "release-cas" ? args[2] - 1 : args[2]);
              committed.push(args[0]); return revision;
            } catch (error) { if (releasing) releaseFailure = error; throw error; }
          };
          const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
        } });
        const safetyPolicy: authApi.EndpointAuthorityPolicy = {
          ...policy,
          namespace: async name => { assert.equal(name, safetyEndpoint); return { ...namespace, endpoint: safetyEndpoint }; },
          serving: async (principal, allocated) => {
            if (scenario === "foreign-operation") {
              const entry = await authKv.get(safetyKey); assert.ok(entry);
              const head = JSON.parse(new TextDecoder().decode(entry.value));
              await authKv.update(safetyKey, enc.encode(core.canonicalJson({ ...head, operation: { ...head.operation, id: foreignOperation } })), entry.revision);
              throw denial;
            }
            if (scenario === "release-cas" || scenario === "serving") throw denial;
            return { account, holder: { owner: principal.owner, actor: principal.actor, lifecycleUid: principal.uid, publicKey: scenario === "holder" ? core.newIdentity().id : allocated.publicKey }, authority: { namespaceRevision: 1, policyRevision: 1, delegationId: core.mintLifecycleUid(), delegationRevision: 1 }, ceiling };
          },
          authorizeInstance: async request => scenario === "instance" ? { authorized: false } : { authorized: true, governor: namespace.governor, ref: request.expected, ceiling: request.ceiling },
        };
        const safety = authApi.createEndpointAuthority({ account, auth, authKv: safetyKv, recordsKv, sourceKv, acceptedKv, issued, nc: host, signing: key, issuer: "https://endpoint-u12.test", policy: safetyPolicy, publishArtifact: async () => { throw new Error("prepare safety does not publish artifacts"); }, readArtifact: async () => undefined });
        let error: unknown;
        try { await safety.prepare(tokens[0], { operationId: safetyOperation, endpoint: safetyEndpoint, holderPublicKey: core.newIdentity().id }); }
        catch (cause) { error = cause; }
        finally { await safety.close(); }
        const entry = await authKv.get(safetyKey); assert.ok(entry);
        const head = JSON.parse(new TextDecoder().decode(entry.value));
        if (scenario === "serving") {
          prepareCell("PREPARE05-serving-preserves-original-denial-object", error === denial && head.state === "open" && head.operation === undefined && attempts.every(name => name === safetyKey) && effects.every(value => value === 0));
        } else if (scenario === "holder" || scenario === "instance") {
          const message = scenario === "holder" ? "serving policy substituted holder or account" : "serving instance is not delegated to this holder/contract/account";
          prepareCell("PREPARE05-validation-" + scenario + "-preserves-denial-and-opens-head", error instanceof core.EpEnvelopeError && error.code === "permission-denied" && error.message === message && head.state === "open" && head.operation === undefined && attempts.every(name => name === safetyKey));
        } else if (scenario === "before-write" || scenario === "after-write") {
          const attempted = attempts.filter(name => name.startsWith("endpoint-reservation."));
          const material = committed.filter(name => name.startsWith("endpoint-reservation."));
          prepareCell("PREPARE06-" + scenario + "-retains-own-uncertain-hold", error instanceof core.EpEnvelopeError && error.code === "unavailable" && attempted.length === 1 && material.length === (scenario === "after-write" ? 1 : 0) && head.state === "held" && head.operation?.id === safetyOperation);
          const row = await authKv.get(attempted[0]);
          prepareCell("PREPARE07-" + scenario + "-actual-material-state-no-operation-release", (scenario === "after-write" ? row?.operation === "PUT" : row === null) && await authKv.get("endpoint-prepare." + safetyOperation) === null && attempts.filter(name => name === safetyKey).length === 1 && effects.every(value => value === 0));
        } else {
          prepareCell("PREPARE08-" + scenario + "-preserves-original-and-release-causes", error instanceof AggregateError && error.cause === denial && error.errors[0] === denial && (scenario === "release-cas" ? error.errors[1] === releaseFailure && releaseFailure !== undefined : error.errors[1] instanceof core.EpEnvelopeError && error.errors[1].code === "conflict"));
          prepareCell("PREPARE09-" + scenario + "-never-reclaims-held-operation", head.state === "held" && head.operation?.id === (scenario === "foreign-operation" ? foreignOperation : safetyOperation) && attempts.every(name => name === safetyKey) && effects.every(value => value === 0));
        }
      }
    }
  }
  const authInstanceId = core.mintLifecycleUid(), authIdentity = core.newIdentity();
  const authCreds = await core.mintCreds(auth, core.newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: "auth", instanceId: authInstanceId } });
  const authExecutor = await connect({ servers, ...core.standaloneConnectOpts({ tls: false, creds: authCreds }), maxReconnectAttempts: 0 }); connections.push(authExecutor);
  const authKvm = new Kvm(authExecutor), authGate = await authKvm.open(core.epAuthBucket(space)), authRecords = await authKvm.open(core.recordsBucket(space));
  const authorityContract = { input: core.compileContract({ root: core.ENDPOINT_AUTHORITY_INPUT_SCHEMA }), output: core.compileContract({ root: core.ENDPOINT_AUTHORITY_OUTPUT_SCHEMA }) };
  const authorityCluster = { urn: "ai.cotal.endpoint-authority", revision: 1, attributes: [], events: [], commands: ["ep-check", "ep-admit", "ep-release"].map(name => ({ name, class: "ephemeral", targeted: false, capability: "endpointauthority", inputDigest: authorityContract.input.closureDigest, outputDigest: authorityContract.output.closureDigest })) };
  const authorityManifest = core.singleDocumentClosure(authorityCluster).manifest;
  const authArtifacts = [authorityCluster, authorityManifest], authMap = new Map(authArtifacts.map(a => [core.contractDigest(a), a]));
  await core.provisionEndpointGateOpen(authGate, { endpoint: "auth", instanceId: authInstanceId, principal: core.principalKey("local", authIdentity.id).key });
  const authRegistered = await core.registerServingInstance(authRecords, { space, instanceId: authInstanceId, spec: { endpoint: "auth", owner: "local", clusterDigests: [core.contractDigest(authorityManifest)], protocol: { v: 1 } }, registrant: { owner: "local" }, authority: { authorize: () => ({ authorized: true, revision: 0 }) }, barrier: core.endpointRegistrationBarrier(authGate, space, { endpoint: "auth", instanceId: authInstanceId, opId: core.mintLifecycleUid() }), readClusterArtifact: digest => authMap.get(digest) });
  const authServingCreds = await core.mintCreds(auth, authIdentity, "endpoint-serve", { endpointServe: authRegistered.grant, serveIssuance: core.serveIssuanceGateKv(authGate, space, { endpoint: "auth", instanceId: authInstanceId }) });
  const authServing = await connect({ servers, ...core.standaloneConnectOpts({ tls: false, creds: authServingCreds }), maxReconnectAttempts: 0 }); connections.push(authServing);
  handles.push(core.serveEndpoint(authServing, space, authRegistered.grant, authority.commandDefs(), { public: true })); await authServing.flush();
  // Direct hosted component witness using the existing genuine account, stores, issuer and gate.
  // This proves a canonical ceiling SUB with real traffic, not its complete self-minted permissions.
  const observerAssignment = core.parseEndpointDeploymentAssignment({ account, lifecycleUid: core.mintLifecycleUid(), state: "active", expiresAt: ceiling.expiresAt });
  const observerDeployment: core.EndpointAuthorityDeployment = {
    assignment: observerAssignment,
    withCurrentAssignment: async (expected, operation) => {
      assert.equal(core.canonicalJson(expected), core.canonicalJson(observerAssignment));
      core.parseEndpointDeploymentAssignment(observerAssignment);
      const result = await operation();
      core.parseEndpointDeploymentAssignment(observerAssignment);
      return result;
    },
  };
  const hostedConnections: { nc: NatsConnection; label: string }[] = [];
  hostedObserver = await openHostedEndpointAuthority({ server: servers, space, dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed! }, deployment: observerDeployment, issuer, policy, authInstanceId, authEpoch: authRegistered.processEpoch,
    onConnection: (nc, label) => { hostedConnections.push({ nc, label }); }, log: () => {} });
  assert.equal(hostedConnections.length, 1, "direct hosted observer exposes one genuine connection");
  const hostedConnection = hostedConnections[0];
  assert.equal(hostedConnection.label, `cotal:endpoint-authority:${space}`);
  assert.equal((await hostedObserver.trust()).authority.epoch, authRegistered.processEpoch, "stock current auth gate checked");
  const hostedSubjects: string[] = [], hostedErrors: unknown[] = [];
  const hostedFilter = `cotal.${space}.ep.v1.inst.>`;
  const hostedSubscription = hostedConnection.nc.subscribe(hostedFilter, { callback(error, message) {
    if (error) { hostedErrors.push(error); return; }
    hostedSubjects.push(message.subject);
  } });
  await hostedConnection.nc.flush();
  assert.equal(hostedSubscription.getSubject(), hostedFilter, "actual hosted canonical ceiling SUB bytes");
  const proposalSchema = JSON.parse(readFileSync(new URL("./proposals/endpoint-authority-v2.schema.json", import.meta.url), "utf8"));
  const Ajv = createRequire(new URL("../../../packages/core/package.json", import.meta.url))("ajv");
  const proposalValidator = new Ajv({ strict: true, allErrors: true }); proposalValidator.addSchema(proposalSchema);
  const proposalAdmit = proposalValidator.compile({ $ref: `${proposalSchema.$id}#/definitions/admissionRequest` });
  const proposalRelease = proposalValidator.compile({ $ref: `${proposalSchema.$id}#/definitions/releaseRequest` });
  const capturedAuthority: { command: string; args: unknown }[] = [];
  const authorityTap = host.subscribe(`cotal.${space}.ep.v1.inst.auth.${authInstanceId}.*.>`, { callback: (_error, message) => {
    if (_error) { console.error("authority tap refused", _error.message); return; }
    const parsed = core.parseEpSubject(message.subject);
    if (parsed?.plane !== "request") return;
    const envelope = core.parseEndpointRequest(JSON.parse(new TextDecoder().decode(message.data)));
    capturedAuthority.push({ command: parsed.command, args: envelope.args });
  } });
  const activated: { instanceId: string; owner: string; nc: NatsConnection; caller: core.IssuedAuthorityRef }[] = [];
  for (const [index, token] of tokens.entries()) {
    const holder = core.newIdentity(), principal = principals[index];
    const reservation = await authority.prepare(token, { operationId: core.mintLifecycleUid(), endpoint, holderPublicKey: holder.id });
    cell(`N01-same-governed-name-reservation-${index}`, reservation.endpoint === endpoint && reservation.binding.holder.owner === principal.owner && reservation.binding.authority.namespaceRevision === 1);
    const content = { action: "activate" as const, registrationRevision: 0 as const, processEpoch: 0 as const, contractArtifacts: artifacts };
    const operationId = core.mintLifecycleUid(), challenge = await authority.challenge(token, { operationId, instanceId: reservation.instanceId, content });
    const signature = Buffer.from(fromSeed(enc.encode(holder.seed)).sign(enc.encode(core.canonicalJson(challenge)))).toString("base64url");
    pauseRelease = index === 0;
    const pendingActivation = authority.activate(token, { operationId, instanceId: reservation.instanceId, content, signature });
    if (index === 0) {
      await Promise.race([releasePaused, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("R01-pause-not-reached")), 5000))]);
      let replayBeforeRelease: { serveJwt?: string } | undefined, replayError: unknown;
      try { replayBeforeRelease = await authority.activate(token, { operationId, instanceId: reservation.instanceId, content, signature }); } catch (error) { replayError = error; }
      const heldEntry = await authKv.get(core.endpointPolicyKey(endpoint));
      const heldHead = heldEntry ? JSON.parse(new TextDecoder().decode(heldEntry.value)) : null;
      console.log(JSON.stringify({ race: "R01", policyState: heldHead?.state, replayReturnedMaterial: !!replayBeforeRelease?.serveJwt, firstActivationPaused: pauseRelease }));
      pauseRelease = false; resumeRelease(); await pendingActivation;
      cell("R01-identical-activation-replay-must-not-release-material-before-policy-final-CAS", !!replayError && !replayBeforeRelease?.serveJwt && heldHead?.state === "held");
    }
    const active = await pendingActivation;
    assert.equal(observationFilters[index], `cotal.${space}.ep.v1.inst.test_example_shared.${reservation.instanceId}.*.>`, "actual canonical observer filter bytes");
    assert.equal(observationFilters.length, index + 1, "one actual observer subscription per activation");
    cell(`N02-native-activation-${index}`, active.processEpoch === 0 && active.registrationRevision > 0);
    const replay = await authority.activate(token, { operationId, instanceId: reservation.instanceId, content, signature });
    assert.equal(observationFilters.length, index + 1, "canonical prior-active replay does not resubscribe");
    cell(`N03-exact-lost-response-material-${index}`, replay.serveJwt === active.serveJwt && replay.attestation === active.attestation);
    const controlId = core.newIdentity(), controlGeneration = core.mintGeneration();
    const controlCaller = { ...principal, generation: controlGeneration };
    const controlRows = core.epCallerGrantRows(space, ["ep-check", "ep-admit", "ep-release"].map(command => ({ endpoint: "auth", command, instanceId: authInstanceId, instanceOnly: true })), controlCaller);
    const controlJwt = await encodeUser("native-component-control", fromPublic(controlId.id), fromPublic(auth.account.pub), { pub: { allow: controlRows.pub }, sub: { allow: [`_INBOX_${controlId.id}.>`, ...controlRows.sub] } }, { signer, exp: Math.floor(Date.now() / 1000) + 120 });
    const material = { servers, authority: { space, instanceId: authInstanceId, epoch: 0, caller: controlCaller }, trust: { issuer: "https://endpoint-u12.test", accountPublicKey: auth.account.pub, assignmentRevision: 1, keys: issuer.jwks().keys, accountSigningKey: signer.getPublicKey() }, serveJwt: active.serveJwt, attestation: active.attestation, artifacts, input, output, holder, controlCreds: new TextDecoder().decode(fmtCreds(controlJwt, fromSeed(enc.encode(controlId.seed)))), serveCreds: new TextDecoder().decode(fmtCreds(active.serveJwt, fromSeed(enc.encode(holder.seed)))) };
    cell(`N04-worker-no-issuer-executor-${index}`, !Object.hasOwn(material, "signingSeed") && !Object.hasOwn(material, "executorCreds"));
    const path = join(dir, `worker-${index}.json`); writeFileSync(path, JSON.stringify(material), { mode: 0o600 });
    const messages: Record<string, unknown>[] = [];
    const child = fork(new URL("./endpoint-authority-native-worker.ts", import.meta.url), [], { execArgv: ["--import", "tsx"], env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ENDPOINT_U12_WORKER_FILE: path }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child.on("message", value => { const message = value as Record<string, unknown>; messages.push(message); if (message.kind === "effect") effects[index] = Number(message.effects); });
    const exit = new Promise<number | null>(resolve => child.once("exit", resolve)); workers.push({ child, messages, exit });
    await waitFor(() => messages.some(m => m.kind === "ready" || m.kind === "failure"), "worker startup");
    const ready = messages.find(m => m.kind === "ready"), error = messages.find(m => m.kind === "failure");
    if (error) throw new Error(String(error.message));
    cell(`N04-stock-signerless-brand-${index}`, ready?.owner === principal.owner && ready.protocol === 3);
    for (const rail of ["ep", "ep.v1"]) for (const route of ["one", "all"]) for (const command of ["increment", "describe"]) {
      const probe = await connect({ servers, ...core.standaloneConnectOpts({ tls: false, creds: material.serveCreds }), maxReconnectAttempts: 0 });
      const subject = `cotal.${space}.${rail}.${route}.${core.endpointToken(endpoint)}.${command}.>`;
      let violation: unknown;
      const status = probe.status();
      const statusTask = (async () => { for await (const event of status) if (event.type === "error" && event.error instanceof PermissionViolationError && event.error.subject === subject) { violation = event.error; return; } })();
      const subscription = probe.subscribe(subject, { ...(route === "one" ? { queue: core.epClassQueueGroup(endpoint) } : {}), callback: error => { if (error instanceof PermissionViolationError && error.subject === subject) violation = error; } });
      await probe.flush();
      await waitFor(() => violation !== undefined, `N13-serve-broker-denies-${index}-${rail}-${route}-${command}`);
      cell(`N13-serve-broker-denies-${index}-${rail}-${route}-${command}`, violation instanceof PermissionViolationError);
      subscription.unsubscribe(); await probe.close(); await statusTask;
    }
    const callerId = core.newIdentity(), issuedCaller = await authority.caller(token, { endpoint, instanceId: reservation.instanceId, commands: ["increment"], publicKey: callerId.id });
    const callerNc = await connect({ servers, ...core.standaloneConnectOpts({ tls: false, creds: new TextDecoder().decode(fmtCreds(issuedCaller.jwt, fromSeed(enc.encode(callerId.seed)))) }), maxReconnectAttempts: 0 }); connections.push(callerNc);
    const resolved = await core.resolveService(callerNc, space, endpoint, issuedCaller.caller, { instanceId: reservation.instanceId, deadlineMs: 5000 });
    cell(`N05-private-direct-describe-${index}`, resolved.owner === principal.owner && resolved.commands.has("increment") && !resolved.commands.has("other"));
    const reply = await core.invokeCommand(callerNc, space, resolved, "increment", undefined, { deadlineMs: 5000, id: "call-1" });
    await waitFor(() => hostedSubjects.some(subject => subject.startsWith(`cotal.${space}.ep.v1.inst.test_example_shared.${reservation.instanceId}.increment.`)) || hostedErrors.length > 0, "direct hosted canonical observer traffic");
    assert.deepEqual(hostedErrors, [], "real hosted ceiling SUB and flush not refused");
    assert.ok(hostedSubjects.some(subject => subject.startsWith(`cotal.${space}.ep.v1.inst.test_example_shared.${reservation.instanceId}.increment.`)), "actual native increment reached hosted observer");
    cell(`N06-direct-scoped-effect-${index}`, reply.reply.ok && (reply.reply.data as { effects: number; owner: string }).effects === 1 && (reply.reply.data as { owner: string }).owner === principal.owner);
    activated.push({ instanceId: reservation.instanceId, owner: principal.owner, nc: callerNc, caller: issuedCaller.caller });
  }
  cell("N07-distinct-A-B-same-name", activated[0].instanceId !== activated[1].instanceId && activated[0].owner !== activated[1].owner);
  await refused("N08-cross-instance-caller-denied", () => core.resolveService(activated[0].nc, space, endpoint, activated[0].caller, { instanceId: activated[1].instanceId, deadlineMs: 1500 }), /permission-denied|REFUSED BY THE BROKER/);
  await refused("N09-class-caller-denied", () => core.resolveService(activated[0].nc, space, endpoint, activated[0].caller, { deadlineMs: 1500 }), /permission-denied|REFUSED BY THE BROKER/);
  cell("N10-effects-attributed-exactly-one-each", effects[0] === 1 && effects[1] === 1);
  const resolvedRace: core.ResolvedService[] = [];
  for (const a of activated) resolvedRace.push(await core.resolveService(a.nc, space, endpoint, a.caller, { instanceId: a.instanceId, deadlineMs: 5000 }));
  assert.equal(Reflect.get(authKv, "direct"), false, "C01-policy-reads-use-original-leader-API");
  const beforeRace = [...effects], capturedBeforeRace = capturedAuthority.length;
  let rendezvousTimer: ReturnType<typeof setTimeout> | undefined;
  readersReady = new Promise<void>((resolve, reject) => {
    releaseReaders = resolve;
    rendezvousTimer = setTimeout(() => reject(new Error("C01-two-real-policy-read-rendezvous timed out")), 3000);
  });
  void readersReady.catch(() => { /* the awaiting real reads report the bounded failure */ });
  raceActive = true; rendezvousArmed = true;
  try {
    const replies = await Promise.all(activated.map((a, index) => core.invokeCommand(a.nc, space, resolvedRace[index], "increment", undefined, { deadlineMs: 5000 })));
    cell("C01-real-two-instance-open-head-rendezvous", readRevisions.length === 2 && readRevisions[0] === readRevisions[1] && casWins === 1 && casCodes.length === 1);
    const loser = replies.findIndex(reply => !reply.reply.ok), winner = replies.findIndex(reply => reply.reply.ok);
    assert.ok(loser >= 0 && winner >= 0 && loser !== winner, "C03-one-real-winner-one-loser");
    await waitFor(() => effects[winner] === beforeRace[winner] + 1, "C03-winner-native-effect");
    cell("C03-single-winner-no-loser-effect", effects[loser] === beforeRace[loser] && effects.reduce((sum, effect, i) => sum + effect - beforeRace[i], 0) === 1);
    await waitFor(() => capturedAuthority.slice(capturedBeforeRace).some(row => row.command === "ep-release"), "C05-winning-native-terminal-release");
    await host.flush();
    const raceRequests = capturedAuthority.slice(capturedBeforeRace);
    cell("C04-no-blind-admission-retry", raceRequests.filter(row => row.command === "ep-admit").length === 2 && raceRequests.filter(row => row.command === "ep-release").length === 1);
    const afterRace = await authKv.get(core.endpointPolicyKey(endpoint));
    const releaseArgs = raceRequests.find(row => row.command === "ep-release")!.args as { admissionId: string };
    const drainDeadline = Date.now() + 3000;
    let drain = await authKv.get(`endpoint-drain.${releaseArgs.admissionId}`);
    while (drain && JSON.parse(new TextDecoder().decode(drain.value)).state === "held" && Date.now() < drainDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      drain = await authKv.get(`endpoint-drain.${releaseArgs.admissionId}`);
    }
    cell("C05-winning-drain-terminal-and-policy-open", afterRace && JSON.parse(new TextDecoder().decode(afterRace.value)).state === "open" && drain && JSON.parse(new TextDecoder().decode(drain.value)).state === "terminal" && JSON.parse(new TextDecoder().decode(drain.value)).outcome === "executed");
    cell("C02-policy-cas-loss-remains-conflict-not-executed", replies[loser].reply.error?.code === "conflict" && replies[loser].reply.error?.outcome === "not-executed");
  } finally {
    raceActive = false; rendezvousArmed = false; releaseReaders(); clearTimeout(rendezvousTimer);
  }
  await hostedConnection.nc.flush(); hostedSubscription.unsubscribe();
  await host.flush(); authorityTap.unsubscribe();
  cell("N14-actual-admit-wire-matches-reviewed-contract", capturedAuthority.some(r => r.command === "ep-admit") && capturedAuthority.filter(r => r.command === "ep-admit").every(r => proposalAdmit(r.args)));
  cell("N15-actual-release-wire-matches-reviewed-contract", capturedAuthority.some(r => r.command === "ep-release") && capturedAuthority.filter(r => r.command === "ep-release").every(r => proposalRelease(r.args)));
  await refused("N16-policy-refuses-ungranted-caller", () => authority!.caller(tokens[0], { endpoint, instanceId: activated[0].instanceId, commands: ["other"], publicKey: core.newIdentity().id }), /caller policy denied/);
  const afterRefusal = await authKv.get(core.endpointPolicyKey(endpoint));
  cell("N17-validation-only-caller-refusal-releases-policy-head", afterRefusal && JSON.parse(new TextDecoder().decode(afterRefusal.value)).state === "open");
  assert.equal(checks.length, 44, "N11-explicit-native-census");
  cell("N11-explicit-native-census", true);
} catch (error) {
  failure = error;
  if (!hostedPrepare) console.error(error);
  else if (error instanceof assert.AssertionError && error.message === "PREPARE03-validation-only-refusal-releases-native-policy-head") console.error("AssertionError [ERR_ASSERTION]: PREPARE03-validation-only-refusal-releases-native-policy-head");
  else if (error instanceof assert.AssertionError && activePrepareCell !== undefined && error.message === activePrepareCell) console.error("AssertionError [ERR_ASSERTION]: " + activePrepareCell);
  else console.error("endpoint prepare entry failed before its named target or in a later control; private report retained");
}
finally {
  clearTimeout(timer);
  for (const worker of workers) {
    if (worker.child.connected) worker.child.send({ kind: "stop" });
    try { await waitFor(() => worker.messages.some(m => m.kind === "stopped"), "worker closure"); const exit = await worker.exit; cell("N12-separate-worker-closed-" + worker.child.pid, exit === 0); }
    catch (error) { cleanupErrors.push(String(error)); await killAndAwaitExit(worker.child); }
  }
  for (const handle of handles.reverse()) try { await handle.stop(); } catch (error) { cleanupErrors.push(String(error)); }
  try { await hostedObserver?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  try { await authority?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  for (const nc of connections.reverse()) { try { await nc.close(); await nc.closed(); } catch (error) { cleanupErrors.push(String(error)); } }
  if (!hostedPrepare) {
    if (broker) await killAndAwaitExit(broker); releaseBroker?.(); releasePath(); rmSync(dir, { recursive: true, force: true });
  } else {
    if (broker) await killAndAwaitExit(broker);
    if (broker && broker.exitCode === null && broker.signalCode === null) cleanupErrors.push("owned broker exit unconfirmed");
    else { releaseBroker?.(); rmSync(dir, { recursive: true, force: true }); releasePath(); }
  }
  writeFileSync(reportPath, JSON.stringify({ schema: "endpoint-u12-native-component.v1", checks, assertionCount: checks.length, effects, noManager: true, separateEndpointProcesses: true, startAuthServicePublicLifecycle: false, realUserCallout: false, fixtureAuthorityConnectionResidual: "explicit trusted account-store writers and broker-observe subscription, never participant material", fullU1U2Acceptance: false, ...(prepareRefusal !== undefined ? { prepareRefusal, prepareChecks, prepareAssertionCount: prepareChecks.length, prepareWriteAttempts, prepareDurableWrites } : {}), cleanupErrors, failure: failure ? String(failure) : null }, null, 2) + "\n", { mode: 0o600 });
  if (hostedPrepare) {
    const passed = checks.length + prepareChecks.length;
    const failedControls = namedControlsAttempted - passed;
    const setupFailure = failure && failedControls === 0 ? 1 : 0;
    const failed = failedControls + setupFailure + (cleanupErrors.length ? 1 : 0);
    console.log(JSON.stringify({ scope: "hosted-native-prepare-serving", namedControlsAttempted, namedControlsPassed: passed, namedControlsFailed: failedControls, setupFailure: !!setupFailure, cleanupConfirmed: cleanupErrors.length === 0, laterControlsUnreached: !!failure, reportRetained: true, fullEndpointAcceptance: false }));
    emitSentinel({ passed, failed });
  }
}
if (failure || cleanupErrors.length) process.exitCode = 1;
