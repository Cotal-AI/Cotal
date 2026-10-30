/** Run after building core and this package: pnpm smoke:registry-listing-e2e:live (needs nats-server).
 *  A static mesh end to end: real minted credentials on a JWT broker, a registered and served
 *  registry, and an agent asking it through its own endpoint. The registry is registered here by
 *  a fixture that follows the operator registration path; how a space runs it is not under test. */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import {
  CotalEndpoint, DEV_OWNER, EpEnvelopeError, dialerFor, standaloneConnectOpts, SERVICE_READY, VOID_SCHEMA_DIGEST, authorizeServeGrant, contractArtifactCanonicalBytes, contractStoreContext,
  createSpaceAuth, endpointRegistrationBarrier, epAuthBucket, isReachable, mintCreds, mintLifecycleUid, newIdentity, principalKey, provisionEndpointGateOpen, publishContractArtifact, readEndpointGateGeneration, recordsBucket,
  registerServiceInstance, registryClusterArtifacts, registryContractArtifactValues, serveIssuanceGateKv, serverConfig, setupSpaceStreams,
  singleDocumentClosure, withIssuerSession, writeServiceStatus, type EpServeGrant, type Identity, type RegistryEndpointsOutput,
  type ServiceNameAuthority, type SpaceAuth,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { natsRegistryReads, serveRegistry } from "../src/index.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

const suite = createSuite();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await pickFreePort();
const space = "listing";
const servers = `nats://127.0.0.1:${port}`;
const storeDir = join(dir, "nats");
mkdirSync(storeDir, { recursive: true });
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "broker.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir }));
const log = openSync(join(dir, "broker.log"), "w");
const broker = spawn("nats-server", ["-c", join(dir, "broker.conf")], { stdio: ["ignore", log, log] });
const releaseBroker = teardownOnSignal(broker, dir);
const conns: NatsConnection[] = [];
const endpoints: CotalEndpoint[] = [];
const dial = async (creds: string) => {
  const nc = await dialerFor(servers)({ servers, ...standaloneConnectOpts({ creds, tls: false }) });
  conns.push(nc);
  return nc;
};

/** Register one instance of `endpoint` as an operator does on a static mesh, and return the serve
 *  grant and credential. */
async function register(a: SpaceAuth, endpoint: string, document: unknown, extra: unknown[]): Promise<{ grant: EpServeGrant; creds: string; identity: Identity }> {
  const { manifest, closureDigest } = singleDocumentClosure(document);
  const store = new Map<string, unknown>([[closureDigest, manifest], [(manifest as { root: string }).root, document]]);
  const readClusterArtifact = (digest: string): unknown => store.get(digest);
  const authority: ServiceNameAuthority = { authorize: (name, owner) => ({ authorized: name === endpoint && owner === DEV_OWNER, revision: 0 }) };
  const instanceId = mintLifecycleUid();
  const identity = newIdentity();
  const nc = await dial(await mintCreds(a, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint, instanceId } }));
  const kvm = new Kvm(nc);
  const recordsKv: KV = await kvm.open(recordsBucket(space));
  const authKv: KV = await kvm.open(epAuthBucket(space));
  const ctx = await contractStoreContext(nc, space);
  for (const value of [...extra, document, manifest]) await publishContractArtifact(ctx, contractArtifactCanonicalBytes(value));
  await provisionEndpointGateOpen(authKv, { endpoint, instanceId, principal: principalKey(DEV_OWNER, identity.id).key });
  const barrier = endpointRegistrationBarrier(authKv, space, { endpoint, instanceId, opId: mintLifecycleUid() });
  const { registrationRevision } = await registerServiceInstance(recordsKv, {
    space, spec: { endpoint, owner: DEV_OWNER, clusterDigests: [closureDigest], protocol: { v: 1 } }, instanceId, registrant: { owner: DEV_OWNER },
    authority, barrier, readClusterArtifact, observeHolderGeneration: (holder) => readEndpointGateGeneration(authKv, { endpoint, instanceId: holder }),
  });
  const fence = serveIssuanceGateKv(authKv, space, { endpoint, instanceId });
  const epoch = (await fence.observe())!.processEpoch;
  const readProcessEpoch = async () => (await fence.observe())!.processEpoch;
  const grant = await authorizeServeGrant(recordsKv, { space, endpoint, instanceId, epoch, holder: { owner: DEV_OWNER }, authority, readClusterArtifact, readProcessEpoch });
  await writeServiceStatus(recordsKv, { endpoint, instanceId, epoch, status: { state: SERVICE_READY, epoch, observedSpecRevision: registrationRevision }, readProcessEpoch });
  const creds = await mintCreds(a, identity, "endpoint-serve", { serveIssuance: fence, endpointServe: grant });
  await nc.drain();
  return { grant, creds, identity };
}

const command = (name: string) => ({ name, class: "ephemeral", targeted: false, capability: name, inputDigest: VOID_SCHEMA_DIGEST, outputDigest: VOID_SCHEMA_DIGEST });
const cluster = (urn: string, names: string[]) => ({ urn, revision: 1, attributes: [], events: [], commands: names.map(command) });

try {
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  for (let i = 0; i < 50 && broker.exitCode === null && !(await isReachable(servers, { creds: provisioner })); i++) await new Promise((r) => setTimeout(r, 200));
  if (broker.exitCode !== null) throw new Error(`broker exited: ${readFileSync(join(dir, "broker.log"), "utf8")}`);
  await setupSpaceStreams({ servers, space, creds: provisioner });

  await register(auth, "alpha.example", cluster("ai.example.alpha", ["read", "write"]), []);
  await register(auth, "beta.example", cluster("ai.example.beta", ["ping"]), []);
  const { document } = registryClusterArtifacts();
  const registry = await register(auth, "registry", document, registryContractArtifactValues());
  const reads = await natsRegistryReads(await dial(await mintCreds(auth, newIdentity(), "registry-reader")), space);
  const served = serveRegistry(await dial(registry.creds), registry.grant, { space, mode: "authed", reads });

  const exp = Math.floor(Date.now() / 1000) + 3600;
  const agent = async (opts: { listing: boolean; expiresAt?: number }) => {
    const identity = newIdentity();
    const lifecycleUid = mintLifecycleUid();
    const mintOpts = { lifecycleUid, endpointCapabilities: [{ endpoint: "alpha.example", command: "read" }], ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}) };
    const creds = opts.listing
      ? await withIssuerSession({ servers, space, auth, tls: false }, (session) => mintCreds(auth, identity, "agent", { ...mintOpts, listingSeam: session }))
      : await mintCreds(auth, identity, "agent", mintOpts);
    const ep = new CotalEndpoint({
      space, servers, creds, lifecycleUid, card: { id: identity.id, name: `lister-${randomBytes(3).toString("hex")}`, kind: "agent" },
      channels: [], consume: false, registerPresence: false, watchPresence: false,
    });
    endpoints.push(ep);
    // A denied publish is also reported as an `error` event; the cells read the call's own result.
    ep.on("error", () => {});
    await ep.start();
    return ep;
  };

  const listed = await agent({ listing: true, expiresAt: exp });
  const result = await listed.listEndpoints({});
  const page = "page" in result ? result.page : undefined;
  const commandsOf = (p: RegistryEndpointsOutput | undefined, endpoint: string) => p?.rows.find((r) => r.endpoint === endpoint)?.commands.map((c) => c.name).join();
  suite.check("a static agent with a listing generation lists the endpoints and commands its grants cover, and no others",
    page?.source === "recorded-ceiling" && page.rows.map((r) => r.endpoint).join() === "alpha.example,registry"
      && commandsOf(page, "alpha.example") === "read" && commandsOf(page, "registry") === "endpoints", JSON.stringify(result));
  const forms = page?.rows.find((r) => r.endpoint === "alpha.example")?.commands[0]?.forms ?? [];
  suite.check("the listed command's form is the legacy class route the agent's own rows hold",
    forms.length === 1 && forms[0]!.rail === "ep" && forms[0]!.route === "one", forms);

  const before = await agent({ listing: false, expiresAt: exp });
  const unbound = await before.listEndpoints({});
  suite.check("a credential minted without a listing generation is told it has no listing binding", "unbound" in unbound && unbound.unbound === true, unbound);
  const forever = await agent({ listing: true });
  const noExpiry = await forever.listEndpoints({});
  suite.check("a credential with no expiry has no listing binding", "unbound" in noExpiry && noExpiry.unbound === true, noExpiry);

  const asked = await before.invokeService("registry", "endpoints", {}).catch((e: unknown) => e);
  suite.check("the legacy rail cannot ask the registry: the broker refuses the publish",
    asked instanceof EpEnvelopeError && asked.code === "permission-denied" && asked.outcome === "not-executed", asked instanceof Error ? asked.message : asked);

  await served.stop();
} finally {
  for (const ep of endpoints) await ep.stop().catch(() => {});
  for (const nc of conns) await nc.close().catch(() => {});
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
suite.finish();
