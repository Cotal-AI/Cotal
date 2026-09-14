/**
 * #1616 item 4 — TARGET-BOUND PLACEMENT GRANTS, graded on an ENFORCING broker.
 *
 * `runMediatorGrants` mints three extra rows when a program names an explicit placement target:
 * `describe`, `resolve-cwd` and `spawn` on that ONE instance rail and nothing else. A test made
 * only of refusals passes trivially when the grant path is never consulted, so this suite proves
 * BOTH directions against a live nats-server running plain user authorization, where each
 * credential holds EXACTLY the rows its builder emits:
 *
 *   POSITIVE  with exactly those three rows, a placed spawn resolves, canonicalizes on the
 *             serving manager, and is accepted by it.
 *   NEGATIVE  with ONE of the three removed, the same placed spawn is refused by the BROKER, at
 *             the stage that needs the removed row, and the refusal names the rail it was denied.
 *
 * The caller side runs the two core entry points a placed spawn actually uses — `resolveService`
 * with an `instanceId`, then `invokeCommand` for `resolve-cwd` and `spawn` (mesh-handler.ts
 * `manager()` and `resolveCwd()`) — over the scoped connection. No subject is built by hand here;
 * if the production reach changed rails, the positive control would go red with it.
 *
 * Run: pnpm smoke:runtime-placement-grants   (needs nats-server on PATH)
 * Broker killed by exact PID; never pkill nats-server.
 */
import { spawn as spawnProc } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable,
  createEndpointStreams,
  createSpaceStreams,
  openRecordsBucket,
  compileContract,
  contractDigest,
  contractStoreContext,
  publishContractArtifact,
  contractArtifactCanonicalBytes,
  epAuthBucket,
  serveIssuanceGateKv,
  provisionEndpointGateOpen,
  endpointRegistrationBarrier,
  registerServiceInstance,
  authorizeServeGrant,
  serveEndpoint,
  resolveService,
  invokeCommand,
  epRequestGrantRows,
  EpEnvelopeError,
  type EpCommandDef,
  type EpServeContext,
} from "@cotal-ai/core";
// Read from core SOURCE, not the package dist: these are the builders under review, and the runtime
// smoke suite already imports them this way for the same reason.
import { runMediatorGrants, runDriverCaller, PLACEMENT_COMMANDS } from "../../../packages/core/src/run-driver-grants.js";
import { canonicalCwd } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "placegrants";
const EP = "manager";                       // BASELINE_LIFECYCLE_ENDPOINT: the endpoint the rows name
const MGR_IID = "m".repeat(26);
const RUN = "pg-run-1";
const TAKE = "tk000001";
const CALLER = runDriverCaller(RUN);        // the triple the rows are stamped with
const EXPECTED_CELLS = 12;

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── the credential variants ────────────────────────────────────────────────────────────────────
const connIdFor = (tag: string): string => `pgconn${tag}`.padEnd(16, "0");
/** The rows the placement arm adds for ONE command, built by the same helper the grant builder
 *  calls, so a variant subtracts what the builder actually emitted rather than a guessed string. */
const rowsForCommand = (command: string): string[] =>
  epRequestGrantRows(SPACE, { endpoint: EP, command, routes: [], instanceId: MGR_IID }, CALLER);
const placed = (connId: string) => runMediatorGrants(SPACE, { endpoint: EP, runId: RUN, takeoverId: TAKE, instanceId: MGR_IID, epoch: 1, placement: { instanceId: MGR_IID } }, connId);
const legacy = (connId: string) => runMediatorGrants(SPACE, { endpoint: EP, runId: RUN, takeoverId: TAKE, instanceId: MGR_IID, epoch: 1 }, connId);
/** The full placement credential minus the rows of ONE placement command. The subtraction is
 *  asserted below: a filter that removed nothing would turn a negative control into the positive
 *  one and pass for the wrong reason. */
const minus = (connId: string, command: string): { publish: string[]; subscribe: string[]; removed: number } => {
  const all = placed(connId);
  const drop = new Set(rowsForCommand(command));
  const publish = all.publish.filter((r) => !drop.has(r));
  return { publish, subscribe: all.subscribe, removed: all.publish.length - publish.length };
};

const VARIANTS = [
  { user: "full", rows: placed(connIdFor("full")), connId: connIdFor("full") },
  { user: "nodescribe", rows: minus(connIdFor("nodesc"), "describe"), connId: connIdFor("nodesc") },
  { user: "nocwd", rows: minus(connIdFor("nocwd"), "resolve-cwd"), connId: connIdFor("nocwd") },
  { user: "nospawn", rows: minus(connIdFor("nospwn"), "spawn"), connId: connIdFor("nospwn") },
  { user: "unplaced", rows: legacy(connIdFor("unplcd")), connId: connIdFor("unplcd") },
] as const;

// ── broker ─────────────────────────────────────────────────────────────────────────────────────
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-placegrants-"));
writeFileSync(join(sd, "server.conf"), [
  `port: ${PORT}`,
  `jetstream { store_dir: ${JSON.stringify(join(sd, "js"))} }`,
  "authorization {",
  "  users [",
  `    { user: "auth", password: "pw" }`,
  ...VARIANTS.map((v) => `    { user: ${JSON.stringify(v.user)}, password: "pw", permissions: { publish = ${JSON.stringify(v.rows.publish)}, subscribe = ${JSON.stringify(v.rows.subscribe)} } }`),
  "  ]",
  "}",
].join("\n"));
const broker = spawnProc("nats-server", ["-c", join(sd, "server.conf")], { stdio: "ignore" });
const done = () => {
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  rmSync(sd, { recursive: true, force: true });
};
process.on("exit", done);
let up = false;
for (let i = 0; i < 60 && !up; i += 1) { up = await isReachable(`nats://auth:pw@127.0.0.1:${PORT}`); if (!up) await wait(100); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

let nc: NatsConnection | undefined;
try {
  nc = await connect({ servers: `nats://127.0.0.1:${PORT}`, user: "auth", pass: "pw" });
  const jsm = await jetstreamManager(nc);
  await createEndpointStreams(jsm, new Kvm(nc), SPACE);
  await createSpaceStreams(jsm, SPACE);
  const kv = await openRecordsBucket(nc, SPACE);

  // ── the served manager instance ──────────────────────────────────────────────────────────────
  const SPAWN_INPUT = {
    type: "object", additionalProperties: false, required: ["name"],
    properties: { name: { type: "string", minLength: 1 }, cwd: { type: "string" } },
  } as const;
  const SPAWN_OUTPUT = {
    type: "object", additionalProperties: false, required: ["name", "owner", "actor", "uid"],
    properties: { name: { type: "string" }, owner: { type: "string" }, actor: { type: "string" }, uid: { type: "string" } },
  } as const;
  const RESOLVE_CWD_INPUT = {
    type: "object", additionalProperties: false, required: ["cwd"],
    properties: { cwd: { type: "string", minLength: 1 } },
  } as const;
  const RESOLVE_CWD_OUTPUT = {
    type: "object", additionalProperties: false, required: ["cwd", "host"],
    properties: { cwd: { type: "string" }, host: { type: "string" } },
  } as const;
  const cc = (root: unknown) => compileContract({ root: root as Record<string, unknown> });
  const COMPILED = {
    spawn: { input: cc(SPAWN_INPUT), output: cc(SPAWN_OUTPUT) },
    "resolve-cwd": { input: cc(RESOLVE_CWD_INPUT), output: cc(RESOLVE_CWD_OUTPUT) },
  };
  const DOCUMENT = {
    urn: "ai.cotal.test.placegrants", revision: 1, attributes: [], events: [],
    commands: [
      { name: "spawn", class: "ephemeral" as const, targeted: false, capability: "manager.spawn", inputDigest: COMPILED.spawn.input.closureDigest, outputDigest: COMPILED.spawn.output.closureDigest },
      { name: "resolve-cwd", class: "ephemeral" as const, targeted: false, capability: "manager.spawn", inputDigest: COMPILED["resolve-cwd"].input.closureDigest, outputDigest: COMPILED["resolve-cwd"].output.closureDigest },
    ],
  };
  const ROOT_DIGEST = contractDigest(DOCUMENT);
  const MANIFEST = { v: 1 as const, root: ROOT_DIGEST, members: [] as string[] };
  const CLOSURE_DIGEST = contractDigest(MANIFEST);
  const store = await contractStoreContext(nc, SPACE);
  const artifactIndex = new Map<string, unknown>();
  {
    const values: unknown[] = [];
    const seen = new Set<string>();
    for (const source of [SPAWN_INPUT, SPAWN_OUTPUT, RESOLVE_CWD_INPUT, RESOLVE_CWD_OUTPUT]) {
      const rootDigest = contractDigest(source);
      if (seen.has(rootDigest)) continue;
      seen.add(rootDigest);
      values.push(source, { v: 1, root: rootDigest, members: [] });
    }
    values.push(DOCUMENT, MANIFEST);
    for (const v of values) {
      artifactIndex.set(contractDigest(v), v);
      await publishContractArtifact(store, contractArtifactCanonicalBytes(v));
    }
  }
  const readClusterArtifact = (digest: string): unknown => artifactIndex.get(digest);
  const authKv = await new Kvm(nc).open(epAuthBucket(SPACE));
  const fence = serveIssuanceGateKv(authKv, SPACE, { endpoint: EP, instanceId: MGR_IID });
  await provisionEndpointGateOpen(authKv, { endpoint: EP, instanceId: MGR_IID, principal: "local.mgr" });
  const authority = { authorize: (endpoint: string, owner: string) => ({ authorized: endpoint === EP && owner === "local", revision: 0 }) };
  await registerServiceInstance(kv, {
    space: SPACE,
    spec: { endpoint: EP, owner: "local", clusterDigests: [CLOSURE_DIGEST], protocol: { v: 1 } },
    instanceId: MGR_IID, registrant: { owner: "local" }, authority,
    barrier: endpointRegistrationBarrier(authKv, SPACE, { endpoint: EP, instanceId: MGR_IID, opId: MGR_IID }),
    readClusterArtifact,
  });
  const observed = await fence.observe();
  if (observed === null) throw new Error("the served instance lost its issuance gate after registration");
  const EXEC_EPOCH = observed.processEpoch;
  const grant = await authorizeServeGrant(kv, {
    space: SPACE, endpoint: EP, instanceId: MGR_IID, epoch: EXEC_EPOCH,
    holder: { owner: "local" }, authority, readProcessEpoch: () => EXEC_EPOCH, readClusterArtifact,
  });
  const resolved: string[] = [];
  const accepted: string[] = [];
  const handle = serveEndpoint(nc, SPACE, grant, [
    {
      command: "resolve-cwd", contract: COMPILED["resolve-cwd"],
      handler: (ctx: EpServeContext): unknown => {
        const asked = String(((ctx.request.args ?? {}) as { cwd?: unknown }).cwd);
        let answered: string;
        try { answered = canonicalCwd(asked); } catch (err) {
          throw new EpEnvelopeError("failed-precondition", `cwd does not resolve here: ${JSON.stringify(asked)} (${(err as Error).message})`);
        }
        resolved.push(answered);
        return { cwd: answered, host: "placement-grants-host" };
      },
    },
    {
      command: "spawn", contract: COMPILED.spawn,
      handler: (ctx: EpServeContext): unknown => {
        const args = (ctx.request.args ?? {}) as Record<string, unknown>;
        accepted.push(String(args.cwd));
        return { name: String(args.name), owner: "local", actor: `seat${accepted.length}`, uid: `s${String(accepted.length).padStart(25, "0")}` };
      },
    },
  ] as EpCommandDef[], { public: true }, {});

  // ── the caller side, over each scoped credential ─────────────────────────────────────────────
  /** The placed-spawn reach, exactly as `MeshEffectHandler.spawn` performs it: a PINNED resolve,
   *  then phase A on that instance, then phase B carrying the directory the instance stated. */
  const placeSpawn = async (user: string, connId: string): Promise<{ stage: string; err?: string; cwd?: string }> => {
    const cnc = await connect({ servers: `nats://127.0.0.1:${PORT}`, user, pass: "pw", inboxPrefix: `_INBOX_${connId}` });
    let stage = "resolve";
    try {
      const svc = await resolveService(cnc, SPACE, EP, CALLER, { instanceId: MGR_IID });
      stage = "resolve-cwd";
      const a = await invokeCommand(cnc, SPACE, svc, "resolve-cwd", { cwd: sd }, { deadlineMs: 8_000 });
      if (a.reply.ok === false) throw new Error(a.reply.error?.message ?? "refused");
      const cwd = (a.reply.data as { cwd: string }).cwd;
      stage = "spawn";
      const b = await invokeCommand(cnc, SPACE, svc, "spawn", { name: "pinned", cwd }, { deadlineMs: 8_000 });
      if (b.reply.ok === false) throw new Error(b.reply.error?.message ?? "refused");
      return { stage: "done", cwd };
    } catch (err) {
      return { stage, err: String((err as Error)?.message ?? err) };
    } finally {
      await cnc.close().catch(() => undefined);
    }
  };

  console.log("A. POSITIVE CONTROL — describe + resolve-cwd + spawn on the selected instance, and nothing else");
  const good = await placeSpawn("full", connIdFor("full"));
  c("a credential holding exactly the three placement rows completes a placed spawn end to end", good.stage === "done", good);
  c("phase A ran on the SERVING instance, which is what stated the directory", resolved.length === 1 && good.cwd === resolved[0], { resolved, said: good.cwd });
  c("phase B was accepted carrying the directory that instance stated", accepted.length === 1 && accepted[0] === resolved[0], { accepted, resolved });
  c("the placement arm is exactly three commands wide", PLACEMENT_COMMANDS.length === 3 && [...PLACEMENT_COMMANDS].sort().join(",") === "describe,resolve-cwd,spawn", [...PLACEMENT_COMMANDS]);

  console.log("B. the subtraction control — each negative credential really is missing rows");
  for (const command of PLACEMENT_COMMANDS) {
    const v = minus(connIdFor("x"), command);
    c(`removing ${command} removes a row that the builder had emitted`, v.removed === rowsForCommand(command).length && v.removed > 0, v);
  }

  console.log("C. NEGATIVE CONTROLS — one row removed, the broker refuses and names the rail");
  const stages: Record<string, string> = { nodescribe: "resolve", nocwd: "resolve-cwd", nospawn: "spawn" };
  for (const command of PLACEMENT_COMMANDS) {
    const user = command === "describe" ? "nodescribe" : command === "resolve-cwd" ? "nocwd" : "nospawn";
    const r = await placeSpawn(user, VARIANTS.find((v) => v.user === user)!.connId);
    c(`without the ${command} row the placed spawn is refused at the ${stages[user]} stage, and the refusal names the denied rail`,
      r.stage === stages[user] && r.err !== undefined && /REFUSED BY THE BROKER/.test(r.err) && /does not authorize publishing/.test(r.err) && r.err.includes(`.${command}.`),
      r);
  }

  console.log("D. the UNPLACED credential — what a run that named no target holds");
  const unplaced = await placeSpawn("unplaced", connIdFor("unplcd"));
  c("a credential minted with no placement cannot reach the instance rail at all", unplaced.stage === "resolve" && unplaced.err !== undefined, unplaced);
  // `nospawn` legitimately reaches phase A — it holds describe and resolve-cwd — so the serving
  // instance has answered TWO resolves by now. What no refused credential ever reached is the
  // accept: one placed spawn was submitted in this suite, by the one credential that held all three.
  c("no refused credential ever reached the spawn accept", accepted.length === 1 && resolved.length === 2, { resolved: resolved.length, accepted: accepted.length });

  await handle.stop();
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
} finally {
  try { await nc?.close(); } catch { /* closed */ }
}

if (ok + fail !== EXPECTED_CELLS) {
  console.log(`\n  ✗ FAIL: the suite ran ${ok + fail} cells, not the ${EXPECTED_CELLS} it declares`);
  fail++;
}
console.log(fail === 0 ? `\nplacement-grants.smoke: ${ok} passed, ${fail} failed ✅` : `\nplacement-grants.smoke: ${ok} passed, ${fail} failed ❌`);
process.exit(fail === 0 ? 0 : 1);
