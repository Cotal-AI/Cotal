/**
 * LIVE e2e for the merged launch grammar (CLI rework stage 2a): a REAL nats-server on an isolated
 * port, a REAL manager (real pty runtime — the spawned "agent" is a node keepalive, not a Claude
 * cold-start), and the REAL CLI command functions parsed through the REAL kernel specs:
 *
 *  A. `spawn --detach <persona> --prompt/--subscribe/--share-tools` → control plane → manager
 *     spawns it; the overrides arrive in the connector's LaunchOpts (flags > persona, e2e).
 *  B. `ps` lists the managed agent; `stop --name` tears it down; `ps` is empty again.
 *  C. `attach` replies a loopback ws:// URL and the socket actually opens (the pinned contract).
 *  D. the `start` tombstone errors, naming `spawn --detach` (subprocess through bin/cotal.ts).
 *  E. foreground `--creds` (no --detach) fails loud (subprocess).
 *
 * COTAL_HOME is sandboxed; kills ONLY the PIDs it spawns. Needs nats-server on PATH.
 * Run: pnpm smoke:spawn-detach:live   (build first — bin/cotal.ts subprocess checks run dist)
 */
import { spawn as spawnProc, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-detach-home-"));
process.env.COTAL_HOME = home;

const { parseCommandArgs, probeConnect, registry, CotalEndpoint, CONTROL_ADMIN } = await import("@cotal-ai/core");
const { recordMesh } = await import("@cotal-ai/workspace");
await import("@cotal-ai/cli"); // registers the CLI commands (spawn/stop/ps/attach) into the registry
const { Manager } = await import("@cotal-ai/manager");
import type { Command, Connector, ControlReply, LaunchOpts } from "@cotal-ai/core";

let pass = 0;
const kids: ChildProcess[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = 14461;
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
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,channels:[],consume:false,registerPresence:true,watchPresence:false,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});",
  "ep.on('error',()=>{});await ep.start();",
  "require('fs').writeFileSync(process.env.CWD_OUT,process.cwd());",
  "setInterval(()=>{},1000);});",
].join("");
let lastOpts: LaunchOpts | undefined;
const e2eCon: Connector = {
  kind: "connector",
  name: "e2e",
  requires: ["node"],
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
      "--allow-publish", "ops", "--model", "fancy", "--cwd", agentCwd, "--share-tools", "alpha",
    ]),
  );
  ok("detached spawn reached the connector", lastOpts !== undefined);
  ok("identity override joined as bard, not the file's poet", /spawned .*bard/.test(spawnOut) && lastOpts?.name === "bard", { spawnOut, name: lastOpts?.name });
  ok("prompt rode the control plane", lastOpts?.prompt === "compose", lastOpts?.prompt);
  ok("subscribe override beat the persona file", JSON.stringify(lastOpts?.subscribe) === JSON.stringify(["ops", "ops.x"]), lastOpts?.subscribe);
  ok("allow-subscribe override arrived", JSON.stringify(lastOpts?.allowSubscribe) === JSON.stringify(["ops", "ops.>"]), lastOpts?.allowSubscribe);
  ok("allow-publish override arrived", JSON.stringify(lastOpts?.allowPublish) === JSON.stringify(["ops"]), lastOpts?.allowPublish);
  ok("model override arrived", lastOpts?.model === "fancy", lastOpts?.model);
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

  // C — attach replies the pinned ws:// contract and the socket opens. One-shot control client
  // over core (the same wire the CLI's askManager uses).
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
    attachReply = await ep.requestControl(CONTROL_ADMIN, { op: "attach", args: { name: "bard" } });
  } finally {
    await ep.stop();
  }
  ok("attach reply ok", attachReply.ok === true, attachReply);
  const wsUrl = (attachReply.data as { ws?: string })?.ws ?? "";
  ok("attach replies a loopback ws:// URL", /^ws:\/\/127\.0\.0\.1:\d+\//.test(wsUrl), wsUrl);
  const sock = new WebSocket(wsUrl);
  const opened = await new Promise<boolean>((res) => {
    sock.onopen = () => res(true);
    sock.onerror = () => res(false);
    setTimeout(() => res(false), 5000);
  });
  ok("attach socket opens", opened);
  sock.close();

  const stopOut = await capture(() => run("stop", ["--name", "bard", "--space", SPACE]));
  ok("stop reports ✓", /stopped bard/.test(stopOut), stopOut);
  const psAfter = await capture(() => run("ps", ["--space", SPACE]));
  ok("ps is empty after stop", /no managed agents/.test(psAfter), psAfter);

  // D — the start tombstone (true subprocess through bin/cotal.ts, i.e. built dist).
  const tomb = spawnSync("npx", ["tsx", join(import.meta.dirname, "..", "cotal.ts"), "start", "--name", "x"], {
    encoding: "utf8",
    env: { ...process.env, COTAL_HOME: home },
  });
  ok("tombstone exits non-zero", tomb.status === 1, tomb.status);
  ok("tombstone names spawn --detach", /spawn --detach/.test(tomb.stderr), tomb.stderr.slice(0, 200));

  // E — foreground --creds fails loud.
  const fg = spawnSync("npx", ["tsx", join(import.meta.dirname, "..", "cotal.ts"), "spawn", "poet", "--creds", "/tmp/x.creds"], {
    encoding: "utf8",
    env: { ...process.env, COTAL_HOME: home },
  });
  ok("foreground --creds exits non-zero", fg.status === 1, fg.status);
  ok("foreground --creds names --detach", /only valid with --detach/.test(fg.stderr), fg.stderr.slice(0, 200));

  console.log(`\nspawn-detach live e2e: ${pass} checks passed`);
} finally {
  await mgr?.stop().catch(() => {});
  for (const k of kids) k.kill("SIGKILL");
}
