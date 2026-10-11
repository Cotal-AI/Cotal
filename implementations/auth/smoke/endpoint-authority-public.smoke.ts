import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { spawn, fork, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { openSync, fstatSync, readSync, closeSync, constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { bearer } from "better-auth/plugins/bearer";
import { SignJWT, decodeJwt } from "jose";
import { toNodeHandler } from "better-auth/node";
import { connect, PermissionViolationError, type NatsConnection } from "@nats-io/transport-node";
import { fromSeed } from "@nats-io/nkeys";
import { Kvm } from "@nats-io/kv";
import * as core from "@cotal-ai/core";
import * as authApi from "@cotal-ai/auth";
import { recordMesh, userAuthStateDir } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, teardownOnSignal, teardownPathOnSignal, awaitBrokerReady, killAndAwaitExit, emitSentinel } from "@cotal-ai/smoke-kit";
import { MemoryStore } from "./_hosted-auth-fixture.js";
import { pickFreePort } from "./_free-port.js";
import { serializedFor } from "../src/serialized.js";
import { openAuthorityClient, type AuthorityClient } from "../src/authority-client.js";
import { runEndpointCallerCLI, type EndpointCallerCLIResult } from "../../cli/smoke/endpoint-caller-child.js";

const twoUserPublic = process.argv.includes("--two-user-public-acceptance");
// The diagnostic reuses the 37 public controls and adds 11 boundary observations, not retry acceptance.
const protocol3Diagnostic = process.argv.includes("--protocol3-public-entry-diagnostic");
const issuedPublicAcceptance = process.argv.includes("--issued-public-caller-acceptance");
const publicEntryScope = issuedPublicAcceptance ? "issued-public-caller-acceptance" : protocol3Diagnostic ? "protocol3-public-entry-diagnostic" : "two-real-user-public-component";
const publicReadControls = protocol3Diagnostic || issuedPublicAcceptance;
if (twoUserPublic || protocol3Diagnostic || issuedPublicAcceptance) {
  if (process.argv.slice(2).length !== 1 || ["ENDPOINT_PUBLIC_CLI", "ENDPOINT_U12_REPORT", "ENDPOINT_PREPARE_REFUSAL", "COTAL_HOME"].some(name => process.env[name] !== undefined)) throw new Error(issuedPublicAcceptance ? "issued public acceptance requires only --issued-public-caller-acceptance without fixture overrides" : protocol3Diagnostic ? "protocol3 diagnostic requires only --protocol3-public-entry-diagnostic without fixture overrides" : "two-user public entry requires only --two-user-public-acceptance without fixture overrides");
  const terminalLog = console.log.bind(console);
  try { await runTwoUserPublicAcceptance(); }
  catch {
    process.exitCode = 1;
    terminalLog(JSON.stringify({ scope: publicEntryScope, terminalFailure: true, cleanupConfirmed: false, reportRetained: false, fullEndpointAcceptance: false }));
    terminalLog("COTAL_SMOKE_SENTINEL cells=1 passed=0 failed=1");
  }
} else {
// CI source entry owns its report and login home. Child text stays in the private report.
// Named CLI predicates are separate from native A/B and installed-package acceptance.
const hostedCLI = process.argv.includes("--cli-describe-causal");
if (hostedCLI && (process.argv.slice(2).length !== 1 || ["ENDPOINT_PUBLIC_CLI", "ENDPOINT_U12_REPORT", "ENDPOINT_PREPARE_REFUSAL", "COTAL_HOME"].some(name => process.env[name] !== undefined))) throw new Error("hosted CLI entry requires only --cli-describe-causal without fixture overrides");
const publicLog = console.log.bind(console), publicError = console.error.bind(console);
if (hostedCLI) {
  // Dependency diagnostics are not part of this entry's public protocol.
  console.log = console.error = console.warn = console.info = console.debug = () => {};
}
const hostedReportDir = hostedCLI ? mkdtempSync(join(tmpdir(), "endpoint-cli-report-")) : undefined;
const cliMode = hostedCLI || process.env.ENDPOINT_PUBLIC_CLI === "1";
let namedControlsAttempted = 0, namedFailure: string | null = null;
let activeCLI: string | null = null, cliPhase: "setup" | "child" | "predicate" | "complete" = "setup";
const cliChecks: string[] = [];
const cliOutcomes: { cell: string; result: unknown }[] = [];
let cliCustodyOutstanding = false;
const reportPath = hostedReportDir ? join(hostedReportDir, "result.json") : process.env.ENDPOINT_U12_REPORT;
if (!reportPath) throw new Error("owned report required");
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "-endpoint-public-"));
const releasePath = teardownPathOnSignal(dir);
const previousFixtureHome = process.env.COTAL_HOME;
if (hostedCLI) {
  const fixtureHome = join(dir, "host-home");
  core.mkSecretDir(fixtureHome);
  process.env.COTAL_HOME = fixtureHome;
}
const checks: string[] = [], cleanupErrors: string[] = [], connections: NatsConnection[] = [];
const cell = (name: string, value: unknown) => { if (hostedCLI) { namedControlsAttempted++; namedFailure = name; } assert.ok(value, name); checks.push(name); namedFailure = null; (hostedCLI ? publicLog : console.log)(JSON.stringify({ cell: name, passed: true, scope: "public-http-native-callout-diagnostic" })); };
let broker: ReturnType<typeof spawn> | undefined, releaseBroker: (() => void) | undefined;
let handle: authApi.AuthServiceHandle | undefined, failure: unknown;
let policyWriter: AuthorityClient | undefined;
let servingHandle: core.EpServeHandle | undefined, effects = 0;
let restoreClockProbe: (() => void) | undefined;
let handler: ReturnType<typeof toNodeHandler> | undefined;
const idpHttp = createServer((req, res) => handler!(req, res));
const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), 150000);
try {
  // A real device login is the client identity. Deployment secrets are fixture-host custody only.
  await new Promise<void>(resolve => idpHttp.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(idpHttp.address() as { port: number }).port}`, idpUrl = `${origin}/api/auth`;
  const idp = betterAuth({ baseURL: origin, secret: "endpoint-public-test-secret-0123456789", database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }), emailAndPassword: { enabled: true }, plugins: [jwt({ jwt: { issuer: origin, audience: origin } }), deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: id => id === "cotal-cli" }), bearer()] });
  handler = toNodeHandler(idp);
  const signup = await idp.api.signUpEmail({ body: { email: "endpoint@example.test", password: "fixture-only-login-password", name: "Endpoint operator" }, returnHeaders: true });
  const cookie = signup.headers.get("set-cookie")!.split(";")[0];
  const approve = async (userCode: string) => {
    const claim = await fetch(`${idpUrl}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin } });
    assert.ok(claim.ok, "P01-device-claim");
    const response = await fetch(`${idpUrl}/device/approve`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify({ userCode }) });
    assert.ok(response.ok, "P01-device-approve");
  };
  const space = "publicep" + Date.now(), root = await core.createBrokerAuth("endpoint-public"), accountAuth = await core.createSpaceAccountAuth(root, space), auth = core.composeSpaceAuth(root, accountAuth);
  const stateDir = join(dir, "state"); mkdirSync(stateDir);
  const store = new MemoryStore({ kind: "injected", coordinate: `endpoint-public:${space}` });
  const prepared = await authApi.cotalAuthProvider.prepareServer({ store, dir: stateDir, space, idpUrl, operatorSeed: root.operator.seed!, account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed! } });
  const port = await pickFreePort(), servers = `nats://127.0.0.1:${port}`;
  writeFileSync(join(dir, "nats.conf"), core.serverConfig(root, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js"), extraAccounts: prepared.extraAccounts }), { mode: 0o600 });
  broker = spawn("nats-server", ["-c", join(dir, "nats.conf")], { stdio: "ignore" }); releaseBroker = teardownOnSignal(broker, dir);
  await awaitBrokerReady(() => core.isReachable(servers), { servers, attempts: 60, delayMs: 50 });
  await core.setupSpaceStreams({ servers, space, creds: await core.mintCreds(auth, core.newIdentity(), "provisioner") });
  const login = await authApi.establishIdpSession({ dir: process.env.COTAL_HOME!, idpUrl, clientId: "cotal-cli", onPrompt: prompt => approve(prompt.userCode) });
  cell("P01-genuine-device-login", typeof login.sub === "string" && !!login.sub);
  const owner = await authApi.cotalAuthProvider.ownerForLogin!({ store, dir: stateDir, space });
  const actor = authApi.grantActor(stateDir, { owner, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] });
  const principal = { owner, actor: "cli", uid: actor.lifecycleUid! };
  const endpoint = "test.example.public", account = { space, accountPublicKey: auth.account.pub, assignmentRevision: 1 };
  const input = { type: "null" }, output = { type: "object", properties: { effects: { type: "integer" } }, required: ["effects"], additionalProperties: false };
  const contract = { input: core.compileContract({ root: input }), output: core.compileContract({ root: output }) };
  const cluster = { urn: endpoint, revision: 1, attributes: [], events: [], commands: [{ name: "increment", class: "ephemeral", effect: "write", targeted: false, capability: "testcall", inputDigest: contract.input.closureDigest, outputDigest: contract.output.closureDigest }] };
  const manifest = core.singleDocumentClosure(cluster).manifest, closures = [core.contractDigest(manifest)];
  const artifacts = [input, output, { ...core.singleDocumentClosure(input).manifest }, { ...core.singleDocumentClosure(output).manifest }, cluster, { ...manifest }].map(value => ({ digest: core.contractDigest(value), value }));
  const decisions = new Map<string, core.EndpointInstanceAuthorityRequest>();
  const ceiling = { routes: { kind: "instance" as const }, resources: { kind: "ephemeral-only" as const }, expiresAt: Math.floor(Date.now() / 1000) + 120 };
  const policy: authApi.EndpointAuthorityPolicy = {
    namespace: async name => { assert.equal(name, endpoint); return { account, endpoint, governor: owner, namespaceRevision: 1, policyRevision: 1, clusterDigests: closures }; },
    actorIsCurrent: async p => core.canonicalJson(p) === core.canonicalJson(principal),
    serving: async (p, allocation) => { const binding = { account, holder: { owner: p.owner, actor: p.actor, lifecycleUid: p.uid, publicKey: allocation.publicKey }, authority: { namespaceRevision: 1, policyRevision: 1, delegationId: core.mintLifecycleUid(), delegationRevision: 1 }, ceiling }; decisions.set(allocation.instanceId, { account, endpoint, instanceId: allocation.instanceId, holder: binding.holder, clusterDigests: closures, expected: binding.authority, ceiling }); return binding; },
    authorizeInstance: async request => core.canonicalJson(decisions.get(request.instanceId)) === core.canonicalJson(request) ? { authorized: true, governor: owner, ref: request.expected, ceiling } : { authorized: false },
    caller: async (p, request) => { if (core.canonicalJson(p) !== core.canonicalJson(principal) || !decisions.has(request.instanceId) || request.endpoint !== endpoint || request.commands.some(command => command !== "increment")) throw new Error("caller policy denied"); return { capabilities: request.commands.map(command => ({ endpoint, command })), expiresAt: ceiling.expiresAt }; },
  };
  let currentAssignment: core.EndpointDeploymentAssignment | null = { account, lifecycleUid: core.mintLifecycleUid(), state: "active", expiresAt: ceiling.expiresAt };
  const assignment = structuredClone(currentAssignment), assignmentFlights = new Map<string, Promise<unknown>>();
  const deployment: core.EndpointAuthorityDeployment = { assignment, withCurrentAssignment: (expected, operation) => serializedFor(assignmentFlights, "deployment", async () => { if (!currentAssignment || core.canonicalJson(currentAssignment) !== core.canonicalJson(expected)) throw new Error("deployment assignment replaced"); core.parseEndpointDeploymentAssignment(currentAssignment); const result = await operation(); core.parseEndpointDeploymentAssignment(currentAssignment); return result; }) };
  handle = await authApi.startAuthService({ context: { accountPublicKey: account.accountPublicKey, lifecycleUid: core.mintLifecycleUid() }, space, servers, store, storeIdentity: store.identity, stateDir, endpointAuthority: { policy, deployment }, ...(cliMode ? { publicFace: { port: 0, trustedProxy: false } } : {}) });
  cell("P02-public-startAuthService-ready", (await handle.readiness()).state === "ready");
  // Embedded hosts publish their returned listener handle for the local registered provider.
  // startAuthService intentionally does not install the CLI daemon's ambient discovery file.
  authApi.saveAuthServiceInfo(stateDir, { url: handle.url, pid: process.pid, cap: handle.cap });
  // This deployment-owned policy setup is an explicit trusted fixture residual, not client authority.
  policyWriter = await openAuthorityClient({ server: servers, space, dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed! }, label: "public-fixture-policy-writer", grants: id => ({ publish: ["$JS.API.INFO", `$JS.API.STREAM.INFO.KV_${core.epAuthBucket(space)}`, `$JS.API.STREAM.MSG.GET.KV_${core.epAuthBucket(space)}`, `$KV.${core.epAuthBucket(space)}.${core.endpointPolicyKey(endpoint)}`], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
  const authKv = await new Kvm(policyWriter.nc).open(core.epAuthBucket(space));
  await core.provisionEndpointPolicyHead(authKv, endpoint, 1);
  const ordinary = await authApi.cotalAuthProvider.userCredentials({ store, dir: stateDir, space, actor: "cli" });
  cell("P03-root-provider-logged-in-bearer", !!ordinary.bearer && !!ordinary.sentinelCreds);
  const post = async (path: string, body: unknown, bearerToken = ordinary.bearer): Promise<Record<string, unknown>> => {
    const response = await fetch(handle!.url + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearerToken}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const value = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`public HTTP ${path} refused ${response.status}: ${value.error}`);
    return value;
  };
  const trust = await handle.endpointDeploymentTrust!();
  cell("R01-authenticated-host-trust-projection", trust.account.accountPublicKey === auth.account.pub && trust.account.assignmentRevision === 1 && trust.authority.endpoint === "auth" && trust.authority.epoch === 0 && trust.keys.every(key => !("d" in key)));
  const requestPins = { account: trust.account, assignmentLifecycleUid: trust.assignmentLifecycleUid, authority: trust.authority };
  const holder = core.newIdentity(), prepareId = core.mintLifecycleUid();
  const reservation = await post("/endpoint-service-authority", { v: 2, ...requestPins, operation: "prepare", operationId: prepareId, endpoint, holderPublicKey: holder.id });
  cell("P04-public-HTTP-prepare", typeof reservation.instanceId === "string" && reservation.state === "prepared");
  const instanceId = reservation.instanceId as string, operationId = core.mintLifecycleUid(), content = { action: "activate", registrationRevision: 0, processEpoch: 0, contractArtifacts: artifacts };
  const challenge = await post("/endpoint-service-authority", { v: 2, ...requestPins, operation: "challenge", operationId, instanceId, content });
  cell("P05-public-HTTP-challenge", challenge.instanceId === instanceId && challenge.operationId === operationId);
  const signature = Buffer.from(fromSeed(new TextEncoder().encode(holder.seed)).sign(new TextEncoder().encode(core.canonicalJson(challenge)))).toString("base64url");
  const active = await post("/endpoint-service-authority", { v: 2, ...requestPins, operation: "activate", operationId, instanceId, content, signature });
  cell("P06-public-HTTP-activate", typeof active.serveJwt === "string" && typeof active.attestation === "string" && active.processEpoch === 0);

  const selection = { endpoint, instanceId, commands: ["describe", "increment"] };
  const caller = await authApi.cotalAuthProvider.endpointCallerAuthority!({ store, dir: stateDir, space, actor: "cli", trust, selection });
  cell("R02-dedicated-signed-in-provider-receipt", caller.receipt.selection.instanceId === instanceId && caller.receipt.principal.owner === owner && caller.receipt.bearerDigest === core.rawDigest(caller.bearer));
  const options = core.standaloneConnectOpts({ tls: false, bearer: caller.bearer, sentinelCreds: caller.sentinelCreds });
  const callerNc = await connect({ servers, ...options, maxReconnectAttempts: 0 }); connections.push(callerNc);
  cell("P08-real-native-user-callout-connect", !callerNc.isClosed());
  const accepted = await core.issuedUserCaller(callerNc, space, options.name as string, caller.receipt.principal);
  cell("P09-native-connectionAcceptedToken-generation", accepted.owner === owner && accepted.actor === "cli" && accepted.uid === principal.uid && typeof accepted.generation === "string");
  await assert.rejects(core.issuedUserCaller(callerNc, space, options.name as string, { ...principal, uid: core.mintLifecycleUid() }), /not the caller/);
  cell("P10-wrong-expected-principal-refused", true);
  await assert.rejects(authApi.cotalAuthProvider.endpointCallerAuthority!({ store, dir: stateDir, space, actor: "cli", trust, selection: { ...selection, commands: ["describe", "other"] } }), /caller policy denied/);
  cell("P11-public-ungranted-command-refused", true);
  const control = await authApi.cotalAuthProvider.endpointServingControlAuthority!({ store, dir: stateDir, space, actor: "cli", trust, selection: { ...selection, commands: ["describe", "ep-check", "ep-admit", "ep-release"] }, credentialDigest: active.credentialDigest as string, holder: { publicKey: holder.id, sign: async bytes => fromSeed(new TextEncoder().encode(holder.seed)).sign(bytes) } });
  cell("R03-holder-proved-public-serving-control", control.receipt.kind === "cotal.endpoint-control" && control.receipt.selection.instanceId === instanceId);
  const controlOpts = core.standaloneConnectOpts({ tls: false, bearer: control.bearer, sentinelCreds: control.sentinelCreds });
  const controlNc = await connect({ servers, ...controlOpts, maxReconnectAttempts: 0 }); connections.push(controlNc);
  const controlCaller = await core.issuedUserCaller(controlNc, space, controlOpts.name as string, control.receipt.principal);
  const adoption = await core.adoptEndpointService({ nc: controlNc, authority: { space, instanceId: trust.authority.instanceId, epoch: trust.authority.epoch, caller: controlCaller }, trust: { issuer: trust.issuer, accountPublicKey: trust.account.accountPublicKey, assignmentRevision: trust.account.assignmentRevision, keys: trust.keys, accountSigningKey: trust.accountSigningKey }, serveJwt: active.serveJwt as string, attestation: active.attestation as string, artifacts, holder: { publicKey: holder.id, sign: async bytes => fromSeed(new TextEncoder().encode(holder.seed)).sign(bytes) } });
  const { fmtCreds } = await import("@nats-io/jwt");
  const serveNc = await connect({ servers, ...core.standaloneConnectOpts({ tls: false, creds: new TextDecoder().decode(fmtCreds(active.serveJwt as string, fromSeed(new TextEncoder().encode(holder.seed)))) }), maxReconnectAttempts: 0 }); connections.push(serveNc);
  servingHandle = core.serveEndpoint(serveNc, space, adoption.grant, [{ command: "increment", contract, handler: () => ({ effects: ++effects }) }], { view: () => { throw new Error("delegated describe must use authenticated stock admission"); } }, { requestAuthority: adoption.requestAuthority });
  await serveNc.flush();
  const runCLIChecks = async (handle: authApi.AuthServiceHandle) => {
    // Template matches are source-stage hints, not observed reach or trusted error provenance.
    // Root dispatch prints a plain message. A remote reason can imitate a local template.
    const classifyChildError = (result: EndpointCallerCLIResult) => {
      const templates: { id: string; sourceStageHint: string; pattern: RegExp }[] = [
        { id: "bootstrap-module", sourceStageHint: "bootstrap", pattern: /^Error \[ERR_MODULE_NOT_FOUND\]: Cannot find (?:package|module) .+$/ },
        { id: "dispatch-unknown-command", sourceStageHint: "dispatch", pattern: /^unknown command: .+$/ },
        { id: "catalog-preparation", sourceStageHint: "pre-command-catalog", pattern: /^space catalog for .+ failed: .+$/ },
        { id: "intent-instance-required", sourceStageHint: "intent", pattern: /^generic endpoint describe\/invoke requires explicit --on <instance>$/ },
        { id: "intent-unsupported", sourceStageHint: "intent", pattern: /^generic endpoint callers do not support raw credentials, admin, targeted or session intentions$/ },
        { id: "registry-no-mesh", sourceStageHint: "registry", pattern: /^no mesh running - run `cotal up` in a project, or pass `--server`$/ },
        { id: "registry-unknown-space", sourceStageHint: "registry", pattern: /^no mesh named "[^"]+" is running - see `cotal meshes`$/ },
        { id: "registry-trust-unreadable", sourceStageHint: "registry", pattern: /^space "[^"]+"'s trust material under .+ will not load \(.+\) - repair or remove the account record, then re-run `cotal up`$/ },
        { id: "trust-file-permissions", sourceStageHint: "protected-trust", pattern: /^endpoint deployment trust requires an owned (?:0700 directory|0600 regular file): .+$/ },
        { id: "trust-currentness", sourceStageHint: "protected-trust", pattern: /^(?:protected endpoint deployment trust is unsupported on this platform|endpoint deployment root must be a real directory|endpoint deployment trust directory changed while opening|endpoint deployment trust file changed or exceeds its byte bound|endpoint deployment trust changed while reading|endpoint deployment trust directory was replaced|endpoint deployment root was replaced|endpoint deployment trust was replaced; acquire a new caller before connecting)$/ },
        { id: "mesh-caller-selection", sourceStageHint: "caller-selection", pattern: /^(?:generic endpoint callers do not accept raw --creds|manager calls use the existing manager authority path|endpoint reply deadline must be positive|generic endpoint callers require a registered user-auth mesh|generic endpoint callers require the selected registry broker and root without a raw server override|generic endpoint callers require a configured account exchange URL)$/ },
        { id: "provider-selection", sourceStageHint: "provider", pattern: /^(?:registered endpoint auth provider differs from the selected mesh|the registered auth provider does not support dedicated endpoint caller acquisition)$/ },
        { id: "session-login-required", sourceStageHint: "login-session", pattern: /^not logged in to .+ - this space requires a user identity and there is no anonymous fallback; run `cotal login --idp .+`$/ },
        { id: "session-idp-refusal", sourceStageHint: "login-session", pattern: /^idp session: .+ (?:rejected the cached session \(expired or revoked\) - run `cotal login --idp .+` to sign in again|failed \(HTTP [1-5][0-9]{2}\)|returned no token)$/ },
        { id: "remote-material-missing", sourceStageHint: "ordinary-provider", pattern: /^space "[^"]+" has no user-auth material on this machine - run `cotal up --user-auth` where the mesh runs, or register a remote user mesh with `cotal meshes add .+ --from <url>` and sign in with `cotal login --idp <idp-url>`$/ },
        { id: "sentinel-unreadable", sourceStageHint: "ordinary-provider", pattern: /^space "[^"]+" is registered as a remote user mesh but its sentinel credential at .+ cannot be read \(.+\) - re-register with `cotal meshes add .+ --from <url>`$/ },
        { id: "ordinary-exchange-refused", sourceStageHint: "ordinary-exchange", pattern: /^signed in, but the exchange for actor "[^"]+"(?: \(view "[^"]+"\))? was refused(?:: .+|, and the exchange face withheld the reason \(HTTP [1-5][0-9]{2}\))$/ },
        { id: "ordinary-exchange-unavailable", sourceStageHint: "ordinary-exchange", pattern: /^the exchange for space "[^"]+" did not answer at .+ \(.+\) - check the network, or re-register with `cotal meshes add .+ --from <url>` if the mesh moved$/ },
        { id: "ordinary-exchange-no-token", sourceStageHint: "ordinary-exchange", pattern: /^the exchange at .+ returned no token - the mesh's auth service build may be stale$/ },
        { id: "authority-acquisition", sourceStageHint: "dedicated-authority", pattern: /^(?:endpoint deployment trust belongs to another space|endpoint acquisition requires a current ordinary signed-in user bearer|endpoint authority local listener is unavailable|endpoint authority has no pinned user exchange|closed endpoint caller response required|endpoint control requires a holder key and exact credential digest)$/ },
        { id: "authority-http-refusal", sourceStageHint: "dedicated-authority", pattern: /^endpoint authority refused [1-5][0-9]{2}: .+$/ },
        { id: "trust-record-binding", sourceStageHint: "trust-verification", pattern: /^(?:endpoint trust record kind\/space mismatch|endpoint trust record exchange origin mismatch|endpoint trust record account\/time mismatch|endpoint deployment assignment is not active|endpoint deployment assignment expired|endpoint deployment trust expired)$/ },
        { id: "receipt-verification", sourceStageHint: "receipt-verification", pattern: /^(?:endpoint caller material exceeds byte bound|unsupported endpoint receipt header|unknown endpoint receipt key|endpoint receipt issuer\/audience\/request\/time mismatch|endpoint receipt account\/assignment\/authority\/principal\/selection\/bearer mismatch|invalid endpoint receipt contract closures|endpoint bearer and verified receipt principal\/expiry disagree|dedicated endpoint caller receipt differs from the deployment and requested selection)$/ },
        { id: "accepted-connection", sourceStageHint: "accepted-connection", pattern: /^(?:dedicated endpoint caller connection has no issued nonce|unsupported accepted-row version|the accepted row names a foreign space|no accepted row for this token \(.+\); the connection holds no issued authority \(SPEC 13\.15\)|this connection's accepted row names .+, not the caller .+; refused \(SPEC 13\.15\))$/ },
        { id: "native-describe-refusal", sourceStageHint: "native-describe", pattern: /^describe\([^)]+\) failed: .+$/ },
        { id: "contract-resolution", sourceStageHint: "contract-resolution", pattern: /^(?:the cluster manifest .+ names root .+ but the root artifact is absent from the fetched closure \(SPEC 13\.7\)|schema closure .+ is missing its root .+ \(SPEC 13\.7\)|the recompiled schema closure hashes to .+, not the fetched .+; a store that served the wrong bytes never authorizes \(SPEC 13\.7\))$/ },
        { id: "descriptor-currency", sourceStageHint: "descriptor-binding", pattern: /^native endpoint descriptor and verified caller receipt currency disagree$/ },
        { id: "descriptor-principal", sourceStageHint: "descriptor-binding", pattern: /^native endpoint caller is not the verified issued principal$/ },
        { id: "descriptor-command-selection", sourceStageHint: "descriptor-binding", pattern: /^native endpoint descriptor widened the verified command selection$/ },
      ];
      const lines = result.stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const matched = new Map<string, string>();
      let unmatchedLines = 0;
      for (const line of lines) {
        const message = line.replace(/^(?:✗\s*){1,2}/u, "").replace(/^(?:permission-denied|failed-precondition|unavailable|internal|expired|conflict): /, "");
        const hits = templates.filter(template => template.pattern.test(message));
        if (!hits.length) unmatchedLines++;
        for (const hit of hits) matched.set(hit.id, hit.sourceStageHint);
      }
      const completeText = Buffer.byteLength(result.stderr) === result.stderrBytes;
      const state = matched.size > 1 ? "ambiguous" : matched.size === 1 && unmatchedLines === 0 && completeText ? "matched-template" : "unknown";
      return { state, templateHints: [...matched].map(([id, sourceStageHint]) => ({ id, sourceStageHint })), nonemptyLines: lines.length, unmatchedLines, completeText, observedStage: false, causalReasonEstablished: false };
    };
    // The host installs public trust. The child receives only its own remote registration,
    // genuine device-login session and public sentinel, never the injected store or signing seeds.
    assert.ok(handle.publicUrl, "CCLI-public-face-bound");
    const clientRoot = join(dir, "remote-client"), clientHome = join(dir, "remote-home");
    core.mkSecretDir(clientRoot);
    core.mkSecretDir(join(clientRoot, ".cotal"));
    core.mkSecretDir(join(clientRoot, ".cotal", "auth"));
    const clientState = userAuthStateDir(clientRoot, space);
    core.mkSecretDir(clientState);
    authApi.saveIdpSession(clientHome, idpUrl, login.session);
    const sentinelCredsPath = join(clientState, "sentinel.creds");
    core.writeSecretFile(sentinelCredsPath, ordinary.sentinelCreds);
    const publicUrl = handle.publicUrl;
    const clientRecord = { v: 2, kind: "cotal.endpoint-deployment-trust", space, exchangeOrigin: new URL(publicUrl).origin, provisionedAt: Math.floor(Date.now() / 1000), trust };
    core.parseEndpointDeploymentTrustRecord(clientRecord, { space, exchangeOrigin: new URL(publicUrl).origin });
    const trustPath = join(clientState, "endpoint-deployment-trust.json");
    core.writeSecretFile(trustPath, JSON.stringify(clientRecord));
    const previousHome = process.env.COTAL_HOME;
    try {
      process.env.COTAL_HOME = clientHome;
      recordMesh({ space, server: servers, root: clientRoot, mode: "user", origin: "manual", ts: new Date().toISOString(), userAuth: { provider: authApi.cotalAuthProvider.name, idp: { url: idpUrl, issuer: origin, audience: origin }, remote: true, endpoints: { url: publicUrl }, sentinelCredsPath } });
    } finally {
      if (previousHome === undefined) delete process.env.COTAL_HOME;
      else process.env.COTAL_HOME = previousHome;
    }
    // This is the source composition root with the existing seed guard, not an installed CLI.
    // Explicit --space selects the separate remote root even though tsx resolves from the checkout.
    const childInput = { cwd: fileURLToPath(new URL("../../../", import.meta.url)), timeoutMs: 30000, closeWaitMs: 1000, maxOutputBytes: 8192, env: { PATH: process.env.PATH, HOME: clientHome, COTAL_HOME: clientHome, XDG_CONFIG_HOME: join(clientHome, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" } };
    const secrets = [login.session.token, ordinary.bearer, ordinary.sentinelCreds, caller.bearer, control.bearer, handle.cap, holder.seed, root.operator.seed!, auth.account.signingSeed!, active.serveJwt as string, active.attestation as string, cookie];
    const diagnostic = (text: string) => {
      let redacted = text;
      for (const secret of secrets) if (secret) redacted = redacted.split(secret).join("[redacted]");
      redacted = redacted.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]").replace(/\bS[A-Z2-7]{57}\b/g, "[redacted-seed]");
      const bytes = Buffer.from(redacted);
      return { text: bytes.subarray(0, 8192).toString("utf8"), originalBytes: Buffer.byteLength(text), redactedBytes: bytes.length, truncated: bytes.length > 8192 };
    };
    const runCLI = async (name: string, args: string[]) => {
      if (hostedCLI) { activeCLI = name; cliPhase = "child"; }
      let result: EndpointCallerCLIResult;
      try {
        result = await runEndpointCallerCLI(childInput, args);
      } catch (error) {
        cliCustodyOutstanding = true;
        cliOutcomes.push({ cell: name, result: { returnedResult: false, errorName: error instanceof Error ? error.name : "unknown", error: diagnostic(String(error)), reportedBoundary: "child-helper-rejected-before-result", terminalCustodyEstablished: false } });
        throw error;
      }
      cliCustodyOutstanding = !result.closeObserved || result.closeWaitExpired;
      cliOutcomes.push({ cell: name, result: { code: result.code, signal: result.signal, timedOut: result.timedOut, closeObserved: result.closeObserved, closeWaitExpired: result.closeWaitExpired, killAttempted: result.killAttempted, killAccepted: result.killAccepted, killError: result.killError === null ? null : diagnostic(result.killError), terminationReason: result.terminationReason, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes, spawnError: result.spawnError === null ? null : { code: result.spawnError.code, message: diagnostic(result.spawnError.message) }, childError: result.childError === null ? null : { code: result.childError.code, message: diagnostic(result.childError.message) }, stdout: diagnostic(result.stdout), stderr: diagnostic(result.stderr), custody: cliCustodyOutstanding ? "unknown" : "known-child-close-observed", reportedBoundary: result.stderr.includes("native endpoint descriptor and verified caller receipt currency disagree") ? "receipt-currency-refusal" : "unclassified-child-result" } });
      assert.ok(!cliCustodyOutstanding, name + "-known-child-close-required-custody-unknown");
      assert.ok(!result.timedOut && result.terminationReason === null && result.spawnError === null && result.childError === null && !result.killAttempted && result.killAccepted === null && result.killError === null, name + "-ordinary-child-result-required");
      if (hostedCLI) publicLog(JSON.stringify({ scope: "hosted-source-cli-error-template-hints", cell: name, classification: classifyChildError(result) }));
      if (hostedCLI) publicLog(JSON.stringify({ scope: "hosted-source-cli-child-result", cell: name, code: result.code, signalObserved: result.signal !== null, timedOut: result.timedOut, closeObserved: result.closeObserved, closeWaitExpired: result.closeWaitExpired, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes, receiptCurrencyRefusalObserved: result.stderr.includes("native endpoint descriptor and verified caller receipt currency disagree"), stdoutHasEndpoint: result.stdout.includes(endpoint), stdoutHasOwner: result.stdout.includes(`owner ${owner}`), stdoutHasInstance: result.stdout.includes(`instance ${instanceId}`), effects }));
      return result;
    };
    const cliCell = (name: string, value: unknown) => { if (hostedCLI) { cliPhase = "predicate"; namedControlsAttempted++; namedFailure = name; } assert.ok(value, name); cliChecks.push(name); namedFailure = null; (hostedCLI ? publicLog : console.log)(JSON.stringify({ cell: name, passed: true, scope: "source-cli-remote-describe-diagnostic" })); };
    const describe = await runCLI("CCLI01", ["describe", endpoint, "--on", instanceId, "--space", space]);
    cliCell("CCLI01-source-remote-describe-exact-instance-zero-effect", describe.code === 0 && describe.signal === null && !describe.timedOut && describe.stdout.includes(endpoint) && describe.stdout.includes(`owner ${owner}`) && describe.stdout.includes(`instance ${instanceId}`) && effects === 0);
    const wrongInstance = core.mintLifecycleUid();
    const wrong = await runCLI("CCLI02", ["describe", endpoint, "--on", wrongInstance, "--space", space]);
    cliCell("CCLI02-source-remote-wrong-instance-refused-zero-effect", wrong.code === 1 && wrong.signal === null && !wrong.timedOut && wrong.stderr.includes(`endpoint authority record endpoint-reservation.${wrongInstance} is absent/deleted`) && effects === 0);
    const ungranted = await runCLI("CCLI03", ["invoke", endpoint, "other", "--on", instanceId, "--space", space]);
    cliCell("CCLI03-source-remote-ungranted-command-refused-zero-effect", ungranted.code === 1 && ungranted.signal === null && !ungranted.timedOut && ungranted.stderr.includes("caller policy denied") && effects === 0);
    core.writeSecretFile(trustPath, JSON.stringify({ ...clientRecord, exchangeOrigin: "https://other.example" }));
    const wrongOrigin = await runCLI("CCLI04", ["describe", endpoint, "--on", instanceId, "--space", space]);
    cliCell("CCLI04-source-remote-wrong-trust-origin-refused-zero-effect", wrongOrigin.code === 1 && wrongOrigin.signal === null && !wrongOrigin.timedOut && wrongOrigin.stderr.includes("endpoint trust record exchange origin mismatch") && effects === 0);
    if (hostedCLI) { activeCLI = null; cliPhase = "complete"; }
  };
  // Hosted mode selects CLI-first diagnostic reach, not a change to either selection.
  if (hostedCLI) await runCLIChecks(handle);
  const describeSelection = { endpoint, instanceId, commands: ["describe"] };
  const describeCaller = await authApi.cotalAuthProvider.endpointCallerAuthority!({ store, dir: stateDir, space, actor: "cli", trust, selection: describeSelection });
  assert.equal(describeCaller.receipt.kind, "cotal.endpoint-caller");
  if (describeCaller.receipt.kind !== "cotal.endpoint-caller" || caller.receipt.kind !== "cotal.endpoint-caller") throw new Error("ordinary caller receipt required");
  const describeOptions = core.standaloneConnectOpts({ tls: false, bearer: describeCaller.bearer, sentinelCreds: describeCaller.sentinelCreds });
  const describeNc = await connect({ servers, ...describeOptions, maxReconnectAttempts: 0 }); connections.push(describeNc);
  const describeAccepted = await core.issuedUserCaller(describeNc, space, describeOptions.name as string, describeCaller.receipt.principal);
  const privateDescribe = await core.resolveService(describeNc, space, endpoint, describeAccepted, { instanceId, deadlineMs: 5000 });
  core.assertEndpointCallerResolvedService(privateDescribe, describeCaller.receipt);
  cell("BIND01-real-describe-only-full-registration-empty-private-view", describeCaller.receipt.v === 3 && describeCaller.receipt.clusterDigests.length === 1 && describeCaller.receipt.privateClusterDigests.length === 0 && privateDescribe.descriptor?.clusters.length === 0 && privateDescribe.commands.size === 0 && effects === 0);
  const privateDescriptor = privateDescribe.descriptor;
  assert.ok(privateDescriptor);
  const foreignClosure = core.rawDigest("foreign binding closure");
  const rejectBinding = (name: string, service: core.ResolvedService, receipt: core.EndpointCallerAuthorityReceipt) => {
    if (hostedCLI) { namedControlsAttempted++; namedFailure = name; }
    assert.throws(() => core.assertEndpointCallerResolvedService(service, receipt), /currency disagree|projection disagree|private contract projection|verified issued principal|widened the verified command selection/, name);
    assert.equal(effects, 0, name);
    checks.push(name); namedFailure = null;
    (hostedCLI ? publicLog : console.log)(JSON.stringify({ cell: name, passed: true, scope: "native-derived-adversarial-binding-input" }));
  };
  rejectBinding("BIND02-empty-view-wrong-full-registration-commitment-refused", { ...privateDescribe, descriptor: { ...privateDescriptor, registeredClusterSetDigest: foreignClosure } }, describeCaller.receipt);
  const missingCommitment = { ...privateDescriptor };
  delete missingCommitment.registeredClusterSetDigest;
  rejectBinding("BIND03-empty-view-missing-full-registration-commitment-refused", { ...privateDescribe, descriptor: missingCommitment }, describeCaller.receipt);
  rejectBinding("BIND04-empty-view-substituted-signed-full-set-refused", privateDescribe, { ...describeCaller.receipt, clusterDigests: [foreignClosure] });
  rejectBinding("BIND05-private-extra-visible-closure-refused", { ...privateDescribe, descriptor: { ...privateDescriptor, clusters: [{ digest: closures[0]!, commands: ["increment"] }] } }, describeCaller.receipt);
  rejectBinding("BIND06-private-signed-closure-outside-full-set-refused", privateDescribe, { ...describeCaller.receipt, privateClusterDigests: [foreignClosure] });
  rejectBinding("BIND07-empty-view-wrong-caller-owner-refused", { ...privateDescribe, caller: { ...describeAccepted, owner: "u_" + "b".repeat(26) } }, describeCaller.receipt);
  rejectBinding("BIND08-empty-view-wrong-responder-instance-refused", { ...privateDescribe, responder: { ...privateDescribe.responder, instanceId: core.mintLifecycleUid() } }, describeCaller.receipt);
  rejectBinding("BIND09-empty-view-stale-process-epoch-refused", { ...privateDescribe, responder: { ...privateDescribe.responder, epoch: privateDescribe.responder.epoch + 1 } }, describeCaller.receipt);
  rejectBinding("BIND10-empty-view-stale-registration-revision-refused", { ...privateDescribe, descriptor: { ...privateDescriptor, registrationRevision: describeCaller.receipt.registrationRevision + 1 } }, describeCaller.receipt);
  rejectBinding("BIND11-empty-view-substituted-serving-authority-refused", { ...privateDescribe, descriptor: { ...privateDescriptor, servingAuthority: { ...describeCaller.receipt.servingAuthority, policyRevision: describeCaller.receipt.servingAuthority.policyRevision + 1 } } }, describeCaller.receipt);
  rejectBinding("BIND12-empty-view-expired-receipt-refused", privateDescribe, { ...describeCaller.receipt, exp: 1 });
  rejectBinding("BIND12b-empty-view-wrong-caller-actor-refused", { ...privateDescribe, caller: { ...describeAccepted, actor: "foreign" } }, describeCaller.receipt);
  rejectBinding("BIND12c-empty-view-wrong-caller-lifecycle-refused", { ...privateDescribe, caller: { ...describeAccepted, uid: core.mintLifecycleUid() } }, describeCaller.receipt);
  rejectBinding("BIND12d-empty-view-missing-issued-generation-refused", { ...privateDescribe, caller: { owner: describeAccepted.owner, actor: describeAccepted.actor, uid: describeAccepted.uid } }, describeCaller.receipt);
  rejectBinding("BIND12e-empty-view-wrong-pinned-instance-refused", { ...privateDescribe, pinnedInstanceId: core.mintLifecycleUid() }, describeCaller.receipt);
  rejectBinding("BIND12f-empty-view-wrong-endpoint-refused", { ...privateDescribe, endpoint: "foreign.example.endpoint" }, describeCaller.receipt);
  const missingRoutes = { ...privateDescriptor };
  delete missingRoutes.serveRoutes;
  rejectBinding("BIND12g-empty-view-missing-instance-route-ceiling-refused", { ...privateDescribe, descriptor: missingRoutes }, describeCaller.receipt);
  const missingResources = { ...privateDescriptor };
  delete missingResources.resources;
  rejectBinding("BIND12h-empty-view-missing-resource-ceiling-refused", { ...privateDescribe, descriptor: missingResources }, describeCaller.receipt);
  assert.equal(core.endpointRegisteredClusterSetDigest([closures[0]!, foreignClosure]), core.endpointRegisteredClusterSetDigest([foreignClosure, closures[0]!]));
  cell("BIND13-full-registration-commitment-canonical-order", true);
  assert.throws(() => core.endpointRegisteredClusterSetDigest([closures[0]!, closures[0]!]), /unique/);
  cell("BIND14-full-registration-duplicate-closure-refused", true);
  assert.throws(() => core.endpointRegisteredClusterSetDigest([]), /1\.\.64/);
  assert.throws(() => core.endpointRegisteredClusterSetDigest(["not-a-digest"]), /closure digests/);
  assert.throws(() => core.endpointRegisteredClusterSetDigest(Array.from({ length: 65 }, (_, index) => core.rawDigest(String(index)))), /1\.\.64/);
  cell("BIND14b-full-registration-empty-invalid-oversized-set-refused", true);
  assert.throws(() => core.parseDescribeDescriptor(missingCommitment), /registered cluster set/);
  cell("BIND15-protocol3-missing-commitment-parser-refused", true);
  for (const version of [1, 2]) {
    const legacy = { endpoint, owner, protocol: { v: version }, clusters: [] };
    core.parseDescribeDescriptor(legacy);
    assert.throws(() => core.parseDescribeDescriptor({ ...legacy, registeredClusterSetDigest: foreignClosure }), /legacy descriptor/);
    cell(`BIND16-legacy-protocol${version}-shape-preserved`, true);
  }
  const realIssuer = await authApi.loadIssuer(store, space);
  assert.ok(realIssuer);
  const oldReceipt = { ...describeCaller.receipt };
  Reflect.set(oldReceipt, "v", 2);
  await assert.rejects(realIssuer.signEndpointCallerReceipt(oldReceipt), /invalid endpoint caller receipt domain/);
  cell("BIND16b-real-issuer-old-receipt-version-refused", true);
  const missingPrivate = { ...describeCaller.receipt };
  Reflect.deleteProperty(missingPrivate, "privateClusterDigests");
  const missingPrivateSigned = await realIssuer.signEndpointCallerReceipt(missingPrivate);
  await assert.rejects(core.verifyEndpointCallerAuthorityReceipt({ receipt: missingPrivateSigned, bearer: describeCaller.bearer, trust, requestId: describeCaller.receipt.jti, selection: describeSelection, principal }), /closed shape/);
  cell("BIND17-real-issuer-signed-missing-private-projection-refused", true);
  const outsidePrivateSigned = await realIssuer.signEndpointCallerReceipt({ ...describeCaller.receipt, privateClusterDigests: [foreignClosure] });
  await assert.rejects(core.verifyEndpointCallerAuthorityReceipt({ receipt: outsidePrivateSigned, bearer: describeCaller.bearer, trust, requestId: describeCaller.receipt.jti, selection: describeSelection, principal }), /private contract projection/);
  cell("BIND18-real-issuer-signed-private-outside-full-set-refused", true);
  const duplicatePrivateSigned = await realIssuer.signEndpointCallerReceipt({ ...describeCaller.receipt, privateClusterDigests: [closures[0]!, closures[0]!] });
  await assert.rejects(core.verifyEndpointCallerAuthorityReceipt({ receipt: duplicatePrivateSigned, bearer: describeCaller.bearer, trust, requestId: describeCaller.receipt.jti, selection: describeSelection, principal }), /private contract projection/);
  cell("BIND18b-real-issuer-signed-duplicate-private-projection-refused", true);
  const unexpectedPrivateSigned = await realIssuer.signEndpointCallerReceipt({ ...describeCaller.receipt, privateClusterDigests: [closures[0]!] });
  await assert.rejects(core.verifyEndpointCallerAuthorityReceipt({ receipt: unexpectedPrivateSigned, bearer: describeCaller.bearer, trust, requestId: describeCaller.receipt.jti, selection: describeSelection, principal }), /private projection and selected commands disagree/);
  cell("BIND18c-real-issuer-signed-describe-only-nonempty-private-projection-refused", true);
  assert.equal(control.receipt.kind, "cotal.endpoint-control");
  const controlWithPrivate = { ...control.receipt, privateClusterDigests: [] };
  const controlWithPrivateSigned = await realIssuer.signEndpointCallerReceipt(controlWithPrivate);
  await assert.rejects(core.verifyEndpointCallerAuthorityReceipt({ receipt: controlWithPrivateSigned, bearer: control.bearer, trust, requestId: control.receipt.jti, selection: control.receipt.selection, principal, control: true }), /closed shape/);
  cell("BIND19-real-issuer-signed-control-private-field-refused", true);
  const resolved = await core.resolveService(callerNc, space, endpoint, accepted, { instanceId, deadlineMs: 5000 });
  core.assertEndpointCallerResolvedService(resolved, caller.receipt);
  cell("R04-native-descriptor-receipt-bound", resolved.responder.instanceId === instanceId && resolved.owner === owner);
  const selectedDescriptor = resolved.descriptor;
  assert.ok(selectedDescriptor);
  cell("BIND20-real-selected-command-private-view-bound", caller.receipt.privateClusterDigests.length === 1 && selectedDescriptor.clusters.length === 1 && effects === 0);
  const omittedPrivateSigned = await realIssuer.signEndpointCallerReceipt({ ...caller.receipt, privateClusterDigests: [] });
  await assert.rejects(core.verifyEndpointCallerAuthorityReceipt({ receipt: omittedPrivateSigned, bearer: caller.bearer, trust, requestId: caller.receipt.jti, selection, principal }), /private projection and selected commands disagree/);
  cell("BIND20b-real-issuer-signed-selected-command-empty-private-projection-refused", true);
  rejectBinding("BIND21-selected-view-omitted-private-closure-refused", { ...resolved, descriptor: { ...selectedDescriptor, clusters: [] } }, caller.receipt);
  const widenedCommands = new Map(resolved.commands);
  const incrementCommand = widenedCommands.get("increment");
  assert.ok(incrementCommand);
  widenedCommands.set("other", { ...incrementCommand, command: "other" });
  rejectBinding("BIND22-selected-view-extra-resolved-command-refused", { ...resolved, commands: widenedCommands }, caller.receipt);
  if (cliMode && !hostedCLI) await runCLIChecks(handle);
  const invoked = await core.invokeCommand(callerNc, space, resolved, "increment", undefined, { deadlineMs: 5000 });
  cell("R05-native-effect-through-public-caller-control", invoked.reply.ok && effects === 1);
  await assert.rejects(core.resolveService(callerNc, space, endpoint, accepted, { deadlineMs: 1200 }), /permission-denied|REFUSED BY THE BROKER/);
  cell("R06-class-request-broker-refused-no-effect", effects === 1);
  await assert.rejects(authApi.cotalAuthProvider.endpointCallerAuthority!({ store, dir: stateDir, space, actor: "cli", trust: { ...trust, account: { ...trust.account, assignmentRevision: 2 } }, selection }), /pins changed/);
  cell("R07-wrong-assignment-revision-refused", effects === 1);
  const receiptRequestId = core.mintLifecycleUid();
  const signed = await post("/endpoint-caller-authority", { v: 2, ...requestPins, requestId: receiptRequestId, ...selection });
  await assert.rejects(core.verifyEndpointCallerAuthorityReceipt({ receipt: signed.receipt as string, bearer: signed.token as string, trust, requestId: core.mintLifecycleUid(), selection, principal }), /request\/time mismatch/, "R10-signed-receipt-request-replay-refused");
  cell("R10-signed-receipt-request-replay-refused", effects === 1);
  await assert.rejects(core.verifyEndpointCallerAuthorityReceipt({ receipt: signed.receipt as string, bearer: signed.token + "changed", trust, requestId: receiptRequestId, selection, principal }), /bearer mismatch/, "R11-signed-receipt-bearer-substitution-refused");
  cell("R11-signed-receipt-bearer-substitution-refused", effects === 1);
  await assert.rejects(authApi.cotalAuthProvider.endpointCallerAuthority!({ store, dir: stateDir, space, actor: "cli", trust: { ...trust, authority: { ...trust.authority, epoch: 1 } }, selection }), /pins changed/, "R12-stale-native-auth-epoch-refused");
  cell("R12-stale-native-auth-epoch-refused", effects === 1);
  const foreignHolder = core.newIdentity();
  await assert.rejects(authApi.cotalAuthProvider.endpointServingControlAuthority!({ store, dir: stateDir, space, actor: "cli", trust, selection: { ...selection, commands: ["describe", "ep-check", "ep-admit", "ep-release"] }, credentialDigest: active.credentialDigest as string, holder: { publicKey: foreignHolder.id, sign: async bytes => fromSeed(new TextEncoder().encode(foreignHolder.seed)).sign(bytes) } }), /holder proof/, "R13-foreign-holder-control-proof-refused");
  cell("R13-foreign-holder-control-proof-refused", effects === 1);
  const record = { v: 2, kind: "cotal.endpoint-deployment-trust", space, exchangeOrigin: new URL(handle.url).origin, provisionedAt: Math.floor(Date.now() / 1000), trust };
  core.parseEndpointDeploymentTrustRecord(record, { space, exchangeOrigin: new URL(handle.url).origin });
  assert.throws(() => core.parseEndpointDeploymentTrustRecord(record, { space, exchangeOrigin: "https://other.example" }), /origin mismatch/, "R14-protected-root-record-wrong-origin-refused");
  cell("R14-protected-root-record-wrong-origin-refused", true);
  assert.throws(() => core.parseEndpointDeploymentTrust({ ...trust, keys: [{ ...trust.keys[0], d: "private" }] }), /closed shape/, "R15-root-trust-private-key-refused");
  cell("R15-root-trust-private-key-refused", true);
  const writeProto = Object.getPrototypeOf(authKv) as { create: typeof authKv.create; update: typeof authKv.update };
  const originalWriteCreate = writeProto.create, originalWriteUpdate = writeProto.update;
  const denialWrites: string[] = [];
  writeProto.create = async function (...args: Parameters<typeof originalWriteCreate>) { const revision = await originalWriteCreate.apply(this, args); denialWrites.push(args[0]); return revision; };
  writeProto.update = async function (...args: Parameters<typeof originalWriteUpdate>) { const revision = await originalWriteUpdate.apply(this, args); denialWrites.push(args[0]); return revision; };
  restoreClockProbe = () => { writeProto.create = originalWriteCreate; writeProto.update = originalWriteUpdate; };
  await assert.rejects(post("/endpoint-caller-authority", { v: 2, ...requestPins, account: { ...trust.account, assignmentRevision: 2 }, requestId: core.mintLifecycleUid(), ...selection }), /pins changed/);
  await assert.rejects(post("/endpoint-caller-authority", { v: 2, ...requestPins, requestId: core.mintLifecycleUid(), ...selection, owner: "untrusted" }), /closed endpoint/);
  await assert.rejects(post("/endpoint-service-authority", { v: 2, ...requestPins, operation: "control", requestId: core.mintLifecycleUid(), endpoint, instanceId, commands: ["describe", "ep-check", "ep-admit", "ep-release"], credentialDigest: active.credentialDigest, signature: Buffer.from(fromSeed(new TextEncoder().encode(foreignHolder.seed)).sign(new Uint8Array([1]))).toString("base64url") }), /holder proof/);
  restoreClockProbe(); restoreClockProbe = undefined;
  const materialWrites = denialWrites.filter(key => /^(cred\.|endpoint-grant\.|endpoint-reservation\.|endpoint-active\.|accepted\.|svc\.)/.test(key));
  console.log(JSON.stringify({ oracle: "A42-04", deniedRequests: 3, durableWrites: denialWrites.length, materialWrites: materialWrites.length, policyHoldWrites: denialWrites.filter(key => key === core.endpointPolicyKey(endpoint)).length, effects }));
  cell("A42-04-denied-public-pins-holder-zero-material-writes", materialWrites.length === 0 && effects === 1);
  if (process.env.A42_UNCERTAIN_ACCEPTED === "1") {
    const uncertainOptions = core.standaloneConnectOpts({ tls: false, bearer: caller.bearer, sentinelCreds: caller.sentinelCreds });
    const acceptedKey = core.acceptedKey(core.connectionAcceptedToken(uncertainOptions.name as string));
    const proto = Object.getPrototypeOf(authKv) as { create: typeof authKv.create };
    const originalCreate = proto.create;
    let acceptedDurableWriteObserved = false;
    proto.create = async function (...args: Parameters<typeof originalCreate>) {
      const revision = await originalCreate.apply(this, args);
      if (args[0] === acceptedKey) {
        acceptedDurableWriteObserved = true;
        throw new Error("fixture lost accepted-row acknowledgement after real broker durable write");
      }
      return revision;
    };
    restoreClockProbe = () => { proto.create = originalCreate; };
    let uncertainConnected = false;
    try { const escaped = await connect({ servers, ...uncertainOptions, maxReconnectAttempts: 0 }); connections.push(escaped); uncertainConnected = true; } catch { /* native refusal required */ }
    restoreClockProbe(); restoreClockProbe = undefined;
    const heldEntry = await authKv.get(core.endpointPolicyKey(endpoint));
    const held = heldEntry ? JSON.parse(new TextDecoder().decode(heldEntry.value)) as { state?: string } : undefined;
    cell("A42-02-real-accepted-durable-write-observed", acceptedDurableWriteObserved);
    cell("A42-02-uncertain-write-no-native-permission-release", !uncertainConnected && effects === 1);
    cell("A42-02-uncertain-accepted-write-retains-policy-custody", held?.state === "held");
    let replayConnected = false;
    try { const replay = await connect({ servers, ...uncertainOptions, maxReconnectAttempts: 0 }); connections.push(replay); replayConnected = true; } catch { /* uncertain held operation must refuse replay */ }
    cell("A42-02-same-nonce-uncertain-replay-refused", !replayConnected && effects === 1);
  } else {
  const freshIdp = await authApi.fetchIdpJwt(idpUrl, login.session.token);
  const shortExchange = await fetch(handle.url + "/exchange", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${handle.cap}` }, body: JSON.stringify({ idpToken: freshIdp, actor: "cli", ttlSec: 4 }) });
  assert.ok(shortExchange.ok, "A42-01-real-short-user-exchange");
  const shortBearer = (await shortExchange.json() as { token: string }).token, shortExp = decodeJwt(shortBearer).exp!;
  const kvProto = Object.getPrototypeOf(authKv) as { get: typeof authKv.get };
  const originalGet = kvProto.get, originalSign = SignJWT.prototype.sign;
  let signedReceipt = false, authReadsAfterSign = 0, finalReadDelayed = false;
  SignJWT.prototype.sign = async function (...args: Parameters<typeof originalSign>) {
    const value = await originalSign.apply(this, args);
    if (decodeJwt(value).kind === "cotal.endpoint-caller") signedReceipt = true;
    return value;
  };
  kvProto.get = async function (...args: Parameters<typeof originalGet>) {
    if (signedReceipt && args[0] === core.epgateKey("auth", trust.authority.instanceId) && ++authReadsAfterSign === 2) {
      finalReadDelayed = true;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, shortExp * 1000 + 50 - Date.now())));
    }
    return originalGet.apply(this, args);
  };
  restoreClockProbe = () => { kvProto.get = originalGet; SignJWT.prototype.sign = originalSign; };
  const delayedReply = await fetch(handle.url + "/endpoint-caller-authority", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${shortBearer}` }, body: JSON.stringify({ v: 2, ...requestPins, requestId: core.mintLifecycleUid(), ...selection }), signal: AbortSignal.timeout(15000) });
  await delayedReply.json();
  restoreClockProbe(); restoreClockProbe = undefined;
  cell("A42-01-final-broker-await-crossed-user-expiry", signedReceipt && finalReadDelayed && Date.now() >= shortExp * 1000);
  cell("A42-01-expired-caller-no-material-after-final-await", !delayedReply.ok && effects === 1);
  await policyWriter.close();
  policyWriter = await openAuthorityClient({ server: servers, space, dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed! }, label: "public-fixture-freeze-writer", grants: id => ({ publish: ["$JS.API.INFO", `$JS.API.STREAM.INFO.KV_${core.epAuthBucket(space)}`, `$JS.API.STREAM.MSG.GET.KV_${core.epAuthBucket(space)}`, `$KV.${core.epAuthBucket(space)}.${core.endpointPolicyKey(endpoint)}`, `$KV.${core.epAuthBucket(space)}.${core.epgateKey(endpoint, instanceId)}`], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
  const freezeKv = await new Kvm(policyWriter.nc).open(core.epAuthBucket(space));
  const freezeOperation = core.mintLifecycleUid(), freezeHold = await core.acquireEndpointPolicyHold(freezeKv, { endpoint, policyRevision: 1, operationId: freezeOperation, content: { kind: "native-frozen-caller-repro", instanceId } });
  const barrier = core.endpointRegistrationBarrier(freezeKv, space, { endpoint, instanceId, opId: freezeOperation, policyHold: freezeHold });
  const observed = await barrier.observe();
  assert.ok(observed, "A42-03-live-gate-observed");
  const frozenToken = await barrier.freeze(observed.revision);
  assert.ok(frozenToken !== null, "A42-03-native-freeze-CAS");
  await freezeHold.release();
  cell("A42-03-native-serving-gate-frozen", true);
  const frozenOptions = core.standaloneConnectOpts({ tls: false, bearer: caller.bearer, sentinelCreds: caller.sentinelCreds });
  let frozenAccepted = false;
  try { const leaked = await connect({ servers, ...frozenOptions, maxReconnectAttempts: 0 }); connections.push(leaked); frozenAccepted = true; } catch { /* broker refusal is the required outcome */ }
  cell("A42-03-frozen-serving-gate-refuses-caller-reconnect", !frozenAccepted && effects === 1);
  await serializedFor(assignmentFlights, "deployment", async () => { currentAssignment = null; });
  await assert.rejects(authApi.cotalAuthProvider.endpointCallerAuthority!({ store, dir: stateDir, space, actor: "cli", trust, selection }), /assignment replaced/);
  cell("R08-current-assignment-replacement-refused", effects === 1);
  await assert.rejects(handle.endpointDeploymentTrust!(), /assignment replaced/);
  cell("R09-stale-root-projection-refused", true);
  }

} catch (error) {
  failure = error;
  if (!hostedCLI) console.error(error instanceof Error ? error.stack : String(error));
  else if (namedFailure) publicError(JSON.stringify({ scope: "hosted-source-cli-describe", failedCell: namedFailure, assertionFailure: error instanceof assert.AssertionError }));
  else publicError("hosted CLI entry failed outside an original named predicate; private report retained");
}
finally {
  try {
    clearTimeout(timer);
    restoreClockProbe?.();
    try { await servingHandle?.stop(); } catch (error) { cleanupErrors.push(String(error)); }
    for (const nc of connections.reverse()) try { await nc.close(); await nc.closed(); } catch (error) { cleanupErrors.push(String(error)); }
    try { await policyWriter?.close(); } catch (error) { cleanupErrors.push(String(error)); }
    try { await handle?.close(); if (handle) await handle.closed; } catch (error) { cleanupErrors.push(String(error)); }
    await new Promise<void>(resolve => { idpHttp.closeAllConnections(); idpHttp.close(() => resolve()); });
    if (broker) try { await killAndAwaitExit(broker, "SIGTERM"); } catch (error) { cleanupErrors.push(String(error)); }
    const brokerExitObserved = !broker || broker.exitCode !== null || broker.signalCode !== null;
    if (hostedCLI && !brokerExitObserved) cleanupErrors.push("owned broker exit unconfirmed");
    if (!hostedCLI || brokerExitObserved) {
      releaseBroker?.();
      rmSync(dir, { recursive: true, force: true }); releasePath();
    }
    if (hostedCLI) {
      if (previousFixtureHome === undefined) delete process.env.COTAL_HOME;
      else process.env.COTAL_HOME = previousFixtureHome;
    }
    const privateFailure = failure ? String(failure) : null;
    const boundedFailure = hostedCLI && privateFailure !== null ? Buffer.from(privateFailure).subarray(0, 8192).toString("utf8") : privateFailure;
    writeFileSync(reportPath, JSON.stringify({ scope: "public-http-native-callout-diagnostic", checks, assertions: checks.length, passed: !failure && cleanupErrors.length === 0 && (!hostedCLI || !cliCustodyOutstanding), failure: boundedFailure, cleanupErrors: hostedCLI ? cleanupErrors.map(error => Buffer.from(error).subarray(0, 8192).toString("utf8")) : cleanupErrors, ...(hostedCLI ? { hostedCLI: true, activeCLI, cliPhase, namedFailure, namedControlsAttempted, brokerExitObserved } : {}), startAuthServicePublicLifecycle: checks.includes("P02-public-startAuthService-ready"), rootProviderOrdinaryLogin: checks.includes("P03-root-provider-logged-in-bearer"), realUserCallout: checks.includes("P08-real-native-user-callout-connect"), providerEndpointSelectionAPI: checks.includes("R02-dedicated-signed-in-provider-receipt"), authenticatedDeploymentReceipt: checks.includes("R01-authenticated-host-trust-projection"), signerlessPublicServingControl: checks.includes("R03-holder-proved-public-serving-control"), effects, ...(cliMode ? { cliMode: "source-remote-describe-only", cliChecks, cliAssertions: cliChecks.length, cliOutcomes, cliCustodyOutstanding, childRetirementProved: false, installedCLIQualification: false, cliPositiveInvokeAcceptance: false, cliWriteEffectAcceptance: false } : {}), fullU1U2Acceptance: false, fixtureResidual: "Deployment signer/store/policy setup stays in trusted harness; exact policy-key writer has stream-wide leader metadata read, signerless adoption/control/serve connections in one harness process, no independent A/B worker proof." }, null, 2) + "\n", { mode: 0o600 });
    if (failure || cleanupErrors.length || cliCustodyOutstanding) process.exitCode = 1;
    if (hostedCLI) {
      const passed = checks.length + cliChecks.length;
      const failedControls = namedControlsAttempted - passed;
      const setupFailure = !!failure && failedControls === 0;
      const failed = failedControls + Number(setupFailure) + Number(cleanupErrors.length > 0) + Number(cliCustodyOutstanding);
      publicLog(JSON.stringify({ scope: "hosted-source-cli-describe", namedControlsAttempted, namedControlsPassed: passed, namedControlsFailed: failedControls, setupFailure, cliPhase, activeCLI, failedCell: namedFailure, cleanupConfirmed: cleanupErrors.length === 0 && brokerExitObserved && !cliCustodyOutstanding, cliCustodyOutstanding, knownBrokerExitObserved: brokerExitObserved, childRetirementProved: false, reportRetained: true, laterControlsUnreached: !!failure, installedCLIQualification: false, fullEndpointAcceptance: false }));
      // Emit only this entry's safe terminal protocol, while dependency logs stay suppressed.
      const log = console.log;
      console.log = publicLog;
      try { emitSentinel({ passed, failed }); } finally { console.log = log; }
    }
  } catch (error) {
    if (!hostedCLI) throw error;
    process.exitCode = 1;
    publicError("hosted CLI cleanup or report did not complete; custody and report remain unconfirmed");
    publicLog(JSON.stringify({ scope: "hosted-source-cli-describe", cleanupConfirmed: false, reportRetained: false, cliCustodyOutstanding, childRetirementProved: false, fullEndpointAcceptance: false }));
    const passed = checks.length + cliChecks.length;
    const failed = namedControlsAttempted - passed + Number(!!failure && namedControlsAttempted === passed) + 1;
    publicLog(`COTAL_SMOKE_SENTINEL cells=${passed + failed} passed=${passed} failed=${failed}`);
  }
}

}

/** This entry composes existing public authority and native workers. It grants no new product surface. */
async function runTwoUserPublicAcceptance(): Promise<void> {
  const { fmtCreds } = await import("@nats-io/jwt");
  const log = console.log.bind(console);
  const savedLogs = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  console.log = console.error = console.warn = console.info = console.debug = () => {};
  const ids = [
    "TUP01-two-real-device-login-subjects-distinct", "TUP02-two-derived-primary-owners-and-current-uids-distinct",
    "TUP03-primary-aux-native-data-accounts-distinct", "TUP04-both-public-auth-services-ready",
    "TUP05-primary-governed-policy-full-contract-pinned", "TUP06-A-public-prepare-challenge-activate-current",
    "TUP07-B-public-prepare-challenge-activate-current", "TUP08-two-public-holder-control-issued-connections",
    "TUP09-two-independent-ready-same-name-owned-workers", "TUP10-participant-material-no-issuer-or-executor",
    "TUP11-A-public-caller-native-own-invoke-one-effect", "TUP12-B-public-caller-native-own-invoke-one-effect",
    "TUP13-original-owned-effects-one-each", "TUP14-B-to-A-without-sharing-refused-zero-effects",
    "TUP15-exact-one-way-trusted-sharing-decision", "TUP16-B-own-issued-principal-invokes-A-only-one-effect",
    "TUP17-A-to-B-not-shared-refused-zero-effects", "TUP18-wrong-instance-public-selection-refused-zero-effects",
    "TUP19-ungranted-command-public-selection-refused-zero-effects", "TUP20-own-issued-caller-foreign-instance-broker-denied-zero-effects",
    "TUP21-own-issued-caller-other-command-broker-denied-zero-effects", "TUP22-own-issued-caller-legacy-rail-broker-denied-zero-effects",
    "TUP23-own-issued-caller-class-rail-broker-denied-zero-effects", "TUP24-own-issued-caller-scatter-rail-broker-denied-zero-effects",
    "TUP25-foreign-account-public-pins-refused-zero-effects", "TUP25b-aux-ordinary-own-channel-positive",
    "TUP25c-primary-exact-wire-observer-positive", "TUP25d-same-wire-native-account-partition-bounded",
    "TUP26-aux-actual-caller-primary-space-subject-broker-denied-zero-effects",
    "TUP27-A-allowed-source-CLI-invoke-owner-and-effect", "TUP28-B-allowed-source-CLI-invoke-owner-and-effect",
    "TUP29-all-known-source-CLI-children-close-observed", "TUP30-final-effects-A3-B2-no-negative-effects",
    "TUP31-A-serving-worker-stopped-ack-and-exit-zero", "TUP32-B-serving-worker-stopped-ack-and-exit-zero",
    "TUP33-two-auth-handles-and-idp-listener-closed", "TUP34-parent-owned-connections-and-broker-closed",
    ...(issuedPublicAcceptance ? ["P3A01-genuine-issued-receipt-and-low-level-descriptor",
      "P3A02-low-level-write-before", "P3A03-low-level-read-before-no-effect",
      "P3A04-public-write-success-exactly-one-effect", "P3A05-public-read-success-no-write-effect",
      "P3A06-own-connection-generation-not-copied", "P3A07-public-other-command-refused-zero-effects",
      "P3A08-cross-owner-acquisition-refused-zero-effects", "P3A09-public-reconnect-own-discovery-and-read",
      "P3A10-issued-option-requires-user-bearer", "P3A11-issued-option-requires-lifecycle",
      "P3A12-low-level-write-after", "P3A13-low-level-read-after-no-effect",
      "P3A14-public-effects-and-no-async-errors-reconciled", "P3A15-legacy-view-issued-discovery-refused-no-fallback",
      "P3A16-public-client-and-known-acquisitions-settled"] as const : []),
    ...(protocol3Diagnostic ? ["P3D01-genuine-receipt-bound-write-read-descriptor", "P3D02-low-level-write-before",
      "P3D03-declared-read-before-no-state-change", "P3D04-public-constructor-stage-observed",
      "P3D05-public-start-stage-observed", "P3D06-public-write-entry-stage-observed",
      "P3D07-public-read-entry-stage-observed", "P3D08-low-level-write-after",
      "P3D09-declared-read-after-no-state-change", "P3D10-observed-entry-effects-reconciled",
      "P3D11-public-client-and-known-acquisitions-settled"] as const : []),
  ] as const;
  type Cell = typeof ids[number];
  const reportDir = mkdtempSync(join(tmpdir(), "endpoint-two-user-report-"));
  const report = join(reportDir, "result.json");
  const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + "-endpoint-two-user-"));
  const releasePath = teardownPathOnSignal(dir);
  const previousHome = process.env.COTAL_HOME;
  const started = Date.now(), deadline = started + 150000;
  const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), 150000);
  const passed = new Set<Cell>(), attempted = new Set<Cell>();
  const cleanupErrors: string[] = [], phaseEvidence: Record<string, unknown>[] = [];
  const witnessErrors: string[] = [];
  const expectedPermissionSubjects = new WeakMap<NatsConnection, string>();
  const witnessDebt = (message: string) => { witnessErrors.push(message); cleanupErrors.push(message); };
  const cliResults: EndpointCallerCLIResult[] = [];
  const connections: { nc: NatsConnection; closed: boolean }[] = [];
  const statusWatches: Promise<void>[] = [];
  const workers: { child: ChildProcess; messages: Record<string, unknown>[]; exit: Promise<number | null>; error?: string; stopped: boolean }[] = [];
  const authHandles: authApi.AuthServiceHandle[] = [], hostClients: AuthorityClient[] = [];
  const diagnosticClients: core.CotalEndpoint[] = [];
  const diagnosticConnections: NatsConnection[] = [];
  const diagnosticAcquisitions = new Set<Promise<unknown>>();
  const diagnosticCounters: { applicationRequests: number; readVisits: number }[] = [];
  let diagnosticWriteEffects = 0;
  let diagnosticStagesObserved = 0;
  type DiagnosticErrorBoundary = "none" | "not-reached" | "other" | "attributed-reply-refusal"
    | "broker-permission-violation" | "describe-reply-subscription" | "describe-permission-watch-unreleasable"
    | "describe-retry-publish" | "contract-store-read" | "describe-publish-denied" | "describe-answered-refusal";
  // Acceptance observations are closed labels. Never serialize caught errors or cleanup text.
  type PublicReconnectStage = "not-reached" | "snapshot-before" | "reconnect" | "connection-count"
    | "old-connection-closed" | "describe" | "receipt-binding" | "read" | "snapshot-after" | "completed";
  type PublicReconnectBoundary = "none" | "other" | "assertion" | "phase-deadline" | "phase-budget"
    | "event-deadline" | "endpoint-stopped" | "connection-closure-unproved" | "broker-permission-violation"
    | "envelope-permission-denied" | "envelope-unavailable" | "envelope-deadline-exceeded"
    | "envelope-failed-precondition" | "envelope-expired" | "envelope-not-found";
  let publicReconnectStage: PublicReconnectStage = "not-reached";
  let publicReconnectBoundary: PublicReconnectBoundary = "none";
  const reconnectBoundary = (error: unknown): PublicReconnectBoundary => {
    if (error instanceof PermissionViolationError || (error instanceof Error && error.cause instanceof PermissionViolationError))
      return "broker-permission-violation";
    if (error instanceof core.EpEnvelopeError) {
      switch (error.code) {
        case "permission-denied": return "envelope-permission-denied";
        case "unavailable": return "envelope-unavailable";
        case "deadline-exceeded": return "envelope-deadline-exceeded";
        case "failed-precondition": return "envelope-failed-precondition";
        case "expired": return "envelope-expired";
        case "not-found": return "envelope-not-found";
        default: return "other";
      }
    }
    if (error instanceof Error) {
      switch (error.message) {
        case "two-user phase deadline": return "phase-deadline";
        case "two-user entry budget exhausted": return "phase-budget";
        case "two-user event deadline": return "event-deadline";
        case "endpoint stopped - cannot reconnect": return "endpoint-stopped";
        case "endpoint connection closure is unproved; consumer custody must be retained": return "connection-closure-unproved";
      }
    }
    if (error instanceof AssertionError) return "assertion";
    return "other";
  };
  type PublicErrorClass = "none" | "type-error" | "range-error" | "assertion-error"
    | "abort-error" | "timeout-error" | "broker-permission-error" | "envelope-error" | "error" | "other";
  type PublicShippedFrame = "none" | "disable-library-reconnect" | "clear-connection-scoped"
    | "close-without-library-reconnect" | "connect-and-bind" | "bind-connection" | "do-rebuild"
    | "rebuild" | "reconnect" | "stop-once" | "stop" | "other";
  type PublicSettlement = "not-reached" | "pending" | "fulfilled" | "rejected";
  type PublicCallObservation = {
    api: PublicSettlement; wrapper: PublicSettlement; apiAtWrapper: PublicSettlement;
    apiErrorClass: PublicErrorClass; wrapperErrorClass: PublicErrorClass; apiShippedFrame: PublicShippedFrame;
    apiOrigin?: PublicErrorOrigin; immediateCause?: { state: "absent" | "present" | "unreadable"; origin?: PublicErrorOrigin };
    sameAsReconnectError?: boolean | null;
  };
  const publicCallSettlements: Record<"reconnect" | "stop", PublicCallObservation[]> = { reconnect: [], stop: [] };
  const newPublicObservation = (kind: "reconnect" | "stop"): PublicCallObservation => {
    const observation: PublicCallObservation = { api: "not-reached", wrapper: "pending", apiAtWrapper: "not-reached",
      apiErrorClass: "none", wrapperErrorClass: "none", apiShippedFrame: "none" };
    if (kind === "stop") observation.sameAsReconnectError = null;
    if (issuedPublicAcceptance) publicCallSettlements[kind].push(observation);
    return observation;
  };
  const publicErrorClass = (error: unknown): PublicErrorClass => {
    try {
      if (error instanceof TypeError) return "type-error";
      if (error instanceof RangeError) return "range-error";
      if (error instanceof AssertionError) return "assertion-error";
      if (error instanceof PermissionViolationError) return "broker-permission-error";
      if (error instanceof core.EpEnvelopeError) return "envelope-error";
      if (error instanceof Error) {
        if (error.name === "AbortError") return "abort-error";
        if (error.name === "TimeoutError") return "timeout-error";
        return "error";
      }
    } catch { /* Observation must not replace the original failure. */ }
    return "other";
  };
  type PublicOriginCode = "other" | "bad-request" | "unsupported-version" | "op-mismatch" | "class-mismatch"
    | "target-mismatch" | "sender-mismatch" | "unauthenticated" | "permission-denied" | "not-found"
    | "already-exists" | "conflict" | "contract-mismatch" | "contract-invalid" | "failed-precondition"
    | "deadline-exceeded" | "cancelled" | "expired" | "unavailable" | "unimplemented" | "resource-exhausted" | "internal";
  type PublicOriginMessage = "other" | "phase-deadline" | "phase-budget" | "event-deadline"
    | "endpoint-stopped" | "connection-closure-unproved" | "stop-closure-unproved"
    | "closed-connection" | "connection-draining" | "nats-timeout";
  type PublicFrameObservation = {
    availability: "unavailable" | "available" | "unreadable";
    format: "unmatched" | "plain" | "async"; frame: PublicShippedFrame;
  };
  // Only fixed public module assets are read. Stack paths never authorize a file read.
  // Synchronous resolution, hashing and reads can perturb scheduling, not cancel the API.
  type PublicLocationModule = "fixture" | "core-index-js" | "core-endpoint-js" | "core-endpoint-ts"
    | "core-issued-authority-js" | "core-envelope-js" | "nats-errors-js" | "nats-nats-js" | "nats-protocol-js"
    | "transport-connect-js" | "transport-node-js" | "jetstream-errors-js" | "jetstream-base-js" | "jetstream-client-js" | "kv-js";
  type PublicModulePin = { module: PublicLocationModule; state: "known" | "unsupported";
    sha256?: string; bytes?: number; lines?: number;
    map?: { state: "bound" | "unsupported"; sha256?: string; bytes?: number } };
  type PublicLocationFrame = { module: PublicLocationModule | "other"; format: "plain" | "async" | "anonymous" | "other";
    line?: number; column?: number };
  type PublicLocationObservation = { state: "available" | "unavailable" | "unreadable" | "oversize"; frames: PublicLocationFrame[] };
  const publicModulePins: PublicModulePin[] = [];
  const publicKnownLocations = new Map<string, { module: PublicLocationModule; widths: number[] }>();
  let publicLocationCatalogueReady = false;
  const preparePublicLocationCatalogue = () => {
    if (publicLocationCatalogueReady) return;
    publicLocationCatalogueReady = true;
    // At most 16 explicit assets, 1 MiB per asset and 8 MiB total, including maps and sources.
    // Node's supported public resolver performs its own filesystem work outside these read counts.
    let files = 0, total = 0;
    const readKnownAsset = (url: URL): Buffer | undefined => {
      let fd: number | undefined;
      try {
        if (url.protocol !== "file:" || url.search || url.hash || ++files > 16) return undefined;
        fd = openSync(url, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
        const before = fstatSync(fd);
        if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > 1048576
          || total + before.size + 1 > 8388608) return undefined;
        total += before.size + 1;
        const bytes = Buffer.alloc(before.size + 1);
        let length = 0;
        for (let read = 0; read < 32 && length < bytes.length; read++) {
          const count = readSync(fd, bytes, length, bytes.length - length, length);
          if (count === 0) break;
          length += count;
        }
        const after = fstatSync(fd);
        if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
          || after.ctimeMs !== before.ctimeMs) return undefined;
        return bytes.subarray(0, length);
      } catch { return undefined; }
      finally { if (fd !== undefined) try { closeSync(fd); } catch { /* No diagnostic exception replaces the API error. */ } }
    };
    const register = (module: PublicLocationModule, url: URL, bytes: Buffer | undefined, admit = true): PublicModulePin => {
      const pin: PublicModulePin = { module, state: "unsupported" };
      publicModulePins.push(pin);
      if (!bytes) return pin;
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) return pin;
      const widths = text.split(/\r?\n/).map(line => line.length);
      if (widths.length > 30000 || widths.some(width => width > 1048576)) return pin;
      Object.assign(pin, { state: "known", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, lines: widths.length });
      const location = { module, widths };
      // Only two representations of the same approved identity. No realpath of an error frame.
      if (admit) {
        publicKnownLocations.set(url.href, location);
        publicKnownLocations.set(fileURLToPath(url), location);
      }
      return pin;
    };
    const unsupported = (module: PublicLocationModule) => { publicModulePins.push({ module, state: "unsupported" }); };
    const mappedModule = (module: PublicLocationModule, sourceModule: PublicLocationModule, url: URL,
      basename: string, source: string) => {
      const bytes = readKnownAsset(url), pin = register(module, url, bytes);
      pin.map = { state: "unsupported" };
      const suffix = `//# sourceMappingURL=${basename}.map`;
      const text = bytes?.toString("utf8");
      if (pin.state !== "known" || !text || !(text.endsWith(suffix) || text.endsWith(`${suffix}\n`))) { unsupported(sourceModule); return; }
      // The map filename and source filename are constants, never taken from arbitrary map fields.
      const map = readKnownAsset(new URL(`${basename}.map`, url));
      if (!map) { unsupported(sourceModule); return; }
      pin.map.sha256 = createHash("sha256").update(map).digest("hex");
      pin.map.bytes = map.length;
      try {
        const header: unknown = JSON.parse(map.toString("utf8"));
        if (typeof header !== "object" || header === null) { unsupported(sourceModule); return; }
        const fields = header as Record<string, unknown>;
        if (fields.version !== 3 || fields.file !== basename || fields.sourceRoot !== ""
          || !Array.isArray(fields.sources) || fields.sources.length !== 1 || fields.sources[0] !== source
          || fields.sourcesContent !== undefined || typeof fields.mappings !== "string") { unsupported(sourceModule); return; }
        const sourceURL = new URL(source, url);
        const sourceBytes = readKnownAsset(sourceURL);
        const sourcePin = register(sourceModule, sourceURL, sourceBytes, false);
        if (sourcePin.state === "known" && sourceBytes) {
          pin.map.state = "bound";
          // Source lookup is admitted only after emitted/map/source all qualify.
          const location = { module: sourceModule, widths: sourceBytes.toString("utf8").split(/\r?\n/).map(line => line.length) };
          publicKnownLocations.set(sourceURL.href, location);
          publicKnownLocations.set(fileURLToPath(sourceURL), location);
        }
        // This binds file identities only. It never decodes mappings or translates a coordinate.
      } catch { unsupported(sourceModule); }
    };
    try { const url = new URL(import.meta.url); register("fixture", url, readKnownAsset(url)); }
    catch { unsupported("fixture"); }
    let coreEntry: URL | undefined, transportEntry: URL | undefined;
    try {
      const entry = new URL(import.meta.resolve("@cotal-ai/core"));
      if (entry.protocol === "file:" && !entry.search && !entry.hash && entry.pathname.endsWith("/dist/index.js")) coreEntry = entry;
    } catch { /* Unsupported public layout stays unknown. */ }
    if (coreEntry) {
      register("core-index-js", coreEntry, readKnownAsset(coreEntry));
      mappedModule("core-endpoint-js", "core-endpoint-ts", new URL("endpoint.js", coreEntry), "endpoint.js", "../src/endpoint.ts");
      for (const [module, file] of [["core-issued-authority-js", "issued-authority.js"], ["core-envelope-js", "endpoint-envelope.js"]] as const) {
        const url = new URL(file, coreEntry);
        register(module, url, readKnownAsset(url));
      }
    } else for (const module of ["core-index-js", "core-endpoint-js", "core-endpoint-ts", "core-issued-authority-js", "core-envelope-js"] as const) unsupported(module);
    try {
      const entry = new URL(import.meta.resolve("@nats-io/transport-node"));
      if (entry.protocol === "file:" && !entry.search && !entry.hash && entry.pathname.endsWith("/transport-node/index.js")) transportEntry = entry;
    } catch { /* Resolution does not execute the package. */ }
    let natsEntry: URL | undefined, jetstreamEntry: URL | undefined, kvEntry: URL | undefined;
    try {
      if (coreEntry && transportEntry) {
        // The public core and transport must resolve the same declared NATS core, not a guessed copy.
        const fromCore = createRequire(coreEntry).resolve("@nats-io/nats-core");
        const fromTransport = createRequire(transportEntry).resolve("@nats-io/nats-core");
        const entry = pathToFileURL(fromCore);
        if (fromCore === fromTransport && entry.pathname.endsWith("/nats-core/lib/mod.js")) natsEntry = entry;
      }
    } catch { /* Unsupported or skewed closure emits no paths. */ }
    if (coreEntry) {
      try {
        const entry = pathToFileURL(createRequire(coreEntry).resolve("@nats-io/jetstream"));
        if (entry.pathname.endsWith("/jetstream/lib/mod.js")) jetstreamEntry = entry;
      } catch { /* Only the declared public entry may seed this fixed catalogue. */ }
      try {
        const entry = pathToFileURL(createRequire(coreEntry).resolve("@nats-io/kv"));
        if (entry.pathname.endsWith("/kv/lib/mod.js")) kvEntry = entry;
      } catch { /* Unsupported declared dependency remains unknown. */ }
    }
    // Vendor entries are compiled-JS-only. A source-mapped vendor frame stays other.
    // Allocation: fixture1 + core6 + vendor9. Endpoint uses JS/map/source, the other core entries only JS.
    // Together with vendor9 these use exactly 16 fixed asset attempts at most.
    for (const [module, entry, file] of [
      ["nats-errors-js", natsEntry, "errors.js"], ["nats-nats-js", natsEntry, "nats.js"],
      ["nats-protocol-js", natsEntry, "protocol.js"],
      ["transport-connect-js", transportEntry, "lib/connect.js"], ["transport-node-js", transportEntry, "lib/node_transport.js"],
      ["jetstream-errors-js", jetstreamEntry, "jserrors.js"], ["jetstream-base-js", jetstreamEntry, "jsbaseclient_api.js"],
      ["jetstream-client-js", jetstreamEntry, "jsclient.js"], ["kv-js", kvEntry, "kv.js"],
    ] as const) {
      if (entry) { const url = new URL(file, entry); register(module, url, readKnownAsset(url)); }
      else unsupported(module);
    }
  };
  const publicLocationObservation = (error: unknown): PublicLocationObservation => {
    try {
      if (!(error instanceof Error)) return { state: "unavailable", frames: [] };
      const stack = error.stack;
      if (typeof stack !== "string") return { state: "unavailable", frames: [] };
      if (stack.length > 65536) return { state: "oversize", frames: [] };
      preparePublicLocationCatalogue();
      const frames: PublicLocationFrame[] = [];
      // Parse only eight slots of the bounded string, including unknown or unsupported frames.
      for (const text of stack.split("\n").slice(1, 9)) {
        const frame: PublicLocationFrame = { module: "other", format: "other" };
        frames.push(frame);
        if (text.length > 4096) continue;
        const match = /^\s*at (async )?(?:(?:[^\r\n]+) \(([^\r\n]+):(\d{1,6}):(\d{1,7})\)|([^\r\n]+):(\d{1,6}):(\d{1,7}))$/.exec(text);
        if (!match) continue;
        const known = publicKnownLocations.get(match[2] ?? match[5]!);
        if (!known) continue;
        const line = Number(match[3] ?? match[6]), column = Number(match[4] ?? match[7]);
        if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || line > known.widths.length
          || column < 1 || column > known.widths[line - 1]! + 1) continue;
        Object.assign(frame, { module: known.module, format: match[1] ? "async" : match[2] ? "plain" : "anonymous", line, column });
      }
      return { state: "available", frames };
    } catch { return { state: "unreadable", frames: [] }; }
  };
  type PublicErrorOrigin = {
    errorClass: PublicErrorClass; code: PublicOriginCode; message: PublicOriginMessage; stack: PublicFrameObservation;
    locations?: PublicLocationObservation;
  };
  let reconnectRejectedObject: unknown;
  let reconnectRejectedObjectKnown = false;
  const publicFrameObservation = (error: unknown): PublicFrameObservation => {
    try {
      if (!(error instanceof Error)) return { availability: "unavailable", format: "unmatched", frame: "other" };
      const stack = error.stack;
      if (typeof stack !== "string") return { availability: "unavailable", format: "unmatched", frame: "other" };
      for (const line of stack.split("\n").slice(1)) {
        // Only this optional async token extends the frozen core method/path allowlist.
        const match = /^\s*at (async )?CotalEndpoint\.(disableLibraryReconnect|clearConnectionScoped|closeWithoutLibraryReconnect|connectAndBind|bindConnection|doRebuild|rebuild|reconnect|stopOnce|stop) \(.*\/packages\/core\/(?:src|dist)\/endpoint\.(?:ts|js):\d+:\d+\)$/.exec(line);
        let frame: PublicShippedFrame;
        switch (match?.[2]) {
          case "disableLibraryReconnect": frame = "disable-library-reconnect"; break;
          case "clearConnectionScoped": frame = "clear-connection-scoped"; break;
          case "closeWithoutLibraryReconnect": frame = "close-without-library-reconnect"; break;
          case "connectAndBind": frame = "connect-and-bind"; break;
          case "bindConnection": frame = "bind-connection"; break;
          case "doRebuild": frame = "do-rebuild"; break;
          case "rebuild": frame = "rebuild"; break;
          case "reconnect": frame = "reconnect"; break;
          case "stopOnce": frame = "stop-once"; break;
          case "stop": frame = "stop"; break;
          default: continue;
        }
        return { availability: "available", format: match?.[1] ? "async" : "plain", frame };
      }
      return { availability: "available", format: "unmatched", frame: "other" };
    } catch { return { availability: "unreadable", format: "unmatched", frame: "other" }; }
  };
  const publicOriginCode = (error: unknown): PublicOriginCode => {
    try {
      if (!(error instanceof core.EpEnvelopeError)) return "other";
      // The shipped core catalog only. Extension codes and arbitrary error.code values stay private.
      switch (error.code) {
        case "bad-request": return "bad-request";
        case "unsupported-version": return "unsupported-version";
        case "op-mismatch": return "op-mismatch";
        case "class-mismatch": return "class-mismatch";
        case "target-mismatch": return "target-mismatch";
        case "sender-mismatch": return "sender-mismatch";
        case "unauthenticated": return "unauthenticated";
        case "permission-denied": return "permission-denied";
        case "not-found": return "not-found";
        case "already-exists": return "already-exists";
        case "conflict": return "conflict";
        case "contract-mismatch": return "contract-mismatch";
        case "contract-invalid": return "contract-invalid";
        case "failed-precondition": return "failed-precondition";
        case "deadline-exceeded": return "deadline-exceeded";
        case "cancelled": return "cancelled";
        case "expired": return "expired";
        case "unavailable": return "unavailable";
        case "unimplemented": return "unimplemented";
        case "resource-exhausted": return "resource-exhausted";
        case "internal": return "internal";
        default: return "other";
      }
    } catch { return "other"; }
  };
  const publicOriginMessage = (error: unknown): PublicOriginMessage => {
    try {
      if (!(error instanceof Error)) return "other";
      switch (error.message) {
        case "two-user phase deadline": return "phase-deadline";
        case "two-user entry budget exhausted": return "phase-budget";
        case "two-user event deadline": return "event-deadline";
        case "endpoint stopped - cannot reconnect": return "endpoint-stopped";
        case "endpoint connection closure is unproved; consumer custody must be retained": return "connection-closure-unproved";
        case "endpoint stop could not prove its connection closed; local consumer custody must be retained": return "stop-closure-unproved";
        case "closed connection": return "closed-connection";
        case "connection draining": return "connection-draining";
        case "timeout": return "nats-timeout";
        default: return "other";
      }
    } catch { return "other"; }
  };
  const publicErrorOrigin = (error: unknown): PublicErrorOrigin => ({ errorClass: publicErrorClass(error),
    code: publicOriginCode(error), message: publicOriginMessage(error), stack: publicFrameObservation(error),
    ...(issuedPublicAcceptance ? { locations: publicLocationObservation(error) } : {}) });
  const publicImmediateCause = (error: unknown): NonNullable<PublicCallObservation["immediateCause"]> => {
    try {
      if (!(error instanceof Error)) return { state: "absent" };
      const cause: unknown = error.cause;
      return cause === undefined ? { state: "absent" } : { state: "present", origin: publicErrorOrigin(cause) };
    } catch { return { state: "unreadable" }; }
  };
  const observedPublicCall = (kind: "reconnect" | "stop", observation: PublicCallObservation, operation: () => Promise<void>): Promise<void> => {
    if (!issuedPublicAcceptance) return operation();
    observation.api = "pending";
    const rejected = (error: unknown) => {
      observation.api = "rejected";
      observation.apiErrorClass = publicErrorClass(error);
      const origin = publicErrorOrigin(error);
      observation.apiOrigin = origin;
      observation.apiShippedFrame = origin.stack.frame;
      observation.immediateCause = publicImmediateCause(error);
      const objectKnown = error !== null && (typeof error === "object" || typeof error === "function");
      if (kind === "reconnect") {
        reconnectRejectedObject = error;
        reconnectRejectedObjectKnown = objectKnown;
      } else {
        observation.sameAsReconnectError = reconnectRejectedObjectKnown && objectKnown ? error === reconnectRejectedObject : null;
      }
    };
    try {
      const flight = operation();
      void flight.then(() => { observation.api = "fulfilled"; }, rejected);
      return flight;
    } catch (error) { rejected(error); throw error; }
  };
  const cleanupDebt = (message: string) => {
    switch (message) {
      case "AUX witness status failure": return "aux-witness-status";
      case "AUX witness subscription failed": return "aux-witness-subscription";
      case "AUX received PRIMARY witness traffic": return "aux-received-primary";
      case "PRIMARY observer status failure": return "primary-observer-status";
      case "PRIMARY witness subscription failed": return "primary-witness-subscription";
      case "PRIMARY received AUX witness traffic": return "primary-received-aux";
      case "witness subscription removal unconfirmed": return "witness-subscription-removal";
      case "PRIMARY observer close failed": return "primary-observer-close";
      case "witness lifetime validation failed": return "witness-lifetime-validation";
      case "unexpected public diagnostic error outside an observed stage": return "diagnostic-error-outside-stage";
      case "issued public acceptance asynchronous error": return "issued-public-asynchronous-error";
      case "unexpected legacy issued-discovery error": return "legacy-issued-discovery-error";
      case "public diagnostic client stop or late start unconfirmed": return "public-client-stop-or-late-start";
      case "public diagnostic acquisition remains outstanding": return "public-acquisition-outstanding";
      case "owned worker stop or exit unconfirmed": return "worker-stop-or-exit";
      case "trusted fixture host connection close failed": return "host-connection-close";
      case "participant connection close failed": return "participant-connection-close";
      case "owned status observer retirement unconfirmed": return "status-observer-retirement";
      case "retained witness lifetime debt at final cleanup": return "retained-witness-lifetime";
      case "public auth service close failed": return "auth-service-close";
      case "IdP listener close failed": return "idp-listener-close";
      case "known broker exit unconfirmed": return "broker-exit";
      default: return "other";
    }
  };
  const diagnosticStageErrors: { stage: string; code: string; eventBoundary: DiagnosticErrorBoundary }[] = [];
  let diagnosticStageInFlight: string | null = null;
  let broker: ReturnType<typeof spawn> | undefined, releaseBroker: (() => void) | undefined;
  let observer: AuthorityClient | undefined, observerCreated = 0, observerClosed = 0;
  let failure: unknown, failedCell: Cell | null = null, phase = "setup", custodyOutstanding = false;
  let idpClosed = false, authClosed = 0, hostClosed = 0;
  let failurePhase: string | null = null;
  let handler: ReturnType<typeof toNodeHandler> | undefined;
  const idpHttp = createServer((req, res) => handler!(req, res));
  const enc = new TextEncoder();
  const track = (nc: NatsConnection) => { connections.push({ nc, closed: false }); return nc; };
  const budget = () => { const ms = Math.min(8000, deadline - Date.now()); assert.ok(ms > 0, "two-user entry budget exhausted"); return ms; };
  async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("two-user phase deadline")), budget()); })]); }
    finally { clearTimeout(timeout); }
  }
  async function waitFor(test: () => boolean): Promise<void> {
    const until = Date.now() + budget();
    while (!test()) { assert.ok(Date.now() < until, "two-user event deadline"); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  async function withHome<T>(home: string, action: () => Promise<T>): Promise<T> {
    const prior = process.env.COTAL_HOME;
    process.env.COTAL_HOME = home;
    try { return await action(); }
    finally { if (prior === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = prior; }
  }
  async function check(name: Cell, action: () => Promise<unknown>): Promise<void> {
    if (phase !== "cleanup") phase = name;
    assert.ok(!attempted.has(name), "duplicate two-user cell"); attempted.add(name); failedCell = name;
    await action(); passed.add(name); failedCell = null;
    log(JSON.stringify({ cell: name, passed: true, scope: publicEntryScope }));
  }
  async function snapshot(): Promise<number[]> {
    assert.equal(workers.length, 2, "two actual workers required for effect fencing");
    return await Promise.all(workers.map(async (worker, workerIndex) => {
      assert.ok(worker.child.connected && !worker.error, "worker snapshot custody unavailable");
      const id = core.mintLifecycleUid(); worker.child.send({ kind: "effects-snapshot", id });
      await waitFor(() => !!worker.error || worker.messages.some(m => m.kind === "effects-snapshot" && m.id === id));
      assert.ok(!worker.error, "worker snapshot failed");
      const response = worker.messages.find(m => m.kind === "effects-snapshot" && m.id === id)!;
      assert.ok(typeof response.effects === "number" && Number.isSafeInteger(response.effects) && response.effects >= 0, "invalid worker effect snapshot");
      const effects = worker.messages.filter(m => m.kind === "effect");
      assert.equal(response.effects, effects.length, "snapshot differs from actual effect IPC sequence");
      assert.ok(effects.every((m, index) => m.command === "increment" && m.effects === index + 1), "unexpected worker command or effect sequence");
      if (publicReadControls) {
        assert.ok(typeof response.applicationRequests === "number" && Number.isSafeInteger(response.applicationRequests) && response.applicationRequests >= 0);
        assert.ok(typeof response.readVisits === "number" && Number.isSafeInteger(response.readVisits) && response.readVisits >= 0);
        assert.equal(response.applicationRequests, response.effects + response.readVisits);
        assert.equal(response.readVisits, worker.messages.filter(message => message.kind === "read-visit").length);
        diagnosticCounters[workerIndex] = { applicationRequests: response.applicationRequests, readVisits: response.readVisits };
      }
      return response.effects;
    }));
  }
  async function negative(name: Cell, action: () => Promise<void>): Promise<void> {
    await check(name, async () => {
      const before = await snapshot(); await action(); const after = await snapshot();
      assert.deepEqual(after, before, "negative request produced an application effect");
      phaseEvidence.push({ cell: name, before, after, zeroEffect: true });
    });
  }
  async function expectPublicDenial(action: () => Promise<unknown>, reason: RegExp): Promise<void> {
    let observed: unknown;
    try { await action(); } catch (error) { observed = error; }
    assert.ok(observed instanceof Error && /endpoint authority refused (?:400|401|403|409):/.test(observed.message) && reason.test(observed.message), "expected explicit public authority denial");
    phaseEvidence.push({ cell: failedCell, kind: "actual-public-authority-denial", status: Number(/endpoint authority refused (\d+):/.exec(observed.message)![1]), expectedReasonMatched: true });
  }
  try {
    await new Promise<void>(resolve => idpHttp.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(idpHttp.address() as { port: number }).port}`, idpUrl = `${origin}/api/auth`;
    const idp = betterAuth({ baseURL: origin, secret: "endpoint-two-user-idp-test-secret-0123456789", database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }), emailAndPassword: { enabled: true }, plugins: [jwt({ jwt: { issuer: origin, audience: origin } }), deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: id => id === "cotal-cli" }), bearer()] });
    handler = toNodeHandler(idp);
    const logins: Awaited<ReturnType<typeof authApi.establishIdpSession>>[] = [], homes: string[] = [];
    await check(ids[0], async () => {
      for (const label of ["a", "b"]) {
        const home = join(dir, "home-" + label); core.mkSecretDir(home); homes.push(home);
        const signup = await idp.api.signUpEmail({ body: { email: `${label}@endpoint-two-user.test`, password: `fixture-only-two-user-password-${label}`, name: `Endpoint ${label}` }, returnHeaders: true });
        const cookie = signup.headers.get("set-cookie")!.split(";")[0];
        const login = await bounded(authApi.establishIdpSession({ dir: home, idpUrl, clientId: "cotal-cli", onPrompt: async prompt => {
          const claim = await fetch(`${idpUrl}/device?user_code=${encodeURIComponent(prompt.userCode)}`, { headers: { cookie, origin }, signal: AbortSignal.timeout(budget()) }); assert.ok(claim.ok, "device claim refused");
          const approved = await fetch(`${idpUrl}/device/approve`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify({ userCode: prompt.userCode }), signal: AbortSignal.timeout(budget()) }); assert.ok(approved.ok, "device approval refused");
        } }));
        logins.push(login);
      }
      assert.ok(logins[0].sub && logins[1].sub && logins[0].sub !== logins[1].sub);
    });
    const root = await core.createBrokerAuth("endpoint-two-user"), port = await pickFreePort(), servers = `nats://127.0.0.1:${port}`;
    const stamp = Date.now(), spaces = ["tup" + stamp, "taux" + stamp];
    const accounts = await Promise.all(spaces.map(async (space, index) => {
      const auth = core.composeSpaceAuth(root, await core.createSpaceAccountAuth(root, space));
      const state = join(dir, "host-" + index); core.mkSecretDir(state);
      const store = new MemoryStore({ kind: "injected", coordinate: "two-user:" + space });
      const prepared = await authApi.cotalAuthProvider.prepareServer({ store, dir: state, space, idpUrl, operatorSeed: root.operator.seed!, account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed! } });
      return { space, auth, state, store, prepared };
    }));
    const primary = accounts[0], aux = accounts[1], endpoint = "test.example.two-user", channel = "witness" + core.mintLifecycleUid();
    const secret = await authApi.loadOwnerSecret(primary.store, primary.space); assert.ok(secret);
    const principals = logins.map(login => ({ owner: authApi.deriveOwnerForIdpSubject(secret, origin, login.sub!), actor: "cli", uid: core.mintLifecycleUid() }));
    await check(ids[1], async () => {
      for (const p of principals) authApi.grantActor(primary.state, { owner: p.owner, actor: p.actor, lifecycleUid: p.uid, scope: [], allowSubscribe: [], allowPublish: [] });
      assert.notEqual(principals[0].owner, principals[1].owner); assert.notEqual(principals[0].uid, principals[1].uid);
    });
    const auxSecret = await authApi.loadOwnerSecret(aux.store, aux.space); assert.ok(auxSecret);
    const auxPrincipal = { owner: authApi.deriveOwnerForIdpSubject(auxSecret, origin, logins[0].sub!), actor: "cli", uid: core.mintLifecycleUid() };
    authApi.grantActor(aux.state, { owner: auxPrincipal.owner, actor: auxPrincipal.actor, lifecycleUid: auxPrincipal.uid, scope: [], allowSubscribe: [channel], allowPublish: [channel] });
    const brokerConfig = core.serverConfig(root, accounts.map(a => a.auth), { host: "127.0.0.1", transport: { kind: "plaintext" }, port, storeDir: join(dir, "js"), extraAccounts: accounts.flatMap(a => a.prepared.extraAccounts) });
    const configPath = join(dir, "nats.conf"); core.writeSecretFile(configPath, brokerConfig);
    const configDigest = core.rawDigest(brokerConfig);
    const verifyAccountProvenance = () => {
      assert.equal(core.rawDigest(readFileSync(configPath, "utf8")), configDigest, "actual installed broker configuration changed");
      assert.notEqual(primary.auth.account.pub, aux.auth.account.pub);
      for (const a of accounts) {
        assert.ok(brokerConfig.includes(`${a.auth.account.pub}: ${a.auth.account.jwt}`), "configured account JWT missing");
        const claims = decodeJwt(a.auth.account.jwt) as { sub?: string; nats?: { imports?: unknown[]; exports?: unknown[] } };
        assert.equal(claims.sub, a.auth.account.pub); assert.equal(claims.nats?.imports?.length ?? 0, 0); assert.equal(claims.nats?.exports?.length ?? 0, 0);
        assert.equal(a.prepared.extraAccounts?.length, 1, "one dedicated callout account required per data account");
        const callout = a.prepared.extraAccounts![0];
        assert.ok(brokerConfig.includes(`${callout.pub}: ${callout.jwt}`), "configured callout account JWT missing");
        const calloutClaims = decodeJwt(callout.jwt) as { sub?: string; nats?: { authorization?: { allowed_accounts?: string[] }; imports?: unknown[]; exports?: unknown[] } };
        assert.equal(calloutClaims.sub, callout.pub); assert.notEqual(callout.pub, a.auth.account.pub);
        assert.deepEqual(calloutClaims.nats?.authorization?.allowed_accounts, [a.auth.account.pub]);
        assert.equal(calloutClaims.nats?.imports?.length ?? 0, 0); assert.equal(calloutClaims.nats?.exports?.length ?? 0, 0);
      }
    };
    await check(ids[2], async () => { verifyAccountProvenance(); });
    broker = spawn("nats-server", ["-c", configPath], { stdio: "ignore" }); releaseBroker = teardownOnSignal(broker, dir);
    await awaitBrokerReady(() => core.isReachable(servers), { servers, attempts: 60, delayMs: 50 });
    for (const a of accounts) await core.setupSpaceStreams({ servers, space: a.space, creds: await core.mintCreds(a.auth, core.newIdentity(), "provisioner") });
    const input = { type: "null" }, output = { type: "object", properties: { effects: { type: "integer" }, owner: { type: "string" } }, required: ["effects", "owner"], additionalProperties: false };
    const contract = { input: core.compileContract({ root: input }), output: core.compileContract({ root: output }) };
    const cluster = { urn: endpoint, revision: 1, attributes: [], events: [], commands: ["increment", "other", ...(publicReadControls ? ["read-state"] : [])].map(name => ({ name, class: "ephemeral", effect: name === "read-state" ? "read" : "write", targeted: false, capability: "testcall", inputDigest: contract.input.closureDigest, outputDigest: contract.output.closureDigest })) };
    const manifest = core.singleDocumentClosure(cluster).manifest, closures = [core.contractDigest(manifest)];
    const artifacts = [input, output, { ...core.singleDocumentClosure(input).manifest }, { ...core.singleDocumentClosure(output).manifest }, cluster, { ...manifest }].map(value => ({ digest: core.contractDigest(value), value }));
    const account = { space: primary.space, accountPublicKey: primary.auth.account.pub, assignmentRevision: 1 };
    const ceiling = { routes: { kind: "instance" as const }, resources: { kind: "ephemeral-only" as const }, expiresAt: Math.floor(Date.now() / 1000) + 120 };
    const decisions = new Map<string, core.EndpointInstanceAuthorityRequest>();
    const shares = new Set<string>(), shareDecisions: string[] = [];
    const shareKey = (p: core.EpCaller, instanceId: string) => core.canonicalJson({ principal: { owner: p.owner, actor: p.actor, uid: p.uid }, instanceId, commands: ["increment"] });
    const policy: authApi.EndpointAuthorityPolicy = {
      namespace: async name => { assert.equal(name, endpoint); return { account, endpoint, governor: principals[0].owner, namespaceRevision: 1, policyRevision: 1, clusterDigests: closures }; },
      actorIsCurrent: async p => principals.some(known => core.canonicalJson(known) === core.canonicalJson(p)),
      serving: async (p, allocated) => {
        assert.ok(principals.some(known => core.canonicalJson(known) === core.canonicalJson(p))); assert.equal(allocated.endpoint, endpoint);
        const binding = { account, holder: { owner: p.owner, actor: p.actor, lifecycleUid: p.uid, publicKey: allocated.publicKey }, authority: { namespaceRevision: 1, policyRevision: 1, delegationId: core.mintLifecycleUid(), delegationRevision: 1 }, ceiling };
        decisions.set(allocated.instanceId, { account, endpoint, instanceId: allocated.instanceId, holder: binding.holder, clusterDigests: closures, expected: binding.authority, ceiling }); return binding;
      },
      authorizeInstance: async request => core.canonicalJson(decisions.get(request.instanceId)) === core.canonicalJson(request) ? { authorized: true, governor: principals[0].owner, ref: request.expected, ceiling: request.ceiling } : { authorized: false },
      caller: async (p, request) => {
        const decision = decisions.get(request.instanceId), key = shareKey(p, request.instanceId);
        const own = decision?.holder.owner === p.owner && decision.holder.actor === p.actor && decision.holder.lifecycleUid === p.uid;
        const shared = shares.has(key);
        if (!decision || request.endpoint !== endpoint || !principals.some(known => core.canonicalJson(known) === core.canonicalJson(p)) || request.commands.some(command => command !== "increment" && !(publicReadControls && command === "read-state" && own)) || (!own && (!shared || request.commands.length !== 1))) throw new Error("caller policy denied");
        if (shared) shareDecisions.push(key);
        return { capabilities: request.commands.map(command => ({ endpoint, command })), expiresAt: ceiling.expiresAt };
      },
    };
    const assignment: core.EndpointDeploymentAssignment = { account, lifecycleUid: core.mintLifecycleUid(), state: "active", expiresAt: ceiling.expiresAt };
    const flights = new Map<string, Promise<unknown>>();
    const deployment: core.EndpointAuthorityDeployment = { assignment, withCurrentAssignment: (expected, action) => serializedFor(flights, "deployment", async () => { assert.equal(core.canonicalJson(expected), core.canonicalJson(assignment)); core.parseEndpointDeploymentAssignment(assignment); const result = await action(); core.parseEndpointDeploymentAssignment(assignment); return result; }) };
    for (const [index, a] of accounts.entries()) {
      const handle = await authApi.startAuthService({ context: { accountPublicKey: a.auth.account.pub, lifecycleUid: core.mintLifecycleUid() }, space: a.space, servers, store: a.store, storeIdentity: a.store.identity, stateDir: a.state, ...(index === 0 ? { endpointAuthority: { policy, deployment } } : {}), publicFace: { port: 0, trustedProxy: false } });
      authHandles.push(handle); authApi.saveAuthServiceInfo(a.state, { url: handle.url, pid: process.pid, cap: handle.cap });
    }
    await check(ids[3], async () => { assert.equal(authHandles.length, 2); for (const handle of authHandles) assert.equal((await handle.readiness()).state, "ready"); });
    const trust = await authHandles[0].endpointDeploymentTrust!();
    await check(ids[4], async () => { assert.equal(trust.account.accountPublicKey, account.accountPublicKey); assert.ok(trust.keys.every(key => !("d" in key))); assert.equal((await policy.namespace(endpoint)).governor, principals[0].owner); assert.deepEqual((await policy.namespace(endpoint)).clusterDigests, closures); });
    const writer = await openAuthorityClient({ server: servers, space: primary.space, dataAccount: { pub: primary.auth.account.pub, signingSeed: primary.auth.account.signingSeed! }, label: "two-user-policy-writer", noReconnect: true, grants: id => ({ publish: ["$JS.API.INFO", `$JS.API.STREAM.INFO.KV_${core.epAuthBucket(primary.space)}`, `$JS.API.STREAM.MSG.GET.KV_${core.epAuthBucket(primary.space)}`, `$KV.${core.epAuthBucket(primary.space)}.${core.endpointPolicyKey(endpoint)}`], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
    hostClients.push(writer); await core.provisionEndpointPolicyHead(await new Kvm(writer.nc).open(core.epAuthBucket(primary.space)), endpoint, 1);
    async function remoteClient(index: number, a: typeof primary) {
      const home = homes[index], clientRoot = join(dir, "client-" + a.space + "-" + index); core.mkSecretDir(clientRoot); core.mkSecretDir(join(clientRoot, ".cotal")); core.mkSecretDir(join(clientRoot, ".cotal", "auth"));
      const state = userAuthStateDir(clientRoot, a.space); core.mkSecretDir(state);
      const callout = await authApi.loadCalloutAuth(a.store, a.space); assert.ok(callout);
      const sentinelCredsPath = join(state, "sentinel.creds"); core.writeSecretFile(sentinelCredsPath, callout.sentinelCreds);
      const publicUrl = authHandles[accounts.indexOf(a)].publicUrl; assert.ok(publicUrl);
      if (a === primary) core.writeSecretFile(join(state, "endpoint-deployment-trust.json"), JSON.stringify({ v: 2, kind: "cotal.endpoint-deployment-trust", space: a.space, exchangeOrigin: new URL(publicUrl).origin, provisionedAt: Math.floor(Date.now() / 1000), trust }));
      await withHome(home, async () => { authApi.saveIdpSession(home, idpUrl, logins[index].session); recordMesh({ space: a.space, server: servers, root: clientRoot, mode: "user", origin: "manual", ts: new Date().toISOString(), userAuth: { provider: authApi.cotalAuthProvider.name, idp: { url: idpUrl, issuer: origin, audience: origin }, remote: true, endpoints: { url: publicUrl }, sentinelCredsPath } }); });
      return { home, root: clientRoot, state, space: a.space, store: new MemoryStore({ kind: "injected" as const, coordinate: "remote-empty:" + a.space + ":" + index }) };
    }
    const clients = [await remoteClient(0, primary), await remoteClient(1, primary)], auxClient = await remoteClient(0, aux);
    const ordinary: { bearer: string; sentinelCreds: string }[] = [];
    for (const client of clients) ordinary.push(await withHome(client.home, () => authApi.cotalAuthProvider.userCredentials({ store: client.store, dir: client.state, space: client.space, actor: "cli" })));
    const pins = { account: trust.account, assignmentLifecycleUid: trust.assignmentLifecycleUid, authority: trust.authority };
    const post = async (index: number, body: Record<string, unknown>, requestPins = pins) => {
      const response = await fetch(authHandles[0].publicUrl! + "/endpoint-service-authority", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ordinary[index].bearer}` }, body: JSON.stringify({ v: 2, ...requestPins, ...body }), signal: AbortSignal.timeout(budget()) });
      const value = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(`endpoint authority refused ${response.status}: ${typeof value.error === "string" ? value.error : "reason unavailable"}`);
      return value;
    };
    const active: { instanceId: string; serveJwt: string; attestation: string; credentialDigest: string; holder: ReturnType<typeof core.newIdentity> }[] = [];
    const controlPrincipals: core.EpCaller[] = [];
    const participantMaterialChecks: boolean[] = [];
    for (let index = 0; index < 2; index++) {
      await check(ids[index === 0 ? 5 : 6], async () => {
        const holder = core.newIdentity(), reservation = await post(index, { operation: "prepare", operationId: core.mintLifecycleUid(), endpoint, holderPublicKey: holder.id });
        assert.equal(reservation.state, "prepared"); assert.equal(typeof reservation.instanceId, "string");
        const instanceId = reservation.instanceId as string, operationId = core.mintLifecycleUid(), content = { action: "activate", registrationRevision: 0, processEpoch: 0, contractArtifacts: artifacts };
        const challenge = await post(index, { operation: "challenge", operationId, instanceId, content }); assert.equal(challenge.instanceId, instanceId); assert.equal(challenge.operationId, operationId);
        const signature = Buffer.from(fromSeed(enc.encode(holder.seed)).sign(enc.encode(core.canonicalJson(challenge)))).toString("base64url");
        const response = await post(index, { operation: "activate", operationId, instanceId, content, signature });
        for (const key of ["serveJwt", "attestation", "credentialDigest"]) assert.equal(typeof response[key], "string"); assert.equal(response.processEpoch, 0); assert.ok(Number(response.registrationRevision) > 0);
        active.push({ instanceId, holder, serveJwt: response.serveJwt as string, attestation: response.attestation as string, credentialDigest: response.credentialDigest as string });
      });
      const selection = { endpoint, instanceId: active[index].instanceId, commands: ["describe", "ep-check", "ep-admit", "ep-release"] };
      const control = await withHome(clients[index].home, () => authApi.cotalAuthProvider.endpointServingControlAuthority!({ store: clients[index].store, dir: clients[index].state, space: primary.space, actor: "cli", trust, selection, credentialDigest: active[index].credentialDigest, holder: { publicKey: active[index].holder.id, sign: async bytes => fromSeed(enc.encode(active[index].holder.seed)).sign(bytes) } }));
      assert.equal(control.receipt.kind, "cotal.endpoint-control"); assert.deepEqual(control.receipt.principal, principals[index]); controlPrincipals.push(control.receipt.principal);
      const material = { publicControl: true, servers, authority: { space: primary.space, instanceId: trust.authority.instanceId, epoch: trust.authority.epoch }, expectedControlPrincipal: control.receipt.principal, trust: { issuer: trust.issuer, accountPublicKey: trust.account.accountPublicKey, assignmentRevision: trust.account.assignmentRevision, keys: trust.keys, accountSigningKey: trust.accountSigningKey }, controlBearer: control.bearer, sentinelCreds: control.sentinelCreds, serveJwt: active[index].serveJwt, attestation: active[index].attestation, artifacts, holder: active[index].holder, serveCreds: new TextDecoder().decode(fmtCreds(active[index].serveJwt, fromSeed(enc.encode(active[index].holder.seed)))), input, output };
      if (publicReadControls) Object.assign(material, { publicEntryDiagnostic: true });
      const materialSafe = !["controlCreds", "signingSeed", "executorCreds", "store", "operatorSeed", "authCap", "hostStore"].some(key => Object.hasOwn(material, key));
      assert.ok(materialSafe); participantMaterialChecks.push(materialSafe);
      const path = join(dir, `worker-${index}.json`); core.writeSecretFile(path, JSON.stringify(material));
      const child = fork(new URL("./endpoint-authority-native-worker.ts", import.meta.url), [], { execArgv: ["--import", "tsx"], env: { PATH: process.env.PATH, HOME: clients[index].home, TMPDIR: process.env.TMPDIR, ENDPOINT_U12_WORKER_FILE: path }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const worker: typeof workers[number] = { child, messages: [], exit: new Promise(resolve => child.once("exit", resolve)), stopped: false };
      child.on("error", () => { worker.error = "owned worker process error"; });
      child.on("message", value => { const message = value as Record<string, unknown>; worker.messages.push(message); if (message.kind === "failure") worker.error = "owned worker reported failure"; }); workers.push(worker);
      await waitFor(() => !!worker.error || worker.messages.some(m => m.kind === "ready")); assert.ok(!worker.error);
    }
    await check(ids[7], async () => { assert.deepEqual(controlPrincipals, principals); for (let i = 0; i < 2; i++) { const ready = workers[i].messages.find(m => m.kind === "ready"); assert.deepEqual(ready?.controlPrincipal, principals[i]); assert.equal(ready?.issuedControlObserved, true); } });
    await check(ids[8], async () => { assert.equal(workers.length, 2); assert.ok(workers.every(w => typeof w.child.pid === "number" && w.child.pid > 0)); assert.notEqual(workers[0].child.pid, workers[1].child.pid); assert.notEqual(active[0].instanceId, active[1].instanceId); for (let i = 0; i < 2; i++) { const ready = workers[i].messages.find(m => m.kind === "ready")!; assert.equal(ready.instanceId, active[i].instanceId); assert.equal(ready.owner, principals[i].owner); assert.equal(ready.protocol, 3); } });
    await check(ids[9], async () => { assert.deepEqual(participantMaterialChecks, [true, true]); assert.equal(controlPrincipals.length, 2); });
    async function acquire(index: number, instanceId: string, commands = ["describe", "increment"]) {
      return await withHome(clients[index].home, () => authApi.cotalAuthProvider.endpointCallerAuthority!({ store: clients[index].store, dir: clients[index].state, space: primary.space, actor: "cli", trust, selection: { endpoint, instanceId, commands } }));
    }
    async function connected(index: number, instanceId: string, commands?: string[]) {
      const material = await acquire(index, instanceId, commands), options = core.standaloneConnectOpts({ tls: false, bearer: material.bearer, sentinelCreds: material.sentinelCreds });
      const nc = track(await connect({ servers, ...options, maxReconnectAttempts: 0 }));
      const caller = await core.issuedUserCaller(nc, primary.space, String(options.name), material.receipt.principal);
      assert.deepEqual(material.receipt.principal, principals[index]); assert.equal(material.receipt.selection.instanceId, instanceId);
      const service = await core.resolveService(nc, primary.space, endpoint, caller, { instanceId, deadlineMs: budget() }); core.assertEndpointCallerResolvedService(service, material.receipt);
      return { nc, caller, service, material };
    }
    const own: Awaited<ReturnType<typeof connected>>[] = [];
    for (let index = 0; index < 2; index++) await check(ids[index === 0 ? 10 : 11], async () => {
      const client = await connected(index, active[index].instanceId); own.push(client);
      const response = await core.invokeCommand(client.nc, primary.space, client.service, "increment", undefined, { deadlineMs: budget() });
      assert.equal(response.reply.ok, true); assert.deepEqual(response.reply.data, { effects: 1, owner: principals[index].owner });
      const counts = await snapshot(); assert.equal(counts[index], 1);
    });
    await check(ids[12], async () => { assert.deepEqual(await snapshot(), [1, 1]); });
    await negative(ids[13], async () => { await expectPublicDenial(() => acquire(1, active[0].instanceId), /caller policy denied/); });
    const grantedShare = shareKey(principals[1], active[0].instanceId);
    await check(ids[14], async () => { assert.equal(shares.size, 0); shares.add(grantedShare); assert.equal(shares.size, 1); assert.ok(!shares.has(shareKey(principals[0], active[1].instanceId))); });
    await check(ids[15], async () => {
      const shared = await connected(1, active[0].instanceId); assert.equal(shared.caller.owner, principals[1].owner); assert.equal(shared.service.owner, principals[0].owner);
      const response = await core.invokeCommand(shared.nc, primary.space, shared.service, "increment", undefined, { deadlineMs: budget() }); assert.equal(response.reply.ok, true); assert.deepEqual(response.reply.data, { effects: 2, owner: principals[0].owner }); assert.deepEqual(await snapshot(), [2, 1]); assert.ok(shareDecisions.includes(grantedShare));
    });
    await negative(ids[16], async () => { await expectPublicDenial(() => acquire(0, active[1].instanceId), /caller policy denied/); });
    await negative(ids[17], async () => { await expectPublicDenial(() => acquire(0, core.mintLifecycleUid()), /absent\/deleted|not active/); });
    await negative(ids[18], async () => { await expectPublicDenial(() => acquire(0, active[0].instanceId, ["describe", "other"]), /caller policy denied/); });
    async function brokerDenied(nc: NatsConnection, space: string, instanceId: string, command: string, caller: core.EpCaller, mode: "inst" | "one" | "all" = "inst") {
      const nonce = core.mintLifecycleUid(), subject = core.epRequestSubject(space, { route: mode === "inst" ? { mode, instanceId } : { mode }, endpoint, command, caller, nonce });
      expectedPermissionSubjects.set(nc, subject);
      const status = nc.status(); let violation: PermissionViolationError | undefined;
      const watch = (async () => { for await (const event of status) if (event.type === "error" && event.error instanceof PermissionViolationError && event.error.subject === subject) { violation = event.error; break; } })();
      try {
        const request = { v: 1, id: nonce, op: { endpoint, command, inputDigest: contract.input.closureDigest, outputDigest: contract.output.closureDigest }, class: "ephemeral", replyExpected: false, from: { id: `${caller.owner}.${caller.actor}`, name: caller.actor } };
        core.parseEndpointRequest(request); nc.publish(subject, enc.encode(JSON.stringify(request))); await nc.flush(); await waitFor(() => violation !== undefined); assert.ok(violation instanceof PermissionViolationError);
        phaseEvidence.push({ kind: "broker-permission-denial", subjectDigest: core.rawDigest(subject), exactSubjectObserved: true, command, route: mode });
      } finally { await bounded(nc.close()); const closeError = await bounded(nc.closed()); await bounded(watch); assert.ok(!closeError, "permission probe close failed"); }
    }
    for (const [cell, command, instanceId, route, legacy] of [
      [ids[19], "increment", active[1].instanceId, "inst", false], [ids[20], "other", active[0].instanceId, "inst", false],
      [ids[21], "increment", active[0].instanceId, "inst", true], [ids[22], "increment", active[0].instanceId, "one", false], [ids[23], "increment", active[0].instanceId, "all", false],
    ] as const) await negative(cell, async () => {
      const probe = await connected(0, active[0].instanceId);
      await brokerDenied(probe.nc, primary.space, instanceId, command, legacy ? principals[0] : probe.caller, route);
    });
    await negative(ids[24], async () => {
      const altered = { ...pins, account: { ...pins.account, accountPublicKey: aux.auth.account.pub, space: aux.space } };
      await expectPublicDenial(() => post(0, { operation: "prepare", operationId: core.mintLifecycleUid(), endpoint, holderPublicKey: core.newIdentity().id }, altered), /deployment|account|pins/);
    });
    const auxOrdinary = await withHome(auxClient.home, () => authApi.cotalAuthProvider.userCredentials({ store: auxClient.store, dir: auxClient.state, space: aux.space, actor: "cli" }));
    const auxClaims = decodeJwt(auxOrdinary.bearer) as { sub?: string; act?: { owner?: string; actor?: string; lifecycleUid?: string } }; assert.equal(auxClaims.sub, auxPrincipal.owner); assert.equal(auxClaims.act?.owner, auxPrincipal.owner); assert.equal(auxClaims.act?.actor, auxPrincipal.actor); assert.equal(auxClaims.act?.lifecycleUid, auxPrincipal.uid);
    const auxNc = track(await connect({ servers, ...core.standaloneConnectOpts({ tls: false, bearer: auxOrdinary.bearer, sentinelCreds: auxOrdinary.sentinelCreds }), maxReconnectAttempts: 0 }));
    const subject = core.chatSubject(aux.space, auxPrincipal.owner, auxPrincipal.actor, channel), auxMessages: string[] = [], primaryMessages: string[] = [];
    let auxWitnessEnded = false;
    let a0: string | undefined, p0: string | undefined, p1: string | undefined, x: string | undefined;
    let finalWitnessCheck: (() => void) | undefined;
    const auxStatus = auxNc.status();
    const auxStatusWatch = (async () => { for await (const event of auxStatus) {
      if (auxWitnessEnded && event.type === "error" && event.error instanceof PermissionViolationError && event.error.subject === expectedPermissionSubjects.get(auxNc)) continue;
      if (event.type === "error" || event.type === "disconnect" || event.type === "reconnect") witnessDebt("AUX witness status failure");
    } })();
    statusWatches.push(auxStatusWatch);
    const auxSub = auxNc.subscribe(subject, { callback: (error, message) => { if (error) witnessDebt("AUX witness subscription failed"); else { const value = new TextDecoder().decode(message.data); auxMessages.push(value); if (value === p0 || value === p1) witnessDebt("AUX received PRIMARY witness traffic"); } } });
    let observerStatusWatch: Promise<void> | undefined;
    let primarySub: ReturnType<NatsConnection["subscribe"]> | undefined;
    try {
      await auxNc.flush(); a0 = core.mintLifecycleUid();
      await check(ids[25], async () => { auxNc.publish(subject, enc.encode(a0)); await auxNc.flush(); await waitFor(() => auxMessages.includes(a0!)); assert.equal(auxMessages.filter(x => x === a0).length, 1); assert.equal(witnessErrors.length, 0); verifyAccountProvenance(); });
      observer = await openAuthorityClient({ server: servers, space: primary.space, dataAccount: { pub: primary.auth.account.pub, signingSeed: primary.auth.account.signingSeed! }, label: "two-user-primary-wire-observer", noReconnect: true, grants: () => ({ publish: [subject], subscribe: [subject] }), log: () => {} }); observerCreated++;
      const status = observer.nc.status();
      observerStatusWatch = (async () => { for await (const event of status) if (event.type === "error" || event.type === "disconnect" || event.type === "reconnect") witnessDebt("PRIMARY observer status failure"); })();
      statusWatches.push(observerStatusWatch);
      primarySub = observer.nc.subscribe(subject, { callback: (error, message) => { if (error) witnessDebt("PRIMARY witness subscription failed"); else { const value = new TextDecoder().decode(message.data); primaryMessages.push(value); if (value === x) witnessDebt("PRIMARY received AUX witness traffic"); } } });
      await observer.nc.flush(); p0 = core.mintLifecycleUid(); p1 = core.mintLifecycleUid(); x = core.mintLifecycleUid();
      finalWitnessCheck = () => {
        assert.equal(auxMessages.filter(value => value === a0).length, 1);
        assert.equal(auxMessages.filter(value => value === x).length, 1);
        assert.equal(primaryMessages.filter(value => value === p0).length, 1);
        assert.equal(primaryMessages.filter(value => value === p1).length, 1);
        assert.equal(primaryMessages.filter(value => value === x).length, 0);
        assert.ok(!auxMessages.includes(p0!) && !auxMessages.includes(p1!));
        assert.equal(witnessErrors.length, 0); verifyAccountProvenance();
      };
      const before = await snapshot(); observer.nc.publish(subject, enc.encode(p0)); await observer.nc.flush(); await waitFor(() => primaryMessages.includes(p0!));
      await check(ids[27], async () => {
        const witnessDeadline = Date.now() + budget();
        verifyAccountProvenance(); assert.equal(primaryMessages.filter(value => value === p0).length, 1);
        auxNc.publish(subject, enc.encode(x)); await auxNc.flush(); await waitFor(() => auxMessages.includes(x!));
        assert.ok(deadline - Date.now() >= 250, "account observation exceeds remaining entry budget"); await new Promise(resolve => setTimeout(resolve, 250));
        observer!.nc.publish(subject, enc.encode(p1)); await observer!.nc.flush(); await waitFor(() => primaryMessages.includes(p1!));
        assert.equal(auxMessages.filter(value => value === x).length, 1); assert.equal(primaryMessages.filter(value => value === x).length, 0);
        assert.ok(!auxMessages.includes(p0!) && !auxMessages.includes(p1!)); assert.equal(witnessErrors.length, 0); verifyAccountProvenance(); assert.deepEqual(await snapshot(), before);
        assert.ok(Date.now() <= witnessDeadline, "same-wire witness phase deadline");
        phaseEvidence.push({ kind: "same-wire-account-partition", wireDigest: core.rawDigest(subject), auxDelivery: 1, primaryDelivery: 0, windowMs: 250, configDigest, ordinaryAuxPositive: true, primaryPositiveIsTrustedHost: true });
      });
      await check(ids[26], async () => { assert.equal(primaryMessages.filter(value => value === p0).length, 1); assert.equal(primaryMessages.filter(value => value === p1).length, 1); assert.equal(witnessErrors.length, 0); });
    } finally {
      auxSub.unsubscribe(); primarySub?.unsubscribe();
      try {
        const auxError = await bounded(auxSub.closed); assert.ok(!auxError && auxSub.isClosed());
        if (primarySub) { const primaryError = await bounded(primarySub.closed); assert.ok(!primaryError && primarySub.isClosed()); }
        auxWitnessEnded = true;
      } catch { witnessDebt("witness subscription removal unconfirmed"); custodyOutstanding = true; }
      if (observer) try { await bounded(observer.close()); const closeError = await bounded(observer.nc.closed()); if (observerStatusWatch) await bounded(observerStatusWatch); assert.ok(!closeError && observer.nc.isClosed()); observerClosed++; } catch { witnessDebt("PRIMARY observer close failed"); custodyOutstanding = true; }
      try { assert.equal(witnessErrors.length, 0); if (passed.has(ids[26]) && passed.has(ids[27])) { assert.ok(finalWitnessCheck, "completed witness requires lifetime verifier"); finalWitnessCheck(); } }
      catch { witnessDebt("witness lifetime validation failed"); }
    }
    assert.equal(witnessErrors.length, 0, "witness lifetime debt remains after retirement");
    await negative(ids[28], async () => { await brokerDenied(auxNc, primary.space, active[0].instanceId, "increment", auxPrincipal); });
    await bounded(auxStatusWatch);
    for (let index = 0; index < 2; index++) await check(ids[index === 0 ? 29 : 30], async () => {
      const client = clients[index], before = await snapshot();
      const command = "increment";
      const cliBudget = Math.min(30000, deadline - Date.now() - 1000); assert.ok(cliBudget > 0, "no CLI budget with reserved close wait");
      const result = await runEndpointCallerCLI({ cwd: fileURLToPath(new URL("../../../", import.meta.url)), timeoutMs: cliBudget, closeWaitMs: 1000, maxOutputBytes: 8192, env: { PATH: process.env.PATH, HOME: client.home, COTAL_HOME: client.home, XDG_CONFIG_HOME: join(client.home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" } }, ["invoke", endpoint, command, "--on", active[index].instanceId, "--space", primary.space]);
      cliResults.push(result); custodyOutstanding ||= !result.closeObserved || result.closeWaitExpired;
      phaseEvidence.push({ cell: ids[index === 0 ? 29 : 30], kind: "actual-known-source-cli-outcome", code: result.code, signal: result.signal, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes, timedOut: result.timedOut, closeObserved: result.closeObserved, closeWaitExpired: result.closeWaitExpired, killAttempted: result.killAttempted, killAccepted: result.killAccepted, terminationReason: result.terminationReason, spawnErrorObserved: result.spawnError !== null, childErrorObserved: result.childError !== null, before });
      assert.equal(result.code, 0); assert.equal(result.signal, null); assert.ok(!result.timedOut && !result.closeWaitExpired && result.closeObserved && result.terminationReason === null && !result.killAttempted && !result.spawnError && !result.childError);
      assert.equal(result.stderrBytes, 0); assert.equal(Buffer.byteLength(result.stdout), result.stdoutBytes);
      assert.deepEqual(JSON.parse(result.stdout), { effects: before[index] + 1, owner: principals[index].owner });
      const after = await snapshot(); const expected = [...before]; expected[index]++; assert.deepEqual(after, expected);
      phaseEvidence.push({ cell: ids[index === 0 ? 29 : 30], code: result.code, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes, closeObserved: result.closeObserved, before, after });
    });
    await check(ids[31], async () => { assert.equal(cliResults.length, 2); assert.ok(cliResults.every(r => r.closeObserved && !r.closeWaitExpired)); });
    await check(ids[32], async () => { assert.deepEqual(await snapshot(), [3, 2]); });
    if (protocol3Diagnostic) {
      const diagnosticIds = ids.slice(37);
      let low: Awaited<ReturnType<typeof connected>> | undefined, client: core.CotalEndpoint | undefined;
      const outcomes: { stage: string; outcome: "succeeded" | "refused" | "not-reached"; code: string; before: number[]; after: number[];
        requestsBefore: number; requestsAfter: number; readsBefore: number; readsAfter: number; replyOk: boolean | null; attributedUnbound: boolean; errorBoundary: DiagnosticErrorBoundary }[] = [];
      const stageErrors = diagnosticStageErrors;
      let startSucceeded = false;
      const safeCode = (error: unknown): string => error instanceof core.EpEnvelopeError ? error.code
        : error instanceof PermissionViolationError ? "broker-permission-violation" : error instanceof Error ? "error" : "non-error";
      // Classify only fixed shipped refusal literals. Never export the message or its dynamic values.
      const errorBoundary = (error: unknown): DiagnosticErrorBoundary => {
        if (error instanceof PermissionViolationError || (error instanceof Error && error.cause instanceof PermissionViolationError))
          return "broker-permission-violation";
        if (!(error instanceof core.EpEnvelopeError)) return "other";
        const message = error.message;
        if (error.code === "unavailable") {
          if (message.startsWith("describe reply subscription failed: ")) return "describe-reply-subscription";
          if (message.startsWith("the NATS connection's status() stream does not expose stop(); the describe permission watch")) return "describe-permission-watch-unreleasable";
          if (message.startsWith("the describe retry for ") && message.includes(" could not publish: ")) return "describe-retry-publish";
          if (message.startsWith("the contract-store read for ") && message.includes(" failed (a failed observation is never absence, SPEC 13.7): ")) return "contract-store-read";
        }
        if (error.code === "permission-denied" && message.startsWith("the describe for ") && message.includes(" was REFUSED BY THE BROKER, not unanswered: "))
          return "describe-publish-denied";
        if (message.startsWith("describe(") && message.includes(") failed: ")) return "describe-answered-refusal";
        return "other";
      };
      const observe = async (stage: string, action?: () => Promise<unknown> | unknown) => {
        const before = await snapshot();
        const { applicationRequests: requestsBefore, readVisits: readsBefore } = diagnosticCounters[0];
        let outcome: "succeeded" | "refused" | "not-reached" = "not-reached", code = "not-reached";
        let replyOk: boolean | null = null, attributedUnbound = false;
        let boundary: DiagnosticErrorBoundary = "not-reached";
        if (action) {
          diagnosticStageInFlight = stage;
          // The wrapper resolves on an actual API refusal. A phase timeout escapes and is RED,
          // rather than being mislabeled an unsupported public composition.
          const acquisition = Promise.resolve().then(action).then(
            value => {
              const reply = value !== null && typeof value === "object" && "reply" in value
                ? (value as core.EpAttributedReply).reply : undefined;
              return { outcome: reply?.ok === false ? "refused" as const : "succeeded" as const,
                code: reply?.error?.code ?? "none", replyOk: reply?.ok ?? null, attributedUnbound: false, errorBoundary: reply?.ok === false ? "attributed-reply-refusal" as const : "none" as const };
            },
            error => ({ outcome: "refused" as const, code: safeCode(error), replyOk: null, attributedUnbound: core.respondedButUnbound(error), errorBoundary: errorBoundary(error) }))
            .finally(() => { diagnosticStageInFlight = null; });
          diagnosticAcquisitions.add(acquisition);
          void acquisition.then(() => diagnosticAcquisitions.delete(acquisition));
          const result = await bounded(acquisition);
          outcome = result.outcome; code = result.code; replyOk = result.replyOk; attributedUnbound = result.attributedUnbound; boundary = result.errorBoundary;
        }
        const after = await snapshot();
        const { applicationRequests: requestsAfter, readVisits: readsAfter } = diagnosticCounters[0];
        const record = { stage, outcome, code, before, after, requestsBefore, requestsAfter, readsBefore, readsAfter, replyOk, attributedUnbound, errorBoundary: boundary }; outcomes.push(record);
        diagnosticStagesObserved++;
        phaseEvidence.push({ kind: "protocol3-public-entry-stage", ...record }); log(JSON.stringify({ scope: "protocol3-public-entry-diagnostic", ...record }));
        return outcome === "succeeded";
      };
      const lowCall = async (command: "increment" | "read-state") => {
        assert.ok(low); core.assertEndpointCallerResolvedService(low.service, low.material.receipt);
        const before = await snapshot();
        const countsBefore = { ...diagnosticCounters[0] };
        const response = await bounded(core.invokeCommand(low.nc, primary.space, low.service, command, undefined, { deadlineMs: budget() }));
        assert.equal(response.reply.ok, true); assert.equal(response.responder.instanceId, active[0].instanceId);
        const after = await snapshot(); const expected = [...before]; if (command === "increment") expected[0]++;
        assert.deepEqual(after, expected); assert.deepEqual(response.reply.data, { effects: after[0], owner: principals[0].owner });
        assert.equal(diagnosticCounters[0].applicationRequests, countsBefore.applicationRequests + 1);
        assert.equal(diagnosticCounters[0].readVisits, countsBefore.readVisits + Number(command === "read-state"));
        phaseEvidence.push({ kind: "protocol3-low-level-bracket", command, before, after, countsBefore,
          countsAfter: { ...diagnosticCounters[0] }, protocol: low.service.descriptor?.protocol.v });
      };
      await check(diagnosticIds[0], async () => {
        const acquisition = connected(0, active[0].instanceId, ["describe", "increment", "read-state"]);
        diagnosticAcquisitions.add(acquisition);
        void acquisition.then(() => diagnosticAcquisitions.delete(acquisition), () => diagnosticAcquisitions.delete(acquisition));
        low = await bounded(acquisition);
        assert.equal(low.service.descriptor?.protocol.v, 3); assert.equal(low.service.commands.get("increment")?.effect, "write");
        assert.equal(low.service.commands.get("read-state")?.effect, "read"); core.assertEndpointCallerResolvedService(low.service, low.material.receipt);
      });
      await check(diagnosticIds[1], () => lowCall("increment"));
      await check(diagnosticIds[2], () => lowCall("read-state"));
      await check(diagnosticIds[3], async () => { await observe("constructor", () => {
        assert.ok(low);
        client = new core.CotalEndpoint({ space: primary.space, servers, bearer: low.material.bearer,
          sentinelCreds: low.material.sentinelCreds, lifecycleUid: low.material.receipt.principal.uid,
          card: { name: "protocol3-public-entry", kind: "endpoint" }, tls: false,
          consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
          onConnection: nc => { diagnosticConnections.push(nc); track(nc); } });
        diagnosticClients.push(client); client.on("error", error => {
          stageErrors.push({ stage: diagnosticStageInFlight ?? "outside-stage", code: safeCode(error), eventBoundary: errorBoundary(error) });
          if (diagnosticStageInFlight === null) cleanupErrors.push("unexpected public diagnostic error outside an observed stage");
        });
      }); });
      await check(diagnosticIds[4], async () => { startSucceeded = await observe("start", client ? () => client!.start() : undefined); });
      await check(diagnosticIds[5], async () => { await observe("invoke-write", startSucceeded ? () => client!.invokeService(endpoint, "increment", undefined,
        { instanceId: active[0].instanceId, deadlineMs: budget(), signal: AbortSignal.timeout(budget()) }) : undefined); });
      await check(diagnosticIds[6], async () => { await observe("invoke-read", startSucceeded ? () => client!.invokeService(endpoint, "read-state", undefined,
        { instanceId: active[0].instanceId, deadlineMs: budget(), signal: AbortSignal.timeout(budget()) }) : undefined); });
      await check(diagnosticIds[7], () => lowCall("increment"));
      await check(diagnosticIds[8], () => lowCall("read-state"));
      await check(diagnosticIds[9], async () => {
        assert.equal(outcomes.length, 4);
        for (const record of outcomes) {
          assert.equal(record.after[1], record.before[1]);
          const delta = record.after[0] - record.before[0];
          if (record.stage === "invoke-write") { assert.ok(delta === 0 || delta === 1); diagnosticWriteEffects = delta; }
          else assert.equal(delta, 0);
          assert.ok(record.requestsAfter >= record.requestsBefore && record.readsAfter >= record.readsBefore);
          const requestDelta = record.requestsAfter - record.requestsBefore;
          const readDelta = record.readsAfter - record.readsBefore;
          if (record.stage === "invoke-read") { assert.ok(readDelta === 0 || readDelta === 1); assert.equal(requestDelta, readDelta); }
          else if (record.stage === "invoke-write") { assert.equal(requestDelta, delta); assert.equal(readDelta, 0); }
          else { assert.equal(requestDelta, 0); assert.equal(readDelta, 0); }
        }
        assert.deepEqual(await snapshot(), [5 + diagnosticWriteEffects, 2]);
        phaseEvidence.push({ kind: "protocol3-public-entry-classification", outcomes, stageErrors,
          classification: "observed-boundary-only", attributedUnboundObserved: outcomes.some(record => record.attributedUnbound),
          requestsCountedAt: "stock-admitted-application-handler", protocol3RetryAcceptance: false });
      });
      await check(diagnosticIds[10], async () => {
        for (const endpointClient of diagnosticClients) await bounded(endpointClient.stop());
        assert.equal(diagnosticAcquisitions.size, 0);
        for (const nc of diagnosticConnections) { const error = await bounded(nc.closed()); assert.ok(!error && nc.isClosed()); }
        assert.ok(low); await bounded(low.nc.close()); const lowError = await bounded(low.nc.closed()); assert.ok(!lowError && low.nc.isClosed());
        phaseEvidence.push({ kind: "protocol3-public-client-lifetime", stageErrors: [...stageErrors],
          clients: diagnosticClients.length, knownConnections: diagnosticConnections.length, acquisitionsOutstanding: diagnosticAcquisitions.size });
        // Parent finally awaits every known connection's actual closed signal, including any
        // opened before a failed start. stop() also awaits a concurrently settling start.
      });
    }
    if (issuedPublicAcceptance) {
      const acceptanceIds = ids.slice(37);
      let low: Awaited<ReturnType<typeof connected>> | undefined;
      let client: core.CotalEndpoint | undefined;
      let service: core.ResolvedService | undefined;
      const publicErrors: unknown[] = [];
      const acquired = async <T>(operation: () => Promise<T>): Promise<T> => {
        const flight = Promise.resolve().then(operation);
        diagnosticAcquisitions.add(flight);
        void flight.then(() => diagnosticAcquisitions.delete(flight), () => diagnosticAcquisitions.delete(flight));
        return await bounded(flight);
      };
      const lowCall = async (command: "increment" | "read-state") => {
        assert.ok(low); core.assertEndpointCallerResolvedService(low.service, low.material.receipt);
        const before = await snapshot(), counts = { ...diagnosticCounters[0] };
        const response = await acquired(() => core.invokeCommand(low!.nc, primary.space, low!.service, command, undefined, { deadlineMs: budget() }));
        assert.equal(response.reply.ok, true); assert.equal(response.responder.instanceId, active[0].instanceId);
        const after = await snapshot(), expected = [...before]; if (command === "increment") expected[0]++;
        assert.deepEqual(after, expected); assert.deepEqual(response.reply.data, { effects: after[0], owner: principals[0].owner });
        assert.equal(diagnosticCounters[0].applicationRequests, counts.applicationRequests + 1);
        assert.equal(diagnosticCounters[0].readVisits, counts.readVisits + Number(command === "read-state"));
      };
      const publicCall = async (command: "increment" | "read-state") => {
        assert.ok(client && low && service); core.assertEndpointCallerResolvedService(service, low.material.receipt);
        const before = await snapshot(), counts = { ...diagnosticCounters[0] };
        const response = await acquired(() => client!.invokeService(endpoint, command, undefined,
          { instanceId: active[0].instanceId, deadlineMs: budget(), signal: AbortSignal.timeout(budget()) }));
        assert.equal(response.reply.ok, true); assert.equal(response.responder.instanceId, low.material.receipt.selection.instanceId);
        assert.equal(response.responder.epoch, low.material.receipt.processEpoch);
        const after = await snapshot(), expected = [...before]; if (command === "increment") expected[0]++;
        assert.deepEqual(after, expected); assert.deepEqual(response.reply.data, { effects: after[0], owner: principals[0].owner });
        assert.equal(diagnosticCounters[0].applicationRequests, counts.applicationRequests + 1);
        assert.equal(diagnosticCounters[0].readVisits, counts.readVisits + Number(command === "read-state"));
        assert.equal(publicErrors.length, 0);
        log(JSON.stringify({ scope: publicEntryScope, command, replyOk: true,
          writeEffects: after[0] - before[0], requestDelta: diagnosticCounters[0].applicationRequests - counts.applicationRequests,
          readDelta: diagnosticCounters[0].readVisits - counts.readVisits, receiptBindingVerified: true }));
      };
      await check(acceptanceIds[0], async () => {
        low = await acquired(() => connected(0, active[0].instanceId, ["describe", "increment", "read-state"]));
        assert.equal(low.service.descriptor?.protocol.v, 3); assert.equal(low.service.commands.get("increment")?.effect, "write");
        assert.equal(low.service.commands.get("read-state")?.effect, "read"); core.assertEndpointCallerResolvedService(low.service, low.material.receipt);
      });
      await check(acceptanceIds[1], () => lowCall("increment"));
      await check(acceptanceIds[2], () => lowCall("read-state"));
      await check(acceptanceIds[3], async () => {
        assert.ok(low);
        client = new core.CotalEndpoint({ space: primary.space, servers, bearer: low.material.bearer,
          sentinelCreds: low.material.sentinelCreds, lifecycleUid: low.material.receipt.principal.uid, ...{ issuedCaller: true },
          card: { name: "issued-public-acceptance", kind: "endpoint" }, tls: false,
          consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
          onConnection: nc => { diagnosticConnections.push(nc); track(nc); } });
        diagnosticClients.push(client); client.on("error", error => { publicErrors.push(error); cleanupErrors.push("issued public acceptance asynchronous error"); });
        await acquired(() => client!.start());
        service = await acquired(() => client!.describeService(endpoint,
          { ...{ instanceId: active[0].instanceId }, deadlineMs: budget(), signal: AbortSignal.timeout(budget()) }));
        core.assertEndpointCallerResolvedService(service, low.material.receipt);
        await publicCall("increment"); diagnosticWriteEffects++;
      });
      await check(acceptanceIds[4], () => publicCall("read-state"));
      await check(acceptanceIds[5], async () => {
        assert.ok(low && service && "generation" in service.caller);
        assert.deepEqual(client!.principal, { owner: low.material.receipt.principal.owner, actor: low.material.receipt.principal.actor });
        assert.equal(service.caller.uid, low.material.receipt.principal.uid);
        assert.notEqual(service.caller.generation, low.caller.generation, "public client discovers its own issuance, not the low-level connection's");
        assert.deepEqual(await snapshot(), [5, 2]);
      });
      await negative(acceptanceIds[6], async () => {
        await assert.rejects(() => acquired(() => client!.invokeService(endpoint, "other", undefined,
          { instanceId: active[0].instanceId, deadlineMs: budget(), signal: AbortSignal.timeout(budget()) })),
          (error: unknown) => error instanceof core.EpEnvelopeError && error.code === "not-found");
      });
      await negative(acceptanceIds[7], async () => { await expectPublicDenial(() => acquired(() => acquire(0, active[1].instanceId)), /caller policy denied/); });
      await check(acceptanceIds[8], async () => {
        try {
          publicReconnectStage = "snapshot-before";
          const before = await snapshot();
          publicReconnectStage = "reconnect";
          const reconnectObservation = newPublicObservation("reconnect");
          await acquired(() => observedPublicCall("reconnect", reconnectObservation, () => client!.reconnect()));
          reconnectObservation.wrapper = "fulfilled";
          reconnectObservation.apiAtWrapper = reconnectObservation.api;
          publicReconnectStage = "connection-count";
          assert.equal(diagnosticConnections.length, 2);
          publicReconnectStage = "old-connection-closed";
          const closedError = await bounded(diagnosticConnections[0].closed()); assert.ok(!closedError && diagnosticConnections[0].isClosed());
          publicReconnectStage = "describe";
          service = await acquired(() => client!.describeService(endpoint,
            { ...{ instanceId: active[0].instanceId }, deadlineMs: budget(), signal: AbortSignal.timeout(budget()) }));
          publicReconnectStage = "receipt-binding";
          assert.ok(low); core.assertEndpointCallerResolvedService(service, low.material.receipt);
          publicReconnectStage = "read";
          await publicCall("read-state");
          publicReconnectStage = "snapshot-after";
          assert.deepEqual(await snapshot(), before);
          publicReconnectStage = "completed";
        } catch (error) {
          const reconnectObservation = publicCallSettlements.reconnect.at(-1);
          if (publicReconnectStage === "reconnect" && reconnectObservation) {
            reconnectObservation.wrapper = "rejected";
            reconnectObservation.apiAtWrapper = reconnectObservation.api;
            reconnectObservation.wrapperErrorClass = publicErrorClass(error);
          }
          publicReconnectBoundary = reconnectBoundary(error);
          throw error;
        }
      });
      await negative(acceptanceIds[9], async () => {
        assert.throws(() => new core.CotalEndpoint({ space: primary.space, servers, ...{ issuedCaller: true },
          lifecycleUid: principals[0].uid, card: { name: "invalid-issued-static", kind: "endpoint" } }), /issuedCaller requires a user bearer/);
      });
      await negative(acceptanceIds[10], async () => {
        assert.ok(low);
        assert.throws(() => new core.CotalEndpoint({ space: primary.space, servers, ...{ issuedCaller: true },
          bearer: low!.material.bearer, sentinelCreds: low!.material.sentinelCreds,
          card: { name: "invalid-issued-lifecycle", kind: "endpoint" } }), /requires this endpoint's lifecycleUid/);
      });
      await check(acceptanceIds[11], () => lowCall("increment"));
      await check(acceptanceIds[12], () => lowCall("read-state"));
      await check(acceptanceIds[13], async () => {
        assert.equal(diagnosticWriteEffects, 1); assert.deepEqual(await snapshot(), [6, 2]); assert.equal(publicErrors.length, 0);
      });
      await negative(acceptanceIds[14], async () => {
        const legacy = new core.CotalEndpoint({ space: aux.space, servers, bearer: auxOrdinary.bearer,
          sentinelCreds: auxOrdinary.sentinelCreds, lifecycleUid: auxPrincipal.uid, ...{ issuedCaller: true },
          card: { name: "legacy-view-issued-refusal", kind: "endpoint" }, tls: false,
          consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
          onConnection: nc => { diagnosticConnections.push(nc); track(nc); } });
        diagnosticClients.push(legacy);
        const expectedDenial = (error: unknown) => error instanceof core.EpEnvelopeError && error.code === "permission-denied"
          || error instanceof PermissionViolationError || error instanceof Error && error.cause instanceof PermissionViolationError;
        legacy.on("error", error => { if (!expectedDenial(error)) cleanupErrors.push("unexpected legacy issued-discovery error"); });
        await assert.rejects(() => acquired(() => legacy.start()), expectedDenial);
        await bounded(legacy.stop());
        await assert.rejects(() => legacy.describeService(endpoint), /endpoint not started/);
      });
      await check(acceptanceIds[15], async () => {
        await bounded(client!.stop()); assert.equal(diagnosticAcquisitions.size, 0);
        for (const nc of diagnosticConnections) { const error = await bounded(nc.closed()); assert.ok(!error && nc.isClosed()); }
        assert.ok(low); await bounded(low.nc.close()); const error = await bounded(low.nc.closed()); assert.ok(!error && low.nc.isClosed());
        assert.equal(publicErrors.length, 0);
      });
    }
    phase = "cleanup";
  } catch (error) { failure = error; failurePhase = phase; }
  finally {
    phase = "cleanup";
    for (const client of diagnosticClients) {
      const stopObservation = newPublicObservation("stop");
      try {
        await bounded(observedPublicCall("stop", stopObservation, () => client.stop()));
        stopObservation.wrapper = "fulfilled";
        stopObservation.apiAtWrapper = stopObservation.api;
      } catch (error) {
        stopObservation.wrapper = "rejected";
        stopObservation.apiAtWrapper = stopObservation.api;
        stopObservation.wrapperErrorClass = publicErrorClass(error);
        cleanupErrors.push("public diagnostic client stop or late start unconfirmed"); custodyOutstanding = true;
      }
    }
    if (diagnosticAcquisitions.size > 0) try { await bounded(Promise.allSettled([...diagnosticAcquisitions])); assert.equal(diagnosticAcquisitions.size, 0); }
    catch { cleanupErrors.push("public diagnostic acquisition remains outstanding"); custodyOutstanding = true; }
    for (let index = 0; index < workers.length; index++) {
      const worker = workers[index];
      try {
        const stop = async () => {
          if (worker.child.connected) worker.child.send({ kind: "stop" });
          await waitFor(() => worker.messages.some(m => m.kind === "stopped") || !!worker.error); assert.ok(!worker.error);
          const code = await bounded(worker.exit); assert.equal(code, 0); worker.stopped = true;
          const stopped = worker.messages.find(m => m.kind === "stopped"); assert.equal(stopped?.knownConnectionsClosed, 2);
          if (!failure) assert.equal(stopped?.effects, index === 0 ? 3 + (publicReadControls ? 2 + diagnosticWriteEffects : 0) : 2);
          if (publicReadControls && !failure) {
            assert.equal(stopped?.applicationRequests, diagnosticCounters[index].applicationRequests);
            assert.equal(stopped?.readVisits, diagnosticCounters[index].readVisits);
            assert.equal(stopped?.applicationRequests, Number(stopped?.effects) + Number(stopped?.readVisits));
            assert.equal(worker.messages.filter(message => message.kind === "effect").length, stopped?.effects);
            assert.equal(worker.messages.filter(message => message.kind === "read-visit").length, stopped?.readVisits);
          }
        };
        if (!failure && workers.length === 2) await check(ids[index === 0 ? 33 : 34], stop);
        else await stop();
      } catch (error) { if (!failure && failedCell !== null) failure = error; cleanupErrors.push("owned worker stop or exit unconfirmed"); try { await killAndAwaitExit(worker.child); } catch { custodyOutstanding = true; } }
    }
    if (observer && observerClosed === 0) try { await bounded(observer.close()); const closeError = await bounded(observer.nc.closed()); assert.ok(!closeError && observer.nc.isClosed()); observerClosed++; } catch { cleanupErrors.push("PRIMARY observer close failed"); custodyOutstanding = true; }
    for (const client of hostClients.reverse()) try { await bounded(client.close()); const error = await bounded(client.nc.closed()); assert.ok(!error && client.nc.isClosed()); hostClosed++; } catch { cleanupErrors.push("trusted fixture host connection close failed"); }
    for (const connection of connections.reverse()) try { await bounded(connection.nc.close()); const error = await bounded(connection.nc.closed()); assert.ok(!error); connection.closed = connection.nc.isClosed(); assert.ok(connection.closed); } catch { cleanupErrors.push("participant connection close failed"); }
    for (const watch of statusWatches) try { await bounded(watch); } catch { cleanupErrors.push("owned status observer retirement unconfirmed"); }
    if (witnessErrors.length > 0) cleanupErrors.push("retained witness lifetime debt at final cleanup");
    for (const handle of authHandles.reverse()) try { await bounded(handle.close()); const closed = await bounded(handle.closed); assert.ok(closed.connections.length > 0 && closed.connections.every(c => c.ended)); authClosed++; } catch { cleanupErrors.push("public auth service close failed"); }
    try { if (idpHttp.listening) { idpHttp.closeAllConnections(); await bounded(new Promise<void>((resolve, reject) => idpHttp.close(error => error ? reject(error) : resolve()))); } idpClosed = !idpHttp.listening; } catch { cleanupErrors.push("IdP listener close failed"); }
    if (!failure && cleanupErrors.length === 0) try { await check(ids[35], async () => { assert.equal(authClosed, 2); assert.ok(idpClosed); }); } catch (error) { failure = error; }
    if (broker) try { await killAndAwaitExit(broker, "SIGTERM"); } catch { cleanupErrors.push("known broker exit unconfirmed"); custodyOutstanding = true; }
    const brokerClosed = !!broker && (broker.exitCode !== null || broker.signalCode !== null);
    if (!failure && cleanupErrors.length === 0) try { await check(ids[36], async () => { assert.equal(observerCreated, 1); assert.equal(observerClosed, 1); assert.equal(hostClosed, hostClients.length); assert.ok(connections.every(c => c.closed)); assert.ok(brokerClosed && !custodyOutstanding && cleanupErrors.length === 0); }); } catch (error) { failure = error; }
    if (!custodyOutstanding && cleanupErrors.length === 0 && brokerClosed && workers.every(w => w.stopped)) { releaseBroker?.(); releasePath(); rmSync(dir, { recursive: true, force: true }); }
    clearTimeout(timer); if (previousHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = previousHome;
    const complete = !failure && cleanupErrors.length === 0 && !custodyOutstanding && passed.size === ids.length;
    // Public evidence contains only fixed identifiers, counts and custody. Child text and credentials never leave the private fixture.
    const summary = { scope: publicEntryScope, plannedCells: ids.length, namedControlsAttempted: attempted.size, namedControlsPassed: passed.size, namedControlsFailed: attempted.size - passed.size, failedCell, phase, failurePhase, cleanupFailure: cleanupErrors.length > 0, witnessDebtCount: witnessErrors.length, setupFailure: !!failure && failedCell === null && failurePhase !== null, laterControlsUnreached: ids.filter(id => !attempted.has(id)), cleanupConfirmed: cleanupErrors.length === 0 && !custodyOutstanding && workers.length === 2 && workers.every(w => w.stopped) && authClosed === 2 && idpClosed && brokerClosed && observerCreated === observerClosed && hostClosed === hostClients.length && connections.every(c => c.closed), knownWorkerExits: workers.filter(w => w.stopped).length, knownCLICloses: cliResults.filter(r => r.closeObserved).length, knownCLIAttempts: cliResults.length, participantConnections: connections.length, participantConnectionsClosed: connections.filter(c => c.closed).length, hostConnections: hostClients.length, hostConnectionsClosed: hostClosed, observerCreated, observerClosed, ...(protocol3Diagnostic ? { diagnosticStagesObserved, diagnosticClients: diagnosticClients.length, diagnosticConnections: diagnosticConnections.length, diagnosticAcquisitionsOutstanding: diagnosticAcquisitions.size, diagnosticStageErrorCount: diagnosticStageErrors.length, protocol3RetryAcceptance: false } : {}), ...(issuedPublicAcceptance ? { publicReconnectObservation: { stage: publicReconnectStage, boundary: publicReconnectBoundary }, publicCallSettlements, publicModulePins, cleanupDebt: cleanupErrors.map(cleanupDebt), publicCallSuccessRequired: true, publicWriteEffects: diagnosticWriteEffects, publicClients: diagnosticClients.length, publicConnections: diagnosticConnections.length, publicAcquisitionsOutstanding: diagnosticAcquisitions.size, protocol3RetryAcceptance: false } : {}), installedCLIQualification: false, fullEndpointAcceptance: false, childRetirementProved: false };
    core.writeSecretFile(report, JSON.stringify({ ...summary, passed: complete, checks: [...passed], cleanupErrors, failureObserved: !!failure, phaseEvidence }, null, 2) + "\n");
    log(JSON.stringify({ ...summary, reportRetained: true }));
    console.log = log; try { emitSentinel({ passed: passed.size, failed: complete ? 0 : Math.max(1, attempted.size - passed.size) }); } finally { Object.assign(console, savedLogs); }
    if (!complete) process.exitCode = 1;
  }
}
