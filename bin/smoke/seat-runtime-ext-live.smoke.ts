/**
 * LIVE e2e for a per-seat runtime that is an INSTALLED extension (AGENT-1013): the REAL binary as
 * subprocesses in a sandboxed config, a real auth broker on a free port, and a detached `pty`
 * manager booted AFTER `cotal ext add` of a fixture runtime provider and a fixture connector.
 *
 *  1. `spawn -d --on <this manager>` with no `--runtime` launches on the manager's own `pty`: the
 *     rig itself works, so what follows is about the runtime step alone.
 *  2. `spawn -d --on <this manager> --runtime seat-fixture` launches: the manager imports the
 *     installed provider on demand (the provider's spawn records the pid of the process that ran
 *     it, which is the manager's), the launch reports that runtime, and `ps` lists the seat on it.
 *     The manager used to refuse this as `unknown runtime` because its process had imported only
 *     its own runtime.
 *  3. an installed provider that is not reachable, an official runtime that is not installed, and
 *     a name nobody provides are refused DEPENDENCY_UNAVAILABLE before the launch is sent, because
 *     `--on` names this root's own manager. The remedy is the CLI's own lookup wording, the official
 *     one naming its `cotal ext add` package.
 *  4. `cotal ext remove` of the runtime while the manager runs refuses the NEXT seat that names
 *     it; the seat already on it is still listed and still stops through its cached backend.
 *
 * Sandboxes COTAL_HOME + XDG_CONFIG_HOME + a temp project root; tears down through the binary's own
 * `stop` and `down`, never by signalling a saved pid (a reused pid could be foreign work). Needs
 * `nats-server` and `npm` on PATH.
 * Run: pnpm smoke:seat-runtime-ext:live
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { canonicalLocalProcessPath, MANAGER_PIDFILE } from "@cotal-ai/workspace";

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const WT = resolve(import.meta.dirname, "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");

// mkdtemp makes 0700 directories, which the Cotal home requires (a group-writable chain is refused).
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "cotal-seat-rt-")));
const home = join(sandbox, "home");
const configDir = join(sandbox, "xdg");
const root = join(sandbox, "root");
const out = join(sandbox, "out");
for (const dir of [home, configDir, root, out]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
const SPACE = basename(root);
const record = (template: string) => canonicalLocalProcessPath(template, { root, space: SPACE });

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const cli = (...args: string[]) => {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 180_000 };
  assertSmokeSandboxDown(anchor, args, options);
  return spawnSync(TSX, [CLI, ...args], options);
};
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** The one JSON envelope a `--json` command wrote on stdout, or undefined. */
const envelope = (stdout: string): { outcome?: string; result?: Record<string, unknown> | null; error?: { code?: string; message?: string; remedy?: string } } | undefined => {
  const line = stdout.split("\n").find((l) => l.startsWith("{\"schemaVersion\""));
  try { return line ? JSON.parse(line) : undefined; } catch { return undefined; }
};

/** A fixture extension package on disk; `index` is its module body. */
function fixture(name: string, index: string): string {
  const dir = join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }, null, 2));
  writeFileSync(join(dir, "index.js"), index);
  return dir;
}

// The runtime provider under test: a real child process per seat, no terminal stream (the shape
// tmux, cmux, orca and herdr have). Its spawn records WHICH PROCESS ran it, so the cell can prove
// the manager, not the CLI, imported the installed package.
const mark = join(out, "spawned.json");
const RUNTIME = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { registry } from "@cotal-ai/core";
const handle = (name, child) => ({
  name, kind: "seat-fixture", pid: child.pid,
  status: () => (child.exitCode === null && child.signalCode === null ? "running" : "exited"),
  stop: () => { child.kill("SIGKILL"); },
  waitForExit: () => new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) return r(); child.once("exit", () => r()); }),
  interrupt: () => { child.kill("SIGINT"); },
  attach: () => { throw new Error("seat-fixture runtime: watch this agent where it runs; it has no terminal here"); },
});
registry.register(
  {
    kind: "runtime", name: "seat-fixture", available: () => true,
    create: ({ session }) => ({
      kind: "seat-fixture", streamsTerminal: false,
      spawn: (name, spec, cwd) => {
        const child = spawn(spec.command, spec.args ?? [], { cwd, env: spec.env, stdio: "ignore" });
        writeFileSync(${JSON.stringify(mark)}, JSON.stringify({ pid: process.pid, session, name, child: child.pid }));
        return handle(name, child);
      },
    }),
  },
  { kind: "runtime", name: "seat-fixture-unreachable", available: () => false, create: () => { throw new Error("unused"); } },
);
`;
// The connector: a real mesh endpoint as the seat, joining presence under the manager-minted
// identity and creds, so a detached launch resolves "joined" through either runtime.
const CONNECTOR = `import { fileURLToPath } from "node:url";
import { registry } from "@cotal-ai/core";
const coreDist = fileURLToPath(import.meta.resolve("@cotal-ai/core"));
const CHILD = [
  "const fs=require('node:fs');const{pathToFileURL}=require('node:url');",
  "import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,",
  "creds:process.env.COTAL_CREDS?fs.readFileSync(process.env.COTAL_CREDS,'utf8'):undefined,",
  "lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,watchPresence:false,",
  "card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});",
  "ep.on('error',()=>{});await ep.start();setInterval(()=>{},1000);});",
].join("");
registry.register({
  kind: "connector", name: "e2e", requires: ["node"],
  buildLaunch: (o) => ({
    command: "node", args: ["-e", CHILD],
    env: { PATH: process.env.PATH ?? "", CORE_DIST: coreDist, COTAL_SPACE: o.space, COTAL_SERVERS: o.servers ?? "", COTAL_ID: o.id ?? "", COTAL_CREDS: o.creds ?? "", COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "", COTAL_NAME: o.name },
  }),
});
`;

let up = false;
try {
  const addRuntime = cli("ext", "add", fixture("cotal-ext-seat-runtime", RUNTIME));
  ok("the fixture runtime extension is added", addRuntime.status === 0 && /runtime:seat-fixture\b/.test(addRuntime.stdout), addRuntime.stdout + addRuntime.stderr.slice(-400));
  const addConnector = cli("ext", "add", fixture("cotal-ext-seat-connector", CONNECTOR));
  ok("the fixture connector extension is added", addConnector.status === 0 && /connector:e2e/.test(addConnector.stdout), addConnector.stdout + addConnector.stderr.slice(-400));
  const runtimes = cli("runtimes", "--plain");
  ok("cotal runtimes lists the installed provider as reachable before any manager runs", runtimes.status === 0 && /seat-fixture\s+installed - reachable/.test(plain(runtimes.stdout)), runtimes.stdout);

  const upReport = cli("up", "--detach", "--server", SERVER);
  up = upReport.status === 0;
  ok("up --detach boots the pty manager after the extensions were added", up, upReport.stdout + upReport.stderr);
  let listed: string | undefined;
  for (let i = 0; i < 30 && listed === undefined; i++) {
    const r = cli("ps", "--plain");
    listed = r.status === 0 ? /^\s*instance:\s+([a-z0-9]{26,32})$/m.exec(plain(r.stdout))?.[1] : undefined;
    if (listed === undefined) await sleep(2000);
  }
  ok("the detached manager answers ps with its instance id", listed !== undefined);
  const managerPid = Number(readFileSync(record(MANAGER_PIDFILE), "utf8").trim());
  ok("the manager pid record names a live process", Number.isFinite(managerPid) && alive(managerPid), managerPid);
  const on = String(listed);

  // 1. the manager's own runtime, so a refusal below is about the runtime step and nothing else.
  const onPty = envelope(cli("spawn", "default", "-d", "--on", on, "--agent", "e2e", "--no-events", "--name", "ptyseat", "--json").stdout);
  ok("a seat with no --runtime launches on the manager's own pty", onPty?.outcome === "ok" && onPty.result?.runtime === "pty" && onPty.result?.name === "ptyseat", onPty);

  // 2. the installed runtime, imported by the manager the first time a seat names it.
  ok("nothing has spawned through the fixture runtime yet", !existsSync(mark));
  const onExt = cli("spawn", "default", "-d", "--on", on, "--agent", "e2e", "--no-events", "--runtime", "seat-fixture", "--name", "extseat", "--json");
  const extReply = envelope(onExt.stdout);
  ok("a seat naming the installed runtime launches, and the manager reports that runtime with no terminal stream",
    onExt.status === 0 && extReply?.outcome === "ok" && extReply.result?.runtime === "seat-fixture" && extReply.result?.name === "extseat" && extReply.result?.streamsTerminal === false,
    { status: onExt.status, stdout: onExt.stdout, stderr: onExt.stderr });
  const spawned = JSON.parse(readFileSync(mark, "utf8")) as { pid: number; session: string; name: string; child: number };
  ok("the provider's spawn ran inside the manager process, with the per-space session name", spawned.pid === managerPid && spawned.name === "extseat" && spawned.session === `cotal-${SPACE}`, { spawned, managerPid });
  ok("the seat is a live child the provider started", alive(spawned.child), spawned.child);
  const census = envelope(cli("ps", "--json").stdout);
  const rows = (census?.result?.items ?? []) as { name: string; mode: string }[];
  ok("ps lists both seats on their own runtimes", rows.some((r) => r.name === "extseat" && r.mode === "seat-fixture") && rows.some((r) => r.name === "ptyseat" && r.mode === "pty"), rows);

  // 3. refusals before the launch is sent, the remedy phrased as the CLI's own lookup phrases it.
  const PREFLIGHT = "the requested runtime did not pass preflight on this machine, where the selected manager runs; nothing was launched";
  const preflightRefused = (reply: ReturnType<typeof envelope>, remedy: string) =>
    reply?.outcome === "refused" && reply.error?.code === "DEPENDENCY_UNAVAILABLE" && reply.error.message === PREFLIGHT && reply.error.remedy === remedy;
  const unreachable = envelope(cli("spawn", "default", "-d", "--on", on, "--agent", "e2e", "--no-events", "--runtime", "seat-fixture-unreachable", "--name", "none1", "--json").stdout);
  ok("an installed provider that is not reachable is refused by name, and nothing launches",
    preflightRefused(unreachable, "seat-fixture-unreachable runtime requested but it is not reachable"), unreachable);
  const official = envelope(cli("spawn", "default", "-d", "--on", on, "--agent", "e2e", "--no-events", "--runtime", "tmux", "--name", "none2", "--json").stdout);
  ok("an official runtime that is not installed is refused naming its package",
    preflightRefused(official, "no installed extension provides runtime \"tmux\" - install it with `cotal ext add @cotal-ai/tmux`"), official);
  const unknown = envelope(cli("spawn", "default", "-d", "--on", on, "--agent", "e2e", "--no-events", "--runtime", "nosuch", "--name", "none3", "--json").stdout);
  ok("a runtime nobody provides is refused as unknown, listing the known names",
    preflightRefused(unknown, "unknown runtime \"nosuch\" (known: pty, orca, tmux, cmux, herdr) - install a provider with `cotal ext add <npm-package>`, or check the name"), unknown);

  // 4. a live remove is honored for the next seat; the seat already on the runtime keeps it.
  const removed = cli("ext", "remove", "cotal-ext-seat-runtime");
  ok("the runtime extension is removed while the manager runs", removed.status === 0, removed.stderr.slice(-400));
  const late = envelope(cli("spawn", "default", "-d", "--on", on, "--agent", "e2e", "--no-events", "--runtime", "seat-fixture", "--name", "late", "--json").stdout);
  ok("after the remove, the next seat naming that runtime is refused even though the manager imported it earlier",
    preflightRefused(late, "unknown runtime \"seat-fixture\" (known: pty, orca, tmux, cmux, herdr) - install a provider with `cotal ext add <npm-package>`, or check the name"), late);
  const still = (envelope(cli("ps", "--json").stdout)?.result?.items ?? []) as { name: string; mode: string }[];
  ok("the seat already on the removed runtime is still listed on it", still.some((r) => r.name === "extseat" && r.mode === "seat-fixture"), still);
  const stopExt = cli("stop", "extseat", "--on", on);
  ok("that seat still stops through its cached backend", stopExt.status === 0, stopExt.stdout + stopExt.stderr);
  for (let i = 0; i < 50 && alive(spawned.child); i++) await sleep(100);
  ok("its child process is gone", !alive(spawned.child), spawned.child);
  const stopPty = cli("stop", "ptyseat", "--on", on);
  ok("the pty seat stops", stopPty.status === 0, stopPty.stdout + stopPty.stderr);

  const down = cli("down");
  up = down.status !== 0;
  ok("cotal down stops the stack", down.status === 0, down.stdout + down.stderr);
  console.log(`seat-runtime-ext:live: ${pass} checks passed`);
} finally {
  // A stack this suite started and did not bring down is stopped the same way an operator would,
  // scoped to this sandbox root; a pty manager stops its seats with it.
  if (up) cli("down");
}
