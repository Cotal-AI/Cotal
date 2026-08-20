/**
 * Spawn environment capability E2E: both policy arms execute a real child through the shipped
 * detached-launch path, then ask whether it can use an ephemeral ssh-agent after its key file is
 * gone. This proves the child is live and proves both the default boundary and explicit opt-in.
 *
 * The default must not inherit SSH_AUTH_SOCK. `spawn.env: ["SSH_AUTH_SOCK"]` is a deliberate
 * operator opt-in and must preserve it. The proof uses no real identity: it creates one temporary
 * ed25519 key, adds it to a fresh ssh-agent, deletes the private-key file, and has the launched
 * child use ssh-keygen -Y sign. Success can only come from the inherited agent socket.
 *
 * Run: pnpm smoke:spawn-env-e2e
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "bin", "dist", "cotal.js");
const PI = join(ROOT, "extensions", "pi");
const NODE = process.execPath;
const TOOL_TIMEOUT_MS = 30_000;
const READINESS_TIMEOUT_MS = 40_000;

interface Agent {
  sock: string;
  pid: string;
}
interface ChildReport {
  argv: string[];
  authSock: string | null;
  signature: boolean;
  privateKeyExists: boolean;
  status: number | null;
}
interface StackRecord {
  file: string;
  pid: number;
}
interface StackTeardown {
  primaryStatus: number | null;
  primaryOutput: string;
  recoveryStatus?: number | null;
  records: StackRecord[];
  clean: boolean;
  failure?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** This suite can itself run inside a managed session. Its child processes need the fresh agent
 * socket this test created, never the runner's Cotal connection material. */
function suiteEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  return env;
}

function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string, label: string): string {
  const result = spawnSync(file, args, { cwd, encoding: "utf8", env, timeout: TOOL_TIMEOUT_MS });
  if (result.status !== 0)
    throw new Error(`${label} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("could not allocate loopback port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function agent(): Agent {
  const output = spawnSync("ssh-agent", ["-s"], { encoding: "utf8", timeout: TOOL_TIMEOUT_MS });
  if (output.status !== 0) throw new Error(`ssh-agent failed: ${output.stderr}`);
  const sock = /SSH_AUTH_SOCK=([^;]+);/.exec(output.stdout)?.[1];
  const pid = /SSH_AGENT_PID=(\d+);/.exec(output.stdout)?.[1];
  if (!sock || !pid) throw new Error(`ssh-agent did not emit its socket and pid: ${output.stdout}`);
  return { sock, pid };
}

function stopAgent(a: Agent): void {
  spawnSync("ssh-agent", ["-k"], { env: { ...process.env, SSH_AUTH_SOCK: a.sock, SSH_AGENT_PID: a.pid }, encoding: "utf8" });
}

/** The normal teardown is a folder-scoped down: `--space` without a named target is invalid and
 * exits before teardown. This is intentionally a separate function so the mutation fixture can
 * restore that invalid command and prove the recorded-stack result cell turns red. */
function recordedStackDownCommand(space: string): string[] {
  void space;
  return ["down"];
}

function recordedStack(project: string): StackRecord[] {
  return ["manager.pid", "nats.pid"].map((file) => {
    const path = join(project, ".cotal", file);
    const raw = readFileSync(path, "utf8").trim();
    if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${file} is not a recorded positive pid`);
    return { file, pid: Number(raw) };
  });
}

function sameRecordedStack(project: string, records: readonly StackRecord[]): boolean {
  try {
    return records.every(({ file, pid }) => readFileSync(join(project, ".cotal", file), "utf8").trim() === String(pid));
  } catch {
    return false;
  }
}

function recordedPidsGone(records: readonly StackRecord[]): boolean {
  return records.every(({ pid }) => {
    try {
      process.kill(pid, 0); // observation only: never signal a pid outside cotal down's recorded ownership path
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ESRCH";
    }
  });
}

async function stopRecordedStack(project: string, space: string, env: NodeJS.ProcessEnv): Promise<StackTeardown> {
  let records: StackRecord[];
  try {
    records = recordedStack(project);
  } catch (e) {
    return { primaryStatus: null, primaryOutput: "", records: [], clean: false, failure: (e as Error).message };
  }
  const primary = spawnSync(NODE, [CLI, ...recordedStackDownCommand(space)], {
    cwd: project, env, encoding: "utf8", timeout: TOOL_TIMEOUT_MS,
  });
  const primaryOutput = `${primary.stdout ?? ""}${primary.stderr ?? ""}`;
  let recoveryStatus: number | null | undefined;
  // A failed primary command may not have touched the stack. Re-run the known-good folder teardown
  // only while its records still name the two processes this fresh fixture started. Never scan or
  // signal unrelated processes, and preserve the box if ownership changed under us.
  if (primary.status !== 0 && sameRecordedStack(project, records)) {
    const recovery = spawnSync(NODE, [CLI, "down"], { cwd: project, env, encoding: "utf8", timeout: TOOL_TIMEOUT_MS });
    recoveryStatus = recovery.status;
  }
  for (let i = 0; i < 100; i++) {
    const recordsGone = records.every(({ file }) => !existsSync(join(project, ".cotal", file)));
    if (recordsGone && recordedPidsGone(records))
      return { primaryStatus: primary.status, primaryOutput, recoveryStatus, records, clean: true };
    await sleep(50);
  }
  return {
    primaryStatus: primary.status,
    primaryOutput,
    recoveryStatus,
    records,
    clean: false,
    failure: "recorded manager or broker did not exit cleanly",
  };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function armAndRun(mode: "default" | "opt-in", port: number): Promise<{ report: ChildReport; teardown: StackTeardown }> {
  const box = mkdtempSync(join(tmpdir(), `cotal-spawn-env-${mode}-`));
  const project = join(box, "project");
  const home = join(box, "home");
  const xdg = join(box, "xdg");
  const tools = join(box, "tools");
  const space = `spawnenv${Date.now()}${mode === "opt-in" ? "o" : "d"}`;
  const server = `nats://127.0.0.1:${port}`;
  const natsPid = join(project, ".cotal", "nats.pid");
  const privateKey = join(box, "ephemeral");
  const publicKey = join(box, "ephemeral.public");
  const challenge = join(box, "challenge");
  const reportPath = join(box, "child.json");
  const a = agent();
  let report: ChildReport | undefined;
  let teardown: StackTeardown | undefined;
  const env = {
    ...suiteEnvironment(),
    COTAL_HOME: home,
    XDG_CONFIG_HOME: xdg,
    COTAL_SKIP_CONNECTOR_SEED: "1",
    PATH: `${tools}:${process.env.PATH ?? ""}`,
    SSH_AUTH_SOCK: a.sock,
    SSH_AGENT_PID: a.pid,
  };

  try {
    mkdirSync(join(project, ".cotal", "agents"), { recursive: true });
    mkdirSync(tools, { recursive: true });
    writeFileSync(join(project, ".cotal", "agents", "default.md"), "---\nname: cap739\n---\n");
    if (mode === "opt-in")
      writeFileSync(join(project, ".cotal", "config.json"), JSON.stringify({ spawn: { env: ["SSH_AUTH_SOCK"] } }));

    const fakePi = join(tools, "pi");
    writeFileSync(fakePi, `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const probe = JSON.parse(readFileSync(${JSON.stringify(join(tools, "probe.json"))}, "utf8"));
const result = spawnSync("ssh-keygen", ["-Y", "sign", "-f", probe.publicKey, "-n", "cap739", probe.challenge], { encoding: "utf8" });
writeFileSync(probe.report, JSON.stringify({ argv: process.argv.slice(2), authSock: process.env.SSH_AUTH_SOCK ?? null, signature: existsSync(probe.challenge + ".sig"), privateKeyExists: existsSync(probe.privateKey), status: result.status }));
process.exit(0);
`);
    chmodSync(fakePi, 0o700);

    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", privateKey, "-C", `cap739-${mode}`], env, project, "ephemeral key generation");
    run("ssh-add", [privateKey], env, project, "ephemeral key load");
    writeFileSync(challenge, `cap739 ${mode} challenge\n`);
    writeFileSync(publicKey, readFileSync(`${privateKey}.pub`));
    rmSync(privateKey);
    writeFileSync(join(tools, "probe.json"), JSON.stringify({ publicKey, challenge, privateKey, report: reportPath }));

    run(NODE, [CLI, "ext", "add", PI], env, project, "local Pi connector install");
    run(NODE, [CLI, "up", "--open", "--detach", "--space", space, "--server", server], env, project, "mesh startup");
    await waitFor(() => existsSync(natsPid), "the shipped mesh listener");
    // The manager is born by the shipped CLI and receives the same environment as the operator shell.
    // It may still be registering when this test gets its pidfile, so retry only its normal detached
    // spawn request until the real child reports. The fake harness exits after observing the socket.
    const deadline = Date.now() + READINESS_TIMEOUT_MS;
    while (!existsSync(reportPath) && Date.now() < deadline) {
      spawnSync(NODE, [CLI, "spawn", "default", "--detach", "--agent", "pi", "--space", space], {
        cwd: project, env, encoding: "utf8", timeout: READINESS_TIMEOUT_MS,
      });
      if (!existsSync(reportPath)) await sleep(300);
    }
    await waitFor(() => existsSync(reportPath), "the real manager-launched Pi child report");
    report = JSON.parse(readFileSync(reportPath, "utf8")) as ChildReport;
  } finally {
    if (existsSync(natsPid)) teardown = await stopRecordedStack(project, space, env);
    stopAgent(a);
    if (teardown?.clean) rmSync(box, { recursive: true, force: true });
    else if (teardown) console.error(`! preserving ${box}: recorded-stack teardown did not complete (${teardown.failure ?? teardown.primaryOutput.trim()})`);
  }
  if (!report) throw new Error(`no child report for ${mode}`);
  if (!teardown) throw new Error(`no recorded-stack teardown result for ${mode}`);
  return { report, teardown };
}

const defaultPort = await freePort();
const optInPort = await freePort();
const defaultArm = await armAndRun("default", defaultPort);
const optInArm = await armAndRun("opt-in", optInPort);
const defaultReport = defaultArm.report;
const optInReport = optInArm.report;

let failed = 0;
function check(name: string, pass: boolean, detail: unknown): void {
  console.log(`${pass ? "✓" : "✗"} ${name}${pass ? "" : `: ${JSON.stringify(detail)}`}`);
  if (!pass) failed++;
}

check("D1 default child ran through the managed Pi launch after its private key file was deleted", defaultReport.privateKeyExists === false && defaultReport.argv[0] === "--extension" && /@cotal-ai\/pi\/dist\/standalone\.js$/.test(defaultReport.argv[1] ?? ""), defaultReport);
check("D2 default child did not receive SSH_AUTH_SOCK", defaultReport.authSock === null, defaultReport);
check("D3 default child could not sign through an undeclared ssh-agent", defaultReport.signature === false && defaultReport.status !== 0, defaultReport);
check("O1 explicit spawn.env opt-in child ran through the managed Pi launch after its private key file was deleted", optInReport.privateKeyExists === false && optInReport.argv[0] === "--extension" && /@cotal-ai\/pi\/dist\/standalone\.js$/.test(optInReport.argv[1] ?? ""), optInReport);
check("O2 explicit spawn.env opt-in delivered SSH_AUTH_SOCK", typeof optInReport.authSock === "string" && optInReport.authSock.length > 0, optInReport);
check("O3 explicit spawn.env opt-in child signed through the live ssh-agent", optInReport.signature === true && optInReport.status === 0, optInReport);
check("T1 default recorded stack teardown exits 0", defaultArm.teardown.primaryStatus === 0, defaultArm.teardown);
check("T2 explicit opt-in recorded stack teardown exits 0", optInArm.teardown.primaryStatus === 0, optInArm.teardown);
check("T3 both recorded manager and broker processes are gone before fixture removal", defaultArm.teardown.clean && optInArm.teardown.clean, { default: defaultArm.teardown, optIn: optInArm.teardown });
process.exit(failed === 0 ? 0 : 1);
