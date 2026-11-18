/**
 * A project's own `.cotal` declares MCP servers, `spawn.env` names and persona launch options only
 * when the operator trusts its folder, and only when the folder's `.cotal` belongs to the operator.
 *
 * Every cell runs a foreground `cotal spawn` through the binary's own dispatch, with the real Claude
 * connector, against a real open broker on a free loopback port. `claude` on PATH is a stand-in host
 * that starts each stdio server named in `--mcp-config`, as Claude does, and records what it was
 * given and which servers ran. A cell reads what that host wrote, never the loader's return value.
 *
 * The control cell comes first: a trusted folder's declared server must start and its `spawn.env`
 * name must reach the host, or every refusal below could pass on a launch that never happened.
 *
 * Needs `nats-server` on PATH. Skipped on Windows, where the stand-in host cannot run as written.
 *
 * Run: pnpm smoke:project-config-trust
 */
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN, emitSentinel, freePort, skipSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";

if (process.platform === "win32") skipSuite("the stand-in harness is a POSIX script");

const box = realpathSync(mkdtempSync(join(tmpdir(), "cotal-project-trust-")));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.HOME = join(box, "home");
process.env.COTAL_HOME = join(box, "cotal-home");
process.env.XDG_CONFIG_HOME = join(box, "xdg");
process.env.COTAL_NO_PROMPT = "1";
for (const dir of [process.env.HOME, process.env.COTAL_HOME, join(process.env.XDG_CONFIG_HOME, "cotal")]) mkdirSync(dir, { recursive: true, mode: 0o700 });

// The stand-in host: record the environment name under test, then start each declared stdio server.
const bin = join(box, "bin");
mkdirSync(bin);
const report = join(box, "report.txt");
writeFileSync(join(bin, "claude"), [
  `#!${process.execPath}`,
  `const fs = require("node:fs"), { spawnSync } = require("node:child_process");`,
  `const out = ${JSON.stringify(report)};`,
  `fs.appendFileSync(out, "ENV " + (process.env.TRUST_SMOKE_NAME ?? "<absent>") + "\\n");`,
  `const args = process.argv.slice(2);`,
  `for (let i = 0; i < args.length; i++) {`,
  `  if (args[i] !== "--mcp-config") continue;`,
  `  const v = args[i + 1];`,
  `  const cfg = JSON.parse(fs.existsSync(v) ? fs.readFileSync(v, "utf8") : v);`,
  `  for (const [name, s] of Object.entries(cfg.mcpServers ?? {})) {`,
  `    if (name === "cotal" || !s.command) continue;`,
  `    spawnSync(s.command, s.args ?? [], { stdio: "ignore", timeout: 5000 });`,
  `  }`,
  `}`,
].join("\n"));
chmodSync(join(bin, "claude"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
process.env.TRUST_SMOKE_NAME = "forwarded-1118";

await import("../src/index.js");
await import("@cotal-ai/connector-claude-code");
const { runCli } = await import("../src/command.js");
const { registry } = await import("@cotal-ai/core");
const { recordMesh, trustedProjectsPath } = await import("@cotal-ai/workspace");

// The one-time upgrade seed reads the registrations before the first command. This space is
// registered before that command, as a space registered under an earlier version would be, and the
// first command below seeds the file. Every later `project()` registers after it.
const preUpgrade = mkdtempSync(join(box, "pre-upgrade-"));
mkdirSync(join(preUpgrade, ".cotal"), { mode: 0o700 });
recordMesh({ space: "preupgrade", server: "nats://127.0.0.1:1", root: preUpgrade, mode: "open", origin: "manual", ts: new Date().toISOString() } as never);
const trustedRoots = (): string[] => (existsSync(trustedProjectsPath()) ? (JSON.parse(readFileSync(trustedProjectsPath(), "utf8")) as { roots: string[] }).roots : []);

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const port = await freePort();
const store = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}project-trust-js-`));
const broker = spawnProcess("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", store], { stdio: "ignore" });
teardownOnSignal(broker, store);
const server = `nats://127.0.0.1:${port}`;
for (let i = 0; i < 75; i++) {
  if (spawnSync("nc", ["-z", "127.0.0.1", String(port)]).status === 0) break;
  await new Promise((r) => setTimeout(r, 200));
}

/** A project folder holding a persona and, when given, a project config. Its server, when run,
 *  appends `RAN <marker>` to the report. Recorded as an open space by hand, the way `cotal meshes
 *  add` records one, so no command trusts it as a side effect. */
let spaces = 0;
function project(config: ((marker: string) => unknown) | undefined): { root: string; space: string; marker: string } {
  const space = `trust${++spaces}`;
  const root = mkdtempSync(join(box, `${space}-`));
  const marker = `server-${space}`;
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, ".cotal", "agents", "probe.md"), "---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\n---\nbody\n");
  if (config) writeFileSync(join(root, ".cotal", "config.json"), JSON.stringify(config(marker)));
  recordMesh({ space, server, root, mode: "open", origin: "manual", ts: new Date().toISOString() } as never);
  return { root, space, marker };
}
const declares = (marker: string) => ({
  connectors: { claude: { mcpServers: { planted: { command: "/bin/sh", args: ["-c", `echo RAN ${marker} >> ${JSON.stringify(report)}`] } } } },
  spawn: { env: ["TRUST_SMOKE_NAME"] },
});

/** One CLI run from `cwd`. The first exit the command asks for is its outcome: the stubbed exit throws
 *  to stop the command, and the dispatcher's own report of that throw is not the command's. `out` is
 *  stdout and stderr together, as written through the stream objects; a classified refusal report is
 *  written to the descriptor directly, so a cell reads such a refusal by its exit code. */
async function cli(cwd: string, argv: string[]): Promise<{ exited?: number; out: string; stdout: string }> {
  const realExit = process.exit, realErr = process.stderr.write.bind(process.stderr), realOut = process.stdout.write.bind(process.stdout), realLog = console.error;
  const before = process.cwd();
  let stderr = "", stdout = "", exited: number | undefined;
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: unknown) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  console.error = (...a: unknown[]) => { stderr += a.map(String).join(" ") + "\n"; };
  (process as unknown as { exit: (c?: number) => never }).exit = ((code?: number) => { exited ??= code ?? 0; throw new Error(`__exit__${exited}`); }) as never;
  process.exitCode = undefined;
  process.chdir(cwd);
  try { await runCli(registry, argv); }
  catch { /* the stubbed exit */ }
  finally {
    process.chdir(before);
    (process as unknown as { exit: typeof realExit }).exit = realExit;
    process.stderr.write = realErr; process.stdout.write = realOut; console.error = realLog;
  }
  if (exited === undefined && typeof process.exitCode === "number" && process.exitCode !== 0) exited = process.exitCode;
  process.exitCode = undefined;
  return { exited, out: stdout + stderr, stdout };
}

const spawnIn = (p: { root: string; space: string }) =>
  cli(p.root, ["spawn", "--foreground", "--file", join(p.root, ".cotal", "agents", "probe.md"), "--space", p.space, "--agent", "claude"]);
const reportText = (): string => (existsSync(report) ? readFileSync(report, "utf8") : "");
const fresh = (): void => writeFileSync(report, "");

console.log("cotal spawn: a project declares servers, spawn.env and persona launch options only in a trusted folder");
try {
  // A project with no config launches whether or not its folder is trusted. This is the first command,
  // so it runs the upgrade seed.
  {
    const p = project(undefined);
    fresh();
    const r = await spawnIn(p);
    check("an empty project launches the host", r.exited === undefined && reportText().includes("ENV <absent>"), r.out.slice(-400));
  }

  // The upgrade seed: a space registered before the first command is trusted, and one registered after
  // it is not, even though it was registered before any trust read of its own.
  {
    check("the upgrade seed trusts a space registered before the first command", trustedRoots().includes(preUpgrade), trustedRoots());
    const later = project(declares);
    check("a space registered after the first command is not seeded", !trustedRoots().includes(later.root), trustedRoots());
    fresh();
    const r = await spawnIn(later);
    check("a space registered after the upgrade cannot run its declared server", r.exited === 1 && !reportText().includes(`RAN ${later.marker}`), r.out.slice(-300));
  }

  // CONTROL: a trusted folder's declared server runs, and its spawn.env name reaches the host.
  {
    const p = project(declares);
    const t = await cli(p.root, ["trust", p.root]);
    check("cotal trust records the folder", t.exited === undefined && readFileSync(trustedProjectsPath(), "utf8").includes(p.root), t.out);
    fresh();
    const r = await spawnIn(p);
    check("CONTROL: a trusted folder's declared server starts", reportText().includes(`RAN ${p.marker}`), r.out.slice(-400));
    check("CONTROL: a trusted folder's spawn.env name reaches the host", reportText().includes("ENV forwarded-1118"), reportText());
    const again = await cli(p.root, ["trust", p.root, "--json"]);
    check("trusting a trusted folder again is a no-op", again.exited === undefined && /"outcome":\s*"no-op"/.test(again.stdout), again.stdout);
  }

  // THE FIX: the same config in a folder nobody trusted launches nothing and names the remedy.
  {
    const p = project(declares);
    fresh();
    const r = await spawnIn(p);
    check("an untrusted folder's declared server does not start", !reportText().includes(`RAN ${p.marker}`), reportText());
    check("an untrusted folder's spawn launches no host", !reportText().includes("ENV "), reportText());
    check("the refusal exits non-zero", r.exited === 1, r.exited);
    check("the refusal names the entries, the folder and `cotal trust`", r.out.includes("connectors.claude.mcpServers.planted") && r.out.includes("spawn.env") && r.out.includes(`cotal trust ${p.root}`), r.out.slice(-500));
  }

  // Only `spawn.env` declared: still refused, and the host never sees the name.
  {
    const p = project(() => ({ spawn: { env: ["TRUST_SMOKE_NAME"] } }));
    fresh();
    const r = await spawnIn(p);
    check("an untrusted folder's spawn.env alone is refused", r.exited === 1 && !reportText().includes("forwarded-1118"), r.out.slice(-300));
  }

  // A config with neither still applies its other fields untrusted: a model policy refuses a
  // persona whose model it does not allow.
  {
    const p = project(() => ({ modelPolicy: { worker: { models: ["only-this-model"] } } }));
    writeFileSync(join(p.root, ".cotal", "agents", "probe.md"), "---\nname: probe\nrole: worker\nmodel: another-model\nsubscribe: [general]\nallowSubscribe: [general]\n---\nbody\n");
    fresh();
    const r = await spawnIn(p);
    check("an untrusted folder's model policy still applies", r.exited === 1 && r.out.includes("does not allow") && !reportText().includes("ENV "), r.out.slice(-300));
  }

  // A persona file in an untrusted project may not contribute launch options: the connector renders
  // each key into the host's own flags. Here one names an MCP config file whose server would run.
  {
    const p = project(undefined);
    const planted = join(p.root, "planted-mcp.json");
    writeFileSync(planted, JSON.stringify({ mcpServers: { viapersona: { command: "/bin/sh", args: ["-c", `echo RAN persona-${p.marker} >> ${JSON.stringify(report)}`] } } }));
    writeFileSync(join(p.root, ".cotal", "agents", "probe.md"), `---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nlaunchOptions:\n  mcp-config: ${planted}\n---\nbody\n`);
    fresh();
    const r = await spawnIn(p);
    check("an untrusted project's persona launch options do not reach the host", !reportText().includes(`RAN persona-${p.marker}`) && !reportText().includes("ENV "), reportText());
    check("the persona refusal names the file, the key, the folder and `cotal trust`", r.exited === 1 && r.out.includes("probe.md") && r.out.includes("launchOptions.mcp-config") && r.out.includes(`cotal trust ${p.root}`), r.out.slice(-400));
    await cli(p.root, ["trust", p.root]);
    fresh();
    await spawnIn(p);
    check("CONTROL: a trusted project's persona launch options reach the host", reportText().includes(`RAN persona-${p.marker}`), reportText());
    // A caller's own --opt is the caller's choice, not the project's.
    const q = project(undefined);
    fresh();
    const o = await cli(q.root, ["spawn", "--foreground", "--file", join(q.root, ".cotal", "agents", "probe.md"), "--space", q.space, "--agent", "claude", "--opt", `mcp-config=${planted}`]);
    check("--opt given by the caller is not gated in an untrusted project", o.exited === undefined && reportText().includes(`RAN persona-${p.marker}`), o.out.slice(-300));
  }

  // A persona file outside any project is the operator's own, so its launch options apply.
  {
    const q = project(undefined);
    const outside = mkdtempSync(join(box, "catalog-"));
    const planted = join(outside, "planted-mcp.json");
    writeFileSync(planted, JSON.stringify({ mcpServers: { outside: { command: "/bin/sh", args: ["-c", `echo RAN outside >> ${JSON.stringify(report)}`] } } }));
    const file = join(outside, "probe.md");
    writeFileSync(file, `---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nlaunchOptions:\n  mcp-config: ${planted}\n---\nbody\n`);
    fresh();
    const r = await cli(q.root, ["spawn", "--foreground", "--file", file, "--space", q.space, "--agent", "claude"]);
    check("a persona file outside any project keeps its launch options", r.exited === undefined && reportText().includes("RAN outside"), r.out.slice(-300));
  }

  // Trust follows the stored path. A trusted path replaced by a link to another folder does not pass
  // its trust to that folder.
  {
    const target = project(declares);
    const linkParent = mkdtempSync(join(box, "link-"));
    const trustedPath = join(linkParent, "proj");
    mkdirSync(trustedPath);
    await cli(linkParent, ["trust", trustedPath]);
    rmSync(trustedPath, { recursive: true });
    symlinkSync(target.root, trustedPath);
    recordMesh({ space: target.space, server, root: trustedPath, mode: "open", origin: "manual", ts: new Date().toISOString() } as never);
    fresh();
    const r = await spawnIn({ root: trustedPath, space: target.space });
    check("a trusted path replaced by a link does not trust the link's target", r.exited === 1 && !reportText().includes(`RAN ${target.marker}`), r.out.slice(-300));
  }

  // A trust record is per folder: trusting a parent does not trust a project inside it.
  {
    const parent = mkdtempSync(join(box, "parent-"));
    const t = await cli(parent, ["trust", parent]);
    check("a parent folder can be trusted", t.exited === undefined, t.out);
    const inner = project(declares);
    const nested = join(parent, "inner");
    spawnSync("mv", [inner.root, nested]);
    recordMesh({ space: inner.space, server, root: nested, mode: "open", origin: "manual", ts: new Date().toISOString() } as never);
    fresh();
    const r = await spawnIn({ root: nested, space: inner.space });
    check("a trusted parent does not trust a project inside it", r.exited === 1 && !reportText().includes(`RAN ${inner.marker}`), r.out.slice(-300));
  }

  // `cotal space create` trusts a folder whose `.cotal` it made, and never one whose `.cotal` was
  // already there, such as one a cloned repository brought, even with nothing declared in it yet.
  {
    const made = mkdtempSync(join(box, "made-"));
    const c = await cli(made, ["space", "create", "madespace", "--root", made]);
    check("space create succeeds", c.exited === undefined, c.out.slice(-300));
    check("space create trusts a folder whose .cotal it made", trustedRoots().includes(made), trustedRoots());
    const cloned = mkdtempSync(join(box, "cloned-"));
    mkdirSync(join(cloned, ".cotal", "agents"), { recursive: true, mode: 0o700 });
    const d = await cli(cloned, ["space", "create", "clonedspace", "--root", cloned]);
    check("space create does not trust a folder that already had a .cotal", d.exited === undefined && !trustedRoots().includes(cloned), trustedRoots());
  }

  // Usage and target refusals of the command itself.
  {
    const none = await cli(box, ["trust"]);
    check("cotal trust with no path is a usage refusal", none.exited === 1 && none.out.includes("usage: cotal trust <path>"), none.out.slice(-200));
    const missing = await cli(box, ["trust", join(box, "does-not-exist")]);
    check("cotal trust of a missing folder is refused as a missing target", missing.exited === 2 && !trustedRoots().some((r) => r.includes("does-not-exist")), missing.exited);
  }

  // The trust store refuses to be read when another account may write it.
  {
    const p = project(declares);
    await cli(p.root, ["trust", p.root]);
    chmodSync(trustedProjectsPath(), 0o666);
    fresh();
    const r = await spawnIn(p);
    chmodSync(trustedProjectsPath(), 0o600);
    check("a trust store other accounts may write trusts nothing", r.exited !== undefined && r.exited !== 0 && !reportText().includes(`RAN ${p.marker}`), r.out.slice(-300));
  }

  // Ownership. `/etc` and `/etc/passwd` belong to root on Linux and macOS, so a link to one stands
  // in for a `.cotal` or a config another account owns. Not run as root, where root is this account.
  if (process.getuid?.() !== 0) {
    const p = project(undefined);
    symlinkSync("/etc/passwd", join(p.root, ".cotal", "config.json"));
    await cli(p.root, ["trust", p.root]);
    fresh();
    const r = await spawnIn(p);
    check("a project config another account owns is refused, even in a trusted folder", r.exited === 1 && r.out.includes("belongs to another user") && !reportText().includes("ENV "), r.out.slice(-300));
    const foreign = mkdtempSync(join(box, "foreign-"));
    symlinkSync("/etc", join(foreign, ".cotal"));
    const t = await cli(foreign, ["trust", foreign]);
    check("cotal trust refuses a folder whose .cotal another account owns", t.exited === 2 && !trustedRoots().includes(foreign), t.exited);
  } else console.log("  - ownership cells not run: this suite runs as root");
} finally {
  broker.kill("SIGKILL");
  rmSync(box, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
}

const EXPECTED = process.getuid?.() === 0 ? 28 : 30;
if (passed + failed !== EXPECTED) { failed++; console.log(`  ✗ FAIL: ${passed + failed - 1} cells reported, ${EXPECTED} expected`); }
emitSentinel({ passed, failed });
process.exit(failed === 0 ? 0 : 1);
