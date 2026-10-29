/**
 * TRUE live user journey for the installed Paseo runtime:
 *
 *   cotal ext add ./extensions/paseo
 *     -> cotal up -f <runtime: paseo manifest>
 *     -> detached manager lazy-loads the installed runtime
 *     -> real Claude Code starts in a real Paseo terminal and joins the mesh
 *     -> cotal ps observes it
 *     -> cotal down closes the terminal, manager, and broker
 *     -> cotal ext remove @cotal-ai/paseo
 *
 * The project root is a temporary directory with its own .cotal marker. COTAL_HOME and
 * XDG_CONFIG_HOME are sandboxed. No prompt is submitted to Claude, so the connector comes online
 * without initiating a model turn. Cleanup kills only recorded PIDs and the Paseo terminals this
 * run named.
 *
 * Needs a running local Paseo daemon (PASEO_HOME selects a sandboxed one), Claude Code,
 * nats-server, and built workspace packages.
 * Run: pnpm smoke:paseo-e2e:live
 */
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { canonicalLocalProcessPath, MANAGER_LOGFILE, MANAGER_PIDFILE } from "@cotal-ai/workspace";

interface PaseoTerminal {
  id: string;
  name?: string | null;
  cwd?: string;
}

const REPO = resolve(import.meta.dirname, "..", "..");
const CLI = join(REPO, "bin", "cotal.ts");
const PASEO_EXTENSION = join(REPO, "extensions", "paseo");
const CLAUDE_EXTENSION = join(REPO, "extensions", "connector-claude-code");
const TSX_IMPORT = import.meta.resolve("tsx");
const runId = `${process.pid}-${Date.now().toString(36)}`;
const SPACE = `paseo-e2e-${runId}`;
// The no-manifest `--runtime paseo` checks run under their own space so the bare manager's
// "supervisor (paseo)" presence can never be confused with a stale entry from the `-f` manager
// (which is also paseo) in the shared JetStream store.
const BARE_SPACE = `paseo-e2e-bare-${runId}`;
const AGENT = `paseoe2e-${runId}`;

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;

// Its own .cotal marker keeps every Cotal write scoped here.
const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-paseo-e2e-")));
const home = mkdtempSync(join(tmpdir(), "cotal-paseo-e2e-home-"));
const config = mkdtempSync(join(tmpdir(), "cotal-paseo-e2e-config-"));
mkdirSync(join(root, ".cotal"), { recursive: true });
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: config });
const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: config, COTAL_SKIP_CONNECTOR_SEED: "1" };

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown): void => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const cli = (args: string[], timeout = 180_000) => {
  const options = {
    cwd: root,
    env,
    encoding: "utf8" as const,
    timeout,
  };
  assertSmokeSandboxDown(sandbox, args, options);
  return spawnSync(process.execPath, ["--import", TSX_IMPORT, CLI, ...args], options);
};
const commandExists = (name: string): boolean =>
  spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8", env }).status === 0;
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const portOpen = (): Promise<boolean> =>
  new Promise((res) => {
    const socket = createConnection({ host: "127.0.0.1", port: PORT }, () => {
      socket.destroy();
      res(true);
    });
    socket.on("error", () => res(false));
    socket.setTimeout(400, () => {
      socket.destroy();
      res(false);
    });
  });

function paseo(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("paseo", [...args, "--json"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function paseoTerminals(): PaseoTerminal[] {
  const result = paseo(["terminal", "ls", "--all"]);
  if (result.status !== 0) throw new Error(`paseo terminal ls failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout) as PaseoTerminal[];
}

function readIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** The manager's record is named per-space, so its reader takes the space and expands the template
 *  through the shipped helper. `nats.pid` is root-scoped and passes no space. */
function recordedPid(file: string, space?: string): number | undefined {
  const path = space === undefined ? join(root, ".cotal", file) : canonicalLocalProcessPath(file, { root, space });
  const pid = Number(readIfPresent(path).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function killRecorded(file: string, space?: string): void {
  const pid = recordedPid(file, space);
  if (!pid || !alive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

const manifest = join(root, "cotal.yaml");
writeFileSync(
  manifest,
  `apiVersion: cotal/v1
kind: Mesh
space: ${SPACE}
runtime: paseo
agent: claude
broker: { servers: "${SERVER}", auth: false }
agents:
  ${AGENT}:
    instructions: Remain idle. This is a lifecycle test; do not modify files or initiate work.
channels:
  general:
    subscribe: [${AGENT}]
    allowPublish: [${AGENT}]
`,
);

let managerPid: number | undefined;
let brokerPid: number | undefined;
let bareManagerPid: number | undefined;
let bareBrokerPid: number | undefined;
let terminalId: string | undefined;
try {
  const status = paseo(["daemon", "status"]);
  const daemon = status.status === 0 ? JSON.parse(status.stdout) as { connectedDaemon?: string } : undefined;
  ok("Paseo CLI and local daemon are reachable", daemon?.connectedDaemon === "reachable", status.stderr || status.stdout);
  ok("Claude Code is available for the real connector launch", commandExists("claude"));
  ok("nats-server is available", commandExists("nats-server"));
  // The published composition root must not know Paseo before the operator installs it.
  const before = cli(["up", "-f", manifest]);
  ok("runtime: paseo fails before its extension is installed", before.status === 2 && /no installed extension provides runtime "paseo"/.test(before.stderr), before.stdout + before.stderr);
  ok("failed runtime preflight starts no broker", !existsSync(join(root, ".cotal", "nats.pid")) && !(await portOpen()));
  // The SAME fail-loud must hold on the no-manifest path: `up --runtime paseo` (no -f). Preflight
  // runs before the broker starts, so this needs no installed paseo and mutates nothing.
  const bareBefore = cli(["up", "--detach", "--open", "--runtime", "paseo", "--space", BARE_SPACE, "--server", SERVER]);
  ok("up --runtime paseo (no -f) fails before its extension is installed", bareBefore.status === 2 && /no installed extension provides runtime "paseo"/.test(bareBefore.stderr), bareBefore.stdout + bareBefore.stderr);
  ok("failed no-manifest runtime preflight starts no broker", !existsSync(join(root, ".cotal", "nats.pid")) && !(await portOpen()));
  // `cotal runtimes` lists paseo as a known-but-not-yet-installed runtime, one `cotal ext add` away.
  const runtimesBefore = cli(["runtimes"]);
  ok("cotal runtimes shows paseo as available before install", runtimesBefore.status === 0 && /paseo\b.*not installed.*@cotal-ai\/paseo/.test(runtimesBefore.stdout), runtimesBefore.stdout + runtimesBefore.stderr);
  // A truly unknown runtime name is named as such — never a made-up `@cotal-ai/<typo>` package.
  const bogus = cli(["up", "--detach", "--open", "--runtime", "notaruntime", "--space", BARE_SPACE, "--server", SERVER]);
  ok("an unknown runtime fails with the known-list, not an invented package", bogus.status === 2 && /unknown runtime "notaruntime" \(known: pty, orca, tmux, cmux, herdr, paseo\)/.test(bogus.stderr) && !/@cotal-ai\/notaruntime/.test(bogus.stderr), bogus.stdout + bogus.stderr);

  const add = cli(["ext", "add", PASEO_EXTENSION]);
  ok("real Paseo package installs through cotal ext", add.status === 0 && /runtime:paseo/.test(add.stdout), add.stdout + add.stderr);
  // Isolated XDG + skip-seed: this suite is not a first-run seeder. The agent
  // still boots `claude`, so install THIS WORKTREE's connector into the
  // sandbox prefix, never the operator store.
  const addClaude = cli(["ext", "add", CLAUDE_EXTENSION]);
  ok("sandbox ext add of the worktree claude connector succeeds", addClaude.status === 0, addClaude.stdout + addClaude.stderr);
  const listed = cli(["ext", "list"]);
  ok("ext list records @cotal-ai/paseo as a runtime provider", listed.status === 0 && /@cotal-ai\/paseo/.test(listed.stdout) && /runtime:paseo/.test(listed.stdout), listed.stdout + listed.stderr);
  // Now `cotal runtimes` reports it installed and probes it reachable on this machine.
  const runtimesAfter = cli(["runtimes"]);
  ok("cotal runtimes shows paseo installed + reachable after install", runtimesAfter.status === 0 && /paseo\b.*installed.*reachable/.test(runtimesAfter.stdout), runtimesAfter.stdout + runtimesAfter.stderr);

  const up = cli(["up", "-f", manifest]);
  ok("manifest starts through the installed Paseo runtime", up.status === 0 && new RegExp(`mesh "${SPACE}" up`).test(up.stdout) && /manager \(paseo\)/.test(up.stdout), up.stdout + up.stderr);
  managerPid = recordedPid(MANAGER_PIDFILE, SPACE);
  brokerPid = recordedPid("nats.pid");
  ok("broker and manager are recorded and alive", !!managerPid && !!brokerPid && alive(managerPid) && alive(brokerPid), { managerPid, brokerPid });

  const managerLog = canonicalLocalProcessPath(MANAGER_LOGFILE, { root, space: SPACE });
  let log = "";
  for (let i = 0; i < 90; i++) {
    log = readIfPresent(managerLog);
    if (new RegExp(`launched ${AGENT}\\b`).test(log)) break;
    await sleep(500);
  }
  ok("manager lazy-loads the extension and reports runtime paseo", /manager up.*· paseo/.test(log), log.slice(-2_000));
  ok("real Claude connector joins the mesh from the Paseo terminal", new RegExp(`launched ${AGENT}\\b`).test(log), log.slice(-2_000));

  const ps = cli(["ps", "--space", SPACE, "--server", SERVER]);
  ok("cotal ps observes the managed agent on claude · paseo", ps.status === 0 && ps.stdout.includes(AGENT) && /claude · paseo/.test(ps.stdout) && !/starting/.test(ps.stdout), ps.stdout + ps.stderr);

  // External runtimes reject attach with native-surface guidance. That manager-owned response is
  // the authoritative terminal identity; never infer ownership from a worktree-wide handle delta.
  const attach = cli(["attach", "--name", AGENT, "--space", SPACE, "--server", SERVER]);
  terminalId = /paseo terminal capture (\S+)`/.exec(attach.stderr)?.[1];
  const terminal = paseoTerminals().find((candidate) => candidate.id === terminalId);
  ok("manager identifies the exact live Paseo terminal", attach.status === 2 && !!terminalId && terminal?.name === `cotal-${AGENT}`, attach.stderr + JSON.stringify(terminal) + readIfPresent(managerLog).slice(-3_000));

  const endpoints = cli(["endpoints", "--space", SPACE, "--server", SERVER]);
  ok(
    "cotal endpoints observes the agent and manager presence endpoints",
    endpoints.status === 0 && endpoints.stdout.includes(AGENT) && /^\s*manager\s+manager\s+endpoint\b.*supervisor \(paseo\)/m.test(endpoints.stdout),
    endpoints.stdout + endpoints.stderr,
  );

  // A bare down spares seats on an external runtime; --with-agents retires them through the
  // runtime's own stop and exit proof, which is what closes the Paseo terminal.
  const down = cli(["down", "--with-agents"], 90_000);
  ok("cotal down --with-agents completes the real user journey", down.status === 0, down.stdout + down.stderr);
  for (let i = 0; i < 40 && ((managerPid && alive(managerPid)) || (brokerPid && alive(brokerPid)) || (await portOpen())); i++) await sleep(250);
  ok("down stops the exact manager and broker", !!managerPid && !!brokerPid && !alive(managerPid) && !alive(brokerPid) && !(await portOpen()), { managerPid, brokerPid });
  ok("down closes the agent's Paseo terminal", !!terminalId && !paseoTerminals().some((candidate) => candidate.id === terminalId));

  // The runtime selection also works WITHOUT a manifest: `up --detach --runtime paseo` must boot the
  // control-plane manager ON the installed paseo runtime, not silently pty. The live manager's own
  // presence activity ("supervisor (paseo)") is the authoritative signal.
  const bareUp = cli(["up", "--detach", "--open", "--runtime", "paseo", "--space", BARE_SPACE, "--server", SERVER]);
  ok("up --detach --runtime paseo (no -f) starts the mesh", bareUp.status === 0, bareUp.stdout + bareUp.stderr);
  bareManagerPid = recordedPid(MANAGER_PIDFILE, BARE_SPACE);
  bareBrokerPid = recordedPid("nats.pid");
  let bareRuntime = false;
  let bareEndpoints = { stdout: "", stderr: "" };
  for (let i = 0; i < 30 && !bareRuntime; i++) {
    const r = cli(["endpoints", "--space", BARE_SPACE, "--server", SERVER]);
    bareEndpoints = { stdout: r.stdout, stderr: r.stderr };
    bareRuntime = r.status === 0 && /supervisor \(paseo\)/.test(r.stdout);
    if (!bareRuntime) await sleep(1_000);
  }
  ok("the no-manifest manager runs on the paseo runtime, not pty", bareRuntime, bareEndpoints);
  const bareDown = cli(["down"], 90_000);
  ok("down clears the no-manifest --runtime paseo mesh", bareDown.status === 0, bareDown.stdout + bareDown.stderr);
  for (let i = 0; i < 40 && ((bareManagerPid && alive(bareManagerPid)) || (bareBrokerPid && alive(bareBrokerPid)) || (await portOpen())); i++) await sleep(250);
  ok("down stops the no-manifest manager and broker", !!bareManagerPid && !!bareBrokerPid && !alive(bareManagerPid) && !alive(bareBrokerPid) && !(await portOpen()), { bareManagerPid, bareBrokerPid });

  const remove = cli(["ext", "remove", "@cotal-ai/paseo"]);
  ok("Paseo extension removes after its runtime is no longer in use", remove.status === 0, remove.stdout + remove.stderr);
  const listedAfter = cli(["ext", "list"]);
  ok("ext list no longer records @cotal-ai/paseo", listedAfter.status === 0 && !/@cotal-ai\/paseo/.test(listedAfter.stdout) && !/runtime:paseo/.test(listedAfter.stdout), listedAfter.stdout + listedAfter.stderr);

  console.log(`\nPASEO EXTENSION USER-JOURNEY E2E OK (${pass} checks)`);
} finally {
  cli(["down"], 30_000);
  try {
    for (const terminal of paseoTerminals().filter((candidate) => candidate.id === terminalId || candidate.name === `cotal-${AGENT}`)) {
      paseo(["terminal", "kill", terminal.id]);
    }
  } catch { /* the daemon may have gone away while the test was failing */ }
  managerPid ??= recordedPid(MANAGER_PIDFILE, SPACE);
  bareManagerPid ??= recordedPid(MANAGER_PIDFILE, BARE_SPACE);
  brokerPid ??= recordedPid("nats.pid");
  killRecorded(MANAGER_PIDFILE, SPACE);
  killRecorded(MANAGER_PIDFILE, BARE_SPACE);
  killRecorded("nats.pid");
  await sleep(500);
  for (const pid of [managerPid, brokerPid, bareManagerPid, bareBrokerPid]) {
    if (pid && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(config, { recursive: true, force: true });
}
