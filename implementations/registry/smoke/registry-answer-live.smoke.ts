/** Run after building core and this package: pnpm smoke:registry-answer:live (needs nats-server).
 *  The `endpoints` answer over the real reads on a throwaway broker: service records and contract
 *  artifacts as registration leaves them, and a caller's ceiling as issuance records it. */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  DEV_OWNER, EP_UNBOUND_CALLER_AUTHORITY, EpEnvelopeError, VOID_SCHEMA_DIGEST, contractArtifactCanonicalBytes, contractStoreContext,
  ensureIssuedStores, epRequestGrantRows, epRequestSubject, importNativeSubjectPermissions, isReachable, issuedBucket, mintGeneration,
  mintLifecycleUid, newIdentity, openIssuedStore, parseEpSubject, publishContractArtifact, recordsBucket, setupSpaceStreams, singleDocumentClosure,
  type EpCaller, type IssuedAuthorityRef, type ParsedEpRequest,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { answerEndpoints, natsRegistryReads, type RegistryAnswerOptions } from "../src/index.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

const suite = createSuite();
const port = await pickFreePort();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
let nc: NatsConnection | undefined;
try {
  const servers = `nats://127.0.0.1:${port}`;
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 100 });
  const space = "reg";
  await setupSpaceStreams({ servers, space });
  nc = await connect({ servers });
  const jsm = await jetstreamManager(nc);
  const kvm = new Kvm(nc);
  await ensureIssuedStores(jsm, kvm, space);
  const store = openIssuedStore(await kvm.open(issuedBucket(space)), jsm, space);
  const records = await kvm.open(recordsBucket(space));
  const contracts = await contractStoreContext(nc, space);
  const exp = Math.floor(Date.now() / 1000) + 3600;

  const command = (name: string) => ({ name, class: "ephemeral", targeted: false, capability: name, inputDigest: VOID_SCHEMA_DIGEST, outputDigest: VOID_SCHEMA_DIGEST });
  /** Publish a cluster and return its closure digest. `publish: false` leaves the artifacts out. */
  const cluster = async (urn: string, names: string[], publish = true) => {
    const document = { urn, revision: 1, attributes: [], events: [], commands: names.map(command) };
    const { manifest, closureDigest } = singleDocumentClosure(document);
    if (publish) for (const value of [document, manifest]) await publishContractArtifact(contracts, contractArtifactCanonicalBytes(value));
    return closureDigest;
  };
  const register = async (endpoint: string, instanceId: string, clusterDigest: string) => {
    const token = endpoint.split(".").join("_");
    await records.put(`svc.${token}.${instanceId}.spec`, JSON.stringify({ endpoint, owner: DEV_OWNER, clusterDigests: [clusterDigest], protocol: { v: 1 } }));
    await records.put(`svc.${token}.${instanceId}.status`, JSON.stringify({ epoch: 1, state: "ready", observedSpecRevision: 1 }));
  };

  const [A1, A2, A3, B1, G1, D1] = [mintLifecycleUid(), mintLifecycleUid(), mintLifecycleUid(), mintLifecycleUid(), mintLifecycleUid(), mintLifecycleUid()];
  await register("alpha.example", A1, await cluster("ai.example.alpha", ["read", "write"]));
  await register("alpha.example", A2, await cluster("ai.example.alpha.ro", ["read"]));
  await register("alpha.example", A3, await cluster("ai.example.alpha.next", ["read"], false));
  await register("beta.example", B1, await cluster("ai.example.beta", ["ping"]));
  await register("gamma.example", G1, await cluster("ai.example.gamma", ["look"], false));
  await register("delta.example", D1, await cluster("ai.example.delta", ["gone"]));
  await records.delete(`svc.delta_example.${D1}.spec`);

  const caller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
  const generation = mintGeneration(exp);
  const issued = { ...caller, generation } as EpCaller;
  const ref: IssuedAuthorityRef = { space, ...caller, generation };
  const rows = [
    ...epRequestGrantRows(space, { endpoint: "alpha.example", command: "read" }, issued),
    ...epRequestGrantRows(space, { endpoint: "gamma.example", command: "look" }, issued),
  ];
  await store.release(await store.stage({ version: 1, ref, sources: [], permissions: importNativeSubjectPermissions({ pub: { allow: rows } }), expiresAt: exp }), async () => {});

  const reads = await natsRegistryReads(nc, space);
  const authed: RegistryAnswerOptions = { space, mode: "authed", reads };
  const ctxFor = (c: EpCaller, replyFits?: (data: unknown, ceiling: number) => boolean) => ({
    subject: parseEpSubject(epRequestSubject(space, { route: { mode: "one" }, endpoint: "registry", command: "endpoints", caller: c, nonce: randomBytes(16).toString("base64url") })) as ParsedEpRequest,
    ...(replyFits ? { replyFits } : {}),
  });
  const refusal = async (run: () => Promise<unknown>) => {
    try { await run(); return undefined; } catch (e) { return e; }
  };

  const page = await answerEndpoints(authed, ctxFor(issued), {});
  const alpha = page.rows.find((r) => r.endpoint === "alpha.example");
  suite.check("the listing names only the endpoints the recorded ceiling covers a command of",
    page.source === "recorded-ceiling" && page.rows.map((r) => r.endpoint).join() === "alpha.example" && page.next === undefined, page.rows.map((r) => r.endpoint));
  suite.check("a covered endpoint lists only its covered commands",
    alpha?.commands.map((c) => c.name).join() === "read" && alpha.commands[0]!.forms.some((f) => f.rail === "ep.v1" && f.route === "one"), alpha?.commands);
  const artifactsOf = (id: string) => alpha?.instances.find((i) => i.instanceId === id)?.artifacts;
  suite.check("an endpoint lists every registered instance with its recorded state",
    alpha?.instances.map((i) => i.instanceId).sort().join() === [A1, A2, A3].sort().join() && alpha.instances.every((i) => i.state === "ready"), alpha?.instances);
  suite.check("an instance whose declarations are not in the contract store is listed as missing beside verified ones",
    artifactsOf(A1) === "verified" && artifactsOf(A2) === "verified" && artifactsOf(A3) === "missing", alpha?.instances);
  suite.check("an endpoint whose declarations cannot be read is left out, even where the ceiling names its command",
    !page.rows.some((r) => r.endpoint === "gamma.example"), page.rows.map((r) => r.endpoint));

  {
    const wide = { ...caller, actor: newIdentity().id, uid: mintLifecycleUid() };
    const wideGeneration = mintGeneration(exp);
    const wideIssued = { ...wide, generation: wideGeneration } as EpCaller;
    const wideRows = (["read", "write", "ping"] as const).flatMap((c) => epRequestGrantRows(space, { endpoint: c === "ping" ? "beta.example" : "alpha.example", command: c }, wideIssued));
    await store.release(await store.stage({ version: 1, ref: { space, ...wide, generation: wideGeneration }, sources: [], permissions: importNativeSubjectPermissions({ pub: { allow: wideRows } }), expiresAt: exp }), async () => {});
    const widePage = await answerEndpoints(authed, ctxFor(wideIssued), {});
    const write = widePage.rows.find((r) => r.endpoint === "alpha.example")?.commands.find((c) => c.name === "write");
    const read = widePage.rows.find((r) => r.endpoint === "alpha.example")?.commands.find((c) => c.name === "read");
    suite.check("a command only some instances declare names those instances",
      write?.instances?.join() === A1 && read?.instances?.slice().sort().join() === [A1, A2].sort().join(), { write, read });
    suite.check("a deregistered instance is not listed", !widePage.rows.some((r) => r.endpoint === "delta.example"), widePage.rows.map((r) => r.endpoint));
    const first = await answerEndpoints(authed, ctxFor(wideIssued), { limit: 1 });
    const second = await answerEndpoints(authed, ctxFor(wideIssued), { limit: 1, after: first.next });
    suite.check("pages follow endpoint name order and end without a cursor",
      first.rows[0]?.endpoint === "alpha.example" && first.next === "alpha.example" && second.rows[0]?.endpoint === "beta.example" && second.next === "beta.example"
        && (await answerEndpoints(authed, ctxFor(wideIssued), { limit: 1, after: second.next })).rows.length === 0, [first.next, second.next]);
    const tight = await answerEndpoints(authed, ctxFor(wideIssued, (data) => (data as { rows: unknown[] }).rows.length <= 1), {});
    suite.check("a page that would not fit in one reply is cut short with a cursor", tight.rows.length === 1 && tight.next === "alpha.example", tight.next);
  }

  const legacy = await refusal(() => answerEndpoints(authed, ctxFor(caller), {}));
  suite.check("a legacy-rail request on an authed mesh is refused as unbound caller authority",
    legacy instanceof EpEnvelopeError && legacy.code === "permission-denied" && legacy.details?.some((d) => (d as { kind?: string }).kind === EP_UNBOUND_CALLER_AUTHORITY) === true, legacy);
  const unknown = await refusal(() => answerEndpoints(authed, ctxFor({ ...caller, generation: mintGeneration(exp) } as EpCaller), {}));
  suite.check("a generation with no recorded evidence is an error, never an empty listing", unknown instanceof Error, unknown);

  const open = await answerEndpoints({ space, mode: "open", reads }, ctxFor(caller), {});
  suite.check("an open mesh lists every registered endpoint as callable",
    open.source === "no-permission-system" && open.rows.map((r) => r.endpoint).join() === "alpha.example,beta.example,gamma.example"
      && open.rows.find((r) => r.endpoint === "gamma.example")?.instances[0]?.artifacts === "missing", open.rows.map((r) => r.endpoint));
} finally {
  if (nc) await nc.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
suite.finish();
