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
 * POSIX needs `nats-server` on PATH. Windows checks the printed remedy in both native shells.
 *
 * Run: pnpm smoke:project-config-trust
 */
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { Kvm } from "@nats-io/kv";
import { SMOKE_BROKER_TOKEN, assertSmokeSandboxDown, emitSentinel, freePort, recordSmokeSandbox, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { channelBucket, dialerFor, presenceBucket, projectTrustProblem } from "@cotal-ai/core";

if (process.platform === "win32") {
  const sandbox = mkdtempSync(join(tmpdir(), "cotal-project-trust-shells-"));
  const entry = resolve("bin/dist/cotal.js");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  Object.assign(env, { COTAL_HOME: join(sandbox, "state"), XDG_CONFIG_HOME: join(sandbox, "config"), COTAL_TELEMETRY: "off", COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1" });
  const launcher = join(sandbox, "cotal.cmd");
  writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`);
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  env[pathKey] = `${sandbox}${delimiter}${env[pathKey] ?? ""}`;
  let passed = 0, failed = 0;
  try {
    for (const shell of ["powershell.exe", "cmd.exe"]) {
      for (const suffix of ["a project with spaces", "a project %PATH% $HOME & '!"]) {
        const project = join(sandbox, shell, suffix);
        mkdirSync(project, { recursive: true });
        const root = realpathSync(project);
        const reason = projectTrustProblem(["spawn.env"], root);
        const command = /`(cotal trust [^`]+)`/.exec(reason)?.[1];
        const expected = /^[A-Za-z0-9_./:\\ -]+$/.test(root) ? `cotal trust -- "${root}"` : `cotal trust --hex ${Buffer.from(root).toString("hex")}`;
        if (command !== expected) {
          failed++;
          console.error(`wrong trust command: ${reason}`);
          continue;
        }
        const args = shell === "cmd.exe" ? ["/d", "/v:off", "/c", command] : ["-NoProfile", "-NonInteractive", "-Command", command];
        const result = spawnSync(shell, args, { cwd: sandbox, env, encoding: "utf8", timeout: 30_000, windowsVerbatimArguments: shell === "cmd.exe" });
        if (result.status === 0 && result.stdout.includes(root)) { passed++; console.log(`✓ ${shell} records ${suffix}`); }
        else { failed++; console.error(`${shell}: ${result.stderr || result.error || result.stdout}`); }
      }
    }
    const { loadTrustCheckedPersona } = await import("@cotal-ai/workspace");
    const root = realpathSync(sandbox);
    mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
    writeFileSync(join(root, ".cotal", "agents", "probe.md"), "---\nname: probe\nlaunchOptions: { mcp-config: empty.json }\n---\nbody\n");
    process.env.COTAL_HOME = env.COTAL_HOME;
    process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
    const mixed = loadTrustCheckedPersona(`${root}\\.cotal/agents\\probe.md`, "launch");
    if (mixed.refusal?.includes("launchOptions.mcp-config") && mixed.refusal.includes(root)) {
      passed++;
      console.log("✓ Windows recognizes the untrusted project through mixed persona path separators");
    } else {
      failed++;
      console.error("mixed Windows persona path did not refuse launch options", mixed.refusal);
    }
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
  emitSentinel({ passed, failed });
  process.exit(failed === 0 ? 0 : 1);
}

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
const cliEntry = resolve("bin/dist/cotal.js");
const launcher = join(bin, "cotal");
writeFileSync(launcher, `#!${process.execPath}\nrequire('node:child_process').spawnSync(process.execPath, [${JSON.stringify(cliEntry)}, ...process.argv.slice(2)], { stdio: 'inherit' }).status === 0 || process.exit(1);\n`, { mode: 0o755 });
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
const { loadManifest } = await import("../src/lib/manifest/index.js");
const { registry } = await import("@cotal-ai/core");
const { recordMesh, recordPreparedSpace, trustedProjectsPath } = await import("@cotal-ai/workspace");

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
function project(config: ((marker: string) => unknown) | undefined, prefix = "", suffix = ""): { root: string; space: string; marker: string } {
  const space = `trust${++spaces}`;
  const root = suffix ? join(box, `${space}${suffix}`) : mkdtempSync(join(box, `${prefix}${space}-`));
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
async function cli(cwd: string, argv: string[]): Promise<{ exited?: number; out: string; stdout: string; stderr: string }> {
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
  return { exited, out: stdout + stderr, stdout, stderr };
}

const spawnIn = (p: { root: string; space: string }) =>
  cli(p.root, ["spawn", "--foreground", "--file", join(p.root, ".cotal", "agents", "probe.md"), "--space", p.space, "--agent", "claude"]);
const reportText = (): string => (existsSync(report) ? readFileSync(report, "utf8") : "");
const fresh = (): void => writeFileSync(report, "");

function runTrustRemedy(output: string, root: string): boolean {
  const printed = /`((?:pnpm )?cotal trust [^`]+)`/.exec(output)?.[1];
  const literal = /^[A-Za-z0-9_./:-]+$/.test(root) ? root : /^[A-Za-z0-9_./:\\ -]+$/.test(root) && !/\\\\|\\$/.test(root) ? `-- "${root}"` : undefined;
  const encoded = `--hex ${Buffer.from(root).toString("hex")}`;
  if (!printed || ![literal, encoded].some((arg) => arg !== undefined && (printed === `cotal trust ${arg}` || printed === `pnpm cotal trust ${arg}`))) return false;
  const result = spawnSync("/bin/sh", ["-c", printed], { cwd: process.cwd(), stdio: "ignore" });
  return result.status === 0 && trustedRoots().includes(root);
}

console.log("cotal spawn: a project declares servers, spawn.env and persona launch options only in a trusted folder");
try {
  {
    const sandbox = mkdtempSync(join(box, "registration-first-"));
    const home = join(sandbox, "home"), config = join(sandbox, "config");
    const old = mkdtempSync(join(sandbox, "old-")), cloned = mkdtempSync(join(sandbox, "cloned-"));
    mkdirSync(join(cloned, ".cotal"), { mode: 0o700 });
    const priorHome = process.env.COTAL_HOME;
    process.env.COTAL_HOME = home;
    try { recordMesh({ space: "legacy", server, root: old, mode: "open", origin: "manual", ts: new Date().toISOString() }); }
    finally { process.env.COTAL_HOME = priorHome; }
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
      COTAL_HOME: home, XDG_CONFIG_HOME: config, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1",
    };
    const run = (...argv: string[]) => spawnSync(process.execPath, [cliEntry, ...argv], { cwd: sandbox, env, encoding: "utf8", timeout: 30_000 });
    const store = join(config, "cotal", "trusted-projects.json");
    const witness = join(home, "trusted-projects-seed.json");
    const refused = run("auth", "mint", "missing", "--space", "not-registered", "--json");
    check("a refused target lookup with legacy registrations writes neither trust record",
      refused.status === 2 && refused.stdout.includes("TARGET_NOT_FOUND") && !existsSync(witness) && !existsSync(store), refused.stdout);
    const created = run("space", "create", "new-clone", "--root", cloned, "--json");
    const roots = existsSync(store) ? JSON.parse(readFileSync(store, "utf8")).roots as string[] : [];
    check("a first new prepared space does not enter the upgrade trust snapshot",
      created.status === 0 && roots.includes(old) && !roots.includes(cloned), { status: created.status, roots, stdout: created.stdout });
  }

  {
    const sandbox = mkdtempSync(join(box, "cold-upgrade-"));
    const home = join(sandbox, "home"), config = join(sandbox, "config");
    const coldProject = join(sandbox, "my-project"), cloned = join(sandbox, "cloned-project");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(coldProject, { recursive: true, mode: 0o700 });
    mkdirSync(join(cloned, ".cotal", "agents"), { recursive: true, mode: 0o700 });
    const coldServer = `nats://127.0.0.1:${await freePort()}`;
    const prefix = join(config, "cotal", "extensions");
    const pkg = "@cotal-ai/connector-claude-code";
    const source = resolve("extensions/connector-claude-code");
    mkdirSync(join(prefix, "node_modules", "@cotal-ai"), { recursive: true, mode: 0o700 });
    symlinkSync(source, join(prefix, "node_modules", pkg), "dir");
    const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
    writeFileSync(join(prefix, "extensions.json"), JSON.stringify({ extensions: [{
      pkg, version, commands: [], provides: [{ kind: "connector", name: "claude" }],
      connectors: [{ name: "claude", requires: ["claude"], eventPlane: true, setup: null }],
    }] }));
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
      COTAL_HOME: home, XDG_CONFIG_HOME: config, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1",
    };
    const guard = recordSmokeSandbox({ root: coldProject, cotalHome: home, xdgConfigHome: config });
    const run = (cwd: string, argv: string[]) => {
      const options = { cwd, env, encoding: "utf8" as const, timeout: 50_000 };
      assertSmokeSandboxDown(guard, argv, options);
      return spawnSync(process.execPath, [cliEntry, ...argv], options);
    };
    const store = join(config, "cotal", "trusted-projects.json"), witness = join(home, "trusted-projects-seed.json");
    try {
      const initialUp = run(coldProject, ["up", "--detach", "--space", "my-mesh", "--server", coldServer]);
      const marker = "cold-upgrade-marker";
      writeFileSync(join(coldProject, ".cotal", "config.json"), JSON.stringify(declares(marker)));
      writeFileSync(join(coldProject, ".cotal", "agents", "default.md"), "---\nname: default_agent\nharness: claude\nlaunchOptions:\n  verbose: true\n---\nDefault test persona.\n");
      const down = run(coldProject, ["down", "--yes"]);
      // Simulate upgrading from <=0.182.1 after `cotal down` removed `~/.cotal/meshes/<space>.json`.
      rmSync(store, { force: true });
      rmSync(witness, { force: true });
      check("cold pre-upgrade down leaves neither mesh registration nor trust records",
        initialUp.status === 0 && down.status === 0 && !existsSync(join(home, "meshes", `space.${Buffer.from("my-mesh").toString("hex")}.json`))
          && existsSync(join(coldProject, ".cotal", "stack-home.json")) && !existsSync(store) && !existsSync(witness),
        { initialUp, down });

      // A cloned repo whose `stack-home.json` names another Cotal home is not eligible for migration.
      writeFileSync(join(cloned, ".cotal", "stack-home.json"), JSON.stringify({ home: join(sandbox, "other-home") }), { mode: 0o600 });
      writeFileSync(join(cloned, ".cotal", "config.json"), JSON.stringify(declares("cloned-marker")));
      writeFileSync(join(cloned, ".cotal", "agents", "default.md"), "---\nname: default_agent\nharness: claude\nlaunchOptions:\n  verbose: true\n---\nCloned persona.\n");
      const clonedPreview = run(cloned, ["spawn", "--file", ".cotal/agents/default.md", "--server", server, "--agent", "claude", "--dry-run", "--json"]);
      check("a cloned folder whose stack-home.json names another Cotal home is refused without writing trust",
        clonedPreview.status !== 0 && `${clonedPreview.stdout}${clonedPreview.stderr}`.includes("launchOptions.verbose")
          && `${clonedPreview.stdout}${clonedPreview.stderr}`.includes(`cotal trust ${cloned}`)
          && !existsSync(store) && !existsSync(witness), clonedPreview);

      const restarted = run(coldProject, ["up", "--detach", "--space", "my-mesh", "--server", coldServer]);
      const roots = existsSync(store) ? JSON.parse(readFileSync(store, "utf8")).roots as string[] : [];
      check("post-upgrade up migrates the stopped local stack root for this Cotal home",
        restarted.status === 0 && existsSync(witness) && roots.includes(coldProject) && !roots.includes(cloned),
        { restarted, roots });
      const preview = run(coldProject, ["spawn", "--dry-run", "--space", "my-mesh"]);
      fresh();
      const live = run(coldProject, ["spawn", "--foreground", "--file", ".cotal/agents/default.md", "--space", "my-mesh", "--agent", "claude"]);
      check("post-upgrade spawn preview and foreground launch accept project config and persona launchOptions",
        preview.status === 0 && preview.stdout.includes("Direct launch preview")
          && live.status === 0 && reportText().includes(`RAN ${marker}`) && reportText().includes("ENV forwarded-1118"),
        { preview, live, report: reportText() });
    } finally {
      run(coldProject, ["down", "--yes"]);
    }
  }

  {
    const sandbox = mkdtempSync(join(box, "manifest-upgrade-"));
    const home = join(sandbox, "home"), config = join(sandbox, "config");
    const legacy = join(sandbox, "legacy"), clone = join(sandbox, "clone"), prepared = join(sandbox, "prepared");
    const space = "upgrade-manifest";
    const legacyServer = `nats://127.0.0.1:${await freePort()}`;
    const planted = join(sandbox, "empty-mcp.json");
    writeFileSync(planted, '{"mcpServers":{}}');
    for (const root of [legacy, clone, prepared]) {
      mkdirSync(join(root, ".cotal", "agents"), { recursive: true, mode: 0o700 });
      writeFileSync(join(root, ".cotal", "agents", "probe.md"), `---\nname: probe\nrole: worker\nlaunchOptions:\n  mcp-config: ${JSON.stringify(planted)}\n---\nbody\n`);
      const manifest = `apiVersion: cotal/v1\nkind: Mesh\nspace: ${root === prepared ? "upgrade-prepared" : space}\nagent: claude\nagents:\n  probe: ./.cotal/agents/probe.md\nchannels:\n  general: { description: Open., deliveryClass: live }\n`;
      writeFileSync(join(root, "mesh.yaml"), `${manifest}broker: { servers: ${JSON.stringify(legacyServer)}, auth: false }\n`);
      writeFileSync(join(root, "deploy.yaml"), manifest);
    }
    writeFileSync(join(legacy, ".cotal", "config.json"), JSON.stringify({ spawn: { env: ["TRUST_SMOKE_NAME"] } }));
    const priorHome = process.env.COTAL_HOME;
    const recordLegacy = (address: string, includePrepared = false) => {
      process.env.COTAL_HOME = home;
      try {
        const ts = new Date().toISOString();
        recordMesh({ space, server: address, root: legacy, mode: "open", origin: "up", ts });
        if (includePrepared) recordPreparedSpace({ space: "upgrade-prepared", root: prepared, ts });
      } finally { process.env.COTAL_HOME = priorHome; }
    };
    recordLegacy(server, true);
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
      COTAL_HOME: home, XDG_CONFIG_HOME: config, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1",
    };
    const guard = recordSmokeSandbox({ root: legacy, cotalHome: home, xdgConfigHome: config });
    const run = (cwd: string, argv: string[]) => {
      const options = { cwd, env, encoding: "utf8" as const, timeout: 50_000 };
      assertSmokeSandboxDown(guard, argv, options);
      return spawnSync(process.execPath, [cliEntry, ...argv], options);
    };
    const store = join(config, "cotal", "trusted-projects.json"), witness = join(home, "trusted-projects-seed.json");
    const recordsAbsent = () => !existsSync(store) && !existsSync(witness);
    const args = ["up", "-f", "mesh.yaml"];
    const json = run(legacy, [...args, "--json"]);
    check("the first legacy manifest JSON invocation names only the existing format refusal and writes neither trust record",
      json.status === 2 && json.stdout.includes('"code":"UNSUPPORTED"') && json.stdout.includes("omit --json") && recordsAbsent(), json);
    const plain = run(legacy, [...args, "--plain"]);
    check("the matching plain invocation names the existing format refusal without writing either trust record",
      plain.status === 2 && `${plain.stdout}${plain.stderr}`.includes("omit --plain") && recordsAbsent(), plain);
    const dryJson = run(legacy, [...args, "--dry-run", "--json"]);
    check("legacy manifest JSON dry run keeps the format refusal and writes neither trust record",
      dryJson.status === 2 && dryJson.stdout.includes('"code":"UNSUPPORTED"') && dryJson.stdout.includes("omit --json") && dryJson.stderr === "" && recordsAbsent(), dryJson);
    const dryPlain = run(legacy, [...args, "--dry-run", "--plain"]);
    check("legacy manifest plain dry run keeps the format refusal and writes neither trust record",
      dryPlain.status === 2 && `${dryPlain.stdout}${dryPlain.stderr}`.includes("omit --plain") && recordsAbsent(), dryPlain);
    const unregistered = run(clone, [...args, "--json"]);
    check("an unregistered manifest root still refuses and leaves pending legacy trust unwritten",
      unregistered.status === 1 && unregistered.stdout.includes("launchOptions.mcp-config") && unregistered.stdout.includes(`cotal trust ${clone}`) && recordsAbsent(), unregistered);
    const prefix = join(config, "cotal", "extensions");
    const pkg = "@cotal-ai/connector-claude-code";
    const source = resolve("extensions/connector-claude-code");
    mkdirSync(join(prefix, "node_modules", "@cotal-ai"), { recursive: true });
    symlinkSync(source, join(prefix, "node_modules", pkg), "dir");
    const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
    writeFileSync(join(prefix, "extensions.json"), JSON.stringify({ extensions: [{
      pkg, version, commands: [], provides: [{ kind: "connector", name: "claude" }],
      connectors: [{ name: "claude", requires: ["claude"], eventPlane: true, setup: null }],
    }] }));
    const nc = await dialerFor(server)({ servers: server });
    try {
      const kv = new Kvm(nc);
      await kv.create(presenceBucket(space));
      await kv.create(channelBucket(space));
    } finally { await nc.close(); }
    const previewCases = [
      { label: "up human", positiveRoot: legacy, argv: [...args, "--dry-run"], kind: null, plan: "Plan -" },
      { label: "team check", positiveRoot: legacy, argv: ["team", "check", "mesh.yaml", "--json"], kind: "team-check" },
      { label: "team boot", positiveRoot: prepared, argv: ["team", "boot", "mesh.yaml", "--dry-run", "--json"], kind: "fresh-team-boot-preview" },
      { label: "team deploy", positiveRoot: legacy, argv: ["team", "deploy", "deploy.yaml", "--dry-run", "--json"], kind: "additive-team-deploy-preview" },
      { label: "topology view", positiveRoot: legacy, argv: ["topology", "view", "-f", "mesh.yaml"], kind: null, plan: `Mesh "${space}"` },
      { label: "down", positiveRoot: legacy, argv: ["down", "-f", "mesh.yaml", "--dry-run", "--json"], kind: "whole-stack-local-preview", fromLegacy: true, expectedStatus: 4 },
      { label: "spawn", positiveRoot: legacy, argv: ["spawn", "--file", ".cotal/agents/probe.md", "--space", space, "--agent", "claude", "--dry-run", "--json"], kind: "direct-launch-preview" },
    ];
    fresh();
    const noEffects = () => recordsAbsent() && !reportText() && spawnSync("nc", ["-z", "127.0.0.1", new URL(legacyServer).port]).status !== 0;
    for (const { label, positiveRoot, argv, kind, plan, fromLegacy, expectedStatus = 0 } of previewCases) {
      const preview = run(positiveRoot, argv);
      const body = argv.includes("--json") && preview.status === expectedStatus ? JSON.parse(preview.stdout) : null;
      const answer = kind ? body?.result?.kind === kind : (body?.result?.plan ?? preview.stdout).includes(plan);
      check(`${label} previews a legacy root without writing trust or launching`,
        preview.status === expectedStatus && answer && noEffects() && body?.result?.effectAttempted !== true && body?.result?.launched !== true, preview);
      const refusal = run(fromLegacy ? legacy : clone, fromLegacy ? argv.map((word) => word === "mesh.yaml" ? join(clone, word) : word) : argv);
      const out = `${refusal.stdout}${refusal.stderr}`;
      check(`${label} refuses an unregistered persona without writing trust or launching`,
        refusal.status !== 0 && out.includes("launchOptions.mcp-config") && out.includes(`cotal trust ${clone}`) && noEffects(), refusal);
    }
    recordLegacy(legacyServer);
    const trustMessage = projectTrustProblem(["launchOptions.mcp-config"], legacy);
    const refusedTrust = (r: ReturnType<typeof run>) => r.status === 1 && r.stderr.includes(trustMessage) && !r.stdout.includes("Plan -");
    for (const [label, dir] of [["Cotal home", home], ["config folder", config]] as const) {
      chmodSync(dir, 0o777);
      try {
        const preview = run(legacy, [...args, "--dry-run"]);
        const readOnly = noEffects() && (statSync(dir).mode & 0o777) === 0o777;
        const live = run(legacy, args);
        const attempt = existsSync(witness) ? readFileSync(witness, "utf8") : undefined;
        const retryPreview = run(legacy, [...args, "--dry-run"]);
        const after = existsSync(witness) ? readFileSync(witness, "utf8") : undefined;
        check(`legacy preview and startup refuse the same trust setting with an unprotected ${label}`,
          refusedTrust(preview) && refusedTrust(live) && refusedTrust(retryPreview) && readOnly && !existsSync(store) && after === attempt
          && (label === "Cotal home" ? attempt === undefined : attempt !== undefined) && !reportText()
          && spawnSync("nc", ["-z", "127.0.0.1", new URL(legacyServer).port]).status !== 0, { preview, live, retryPreview, readOnly });
      } finally { chmodSync(dir, 0o700); }
    }
    const pending = existsSync(witness) ? readFileSync(witness, "utf8") : undefined;
    const recovered = run(legacy, [...args, "--dry-run"]);
    check("after the config is protected again, a legacy preview uses but does not complete the saved migration attempt",
      recovered.status === 0 && recovered.stdout.includes("Plan -") && pending !== undefined && readFileSync(witness, "utf8") === pending
      && !existsSync(store) && !reportText() && spawnSync("nc", ["-z", "127.0.0.1", new URL(legacyServer).port]).status !== 0, recovered);
    try {
      const retry = run(legacy, args);
      const livePort = new URL(legacyServer).port;
      const roots = existsSync(store) ? JSON.parse(readFileSync(store, "utf8")).roots as string[] : [];
      check("omitting the format flag starts the legacy manifest and migrates only eligible roots",
        retry.status === 0 && spawnSync("nc", ["-z", "127.0.0.1", livePort]).status === 0 && existsSync(witness) && roots.includes(legacy) && roots.includes(prepared) && !roots.includes(clone), retry);
    } finally {
      run(legacy, ["down", "--yes", "--with-agents"]);
    }
  }

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
    // The seed ran once for this Cotal home. Removing the trust file, as a refusal's remedy may say,
    // trusts nothing new on the next command, and neither does another config folder that shares the
    // registry, though both find no trust file.
    rmSync(trustedProjectsPath());
    await cli(box, ["trust", "--json", box]);
    check("after the trust file is removed, the next command seeds nothing", !trustedRoots().includes(later.root) && !trustedRoots().includes(preUpgrade), trustedRoots());
    const realXdg = process.env.XDG_CONFIG_HOME!;
    process.env.XDG_CONFIG_HOME = join(box, "xdg-other");
    mkdirSync(join(process.env.XDG_CONFIG_HOME, "cotal"), { recursive: true, mode: 0o700 });
    await cli(box, ["trust", "--json", box]);
    check("a second config folder sharing the registry seeds nothing", !trustedRoots().includes(later.root) && !trustedRoots().includes(preUpgrade), trustedRoots());
    process.env.XDG_CONFIG_HOME = realXdg;
  }

  // A seed whose trust file write failed records its attempt first, so when it later succeeds it adds
  // only the roots known at that first attempt, never one registered in between.
  {
    const realHome = process.env.COTAL_HOME!, realXdg = process.env.XDG_CONFIG_HOME!;
    process.env.COTAL_HOME = join(box, "home-retry");
    process.env.XDG_CONFIG_HOME = join(box, "xdg-retry");
    mkdirSync(process.env.COTAL_HOME, { recursive: true, mode: 0o700 });
    const before = mkdtempSync(join(box, "retry-before-"));
    recordMesh({ space: "retrybefore", server, root: before, mode: "open", origin: "manual", ts: new Date().toISOString() } as never);
    // A config folder other accounts may write: the trust file is refused, the seed attempt recorded.
    mkdirSync(process.env.XDG_CONFIG_HOME, { mode: 0o777 });
    chmodSync(process.env.XDG_CONFIG_HOME, 0o777);
    const failed = await cli(box, ["status", "--json"]);
    check("a seed that cannot write the trust file warns only in the JSON envelope", !existsSync(trustedProjectsPath()) && failed.stderr === ""
      && JSON.parse(failed.stdout).warnings.some((w: { code: string }) => w.code === "PROJECT_TRUST_SEED_FAILED"), failed.out.slice(-300));
    const between = mkdtempSync(join(box, "retry-between-"));
    recordMesh({ space: "retrybetween", server, root: between, mode: "open", origin: "manual", ts: new Date().toISOString() } as never);
    chmodSync(process.env.XDG_CONFIG_HOME, 0o700);
    await cli(box, ["meshes", "--json"]);
    check("the retried seed adds the roots of its first attempt", trustedRoots().includes(before), trustedRoots());
    check("and not a space registered after that attempt", !trustedRoots().includes(between), trustedRoots());
    process.env.COTAL_HOME = realHome;
    process.env.XDG_CONFIG_HOME = realXdg;
  }

  {
    const home = mkdtempSync(join(box, "home-prepared-fault-"));
    const cwd = mkdtempSync(join(box, "status-prepared-fault-"));
    const prepared = join(home, "prepared");
    writeFileSync(prepared, "not a directory");
    const status = spawnSync(process.execPath, [cliEntry, "status", "--json"], {
      cwd, encoding: "utf8", timeout: 30_000,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
        COTAL_HOME: home, XDG_CONFIG_HOME: join(home, "config"), COTAL_TELEMETRY: "off", COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1",
      },
    });
    const output = status.stdout ? JSON.parse(status.stdout) : undefined;
    check("an unexpected trust seed error leaves status free to report the partial registry in JSON",
      output?.command === "status" && output.result !== null && output.completeness === "partial" && status.stderr === ""
      && output.warnings.some((w: { code: string; message: string }) => w.code === "PROJECT_TRUST_SEED_FAILED" && w.message.includes(prepared))
      && JSON.parse(readFileSync(join(home, "trusted-projects-seed.json"), "utf8")).roots.length === 0,
      { status: status.status, stdout: status.stdout?.slice(0, 500), stderr: status.stderr?.slice(0, 500) });
  }

  // A damaged seed record warns and blocks nothing: `cotal trust` still records a folder, a folder
  // already in the trust file stays trusted, and the warning says how to clear it.
  {
    const p = project(declares);
    await cli(p.root, ["trust", p.root]);
    const seed = join(process.env.COTAL_HOME!, "trusted-projects-seed.json");
    const kept = readFileSync(seed, "utf8");
    writeFileSync(seed, "{not json");
    const other = mkdtempSync(join(box, "damaged-seed-"));
    const t = await cli(box, ["trust", other]);
    fresh();
    const r = await spawnIn(p);
    writeFileSync(seed, kept);
    check("a damaged seed record does not block cotal trust or a trusted folder",
      t.exited === undefined && trustedRoots().includes(other) && t.out.includes("the project trust upgrade seed did not complete") && t.out.includes(`remove ${seed}`)
        && r.exited === undefined && reportText().includes(`RAN ${p.marker}`), { trust: t.out.slice(-400), spawn: r.out.slice(-200) });
    // A seed record other accounts may write is never repaired in place: its roots may be theirs, so
    // the remedy is to remove it, and nothing it lists is added.
    const listed = mkdtempSync(join(box, "writable-seed-"));
    writeFileSync(seed, JSON.stringify({ schemaVersion: 1, attemptedAt: new Date().toISOString(), roots: [listed] }));
    chmodSync(seed, 0o666);
    const w = await cli(box, ["meshes", "--json"]);
    writeFileSync(seed, kept);
    chmodSync(seed, 0o600);
    check("a seed record other accounts may write adds nothing and says to remove it",
      !trustedRoots().includes(listed) && w.out.includes("other accounts can write it") && w.out.includes(`remove ${seed}`) && !w.out.includes("chmod 600"), w.out.slice(-400));
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
    const p = project(declares, "project with spaces ");
    fresh();
    const r = await spawnIn(p);
    check("an untrusted folder's declared server does not start", !reportText().includes(`RAN ${p.marker}`), reportText());
    check("an untrusted folder's spawn launches no host", !reportText().includes("ENV "), reportText());
    check("the refusal exits non-zero", r.exited === 1, r.exited);
    check("the refusal names the entries, the folder and `cotal trust`", r.out.includes("connectors.claude.mcpServers.planted") && r.out.includes("spawn.env") && r.out.includes(p.root) && r.out.includes(`cotal trust -- "${p.root}"`), r.out.slice(-500));
    const fixed = runTrustRemedy(r.out, p.root) && (await spawnIn(p)).exited === undefined;
    check("the printed command handles a path with spaces and the same launch then succeeds", fixed && reportText().includes(`RAN ${p.marker}`) && reportText().includes("ENV forwarded-1118"), reportText());
  }

  // Only `spawn.env` declared: still refused, and the host never sees the name.
  {
    const p = project(() => ({ spawn: { env: ["TRUST_SMOKE_NAME"] } }), "project %PATH% $HOME & ' ");
    fresh();
    const r = await spawnIn(p);
    check("an untrusted folder's spawn.env alone is refused", r.exited === 1 && !reportText().includes("forwarded-1118"), r.out.slice(-300));
    const fixed = runTrustRemedy(r.out, p.root) && (await spawnIn(p)).exited === undefined;
    check("the printed command handles shell metacharacters and the same launch then succeeds", fixed && reportText().includes("ENV forwarded-1118"), r.out.slice(-500));
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
    check("the persona refusal's printed command records trust", runTrustRemedy(r.out, p.root), r.out.slice(-400));
    fresh();
    await spawnIn(p);
    check("CONTROL: a trusted project's persona launch options reach the host", reportText().includes(`RAN persona-${p.marker}`), reportText());
    // A caller's own --opt is the caller's choice, not the project's.
    const q = project(undefined);
    fresh();
    const o = await cli(q.root, ["spawn", "--foreground", "--file", join(q.root, ".cotal", "agents", "probe.md"), "--space", q.space, "--agent", "claude", "--opt", `mcp-config=${planted}`]);
    check("--opt given by the caller is not gated in an untrusted project", o.exited === undefined && reportText().includes(`RAN persona-${p.marker}`), o.out.slice(-300));
  }

  for (const [suffix, form] of [["-back\\slash", "quoted"], ["-trailing\\", "hex"]] as const) {
    const p = project(undefined, "", suffix);
    const file = join(p.root, ".cotal", "agents", "probe.md");
    const planted = join(box, `${p.marker}.json`);
    const marker = `RAN ${p.marker}`;
    writeFileSync(planted, JSON.stringify({ mcpServers: { test: { command: "/bin/sh", args: ["-c", `echo ${marker} >> ${JSON.stringify(report)}`] } } }));
    writeFileSync(file, `---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nlaunchOptions:\n  mcp-config: ${JSON.stringify(planted)}\n---\nbody\n`);
    fresh();
    const refused = await spawnIn(p);
    const argument = form === "quoted" ? `-- "${p.root}"` : `--hex ${Buffer.from(p.root).toString("hex")}`;
    const named = refused.exited === 1 && refused.out.includes(file) && refused.out.includes("launchOptions.mcp-config")
      && refused.out.includes(`cotal trust ${argument}\``) && reportText() === "";
    const remedied = named && runTrustRemedy(refused.out, p.root);
    const launched = remedied && (await spawnIn(p)).exited === undefined && reportText().includes(marker);
    check(`a ${form} backslash-root remedy works when pasted into a POSIX shell`, launched, { out: refused.out.slice(-600), report: reportText() });
  }
  {
    const p = project(undefined);
    const file = join(p.root, ".cotal", "agents", "a\\..\\x.md");
    const planted = join(box, `${p.marker}.json`);
    const marker = `RAN ${p.marker}`;
    writeFileSync(planted, JSON.stringify({ mcpServers: { test: { command: "/bin/sh", args: ["-c", `echo ${marker} >> ${JSON.stringify(report)}`] } } }));
    writeFileSync(file, `---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nlaunchOptions:\n  mcp-config: ${JSON.stringify(planted)}\n---\nbody\n`);
    fresh();
    const trusted = await cli(p.root, ["trust", p.root]);
    const launched = await cli(p.root, ["spawn", "--foreground", "--file", file, "--space", p.space, "--agent", "claude"]);
    check("a trusted persona named a\\..\\x.md is one literal POSIX file and its launch options reach the host",
      trusted.exited === undefined && launched.exited === undefined && reportText().includes(marker), launched.out.slice(-600));
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

  // A persona file a manifest names follows the same rule. `team check` resolves the manifest as
  // `team deploy` and `up -f` do, and is refused before any broker is contacted; the manifest's own
  // launch options are not gated. A persona nested below `.cotal/agents` belongs to the project too.
  {
    const p = project(undefined);
    mkdirSync(join(p.root, ".cotal", "agents", "team"), { recursive: true });
    writeFileSync(join(p.root, ".cotal", "agents", "team", "opts.md"), "---\nname: opts\nrole: worker\nlaunchOptions:\n  mcp-config: /tmp/planted.json\n---\nbody\n");
    const manifest = (agent: string) => `apiVersion: cotal/v1\nkind: Mesh\nspace: ${p.space}\nagent: claude\nbroker: { auth: false }\nagents:\n${agent}\nchannels:\n  general: { description: Open. }\n`;
    writeFileSync(join(p.root, "nested.yaml"), manifest("  probe: ./.cotal/agents/team/opts.md"));
    const nested = await cli(p.root, ["team", "check", join(p.root, "nested.yaml"), "--json"]);
    // A classified refusal is written to the descriptor, so its text is read from the same resolution
    // the command runs, and the command's own outcome from its exit code.
    let reason = "";
    try { loadManifest(join(p.root, "nested.yaml")); } catch (e) { reason = (e as Error).message; }
    check("a manifest naming an untrusted project's persona with launch options is refused", nested.exited === 1 && reason.includes("launchOptions.mcp-config") && reason.includes(`cotal trust ${p.root}`), { exited: nested.exited, reason: reason.slice(0, 300) });
    writeFileSync(join(p.root, "own.yaml"), manifest("  probe:\n    persona: ./.cotal/agents/probe.md\n    launchOptions: { mcp-config: /tmp/manifest.json }"));
    const own = await cli(p.root, ["team", "check", join(p.root, "own.yaml"), "--json"]);
    check("a manifest's own launch options are not gated", own.exited === undefined, own.out.slice(-300));
    check("the manifest refusal's printed command records trust", runTrustRemedy(reason, p.root), reason);
    const trusted = await cli(p.root, ["team", "check", join(p.root, "nested.yaml"), "--json"]);
    check("CONTROL: the same manifest resolves once the folder is trusted", trusted.exited === undefined, trusted.out.slice(-300));
    // `foo.cotal/agents` is not a project's `.cotal/agents`: matched by whole path segments.
    const lookalike = mkdtempSync(join(box, "lookalike-"));
    mkdirSync(join(lookalike, "foo.cotal", "agents"), { recursive: true });
    const planted = join(lookalike, "planted-mcp.json");
    writeFileSync(planted, JSON.stringify({ mcpServers: { lookalike: { command: "/bin/sh", args: ["-c", `echo RAN lookalike >> ${JSON.stringify(report)}`] } } }));
    const file = join(lookalike, "foo.cotal", "agents", "probe.md");
    writeFileSync(file, `---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nlaunchOptions:\n  mcp-config: ${planted}\n---\nbody\n`);
    const q = project(undefined);
    fresh();
    const r = await cli(q.root, ["spawn", "--foreground", "--file", file, "--space", q.space, "--agent", "claude"]);
    check("a persona under foo.cotal/agents is not taken for a project's", r.exited === undefined && reportText().includes("RAN lookalike"), r.out.slice(-300));
  }

  // A persona file is judged by the path as written and by the file a read of it reaches. A link
  // outside any `.cotal/agents` to an untrusted project's persona, and a link in a trusted project's
  // `.cotal/agents` to that persona, both belong to the untrusted project. A link to a persona in the
  // same trusted project, and a plain file outside any `.cotal/agents`, keep their launch options.
  {
    const untrusted = project(undefined);
    const planted = join(untrusted.root, "planted-mcp.json");
    writeFileSync(planted, JSON.stringify({ mcpServers: { vialink: { command: "/bin/sh", args: ["-c", `echo RAN link-untrusted >> ${JSON.stringify(report)}`] } } }));
    const target = join(untrusted.root, ".cotal", "agents", "probe.md");
    writeFileSync(target, `---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nlaunchOptions:\n  mcp-config: ${planted}\n---\nbody\n`);
    const trusted = project(undefined);
    await cli(trusted.root, ["trust", trusted.root]);
    const ownPlanted = join(trusted.root, "own-mcp.json");
    writeFileSync(ownPlanted, JSON.stringify({ mcpServers: { own: { command: "/bin/sh", args: ["-c", `echo RAN link-same >> ${JSON.stringify(report)}`] } } }));
    writeFileSync(join(trusted.root, ".cotal", "agents", "own.md"), `---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nlaunchOptions:\n  mcp-config: ${ownPlanted}\n---\nbody\n`);
    const outside = mkdtempSync(join(box, "links-"));
    const linkOut = join(outside, "link.md");
    symlinkSync(target, linkOut);
    const linkIn = join(trusted.root, ".cotal", "agents", "link.md");
    symlinkSync(target, linkIn);
    const linkSame = join(trusted.root, ".cotal", "agents", "same.md");
    symlinkSync(join(trusted.root, ".cotal", "agents", "own.md"), linkSame);
    const spawnFile = (file: string) => cli(trusted.root, ["spawn", "--foreground", "--file", file, "--space", trusted.space, "--agent", "claude"]);
    const checkManifest = async (file: string): Promise<{ exited?: number; reason: string }> => {
      const path = join(outside, `m-${file.split("/").pop()}.yaml`);
      writeFileSync(path, `apiVersion: cotal/v1\nkind: Mesh\nspace: ${trusted.space}\nagent: claude\nbroker: { auth: false }\nagents:\n  probe: ${file}\nchannels:\n  general: { description: Open. }\n`);
      const r = await cli(trusted.root, ["team", "check", path, "--json"]);
      let reason = "";
      try { loadManifest(path); } catch (e) { reason = (e as Error).message; }
      return { exited: r.exited, reason };
    };
    fresh();
    const out = await spawnFile(linkOut);
    const outManifest = await checkManifest(linkOut);
    check("a link outside .cotal/agents to an untrusted project's persona is refused",
      out.exited === 1 && !reportText().includes("RAN link-untrusted") && out.out.includes(`which leads to ${target}`) && out.out.includes(`cotal trust ${untrusted.root}`)
        && outManifest.exited === 1 && outManifest.reason.includes(`cotal trust ${untrusted.root}`), { out: out.out.slice(-300), manifest: outManifest });
    fresh();
    const inside = await spawnFile(linkIn);
    const inManifest = await checkManifest(linkIn);
    check("a link in a trusted project's .cotal/agents to an untrusted project's persona is refused",
      inside.exited === 1 && !reportText().includes("RAN link-untrusted") && inside.out.includes(`cotal trust ${untrusted.root}`)
        && inManifest.exited === 1 && inManifest.reason.includes(`cotal trust ${untrusted.root}`), { out: inside.out.slice(-300), manifest: inManifest });
    fresh();
    const same = await spawnFile(linkSame);
    const sameManifest = await checkManifest(linkSame);
    check("a link to a persona in the same trusted project keeps its launch options", same.exited === undefined && reportText().includes("RAN link-same") && sameManifest.exited === undefined, { out: same.out.slice(-300), manifest: sameManifest });
    const plain = join(outside, "plain.md");
    writeFileSync(plain, `---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nlaunchOptions:\n  mcp-config: ${planted}\n---\nbody\n`);
    fresh();
    const plainRun = await spawnFile(plain);
    check("a plain persona file outside any .cotal/agents keeps its launch options", plainRun.exited === undefined && reportText().includes("RAN link-untrusted"), plainRun.out.slice(-300));
    // The path as written counts too: a link in an untrusted project's `.cotal/agents` that names a
    // file outside it, here in that project's own root, still belongs to that project.
    const escaped = join(untrusted.root, "escaped.md");
    writeFileSync(escaped, `---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nlaunchOptions:\n  mcp-config: ${planted}\n---\nbody\n`);
    const linkOutward = join(untrusted.root, ".cotal", "agents", "outward.md");
    symlinkSync(escaped, linkOutward);
    fresh();
    const outward = await spawnFile(linkOutward);
    check("a link in an untrusted project's .cotal/agents to a file outside it is refused", outward.exited === 1 && !reportText().includes("RAN link-untrusted") && outward.out.includes(`cotal trust ${untrusted.root}`), outward.out.slice(-300));

    // Every hop is judged, not only the first and last spellings. U/.cotal/agents/hop.md is a link to
    // ../../cfg/x.md, a persona outside U's .cotal/agents; a link from outside, or from the trusted
    // project's .cotal/agents, names that middle link. A project whose .cotal is itself a link to
    // another folder is judged by the path through it.
    mkdirSync(join(untrusted.root, "cfg"));
    const cfgPersona = join(untrusted.root, "cfg", "x.md");
    writeFileSync(cfgPersona, `---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nlaunchOptions:\n  mcp-config: ${planted}\n---\nbody\n`);
    symlinkSync("../../cfg/x.md", join(untrusted.root, ".cotal", "agents", "hop.md"));
    const chainOut = join(outside, "chain.md");
    symlinkSync(join(untrusted.root, ".cotal", "agents", "hop.md"), chainOut);
    const chainIn = join(trusted.root, ".cotal", "agents", "chain.md");
    symlinkSync(join(untrusted.root, ".cotal", "agents", "hop.md"), chainIn);
    fresh();
    const chainOutRun = await spawnFile(chainOut);
    const chainOutManifest = await checkManifest(chainOut);
    check("a two-link chain from outside through an untrusted project's .cotal/agents is refused",
      chainOutRun.exited === 1 && !reportText().includes("RAN link-untrusted") && chainOutRun.out.includes(`cotal trust ${untrusted.root}`)
        && chainOutManifest.exited === 1 && chainOutManifest.reason.includes(`cotal trust ${untrusted.root}`), { out: chainOutRun.out.slice(-300), manifest: chainOutManifest });
    fresh();
    const chainInRun = await spawnFile(chainIn);
    const chainInManifest = await checkManifest(chainIn);
    check("a two-link chain from a trusted project through an untrusted project's .cotal/agents is refused",
      chainInRun.exited === 1 && !reportText().includes("RAN link-untrusted") && chainInRun.out.includes(`cotal trust ${untrusted.root}`)
        && chainInManifest.exited === 1 && chainInManifest.reason.includes(`cotal trust ${untrusted.root}`), { out: chainInRun.out.slice(-300), manifest: chainInManifest });
    const linkedDir = mkdtempSync(join(box, "linked-dir-"));
    mkdirSync(join(linkedDir, "cfg", "agents"), { recursive: true });
    writeFileSync(join(linkedDir, "cfg", "agents", "x.md"), `---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nlaunchOptions:\n  mcp-config: ${planted}\n---\nbody\n`);
    symlinkSync("cfg", join(linkedDir, ".cotal"));
    const dirLink = join(outside, "dirlink.md");
    symlinkSync(join(linkedDir, ".cotal", "agents", "x.md"), dirLink);
    fresh();
    const dirRun = await spawnFile(dirLink);
    const dirManifest = await checkManifest(dirLink);
    check("a persona reached through a project's linked .cotal folder is refused",
      dirRun.exited === 1 && !reportText().includes("RAN link-untrusted") && dirRun.out.includes(`cotal trust ${linkedDir}`)
        && dirManifest.exited === 1, { out: dirRun.out.slice(-300), manifest: dirManifest });
    // A chain that stays inside one trusted project keeps its launch options.
    mkdirSync(join(trusted.root, "cfg"));
    writeFileSync(join(trusted.root, "cfg", "own.md"), `---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nlaunchOptions:\n  mcp-config: ${ownPlanted}\n---\nbody\n`);
    symlinkSync("../../cfg/own.md", join(trusted.root, ".cotal", "agents", "mid.md"));
    symlinkSync("mid.md", join(trusted.root, ".cotal", "agents", "inner.md"));
    fresh();
    const innerRun = await spawnFile(join(trusted.root, ".cotal", "agents", "inner.md"));
    check("a two-link chain inside one trusted project keeps its launch options", innerRun.exited === undefined && reportText().includes("RAN link-same"), innerRun.out.slice(-300));
    // A loop is refused rather than followed.
    symlinkSync("loop-b.md", join(outside, "loop-a.md"));
    symlinkSync("loop-a.md", join(outside, "loop-b.md"));
    fresh();
    const loopRun = await spawnFile(join(outside, "loop-a.md"));
    const loopManifest = await checkManifest(join(outside, "loop-a.md"));
    check("a persona path that loops is refused", loopRun.exited === 1 && loopManifest.exited === 1 && !reportText().includes("ENV "), { out: loopRun.out.slice(-300), manifest: loopManifest });
  }

  // Trust is stored canonically, so another spelling of a trusted folder is trusted: a path through a
  // linked parent, and one with a trailing separator.
  {
    const p = project(declares);
    await cli(p.root, ["trust", `${p.root}/`]);
    fresh();
    const viaSlash = await spawnIn(p);
    check("a folder trusted with a trailing separator is trusted", viaSlash.exited === undefined && reportText().includes(`RAN ${p.marker}`), viaSlash.out.slice(-300));
    const q = project(declares);
    const alias = join(box, `alias-${q.space}`);
    symlinkSync(join(q.root, ".."), alias);
    const aliased = join(alias, q.root.split("/").pop()!);
    await cli(box, ["trust", aliased]);
    fresh();
    const viaLink = await spawnIn(q);
    check("a folder trusted through a linked parent is trusted", viaLink.exited === undefined && reportText().includes(`RAN ${q.marker}`), viaLink.out.slice(-300));
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

const EXPECTED = process.getuid?.() === 0 ? 88 : 90;
if (passed + failed !== EXPECTED) { failed++; console.log(`  ✗ FAIL: ${passed + failed - 1} cells reported, ${EXPECTED} expected`); }
emitSentinel({ passed, failed });
process.exit(failed === 0 ? 0 : 1);
