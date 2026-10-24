/**
 * LIVE: a controller stack whose manager or delivery process died. The stack is a real `space create` and
 * `cotal up` on an isolated port, and the suite kills the manager it started, by PID, as a crash
 * would.
 *
 *  1. `status` leads its Next with `cotal up --root <root>`, which restarts the stopped member. The
 *     project folder's name needs shell quoting. This hint, the `chmod u+w` a persona catalog that
 *     cannot be written names, the `space create --root` that `status` names after a forget, the
 *     home screen's `up --root` row for a space prepared there, and the `space create --adopt`
 *     remedy once the folder is moved all quote it, so each pastes as one word.
 *  2. `ps` refuses: no manager is running for this space, and its Next names bare `cotal up`.
 *     `chat` refuses TARGET_UNAVAILABLE once its describe goes unanswered, pointing to `status`.
 *  3. `up` starts the manager again, and `ps` is answered.
 *  4. A SIGINT with no stop request leaves that manager running. A plain SIGTERM, as `kill`, a
 *     systemd stop or a system shutdown sends, stops it and it exits. `chat` then refuses at once
 *     that no manager is running, rather than wait out a request no manager can answer; `up` starts
 *     the manager again.
 *  5. `status` reports the running manager as answering, and `status manager` names it as the
 *     manager with that Next instead of refusing it as an agent with none. Stopped with SIGSTOP, as a hang, it reads
 *     not answering by pid, `down --yes` and `ps` refuse it by pid, and `run ps` refuses
 *     TARGET_UNAVAILABLE pointing to `status`; once that process is killed, the final
 *     `down --yes` stops the stack.
 *  6. The delivery member is killed, and its record and pin then name a process the suite started,
 *     with the old start, as a reused pid does. The record fronts nothing: `down --dry-run` names it,
 *     `down stack-broker` and bare `down` are not refused by it, and bare `down` removes it with its
 *     pin and never signals that process. A record whose pin matches that live process refuses
 *     `down stack-broker` and bare `down`, naming its path and pid in the message and the Next;
 *     once the process ends, `down` removes it.
 *  7. Started again with its delivery member stopped with SIGSTOP, as a hang, `down --yes` sends
 *     SIGKILL once 15 seconds pass after SIGTERM, and a `STOP_ESCALATED` warning names the member
 *     and its pid. It keeps the delivery credential, since that daemon never released its lease, so
 *     an `up` right after waits the lease out and starts the stack.
 *  8. With the delivery member stopped with SIGSTOP again, once its lease expires `status` names
 *     its pid as alive with no lease, starting or not responding, never `cotal up`, and its Next
 *     names `cotal service status stack-delivery`, then `cotal down --yes` and `cotal up`.
 *
 * Sandboxes COTAL_HOME and a temp project root, and stops the stack with `cotal down`; it signals
 * only the members its own `up` started and the process it started itself. Needs `nats-server` on PATH.
 * Run: pnpm smoke:stack-member-crash:live
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { canonicalLocalProcessPath, DELIVERY_PIDFILE, identityRecord } from "@cotal-ai/workspace";

const PORT = await freePort();
const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");
const home = mkdtempSync(join(tmpdir(), "cotal-crash-home-"));
const base = mkdtempSync(join(tmpdir(), "cotal-crash-root-"));
const root = join(base, "we ird $x 'q'");
mkdirSync(root, { mode: 0o700 });
const configDir = join(home, "xdg");
const anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
const { check, finish } = createSuite();
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cli = (...args: string[]) => cliIn(root, ...args);
const cliIn = (cwd: string, ...args: string[]) => {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(anchor, args, options);
  const r = spawnSync(TSX, [CLI, ...args], options);
  return { status: r.status, out: plain(`${r.stdout}${r.stderr}`), stdout: r.stdout };
};
/** The words a shell reads from `text` pasted after a command: one per line. */
const shellWords = (text: string | undefined) => text === undefined ? undefined : spawnSync("sh", ["-c", `printf '%s\\n' ${text}`], { encoding: "utf8" }).stdout;
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
/** A process the suite starts to hold a pid a crashed member's record names. */
let other: ChildProcess | undefined;
/** A command's JSON document, or undefined when its stdout is not one. */
const doc = (r: { stdout: string }): { outcome?: string; warnings?: { code: string; message: string }[]; error?: { code: string; message: string; remedy?: string }; result?: { blockedBy?: unknown } } | undefined => {
  try { return JSON.parse(r.stdout); } catch { return undefined; }
};

try {
  const created = cli("space", "create", "crash");
  check("space create prepares the space", created.status === 0, created.out);
  const agents = join(root, ".cotal", "agents");
  const agentsMode = statSync(agents).mode & 0o777;
  chmodSync(agents, agentsMode & ~0o200);
  const readOnly = cli("persona", "create", "r1", "--prompt", "a reviewer", "--subscribe", "general");
  chmodSync(agents, agentsMode);
  const chmod = /make it writable with `chmod u\+w (.+?)` to change its personas/.exec(readOnly.out)?.[1];
  check("a persona catalog that cannot be written names chmod u+w with the folder quoted", readOnly.status === 2 && shellWords(chmod) === `${agents}\n`, { chmod, out: readOnly.out });
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
  // A shell reads the pasted hint: unquoted, the folder's name splits at its spaces and `$x` expands.
  const hint = / up --root (.+?) {2,}Restart this stack's stopped members/.exec(firstNext)?.[1];
  check("with the manager gone, status leads its Next with up --root, the folder quoted so it pastes as one word", shellWords(hint) === `${root}\n`, { hint, out: status.out });
  const ps = cli("ps");
  check("ps refuses: no manager is running for this space", ps.status === 2 && ps.out.includes("no manager is running for this space"), ps.out);
  check("...and its Next names bare cotal up", ps.out.includes("start the stack's manager with bare cotal up"), ps.out);
  // The crashed manager is still registered, so chat waits out its describe and then refuses, since
  // no session was asked for.
  const crashedChat = cli("chat", "general", "--plain");
  check("chat refuses TARGET_UNAVAILABLE, exit 2, saying chat-session-open was not sent", crashedChat.status === 2 && crashedChat.out.includes("TARGET_UNAVAILABLE") && crashedChat.out.includes("chat-session-open was not sent"), crashedChat.out);
  check("...and its Next points to status", crashedChat.out.includes("cotal status shows whether this space's manager answers"), crashedChat.out);

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
  // `status manager` names the manager, not an agent it runs, and says where its state is read; an
  // unknown agent name gets no such Next.
  const asAgent = cli("status", "manager");
  check("status manager refuses as no agent and points to status and the manager's commands", asAgent.status === 2 && asAgent.out.includes("TARGET_NOT_FOUND") && asAgent.out.includes("manager is this space's manager, which is answering, not an agent it runs") && asAgent.out.includes("cotal endpoint describe manager"), asAgent.out);
  const unknownAgent = cli("status", "nosuch");
  check("control: an unknown agent name gets no manager Next", unknownAgent.status === 2 && unknownAgent.out.includes("TARGET_NOT_FOUND") && !unknownAgent.out.includes("endpoint describe manager"), unknownAgent.out);
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

  // 6. A crashed delivery member whose pid another process holds.
  const record = canonicalLocalProcessPath(DELIVERY_PIDFILE, { root, space: "crash" }), at = relative(root, record);
  const crashDelivery = async () => {
    const pid = Number(readFileSync(record, "utf8").trim());
    process.kill(pid, "SIGKILL");
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    return !alive(pid);
  };
  const pointAt = (pid: number, token: string) => { writeFileSync(record, String(pid)); writeFileSync(`${record}.identity`, `${pid} ${token}\n`); };
  other = spawn("sleep", ["600"], { stdio: "ignore" });
  const held = other.pid!;
  check("the delivery member is killed", await crashDelivery());
  pointAt(held, readFileSync(`${record}.identity`, "utf8").trim().split(" ")[1]!);
  const stale = (verb: string, pid: number, why: string) => `${verb} the stale delivery record ${at}: ${why === "reused" ? `pid ${pid} was reused by another process` : `its process, pid ${pid}, is gone`}`;
  const preview = cli("down", "--dry-run", "--json");
  check("down --dry-run names the stale record the stop removes, and no refusal", preview.status === 0 && doc(preview)?.result?.blockedBy === null && doc(preview)?.warnings?.some((w) => w.code === "STALE_PROCESS_RECORD" && w.message === stale("the stop removes", held, "reused")) === true, preview.out);
  const brokerStop = cli("down", "stack-broker", "--yes");
  check("down stack-broker stops the broker past the stale record", brokerStop.status === 0, brokerStop.out);
  const cleared = cli("down", "--yes", "--json");
  check("bare down completes and says it removed the stale record", cleared.status === 0 && doc(cleared)?.warnings?.some((w) => w.code === "STALE_PROCESS_RECORD" && w.message === stale("removed", held, "reused")) === true, cleared.out);
  check("...the record and its pin are gone", !existsSync(record) && !existsSync(`${record}.identity`));
  check("...and the process that holds the pid was never signalled", alive(held));

  const restarted = cli("up");
  check("up starts the stack again", restarted.status === 0, restarted.out);
  check("the delivery member is killed again", await crashDelivery());
  const live = identityRecord(held);
  pointAt(held, "token" in live ? live.token : "");
  const brokerBlocked = cli("down", "stack-broker", "--yes");
  check("down stack-broker refuses that record by path and pid, and its Next says what to check", brokerBlocked.status === 2 && brokerBlocked.out.includes(`legacy local daemons on this root (delivery at ${at}, pid ${held})`) && brokerBlocked.out.includes(`check pid ${held} at ${at}; stop each process where it was started`), brokerBlocked.out);
  const blocked = cli("down", "--yes", "--json");
  check("a record whose pin matches a live process refuses LIFECYCLE_BLOCKED, naming its path and pid", blocked.status === 2 && doc(blocked)?.error?.code === "LIFECYCLE_BLOCKED" && doc(blocked)?.error?.message.includes(`(delivery at ${at}, pid ${held})`) === true, blocked.out);
  check("...its Next names the pid and path to check", doc(blocked)?.error?.remedy?.startsWith(`check pid ${held} at ${at}; stop each process where it was started`) === true, blocked.out);
  check("...and the record stays and the process was not signalled", existsSync(record) && alive(held));
  other.kill("SIGKILL");
  for (let i = 0; i < 50 && alive(held); i++) await sleep(100);
  const after = cli("down", "--yes", "--json");
  check("once that process ends, bare down completes and removes its record, saying its process is gone", after.status === 0 && doc(after)?.warnings?.some((w) => w.code === "STALE_PROCESS_RECORD" && w.message === stale("removed", held, "gone")) === true && !existsSync(record), after.out);

  // 7. A hung delivery member is killed once its SIGTERM grace passes, and the stop says so.
  const once = cli("up");
  check("up starts the stack once more", once.status === 0, once.out);
  const frozen = Number(readFileSync(record, "utf8").trim());
  process.kill(frozen, "SIGSTOP");
  const killed = cli("down", "--yes", "--json");
  const escalated = doc(killed)?.warnings?.find((w) => w.code === "STOP_ESCALATED");
  check("down --yes stops a hung delivery member with SIGKILL and names it in a STOP_ESCALATED warning",
    killed.status === 0 && escalated?.message === `the delivery member, pid ${frozen}, did not exit within 15 s of SIGTERM, so it was stopped with SIGKILL` && !alive(frozen), killed.out);
  check("...and keeps the delivery credential, as for a daemon already gone", (doc(killed)?.result as { cleanup?: string } | undefined)?.cleanup === "registration-removed-delivery-credential-kept", killed.out);
  const waited = cli("up");
  check("up right after waits out the killed daemon's lease and starts the stack", waited.status === 0, waited.out);

  // 8. A delivery member that runs but holds no lease: status names its pid and the way out.
  const silent = Number(readFileSync(record, "utf8").trim());
  process.kill(silent, "SIGSTOP");
  const responder = () => { try { return (JSON.parse(cli("status", "--json").stdout) as { result?: { selected?: { deliveryResponder?: unknown } } }).result?.selected?.deliveryResponder; } catch { return undefined; } };
  let leaseGone = false;
  for (let i = 0; i < 30 && !leaseGone; i++) { await sleep(2_000); leaseGone = responder() === "unbound"; }
  const noLease = cli("status");
  const next = noLease.out.split("\nNext\n")[1]?.split("\n") ?? [];
  check("status names a frozen delivery member's pid once its lease expires, as starting or not responding, not NOT BOUND",
    leaseGone && noLease.out.includes(`no lease · stack-delivery pid ${silent} is alive but holds no lease, so it is starting or not responding`) && !noLease.out.includes("NOT BOUND"), noLease.out);
  check("...and its Next names service status stack-delivery, then down --yes and up",
    /cotal service status stack-delivery +Read the delivery member's record/.test(next[0] ?? "") && /cotal down --yes +If it stays that way/.test(next[1] ?? "") && /cotal up +Then start the stack again/.test(next[2] ?? ""), next.slice(0, 4));
  const final = cli("down", "--yes");
  check("down --yes stops it", final.status === 0, final.out);
} finally {
  if (hung !== undefined && alive(hung)) process.kill(hung, "SIGKILL");
  if (other?.pid !== undefined && alive(other.pid)) other.kill("SIGKILL");
  const down = cli("down", "--yes");
  check("down stops the stack", down.status === 0, down.out);
  const forgot = cli("space", "forget", "crash");
  const prepareAgain = /prepare it again with `cotal space create crash --root (.+?)`/.exec(cli("status").out)?.[1];
  check("after a forget, status names space create --root with the folder quoted", forgot.status === 0 && shellWords(prepareAgain) === `${root}\n`, prepareAgain);
  const prepared = cli("space", "create", "crash");
  cli("use", "crash");
  const homeRow = /^ {2}cotal up --root (.+?) {2,}Start this space$/m.exec(cliIn(base).out)?.[1];
  cli("use", "--clear");
  check("the home screen of a space prepared in another folder quotes that folder in its up --root row", prepared.status === 0 && shellWords(homeRow) === `${root}\n`, homeRow);
  cli("space", "forget", "crash");
  const moved = join(base, "moved $x 'q'");
  renameSync(root, moved);
  const adopt = /adopt it with cotal space create crash --adopt --root (.+?); this machine/.exec(cliIn(moved, "whoami").out)?.[1];
  check("a folder moved with its stack journal names space create --adopt with the new folder quoted", shellWords(adopt) === `${moved}\n`, adopt);
  rmSync(home, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
  finish();
}
