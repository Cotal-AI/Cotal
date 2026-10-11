import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { bearer } from "better-auth/plugins/bearer";
import { SignJWT, decodeJwt } from "jose";
import { toNodeHandler } from "better-auth/node";
import { connect, type NatsConnection } from "@nats-io/transport-node";
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
