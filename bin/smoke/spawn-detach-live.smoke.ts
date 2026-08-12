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
 *  E. the `start` tombstone errors, naming `spawn --detach` (subprocess through bin/cotal.ts).
 *  F. foreground `--creds` (no --detach) fails loud (subprocess).
 *
 * COTAL_HOME is sandboxed; kills ONLY the PIDs it spawns. Needs nats-server on PATH.
 * Run: pnpm smoke:spawn-detach:live   (build first — bin/cotal.ts subprocess checks run dist)
 */
import { spawn as spawnProc, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** An ephemeral, collision-safe loopback port (ask the OS for a free one, then release it). */
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
/** Resolve once the child has actually exited (or immediately if it already has); bounded by ms. */
const awaitExit = (p: ChildProcess, ms = 5000): Promise<void> =>
  new Promise((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r();
    p.once("exit", () => r());
    setTimeout(r, ms).unref?.();
  });

const home = mkdtempSync(join(tmpdir(), "cotal-detach-home-"));
process.env.COTAL_HOME = home;

const { parseCommandArgs, probeConnect, registry, CotalEndpoint, openSessionRail } = await import("@cotal-ai/core");
const { connect } = await import("@nats-io/transport-node");
const { recordMesh } = await import("@cotal-ai/workspace");
await import("@cotal-ai/cli"); // registers the CLI commands (spawn/stop/ps/attach) into the registry
const { Manager } = await import("@cotal-ai/manager");
import type { Command, Connector, ControlReply, LaunchOpts, SessionGrant } from "@cotal-ai/core";

let pass = 0;
const kids: ChildProcess[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const cmd = (name: string): Command => {
  const c = registry.all<Command>("command").find((c) => c.name === name);
  if (!c) throw new Error(`command ${name} not registered`);
  return c;
};
/** Run a REAL CLI command exactly as the dispatcher would: kernel-parsed argv → run(). */
const run = (name: string, argv: string[]) => cmd(name).run(parseCommandArgs(cmd(name), argv));
/** Capture console.log output of a run (ps prints rows). */
async function capture(fn: () => Promise<void>): Promise<string> {
  let out = "";
  const real = console.log;
  console.log = (...a: unknown[]) => void (out += a.join(" ") + "\n");
  try {
    await fn();
  } finally {
    console.log = real;
  }
  return out;
}

let mgr: InstanceType<typeof Manager> | undefined;
try {
  // Real broker (open mode — authed control ops are covered by smoke:control-auth; this e2e is
  // about the CLI↔manager grammar) + registry entry so the CLI resolver finds the mesh.
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", mkdtempSync(join(tmpdir(), "cotal-detach-js-"))], { stdio: "ignore" });
  kids.push(broker);
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
      "poet", "--detach", "--agent", "e2e", "--space", SPACE, "--name", "bard",
      "--prompt", "compose", "--subscribe", "ops,ops.x", "--allow-subscribe", "ops,ops.>",
      "--allow-publish", "ops", "--model", "fancy", "--variant", "high", "--opt", "temperature=0.2", "--opt", "seed=7",
      "--cwd", agentCwd, "--share-tools", "alpha",
    ]),
  );
  ok("detached spawn reached the connector", lastOpts !== undefined);
  ok("identity override joined as bard, not the file's poet", /spawned .*bard/.test(spawnOut) && lastOpts?.name === "bard", { spawnOut, name: lastOpts?.name });
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
  ok("stop reports ✓", /stopped bard/.test(stopOut), stopOut);
  const psAfter = await capture(() => run("ps", ["--space", SPACE]));
  ok("ps is empty after stop", /no managed agents/.test(psAfter), psAfter);

  // D — COTAL_DEFAULT_PERSONA supplies the persona for a bare detached spawn. The identity still
  // comes from --name, so this proves persona selection and identity override stay separate.
  {
    const prev = process.env.COTAL_DEFAULT_PERSONA;
    process.env.COTAL_DEFAULT_PERSONA = "poet";
    try {
      lastOpts = undefined;
      const envOut = await capture(() => run("spawn", ["--detach", "--agent", "e2e", "--space", SPACE, "--name", "envbard"]));
      ok("COTAL_DEFAULT_PERSONA bare detached spawn reached the connector", lastOpts !== undefined);
      ok(
        "COTAL_DEFAULT_PERSONA picked poet while --name set identity",
        /spawned .*envbard/.test(envOut) && lastOpts?.name === "envbard" && lastOpts?.role === "writer",
        { envOut, name: lastOpts?.name, role: lastOpts?.role },
      );
      const envStop = await capture(() => run("stop", ["--name", "envbard", "--space", SPACE]));
      ok("COTAL_DEFAULT_PERSONA spawned agent stops", /stopped envbard/.test(envStop), envStop);
    } finally {
      if (prev === undefined) delete process.env.COTAL_DEFAULT_PERSONA;
      else process.env.COTAL_DEFAULT_PERSONA = prev;
    }
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
  const tomb = spawnSync("npx", ["tsx", join(import.meta.dirname, "..", "cotal.ts"), "start", "--name", "x"], {
    encoding: "utf8",
    env: subEnv,
  });
  ok("tombstone exits non-zero", tomb.status === 1, tomb.status);
  ok("tombstone names spawn --detach", /spawn --detach/.test(tomb.stderr), tomb.stderr.slice(0, 200));

  // F — foreground --creds fails loud. A foreground spawn REQUIRES its connector materialized
  // pre-dispatch (spawnRequiredExtensions), so first `ext add` THIS WORKTREE's claude connector
  // into the sandbox prefix (the real local-path install + core peer-link path) — never the
  // operator's global store.
  const extAdd = spawnSync(
    "npx",
    ["tsx", join(import.meta.dirname, "..", "cotal.ts"), "ext", "add", join(import.meta.dirname, "..", "..", "extensions", "connector-claude-code")],
    { encoding: "utf8", env: subEnv },
  );
  ok("sandbox ext add of the worktree claude connector succeeds", extAdd.status === 0, (extAdd.stderr + extAdd.stdout).slice(0, 300));
  const fg = spawnSync("npx", ["tsx", join(import.meta.dirname, "..", "cotal.ts"), "spawn", "poet", "--creds", "/tmp/x.creds"], {
    encoding: "utf8",
    env: subEnv,
  });
  ok("foreground --creds exits non-zero", fg.status === 1, fg.status);
  ok("foreground --creds names --detach", /only valid with --detach/.test(fg.stderr), fg.stderr.slice(0, 200));

  console.log(`\nspawn-detach live e2e: ${pass} checks passed`);
} finally {
  await mgr?.stop().catch(() => {});
  await Promise.all(kids.map((k) => {
    k.kill("SIGKILL");
    return awaitExit(k);
  }));
}
