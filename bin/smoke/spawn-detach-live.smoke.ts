/**
 * LIVE e2e for the merged launch grammar (CLI rework stage 2a): a REAL nats-server on an isolated
 * port, a REAL manager (real pty runtime — the spawned "agent" is a node keepalive, not a Claude
 * cold-start), and the REAL CLI command functions parsed through the REAL kernel specs:
 *
 *  A. `spawn --detach <persona> --prompt/--subscribe/--share-tools` → control plane → manager
 *     spawns it; the overrides arrive in the connector's LaunchOpts (flags > persona, e2e).
 *  B. `ps` lists the managed agent; `stop --name` tears it down; `ps` is empty again.
 *  C. `attach` replies the holder-bound §13.6 session grant (no ws:// URL, no 127.0.0.1) and the
 *     mesh caller rail opens + handshakes over the real broker (item 6 replaced the loopback WS).
 *  D. `COTAL_DEFAULT_PERSONA` supplies the persona for a bare `spawn --detach`.
 *  G. a persona the manager cannot find is refused (exit 2) with the manager's reason, and nothing launches.
 *  I. an agent that exits at once fails OPERATION_FAILED (exit 5) with the manager's reason.
 *  E. the `start` tombstone errors, naming `spawn --detach` (subprocess through bin/cotal.ts).
 *  F. `--foreground --creds` fails loud (subprocess).
 *  H. a spawn in this terminal refuses a missing persona or connector with its code and Next, before
 *     it prints that it is starting the application (subprocess).
 *
 * COTAL_HOME is sandboxed; kills ONLY the PIDs it spawns. Needs nats-server on PATH.
 * Run: pnpm smoke:spawn-detach:live   (build first — bin/cotal.ts subprocess checks run dist)
 */
import { spawn as spawnProc, spawnSync, type ChildProcess } from "node:child_process";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Resolve once the child has actually exited (or immediately if it already has); bounded by ms. */
const awaitExit = (p: ChildProcess, ms = 5000): Promise<void> =>
  new Promise((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r();
    p.once("exit", () => r());
    setTimeout(r, ms).unref?.();
  });

const home = mkdtempSync(join(tmpdir(), "cotal-detach-home-"));
process.env.COTAL_HOME = home;

const { parseCommandArgs, probeConnect, registry, CotalEndpoint, openSessionRail, EpEnvelopeError } = await import("@cotal-ai/core");
const { connect } = await import("@nats-io/transport-node");
const { recordMesh, isCommandFailure, exitCode, commandFailureReport, renderReport } = await import("@cotal-ai/workspace");
await import("@cotal-ai/cli"); // registers the CLI commands (spawn/stop/ps/attach) into the registry
const { Manager } = await import("@cotal-ai/manager");
import type { AgentHandle, Command, Connector, ControlReply, LaunchOpts, LaunchSpec, RuntimeProvider, SessionGrant } from "@cotal-ai/core";
const TSX = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsx");

let pass = 0;
const kids: ChildProcess[] = [];
let releaseBroker: (() => void) | undefined;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** True when a receipt carries `heading` and names `name` on its own `Agent:` row. */
const receiptFor = (out: string, heading: string, name: string): boolean =>
  out.includes(heading) && out.split("\n").some((line) => /^Agent:\s/.test(line.trim()) && line.trim().slice(6).trim() === name);
const joinedAs = (out: string, name: string): boolean => receiptFor(out, "Agent joined", name);
const stopped = (out: string, name: string): boolean => receiptFor(out, "Agent stop acknowledged", name);
const NO_AGENTS = /^\s*No managed agents\.$/m;
/** A report read without its color, for the cells that run with `isTTY` forced on. */
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "detach-e2e";

// Workspace: a persona with a file ACL (so the override test proves flags WIN), plus config.json
// declaring shareable MCP servers for the e2e connector.
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-detach-ws-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
writeFileSync(
  join(workspaceRoot, ".cotal", "agents", "poet.md"),
  "---\nname: poet\nrole: writer\nsubscribe: [verse]\nallowPublish: [verse]\n---\nYou write verse.\n",
);
writeFileSync(
  join(workspaceRoot, ".cotal", "config.json"),
  JSON.stringify({ connectors: { e2e: { mcpServers: { alpha: { command: "true" }, beta: { command: "true" } } } } }),
);

// The e2e connector: a REAL long-lived child (node keepalive) through the REAL pty runtime — no
// Claude cold-start, but a genuine process the manager supervises and attach streams. The child
// reports its ACTUAL cwd to a file, so `--cwd` is asserted end to end (it rides runtime.spawn,
// not LaunchOpts — only the real process can prove it).
const cwdReport = join(mkdtempSync(join(tmpdir(), "cotal-detach-out-")), "cwd.txt");
// The child is a REAL mesh endpoint: it joins presence under the manager-assigned id (env), so the
// #159 B1 readiness race resolves "started" — a bare keepalive would ride the 30s backstop into
// an `uncertain` non-success and fail the spawn reply.
const coreDist = join(import.meta.dirname, "..", "..", "packages", "core", "dist", "index.js");
const CHILD = [
  "const{pathToFileURL}=require('node:url');",
  "import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,watchPresence:false,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});",
  "ep.on('error',()=>{});await ep.start();",
  "require('fs').writeFileSync(process.env.CWD_OUT,process.cwd());",
  "setInterval(()=>{},1000);});",
].join("");
let lastOpts: LaunchOpts | undefined;
const e2eCon: Connector = {
  kind: "connector",
  name: "e2e",
  requires: ["node"],
  supportsModelVariant: true,
  supportsPrompt: true, // the suite spawns with --prompt; the contract is default-deny (#315)
  buildLaunch: (o) => {
    lastOpts = o;
    return {
      command: "node",
      args: ["-e", CHILD],
      env: {
        PATH: process.env.PATH ?? "",
        CWD_OUT: cwdReport,
        CORE_DIST: coreDist,
        COTAL_SPACE: o.space,
        COTAL_SERVERS: o.servers ?? "",
        COTAL_ID: o.id ?? "",
        COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "",
        COTAL_NAME: o.name,
      },
    };
  },
};
registry.register(e2eCon);
// A connector whose child prints one line and exits at once: a launch the manager reports failed.
const exitCon: Connector = {
  kind: "connector",
  name: "e2e-exit",
  requires: ["node"],
  buildLaunch: () => ({ command: "node", args: ["-e", "console.log('e2e-exit quits');process.exit(3)"], env: { PATH: process.env.PATH ?? "" } }),
};
registry.register(exitCon);
// A runtime with NO terminal to stream — the shape tmux, cmux, orca and herdr have. It starts a
// real child and its `attach()` throws its own guidance, as theirs do, and `attachCalls` counts
// every attach the manager was asked to open: "the foreground launch did not attempt an attach" is
// then measured at the runtime rather than read off the receipt that claims it.
let attachCalls = 0;
const noStream: RuntimeProvider = {
  kind: "runtime",
  name: "e2e-nostream",
  available: () => true,
  create: () => ({
    kind: "e2e-nostream",
    streamsTerminal: false,
    spawn: (name: string, spec: LaunchSpec, cwd: string): AgentHandle => {
      const child = spawnProc(spec.command, spec.args, { cwd, env: spec.env, stdio: "ignore" });
      kids.push(child);
      return {
        name, kind: "e2e-nostream",
        status: () => (child.exitCode === null && child.signalCode === null ? "running" : "exited"),
        stop: () => { child.kill("SIGKILL"); },
        waitForExit: () => awaitExit(child),
        interrupt: () => {},
        attach: () => {
          attachCalls++;
          throw new Error(`e2e-nostream runtime: watch this agent where it runs; agent "${name}" has no terminal here`);
        },
      };
    },
  }),
};
registry.register(noStream);
// A runtime that declares a terminal but cannot open one: an attach that should work and fails, so
// its refusal is a real attach failure rather than the no-terminal answer.
const brokenStream: RuntimeProvider = {
  kind: "runtime",
  name: "e2e-brokenstream",
  available: () => true,
  create: () => ({
    kind: "e2e-brokenstream",
    streamsTerminal: true,
    spawn: (name: string, spec: LaunchSpec, cwd: string): AgentHandle => {
      const child = spawnProc(spec.command, spec.args, { cwd, env: spec.env, stdio: "ignore" });
      kids.push(child);
      return {
        name, kind: "e2e-brokenstream",
        status: () => (child.exitCode === null && child.signalCode === null ? "running" : "exited"),
        stop: () => { child.kill("SIGKILL"); },
        waitForExit: () => awaitExit(child),
        interrupt: () => {},
        attach: () => { throw new Error(`e2e-brokenstream runtime: the terminal of "${name}" could not be opened`); },
      };
    },
  }),
};
registry.register(brokenStream);

const cmd = (name: string): Command => {
  const c = registry.all<Command>("command").find((c) => c.name === name);
  if (!c) throw new Error(`command ${name} not registered`);
  return c;
};
/** Run a REAL CLI command exactly as the dispatcher would: kernel-parsed argv → run(). */
const run = (name: string, argv: string[]) => cmd(name).run(parseCommandArgs(cmd(name), argv));
/** Capture what a run writes on stdout (ps prints a report, or one envelope under --json). */
async function capture(fn: () => Promise<void>): Promise<string> {
  let out = "";
  const real = console.log;
  const write = process.stdout.write;
  console.log = (...a: unknown[]) => void (out += a.join(" ") + "\n");
  process.stdout.write = ((chunk: string) => ((out += chunk), true)) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    console.log = real;
    process.stdout.write = write;
  }
  return out;
}

let mgr: InstanceType<typeof Manager> | undefined;
try {
  // Real broker (open mode — authed control ops are covered by smoke:control-auth; this e2e is
  // about the CLI↔manager grammar) + registry entry so the CLI resolver finds the mesh.
  const brokerStore = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}detach-js-`));
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", brokerStore], { stdio: "ignore" });
  kids.push(broker);
  releaseBroker = teardownOnSignal(broker, brokerStore);
  for (let i = 0; i < 50; i++) {
    if ((await probeConnect(SERVER, { timeoutMs: 400 })).ok) break;
    await sleep(100);
  }
  recordMesh({ space: SPACE, server: SERVER, root: workspaceRoot, mode: "open", ts: new Date().toISOString() });

  mgr = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot });
  await mgr.start();

  // A — detached spawn with the FULL override set (incl. identity: `--name bard` beside the
  // positional ref — the review-1 fix), through the real kernel parse + control plane.
  const agentCwd = mkdtempSync(join(tmpdir(), "cotal-detach-cwd-"));
  const spawnOut = await capture(() =>
    run("spawn", [
      "poet", "--detach", "--no-events", "--agent", "e2e", "--space", SPACE, "--name", "bard",
      "--prompt", "compose", "--subscribe", "ops,ops.x", "--allow-subscribe", "ops,ops.>",
      "--allow-publish", "ops", "--model", "fancy", "--variant", "high", "--opt", "temperature=0.2", "--opt", "seed=7",
      "--cwd", agentCwd, "--share-tools", "alpha",
    ]),
  );
  ok("detached spawn reached the connector", lastOpts !== undefined);
  ok("identity override joined as bard, not the file's poet", joinedAs(spawnOut, "bard") && lastOpts?.name === "bard", { spawnOut, name: lastOpts?.name });
  ok("prompt rode the control plane", lastOpts?.prompt === "compose", lastOpts?.prompt);
  ok("subscribe override beat the persona file", JSON.stringify(lastOpts?.subscribe) === JSON.stringify(["ops", "ops.x"]), lastOpts?.subscribe);
  ok("allow-subscribe override arrived", JSON.stringify(lastOpts?.allowSubscribe) === JSON.stringify(["ops", "ops.>"]), lastOpts?.allowSubscribe);
  ok("allow-publish override arrived", JSON.stringify(lastOpts?.allowPublish) === JSON.stringify(["ops"]), lastOpts?.allowPublish);
  ok("model override arrived", lastOpts?.model === "fancy", lastOpts?.model);
  ok("variant override arrived", lastOpts?.variant === "high", lastOpts?.variant);
  ok("launch options (--opt k=v) rode the control plane", JSON.stringify(lastOpts?.launchOptions) === JSON.stringify({ temperature: "0.2", seed: "7" }), lastOpts?.launchOptions);
  ok("share-tools narrowed the config servers", JSON.stringify(Object.keys(lastOpts?.mcpServers ?? {})) === JSON.stringify(["alpha"]), lastOpts?.mcpServers);
  ok("persona role survived (no override given)", lastOpts?.role === "writer", lastOpts?.role);
  // --cwd is proven by the real child: it wrote its actual working directory.
  {
    const { readFileSync, realpathSync } = await import("node:fs");
    let reported = "";
    for (let i = 0; i < 50 && !reported; i++) {
      try {
        reported = readFileSync(cwdReport, "utf8");
      } catch {
        await sleep(100);
      }
    }
    ok("--cwd rooted the real process there", realpathSync(reported) === realpathSync(agentCwd), { reported, agentCwd });
  }

  // B — ps shows it; stop tears it down; ps empties.
  const psOut = await capture(() => run("ps", ["--space", SPACE]));
  ok("ps lists the detached agent under its OVERRIDDEN identity", /bard/.test(psOut) && !/poet/.test(psOut), psOut);

  // B2 (#651, #905): the same rows, three presentations. BARE is a table with one compact identity
  // row per seat, including model and optional requested variant. WIDE is one labeled record per
  // seat that adds the EXTRA operational facts without repeating that identity; pid is real and
  // uid/instance/host attribute the seat. JSON is one envelope whose items are the manager's rows
  // verbatim, fields equal to what the launch sent.
  const psBare2 = await capture(() => run("ps", ["--space", SPACE]));
  // The table is the block under the Agents heading, up to the blank line before Next.
  const bareLines = (psBare2.split("\nAgents\n")[1] ?? "").split("\n\n")[0]!.split("\n").map((line) => line.trim());
  ok("bare ps stays compact and includes model plus requested variant identity",
    bareLines.length === 2 && /^NAME\s+AGENT\s+PROCESS\s+MESH/.test(bareLines[0] ?? "") && /e2e · fancy \(high\) · pty/.test(bareLines[1] ?? ""), psBare2);
  const psWide = await capture(() => run("ps", ["--space", SPACE, "--wide"]));
  ok("ps --wide adds operational facts without duplicating model or requested variant",
    /agent:\s+e2e · fancy \(high\) · pty/.test(psWide) && !/model:?\s+fancy/.test(psWide) && /pid:\s+\d+/.test(psWide) && /uid:\s+[a-z0-9]{26,}/.test(psWide) && /instance:\s+[a-z0-9]{26,}/.test(psWide) && /host:\s+\S/.test(psWide), psWide);
  const psJson = await capture(() => run("ps", ["--space", SPACE, "--json"]));
  let psEnvelope: { outcome?: string; result?: { items?: Record<string, unknown>[] } } | undefined;
  try { psEnvelope = JSON.parse(psJson); } catch { /* graded below */ }
  const jsonRow = psEnvelope?.result?.items?.find((row) => row.name === "bard");
  ok("ps --json is one envelope whose items carry the manager's row verbatim",
    psEnvelope?.outcome === "ok" && psJson.trim().split("\n").length === 1 && jsonRow !== undefined && jsonRow.model === "fancy" && jsonRow.variant === "high" && typeof jsonRow.pid === "number" && typeof jsonRow.lifecycleUid === "string" && typeof jsonRow.cwd === "string", psJson);

  // B3 (#651, #905): a variant WITHOUT a model survives in the compact identity and JSON. The wide
  // continuation must not repeat it now that provenance lives in the identity row.
  writeFileSync(join(workspaceRoot, ".cotal", "agents", "lutist.md"), "---\nname: lutist\nrole: writer\nvariant: high\n---\nYou play.\n");
  await capture(() => run("spawn", ["lutist", "--detach", "--no-events", "--agent", "e2e", "--space", SPACE, "--name", "lutist"]));
  let lutWide = "";
  for (let i = 0; i < 40 && !/lutist/.test(lutWide); i++) {
    lutWide = await capture(() => run("ps", ["--space", SPACE, "--wide"]));
    if (!/lutist/.test(lutWide)) await sleep(250);
  }
  // Each seat is one record; the identity is its agent field and the operational facts follow it.
  const lutRecord = lutWide.split("\n\n").find((record) => /name:\s+lutist/.test(record)) ?? "";
  const lutFacts = lutRecord.split("\n").filter((line) => !/^\s*(name|agent|process|mesh|auth):/.test(line)).join("\n");
  ok("ps --wide keeps a variant-without-model in identity and out of operational facts",
    /agent:\s+e2e · variant high · pty/.test(lutRecord) && !/variant high|model/.test(lutFacts), lutWide);
  const lutJsonOut = await capture(() => run("ps", ["--space", SPACE, "--json"]));
  let lutJson: Record<string, unknown> | undefined;
  try { lutJson = (JSON.parse(lutJsonOut) as { result: { items: Record<string, unknown>[] } }).result.items.find((row) => row.name === "lutist"); } catch { /* graded below */ }
  ok("ps --json carries the variant and omits model for a variant-only pin",
    lutJson?.variant === "high" && !("model" in (lutJson ?? {})), lutJsonOut);
  // Tear lutist down so it does not linger into the single-seat teardown assertion below.
  await capture(() => run("stop", ["--name", "lutist", "--space", SPACE]));

  // C — attach replies the pinned ws:// contract and the socket opens. One-shot ep client over
  // core (the same wire the CLI's askManagerEp uses: inspect resolves the wire target, then the
  // targeted attach rides the manager's v0.4 service endpoint — the open-mesh bare-caller shape).
  const ep = new CotalEndpoint({
    space: SPACE,
    servers: SERVER,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    card: { name: "e2e-cli", kind: "endpoint" },
  });
  await ep.start();
  let attachReply: ControlReply;
  try {
    const info = await ep.invokeService("manager", "inspect", { name: "bard" });
    if (info.reply.ok !== true) throw new Error(`inspect could not resolve bard: ${info.reply.error?.message ?? info.reply.error?.code}`);
    const row = info.reply.data as { id: string; lifecycleUid: string };
    // A static/open row's `id` is the bare actor under the caller's own owner; a user-mode row's
    // is the composite `owner.actor` — split only when the dot is there (the CLI's exact guard).
    const dot = row.id.indexOf(".");
    const [tOwner, tActor] = dot > 0 ? [row.id.slice(0, dot), row.id.slice(dot + 1)] : [ep.principal.owner, row.id];
    // Operator reach: this one-shot client is NOT bard's spawner, so owner-mode's spawner-bound
    // privileged semantics refuse it — the instrument rides ANY-mode (the CLI's non-bearer
    // `reach: "any"` shape; on an open mesh the serve side admits it as the old single-trusted-host).
    const r = await ep.invokeService("manager", "attach", undefined, {
      target: { mode: "any", owner: tOwner, actor: tActor, lifecycleUid: row.lifecycleUid },
    });
    attachReply = r.reply.ok === true ? { ok: true, ...(r.reply.data !== undefined ? { data: r.reply.data } : {}) } : { ok: false, error: r.reply.error?.message ?? r.reply.error?.code };
  } finally {
    await ep.stop();
  }
  ok("attach reply ok", attachReply.ok === true, attachReply);
  // P2 item 6: attach replies the holder-bound §13.6 session grant, NOT a 127.0.0.1 ws:// URL.
  const grant = (attachReply.data as { grant?: SessionGrant })?.grant;
  ok("attach replies a holder-bound §13.6 session grant (no ws:// URL)",
    typeof grant?.sessionId === "string" && typeof grant.subjects?.in === "string" && (attachReply.data as { ws?: unknown }).ws === undefined, attachReply.data);
  ok("the grant names an eps session rail and carries NO 127.0.0.1 anywhere",
    /^cotal\..+\.eps\.manager\./.test(grant?.subjects?.in ?? "") && !JSON.stringify(grant ?? {}).includes("127.0.0.1"), grant?.subjects);
  // Redeem it over the MESH (open mesh: a bare connection): the caller rail opens on the real broker
  // and completes the `ready` handshake — the item-6 replacement for the loopback WebSocket, end to end.
  const rnc = await connect({ servers: SERVER });
  let railErr: string | undefined;
  const rail = openSessionRail({
    nc: rnc, grant: grant!, role: "caller",
    onData: () => {}, onClose: () => {}, onProtocolError: (r: string) => { railErr = r; },
  });
  await rnc.flush();
  let ready = false;
  try { rail.send({ k: "ready" }); ready = true; } catch (e) { railErr = (e as Error).message; }
  await sleep(500);
  ok("the mesh caller rail opens + handshakes over the real broker (no ws, no 127.0.0.1)", ready && railErr === undefined, railErr);
  rail.close();
  await rnc.drain().catch(() => rnc.close());

  const stopOut = await capture(() => run("stop", ["--name", "bard", "--space", SPACE]));
  ok("stop reports the acknowledged stop", stopped(stopOut, "bard"), stopOut);
  const psAfter = await capture(() => run("ps", ["--space", SPACE]));
  ok("ps is empty after stop", NO_AGENTS.test(psAfter), psAfter);

  // D — COTAL_DEFAULT_PERSONA supplies the persona for a bare detached spawn. The identity still
  // comes from --name, so this proves persona selection and identity override stay separate.
  {
    const prev = process.env.COTAL_DEFAULT_PERSONA;
    process.env.COTAL_DEFAULT_PERSONA = "poet";
    try {
      lastOpts = undefined as LaunchOpts | undefined; // the connector reassigns it from a callback
      const envOut = await capture(() => run("spawn", ["--detach", "--no-events", "--agent", "e2e", "--space", SPACE, "--name", "envbard"]));
      ok("COTAL_DEFAULT_PERSONA bare detached spawn reached the connector", lastOpts !== undefined);
      ok(
        "COTAL_DEFAULT_PERSONA picked poet while --name set identity",
        joinedAs(envOut, "envbard") && lastOpts?.name === "envbard" && lastOpts?.role === "writer",
        { envOut, name: lastOpts?.name, role: lastOpts?.role },
      );
      const envStop = await capture(() => run("stop", ["--name", "envbard", "--space", SPACE]));
      ok("COTAL_DEFAULT_PERSONA spawned agent stops", stopped(envStop, "envbard"), envStop);
    } finally {
      if (prev === undefined) delete process.env.COTAL_DEFAULT_PERSONA;
      else process.env.COTAL_DEFAULT_PERSONA = prev;
    }
  }

  // G — a persona the manager cannot find is refused before anything ran, so the CLI reports a
  // refusal (exit 2) carrying the manager's own reason and naming the file it looked for. An
  // unknown outcome here would tell the operator to inspect a launch that never happened.
  {
    lastOpts = undefined as LaunchOpts | undefined;
    let failure: unknown;
    try {
      await capture(() => run("spawn", ["ghost", "--detach", "--no-events", "--agent", "e2e", "--space", SPACE]));
    } catch (e) {
      failure = e;
    }
    const seen = isCommandFailure(failure) ? { outcome: failure.outcome, code: failure.code, message: failure.message, native: failure.native } : String(failure);
    ok("a missing persona is a refusal the manager stated before execution, exit 2",
      isCommandFailure(failure) && failure.outcome === "refused" && failure.native?.outcome === "not-executed" && exitCode(failure.outcome, failure.code) === 2, seen);
    const missing = join(workspaceRoot, ".cotal", "agents", "ghost.md");
    ok("...it shows the manager's reason, naming the persona file it looked for",
      isCommandFailure(failure) && failure.message.includes('no persona "ghost"') && failure.message.includes(missing) && !failure.message.includes("\n"), seen);
    ok("...and nothing launched", lastOpts === undefined, lastOpts?.name);
    const psRefused = await capture(() => run("ps", ["--space", SPACE]));
    ok("...and ps is still empty", NO_AGENTS.test(psRefused), psRefused);
  }

  // I — an agent whose process exits at once is a launch the manager reports failed. The CLI says so
  // with the manager's reason, OPERATION_FAILED, exit 5, never as an unknown outcome.
  {
    let failure: unknown;
    try {
      await capture(() => run("spawn", ["poet", "--detach", "--no-events", "--agent", "e2e-exit", "--space", SPACE, "--name", "quitter"]));
    } catch (e) {
      failure = e;
    }
    const seen = isCommandFailure(failure) ? { outcome: failure.outcome, code: failure.code, message: failure.message, native: failure.native } : String(failure);
    ok("an agent that exits at once fails OPERATION_FAILED, exit 5",
      isCommandFailure(failure) && failure.outcome === "failed" && failure.code === "OPERATION_FAILED" && exitCode(failure.outcome, failure.code) === 5, seen);
    ok("...with the manager's reason and the agent's last output",
      isCommandFailure(failure) && failure.message.includes("quitter exited on launch") && failure.message.includes("e2e-exit quits"), seen);
    const psExited = await capture(() => run("ps", ["--space", SPACE]));
    ok("...and nothing is left running", NO_AGENTS.test(psExited), psExited);
  }

  // E/F run TRUE subprocesses through bin/cotal.ts with `extensions: true`, so the sandbox must
  // cover the OPERATOR config dir too (the installed-extensions prefix lives under
  // `$XDG_CONFIG_HOME/cotal`, NOT COTAL_HOME): the operator's real store holds npm-published
  // connectors built against the RELEASED core, and in the pre-release window their import
  // fail-louds against this worktree's core (the designed skew refusal) before the arg
  // validation under test is ever reached. The seed stays skipped so nothing npm-installs into
  // the sandbox either. Customers never see this state (the lockstep release publishes core +
  // connectors together).
  const subEnv = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1" };

  // E — the start tombstone (true subprocess through bin/cotal.ts, i.e. built dist).
  const tomb = spawnSync(TSX, [join(import.meta.dirname, "..", "cotal.ts"), "start", "--name", "x"], {
    encoding: "utf8",
    env: subEnv,
  });
  ok("tombstone exits non-zero", tomb.status === 1, tomb.status);
  ok("tombstone names spawn --detach", /spawn --detach/.test(tomb.stderr), tomb.stderr.slice(0, 200));

  // H — a spawn in this terminal checks its persona and connector before it says it is starting the
  // application, and refuses each with the full block: code, Next and exit 2.
  const direct = (...words: string[]) => spawnSync(TSX, [join(import.meta.dirname, "..", "cotal.ts"), "spawn", ...words, "--space", SPACE], { encoding: "utf8", env: subEnv });
  const noPersona = direct("ghostly");
  ok("a bare spawn of a missing persona refuses TARGET_NOT_FOUND, exit 2, before the Direct application banner",
    noPersona.status === 2 && /no persona "ghostly" in /.test(noPersona.stderr) && /Code:\s+TARGET_NOT_FOUND/.test(noPersona.stderr) && /^Next$/m.test(noPersona.stderr) && !/Direct application/.test(noPersona.stderr), noPersona.stderr.slice(0, 600));
  const noConnector = direct("poet", "--harness", "nosuch");
  ok("a bare spawn whose harness has no connector refuses DEPENDENCY_UNAVAILABLE, exit 2, naming cotal ext add, before the banner",
    noConnector.status === 2 && /no connector "nosuch" is installed/.test(noConnector.stderr) && /Code:\s+DEPENDENCY_UNAVAILABLE/.test(noConnector.stderr) && /cotal ext add <npm-package>/.test(noConnector.stderr) && !/Direct application/.test(noConnector.stderr), noConnector.stderr.slice(0, 600));

  // J — a FOREGROUND launch on a manager whose runtime streams no terminal. The launch is complete
  // and the command is done: no attach is attempted, nothing is partial, and the receipt says where
  // the seat runs and what reaches it. Before this, the CLI launched the agent and then asked for a
  // terminal attach the runtime cannot open, which came back OPERATION_PARTIAL on a launch that had
  // in fact done everything the runtime allows, with a Next telling the operator to reattach.
  //
  // `isTTY` is forced for the foreground launch alone, and only to pass the argument check that a
  // foreground managed launch runs at a terminal: it reads no key, and the attach this cell is
  // about is the one that must NOT happen. It is restored before `attach` runs, which at a stdin
  // that is not really a terminal would reach for raw mode. The pty arm is the same launch on the
  // other manager: its reply says the terminal IS there, so nothing skips an attach of its own.
  {
    const root2 = mkdtempSync(join(tmpdir(), "cotal-detach-ws2-"));
    mkdirSync(join(root2, ".cotal", "agents"), { recursive: true });
    writeFileSync(join(root2, ".cotal", "agents", "poet.md"), "---\nname: poet\nrole: writer\n---\nYou write verse.\n");
    const mgr2 = new Manager({ space: SPACE, servers: SERVER, runtime: "e2e-nostream", workspaceRoot: root2 });
    await mgr2.start();
    const on2 = (mgr2 as unknown as { managerInstanceId: string }).managerInstanceId;
    const on1 = (mgr as unknown as { managerInstanceId: string }).managerInstanceId;
    const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY };
    const atTerminal = <T>(fn: () => Promise<T>): Promise<T> => {
      Object.assign(process.stdin, { isTTY: true });
      Object.assign(process.stdout, { isTTY: true });
      return fn().finally(() => {
        Object.assign(process.stdin, { isTTY: tty.in });
        Object.assign(process.stdout, { isTTY: tty.out });
      });
    };
    try {
      // The DETACHED launch first, as the baseline: a manager attaches to its own seats to read
      // readiness and to watch for the exit (both are caught where a runtime streams nothing), so
      // the bare count says nothing on its own. The foreground launch below must add none of its
      // own to it. The same launch also carries the answer over the wire, for a caller that reads
      // the envelope rather than the report.
      const beforeDetached = attachCalls;
      const fgJson = await capture(() => run("spawn", ["poet", "--detach", "--no-events", "--agent", "e2e", "--space", SPACE, "--name", "pane2", "--on", on2, "--json"]));
      const managerOwn = attachCalls - beforeDetached;
      const paneResult = (JSON.parse(fgJson) as { result: { runtime: string; streamsTerminal: boolean | null } }).result;
      ok("--json names the runtime and that it streams no terminal", paneResult.runtime === "e2e-nostream" && paneResult.streamsTerminal === false, paneResult);
      const before = attachCalls;
      // Forcing `isTTY` also turns the report's color on, so the receipt is read without it.
      const fgOut = plain(await atTerminal(() => capture(() => run("spawn", ["poet", "--no-events", "--agent", "e2e", "--space", SPACE, "--name", "pane", "--on", on2]))));
      ok("a foreground launch on a runtime with no terminal joins and returns", joinedAs(fgOut, "pane"), fgOut);
      ok("and asks for no attach the detached launch did not also make", attachCalls - before === managerOwn, { foreground: attachCalls - before, detached: managerOwn });
      ok("nothing about it is partial", !/Partly completed|OPERATION_PARTIAL/.test(fgOut), fgOut);
      ok("its receipt names the runtime as streaming no terminal", /Runtime:\s+e2e-nostream [·-] no terminal stream/.test(fgOut), fgOut);
      ok("and says where the seat runs instead of claiming a view", /View:\s+not attached; the seat runs in the manager's e2e-nostream session/.test(fgOut), fgOut);
      ok("its Next names what reaches the agent without a terminal", /watch --space/.test(fgOut) && /send -t pane/.test(fgOut), fgOut);
      ok("and says once that attach is not available here", /attach is not available here: the e2e-nostream runtime streams no terminal\./.test(fgOut), fgOut);
      const ptyJson = await capture(() => run("spawn", ["poet", "--detach", "--no-events", "--agent", "e2e", "--space", SPACE, "--name", "ptyseat", "--on", on1, "--json"]));
      ok("a pty manager reports the terminal it does have, so nothing skips its attach", (JSON.parse(ptyJson) as { result: { streamsTerminal: boolean | null } }).result.streamsTerminal === true, ptyJson);
      // And `attach` on such a seat refuses once, by the runtime's own guidance, naming what does
      // reach it — never "inspect and reattach", which that runtime cannot do either.
      let refusal: { code?: string; message?: string; remedy?: string } | undefined;
      try { await run("attach", ["pane", "--space", SPACE, "--on", on2, "--no-reconnect"]); }
      catch (e) { refusal = e as { code?: string; message?: string; remedy?: string }; }
      const said = { code: refusal?.code, message: refusal?.message, remedy: refusal?.remedy };
      ok("attach on that seat is refused UNSUPPORTED, not as a lifecycle condition to retry", refusal?.code === "UNSUPPORTED", said);
      ok("the refusal carries the runtime's own guidance", /e2e-nostream runtime: watch this agent where it runs/.test(refusal?.message ?? ""), said);
      ok("and its Next names the mesh, never a reattach", /send -t pane/.test(refusal?.remedy ?? "") && !/reattach/.test(refusal?.remedy ?? ""), said);
      for (const name of ["pane", "pane2", "ptyseat"]) await capture(() => run("stop", ["--name", name, "--space", SPACE]));
    } finally {
      await mgr2.stop().catch(() => {});
    }
  }

  // K — a foreground launch on a manager from before 0.104.2, which does not report whether its
  // runtime streams a terminal, so the CLI finds out by attaching. The stand-in is this manager with
  // that release's two differences: its launch reply carries no `streamsTerminal`, and once `oldDoor`
  // is set its attach door refuses a runtime whose attach() throws as a lifecycle precondition, with
  // the runtime's own text and no marker. Each launch below used to end OPERATION_PARTIAL with no
  // reason and a Next to "reattach".
  {
    const root3 = mkdtempSync(join(tmpdir(), "cotal-detach-ws3-"));
    mkdirSync(join(root3, ".cotal", "agents"), { recursive: true });
    writeFileSync(join(root3, ".cotal", "agents", "poet.md"), "---\nname: poet\nrole: writer\n---\nYou write verse.\n");
    const mgr3 = new Manager({ space: SPACE, servers: SERVER, runtime: "e2e-nostream", workspaceRoot: root3 });
    const startAgent = mgr3.startAgent.bind(mgr3);
    mgr3.startAgent = (opts, spawner, hooks, caller) => startAgent(opts, spawner, hooks && {
      ...hooks,
      onOutcome: (o) => {
        if (o.kind !== "succeeded") return hooks.onOutcome?.(o);
        const { streamsTerminal: _unreported, ...data } = o.data as Record<string, unknown>;
        return hooks.onOutcome?.({ ...o, data });
      },
    }, caller);
    let oldDoor = false;
    const door = mgr3 as unknown as { attachAuthorized: (a: { handle: AgentHandle }, caller: unknown) => Promise<ControlReply> };
    const attachAuthorized = door.attachAuthorized.bind(mgr3);
    door.attachAuthorized = async (a, caller) => {
      if (!oldDoor) return attachAuthorized(a, caller);
      try { a.handle.attach(); } catch (e) { throw new EpEnvelopeError("failed-precondition", (e as Error).message, undefined, "not-executed"); }
      throw new Error("the stand-in serves no terminal");
    };
    await mgr3.start();
    const on3 = (mgr3 as unknown as { managerInstanceId: string }).managerInstanceId;
    const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY };
    const exitBefore = process.exitCode;
    /** Run `fn` at a forced terminal, returning stdout, stderr and the failure it threw, if any.
     *  These launches do attach, and the attach's detach-key reader puts the terminal in raw mode,
     *  which a stdin that is not really a terminal cannot do: the forced one takes it as a no-op. */
    const foreground = async (fn: () => Promise<void>): Promise<{ out: string; err: string; failure: unknown }> => {
      let err = "", failure: unknown;
      const realError = console.error;
      const rawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
      console.error = (...a: unknown[]) => void (err += a.join(" ") + "\n");
      Object.assign(process.stdin, { isTTY: true, setRawMode: () => process.stdin });
      Object.assign(process.stdout, { isTTY: true });
      try {
        const out = await capture(() => fn().catch((e: unknown) => { failure = e; }));
        return { out: plain(out), err: plain(err), failure };
      } finally {
        console.error = realError;
        if (rawMode) Object.defineProperty(process.stdin, "setRawMode", rawMode);
        else delete (process.stdin as { setRawMode?: unknown }).setRawMode;
        Object.assign(process.stdin, { isTTY: tty.in });
        Object.assign(process.stdout, { isTTY: tty.out });
      }
    };
    try {
      const reportJson = await capture(() => run("spawn", ["poet", "--detach", "--no-events", "--agent", "e2e", "--space", SPACE, "--name", "oldpane0", "--on", on3, "--json"]));
      ok("the stand-in reports no terminal answer, so the CLI reads null", (JSON.parse(reportJson) as { result: { streamsTerminal: unknown } }).result.streamsTerminal === null, reportJson);

      // Its refusal carries the marker: the seat's runtime streams no terminal.
      process.exitCode = undefined;
      const marked = await foreground(() => run("spawn", ["poet", "--no-events", "--agent", "e2e", "--space", SPACE, "--name", "oldpane1", "--on", on3]));
      ok("a marked no-terminal refusal ends the launch with the agent joined and exit 0", marked.failure === undefined && joinedAs(marked.out, "oldpane1") && (process.exitCode ?? 0) === 0, { ...marked, exitCode: process.exitCode });
      ok("and says once that the named runtime has no terminal to attach", /the e2e-nostream runtime has no terminal to attach, so none was opened; the agent runs in the manager's e2e-nostream session/.test(marked.err) && !/Partly completed|OPERATION_PARTIAL/.test(marked.out + marked.err), marked);

      // The unmarked refusal of a manager before 0.104.2, on a runtime this CLI's registry declares
      // streams no terminal. The launch still asks once; the manager's own attaches are the baseline.
      oldDoor = true;
      const beforeDetached = attachCalls;
      await capture(() => run("spawn", ["poet", "--detach", "--no-events", "--agent", "e2e", "--space", SPACE, "--name", "oldpane2", "--on", on3]));
      const managerOwn = attachCalls - beforeDetached;
      const before = attachCalls;
      process.exitCode = undefined;
      const unmarked = await foreground(() => run("spawn", ["poet", "--no-events", "--agent", "e2e", "--space", SPACE, "--name", "oldpane3", "--on", on3]));
      ok("an old manager's unmarked refusal on a no-terminal runtime ends the launch, exit 0", unmarked.failure === undefined && joinedAs(unmarked.out, "oldpane3") && (process.exitCode ?? 0) === 0, { ...unmarked, exitCode: process.exitCode });
      ok("it names the runtime and is not partial", /the e2e-nostream runtime has no terminal to attach/.test(unmarked.err) && !/Partly completed|OPERATION_PARTIAL/.test(unmarked.out + unmarked.err), unmarked);
      ok("and it found out by asking the manager once", attachCalls - before === managerOwn + 1, { foreground: attachCalls - before, detached: managerOwn });

      // A real attach failure on a runtime that declares a terminal stays partial, and says why.
      const broken = await foreground(() => run("spawn", ["poet", "--no-events", "--agent", "e2e", "--space", SPACE, "--name", "brokenseat", "--on", on3, "--runtime", "e2e-brokenstream"]));
      const failure = broken.failure;
      ok("a real attach failure after the launch is OPERATION_PARTIAL, exit 4", isCommandFailure(failure) && failure.code === "OPERATION_PARTIAL" && exitCode(failure.outcome, failure.code) === 4 && joinedAs(broken.out, "brokenseat"), { out: broken.out, failure: String(failure) });
      if (!isCommandFailure(failure)) throw new Error("unreachable");
      const reason = 'e2e-brokenstream runtime: the terminal of "brokenseat" could not be opened';
      ok("its envelope carries the manager's reason as error.cause.detail", failure.detail().cause?.detail === reason, failure.detail());
      const report = renderReport(commandFailureReport(failure), "plain", 400);
      ok("and its report prints that reason as a Native detail row", report.split("\n").some((line) => /^\s*Native detail:\s/.test(line) && line.includes(reason)), report);
      ok("its Next names ps and attach with the real space and manager instance, never a bare reattach",
        failure.remedy?.includes(`ps --space ${SPACE} --on ${on3}`) === true && failure.remedy.includes(`attach brokenseat --space ${SPACE} --on ${on3}`) && !/reattach/.test(failure.remedy), failure.remedy);
      for (const name of ["oldpane0", "oldpane1", "oldpane2", "oldpane3", "brokenseat"]) await capture(() => run("stop", ["--name", name, "--space", SPACE]));
    } finally {
      process.exitCode = exitBefore;
      await mgr3.stop().catch(() => {});
    }
  }

  // F — direct foreground (`--foreground`) with --creds fails loud. A foreground spawn REQUIRES its connector materialized
  // pre-dispatch (spawnRequiredExtensions), so first `ext add` THIS WORKTREE's claude connector
  // into the sandbox prefix (the real local-path install + core peer-link path) — never the
  // operator's global store.
  const extAdd = spawnSync(TSX, [join(import.meta.dirname, "..", "cotal.ts"), "ext", "add", join(import.meta.dirname, "..", "..", "extensions", "connector-claude-code")],
    { encoding: "utf8", env: subEnv },
  );
  ok("sandbox ext add of the worktree claude connector succeeds", extAdd.status === 0, (extAdd.stderr + extAdd.stdout).slice(0, 300));
  const fg = spawnSync(TSX, [join(import.meta.dirname, "..", "cotal.ts"), "spawn", "poet", "--foreground", "--creds", "/tmp/x.creds"], {
    encoding: "utf8",
    env: subEnv,
  });
  ok("foreground --creds exits non-zero", fg.status === 1, fg.status);
  ok("foreground --creds is refused as a manager credential", /a spawn in this terminal takes no .*manager credential/.test(fg.stderr), fg.stderr.slice(0, 200));
  // A bare spawn is the spawn in this terminal: without -d or --on no manager is asked, so the same
  // manager credential is refused the same way, not as a managed attachment without terminals.
  const bare = spawnSync(TSX, [join(import.meta.dirname, "..", "cotal.ts"), "spawn", "poet", "--creds", "/tmp/x.creds"], {
    encoding: "utf8",
    env: subEnv,
  });
  ok("a bare spawn runs in this terminal, so --creds without -d is refused as a manager credential", bare.status === 1 && /a spawn in this terminal takes no .*manager credential/.test(bare.stderr) && !/managed attachment|attaching to a manager/.test(bare.stderr), bare.stderr.slice(0, 300));

  console.log(`\nspawn-detach live e2e: ${pass} checks passed`);
} finally {
  await mgr?.stop().catch(() => {});
  console.log("spawn-detach:live manager-stop-returned");
  await Promise.all(kids.map((k) => {
    k.kill("SIGKILL");
    return awaitExit(k);
  }));
  releaseBroker?.();
  console.log("spawn-detach:live finally-complete");
}
