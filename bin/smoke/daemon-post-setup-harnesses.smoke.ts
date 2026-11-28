/**
 * Agent applications installed into per-user installer folders (`~/.local/bin`, `~/.opencode/bin`,
 * `~/.pi/agent/bin`) after the background service was set up are found on the next Manager status
 * read and by `cotal spawn`, on both macOS and Linux, with the daemon and hosted Manager PIDs
 * unchanged and without altering resolution of executables already on the caller's PATH.
 *
 * Runs identically on Linux (`renderDaemonUnit` systemd user unit) and macOS (`launchAgentService`
 * LaunchAgent plist).
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveOnPath } from "@cotal-ai/workspace";
import { createSuite, killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { daemonPaths } from "../daemon/endpoint.js";
import { planInstalledPathRefresh, renderDaemonUnit } from "../daemon/install.js";
import { launchAgentService } from "../daemon/install-darwin.js";
import { serviceApplicationPath } from "../daemon/desktop-path.js";
import { createFixtureSpace } from "./_fixture-space.mjs";

if (process.platform !== "linux" && process.platform !== "darwin") {
  skipSuite(`daemon-post-setup-harnesses: POSIX service PATH only; skipped on ${process.platform}`);
}

for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];

const { check, finish, passed, failed } = createSuite();
const runtime = fileURLToPath(new URL("..", import.meta.url));
const cli = join(runtime, "dist", "cotal.js");
if (!existsSync(cli)) {
  console.error(`✗ ${cli} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}
const root = realpathSync(mkdtempSync(join(tmpdir(), "psh-")));
const savedEnv = Object.fromEntries(["HOME", "COTAL_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "PATH", "NATS_SERVER_BIN"].map(key => [key, process.env[key]]));
const resolvedNatsServer = process.env.NATS_SERVER_BIN || resolveOnPath("nats-server", process.env);
if (resolvedNatsServer) process.env.NATS_SERVER_BIN = resolvedNatsServer;

const home = join(root, "home");
const cotalHome = join(root, "cotal");
const configHome = join(root, "config");
const runDir = join(root, "rt");
const callerBin = join(root, "caller-bin");
for (const dir of [home, cotalHome, configHome, runDir, callerBin]) mkdirSync(dir, { recursive: true, mode: 0o700 });

const callerNodeDir = dirname(process.execPath);
const callerPath = [callerBin, callerNodeDir, "/usr/local/bin", "/usr/bin", "/bin"]
  .filter((entry, index, all) => entry.startsWith("/") && all.indexOf(entry) === index)
  .join(":");

process.env.HOME = home;
process.env.COTAL_HOME = cotalHome;
process.env.XDG_CONFIG_HOME = configHome;
process.env.XDG_RUNTIME_DIR = runDir;
process.env.PATH = callerPath;

const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["NODE_OPTIONS", "NODE_PATH", "NOTIFY_SOCKET"].includes(key))),
  HOME: home,
  COTAL_HOME: cotalHome,
  XDG_CONFIG_HOME: configHome,
  XDG_RUNTIME_DIR: runDir,
  PATH: callerPath,
  DO_NOT_TRACK: "1",
  NO_COLOR: "1",
  COTAL_SKIP_CONNECTOR_SEED: "1",
};

const callCli = (args: string[], cwd: string, customEnv = env): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise(resolve => {
    execFile(process.execPath, [cli, ...args], { env: customEnv, cwd, timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

let fixture: Awaited<ReturnType<typeof createFixtureSpace>> | undefined;
let daemon: ReturnType<typeof spawn> | undefined;

try {
  // Place an executable on the caller's PATH and a conflicting shadow in ~/.local/bin later:
  // the caller's PATH must keep precedence.
  const callerTool = join(callerBin, "caller-precedence-app");
  writeFileSync(callerTool, "#!/bin/sh\necho caller-wins\n", { mode: 0o755 });

  // None of the three per-user installer folders exist when the service unit/plist is rendered.
  const folders = [
    { rel: ".local/bin", connector: "late-local", binary: "late-local-bin", seat: "seat_late_local" },
    { rel: ".opencode/bin", connector: "late-opencode", binary: "late-opencode-bin", seat: "seat_late_opencode" },
    { rel: ".pi/agent/bin", connector: "late-pi", binary: "late-pi-bin", seat: "seat_late_pi" },
  ] as const;
  for (const item of folders) {
    check(`installer folder ~/${item.rel} does not exist before service install`, !existsSync(join(home, item.rel)));
  }

  let pinnedServicePath: string;
  const paths = daemonPaths(env, cotalHome);
  const savedArgv = process.argv;
  const savedExecArgv = process.execArgv;
  process.argv = [process.execPath, cli];
  process.execArgv = [];
  try {
    if (process.platform === "darwin") {
      mkdirSync(join(home, "Library"), { recursive: true, mode: 0o700 });
      mkdirSync(paths.state, { recursive: true, mode: 0o700 });
      const service = launchAgentService(
        call => ({ status: call === "/bin/launchctl" ? 113 : 0, stdout: "", stderr: "", detail: "" }),
        () => ({ state: "absent" }),
      );
      const plan = service.plan(paths, undefined, [process.execPath, cli, "daemon", "serve"], () => serviceApplicationPath());
      const match = /<key>PATH<\/key><string>([^<]+)<\/string>/.exec(plan.bytes.toString("utf8"));
      check("macOS LaunchAgent plist pins PATH with appended installer folders", Boolean(match));
      pinnedServicePath = match![1]!
        .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
    } else {
      const unit = renderDaemonUnit(join(configHome, "systemd", "user"), undefined);
      const match = /^Environment=PATH="((?:\\.|[^"\\])*)"$/m.exec(unit.bytes);
      check("Linux systemd unit pins PATH with appended installer folders", Boolean(match));
      pinnedServicePath = match![1]!.replace(/\\([\\"])/g, "$1").replaceAll("%%", "%");
    }
  } finally {
    process.argv = savedArgv;
    process.execArgv = savedExecArgv;
  }

  const expectedSuffix = folders.map(item => join(home, item.rel));
  check(
    "service PATH keeps caller entries first and appends each missing per-user installer folder once",
    pinnedServicePath === [...callerPath.split(":"), ...expectedSuffix].join(":"),
    pinnedServicePath,
  );

  if (process.platform === "linux") {
    const refreshRoot = join(root, "refresh-check");
    const refreshConfig = join(refreshRoot, "config");
    const refreshState = join(refreshRoot, "state");
    const fakeSys = join(refreshRoot, "sys");
    for (const dir of [join(refreshConfig, "systemd", "user"), refreshState, fakeSys]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(fakeSys, "systemctl"),
      `#!/bin/sh\nif [ "$1" = "--user" ] && [ "$2" = "show-environment" ]; then printf 'XDG_CONFIG_HOME=%s\\n' ${JSON.stringify(refreshConfig)}; exit 0; fi\nexit 0\n`,
      { mode: 0o700 },
    );
    const oldUnitPath = join(refreshConfig, "systemd", "user", "cotal-daemon.service");
    const oldUnit = `[Service]\nEnvironment=PATH="/old-only:/usr/bin:/bin"\nExecStart="${process.execPath}" "${cli}" "daemon" "serve"\n`;
    writeFileSync(oldUnitPath, oldUnit, { mode: 0o600 });
    writeFileSync(
      join(refreshState, "service-unit.json"),
      `${JSON.stringify({ v: 1, mechanism: "systemd-user", unit: "cotal-daemon.service", unitPath: oldUnitPath, unitSha256: createHash("sha256").update(oldUnit).digest("hex"), installedAt: "2026-11-27T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );
    const prevPath = process.env.PATH;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = refreshConfig;
      process.env.PATH = `${fakeSys}:/new-term:/usr/bin:/bin`;
      const applyRefresh = planInstalledPathRefresh({ dir: refreshState, socket: join(refreshState, "daemon.sock"), state: refreshState, lock: join(refreshState, "daemon.lock") }, undefined);
      applyRefresh?.();
      const rewritten = readFileSync(oldUnitPath, "utf8");
      const expectedRefreshed = [fakeSys, "/new-term", "/usr/bin", "/bin", "/old-only", ...expectedSuffix].join(":");
      check(
        "refreshing an older unit appends installer folders after both terminal and older pinned entries",
        rewritten.includes(`Environment=PATH="${expectedRefreshed}"\n`),
        rewritten,
      );
    } finally {
      process.env.PATH = prevPath;
      process.env.XDG_CONFIG_HOME = prevXdg;
    }

    if (existsSync("/run/systemd/system")) {
      const corruptRoot = join(root, "cs");
      const corruptHome = join(corruptRoot, "home");
      const corruptCotalHome = join(corruptRoot, "cotal");
      const corruptConfig = join(corruptRoot, "config");
      const corruptRun = join(corruptRoot, "r");
      const corruptBin = join(corruptRoot, "bin");
      for (const dir of [corruptHome, corruptCotalHome, join(corruptConfig, "systemd", "user"), corruptRun, corruptBin]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      cpSync(join(runtime, "dist"), join(corruptBin, "dist"), { recursive: true });
      cpSync(join(runtime, "package.json"), join(corruptBin, "package.json"));
      symlinkSync(join(runtime, "node_modules"), join(corruptBin, "node_modules"));
      symlinkSync(join(runtime, "..", "node_modules"), join(corruptRoot, "node_modules"));
      const corruptCli = join(corruptBin, "dist", "cotal.js");
      const corruptSeeded = join(corruptBin, "dist", "daemon", "seeded-installers.json");
      writeFileSync(
        join(fakeSys, "systemctl"),
        `#!/bin/sh\nif [ "$1" = "--user" ] && [ "$2" = "show-environment" ]; then printf 'XDG_CONFIG_HOME=%s\\n' ${JSON.stringify(corruptConfig)}; exit 0; fi\nexit 0\n`,
        { mode: 0o700 },
      );
      writeFileSync(join(fakeSys, "loginctl"), "#!/bin/sh\nprintf 'Linger=yes\\n'\n", { mode: 0o700 });
      const corruptEnv: NodeJS.ProcessEnv = {
        ...env,
        HOME: corruptHome,
        USER: "smoke",
        LOGNAME: "smoke",
        COTAL_HOME: corruptCotalHome,
        XDG_CONFIG_HOME: corruptConfig,
        XDG_RUNTIME_DIR: corruptRun,
        PATH: `${fakeSys}:${callerPath}`,
      };
      const callCorruptCli = (args: string[]) =>
        new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
          execFile(process.execPath, [corruptCli, ...args], { env: corruptEnv, cwd: corruptHome, timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => {
            const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          });
        });

      writeFileSync(corruptSeeded, "{", { mode: 0o600 });
      const truncatedInstall = await callCorruptCli(["daemon", "install", "--dry-run", "--json"]);
      const truncatedDoc = JSON.parse(truncatedInstall.stdout || "{}") as { outcome?: string; error?: { code?: string; message?: string; remedy?: string } };
      check(
        "corrupt seeded-installers.json refuses daemon install with file path and reinstall guidance instead of SyntaxError",
        truncatedInstall.code === 2
          && truncatedDoc.outcome === "refused"
          && truncatedDoc.error?.code === "DEPENDENCY_UNAVAILABLE"
          && (truncatedDoc.error.message ?? "").includes(corruptSeeded)
          && /reinstall/i.test(truncatedDoc.error.message ?? "")
          && /reinstall/i.test(truncatedDoc.error.remedy ?? ""),
        truncatedInstall,
      );

      writeFileSync(corruptSeeded, "{}\n", { mode: 0o600 });
      const emptyShapeInstall = await callCorruptCli(["daemon", "install", "--dry-run", "--json"]);
      const emptyShapeDoc = JSON.parse(emptyShapeInstall.stdout || "{}") as { outcome?: string; error?: { code?: string; message?: string; remedy?: string } };
      check(
        "malformed seeded-installers.json refuses daemon install without falling back to an empty folder list",
        emptyShapeInstall.code === 2
          && emptyShapeDoc.outcome === "refused"
          && emptyShapeDoc.error?.code === "DEPENDENCY_UNAVAILABLE"
          && (emptyShapeDoc.error.message ?? "").includes(corruptSeeded),
        emptyShapeInstall,
      );

      const repairPaths = daemonPaths(corruptEnv, corruptCotalHome);
      mkdirSync(repairPaths.state, { recursive: true, mode: 0o700 });
      const missingUnitPath = join(corruptConfig, "systemd", "user", "cotal-daemon.service");
      const missingUnit = [
        "[Service]",
        `Environment=PATH="/usr/bin:/bin"`,
        "Environment=COTAL_DAEMON_NATIVE_SERVICE=1",
        `ExecStart="${join(corruptRoot, "missing-node")}" "${join(corruptRoot, "missing-cotal.js")}" "daemon" "serve"`,
        "",
      ].join("\n");
      writeFileSync(missingUnitPath, missingUnit, { mode: 0o600 });
      writeFileSync(
        join(repairPaths.state, "service-unit.json"),
        `${JSON.stringify({ v: 1, mechanism: "systemd-user", unit: "cotal-daemon.service", unitPath: missingUnitPath, unitSha256: createHash("sha256").update(missingUnit).digest("hex"), installedAt: "2026-11-27T00:00:00.000Z" })}\n`,
        { mode: 0o600 },
      );
      writeFileSync(corruptSeeded, "{", { mode: 0o600 });
      const truncatedRepair = await callCorruptCli(["daemon", "install", "--json"]);
      const repairDoc = JSON.parse(truncatedRepair.stdout || "{}") as { outcome?: string; error?: { code?: string; message?: string; remedy?: string } };
      check(
        "corrupt seeded-installers.json refuses missing-program service repair with file path and reinstall guidance",
        truncatedRepair.code === 2
          && repairDoc.outcome === "refused"
          && repairDoc.error?.code === "DEPENDENCY_UNAVAILABLE"
          && (repairDoc.error.message ?? "").includes(corruptSeeded)
          && /reinstall/i.test(repairDoc.error.message ?? "")
          && /reinstall/i.test(repairDoc.error.remedy ?? ""),
        truncatedRepair,
      );
    }
  }

  fixture = await createFixtureSpace({ root: join(root, "space"), machineHome: cotalHome, runtime, node: process.execPath, env });

  // Register three real endpoint connectors whose required executables live in ~/.local/bin,
  // ~/.opencode/bin, and ~/.pi/agent/bin respectively, plus one connector already on callerBin.
  const coreUrl = pathToFileURL(join(runtime, "node_modules", "@cotal-ai", "core", "dist", "index.js")).href;
  const connectorCoreUrl = pathToFileURL(join(runtime, "node_modules", "@cotal-ai", "connector-core", "dist", "index.js")).href;
  const pkgDir = join(root, "late-connectors");
  mkdirSync(pkgDir, { recursive: true, mode: 0o700 });
  const seatScript = join(pkgDir, "seat.mjs");
  writeFileSync(
    seatScript,
    `import { CotalEndpoint } from ${JSON.stringify(coreUrl)};
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const out = execFileSync(process.env.LATE_HARNESS_BIN, ["--version"], { encoding: "utf8" }).trim();
const command = JSON.parse(process.env.COTAL_BEARER_CMD);
const bearer = () => new Promise((resolve, reject) => execFile(command[0], command.slice(1), { windowsHide: true }, (err, stdout) => err ? reject(err) : resolve(stdout.trim())));
const ep = new CotalEndpoint({
  space: process.env.COTAL_SPACE,
  servers: process.env.COTAL_SERVERS,
  bearer,
  sentinelCreds: readFileSync(process.env.COTAL_SENTINEL_CREDS, "utf8"),
  lifecycleUid: process.env.COTAL_LIFECYCLE_UID,
  channels: [],
  consume: false,
  card: { owner: process.env.COTAL_OWNER, actor: process.env.COTAL_ACTOR, name: process.env.COTAL_NAME, kind: "agent" },
});
ep.on("error", () => {});
await ep.start();
writeFileSync(process.env.LATE_READY_FILE, JSON.stringify({ pid: process.pid, versionOut: out }));
while (!existsSync(process.env.LATE_RELEASE_FILE)) await delay(100);
await ep.close();
`,
    { mode: 0o600 },
  );

  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "cotal-late-harnesses", version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": ">=0.1.0" } }),
    { mode: 0o600 },
  );
  const registrations = [
    ...folders.map(item => ({
      name: item.connector,
      bin: item.binary,
      binDir: `~/${item.rel}`,
      script: `https://example.com/${item.connector}/install.sh`,
    })),
    { name: "caller-existing", bin: "caller-precedence-app", binDir: "~/.local/bin", script: "https://example.com/caller/install.sh" },
  ];
  writeFileSync(
    join(pkgDir, "index.js"),
    `import { registry } from "@cotal-ai/core";
import { launchEnv } from ${JSON.stringify(connectorCoreUrl)};
const items = ${JSON.stringify(registrations)};
for (const item of items) {
  registry.register({
    kind: "connector",
    name: item.name,
    requires: [item.bin],
    install: {
      title: item.name,
      maker: "Fixture",
      installers: {
        darwin: { script: item.script, shell: "sh", binDir: item.binDir },
        linux: { script: item.script, shell: "sh", binDir: item.binDir },
      },
    },
    buildLaunch(o) {
      return {
        command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(seatScript)}],
        env: {
          ...launchEnv(),
          COTAL_SKIP_CONNECTOR_SEED: "1",
          COTAL_SPACE: o.space,
          COTAL_SERVERS: o.servers,
          COTAL_NAME: o.name,
          COTAL_OWNER: o.userAuth.owner,
          COTAL_ACTOR: o.userAuth.actor,
          COTAL_SENTINEL_CREDS: o.userAuth.sentinelCredsPath,
          COTAL_BEARER_CMD: JSON.stringify(o.userAuth.bearerCmd),
          COTAL_LIFECYCLE_UID: o.lifecycleUid,
          LATE_HARNESS_BIN: item.bin,
          LATE_READY_FILE: ${JSON.stringify(join(root, "ready-"))} + o.name + ".json",
          LATE_RELEASE_FILE: ${JSON.stringify(join(root, "release-"))} + o.name,
        },
      };
    },
  });
}
`,
    { mode: 0o600 },
  );

  const added = await callCli(["ext", "add", pkgDir], fixture.participant, { ...env, PATH: savedEnv.PATH ?? callerPath });
  check("fixture connector package installs cleanly", added.code === 0, added.stderr || added.stdout);

  // Start `daemon serve` with the exact pinned service PATH (before any ~/.local/bin, ~/.opencode/bin, or ~/.pi/agent/bin exists).
  const serviceEnv: NodeJS.ProcessEnv = { ...env, PATH: pinnedServicePath, COTAL_DAEMON_NATIVE_SERVICE: "1" };
  daemon = spawn(process.execPath, [cli, "daemon", "serve"], { env: serviceEnv, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  let daemonErr = "";
  daemon.stderr?.on("data", chunk => { daemonErr += String(chunk); });

  let initialManager: { instanceId: string; pid: number; connectors: Array<{ agent: string; state: string; reason?: string }> } | undefined;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      initialManager = await fixture.startManager();
      break;
    } catch {
      await delay(300);
    }
  }
  check("daemon and hosted Manager start under pinned service PATH with nonexistent installer folders", Boolean(initialManager?.instanceId && initialManager.pid > 0), daemonErr);
  const daemonPidBefore = daemon.pid!;
  const managerPidBefore = initialManager!.pid;
  const managerInstance = initialManager!.instanceId;

  const readStatus = async () => {
    const res = await callCli(["daemon", "status", "--space", fixture!.space, "--json"], fixture!.participant);
    check("daemon status --json succeeds", res.code === 0, res.stderr || res.stdout);
    const doc = JSON.parse(res.stdout) as { result: { pid: number; managers: Array<{ instanceId: string; pid: number; connectors: Array<{ agent: string; state: string; reason?: string }> }> } };
    return doc.result;
  };

  const beforeStatus = await readStatus();
  const beforeConnectors = beforeStatus.managers[0]!.connectors;
  for (const item of folders) {
    const row = beforeConnectors.find(entry => entry.agent === item.connector);
    check(`${item.connector} is unavailable before its binary is installed in ~/${item.rel}`, row?.state === "unavailable" && Boolean(row.reason?.includes(item.binary)), row);
  }
  check(
    "application already on caller PATH is available immediately",
    beforeConnectors.find(entry => entry.agent === "caller-existing")?.state === "available",
    beforeConnectors,
  );

  // Now create each per-user installer folder and install its stub executable (plus a shadow of caller-precedence-app in ~/.local/bin)
  // WITHOUT restarting the daemon, Manager, or running `daemon setup`.
  for (const item of folders) {
    const absDir = join(home, item.rel);
    mkdirSync(absDir, { recursive: true, mode: 0o700 });
    const binPath = join(absDir, item.binary);
    writeFileSync(binPath, `#!/bin/sh\necho "${item.binary}-ready"\n`, { mode: 0o700 });
    chmodSync(binPath, 0o755);
  }
  const shadowTool = join(home, ".local/bin", "caller-precedence-app");
  writeFileSync(shadowTool, "#!/bin/sh\necho shadow-loses\n", { mode: 0o755 });
  check(
    "caller PATH entry keeps precedence over appended ~/.local/bin entry",
    resolveOnPath("caller-precedence-app", { ...serviceEnv, PATH: pinnedServicePath }) === callerTool,
  );

  // Next status read must discover all three applications with daemon and Manager PIDs unchanged.
  const afterStatus = await readStatus();
  check("daemon PID is unchanged after installing applications", afterStatus.pid === daemonPidBefore);
  check("hosted Manager PID and instanceId are unchanged after installing applications", afterStatus.managers[0]?.pid === managerPidBefore && afterStatus.managers[0]?.instanceId === managerInstance);
  for (const item of folders) {
    const row = afterStatus.managers[0]!.connectors.find(entry => entry.agent === item.connector);
    check(`${item.connector} becomes available on the next status read with no restart`, row?.state === "available", row);
  }

  // Spawn a real seat from each newly populated folder (~/.local/bin, ~/.opencode/bin, ~/.pi/agent/bin) and from callerBin.
  for (const item of [
    ...folders.map(f => ({ connector: f.connector, seat: f.seat, expectedOut: `${f.binary}-ready` })),
    { connector: "caller-existing", seat: "seat_caller_precedence", expectedOut: "caller-wins" },
  ]) {
    const spawned = await callCli(
      ["spawn", "--on", managerInstance, "--space", fixture.space, "--harness", item.connector, "--name", item.seat, "--no-events", "--detach", "--json"],
      fixture.participant,
    );
    check(`spawn succeeds for ${item.connector} with service PID unchanged`, spawned.code === 0 && JSON.parse(spawned.stdout).result?.readiness === "joined", spawned.stderr || spawned.stdout);
    const readyFile = join(root, `ready-${item.seat}.json`);
    const waitUntil = Date.now() + 20_000;
    while (!existsSync(readyFile) && Date.now() < waitUntil) await delay(100);
    check(`${item.seat} executed the expected binary on service PATH`, existsSync(readyFile) && JSON.parse(readFileSync(readyFile, "utf8")).versionOut === item.expectedOut, existsSync(readyFile) ? readFileSync(readyFile, "utf8") : "missing ready file");
    const stopped = await callCli(["stop", item.seat, "--on", managerInstance, "--space", fixture.space, "--json"], fixture.participant);
    check(`${item.seat} stops cleanly`, stopped.code === 0, stopped.stderr || stopped.stdout);
    writeFileSync(join(root, `release-${item.seat}`), "done\n");
  }

  const finalStatus = await readStatus();
  check("daemon and Manager PIDs remain unchanged after spawning from all folders", finalStatus.pid === daemonPidBefore && finalStatus.managers[0]?.pid === managerPidBefore);
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    await killAndAwaitExit(daemon, "SIGTERM");
  }
  await fixture?.close();
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
  rmSync(root, { recursive: true, force: true });
}

console.log(`daemon-post-setup-harnesses: ${passed()} passed, ${failed()} failed (${process.platform})`);
finish();
process.exit(failed() ? 1 : 0);
