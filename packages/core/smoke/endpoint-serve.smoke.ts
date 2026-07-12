/**
 * v0.4 service-registry + serve/describe smoke (SPEC §13.5/§13.7/§13.9) against a real broker:
 * registration CAS + registrationRevision semantics, name authority, epoch-fenced status
 * writes, the scatter expected-set freeze, queue-grouped class serving vs scatter vs instance
 * rails, contract-digest-bound invoke, cast silence, and authorization-scoped describe.
 *
 * Run: pnpm smoke:ep-serve   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  isReachable, EpEnvelopeError,
  openRecordsBucket,
  parseServiceSpec, parseServiceStatus, assertServiceNameAuthority,
  registerServiceInstance, writeServiceStatus, freezeExpectedSet,
  SERVICE_READY, SERVICE_EXITED,
  serveEndpoint, describeCommandDef,
  epRequestSubject, epCallerReplyFilter, parseEpSubject,
  type ServiceSpec, type ServiceNameAuthority, type EpCaller, type EndpointReply,
  type EpServeIdentity, type DescribeAnswer,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const throws = (n: string, fn: () => unknown, code?: string) => {
  try { fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code}`);
  }
};
const rejects = async (n: string, fn: () => Promise<unknown>, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "epserve";
const D_IN = `sha256:${"1".repeat(64)}`;
const D_OUT = `sha256:${"2".repeat(64)}`;
const D_OTHER = `sha256:${"f".repeat(64)}`;
const IID_A = "a".repeat(26);
const IID_B = "b".repeat(26);
const UID = "c".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };

const authority: ServiceNameAuthority = {
  isOperatorOwner: (o) => o === "u_op",
  domainOwnerOf: (name) => (name === "com.acme.builds" ? "u_acme" : undefined),
};

// ── name authority (broker-free) ──
c("a core name under the operator owner admits",
  (assertServiceNameAuthority("manager", "u_op", authority), true));
throws("a core name under a non-operator owner refuses",
  () => assertServiceNameAuthority("manager", "u_abc", authority), "permission-denied");
c("a reverse-DNS name under its registered owner admits",
  (assertServiceNameAuthority("com.acme.builds", "u_acme", authority), true));
throws("a reverse-DNS name under a foreign owner refuses",
  () => assertServiceNameAuthority("com.acme.builds", "u_abc", authority), "permission-denied");
throws("an UNREGISTERED reverse-DNS name fails closed (never first-come adoption)",
  () => assertServiceNameAuthority("com.evil.squat", "u_abc", authority), "permission-denied");

// ── descriptor validators (broker-free) ──
const spec: ServiceSpec = {
  endpoint: "manager", owner: "u_op", clusterDigests: [D_IN], protocol: { v: 1 },
};
c("a service spec validates", parseServiceSpec(spec, { endpoint: "manager" }).owner === "u_op");
throws("a spec whose endpoint disagrees with the record key refuses",
  () => parseServiceSpec(spec, { endpoint: "other" }), "internal");
throws("a spec with empty clusterDigests refuses",
  () => parseServiceSpec({ ...spec, clusterDigests: [] }, { endpoint: "manager" }), "internal");
throws("a spec with a non-1 protocol version refuses",
  () => parseServiceSpec({ ...spec, protocol: { v: 2 } }, { endpoint: "manager" }), "internal");
c("a service status validates",
  parseServiceStatus({ epoch: 3, state: SERVICE_READY, observedSpecRevision: 1 }).epoch === 3);
throws("a status with a malformed state token refuses",
  () => parseServiceStatus({ epoch: 3, state: "Ready!", observedSpecRevision: 1 }), "internal");

// ── serve-table construction rules (broker-free; nc unused before subscribe) ──
throws("a non-describe command without pinned contract digests refuses at construction",
  () => serveEndpoint(null as never, SPACE, { endpoint: "manager", instanceId: IID_A, epoch: 1 }, [
    { command: "stop", handler: () => undefined },
  ]));
throws("a describe def pinning a contract refuses at construction",
  () => serveEndpoint(null as never, SPACE, { endpoint: "manager", instanceId: IID_A, epoch: 1 }, [
    { command: "describe", contract: { inputDigest: D_IN, outputDigest: D_OUT }, handler: () => undefined },
  ]));

// ── live broker ──
const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-epserve-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });

  // ---- registry over the records KV ----
  const kv = await openRecordsBucket(nc, SPACE, { create: true });

  const regA = await registerServiceInstance(kv, { spec, instanceId: IID_A, authority });
  c("registration writes the spec and returns its store revision", regA.registrationRevision >= 1);
  const regA2 = await registerServiceInstance(kv, { spec, instanceId: IID_A, authority });
  c("re-registration ADVANCES registrationRevision (scatter churn detection, SPEC 13.5)",
    regA2.registrationRevision > regA.registrationRevision);
  await rejects("a registration under a foreign owner never reaches the store",
    () => registerServiceInstance(kv, { spec: { ...spec, owner: "u_abc" }, instanceId: IID_A, authority }), "permission-denied");

  await writeServiceStatus(kv, { endpoint: "manager", instanceId: IID_A, epoch: 2, status: { epoch: 2, state: SERVICE_READY, observedSpecRevision: regA2.registrationRevision } });
  await rejects("a status write from a SUPERSEDED epoch refuses (a stale incarnation cannot commit)",
    () => writeServiceStatus(kv, { endpoint: "manager", instanceId: IID_A, epoch: 1, status: { epoch: 1, state: SERVICE_READY, observedSpecRevision: regA2.registrationRevision } }), "expired");
  await rejects("a status payload epoch disagreeing with the writer-authenticated epoch refuses",
    () => writeServiceStatus(kv, { endpoint: "manager", instanceId: IID_A, epoch: 3, status: { epoch: 2, state: SERVICE_READY, observedSpecRevision: regA2.registrationRevision } }), "internal");

  const regB = await registerServiceInstance(kv, { spec, instanceId: IID_B, authority });
  await writeServiceStatus(kv, { endpoint: "manager", instanceId: IID_B, epoch: 1, status: { epoch: 1, state: SERVICE_READY, observedSpecRevision: regB.registrationRevision } });

  const frozen = await freezeExpectedSet(kv, "manager");
  c("the frozen expected set carries (instanceId, registrationRevision, epoch) per live instance",
    frozen.length === 2
    && frozen.some((f) => f.instanceId === IID_A && f.registrationRevision === regA2.registrationRevision && f.epoch === 2)
    && frozen.some((f) => f.instanceId === IID_B && f.registrationRevision === regB.registrationRevision && f.epoch === 1));

  await writeServiceStatus(kv, { endpoint: "manager", instanceId: IID_B, epoch: 1, status: { epoch: 1, state: SERVICE_EXITED, observedSpecRevision: regB.registrationRevision } });
  c("an exited instance leaves the frozen set", (await freezeExpectedSet(kv, "manager")).every((f) => f.instanceId !== IID_B));
  await rejects("an empty registry is failed-precondition, never an empty scatter success",
    () => freezeExpectedSet(kv, "ghost"), "failed-precondition");

  // ---- serve: two instances of one class ----
  const idA: EpServeIdentity = { endpoint: "manager", instanceId: IID_A, epoch: 2 };
  const idB: EpServeIdentity = { endpoint: "manager", instanceId: IID_B, epoch: 1 };
  let castRuns = 0;
  const commandsFor = (which: string) => [
    {
      command: "status",
      contract: { inputDigest: D_IN, outputDigest: D_OUT },
      handler: () => ({ which }),
    },
    {
      command: "poke",
      contract: { inputDigest: D_IN, outputDigest: D_OUT },
      handler: () => { castRuns++; throw new Error("cast handlers may fail; nobody hears it"); },
    },
    describeCommandDef(
      {
        endpoint: "manager", owner: "u_op", protocol: { v: 1 },
        clusters: [{ digest: D_IN, commands: ["status", "poke", "stop"] }],
      },
      { view: (who) => (who.owner === "u_abc" ? { commands: ["status"] } : undefined) },
    ),
  ];
  const srvA = serveEndpoint(nc, SPACE, idA, commandsFor("A"));
  const srvB = serveEndpoint(nc, SPACE, idB, commandsFor("B"));
  await nc.flush();

  // The caller's reply rail: exactly its own filter (§13.9).
  const replies: { subject: string; reply: EndpointReply }[] = [];
  const replySub = nc.subscribe(epCallerReplyFilter(SPACE, caller), {
    callback: (_e, m) => { replies.push({ subject: m.subject, reply: JSON.parse(new TextDecoder().decode(m.data)) as EndpointReply }); },
  });
  await nc.flush();

  let nonceN = 0;
  const nonce = () => `n${String(nonceN++).padStart(23, "0")}`;
  const req = (over: Record<string, unknown> = {}) => ({
    v: 1, id: "req-1", op: { endpoint: "manager", command: "status", inputDigest: D_IN, outputDigest: D_OUT },
    class: "ephemeral", replyExpected: true, deadlineMs: 2000, from: { id: "u_abc.worker", name: "w" }, ...over,
  });
  const send = async (subject: string, body: unknown) => {
    nc.publish(subject, new TextEncoder().encode(JSON.stringify(body)));
    await nc.flush();
    for (let i = 0; i < 40 && replies.length === 0; i++) await wait(50);
    return replies.shift();
  };

  // call on the one rail: queue-group anycast, exactly one instance answers
  const r1 = await send(epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager", command: "status", caller, nonce: nonce() }), req());
  await wait(200);
  c("a class call is answered EXACTLY once (queue-group anycast)",
    r1 !== undefined && r1.reply.ok === true && replies.length === 0,
    JSON.stringify(r1));
  const attr1 = parseEpSubject(r1!.subject);
  c("the reply subject attributes the responding instance + epoch (structural, never body)",
    attr1?.plane === "reply"
    && ((attr1.instanceId === IID_A && attr1.epoch === 2 && (r1!.reply.data as { which: string }).which === "A")
      || (attr1.instanceId === IID_B && attr1.epoch === 1 && (r1!.reply.data as { which: string }).which === "B")));

  // inst rail addresses ONE stable instance
  const r2 = await send(epRequestSubject(SPACE, { route: { mode: "inst", instanceId: IID_B }, endpoint: "manager", command: "status", caller, nonce: nonce() }), req());
  c("an instance call lands on exactly the addressed instance",
    r2 !== undefined && (r2.reply.data as { which: string }).which === "B"
    && (parseEpSubject(r2.subject) as { instanceId: string }).instanceId === IID_B);

  // all rail: every instance answers (gather semantics are D5's; here both replies arrive)
  nc.publish(epRequestSubject(SPACE, { route: { mode: "all" }, endpoint: "manager", command: "status", caller, nonce: nonce() }), new TextEncoder().encode(JSON.stringify(req())));
  await nc.flush();
  for (let i = 0; i < 40 && replies.length < 2; i++) await wait(50);
  c("a scatter request draws one reply per instance",
    replies.length === 2
    && new Set(replies.map((r) => (parseEpSubject(r.subject) as { instanceId: string }).instanceId)).size === 2);
  replies.length = 0;

  // digest binding
  const r3 = await send(epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager", command: "status", caller, nonce: nonce() }), req({ op: { endpoint: "manager", command: "status", inputDigest: D_OTHER, outputDigest: D_OUT } }));
  c("a pinned digest the member cannot honor is contract-mismatch, never coerced",
    r3 !== undefined && r3.reply.ok === false && r3.reply.error?.code === "contract-mismatch");

  // class discipline: a journal-declared call on a rail dies at the boundary (§13.4: a journal
  // submission is a cast observing its decision subtree, so journal+replyExpected:true is the
  // envelope's own bad-request; a WELL-FORMED journal cast is silent by §13.5 and the class
  // seam guards it without a reply to witness).
  const r4 = await send(epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager", command: "status", caller, nonce: nonce() }), req({ class: "journal" }));
  c("a journal-class call on a rail is refused at the boundary",
    r4 !== undefined && r4.reply.ok === false && r4.reply.error?.code === "bad-request");

  // body-subject agreement
  const r5 = await send(epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager", command: "status", caller, nonce: nonce() }), req({ op: { endpoint: "other", command: "status", inputDigest: D_IN, outputDigest: D_OUT } }));
  c("a body op disagreeing with the subject is op-mismatch",
    r5 !== undefined && r5.reply.error?.code === "op-mismatch");

  // a malformed body still answers the call boundary (the reply subject is nonce-scoped)
  const r6 = await send(epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager", command: "status", caller, nonce: nonce() }), { v: 1, id: "req-x" });
  c("a malformed call body draws a structured boundary error",
    r6 !== undefined && r6.reply.ok === false && typeof r6.reply.error?.code === "string");

  // cast: at-most-once, never replied to — even when the handler throws
  const castBefore = castRuns;
  nc.publish(epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager", command: "poke", caller, nonce: nonce() }), new TextEncoder().encode(JSON.stringify(req({ op: { endpoint: "manager", command: "poke", inputDigest: D_IN, outputDigest: D_OUT }, replyExpected: false, deadlineMs: undefined }))));
  await nc.flush();
  for (let i = 0; i < 20 && castRuns === castBefore; i++) await wait(50);
  await wait(300);
  c("a cast runs its handler and the responder never replies (even on handler failure)",
    castRuns === castBefore + 1 && replies.length === 0, `castRuns ${castRuns} replies ${replies.length}`);

  // describe: authorization-scoped answers off the broker-authenticated caller
  const dReq = req({ op: { endpoint: "manager", command: "describe" } });
  const r7 = await send(epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager", command: "describe", caller, nonce: nonce() }), dReq);
  const answer = r7?.reply.data as DescribeAnswer | undefined;
  c("describe answers scoped: the caller sees exactly its authorized command intersection",
    r7?.reply.ok === true && answer?.public === false
    && answer.descriptor.clusters.length === 1
    && JSON.stringify(answer.descriptor.clusters[0].commands) === JSON.stringify(["status"]));
  const r8 = await send(epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager", command: "describe", caller, nonce: nonce() }), req({ op: { endpoint: "manager", command: "describe", inputDigest: D_IN, outputDigest: D_OUT } }));
  c("a digest carried on describe is contract-mismatch (nothing to honor)",
    r8 !== undefined && r8.reply.error?.code === "contract-mismatch");

  // an answerless trusted view fails CLOSED
  await srvA.stop(); await srvB.stop();
  const srvClosed = serveEndpoint(nc, SPACE, idA, [describeCommandDef(
    { endpoint: "manager", owner: "u_op", protocol: { v: 1 }, clusters: [{ digest: D_IN, commands: ["status"] }] },
    { view: () => undefined },
  )]);
  await nc.flush();
  const r9 = await send(epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager", command: "describe", caller, nonce: nonce() }), dReq);
  c("describe with no fresh trusted view is unavailable (fail closed, never a weaker source)",
    r9 !== undefined && r9.reply.ok === false && r9.reply.error?.code === "unavailable");
  await srvClosed.stop();

  // a public descriptor consults no view and the answer says so
  const srvPub = serveEndpoint(nc, SPACE, idA, [describeCommandDef(
    { endpoint: "manager", owner: "u_op", protocol: { v: 1 }, clusters: [{ digest: D_IN, commands: ["status", "stop"] }] },
    { public: true },
  )]);
  await nc.flush();
  const r10 = await send(epRequestSubject(SPACE, { route: { mode: "one" }, endpoint: "manager", command: "describe", caller, nonce: nonce() }), dReq);
  const pub = r10?.reply.data as DescribeAnswer | undefined;
  c("a declared-public descriptor answers unscoped and SAYS it is public",
    pub?.public === true && pub.descriptor.clusters[0].commands.length === 2);
  await srvPub.stop();

  await replySub.drain();
  await nc.close();
} finally {
  broker.kill("SIGKILL");
  await new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nENDPOINT SERVE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
