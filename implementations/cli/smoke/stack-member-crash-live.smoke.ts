/**
 * LIVE: a real `space create` and `cotal up` on an isolated port. The suite kills controller
 * members it started and checks how the stack recovers.
 *
 *  1. `status` leads its Next with `cotal up --root <root>`, which restarts the stopped member. The
 *     project folder's name needs shell quoting. This hint, the `chmod u+w` a persona catalog that
 *     cannot be written names, the `space create --root` that `status` names after a forget, the
 *     home screen's `up --root` row for a space prepared there, the `up --root` that the Next of an
 *     `up --root --no-manager` from another folder offers, and the `space create --adopt` remedy
 *     once the folder is moved all quote it, so each pastes as one word. Before that, with the
 *     stack running, `status --server` at an address nothing answers at offers no restart and names
 *     that address and the recorded broker.
 *  2. `ps` refuses: no manager is running for this space, and its Next names bare `cotal up`.
 *     `chat` refuses TARGET_UNAVAILABLE once its describe goes unanswered, pointing to `status`.
 *  3. `up` starts the manager again with the running broker's WebSocket port, and `ps` is answered.
 *     A broker-only repair serves the port the running manager advertises.
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
 *     pin and never signals that process. Planted again on the stopped stack, as after a reboot, `up`
 *     removes it before it starts a member, names it, and never signals that process. A record whose pin matches that live process refuses
 *     `down stack-broker` and bare `down`, naming its path and pid in the message and the Next, and
 *     the `down stack-broker` dry run warns with that refusal. Once the process ends, `down
 *     stack-broker` refuses on the running manager and a service the user added, naming each exact
 *     `cotal service stop` with the added service's first, then bare `down`, and its dry run warns
 *     with that refusal. Once that service stops, `down` stops the stack and removes the record.
 *  7. Started again with its delivery member stopped with SIGSTOP, as a hang, `down --yes` sends
 *     SIGKILL once 15 seconds pass after SIGTERM, and a `STOP_ESCALATED` warning names the member
 *     and its pid. It keeps the delivery credential, since that daemon never released its lease, so
 *     an `up` right after waits the lease out and starts the stack.
 *  8. With the delivery member stopped with SIGSTOP again, once its lease expires `status` names
 *     its pid as alive with no lease, starting or not responding, never `cotal up`, and its Next
 *     names `cotal service status stack-delivery`, then `cotal down --yes` and `cotal up`.
 *  9. An independent read-only dashboard keeps its process and browser session when the same
 *     broker is recovered.
 * 10. After a full stop the next up reuses that stack's websocket port. When another process holds
 *     the port, up starts on a new one and names both. A second space on the same machine takes its
 *     own port and does not take the first space's.
 *
 * Sandboxes COTAL_HOME and a temp project root, and stops the stack with `cotal down`; it signals
 * only the members its own `up` started and the process it started itself. Needs `nats-server` on PATH.
 * Run: pnpm smoke:stack-member-crash:live
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { canonicalLocalProcessPath, DELIVERY_PIDFILE, identityRecord, readProcessCommand } from "@cotal-ai/workspace";

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
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
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
/** The running member's owned instance, as `service --json` reports it. */
const runningMember = (definition: string): { pid: number; instanceId: string } | undefined => {
  const r = cli("service", "--json");
  try {
    const rows = (JSON.parse(r.stdout) as { result?: { instances?: { definition: string; instanceId: string; observedProcess: string; pid: number | null }[] } }).result?.instances ?? [];
    const row = rows.find((item) => item.definition === definition && item.observedProcess === "running");
    return row?.pid ? { pid: row.pid, instanceId: row.instanceId } : undefined;
  } catch { return undefined; }
};
const runningManager = () => runningMember("stack-manager");
const managerPid = (): number | undefined => runningManager()?.pid;
const managerWsPort = (pid: number | undefined) => {
  const argv = pid === undefined ? undefined : readProcessCommand(pid);
  return argv?.kind === "command" ? / --ws-port (\d+)(?: |$)/.exec(argv.command)?.[1] : undefined;
};
const receiptWsPort = (out: string) => /^  Broker websocket: +127\.0\.0\.1:(\d+)\b/m.exec(out)?.[1];
const listenerOpen = (port: number) => new Promise<boolean>((done) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  const close = (open: boolean) => { socket.destroy(); done(open); };
  socket.once("connect", () => close(true)).once("error", () => close(false)).setTimeout(2_000, () => close(false));
});
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

async function repairWithDashboard(brokerPid: number): Promise<void> {
  const installed = cli("ext", "add", join(WT, "implementations", "web"));
  check("the checkout's dashboard provider is available", installed.status === 0, installed.out);
  const port = await freePort();
  try {
    const start = cli("service", "start", "web", "--space", "crash", "--no-open", "--port", String(port));
    const web = runningMember("web");
    const log = cli("service", "logs", "web", "--space", "crash");
    const sessionPath = /Private browser bootstrap file: (.+)$/m.exec(log.out)?.[1];
    if (start.status !== 0 || !web || !sessionPath) throw new Error(`the dashboard did not start: ${start.out}`);
    const { launchUrl } = JSON.parse(readFileSync(sessionPath, "utf8")) as { launchUrl: string };
    const exchange = await fetch(launchUrl, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
    if (exchange.status !== 302 || !cookie) throw new Error(`could not authenticate the browser session: HTTP ${exchange.status}`);
    const browser = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie }, signal: AbortSignal.timeout(20_000) });
    check("the dashboard still blocks whole-stack up while the broker runs", doc(cli("up", "--space", "crash", "--json"))?.error?.code === "LIFECYCLE_BLOCKED");
    process.kill(brokerPid, "SIGTERM");
    for (let i = 0; i < 100 && await listenerOpen(PORT); i++) await sleep(100);
    check("the original browser session stays authenticated during the broker outage", (await browser("/api/meta")).status === 200);
    check("a broker input change is still blocked by the dashboard", doc(cli("up", "--space", "crash", "--max-payload", "2097152", "--json"))?.error?.code === "LIFECYCLE_BLOCKED");
    const repair = cli("up", "--space", "crash");
    const repaired = runningMember("stack-broker"), webAfter = runningMember("web");
    check("up restarts the stopped broker without replacing the dashboard process or instance", repair.status === 0 && !!repaired && repaired.pid !== brokerPid &&
      webAfter?.pid === web.pid && webAfter.instanceId === web.instanceId, repair.out);
    const sent = cli("send", "-c", "general", "message after broker repair");
    const history = await browser("/api/channels/general/history");
    check("the original browser session reads new messages from the recovered broker", sent.status === 0 && history.status === 200 && (await history.text()).includes("message after broker repair"), { sendStatus: sent.status, httpStatus: history.status });
  } finally {
    const stop = cli("service", "stop", "web", "--space", "crash", "--yes");
    check("the independent dashboard stops through its own service command", stop.status === 0, stop.out);
  }
}

try {
  const created = cli("space", "create", "crash");
  check("space create prepares the space", created.status === 0, created.out);
  const missing = cli("endpoint", "--space", "missing-space", "--json");
  const missingDoc = JSON.parse(missing.stdout);
  check("saved inventory names the unknown space in JSON and gives a retry without starting it",
    missing.status === 2 && missing.out === missing.stdout && missingDoc.error.code === "TARGET_NOT_FOUND" && missingDoc.target.requested === "missing-space"
    && missingDoc.error.message.includes("missing-space") && missingDoc.error.remedy.includes("`cotal space`")
    && missingDoc.error.remedy.includes("`cotal endpoint --space <name> --json`"), missing.out);
  const missingPlain = cli("endpoint", "--space", "missing-space", "--plain");
  check("the plain saved inventory refusal names the space and keeps plain output in its retry", missingPlain.status === 2
    && missingPlain.stdout === "" && missingPlain.out.includes("missing-space") && missingPlain.out.includes("`cotal endpoint --space <name> --plain`"), missingPlain.out);
  const offline = cli("endpoint", "--space", "crash", "--json");
  const savedInventory = JSON.parse(offline.stdout);
  check("the prepared space's saved inventory is readable without live registration reads", offline.status === 0
    && savedInventory.target.space === "crash" && savedInventory.result.liveCompleteness === "not-checked", offline.out);
  const agents = join(root, ".cotal", "agents");
  const agentsMode = statSync(agents).mode & 0o777;
  chmodSync(agents, agentsMode & ~0o200);
  const readOnly = cli("persona", "create", "r1", "--prompt", "a reviewer", "--subscribe", "general");
  chmodSync(agents, agentsMode);
  const chmod = /make it writable with `chmod u\+w (.+?)` to change its personas/.exec(readOnly.out)?.[1];
  check("a persona catalog that cannot be written names chmod u+w with the folder quoted", readOnly.status === 2 && shellWords(chmod) === `${agents}\n`, { chmod, out: readOnly.out });
  const away = cliIn(base, "up", "--root", root, "--no-manager", "--server", `nats://127.0.0.1:${PORT}`);
  const addManager = /^ {2}(?:pnpm )?cotal up --root (.+?) {2,}Add the manager to this stack$/m.exec(away.out)?.[1];
  check("up --root --no-manager from another folder quotes that folder in the up --root its Next offers", away.status === 0 && shellWords(addManager) === `${root}\n`, { addManager, out: away.out });
  const awayDown = cli("down", "--yes");
  check("...and down --yes in that folder stops it", awayDown.status === 0, awayDown.out);
  const up = cli("up", "--server", `nats://127.0.0.1:${PORT}`);
  check("up starts its controller stack", up.status === 0, up.out);
  let answered = false;
  for (let i = 0; i < 15 && !answered; i++) {
    answered = cli("ps").status === 0;
    if (!answered) await sleep(2000);
  }
  check("the detached manager answers", answered);
  // A `--server` address nothing answers at says nothing about whether this stack runs, so status
  // offers no restart and names that address, as the refusal of other commands does.
  const closed = `nats://127.0.0.1:${await freePort()}`;
  const remedy = `check that address, or drop --server and retry with \`--space crash\` to reach its recorded broker at nats://127.0.0.1:${PORT}`;
  const elsewhere = cli("status", "--server", closed, "--json");
  const named = `nothing answered at ${closed}, the broker address --server named; ${remedy}`;
  check("with the stack running, status --server at an address nothing answers at names it and the recorded broker",
    elsewhere.status === 0 && (JSON.parse(elsewhere.stdout).result?.hints as string[] | undefined)?.includes(named) === true, elsewhere.out);
  const elsewhereText = cli("status", "--server", closed);
  check("...and its Next offers no restart of stopped members", elsewhereText.status === 0 && elsewhereText.out.includes("\nNext\n") && !elsewhereText.out.includes("stopped members"), elsewhereText.out);

  const referenceFile = join(base, "manager-reference.json");
  writeFileSync(referenceFile, JSON.stringify({ schemaVersion: 1, space: "crash", endpoint: "manager" }));
  const saved = cli("endpoint", "add", "saved-manager", "--file", referenceFile);
  check("the local manager reference is saved", saved.status === 0, saved.out);
  const otherRoot = join(base, "other-selection");
  mkdirSync(otherRoot, { mode: 0o700 });
  const added = cli("space", "add", "other-selection", "--mode", "open", "--root", otherRoot, "--server", `nats://127.0.0.1:${await freePort()}`, "--force", "--yes");
  const picked = cli("use", "other-selection");
  check("a different registered space is selected", added.status === 0 && picked.status === 0, { added, picked });
  const inventory = cli("endpoint", "list", "--live", "--server", closed, "--plain");
  const [unavailable, inventoryNext] = inventory.stdout.split("\nNext\n");
  const diagnostic = `nothing answered at ${closed}, the broker address --server named`;
  check("live endpoint inventory keeps saved references and names the failed override and its remedy",
    inventory.status === 4 && unavailable?.includes("Native registration reads: partial") && unavailable.includes("saved-manager")
    && unavailable.includes(diagnostic) && inventoryNext?.trim() === remedy, inventory.out);
  const partialInventory = cli("endpoint", "list", "--live", "--server", closed, "--json");
  const inventoryDoc = JSON.parse(partialInventory.stdout);
  check("structured inventory keeps its partial outcome and the connection diagnostic and remedy",
    partialInventory.status === 4 && inventoryDoc.outcome === "partial" && inventoryDoc.completeness === "partial"
    && inventoryDoc.result.items.some((item: { name: string }) => item.name === "saved-manager")
    && inventoryDoc.result.live === null && inventoryDoc.result.liveUnavailable?.code === "TARGET_UNAVAILABLE"
    && inventoryDoc.result.liveUnavailable?.message === diagnostic && inventoryDoc.error?.remedy === remedy, partialInventory.out);
  const unpinned = cli("endpoint", "list", "--live", "--plain");
  check("dropping --server alone would read the other selection", unpinned.status === 4 && unpinned.stdout.includes("Mesh: other-selection\n"), unpinned.out);
  const pin = /`(--space [^`]+)`/.exec(inventoryNext ?? "")?.[1];
  const retried = cli("endpoint", "list", "--live", ...(pin?.split(" ") ?? []), "--plain");
  check("following the printed space pin gives a complete live inventory with the native manager registration",
    retried.status === 0 && retried.stdout.includes("Mesh: crash\n") && retried.stdout.includes("Native registration reads: complete")
    && /^  manager\s+/m.test(retried.stdout.split("\nNative registrations\n")[1] ?? ""), retried.out);
  const clearedSelection = cli("use", "--clear");
  check("the competing selection is cleared", clearedSelection.status === 0, clearedSelection.out);
  const removed = cli("space", "forget", "other-selection");
  check("the competing registration is removed", removed.status === 0, removed.out);

  const pid = managerPid();
  check("status names the running manager's PID", pid !== undefined && alive(pid), pid);
  const wsPort = receiptWsPort(up.out);
  const broker = runningMember("stack-broker");
  check("the initial manager advertises the broker's WebSocket listener", !!wsPort && managerWsPort(pid) === wsPort && await listenerOpen(Number(wsPort)), up.out);
  if (pid !== undefined) process.kill(pid, "SIGKILL");
  for (let i = 0; i < 50 && pid !== undefined && alive(pid); i++) await sleep(100);

  const status = cli("status");
  const firstNext = status.out.split("\nNext\n")[1]?.split("\n")[0] ?? "";
  // A shell reads the pasted hint: unquoted, the folder's name splits at its spaces and `$x` expands.
  const hint = / up --root (.+?) {2,}Restart this stack's stopped members/.exec(firstNext)?.[1];
  check("with the manager gone, status leads its Next with up --root, the folder quoted so it pastes as one word", shellWords(hint) === `${root}\n`, { hint, out: status.out });
  const ps = cli("ps");
  check("ps refuses: no manager is running for this space", ps.status === 2 && ps.out.includes("no manager is running for this space"), ps.out);
  check("...and its Next names bare cotal up", ps.out.includes("start the stack's manager with bare `cotal up`"), ps.out);
  // The crashed manager is still registered, so chat waits out its describe and then refuses, since
  // no session was asked for.
  const crashedChat = cli("chat", "general", "--plain");
  check("chat refuses TARGET_UNAVAILABLE, exit 2, saying chat-session-open was not sent", crashedChat.status === 2 && crashedChat.out.includes("TARGET_UNAVAILABLE") && crashedChat.out.includes("chat-session-open was not sent"), crashedChat.out);
  check("...and its Next points to status", crashedChat.out.includes("cotal status shows whether this space's manager answers"), crashedChat.out);

  const again = cli("up");
  check("up starts the manager again", again.status === 0, again.out);
  check("...and ps is answered", cli("ps").status === 0);
  const repairedManager = managerPid();
  check("manager-only repair keeps the broker and passes its WebSocket port to the new manager",
    !!broker && runningMember("stack-broker")?.pid === broker.pid && repairedManager !== pid && managerWsPort(repairedManager) === wsPort && receiptWsPort(again.out) === wsPort, again.out);

  if (!broker || !wsPort || !repairedManager || runningMember("stack-broker")?.pid !== broker.pid) throw new Error("could not identify the private broker and manager for broker repair");
  process.kill(broker.pid, "SIGKILL");
  for (let i = 0; i < 50 && alive(broker.pid); i++) await sleep(100);
  const holder = createServer();
  await new Promise<void>((done, fail) => holder.once("error", fail).listen(Number(wsPort), "127.0.0.1", done));
  try {
    const blocked = cli("up");
    check("broker-only repair fails rather than moving the WebSocket port when another process holds it",
      blocked.status !== 0 && blocked.out.includes(`could not bind websocket port ${wsPort}, which the running manager still advertises`) && alive(repairedManager), blocked.out);
  } finally {
    await new Promise<void>((done) => holder.close(() => done()));
  }
  const brokerRepair = cli("up");
  const repairedBroker = runningMember("stack-broker");
  check("broker-only repair reuses the manager and serves its original WebSocket port",
    brokerRepair.status === 0 && !!repairedBroker && repairedBroker.pid !== broker.pid && managerPid() === repairedManager && managerWsPort(repairedManager) === wsPort &&
    receiptWsPort(brokerRepair.out) === wsPort && await listenerOpen(Number(wsPort)), brokerRepair.out);
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
  check("...and its Next names bare cotal up", chat.out.includes("start the stack's manager with bare `cotal up`"), chat.out);
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
  check("ps names the running manager that did not answer, by pid, with the way out", silentPs.status === 2 && silentPs.out.includes("TARGET_UNAVAILABLE") && silentPs.out.includes(`this space's stack manager (pid ${hung}) is running but did not answer`) && silentPs.out.includes(`end that process with kill -KILL ${hung}; then bare \`cotal up\` starts the manager again`), silentPs.out);
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
  const crashedStart = readFileSync(`${record}.identity`, "utf8").trim().split(" ")[1]!;
  pointAt(held, crashedStart);
  const stale = (verb: string, pid: number, why: string) => `${verb} the stale delivery record ${at}: ${why === "reused" ? `pid ${pid} was reused by another process` : `its process, pid ${pid}, is gone`}`;
  const preview = cli("down", "--dry-run", "--json");
  check("down --dry-run names the stale record the stop removes, and no refusal", preview.status === 0 && doc(preview)?.result?.blockedBy === null && doc(preview)?.warnings?.some((w) => w.code === "STALE_PROCESS_RECORD" && w.message === stale("the stop removes", held, "reused")) === true, preview.out);
  const brokerStop = cli("down", "stack-broker", "--yes");
  check("down stack-broker stops the broker past the stale record", brokerStop.status === 0, brokerStop.out);
  const cleared = cli("down", "--yes", "--json");
  check("bare down completes and says it removed the stale record", cleared.status === 0 && doc(cleared)?.warnings?.some((w) => w.code === "STALE_PROCESS_RECORD" && w.message === stale("removed", held, "reused")) === true, cleared.out);
  check("...the record and its pin are gone", !existsSync(record) && !existsSync(`${record}.identity`));
  check("...and the process that holds the pid was never signalled", alive(held));

  // The stopped stack's record names that process again with the crashed start, as after a reboot.
  pointAt(held, crashedStart);
  const restarted = cli("up", "--json");
  check("up removes that stale record before it starts the stack again, and names it", restarted.status === 0 && doc(restarted)?.warnings?.some((w) => w.code === "STALE_PROCESS_RECORD" && w.message === stale("removed", held, "reused")) === true, restarted.out);
  check("...and the process that holds the pid was still never signalled", alive(held));
  check("the delivery member is killed again", await crashDelivery());
  const live = identityRecord(held);
  pointAt(held, "token" in live ? live.token : "");
  const brokerPreview = cli("down", "stack-broker", "--dry-run", "--json");
  const brokerBlocked = cli("down", "stack-broker", "--yes");
  check("down stack-broker refuses that record by path and pid, and its Next says what to check", brokerBlocked.status === 2 && brokerBlocked.out.includes(`legacy local daemons on this root (delivery at ${at}, pid ${held})`) && brokerBlocked.out.includes(`check pid ${held} at ${at}; stop each process where it was started`), brokerBlocked.out);
  const previewWarning = doc(brokerPreview)?.warnings?.[0]?.message ?? "";
  check("...and its dry run exits 0 and warns with that refusal", brokerPreview.status === 0 && doc(brokerPreview)?.warnings?.length === 1
    && previewWarning.startsWith(`the real stop would refuse: legacy local daemons on this root (delivery at ${at}, pid ${held})`) && previewWarning.includes(`check pid ${held} at ${at}; stop each process where it was started`), brokerPreview.out);
  const blocked = cli("down", "--yes", "--json");
  check("a record whose pin matches a live process refuses LIFECYCLE_BLOCKED, naming its path and pid", blocked.status === 2 && doc(blocked)?.error?.code === "LIFECYCLE_BLOCKED" && doc(blocked)?.error?.message.includes(`(delivery at ${at}, pid ${held})`) === true, blocked.out);
  check("...its Next names the pid and path to check", doc(blocked)?.error?.remedy?.startsWith(`check pid ${held} at ${at}; stop each process where it was started`) === true, blocked.out);
  check("...and the record stays and the process was not signalled", existsSync(record) && alive(held));
  other.kill("SIGKILL");
  for (let i = 0; i < 50 && alive(held); i++) await sleep(100);
  // With that process gone, the running manager and a service the user added are what the broker's
  // stop would cut off. The stop refuses naming each exact stop, and its dry run warns with the same
  // refusal. Bare `down` refuses beside that service, so the Next names its stop before bare `down`.
  writeFileSync(join(base, "idle.json"), JSON.stringify({ schemaVersion: 1, space: "crash", launch: { type: "process", executable: process.execPath, args: ["-e", "setTimeout(() => {}, 600000)"], cwd: root }, readiness: { type: "process", timeoutMs: 10000 } }));
  const idleAdded = cli("service", "add", "idle", "--file", join(base, "idle.json"), "--space", "crash", "--json");
  const idle = (doc(cli("service", "start", "idle", "--space", "crash", "--json"))?.result as { instanceId?: string } | undefined)?.instanceId;
  check("rig: a service the user added runs beside the manager", idleAdded.status === 0 && typeof idle === "string", idleAdded.out);
  const instances = JSON.parse(cli("service", "--json").stdout).result?.instances as { definition: string; instanceId: string; observedProcess: string }[] | undefined;
  const managerId = instances?.find((row) => row.definition === "stack-manager" && row.observedProcess === "running")?.instanceId;
  const managerPreview = cli("down", "stack-broker", "--dry-run", "--json");
  const managerBlocked = cli("down", "stack-broker", "--yes", "--json");
  const refusal = doc(managerBlocked)?.error;
  check("with the manager running, down stack-broker refuses LIFECYCLE_BLOCKED naming it, and its Next names its exact stop",
    managerBlocked.status === 2 && refusal?.code === "LIFECYCLE_BLOCKED" && managerId !== undefined && refusal.message.startsWith("other service instances in this space (") && refusal.message.includes("stack-manager")
      && refusal.remedy?.includes(`cotal service stop stack-manager --instance ${managerId} --space crash --yes`) === true && !refusal.remedy.includes("<name>"), managerBlocked.out);
  check("...and its dry run exits 0 and warns with that refusal",
    managerPreview.status === 0 && doc(managerPreview)?.warnings?.length === 1 && doc(managerPreview)?.warnings?.[0]?.message === `the real stop would refuse: ${refusal?.message}; ${refusal?.remedy}`, managerPreview.out);
  check("...whose Next names the added service's stop first, then bare down, or the manager's stop and the broker stop again",
    refusal?.remedy === `stop the services outside the stack first with \`cotal service stop idle --instance ${idle} --space crash --yes\`, then stop the whole stack with bare \`cotal down\`, or also run \`cotal service stop stack-manager --instance ${managerId} --space crash --yes\` and then stop the broker again`, managerBlocked.out);
  const blockedStack = cli("down", "--space", "crash", "--yes", "--with-agents", "--json");
  check("the blocked stack stop keeps its space, agent policy, confirmation and format for the retry",
    blockedStack.status === 2 && doc(blockedStack)?.error?.code === "LIFECYCLE_BLOCKED" &&
      /`(?:pnpm )?cotal down --with-agents --yes --space crash --json`/.test(doc(blockedStack)?.error?.remedy ?? ""), blockedStack.out);
  const idleStop = cli("service", "stop", "idle", "--instance", String(idle), "--space", "crash", "--yes", "--json");
  check("the named service stop stops it", idleStop.status === 0, idleStop.out);
  const idleRemoved = cli("service", "remove", "idle", "--space", "crash", "--yes", "--json");
  check("rig: its definition is removed again", idleRemoved.status === 0, idleRemoved.out);
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

  // A full stop leaves the websocket port on the saved manager definition. The next up uses it when
  // it is free, and the existing taken-port notice covers a port another process holds.
  const reusedStart = cli("up");
  const reusedPort = receiptWsPort(reusedStart.out);
  check("the stack starts again after its hung member was stopped", reusedStart.status === 0 && reusedPort !== undefined, reusedStart.out);
  const reusedStop = cli("down", "--yes");
  check("down --yes stops that stack before the restart", reusedStop.status === 0, reusedStop.out);
  const restartedUp = cli("up");
  check("a full restart reuses the stopped stack's websocket port", restartedUp.status === 0 && receiptWsPort(restartedUp.out) === reusedPort, restartedUp.out);
  const restartedStop = cli("down", "--yes");
  check("down --yes stops the reused stack", restartedStop.status === 0, restartedStop.out);
  const portHolder = createServer();
  await new Promise<void>((done, fail) => portHolder.once("error", fail).listen(Number(reusedPort), "127.0.0.1", done));
  try {
    const moved = cli("up");
    const movedPort = receiptWsPort(moved.out);
    check("a recorded websocket port held by another process is replaced, and the notice names both ports",
      moved.status === 0 && movedPort !== undefined && movedPort !== reusedPort
      && moved.out.includes(`another process took the broker's websocket port ${reusedPort} before the broker bound it; launching the broker again with port ${movedPort}`),
      moved.out);
    const otherRoot = join(base, "other-port");
    mkdirSync(otherRoot, { mode: 0o700 });
    const otherAnchor = recordSmokeSandbox({ root: otherRoot, cotalHome: home, xdgConfigHome: configDir });
    const otherCli = (...args: string[]) => {
      const options = { cwd: otherRoot, env, encoding: "utf8" as const, timeout: 120_000 };
      assertSmokeSandboxDown(otherAnchor, args, options);
      const r = spawnSync(TSX, [CLI, ...args], options);
      return { status: r.status, out: plain(`${r.stdout}${r.stderr}`) };
    };
    const otherClient = await freePort();
    const otherCreated = cli("space", "create", "otherport", "--root", otherRoot);
    const otherUp = otherCli("up", "--server", `nats://127.0.0.1:${otherClient}`);
    const otherWs = receiptWsPort(otherUp.out);
    check("a second space takes its own websocket port and does not take the first space's",
      otherCreated.status === 0 && otherUp.status === 0 && otherWs !== undefined && otherWs !== reusedPort
      && !otherUp.out.includes("another process took the broker's websocket port"),
      otherUp.out);
    const otherDown = otherCli("down", "--yes");
    check("down --yes stops the second space", otherDown.status === 0, otherDown.out);
    const forgotOther = cli("space", "forget", "otherport");
    const selected = cli("use", "crash");
    check("the second space is forgotten and the first space is selected again", forgotOther.status === 0 && selected.status === 0, `${forgotOther.out}\n${selected.out}`);
  } finally {
    await new Promise<void>((done) => portHolder.close(() => done()));
  }
  const movedDown = cli("down", "--yes");
  check("down --yes stops the stack that replaced its websocket port", movedDown.status === 0, movedDown.out);

  const dashboardStack = cli("up", "--space", "crash");
  const dashboardBroker = runningMember("stack-broker");
  if (dashboardStack.status !== 0 || !dashboardBroker) throw new Error(`could not start the dashboard's stack: ${dashboardStack.out}`);
  await repairWithDashboard(dashboardBroker.pid);
} finally {
  if (hung !== undefined && alive(hung)) process.kill(hung, "SIGKILL");
  if (other?.pid !== undefined && alive(other.pid)) other.kill("SIGKILL");
  const down = cli("down", "--yes");
  check("down stops the stack", down.status === 0, down.out);
  const forgot = cli("space", "forget", "crash");
  const prepareAgain = /prepare it again with `(?:pnpm )?cotal space create crash --root (.+?)`/.exec(cli("status").out)?.[1];
  check("after a forget, status names space create --root with the folder quoted", forgot.status === 0 && shellWords(prepareAgain) === `${root}\n`, prepareAgain);
  const prepared = cli("space", "create", "crash");
  cli("use", "crash");
  const homeRow = /^ {2}(?:pnpm )?cotal up --root (.+?) {2,}Start this space$/m.exec(cliIn(base).out)?.[1];
  cli("use", "--clear");
  check("the home screen of a space prepared in another folder quotes that folder in its up --root row", prepared.status === 0 && shellWords(homeRow) === `${root}\n`, homeRow);
  cli("space", "forget", "crash");
  const moved = join(base, "moved $x 'q'");
  renameSync(root, moved);
  const adopt = /adopt it with `(?:pnpm )?cotal space create crash --adopt --root (.+?)`; this machine/.exec(cliIn(moved, "whoami").out)?.[1];
  check("a folder moved with its stack journal names space create --adopt with the new folder quoted", shellWords(adopt) === `${moved}\n`, adopt);
  rmSync(home, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
  finish();
}
