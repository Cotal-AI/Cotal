/**
 * TRUE live user journey for the installed Orca runtime:
 *
 *   cotal ext add ./extensions/orca
 *     -> cotal up -f <runtime: orca manifest>
 *     -> detached manager lazy-loads the installed runtime
 *     -> real Claude Code starts in a real Orca terminal and joins the mesh
 *     -> cotal ps observes it
 *     -> cotal down closes the terminal, manager, and broker
 *     -> cotal ext remove @cotal-ai/orca
 *
 * The project root is a temporary directory INSIDE the active Orca-managed worktree, so runtime
 * resolution exercises the real enclosing-worktree lookup without touching this checkout's .cotal
 * state. COTAL_HOME and XDG_CONFIG_HOME are sandboxed. No prompt is submitted to Claude, so the
 * connector comes online without initiating a model turn. Cleanup kills only recorded PIDs and the
 * new Orca terminal handle created by this run.
 *
 * Needs a running local Orca runtime, Claude Code, nats-server, and built workspace packages.
 * Run: pnpm smoke:orca-e2e:live
 */
import { spawnSync } from "node:child_process";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface OrcaTerminal {
  handle: string;
  ptyId?: string;
  title?: string;
  worktreePath?: string;
  connected?: boolean;
}

const REPO = resolve(import.meta.dirname, "..", "..");
const CLI = join(REPO, "bin", "cotal.ts");
const ORCA_EXTENSION = join(REPO, "extensions", "orca");
const TSX_IMPORT = import.meta.resolve("tsx");
const runId = `${process.pid}-${Date.now().toString(36)}`;
const SPACE = `orca-e2e-${runId}`;
// The no-manifest `--runtime orca` checks run under their own space so the bare manager's
// "supervisor (orca)" presence can never be confused with a stale entry from the `-f` manager
// (which is also orca) in the shared JetStream store.
const BARE_SPACE = `orca-e2e-bare-${runId}`;
const AGENT = `orcae2e-${runId}`;

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const server = createServer();
    server.on("error", rej);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => res(port));
    });
  });
const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;

// This directory must be under an Orca-managed worktree. Its own .cotal marker keeps every Cotal
// write scoped here rather than walking up to the checkout's real .cotal directory.
const root = mkdtempSync(join(REPO, ".cotal-orca-e2e-"));
const home = mkdtempSync(join(tmpdir(), "cotal-orca-e2e-home-"));
const config = mkdtempSync(join(tmpdir(), "cotal-orca-e2e-config-"));
mkdirSync(join(root, ".cotal"), { recursive: true });
const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: config };

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown): void => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const cli = (args: string[], timeout = 180_000) =>
  spawnSync(process.execPath, ["--import", TSX_IMPORT, CLI, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout,
  });
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

function orca(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.platform === "linux" ? "orca-ide" : "orca", [...args, "--json"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function orcaTerminals(): OrcaTerminal[] {
  const result = orca(["terminal", "list"]);
  if (result.status !== 0) throw new Error(`orca terminal list failed: ${result.stderr || result.stdout}`);
  const envelope = JSON.parse(result.stdout) as { ok?: boolean; result?: { terminals?: OrcaTerminal[] } };
  if (envelope.ok !== true) throw new Error(`orca terminal list returned no successful envelope: ${result.stdout}`);
  return envelope.result?.terminals ?? [];
}

function readIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function recordedPid(file: string): number | undefined {
  const pid = Number(readIfPresent(join(root, ".cotal", file)).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function killRecorded(file: string): void {
  const pid = recordedPid(file);
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
runtime: orca
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
let terminalHandle: string | undefined;
let terminalPtyId: string | undefined;
try {
  const status = orca(["status"]);
  const statusEnvelope = status.status === 0
    ? JSON.parse(status.stdout) as { ok?: boolean; result?: { runtime?: { reachable?: boolean } } }
    : undefined;
  ok("Orca CLI and local runtime are reachable", statusEnvelope?.ok === true && statusEnvelope.result?.runtime?.reachable === true, status.stderr || status.stdout);
  ok("Claude Code is available for the real connector launch", commandExists("claude"));
  ok("nats-server is available", commandExists("nats-server"));
  // The published composition root must not know Orca before the operator installs it.
  const before = cli(["up", "-f", manifest]);
  ok("runtime: orca fails before its extension is installed", before.status === 1 && /no installed extension provides runtime "orca"/.test(before.stderr), before.stdout + before.stderr);
  ok("failed runtime preflight starts no broker", !existsSync(join(root, ".cotal", "nats.pid")) && !(await portOpen()));
  // The SAME fail-loud must hold on the no-manifest path: `up --runtime orca` (no -f) is where the
  // flag was silently dropped and the detached manager fell back to pty. Preflight runs before the
  // broker starts, so this needs no installed orca and mutates nothing.
  const bareBefore = cli(["up", "--detach", "--open", "--runtime", "orca", "--space", BARE_SPACE, "--server", SERVER]);
  ok("up --runtime orca (no -f) fails before its extension is installed", bareBefore.status === 1 && /no installed extension provides runtime "orca"/.test(bareBefore.stderr), bareBefore.stdout + bareBefore.stderr);
  ok("failed no-manifest runtime preflight starts no broker", !existsSync(join(root, ".cotal", "nats.pid")) && !(await portOpen()));
  // `cotal runtimes` lists orca as a known-but-not-yet-installed runtime, one `cotal ext add` away.
  const runtimesBefore = cli(["runtimes"]);
  ok("cotal runtimes shows orca as available before install", runtimesBefore.status === 0 && /orca\b.*available.*cotal ext add @cotal-ai\/orca/.test(runtimesBefore.stdout), runtimesBefore.stdout + runtimesBefore.stderr);
  // A truly unknown runtime name is named as such — never a made-up `@cotal-ai/<typo>` package.
  const bogus = cli(["up", "--detach", "--open", "--runtime", "notaruntime", "--space", BARE_SPACE, "--server", SERVER]);
  ok("an unknown runtime fails with the known-list, not an invented package", bogus.status === 1 && /unknown runtime "notaruntime" \(known: pty, orca, tmux, cmux\)/.test(bogus.stderr) && !/@cotal-ai\/notaruntime/.test(bogus.stderr), bogus.stdout + bogus.stderr);

  const add = cli(["ext", "add", ORCA_EXTENSION]);
  ok("real Orca package installs through cotal ext", add.status === 0 && /runtime:orca/.test(add.stdout), add.stdout + add.stderr);
  const listed = cli(["ext", "list"]);
  ok("ext list records @cotal-ai/orca as a runtime provider", listed.status === 0 && /@cotal-ai\/orca/.test(listed.stdout) && /runtime:orca/.test(listed.stdout), listed.stdout + listed.stderr);
  // Now `cotal runtimes` reports it installed and probes it reachable on this machine.
  const runtimesAfter = cli(["runtimes"]);
  ok("cotal runtimes shows orca installed + reachable after install", runtimesAfter.status === 0 && /orca\b.*installed.*reachable/.test(runtimesAfter.stdout), runtimesAfter.stdout + runtimesAfter.stderr);

  const up = cli(["up", "-f", manifest]);
  ok("manifest starts through the installed Orca runtime", up.status === 0 && new RegExp(`mesh "${SPACE}" up`).test(up.stdout) && /manager \(orca\)/.test(up.stdout), up.stdout + up.stderr);
  managerPid = recordedPid("manager.pid");
  brokerPid = recordedPid("nats.pid");
  ok("broker and manager are recorded and alive", !!managerPid && !!brokerPid && alive(managerPid) && alive(brokerPid), { managerPid, brokerPid });

  const managerLog = join(root, ".cotal", "manager.log");
  let log = "";
  for (let i = 0; i < 90; i++) {
    log = readIfPresent(managerLog);
    if (new RegExp(`launched ${AGENT}\\b`).test(log)) break;
    await sleep(500);
  }
  ok("manager lazy-loads the extension and reports runtime orca", /manager up.*· orca/.test(log), log.slice(-2_000));
  ok("real Claude connector joins the mesh from the Orca terminal", new RegExp(`launched ${AGENT}\\b`).test(log), log.slice(-2_000));

  const ps = cli(["ps", "--space", SPACE, "--server", SERVER]);
  ok("cotal ps observes the managed agent on claude · orca", ps.status === 0 && ps.stdout.includes(AGENT) && /claude · orca/.test(ps.stdout) && !/starting/.test(ps.stdout), ps.stdout + ps.stderr);

  // External runtimes reject attach with native-surface guidance. That manager-owned response is
  // the authoritative terminal identity; never infer ownership from a worktree-wide handle delta.
  const attach = cli(["attach", "--name", AGENT, "--space", SPACE, "--server", SERVER]);
  terminalHandle = /watch this agent in Orca terminal (\S+)/.exec(attach.stderr)?.[1];
  const terminal = orcaTerminals().find((candidate) => candidate.handle === terminalHandle);
  terminalPtyId = terminal?.ptyId;
  ok("manager identifies the exact live Orca terminal", attach.status === 1 && !!terminalHandle && terminal?.connected !== false && terminal?.worktreePath === REPO, attach.stderr + JSON.stringify(terminal));

  const endpoints = cli(["endpoints", "--space", SPACE, "--server", SERVER]);
  ok(
    "cotal endpoints observes the agent and manager presence endpoints",
    endpoints.status === 0 && endpoints.stdout.includes(AGENT) && /manager\/manager/.test(endpoints.stdout) && /supervisor \(orca\)/.test(endpoints.stdout),
    endpoints.stdout + endpoints.stderr,
  );

  const down = cli(["down"], 90_000);
  ok("cotal down completes the real user journey", down.status === 0, down.stdout + down.stderr);
  for (let i = 0; i < 40 && ((managerPid && alive(managerPid)) || (brokerPid && alive(brokerPid)) || (await portOpen())); i++) await sleep(250);
  ok("down stops the exact manager and broker", !!managerPid && !!brokerPid && !alive(managerPid) && !alive(brokerPid) && !(await portOpen()), { managerPid, brokerPid });
  ok(
    "down closes the agent's Orca terminal",
    !!terminalHandle && !orcaTerminals().some((candidate) => terminalPtyId ? candidate.ptyId === terminalPtyId : candidate.handle === terminalHandle),
  );

  // The runtime selection also works WITHOUT a manifest: `up --detach --runtime orca` must boot the
  // control-plane manager ON the installed orca runtime (the flag reaches the detached supervise),
  // not silently pty. The live manager's own presence activity ("supervisor (orca)") is the
  // authoritative signal, so query it rather than parse the appended manager.log.
  const bareUp = cli(["up", "--detach", "--open", "--runtime", "orca", "--space", BARE_SPACE, "--server", SERVER]);
  ok("up --detach --runtime orca (no -f) starts the mesh", bareUp.status === 0, bareUp.stdout + bareUp.stderr);
  bareManagerPid = recordedPid("manager.pid");
  bareBrokerPid = recordedPid("nats.pid");
  let bareRuntime = false;
  let bareEndpoints = { stdout: "", stderr: "" };
  for (let i = 0; i < 30 && !bareRuntime; i++) {
    const r = cli(["endpoints", "--space", BARE_SPACE, "--server", SERVER]);
    bareEndpoints = { stdout: r.stdout, stderr: r.stderr };
    bareRuntime = r.status === 0 && /supervisor \(orca\)/.test(r.stdout);
    if (!bareRuntime) await sleep(1_000);
  }
  ok("the no-manifest manager runs on the orca runtime, not pty", bareRuntime, bareEndpoints);
  const bareDown = cli(["down"], 90_000);
  ok("down clears the no-manifest --runtime orca mesh", bareDown.status === 0, bareDown.stdout + bareDown.stderr);
  for (let i = 0; i < 40 && ((bareManagerPid && alive(bareManagerPid)) || (bareBrokerPid && alive(bareBrokerPid)) || (await portOpen())); i++) await sleep(250);
  ok("down stops the no-manifest manager and broker", !!bareManagerPid && !!bareBrokerPid && !alive(bareManagerPid) && !alive(bareBrokerPid) && !(await portOpen()), { bareManagerPid, bareBrokerPid });

  const remove = cli(["ext", "remove", "@cotal-ai/orca"]);
  ok("Orca extension removes after its runtime is no longer in use", remove.status === 0, remove.stdout + remove.stderr);
  ok("extension manifest returns to empty", /no extensions installed/.test(cli(["ext", "list"]).stdout));

  console.log(`\nORCA EXTENSION USER-JOURNEY E2E OK (${pass} checks)`);
} finally {
  cli(["down"], 30_000);
  try {
    for (const terminal of orcaTerminals().filter((candidate) =>
      candidate.handle === terminalHandle || (terminalPtyId !== undefined && candidate.ptyId === terminalPtyId) || candidate.title === `cotal-${AGENT}`,
    )) {
      orca(["terminal", "close", "--terminal", terminal.handle]);
    }
  } catch { /* Orca may have closed while the test was failing */ }
  managerPid ??= recordedPid("manager.pid");
  brokerPid ??= recordedPid("nats.pid");
  killRecorded("manager.pid");
  killRecorded("nats.pid");
  await sleep(500);
  for (const pid of [managerPid, brokerPid, bareManagerPid, bareBrokerPid]) {
    if (pid && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(config, { recursive: true, force: true });
}
