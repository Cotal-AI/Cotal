/**
 * LIVE: a controller stack whose manager process died. The stack is a real `space create` and
 * `cotal up` on an isolated port, and the suite kills the manager it started, by PID, as a crash
 * would.
 *
 *  1. `status` leads its Next with `cotal up --root <root>`, which restarts the stopped member.
 *  2. `ps` refuses: no manager is running for this space, and its Next names bare `cotal up`.
 *  3. `up` starts the manager again, and `ps` is answered.
 *  4. A SIGINT with no stop request leaves that manager running. A plain SIGTERM, as `kill`, a
 *     systemd stop or a system shutdown sends, stops it and it exits. `chat` then refuses at once
 *     that no manager is running, rather than wait out a request no manager can answer; `up` starts
 *     the manager again.
 *  5. `status` reports the running manager as answering. Stopped with SIGSTOP, as a hang, it reads
 *     not answering by pid, `down --yes` and `ps` refuse it by pid, and `run ps` refuses
 *     TARGET_UNAVAILABLE pointing to `status`; once that process is killed, the final
 *     `down --yes` stops the stack.
 *
 * Sandboxes COTAL_HOME and a temp project root, and stops the stack with `cotal down`; it signals
 * only the manager its own `up` started. Needs `nats-server` on PATH.
 * Run: pnpm smoke:stack-member-crash:live
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const PORT = await freePort();
const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");
const home = mkdtempSync(join(tmpdir(), "cotal-crash-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-crash-root-"));
const configDir = join(home, "xdg");
const anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
const { check, finish } = createSuite();
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cli = (...args: string[]) => {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(anchor, args, options);
  const r = spawnSync(TSX, [CLI, ...args], options);
  return { status: r.status, out: plain(`${r.stdout}${r.stderr}`), stdout: r.stdout };
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** The running stack manager's owned instance, as `status --json` reports it. */
const runningManager = (): { pid: number; instanceId: string } | undefined => {
  const r = cli("status", "--json");
  try {
    const rows = (JSON.parse(r.stdout) as { result?: { services?: { instances?: { definition: string; instanceId: string; observedProcess: string; pid: number | null }[] } } }).result?.services?.instances ?? [];
    const row = rows.find((item) => item.definition === "stack-manager" && item.observedProcess === "running");
    return row?.pid ? { pid: row.pid, instanceId: row.instanceId } : undefined;
  } catch { return undefined; }
};
const managerPid = (): number | undefined => runningManager()?.pid;
/** The `stackManager.endpoint` probe result `status --json` reports. */
const managerEndpoint = (): unknown => {
  try { return (JSON.parse(cli("status", "--json").stdout) as { result?: { stackManager?: { endpoint?: unknown } } }).result?.stackManager?.endpoint; }
  catch { return undefined; }
};
let hung: number | undefined;

try {
  const created = cli("space", "create", "crash");
  check("space create prepares the space", created.status === 0, created.out);
  const up = cli("up", "--server", `nats://127.0.0.1:${PORT}`);
  check("up starts its controller stack", up.status === 0, up.out);
  let answered = false;
  for (let i = 0; i < 15 && !answered; i++) {
    answered = cli("ps").status === 0;
    if (!answered) await sleep(2000);
  }
  check("the detached manager answers", answered);

  const pid = managerPid();
  check("status names the running manager's PID", pid !== undefined && alive(pid), pid);
  if (pid !== undefined) process.kill(pid, "SIGKILL");
  for (let i = 0; i < 50 && pid !== undefined && alive(pid); i++) await sleep(100);

  const status = cli("status");
  const firstNext = status.out.split("\nNext\n")[1]?.split("\n")[0] ?? "";
  check("with the manager gone, status leads its Next with up --root", firstNext.includes(`up --root ${root}`) && firstNext.includes("Restart this stack's stopped members"), status.out);
  const ps = cli("ps");
  check("ps refuses: no manager is running for this space", ps.status === 2 && ps.out.includes("no manager is running for this space"), ps.out);
  check("...and its Next names bare cotal up", ps.out.includes("start the stack's manager with bare cotal up"), ps.out);

  const again = cli("up");
  check("up starts the manager again", again.status === 0, again.out);
  check("...and ps is answered", cli("ps").status === 0);

  // Ctrl-C reaches the manager together with the CLI that publishes the stop request, so a SIGINT
  // without one is ignored. A plain SIGTERM carries no request either, and the manager stops on it.
  const signalled = runningManager();
  check("status names the restarted manager", signalled !== undefined && alive(signalled.pid), signalled);
  if (signalled !== undefined) process.kill(signalled.pid, "SIGINT");
  await sleep(3000);
  check("a SIGINT with no stop request leaves the manager running", signalled !== undefined && alive(signalled.pid));
  if (signalled !== undefined) process.kill(signalled.pid, "SIGTERM");
  for (let i = 0; i < 150 && signalled !== undefined && alive(signalled.pid); i++) await sleep(100);
  check("a plain SIGTERM stops the manager and it exits", signalled !== undefined && !alive(signalled.pid));
  const log = signalled ? cli("service", "logs", "stack-manager", "--instance", signalled.instanceId, "--tail", "40") : undefined;
  check("...and its log names the stop it ran", log?.out.includes("received SIGTERM with no stop request; stopping with the default agent policy") === true, log?.out);
  const chatFrom = Date.now();
  const chat = cli("chat", "general", "--plain");
  const chatMs = Date.now() - chatFrom;
  check("chat refuses at once: no manager is running to admit a chat session", chat.status === 2 && chat.out.includes("no manager is running for this space to admit a chat session") && chatMs < 8_000, { ms: chatMs, out: chat.out });
  check("...and its Next names bare cotal up", chat.out.includes("start the stack's manager with bare cotal up"), chat.out);
  const afterTerm = cli("up");
  check("up starts the manager after its SIGTERM stop", afterTerm.status === 0, afterTerm.out);
  check("...and ps is answered", cli("ps").status === 0);

  // A hung manager's process record stays running, so status asks its endpoint, and the stop
  // commands, which need its stop impact, refuse it by pid until that process is ended.
  check("status reports the running stack manager as answering", managerEndpoint() === "answered");
  hung = managerPid();
  if (hung !== undefined) process.kill(hung, "SIGSTOP");
  const hungStatus = cli("status");
  check("status reports a stopped stack manager as not answering, by pid", hung !== undefined && hungStatus.out.includes(`not answering · stack-manager pid ${hung}`), hungStatus.out);
  check("...and leads its Next with ending that process", (hungStatus.out.split("\nNext\n")[1]?.split("\n")[0] ?? "").includes(`kill -KILL ${hung}`), hungStatus.out);
  const refused = cli("down", "--yes");
  check("down refuses a manager that does not answer, naming its pid", refused.status === 2 && refused.out.includes("LIFECYCLE_BLOCKED") && refused.out.includes(`the manager process ${hung} is running but did not answer its endpoint`) && refused.out.includes("no stop was submitted"), refused.out);
  check("...and its Next ends that process", refused.out.includes(`end that process with kill -KILL ${hung}; the same command then finds it gone and goes on`), refused.out);
  const silentPs = cli("ps");
  check("ps names the running manager that did not answer, by pid, with the way out", silentPs.status === 2 && silentPs.out.includes("TARGET_UNAVAILABLE") && silentPs.out.includes(`this space's stack manager (pid ${hung}) is running but did not answer`) && silentPs.out.includes(`end that process with kill -KILL ${hung}; then bare cotal up starts the manager again`), silentPs.out);
  const silentRun = cli("run", "ps");
  check("run ps refuses TARGET_UNAVAILABLE, exit 2, and points to status", silentRun.status === 2 && silentRun.out.includes("TARGET_UNAVAILABLE") && silentRun.out.includes("cotal status shows whether this space's manager answers"), silentRun.out);
  if (hung !== undefined) process.kill(hung, "SIGKILL");
  for (let i = 0; i < 50 && hung !== undefined && alive(hung); i++) await sleep(100);
} finally {
  if (hung !== undefined && alive(hung)) process.kill(hung, "SIGKILL");
  const down = cli("down", "--yes");
  check("down stops the stack", down.status === 0, down.out);
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  finish();
}
