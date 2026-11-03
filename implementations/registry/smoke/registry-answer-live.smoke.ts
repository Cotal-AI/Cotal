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

  /** An ephemeral command with no payload; `exact` makes it targeted in exact mode. */
  const command = (name: string, exact = false) => ({
    name, class: "ephemeral", capability: name, inputDigest: VOID_SCHEMA_DIGEST, outputDigest: VOID_SCHEMA_DIGEST, ...(exact ? { targeted: true, modes: ["exact"] } : { targeted: false }),
  });
  /** Publish a cluster and return its closure digest. `publish: false` leaves the artifacts out. */
  const cluster = async (urn: string, names: string[], publish = true, exact = false) => {
    const document = { urn, revision: 1, attributes: [], events: [], commands: names.map((n) => command(n, exact)) };
    const { manifest, closureDigest } = singleDocumentClosure(document);
    if (publish) for (const value of [document, manifest]) await publishContractArtifact(contracts, contractArtifactCanonicalBytes(value));
    return closureDigest;
  };
  const register = async (endpoint: string, instanceId: string, clusterDigest: string | string[]) => {
    const token = endpoint.split(".").join("_");
    const clusterDigests = typeof clusterDigest === "string" ? [clusterDigest] : clusterDigest;
    await records.put(`svc.${token}.${instanceId}.spec`, JSON.stringify({ endpoint, owner: DEV_OWNER, clusterDigests, protocol: { v: 1 } }));
    await records.put(`svc.${token}.${instanceId}.status`, JSON.stringify({ epoch: 1, state: "ready", observedSpecRevision: 1 }));
  };

  const [A1, A2, A3, B1, G1, D1, E1, T1] = Array.from({ length: 8 }, () => mintLifecycleUid());
  await register("alpha.example", A1, await cluster("ai.example.alpha", ["read", "write"]));
  await register("alpha.example", A2, await cluster("ai.example.alpha.ro", ["read"]));
  await register("alpha.example", A3, await cluster("ai.example.alpha.next", ["read"], false));
  await register("beta.example", B1, await cluster("ai.example.beta", ["ping"]));
  await register("gamma.example", G1, await cluster("ai.example.gamma", ["look"], false));
  await register("delta.example", D1, await cluster("ai.example.delta", ["gone"]));
  await records.delete(`svc.delta_example.${D1}.spec`);
  await register("epsilon.example", E1, await cluster("ai.example.epsilon", ["poke"]));
  await register("eta.example", T1, await cluster("ai.example.eta", ["set"], true, true));

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
  const logged: string[] = [];
  const authed: RegistryAnswerOptions = { space, mode: "authed", reads, log: (line) => logged.push(line) };
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

  {
    // Deny rows naming 64 instance ids and 64 nonces on epsilon's instance route put that form past
    // the projection limit. Only a ceiling that also admits a subject of the command names it. The
    // allowed rows include E1's instance route, so that form's witness is a subject the deny must refuse.
    const over = async (allowEpsilon: boolean, denyAll = false) => {
      const c = { ...caller, actor: newIdentity().id, uid: mintLifecycleUid() };
      const g = mintGeneration(exp);
      const ci = { ...c, generation: g } as EpCaller;
      const deny = Array.from({ length: 64 }, () => epRequestSubject(space, {
        route: { mode: "inst", instanceId: mintLifecycleUid() }, endpoint: "epsilon.example", command: "poke", caller: ci, nonce: randomBytes(16).toString("base64url"),
      }));
      // A trailing `>` after the command token on every route: each poke subject this caller can send.
      if (denyAll)
        for (const route of [{ mode: "one" }, { mode: "all" }, { mode: "inst", instanceId: E1 }] as const) {
          const tokens = epRequestSubject(space, { route, endpoint: "epsilon.example", command: "poke", caller: ci, nonce: randomBytes(16).toString("base64url") }).split(".");
          deny.push([...tokens.slice(0, tokens.indexOf("poke") + 1).map((t) => (t === E1 ? "*" : t)), ">"].join("."));
        }
      const allow = [
        ...epRequestGrantRows(space, { endpoint: "beta.example", command: "ping" }, ci),
        ...(allowEpsilon ? epRequestGrantRows(space, { endpoint: "epsilon.example", command: "poke", instanceId: E1 }, ci) : []),
      ];
      await store.release(await store.stage({ version: 1, ref: { space, ...c, generation: g }, sources: [], permissions: importNativeSubjectPermissions({ pub: { allow, deny } }), expiresAt: exp }), async () => {});
      return (await answerEndpoints(authed, ctxFor(ci), {})).rows.find((r) => r.endpoint === "epsilon.example");
    };
    const denied = await over(false);
    suite.check("a command past the projection limit that the ceiling admits no subject of is left out", denied === undefined, denied);
    const admitted = await over(true);
    suite.check("a command past the projection limit that the ceiling admits a subject of is named unprojected",
      admitted?.unprojected?.join() === "poke" && admitted.commands.length === 0, admitted);
    const wildDenied = await over(true, true);
    suite.check("a command past the projection limit whose every subject a trailing-wildcard deny refuses is left out", wildDenied === undefined, wildDenied);
  }

  {
    // Exact-target rows name 16 owners, actors and uids at the target positions eta's exact-mode
    // command uses: 17^3 classes if every pattern counted, past the 4096 limit.
    const exactRows = (endpoint: string, command: string, c: EpCaller, n: number) => Array.from({ length: n }, (_, i) => epRequestGrantRows(space, {
      endpoint, command, target: { mode: "exact", tOwner: `own${i}`, tActor: `act${i}`, tUid: mintLifecycleUid() },
    }, c)).flat();
    const etaFor = async (rows: (c: EpCaller) => string[]) => {
      const c = { ...caller, actor: newIdentity().id, uid: mintLifecycleUid() };
      const g = mintGeneration(exp);
      const ci = { ...c, generation: g } as EpCaller;
      await store.release(await store.stage({ version: 1, ref: { space, ...c, generation: g }, sources: [], permissions: importNativeSubjectPermissions({ pub: { allow: rows(ci) } }), expiresAt: exp }), async () => {});
      const answer = await answerEndpoints(authed, ctxFor(ci), {});
      return { next: answer.next, eta: answer.rows.find((r) => r.endpoint === "eta.example") };
    };
    const unrelated = await etaFor((c) => [...epRequestGrantRows(space, { endpoint: "alpha.example", command: "read" }, c), ...exactRows("beta.example", "ping", c, 16)]);
    suite.check("rows on another endpoint never make an endpoint the caller holds nothing on appear, even past the projection limit",
      unrelated.eta === undefined && unrelated.next === undefined, unrelated);
    const held = await etaFor((c) => [...exactRows("beta.example", "ping", c, 16), ...exactRows("eta.example", "set", c, 1)]);
    suite.check("literals on another endpoint do not push a held command past the projection limit",
      held.eta?.unprojected === undefined && held.eta?.commands.map((c) => c.name).join() === "set"
        && held.eta.commands[0]!.forms.every((f) => f.literals.targetActor?.join() === "act0"), held.eta);
    const many = await etaFor((c) => exactRows("eta.example", "set", c, 16));
    suite.check("a held command past the projection limit is named unprojected", many.eta?.unprojected?.join() === "set" && many.eta.commands.length === 0, many.eta);
  }

  {
    // Records written past registration, which refuses both shapes: removed again after, so the
    // open-mesh listing below is unchanged.
    const issue = async (rows: (c: EpCaller) => string[]) => {
      const c = { ...caller, actor: newIdentity().id, uid: mintLifecycleUid() };
      const g = mintGeneration(exp);
      const ci = { ...c, generation: g } as EpCaller;
      await store.release(await store.stage({ version: 1, ref: { space, ...c, generation: g }, sources: [], permissions: importNativeSubjectPermissions({ pub: { allow: rows(ci) } }), expiresAt: exp }), async () => {});
      return ci;
    };
    // One dup instance names `read` in two of its clusters; the other two declare only `write`.
    const [U1, U2, U3] = [mintLifecycleUid(), mintLifecycleUid(), mintLifecycleUid()].sort();
    await register("dup.example", U1, [await cluster("ai.example.dup", ["read"]), await cluster("ai.example.dup.more", ["read"])]);
    const writeOnly = await cluster("ai.example.dup.w", ["write"]);
    await register("dup.example", U2, writeOnly);
    await register("dup.example", U3, writeOnly);
    const dupCaller = await issue((c) => ["read", "write"].flatMap((command) => epRequestGrantRows(space, { endpoint: "dup.example", command }, c)));
    const dup = (await answerEndpoints(authed, ctxFor(dupCaller), {})).rows.find((r) => r.endpoint === "dup.example");
    suite.check("an instance whose clusters declare one command twice is listed invalid and declares nothing",
      dup?.instances.find((i) => i.instanceId === U1)?.artifacts === "invalid" && dup.commands.map((c) => c.name).join() === "write"
        && dup.commands[0]!.instances?.join() === [U2, U3].join(), dup);
    // Mix declares `set` untargeted on M1 and in exact mode on M2; 16 exact rows put M2's form past the limit.
    const [M1, M2] = [mintLifecycleUid(), mintLifecycleUid()].sort();
    await register("mix.example", M1, await cluster("ai.example.mix", ["set"]));
    await register("mix.example", M2, await cluster("ai.example.mix.exact", ["set"], true, true));
    const mixCaller = await issue((c) => [
      ...epRequestGrantRows(space, { endpoint: "mix.example", command: "set" }, c),
      ...Array.from({ length: 16 }, (_, i) => epRequestGrantRows(space, {
        endpoint: "mix.example", command: "set", target: { mode: "exact", tOwner: `own${i}`, tActor: `act${i}`, tUid: mintLifecycleUid() },
      }, c)).flat(),
    ]);
    const mix = (await answerEndpoints(authed, ctxFor(mixCaller), {})).rows.find((r) => r.endpoint === "mix.example");
    suite.check("a command one of whose declarations is past the projection limit is named only unprojected, with no forms",
      mix?.unprojected?.join() === "set" && mix.commands.length === 0, mix);
    for (const [token, ids] of [["dup_example", [U1, U2, U3]], ["mix_example", [M1, M2]]] as const)
      for (const id of ids) await records.delete(`svc.${token}.${id}.spec`);
  }

  const legacy = await refusal(() => answerEndpoints(authed, ctxFor(caller), {}));
  suite.check("a legacy-rail request on an authed mesh is refused as unbound caller authority",
    legacy instanceof EpEnvelopeError && legacy.code === "permission-denied" && legacy.details?.some((d) => (d as { kind?: string }).kind === EP_UNBOUND_CALLER_AUTHORITY) === true, legacy);
  const unrecorded = mintGeneration(exp);
  const unknown = await refusal(() => answerEndpoints(authed, ctxFor({ ...caller, generation: unrecorded } as EpCaller), {}));
  suite.check("a generation with no recorded evidence is an error, never an empty listing", unknown instanceof Error, unknown);
  suite.check("a ceiling that cannot be read is refused with a message that names no generation or key",
    unknown instanceof EpEnvelopeError && unknown.code === "permission-denied" && !unknown.message.includes(unrecorded) && !unknown.message.includes(caller.actor)
      && logged.some((line) => line.includes(unrecorded)),
    { error: unknown instanceof Error ? unknown.message : unknown, logged });

  {
    // A spec row that does not parse fails the read; the caller's error names no endpoint or key.
    const Z1 = mintLifecycleUid();
    await records.put(`svc.zeta_example.${Z1}.spec`, JSON.stringify({ endpoint: "zeta.example" }));
    const failed = await refusal(() => answerEndpoints(authed, ctxFor(issued), {}));
    await records.delete(`svc.zeta_example.${Z1}.spec`);
    suite.check("a records read that fails is refused with a message that names no endpoint or key",
      failed instanceof EpEnvelopeError && failed.code === "unavailable" && !/zeta|svc\.|_example/.test(failed.message)
        && logged.some((line) => line.includes("service record does not validate")),
      { error: failed instanceof Error ? `${(failed as EpEnvelopeError).code}: ${failed.message}` : failed, logged });
  }

  const open = await answerEndpoints({ space, mode: "open", reads, log: (line) => logged.push(line) }, ctxFor(caller), {});
  suite.check("an open mesh lists every registered endpoint as callable",
    open.source === "no-permission-system" && open.rows.map((r) => r.endpoint).join() === "alpha.example,beta.example,epsilon.example,eta.example,gamma.example"
      && open.rows.find((r) => r.endpoint === "gamma.example")?.instances[0]?.artifacts === "missing", open.rows.map((r) => r.endpoint));
} finally {
  if (nc) await nc.close();
  await killAndAwaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
suite.finish();
