/**
 * SEAT INPUT smoke (lane C3): the manager op `input` and `cotal input`, over a REAL Manager, a REAL
 * JWT broker and REAL pty children, graded on THE BYTES THAT REACHED THE CHILD.
 *
 * WHY THE CHILD AND NOT THE REPLY. `input` answers `{name, bytes}`. A suite that asserted that
 * reply would be grading the manager's own arithmetic: it stays green if the write never leaves the
 * process, if the runtime handle drops it, if node-pty mangles the encoding, or if a future
 * refactor computes `bytes` from the request instead of from what it wrote. The claim the feature
 * actually makes is that a line typed by an external UI arrives at the seat's harness, so the
 * witness has to be the harness end. Every delivery cell here reads a file the CHILD appends its
 * raw stdin to (`input-echo-stub.mjs`), byte for byte, with no decoding and no trimming. The stub
 * puts its tty in RAW MODE, as every TUI harness this feature drives does; see the stub for the
 * measured reason a cooked-mode child would grade bytes no real seat ever sees.
 *
 * WHAT IS GRADED
 *   1. Fixture first: the sink witnesses reality (it is EMPTY before anything is typed), so an
 *      absence cell below cannot pass because the mechanism never worked.
 *   2. Owner reach: the spawner types into its own seat, and the exact bytes arrive.
 *   3. `enter:false` types the text with NO trailing carriage return (byte-exact, and read as a
 *      DELTA on the same live seat, so the two enter modes are compared against one child).
 *   4. A caller that did not spawn the seat is refused (`permission-denied`), and nothing arrives.
 *   5. An operator instrument's ANY-mode call types into a seat it did not spawn (admin reach,
 *      the same row shape `attach`/`despawn` carry), over the GENERIC describe/store invoke path.
 *   6. A spawn-capable agent publishing the ANY-mode subject is broker-dropped: the tier boundary
 *      is the grant, not a handler branch.
 *   7. A seat that is not running refuses (see the cell for exactly what is forced and why).
 *   8. THE CLI PATH, end to end: the real binary as a subprocess runs
 *      `cotal input --name <seat> --text "/compact"`, exits 0, prints the byte count, and the child
 *      receives `/compact\r`. An external UI calls the CLI before it calls anything else, and a
 *      defect anywhere in agents.ts -> control.ts -> the mint -> the subject leaves cells 2-7 green.
 *
 * COVERAGE BOUNDARY, stated so it is not over-read. This is a STATIC-auth mesh, so cell 4's refusal
 * is the own-child arm of the shared `authorizeNamedControl` policy (the caller is not the
 * spawner); the cross-OWNER arm needs a user-mode ledger and is graded where that fixture already
 * exists (`implementations/auth/smoke/user-spawn.smoke.ts`, whose despawn/attach cells cover the
 * same one policy function this op calls). Nothing here grades a runtime other than `pty`: the
 * tmux/cmux/orca/herdr refusal is the ABSENCE of `AgentHandle.write` on those handles, which is a
 * type-level fact plus the handler's `if (!write)` branch, not something this fixture can spawn.
 *
 * MUTATION-PROOF TARGETS (named BEFORE the run, per cell, not per suite):
 *   `input-authz`: delete the `authorizeNamed` refusal in manager.ts's `input` handler
 *      -> cell 4 "a caller that did NOT spawn the seat is refused" goes red.
 *   `input-enter`: flip `args.enter !== false ? "\r" : ""` in `inputAuthorized` to always append
 *      -> cell 3 "enter:false types the text with NO trailing carriage return" goes red.
 *
 * Run: pnpm smoke:seat-input   (needs nats-server + node on PATH; boots its own broker; the CLI
 * cell drives bin/cotal.ts, which imports dist, so build first)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, principalKey, DEV_OWNER,
  epCall, EpEnvelopeError, resolveService, invokeCommand, registry,
  type Connector, type EpCaller, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, recordMesh } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const STUB = join(here, "input-echo-stub.mjs");
const BIN = join(repoRoot, "bin", "cotal.ts");
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;

// The CLI cell spawns the REAL binary, which resolves a mesh from the environment before it reads a
// flag. A stray COTAL_SERVERS inherited from a seat's own env would point `cotal input` at the live
// broker and type into somebody's production agent, so refuse to run at all rather than find out.
const LIVE_HOST = "broker.cotal.ai";
for (const k of ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE"]) delete process.env[k];
for (const [k, v] of Object.entries(process.env))
  if (typeof v === "string" && v.includes(LIVE_HOST)) throw new Error(`refusing to run: ${k} points at the live broker (${v})`);
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) throw new Error(`this suite only runs against an ephemeral loopback broker; got ${SERVERS}`);
console.log(`broker-url guard: ${SERVERS} is ephemeral loopback; no env var references ${LIVE_HOST}\n`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const space = `seatin-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
// COTAL_HOME BEFORE any recordMesh: the mesh registry the CLI cell reads is written under it, and
// this suite must never touch the operator's real `~/.cotal`. The CLI child inherits the same value.
const home = join(dir, "home");
mkdirSync(home, { recursive: true });
process.env.COTAL_HOME = home;
const workspaceRoot = join(dir, "ws");
const sinkDir = join(dir, "sinks");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
mkdirSync(sinkDir, { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
for (const n of ["typist", "guarded", "opseat", "cliseat", "deadseat"])
  writeFileSync(join(workspaceRoot, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nrole: worker\n---\n`);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

/** Where a seat's child writes what it was typed. Derived from the ALLOCATED name (the manager may
 *  number a collision into `typist-2`), so a fixture that read the requested name would silently
 *  watch an empty file. */
const sinkFor = (name: string): string => join(sinkDir, `${name}.bin`);
/** The raw bytes the child has received so far, `<empty>` before it has been typed into at all.
 *  Deliberately a Buffer and never a string: a `\r` present or absent IS a cell here, so a helper
 *  that decoded or trimmed would answer the question the suite is asking. */
const sinkBytes = (name: string): Buffer => {
  try { return readFileSync(sinkFor(name)); } catch { return Buffer.alloc(0); }
};
/** Wait for the child's sink to reach `want` bytes. Delivery is a real pty write to a real
 *  process, so it is not synchronous with the reply; polling for a LENGTH (not for a match) means a
 *  wrong-bytes delivery is graded by the assertion that follows, never masked by this wait. */
const sinkReaches = async (name: string, want: number, ms = 15_000): Promise<Buffer> => {
  const deadline = Date.now() + ms;
  let b = sinkBytes(name);
  while (b.length < want && Date.now() < deadline) { await wait(100); b = sinkBytes(name); }
  return b;
};

const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? SERVERS), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
  COTAL_INPUT_SINK: sinkFor(o.name),
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
const echoCon: Connector = { kind: "connector", name: "input-echo", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: [STUB], env: envFor(o) }) };
registry.register(echoCon);

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
type PrivHandle = { status: () => "running" | "exited"; kind: string };
const M = mgr as unknown as {
  managerInstanceId: string;
  agents: Map<string, { id: string; lifecycleUid: string; handle: PrivHandle }>;
};

type Call = (c: string, a?: Record<string, unknown>, t?: { actor: string; lifecycleUid: string }) => Promise<{ reply: { ok: boolean; data?: unknown; error?: { code?: string; message?: string } } }>;

/** `spawn` is an ACTION: its reply is the acceptance, returned before the child is live. Poll `ps`
 *  for the allocated row, which carries the id + lifecycle uid a targeted call needs. */
const spawnLive = async (call: Call, args: Record<string, unknown>): Promise<{ name: string; id: string; lifecycleUid: string }> => {
  const r = await call("spawn", args);
  if (r.reply.ok !== true) throw new Error(`spawn ${String(args.name)} was not accepted: ${JSON.stringify(r.reply)}`);
  const name = String((r.reply.data as { name: string }).name);
  for (let i = 0; i < 120; i++) {
    const ps = await call("ps");
    const row = ((ps.reply.data as Array<{ name: string; id: string; lifecycleUid: string }>) ?? []).find((x) => x.name === name);
    if (row) return row;
    await wait(250);
  }
  throw new Error(`agent ${name} never became live in ps`);
};

/** An agent-grade caller instrument: the given ep capabilities on the manager endpoint, owner-mode
 *  where marked. This is the AGENT tier - it can never hold an any-mode row (cell 6 proves it). */
async function instrument(caps: Array<{ command: string; owner?: true }>): Promise<{ caller: EpCaller; principal: string; nc: Awaited<ReturnType<typeof connect>>; call: Call }> {
  const id = newIdentity();
  const uid = mintLifecycleUid();
  const caller: EpCaller = { owner: DEV_OWNER, actor: id.id, uid };
  const creds = await mintCreds(auth, id, "agent", {
    lifecycleUid: uid,
    capabilities: ["spawn"],
    endpointCapabilities: caps.map((c) => ({
      endpoint: MANAGER_ENDPOINT, command: c.command,
      ...(c.owner ? { target: { mode: "owner" as const, tOwner: DEV_OWNER } } : {}),
    })),
  });
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  const call: Call = (command, callArgs, target) =>
    epCall(nc, space, { mode: "one" }, {
      endpoint: MANAGER_ENDPOINT, command, contract: MANAGER_CONTRACTS[command], caller,
      ...(callArgs !== undefined ? { args: callArgs } : {}),
      ...(target ? { target: { mode: "owner" as const, owner: DEV_OWNER, actor: target.actor, lifecycleUid: target.lifecycleUid } } : {}),
    }, { deadlineMs: 30_000, currentEpoch: async () => 0 });
  return { caller, principal: principalKey(DEV_OWNER, id.id).key, nc, call };
}

/** How the CLI child ENDED rides in the result: a launch failure, a signal death, or this suite's
 *  own timeout each produce output that would otherwise be graded as if the command had spoken. */
type Run = { status: number | null; out: string; timedOut: boolean; signal: NodeJS.Signals | null; launchError?: string };
function cotal(args: string[], timeoutMs = 120_000): Promise<Run> {
  return new Promise((res) => {
    const child = spawn("npx", ["tsx", BIN, ...args], {
      cwd: workspaceRoot, env: { ...process.env, COTAL_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", timedOut = false, settled = false;
    let status: number | null = null, signal: NodeJS.Signals | null = null;
    const done = (r: Run): void => { if (settled) return; settled = true; clearTimeout(t); res(r); };
    const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (e) => done({ status: null, out, timedOut, signal: null, launchError: e.message }));
    child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("exit", (s, sg) => { status = s; signal = sg; });
    child.on("close", (s, sg) => done({ status: s ?? status, out, timedOut, signal: sg ?? signal }));
  });
}
/** Refuse to grade anything but a self-terminated child with a real exit code: every shape rejected
 *  here would otherwise satisfy a "the CLI delivered it" cell without the CLI having run. */
function mustHaveRun(r: Run, what: string): void {
  const why =
    r.launchError ? `never launched (${r.launchError})`
    : r.timedOut ? "was SIGKILLed by this suite's timeout"
    : r.signal ? `was killed by ${r.signal} from outside this suite`
    : r.status === null ? "ended with neither an exit code nor a signal"
    : null;
  if (why === null) return;
  process.exitCode = 1;
  throw new Error(`FIXTURE FAILURE, not a product defect: ${what} ${why}, which fakes the pass shape.\n${r.out.slice(-800)}`);
}
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  recordMesh({ space, server: SERVERS, root: workspaceRoot, mode: "auth", ts: new Date().toISOString() });
  await mgr.start();

  // A holds the owner-mode `input` row (the spawn capability's standing set). B holds it too, and
  // spawns nothing: it is the non-spawner in cell 4, so its refusal is the POLICY refusing, never a
  // missing grant refusing (which would prove nothing about the handler).
  const A = await instrument([
    { command: "status" }, { command: "ps" }, { command: "inspect" }, { command: "spawn" },
    { command: "despawn", owner: true }, { command: "input", owner: true },
  ]);
  const B = await instrument([{ command: "inspect" }, { command: "input", owner: true }]);

  console.log("1. the fixture witnesses reality: a live seat whose sink is EMPTY before anything is typed");
  const typist = await spawnLive(A.call, { name: "typist", agent: "input-echo", cwd: repoRoot });
  // Without this, every byte-exact cell below could pass on a broken stub: an absence assertion
  // ("no trailing \r") is satisfied by a sink that never receives anything at all.
  check("the spawned seat's sink starts empty (so an absence below means absence, not a dead stub)",
    sinkBytes(typist.name).length === 0, sinkBytes(typist.name).toString("hex"));

  console.log("\n2. owner reach: the spawner types into its OWN seat and the exact bytes reach the child");
  {
    const r = await A.call("input", { text: "hello" }, { actor: typist.id, lifecycleUid: typist.lifecycleUid });
    check("the op is served and reports the seat + the byte count (text + the appended \\r)",
      r.reply.ok === true && (r.reply.data as { name: string; bytes: number }).name === typist.name
      && (r.reply.data as { bytes: number }).bytes === 6, r.reply);
    const got = await sinkReaches(typist.name, 6);
    check("THE CHILD RECEIVED EXACTLY `hello\\r`: the bytes left the manager, crossed the pty and arrived",
      got.equals(Buffer.from("hello\r", "utf8")), { hex: got.toString("hex"), want: Buffer.from("hello\r", "utf8").toString("hex") });
  }

  console.log("\n3. enter:false types the text and presses nothing (mutation-proof cell `input-enter`)");
  {
    // Read as a DELTA on the SAME live child, so the two enter modes are compared through one pty
    // and one stub rather than against a constant. A second seat would make this cell independent
    // of cell 2, and an independent cell can drift green while the pair it is supposed to
    // distinguish has collapsed into one behaviour.
    const before = sinkBytes(typist.name).length;
    const r = await A.call("input", { text: "part", enter: false }, { actor: typist.id, lifecycleUid: typist.lifecycleUid });
    check("the op reports 4 bytes: the text alone, no carriage return counted",
      r.reply.ok === true && (r.reply.data as { bytes: number }).bytes === 4, r.reply);
    const got = await sinkReaches(typist.name, before + 4);
    const delta = got.subarray(before);
    check("THE CHILD RECEIVED EXACTLY `part` with NO trailing carriage return",
      delta.equals(Buffer.from("part", "utf8")), { hex: delta.toString("hex"), want: Buffer.from("part", "utf8").toString("hex") });
    // Belt and braces on the whole conversation: a mutation that appended `\r` unconditionally
    // would be caught by the delta above, and one that appended it LATE (say on the next write)
    // would not. The full transcript pins the exact byte sequence the child has ever seen.
    check("...and the child's WHOLE transcript is `hello\\r` then `part`, in that order, nothing else",
      got.equals(Buffer.from("hello\rpart", "utf8")), { hex: got.toString("hex") });
  }

  console.log("\n4. a caller that did NOT spawn the seat is refused (mutation-proof cell `input-authz`)");
  {
    const before = sinkBytes(typist.name).length;
    const r = await B.call("input", { text: "intruder" }, { actor: typist.id, lifecycleUid: typist.lifecycleUid });
    check("a caller that did NOT spawn the seat is refused (permission-denied, the shared named-control policy)",
      r.reply.ok === false && r.reply.error?.code === "permission-denied", r.reply);
    // The refusal must be a refusal to ACT, not a refusal to REPORT. A handler that denied after
    // writing would satisfy the code check above and still have typed into somebody else's agent.
    await wait(750);
    check("...and NOTHING reached the child: the refusal happened before the write, not after it",
      sinkBytes(typist.name).length === before, { before, after: sinkBytes(typist.name).length });
  }

  console.log("\n5. operator ANY-mode reach: an instrument types into a seat it did not spawn");
  {
    // The CLI's exact credential and the CLI's exact path: a `control-caller-admin` one-shot whose
    // ep rows come from operatorInstrumentCapabilities("admin"), driving the GENERIC describe ->
    // store fetch -> recompile invoke path with no hand-imported schema and no epoch stub.
    const opId = newIdentity();
    const opUid = mintLifecycleUid();
    const opCaller: EpCaller = { owner: DEV_OWNER, actor: opId.id, uid: opUid };
    const opCreds = await mintCreds(auth, opId, "control-caller-admin", { lifecycleUid: opUid });
    const opNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: opCreds, tls: false }), maxReconnectAttempts: 0 });
    const opseat = await spawnLive(A.call, { name: "opseat", agent: "input-echo", cwd: repoRoot });
    check("fixture: A spawned the seat, so the instrument is NOT its spawner", opseat.name.startsWith("opseat"), opseat.name);
    const svc = await resolveService(opNc, space, MANAGER_ENDPOINT, opCaller, { deadlineMs: 15_000 });
    check("the instrument resolves `input` generically off the served document (digest-verified recompile)",
      svc.commands.has("input"), [...svc.commands.keys()]);
    const r = await invokeCommand(opNc, space, svc, "input", { text: "/model opus" }, {
      target: { mode: "any", owner: DEV_OWNER, actor: opseat.id, lifecycleUid: opseat.lifecycleUid },
    });
    check("ANY-mode input is served for an agent the caller did not spawn (admin reach, the attach/despawn row shape)",
      r.reply.ok === true && (r.reply.data as { bytes: number }).bytes === 12, r.reply);
    const got = await sinkReaches(opseat.name, 12);
    check("THE CHILD RECEIVED EXACTLY `/model opus\\r`: a leading `/` survives the whole path unparsed",
      got.equals(Buffer.from("/model opus\r", "utf8")), { hex: got.toString("hex") });
    await opNc.drain().catch(() => opNc.close());
  }

  console.log("\n6. the tier boundary is the GRANT: an agent cred's any-mode input never reaches the handler");
  {
    // B holds the OWNER-mode input row. The any-mode form of the same command is a different
    // subject its credential does not carry, so the broker drops the publish (default deny) and the
    // admin path is structurally unreachable from every agent-grade credential: exactly the
    // property that lets `input` share `attach`'s row shape without inventing a second tier.
    let refused: string | undefined;
    try {
      const r = await epCall(B.nc, space, { mode: "one" }, {
        endpoint: MANAGER_ENDPOINT, command: "input", contract: MANAGER_CONTRACTS.input, caller: B.caller,
        args: { text: "escalate" },
        target: { mode: "any", owner: DEV_OWNER, actor: typist.id, lifecycleUid: typist.lifecycleUid },
      }, { deadlineMs: 3_000, currentEpoch: async () => 0 });
      refused = r.reply.ok === false ? r.reply.error?.code : "SERVED-OK";
    } catch (e) {
      refused = e instanceof EpEnvelopeError ? e.code : (e as Error).message;
    }
    check("a spawn-capable agent publishing the ANY-mode input subject is broker-dropped (no reply, never served)",
      refused === "unavailable" || refused === "deadline-exceeded", refused);
  }

  console.log("\n7. a seat that is not running refuses");
  {
    // WHAT IS FORCED AND WHY, so this cell is not over-read. On the pty runtime a child's exit is
    // reaped SYNCHRONOUSLY (the attach session's onExit -> onAgentExit -> freeSlot deletes the slot
    // in the same tick), so the state this branch guards - a slot still held by an agent whose
    // process has gone - cannot be produced by killing a child and racing the manager. What is
    // forced is exactly one fact, on a REAL live managed agent: its handle reports `exited`. The
    // request, the subject, the credential, the authorization and the handler are all real and
    // unmodified, and the forcing is undone immediately. It is graded here rather than left to a
    // reasoned argument because "refuses to type into a dead seat" is the one thing an external UI
    // must be able to rely on when a seat dies mid-session.
    const deadseat = await spawnLive(A.call, { name: "deadseat", agent: "input-echo", cwd: repoRoot });
    const managed = M.agents.get(deadseat.name);
    if (!managed) throw new Error(`FIXTURE FAILURE: ${deadseat.name} is live in ps but absent from the manager's slot map`);
    const realStatus = managed.handle.status.bind(managed.handle);
    let r;
    try {
      managed.handle.status = () => "exited";
      r = await A.call("input", { text: "ghost" }, { actor: deadseat.id, lifecycleUid: deadseat.lifecycleUid });
    } finally {
      managed.handle.status = realStatus;
    }
    check("input into a seat whose process is gone refuses (failed-precondition), naming the state",
      r.reply.ok === false && r.reply.error?.code === "failed-precondition"
      && String(r.reply.error?.message ?? "").includes("is not running"), r.reply);
    check("...and nothing was typed into it", sinkBytes(deadseat.name).length === 0, sinkBytes(deadseat.name).toString("hex"));
    await A.call("despawn", { graceful: false }, { actor: deadseat.id, lifecycleUid: deadseat.lifecycleUid });
  }

  console.log("\n8. THE CLI PATH: the real binary types a harness command into a seat");
  {
    // The cell the whole lane exists for. An external UI reaches this feature through `cotal input`,
    // and every layer between the flag and the subject (flag parsing, the seat-locality pin, the
    // instrument mint, the alias -> triple resolution, the reach choice) is invisible to cells 2-7:
    // a defect in any of them leaves those green and the product broken.
    const cliseat = await spawnLive(A.call, { name: "cliseat", agent: "input-echo", cwd: repoRoot });
    const run = await cotal(["input", "--name", cliseat.name, "--text", "/compact", "--space", space]);
    mustHaveRun(run, "`cotal input`");
    const out = strip(run.out);
    check("`cotal input --name <seat> --text \"/compact\"` exits 0", run.status === 0, { status: run.status, tail: out.slice(-400) });
    check("...and reports what it delivered", /✓ sent 9 bytes to /.test(out) && out.includes(cliseat.name), out.slice(-400));
    const got = await sinkReaches(cliseat.name, 9);
    check("THE SEAT'S HARNESS RECEIVED EXACTLY `/compact\\r`: a slash command typed in a UI reaches the child verbatim",
      got.equals(Buffer.from("/compact\r", "utf8")), { hex: got.toString("hex"), want: Buffer.from("/compact\r", "utf8").toString("hex") });

    // `--no-enter` through the same real binary, carrying the HARDEST payload: text that is itself
    // a flag spelling. `--text=<value>` is the form node's `parseArgs` requires for a dash-leading
    // value, and it is what docs/cli.md tells the operator to use.
    const before = sinkBytes(cliseat.name).length;
    const run2 = await cotal(["input", "--name", cliseat.name, `--text=--not-a-flag`, "--no-enter", "--space", space]);
    mustHaveRun(run2, "`cotal input --no-enter`");
    const out2 = strip(run2.out);
    check("`--no-enter` exits 0 and reports only the text's bytes", run2.status === 0 && /✓ sent 12 bytes to /.test(out2), { status: run2.status, tail: out2.slice(-400) });
    const got2 = await sinkReaches(cliseat.name, before + 12);
    check("...and the child received EXACTLY `--not-a-flag`, unparsed and with no carriage return",
      got2.subarray(before).equals(Buffer.from("--not-a-flag", "utf8")), { hex: got2.subarray(before).toString("hex") });

    // THE SPACE FORM OF A DASH-LEADING VALUE MUST FAIL LOUD, and this is graded rather than
    // reasoned because the alternative outcomes are both bad and both plausible: `parseArgs` could
    // swallow `--not-a-flag` as an option (delivering nothing while exiting 0) or could take the
    // NEXT token as the text (delivering the wrong bytes). It does neither, and nothing typed
    // reaches the seat. Measured on the first run of this suite, which is why the docs carry the
    // `--text=` form rather than leaving an operator to discover this at a live agent.
    const beforeRefusal = sinkBytes(cliseat.name).length;
    const run3 = await cotal(["input", "--name", cliseat.name, "--text", "--not-a-flag", "--space", space]);
    mustHaveRun(run3, "`cotal input` with a space-separated dash-leading value");
    check("a dash-leading value in the SPACE form is a usage error, not a silent or wrong delivery",
      run3.status !== 0 && sinkBytes(cliseat.name).length === beforeRefusal,
      { status: run3.status, delivered: sinkBytes(cliseat.name).length - beforeRefusal, tail: strip(run3.out).slice(-300) });

    // The refusal path, through the binary: a name that does not exist must be a non-zero exit with
    // the manager's own message, never a silent success an external UI would render as delivered.
    const run4 = await cotal(["input", "--name", `no-such-seat-${randomUUID().slice(0, 6)}`, "--text", "/compact", "--space", space]);
    mustHaveRun(run4, "`cotal input` at an absent seat");
    check("an absent seat exits NON-ZERO and says so", run4.status !== 0 && /no managed agent|could not resolve/.test(strip(run4.out)), { status: run4.status, tail: strip(run4.out).slice(-400) });
  }

  await A.nc.drain().catch(() => A.nc.close());
  await B.nc.drain().catch(() => B.nc.close());
  await mgr.stop();
} finally {
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

console.log(`\n${fail === 0 ? "SEAT INPUT SMOKE OK ✅" : "SEAT INPUT SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
