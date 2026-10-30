/** Run after building core and this package: pnpm smoke:registry-listing-e2e:live (needs nats-server).
 *  A static mesh end to end: real minted credentials on a JWT broker, a registered and served
 *  registry, and an agent asking it through its own endpoint. The registry is registered here by
 *  a fixture that follows the operator registration path; how a space runs it is not under test. */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, EpEnvelopeError, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity, serverConfig, setupSpaceStreams,
  withIssuerSession, type RegistryEndpointsOutput,
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
let registry: { stop(): Promise<void> } | undefined;

try {
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  for (let i = 0; i < 50 && broker.exitCode === null && !(await isReachable(servers, { creds: provisioner })); i++) await new Promise((r) => setTimeout(r, 200));
  if (broker.exitCode !== null) throw new Error(`broker exited: ${readFileSync(join(dir, "broker.log"), "utf8")}`);
  await setupSpaceStreams({ servers, space, creds: provisioner });

  await registerFixture(mesh, "alpha.example", fixtureCluster("ai.example.alpha", ["read", "write"]));
  await registerFixture(mesh, "beta.example", fixtureCluster("ai.example.beta", ["ping"]));
  registry = await runRegistryFixture(mesh);

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
  const forever = await agent({ listing: true });
  const noExpiry = await forever.listEndpoints({}).catch((e: unknown) => e);
  suite.check("a credential with no expiry has no listing binding", isUnbound(noExpiry), noExpiry instanceof Error ? noExpiry.message : noExpiry);

  const asked = await before.invokeService("registry", "endpoints", {}).catch((e: unknown) => e);
  suite.check("the legacy rail cannot ask the registry: the broker refuses the publish",
    asked instanceof EpEnvelopeError && asked.code === "permission-denied" && asked.outcome === "not-executed", asked instanceof Error ? asked.message : asked);
} finally {
  for (const ep of endpoints) await ep.stop().catch(() => {});
  await registry?.stop().catch(() => {});
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
suite.finish();
