/**
 * THE SPLIT-RETRY GUARD READS ITS ALLOWLIST PER ENDPOINT (SPEC §13.2).
 *
 * `invokeService`'s describe-bound currency check is a POST-REPLY check — `endpoint-verbs.ts`:
 * "after the reply lands, the answering incarnation's epoch is checked". When a DIFFERENT live
 * instance wins the class queue and replies, the command has ALREADY EXECUTED by the time the
 * refusal is raised, so re-invoking runs it a second time. The guard withholds that retry for
 * everything `isRepeatSafeCommand(endpoint, command)` does not vouch for.
 *
 * That predicate is keyed on the PAIR, and this suite exists because `invokeService` is otherwise
 * endpoint-agnostic: it is the one place a `list` served by somebody else's endpoint could inherit
 * the delivery endpoint's safety judgement for free, purely because the names match.
 *
 * THE MEASUREMENT IS A DISCRIMINATING PAIR, and it is the reason this fixture serves its own
 * endpoints rather than driving the manager. TWO endpoints, ONE command name, ONE forced split:
 *
 *   - `list` on an endpoint NAMED `delivery`, where the table lists it → RETRIED, executes TWICE;
 *   - `list` on an endpoint the table has never heard of → SURFACES, executes ONCE.
 *
 * Same name, same contracts, same handler body, same instant, same split. The only difference
 * between the two outcomes is the endpoint the command was addressed to, which is exactly the
 * claim. A guard that consulted only the command name would make these two identical, and a suite
 * that drove one endpoint could not tell the difference. `append` is then run against a DIFFERENT
 * listed endpoint to show the pairing is not merely per-endpoint either: being on the table does
 * not launder an endpoint's unlisted commands.
 *
 * WHY THE COUNT IS TAKEN AT THE HANDLER. It cannot be taken on the wire: `MintOpts.endpointServe`
 * mints only queue-qualified class subscribes — "no plain class-rail subscribe exists on any
 * credential" — and a queue-qualified observer would COMPETE for requests rather than watch them.
 * Counting the effect is also the stronger claim: not that a request was published twice, but that
 * the write ran twice.
 *
 * ABSENCE IS NEVER THE EVIDENCE. Every claim below that rests on something NOT happening is
 * preceded by proof that the request reached a responder at all: the priming cell asserts the
 * ledger GREW, attributed to the instance that served it. A command that never leaves the caller
 * — a schema refusal, a bad subject — also leaves the ledger untouched, and without the positive
 * control that is indistinguishable from the guard holding. A sibling suite shipped green twice on
 * exactly that mistake, its whole sweep vacuous because `{}` failed `required` client-side and no
 * command was ever published. So every invoke here carries schema-valid arguments.
 *
 * THE SPLIT IS NOT SIMULATED. Instance A serves alone while the resolve cache is primed, then the
 * replacement comes up and A retires — a rolling replacement, which is what a restart or supersede
 * looks like from the caller's side. `endpoint-invoke.ts` calls this an "ordinary split" in its own
 * refusal text; the fixture removes the coin toss, not the mechanism.
 *
 * Run: pnpm smoke:invoke-retry-duplicate   (needs nats-server on PATH; part of smoke:ci)
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, CotalEndpoint, openRecordsBucket, registerServiceInstance, authorizeServeGrant,
  createEndpointStreams, serveEndpoint, compileContract, contractDigest, contractStoreContext,
  publishContractArtifact, contractArtifactCanonicalBytes, mintLifecycleUid,
  EpEnvelopeError, respondedButUnbound, isRepeatSafeCommand,
  BASELINE_DELIVERY_ENDPOINT, BASELINE_LIFECYCLE_ENDPOINT,
  type ServiceSpec, type ServiceNameAuthority, type EpCommandDef, type EpIssuanceBarrier,
  type EpAttributedReply,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "invdup";
const OWNER = "u_op";

// The borrowed name is read from the constant the table is keyed by, so renaming the baseline
// endpoint breaks this suite loudly instead of leaving it grading a name nobody uses.
const BORROWED = BASELINE_DELIVERY_ENDPOINT; // "delivery" — the table lists `list` here
const UNKNOWN = "ledger";                    // an endpoint the table has never heard of
const SHARED = "list";                       // ONE command name, served identically by both
const UNLISTED = "append";                   // never listed anywhere, served by every endpoint here
// A SECOND listed endpoint, so the unlisted-command cell gets a clean split of its own: reusing
// `delivery` would put a third instance behind a name that already has a live B from the pair above,
// and the measurement would be staged by the previous one rather than by the fixture.
const LISTED_OTHER = BASELINE_LIFECYCLE_ENDPOINT; // "manager" — lists status/ps/inspect, not append

// The premises this suite is built on. If any stops holding, the cells below would still pass
// while measuring nothing, so they are asserted rather than assumed.
assert.ok(isRepeatSafeCommand(BORROWED, SHARED),
  `${SHARED} must be repeat-safe on ${BORROWED} or the retried side grades nothing`);
assert.ok(!isRepeatSafeCommand(UNKNOWN, SHARED),
  `${SHARED} must NOT be repeat-safe on ${UNKNOWN} or the surfaced side grades nothing`);
assert.ok(!isRepeatSafeCommand(LISTED_OTHER, UNLISTED),
  `${UNLISTED} must NOT be repeat-safe on ${LISTED_OTHER} or the pairing cell grades nothing`);
assert.ok(isRepeatSafeCommand(LISTED_OTHER, "status"),
  `${LISTED_OTHER} must be a LISTED endpoint or the pairing cell proves nothing about laundering`);

// A `CotalEndpoint` reads connection settings from the ambient environment, and this fixture stops
// serving instances. Inheriting a real mesh's `COTAL_*` vars would aim that at someone else's space.
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
for (const [k, v] of Object.entries(process.env))
  if (typeof v === "string" && v.includes("broker.cotal.ai")) throw new Error(`refusing to run: ${k} points at a live broker`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

// ── the §13.7 contracts, identical for both endpoints ──
const IN_SCHEMA = { type: "object", properties: { tag: { type: "string" } }, required: ["tag"], additionalProperties: false };
const OUT_SCHEMA = { type: "object", properties: { which: { type: "string" }, runs: { type: "number" } }, required: ["which", "runs"], additionalProperties: false };
const inC = compileContract({ root: IN_SCHEMA });
const outC = compileContract({ root: OUT_SCHEMA });
const cmdDecl = (name: string) => ({
  name, class: "ephemeral", targeted: false, capability: "ledger.write",
  inputDigest: inC.closureDigest, outputDigest: outC.closureDigest,
});
const docFor = (urn: string) => ({
  urn, revision: 1, attributes: [], events: [],
  commands: [SHARED, UNLISTED].map(cmdDecl),
});

// ── the LEDGER both endpoints append to: the whole measurement ──
const ledger: Array<{ endpoint: string; which: string; command: string; tag: string }> = [];
const since = (n: number) => ledger.slice(n);

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-invdup-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
process.on("exit", () => { try { broker.kill("SIGKILL"); } catch { /* already gone */ } rmSync(sd, { recursive: true, force: true }); });

const callers: CotalEndpoint[] = [];
const servers: Array<{ stop: () => Promise<void> }> = [];

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("fixture broker did not come up — refusing to report on a server that never started");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });

  await createEndpointStreams(await jetstreamManager(nc), new Kvm(nc), SPACE);
  const storeCtx = await contractStoreContext(nc, SPACE);
  const kv = await openRecordsBucket(nc, SPACE, { create: true });

  for (const value of [IN_SCHEMA, { v: 1, root: contractDigest(IN_SCHEMA), members: [] },
                       OUT_SCHEMA, { v: 1, root: contractDigest(OUT_SCHEMA), members: [] }])
    await publishContractArtifact(storeCtx, contractArtifactCanonicalBytes(value));

  // A faithful freeze→(spec write)→reopen issuance barrier. The fence internals are proven in
  // endpoint-serve-auth.smoke.ts; here it only has to be honest about state transitions.
  const gates = new Map<string, { state: "open" | "frozen"; generation: number; processEpoch: number; registrationRevision: number; nameAuthorityRevision: number; revision: number }>();
  const barrierFor = (endpoint: string, instanceId: string): EpIssuanceBarrier => {
    const key = `${endpoint}/${instanceId}`;
    if (!gates.has(key)) gates.set(key, { state: "open", generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0, revision: 1 });
    const g = gates.get(key)!;
    return {
      observe: () => ({ space: SPACE, endpoint, lifecycleUid: instanceId, principal: `${OWNER}.svc`, ...g }),
      freeze: (rev) => { if (g.state !== "open" || g.revision !== rev) return null; g.state = "frozen"; g.revision++; return g.revision; },
      enumerate: () => [],
      revoke: () => {},
      evict: () => true,
      reopen: (token, succ) => {
        if (g.state !== "frozen" || g.revision !== token) return false;
        g.state = "open"; g.generation = succ.generation; g.processEpoch = succ.processEpoch;
        g.registrationRevision = succ.registrationRevision; g.nameAuthorityRevision = succ.nameAuthorityRevision; g.revision++;
        return true;
      },
    };
  };

  /** Stand up one instance of one endpoint. ONE handler body behind every (endpoint, command)
   *  pair, so any divergence in outcome is the classifier and nothing else. */
  const serveOne = async (endpoint: string, instanceId: string, which: string) => {
    const doc = docFor(`ai.cotal.invdup.${endpoint}`);
    const root = contractDigest(doc);
    const manifest = { v: 1 as const, root, members: [] as string[] };
    const closure = contractDigest(manifest);
    for (const value of [doc, manifest]) await publishContractArtifact(storeCtx, contractArtifactCanonicalBytes(value));
    const local = new Map<string, unknown>([[root, doc], [closure, manifest]]);
    const authority: ServiceNameAuthority = {
      authorize: (name, owner) => ({ authorized: name === endpoint && owner === OWNER, revision: 0 }),
    };
    const spec: ServiceSpec = { endpoint, owner: OWNER, clusterDigests: [closure], protocol: { v: 1 } };
    await registerServiceInstance(kv, {
      space: SPACE, spec, instanceId, registrant: { owner: OWNER }, authority,
      barrier: barrierFor(endpoint, instanceId), readClusterArtifact: (d) => local.get(d),
    });
    const grant = await authorizeServeGrant(kv, {
      space: SPACE, endpoint, instanceId, epoch: gates.get(`${endpoint}/${instanceId}`)!.processEpoch,
      holder: { owner: OWNER }, authority, readClusterArtifact: (d) => local.get(d),
      readProcessEpoch: async () => gates.get(`${endpoint}/${instanceId}`)!.processEpoch,
    });
    const defs: EpCommandDef[] = [SHARED, UNLISTED].map((command) => ({
      command,
      contract: { input: inC, output: outC },
      handler: (ctx) => {
        ledger.push({ endpoint, which, command, tag: String((ctx.request.args as { tag?: unknown } | undefined)?.tag ?? "") });
        return { which, runs: ledger.length };
      },
    }));
    const srv = await serveEndpoint(nc, SPACE, grant, defs, { public: true });
    servers.push(srv);
    return srv;
  };

  // A caller invokes and nothing else, so it binds no lifecycle durables and publishes no presence;
  // `lifecycleUid` is still required, because `invokeService` pins the caller triple into every
  // request subject. One caller per measurement: a refusal's effect on the resolve cache is exactly
  // what the guard varies, so sharing a caller would stage one measurement with another's outcome.
  const newCaller = async (name: string) => {
    const e = new CotalEndpoint({
      space: SPACE, servers: `nats://127.0.0.1:${PORT}`, lifecycleUid: mintLifecycleUid(),
      consume: false, registerPresence: false, card: { name, role: "agent" },
    });
    await e.start();
    callers.push(e);
    return e;
  };

  /**
   * Prime a caller against instance A of `endpoint`, then force the split and invoke `command`.
   * Returns what the caller saw and how many times the effect actually ran.
   *
   * The priming invoke is the POSITIVE CONTROL for everything after it: it proves this caller can
   * reach this endpoint and produce a ledger entry, so a later absence means the guard held rather
   * than the request never leaving.
   */
  const splitAndInvoke = async (endpoint: string, command: string, label: string) => {
    const iidA = `${label}a`.padEnd(26, "a").slice(0, 26);
    const iidB = `${label}b`.padEnd(26, "b").slice(0, 26);
    const srvA = await serveOne(endpoint, iidA, "A");
    const caller = await newCaller(`caller-${label}`);

    const beforePrime = ledger.length;
    await caller.invokeService(endpoint, command, { tag: `prime-${label}` });
    const primed = since(beforePrime);
    check(`[${label}] POSITIVE CONTROL: priming ${endpoint}/${command} reached A and ran exactly once`,
      primed.length === 1 && primed[0]?.which === "A" && primed[0]?.endpoint === endpoint, { primed });

    // Bring the replacement up, then retire EXACTLY the instance the cache describes.
    await serveOne(endpoint, iidB, "B");
    await srvA.stop();
    await wait(300);

    const before = ledger.length;
    let err: unknown;
    let reply: EpAttributedReply | undefined;
    try { reply = await caller.invokeService(endpoint, command, { tag: label }); }
    catch (e) { err = e; }
    return { runs: ledger.length - before, tail: since(before), err, reply };
  };

  // ── the discriminating pair: ONE command name, TWO endpoints, ONE split ──
  const borrowed = await splitAndInvoke(BORROWED, SHARED, "borrowed");
  const unknown = await splitAndInvoke(UNKNOWN, SHARED, "unknown");

  check(`${SHARED} on "${BORROWED}" — where the table lists it — is RETRIED and executes TWICE`,
    borrowed.runs === 2 && borrowed.err === undefined && borrowed.reply?.reply.ok === true,
    { borrowed: { runs: borrowed.runs, tail: borrowed.tail, err: borrowed.err === undefined ? null : String(borrowed.err) } });

  check(`the SAME command name on "${UNKNOWN}" SURFACES instead — an endpoint the table never listed`,
    unknown.err instanceof EpEnvelopeError && unknown.err.code === "failed-precondition",
    { unknown: { runs: unknown.runs, tail: unknown.tail, err: unknown.err === undefined ? null : String(unknown.err) } });
  check(`...and it executed EXACTLY ONCE — the responder ran it, the guard did not run it again`,
    unknown.runs === 1 && unknown.tail[0]?.which === "B",
    { runs: unknown.runs, tail: unknown.tail });
  check("...carrying the unbound-responder marker the guard keys on",
    unknown.err instanceof EpEnvelopeError && respondedButUnbound(unknown.err), { err: String(unknown.err) });

  check("both sides met the SAME split — every execution after retirement landed on B",
    [...borrowed.tail, ...unknown.tail].every((e) => e.which === "B"),
    { borrowed: borrowed.tail, unknown: unknown.tail });

  // ── the pairing is not merely per-endpoint: a listed endpoint does not launder its own commands ──
  const unlisted = await splitAndInvoke(LISTED_OTHER, UNLISTED, "unlisted");
  check(`an UNLISTED command on a LISTED endpoint ("${LISTED_OTHER}/${UNLISTED}") still SURFACES`,
    unlisted.err instanceof EpEnvelopeError && unlisted.err.code === "failed-precondition" && unlisted.runs === 1,
    { runs: unlisted.runs, tail: unlisted.tail, err: unlisted.err === undefined ? null : String(unlisted.err) });

  // ── the exemption `describe` rests on: it cannot be given a handler, so it cannot be made to mutate ──
  // `describe` is repeat-safe on EVERY endpoint. That is only safe because no endpoint can serve its
  // own: `endpoint-cluster.ts` refuses a cluster command named `describe` at registration, and
  // `serveEndpoint` refuses a def named `describe` unconditionally, at the TOP of its defs loop —
  // before the grant, class and duplicate checks, so no ordering slips past it. The second fence is
  // the one that matters here and it is asserted rather than cited, because a source comment citing
  // two files rots silently if either stops throwing.
  let describeRefusal: unknown;
  try {
    await serveEndpoint(nc, SPACE, (await (async () => {
      const doc = docFor(`ai.cotal.invdup.fence`);
      const root = contractDigest(doc);
      const manifest = { v: 1 as const, root, members: [] as string[] };
      const closure = contractDigest(manifest);
      for (const value of [doc, manifest]) await publishContractArtifact(storeCtx, contractArtifactCanonicalBytes(value));
      const local = new Map<string, unknown>([[root, doc], [closure, manifest]]);
      const authority: ServiceNameAuthority = { authorize: (n, o) => ({ authorized: n === "fence" && o === OWNER, revision: 0 }) };
      const iid = "f".repeat(26);
      await registerServiceInstance(kv, {
        space: SPACE, spec: { endpoint: "fence", owner: OWNER, clusterDigests: [closure], protocol: { v: 1 } },
        instanceId: iid, registrant: { owner: OWNER }, authority,
        barrier: barrierFor("fence", iid), readClusterArtifact: (d) => local.get(d),
      });
      return authorizeServeGrant(kv, {
        space: SPACE, endpoint: "fence", instanceId: iid, epoch: gates.get(`fence/${iid}`)!.processEpoch,
        holder: { owner: OWNER }, authority, readClusterArtifact: (d) => local.get(d),
        readProcessEpoch: async () => gates.get(`fence/${iid}`)!.processEpoch,
      });
    })()), [{
      command: "describe",
      contract: { input: inC, output: outC },
      handler: () => { ledger.push({ endpoint: "fence", which: "X", command: "describe", tag: "mutating" }); return { which: "X", runs: ledger.length }; },
    }] as EpCommandDef[], { public: true });
  } catch (e) { describeRefusal = e; }

  check("a mutating `describe` CANNOT be served — serveEndpoint refuses the def outright",
    describeRefusal instanceof Error && /describe is reserved/.test((describeRefusal as Error).message),
    { describeRefusal: describeRefusal === undefined ? null : String(describeRefusal) });
  check("...so the universal describe exemption cannot be turned into a mutating command",
    !ledger.some((e) => e.command === "describe"), { ledger: ledger.filter((e) => e.command === "describe") });
} finally {
  for (const c of callers) await c.stop().catch(() => { /* already down */ });
  for (const s of servers) await s.stop().catch(() => { /* already down */ });
}

console.log(`\n${fail === 0 ? "INVOKE-RETRY-DUPLICATE SMOKE OK ✅" : "INVOKE-RETRY-DUPLICATE SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
assert.equal(fail, 0, `${fail} check(s) failed`);
process.exit(fail === 0 ? 0 : 1);
