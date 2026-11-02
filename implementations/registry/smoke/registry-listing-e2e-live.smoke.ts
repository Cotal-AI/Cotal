/** Run after building core and this package: pnpm smoke:registry-listing-e2e:live (needs nats-server).
 *  A static mesh end to end: real minted credentials on a JWT broker, a registered and served
 *  registry, and an agent asking it through its own endpoint. The registry is registered here by
 *  a fixture that follows the operator registration path; how a space runs it is not under test. */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import {
  CotalEndpoint, DEV_OWNER, EpEnvelopeError, RECORD_KINDS, createSpaceAuth, dialerFor, isReachable, mintAcceptedToken, mintCreds, mintGeneration, mintLifecycleUid, newIdentity, recordSpecKey,
  recordsBucket, serverConfig, setupSpaceStreams, standaloneConnectOpts,
  withIssuerSession, type EpCapability, type RegistryEndpointsOutput,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { fixtureCluster, registerFixture, runRegistryFixture } from "./_fixture.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

const suite = createSuite();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const port = await pickFreePort();
const space = "listing";
const servers = `nats://127.0.0.1:${port}`;
const storeDir = join(dir, "nats");
mkdirSync(storeDir, { recursive: true });
const auth = await createSpaceAuth(space);
const mesh = { auth, servers, space };
writeFileSync(join(dir, "broker.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir }));
const log = openSync(join(dir, "broker.log"), "w");
const broker = spawn("nats-server", ["-c", join(dir, "broker.conf")], { stdio: ["ignore", log, log] });
const releaseBroker = teardownOnSignal(broker, dir);
const endpoints: CotalEndpoint[] = [];
let registry: { stop(): Promise<void>; logged: string[] } | undefined;

try {
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  for (let i = 0; i < 50 && broker.exitCode === null && !(await isReachable(servers, { creds: provisioner })); i++) await new Promise((r) => setTimeout(r, 200));
  if (broker.exitCode !== null) throw new Error(`broker exited: ${readFileSync(join(dir, "broker.log"), "utf8")}`);
  await setupSpaceStreams({ servers, space, creds: provisioner });

  await registerFixture(mesh, "alpha.example", fixtureCluster("ai.example.alpha", ["read", "write"]));
  await registerFixture(mesh, "beta.example", fixtureCluster("ai.example.beta", ["ping"]));
  registry = await runRegistryFixture(mesh);

  const exp = Math.floor(Date.now() / 1000) + 3600;
  // `issued`: an agent on its own issued generation, with or without the `endpoints` row.
  const agent = async (opts: { listing: boolean; issued?: { listing: boolean }; expiresAt?: number; extra?: EpCapability[] }) => {
    const identity = newIdentity();
    const lifecycleUid = mintLifecycleUid();
    const mintOpts = { lifecycleUid, endpointCapabilities: [{ endpoint: "alpha.example", command: "read" }, ...(opts.extra ?? [])], ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}) };
    const issued = opts.issued
      ? { generation: mintGeneration(opts.expiresAt!), acceptedToken: mintAcceptedToken(), ...(opts.issued.listing ? { listing: true as const } : {}) }
      : undefined;
    const creds = issued
      ? await withIssuerSession({ servers, space, auth, tls: false }, (session) => mintCreds(auth, identity, "agent", {
        ...mintOpts, issued, issuance: { mode: "issue", store: session.store, accepted: session.accepted, sources: [] },
      }))
      : opts.listing
        ? await withIssuerSession({ servers, space, auth, tls: false }, (session) => mintCreds(auth, identity, "agent", { ...mintOpts, listingSeam: session }))
        : await mintCreds(auth, identity, "agent", mintOpts);
    const ep = new CotalEndpoint({
      space, servers, creds, lifecycleUid, ...(issued ? { acceptedToken: issued.acceptedToken } : {}),
      card: { id: identity.id, name: `lister-${randomBytes(3).toString("hex")}`, kind: "agent" },
      channels: [], consume: false, registerPresence: false, watchPresence: false,
    });
    endpoints.push(ep);
    // A denied publish is also reported as an `error` event; the cells read the call's own result.
    ep.on("error", () => {});
    await ep.start();
    return ep;
  };

  const listed = await agent({ listing: true, expiresAt: exp });
  const result = await listed.listEndpoints({}).catch((e: unknown) => e as Error);
  const page = result instanceof Error || result.unbound ? undefined : result.page;
  const commandsOf = (p: RegistryEndpointsOutput | undefined, endpoint: string) => p?.rows.find((r) => r.endpoint === endpoint)?.commands.map((c) => c.name).join();
  suite.check("a static agent with a listing generation lists the endpoints and commands its grants cover, and no others",
    page?.source === "recorded-ceiling" && page.rows.map((r) => r.endpoint).join() === "alpha.example,registry"
      && commandsOf(page, "alpha.example") === "read" && commandsOf(page, "registry") === "endpoints", result instanceof Error ? result.message : JSON.stringify(result));
  const forms = page?.rows.find((r) => r.endpoint === "alpha.example")?.commands[0]?.forms ?? [];
  suite.check("the listed command's form is the legacy class route the agent's own rows hold",
    forms.length === 1 && forms[0]!.rail === "ep" && forms[0]!.route === "one", forms);

  const before = await agent({ listing: false, expiresAt: exp });
  const isUnbound = (r: unknown) => typeof r === "object" && r !== null && "unbound" in r && r.unbound === true;
  const unbound = await before.listEndpoints({}).catch((e: unknown) => e);
  suite.check("a credential minted without a listing generation is told it has no listing binding", isUnbound(unbound), unbound instanceof Error ? unbound.message : unbound);
  const issuedListed = await (await agent({ listing: false, issued: { listing: true }, expiresAt: exp })).listEndpoints({}).catch((e: unknown) => e as Error);
  const issuedPage = issuedListed instanceof Error || issuedListed.unbound ? undefined : issuedListed.page;
  suite.check("an issued credential carrying the endpoints row lists on its own generation",
    issuedPage?.rows.map((r) => r.endpoint).join() === "alpha.example,registry", issuedListed instanceof Error ? issuedListed.message : JSON.stringify(issuedListed));
  // Minted as an issued credential was before listing issuance: no `endpoints` row.
  const issuedBefore = await agent({ listing: false, issued: { listing: false }, expiresAt: exp });
  const issuedUnbound = await issuedBefore.listEndpoints({}).catch((e: unknown) => e);
  suite.check("an issued credential whose generation predates listing issuance is told it has no listing binding",
    isUnbound(issuedUnbound), issuedUnbound instanceof Error ? issuedUnbound.message : issuedUnbound);
  const forever = await agent({ listing: true });
  const noExpiry = await forever.listEndpoints({}).catch((e: unknown) => e);
  suite.check("a credential with no expiry has no listing binding", isUnbound(noExpiry), noExpiry instanceof Error ? noExpiry.message : noExpiry);

  const asked = await before.invokeService("registry", "endpoints", {}).catch((e: unknown) => e);
  suite.check("the legacy rail cannot ask the registry: the broker refuses the publish",
    asked instanceof EpEnvelopeError && asked.code === "permission-denied" && asked.outcome === "not-executed", asked instanceof Error ? asked.message : asked);

  // Two theta instances declare `set`: the first by instance id untargeted, the second in owner mode.
  const [plain, owned] = [mintLifecycleUid(), mintLifecycleUid()].sort();
  await registerFixture(mesh, "theta.example", fixtureCluster("ai.example.theta", ["set"]), { instanceId: plain });
  await registerFixture(mesh, "theta.example", fixtureCluster("ai.example.theta.owned", ["set"], ["owner"]), { instanceId: owned });
  const thetaResult = await (await agent({ listing: true, expiresAt: exp, extra: [{ endpoint: "theta.example", command: "set", target: { mode: "owner", tOwner: DEV_OWNER } }] }))
    .listEndpoints({}).catch((e: unknown) => e as Error);
  const theta = thetaResult instanceof Error || thetaResult.unbound ? undefined : thetaResult.page?.rows.find((r) => r.endpoint === "theta.example");
  suite.check("each declaration of a command is projected over the instances that declare it",
    theta?.commands.length === 1 && theta.commands[0]!.instances?.join() === owned && theta.commands[0]!.forms.length > 0 && theta.commands[0]!.forms.every((f) => f.mode === "owner"),
    thetaResult instanceof Error ? thetaResult.message : JSON.stringify(theta ?? (thetaResult.unbound ? "unbound" : thetaResult.reply.reply)));

  // A zeta spec row that does not parse, written with the instance's own executor credential.
  const Z1 = mintLifecycleUid();
  const executor = await dialerFor(servers)({ servers, ...standaloneConnectOpts({
    creds: await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: "zeta.example", instanceId: Z1 } }), tls: false,
  }) });
  const zetaKey = recordSpecKey(RECORD_KINDS.svc, ["zeta.example", Z1]);
  try {
    const records = await new Kvm(executor).open(recordsBucket(space));
    await records.put(zetaKey, JSON.stringify({ endpoint: "zeta.example" }));
    const refused = await listed.listEndpoints({}).catch((e: unknown) => e as Error);
    const error = refused instanceof Error || refused.unbound ? undefined : refused.reply.reply.error;
    suite.check("a failed records read reaches the agent as a fixed refusal that names no endpoint or key, and its detail goes to the registry's log",
      error?.code === "unavailable" && error.message === "the registry could not read the space's endpoint records; nothing is listed"
        && registry!.logged.some((line) => line.includes("service record does not validate")),
      { reply: refused instanceof Error ? refused.message : error, logged: registry!.logged });
    await records.delete(zetaKey);
  } finally {
    await executor.close();
  }

  // The registry registers again under a new instance while the agent holds its old describe.
  const described = (await listed.describeService("registry")).responder.instanceId;
  await registry!.stop();
  registry = await runRegistryFixture(mesh);
  const cached = (await listed.describeService("registry")).responder.instanceId;
  const relisted = await listed.listEndpoints({}).catch((e: unknown) => e as Error);
  const fresh = await listed.describeService("registry").then((s) => s.responder.instanceId, (e: unknown) => (e as Error).message);
  suite.check("a listing drops the cached describe of every endpoint it reports",
    cached === described && !(relisted instanceof Error) && !relisted.unbound && relisted.page?.rows.some((r) => r.endpoint === "registry") === true && fresh !== described,
    { described, cached, fresh, relisted: relisted instanceof Error ? relisted.message : "ok" });

  // One delta instance verifies; the other's closure manifest digest holds bytes that do not. Last,
  // because before the fix one corrupt artifact failed every later listing.
  await registerFixture(mesh, "delta.example", fixtureCluster("ai.example.delta", ["poke"]));
  await registerFixture(mesh, "delta.example", fixtureCluster("ai.example.delta.next", ["poke"]), { corrupt: true });
  const deltaResult = await (await agent({ listing: true, expiresAt: exp, extra: [{ endpoint: "delta.example", command: "poke" }] })).listEndpoints({}).catch((e: unknown) => e as Error);
  const delta = deltaResult instanceof Error || deltaResult.unbound ? undefined : deltaResult.page?.rows.find((r) => r.endpoint === "delta.example");
  suite.check("an instance whose stored declaration does not verify is listed invalid, and the listing still answers",
    delta?.instances.map((i) => i.artifacts).sort().join() === "invalid,verified" && delta.commands.map((c) => c.name).join() === "poke"
      && delta.commands[0]!.instances?.join() === delta.instances.find((i) => i.artifacts === "verified")?.instanceId,
    deltaResult instanceof Error ? deltaResult.message : JSON.stringify(deltaResult.unbound ? "unbound" : deltaResult.reply.reply));
} finally {
  for (const ep of endpoints) await ep.stop().catch(() => {});
  await registry?.stop().catch(() => {});
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
suite.finish();
