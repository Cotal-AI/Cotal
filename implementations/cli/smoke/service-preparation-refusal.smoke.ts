/**
 * A preset start that fails before its process exists leaves an instance that start, stop and
 * remove can clear. The manager preset is saved for a space that is prepared and not started, so
 * its launch plan cannot resolve a broker. The start must refuse with the target's own code and
 * record the instance as failed with no process; a second start, a stop and a removal must then
 * succeed or refuse on that same cause, never on the retained instance. A second record makes the
 * bare forms ambiguous until `remove --instance` clears one.
 *
 * Driven through the built binary in a sandboxed COTAL_HOME. No broker is started, and the only
 * service process launched is the HTTP readiness one below, which its own Next stops. The named
 * `down <service>` form runs the same stop path as `service stop` and is not driven here.
 *
 * A process definition whose envRefs read a variable the environment does not set refuses its start
 * before anything launches, naming that variable and the child variable it feeds, and `service show`
 * lists the references by name.
 *
 * A process definition whose HTTP readiness never answers exits 3 naming the loopback address, the
 * expected status, the deadline and the refused connection it saw, never the URL's path, and its
 * Next stops that exact instance and names `service show`. One that answers 503 exits 5 naming that
 * status. A second instance whose readiness address the first one answers is refused before launch,
 * naming the address and that instance, and no instance is recorded for it. A process with process
 * readiness that exits at once fails its start, exit 5, recording its exit code, and its restart is
 * partial, exit 4, naming that exit code and its log.
 *
 * A Linear service whose definition gives the child its own HOME, with COTAL_HOME unset, refuses
 * before a child in two isolated homes: with the account only in the child's home and only in the
 * controller's. Its space is registered in both homes as `up` records a started one, with static
 * authority at its root, so a start without that refusal reaches the account lookup. The built
 * Linear package is loaded with `--import`, as an installed extension is.
 *
 * Run: pnpm smoke:service-preparation-refusal
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSpaceAuth } from "@cotal-ai/core";
import { createSuite, freePort } from "@cotal-ai/smoke-kit";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
const LINEAR = join(import.meta.dirname, "..", "..", "linear", "dist", "index.js");
for (const built of [BIN, LINEAR]) if (!existsSync(built)) {
  console.error(`✗ ${built} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope {
  outcome: string;
  target: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error?: { code: string; message: string; remedy?: string };
}

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-service-prep-"));
const root = mkdtempSync(join(home, "project-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1" };
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout) as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });

const created = run(["space", "create", "b1", "--root", root]);
check("rig: the space is prepared and not started", created.status === 0, shown(created));
const added = run(["service", "add", "mymgr", "--preset", "manager", "--root", root, "--runtime", "pty", "--space", "b1"]);
check("rig: the manager preset is saved without starting anything", added.status === 0 && added.envelope?.outcome === "ok", shown(added));

const first = run(["service", "start", "mymgr", "--space", "b1"]);
check("rig: the start reached allocation; the binary is a verified entry for an adapter launch", first.envelope?.error?.code !== "UNSUPPORTED", shown(first));
const instance = first.envelope?.target?.instanceId;
check("the first start is refused under the target's own code, exit 2", first.status === 2 && first.envelope?.outcome === "refused" && first.envelope.error?.code === "TARGET_UNAVAILABLE", shown(first));
check("its message names the cause: the space is prepared and not started", /prepared but not started/.test(first.envelope?.error?.message ?? ""), first.envelope?.error);
check("its remedy is the action that starts the space", /cotal up/.test(first.envelope?.error?.remedy ?? ""), first.envelope?.error);
check("the instance is recorded as failed with no process", typeof instance === "string" && first.envelope?.target?.recordedState === "failed" && first.envelope.target.observedProcess === "gone" && first.envelope.target.pid === null, first.envelope?.target);

const second = run(["service", "start", "mymgr", "--space", "b1"]);
check("a second start refuses on the same cause, not on the retained instance", second.status === 2 && second.envelope?.error?.code === "TARGET_UNAVAILABLE", shown(second));
check("the second start reuses the same instance", second.envelope?.target?.instanceId === instance, second.envelope?.target);

const stopped = run(["service", "stop", "mymgr", "--space", "b1", "--yes"]);
check("stop finds nothing to stop: a no-op, exit 0", stopped.status === 0 && stopped.envelope?.outcome === "no-op", shown(stopped));

// Two records of one process service make the bare forms ambiguous. The refusal names each record
// with its state and the command that clears a stopped one, and clearing one frees the bare form.
const workerFile = join(home, "worker.json");
writeFileSync(workerFile, JSON.stringify({ schemaVersion: 1, space: "b1", launch: { type: "process", executable: process.execPath, args: ["-e", ""], cwd: root }, readiness: { type: "process", timeoutMs: 5000 } }));
const workerAdded = run(["service", "add", "worker", "--file", workerFile, "--space", "b1"]);
const firstWorker = run(["service", "start", "worker", "--space", "b1"]);
const secondWorker = run(["service", "start", "worker", "--new-instance", "--space", "b1"]);
const [one, two] = [firstWorker, secondWorker].map((r) => r.envelope?.target?.instanceId);
check("rig: two starts of a process service leave two records with no process", workerAdded.status === 0 && typeof one === "string" && typeof two === "string" && one !== two, { added: shown(workerAdded), first: shown(firstWorker), second: shown(secondWorker) });
const ambiguous = run(["service", "status", "worker", "--space", "b1"]);
const ambiguousNext = ambiguous.envelope?.error?.remedy ?? "";
check("a bare status with two records is TARGET_AMBIGUOUS, exit 2, naming each with its state",
  ambiguous.status === 2 && ambiguous.envelope?.error?.code === "TARGET_AMBIGUOUS" && [one, two].every((id) => new RegExp(`${id} \\(\\w+\\)`).test(ambiguousNext)), shown(ambiguous));
check("its Next names the remove --instance command for each stopped record", [one, two].every((id) => ambiguousNext.includes(`cotal service remove worker --instance ${id} --space b1 --yes`)), ambiguous.envelope?.error);
const unconfirmed = run(["service", "remove", "worker", "--instance", String(two), "--space", "b1"]);
check("remove --instance in a script needs --yes: USAGE_INVALID, exit 1", unconfirmed.status === 1 && unconfirmed.envelope?.error?.code === "USAGE_INVALID", shown(unconfirmed));
const cleared = run(["service", "remove", "worker", "--instance", String(two), "--space", "b1", "--yes"]);
check("remove --instance forgets that stopped record, exit 0", cleared.status === 0 && cleared.envelope?.result?.kind === "service-instance-record-removed" && cleared.envelope.result.instanceId === two, shown(cleared));
const again = run(["service", "remove", "worker", "--instance", String(two), "--space", "b1", "--yes"]);
check("the same ID again is TARGET_NOT_FOUND, exit 2", again.status === 2 && again.envelope?.error?.code === "TARGET_NOT_FOUND", shown(again));
const single = run(["service", "status", "worker", "--space", "b1"]);
check("the bare status reads the one record left", single.envelope?.error?.code !== "TARGET_AMBIGUOUS" && single.envelope?.target?.instanceId === one, shown(single));
const workerRemoved = run(["service", "remove", "worker", "--space", "b1", "--yes"]);
check("rig: the worker definition and its record are removed", workerRemoved.status === 0, shown(workerRemoved));

const removed = run(["service", "remove", "mymgr", "--space", "b1", "--yes"]);
check("remove forgets the definition and its failed instance, exit 0", removed.status === 0 && removed.envelope?.outcome === "ok", shown(removed));

const listed = run(["service", "--space", "b1"]);
const instances = listed.envelope?.result?.instances;
const definitions = listed.envelope?.result?.definitions;
check("no definition or instance record remains", Array.isArray(instances) && instances.length === 0 && Array.isArray(definitions) && definitions.length === 0, listed.envelope?.result);

// A process service whose envRefs read a variable this environment does not set.
const envDefinition = join(home, "env.json");
writeFileSync(envDefinition, JSON.stringify({ schemaVersion: 1, space: "b1", launch: { type: "process", executable: "/bin/sh", args: ["-c", "exit 0"], cwd: root }, readiness: { type: "process", timeoutMs: 3000 }, envRefs: { REVIEWS_TOKEN: "SMOKE_UNSET_REVIEWS_TOKEN" } }));
delete (env as NodeJS.ProcessEnv).SMOKE_UNSET_REVIEWS_TOKEN;
const envAdded = run(["service", "add", "envsvc", "--file", envDefinition, "--space", "b1"]);
check("rig: a process definition with an envRefs entry is saved", envAdded.status === 0 && envAdded.envelope?.outcome === "ok", shown(envAdded));
const unset = run(["service", "start", "envsvc", "--space", "b1"]);
check("a start without the referenced variable refuses DEPENDENCY_UNAVAILABLE, exit 2, naming it and the child variable, with a remedy that sets it",
  unset.status === 2 && unset.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE" && /does not set SMOKE_UNSET_REVIEWS_TOKEN \(passed to the service as REVIEWS_TOKEN\)/.test(unset.envelope.error.message) &&
    (unset.envelope.error.remedy ?? "").includes("set SMOKE_UNSET_REVIEWS_TOKEN"), shown(unset));
const shownText = spawnSync(process.execPath, [BIN, "service", "show", "envsvc", "--space", "b1"], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
check("service show lists the reference by name", shownText.status === 0 && /Environment references:\s+REVIEWS_TOKEN from SMOKE_UNSET_REVIEWS_TOKEN/.test(shownText.stdout), { status: shownText.status, stdout: shownText.stdout.slice(0, 900) });
const envRemoved = run(["service", "remove", "envsvc", "--space", "b1", "--yes"]);
check("rig: the definition is forgotten", envRemoved.status === 0, shown(envRemoved));

// A process service whose HTTP readiness never answers: nothing listens at its loopback address.
{
  const port = await freePort(), httpDefinition = join(home, "http.json");
  writeFileSync(httpDefinition, JSON.stringify({ schemaVersion: 1, space: "b1", launch: { type: "process", executable: "/bin/sh", args: ["-c", "exec sleep 60"], cwd: root }, readiness: { type: "http", url: `http://127.0.0.1:${port}/health?token=smoke-hidden`, expectedStatus: 200, timeoutMs: 1500 } }));
  const httpAdded = run(["service", "add", "httpsvc", "--file", httpDefinition, "--space", "b1"]);
  check("rig: a process definition with HTTP readiness is saved", httpAdded.status === 0 && httpAdded.envelope?.outcome === "ok", shown(httpAdded));
  const late = run(["service", "start", "httpsvc", "--space", "b1"]);
  const id = late.envelope?.target?.instanceId, message = late.envelope?.error?.message ?? "", remedy = late.envelope?.error?.remedy ?? "";
  check("a start whose HTTP readiness never answers exits 3, naming the address, status, deadline and the refused connection",
    late.status === 3 && late.envelope?.error?.code === "OPERATION_UNKNOWN" && message.includes(`on 127.0.0.1:${port} with status 200 within 1500 ms; the last check saw connection refused`) && message.includes("left running"), shown(late));
  check("it never prints the URL's path or query", !`${late.stdout}${late.stderr}`.includes("/health") && !`${late.stdout}${late.stderr}`.includes("smoke-hidden"), shown(late));
  check("its Next names the logs and the stop for that exact instance, and service show for the deadline", typeof id === "string" && remedy.includes(`cotal service logs httpsvc --instance ${id} --space b1`) && remedy.includes(`cotal service stop httpsvc --instance ${id} --space b1 --yes`) && remedy.endsWith("cotal service show httpsvc --space b1 shows the readiness deadline it missed"), late.envelope?.error);
  const stopped = run(["service", "stop", "httpsvc", "--instance", String(id), "--space", "b1", "--yes"]);
  check("following it stops the process, exit 0", stopped.status === 0 && stopped.envelope?.outcome === "ok", shown(stopped));
  check("rig: the definition is forgotten", run(["service", "remove", "httpsvc", "--space", "b1", "--yes"]).status === 0);
}

// A process service that answers its own HTTP readiness with a status, as a Node child on a free port.
const answering = (port: number, status: number) => ({ type: "process", executable: process.execPath, args: ["-e", `require("node:http").createServer((_, res) => { res.statusCode = ${status}; res.end(); }).listen(${port}, "127.0.0.1")`], cwd: root });
{
  const port = await freePort(), file = join(home, "unready.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, space: "b1", launch: answering(port, 503), readiness: { type: "http", url: `http://127.0.0.1:${port}/health`, expectedStatus: 200, timeoutMs: 1500 } }));
  check("rig: a definition whose process answers 503 is saved", run(["service", "add", "unready", "--file", file, "--space", "b1"]).status === 0);
  const unready = run(["service", "start", "unready", "--space", "b1"]);
  const id = unready.envelope?.target?.instanceId, message = unready.envelope?.error?.message ?? "";
  check("a start whose process answers 503 until the deadline fails OPERATION_FAILED, exit 5, naming that status and the process left running",
    unready.status === 5 && unready.envelope?.error?.code === "OPERATION_FAILED" && message.includes(`on 127.0.0.1:${port} with status 503, not 200, until its 1500 ms deadline passed`) && message.includes("left running") && (unready.envelope.error.remedy ?? "").includes(`cotal service stop unready --instance ${id} --space b1 --yes`), shown(unready));
  check("following it stops the process, exit 0", run(["service", "stop", "unready", "--instance", String(id), "--space", "b1", "--yes"]).status === 0);
  check("rig: the definition is forgotten", run(["service", "remove", "unready", "--space", "b1", "--yes"]).status === 0);
}

// A process with process readiness that exits at once, as a bad configuration makes it.
{
  const file = join(home, "broken.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, space: "b1", launch: { type: "process", executable: "/bin/sh", args: ["-c", "echo broken; exit 1"], cwd: root }, readiness: { type: "process", timeoutMs: 3000 } }));
  check("rig: a definition whose process exits 1 at once is saved", run(["service", "add", "broken", "--file", file, "--space", "b1"]).status === 0);
  const exited = (r: ReturnType<typeof run>) => r.status === 5 && r.envelope?.error?.code === "OPERATION_FAILED" && (r.envelope.error.message ?? "").includes("exited before readiness was established (exit code 1")
    && r.envelope.target?.recordedState === "failed" && (r.envelope.target.exit as { code?: number } | null)?.code === 1;
  const start = run(["service", "start", "broken", "--space", "b1"]);
  check("its start fails OPERATION_FAILED, exit 5, and records exit code 1", exited(start), shown(start));
  const restart = run(["service", "restart", "broken", "--space", "b1", "--yes"]);
  check("its restart is partial, exit 4, naming the replacement's exit code and its log",
    restart.status === 4 && restart.envelope?.error?.code === "OPERATION_PARTIAL" && (restart.envelope.error.message ?? "").includes("exited before readiness was established (exit code 1") && (restart.envelope.error.remedy ?? "").startsWith("read its log with cotal service logs broken --instance "), shown(restart));
  const after = run(["service", "status", "broken", "--space", "b1"]);
  check("status then shows it failed with exit code 1", after.envelope?.result?.recordedState === "failed" && (after.envelope.result.exit as { code?: number } | null)?.code === 1, after.envelope?.result);
  check("rig: the definition is forgotten", run(["service", "remove", "broken", "--space", "b1", "--yes"]).status === 0);
}

// A second instance of a service whose readiness address its first instance answers.
{
  const port = await freePort(), file = join(home, "web.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, space: "b1", launch: answering(port, 200), readiness: { type: "http", url: `http://127.0.0.1:${port}/health`, expectedStatus: 200, timeoutMs: 5000 } }));
  check("rig: a definition whose process answers 200 is saved", run(["service", "add", "web", "--file", file, "--space", "b1"]).status === 0);
  const first = run(["service", "start", "web", "--space", "b1"]);
  const id = first.envelope?.result?.instanceId;
  check("rig: its first instance starts reachable", first.status === 0 && first.envelope?.result?.readinessObservation === "http-reachable", shown(first));
  const second = run(["service", "start", "web", "--new-instance", "--space", "b1"]);
  check("a second instance on that address refuses CONFLICT, exit 2, naming the address and the first instance, before any launch",
    second.status === 2 && second.envelope?.error?.code === "CONFLICT" && (second.envelope.error.message ?? "").startsWith(`something already answers 127.0.0.1:${port}, where web's HTTP readiness is checked`) && (second.envelope.error.remedy ?? "").startsWith(`instance ${id} of web answers there`), shown(second));
  const listed = run(["service", "--space", "b1"]);
  check("no instance was recorded for it", (listed.envelope?.result?.instances as { definition?: string }[] | undefined)?.filter((row) => row.definition === "web").length === 1, listed.envelope?.result);
  check("rig: the first instance stops", run(["service", "stop", "web", "--instance", String(id), "--space", "b1", "--yes"]).status === 0);
  check("rig: the definition is forgotten", run(["service", "remove", "web", "--space", "b1", "--yes"]).status === 0);
}

// A Linear service whose envRefs give the child HOME from SERVICE_HOME. With COTAL_HOME unset, each
// process reads the Cotal home under its own HOME: the controller's is `a`, the child's `b`.
const homes = mkdtempSync(join(home, "linear-"));
const [homeA, homeB, linearRoot] = ["a", "b", "project"].map((name) => join(homes, name));
for (const dir of [homeA, homeB, linearRoot]) mkdirSync(dir, { mode: 0o700 });
const token = join(homes, "token"), definition = join(homes, "lin.json");
writeFileSync(token, "lin_local_not_a_real_token\n", { mode: 0o600 });
writeFileSync(definition, JSON.stringify({ schemaVersion: 1, space: "lin", launch: { type: "adapter", adapter: "linear-service", options: { root: linearRoot, account: "work", endpoint: "com.example.linear" } }, readiness: { type: "adapter", timeoutMs: 20000 }, envRefs: { HOME: "SERVICE_HOME" } }));
const linear = (homeDir: string, args: string[], extra: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(LINEAR).href, BIN, ...args, "--json"], { cwd: linearRoot, env: { ...HOST_ENV, HOME: homeDir, USERPROFILE: homeDir, XDG_CONFIG_HOME: join(home, ".config"), SERVICE_HOME: homeB, COTAL_SKIP_CONNECTOR_SEED: "1", ...extra }, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout) as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, envelope };
};
const refusedBeforeChild = (r: ReturnType<typeof linear>) => r.status === 2 && r.envelope?.outcome === "refused" && r.envelope.error?.code === "UNSUPPORTED"
  && /envRefs set HOME for the Linear child/.test(r.envelope.error.message) && /COTAL_HOME/.test(r.envelope.error.remedy ?? "")
  && r.envelope.target?.recordedState === "failed" && r.envelope.target.observedProcess === "gone" && r.envelope.target.pid === null;

// Static authority at the root and the space's registration in both homes, as a started `up` leaves
// them, so the controller and the child each resolve the space under their own home.
mkdirSync(join(linearRoot, ".cotal"), { mode: 0o700 });
saveSpaceAuth(authDir(linearRoot), await createSpaceAuth("lin"));
for (const homeDir of [homeA, homeB]) {
  process.env.COTAL_HOME = join(homeDir, ".cotal");
  recordMesh({ space: "lin", server: "nats://127.0.0.1:4222", root: linearRoot, mode: "auth", origin: "up", ts: new Date().toISOString() });
}
delete process.env.COTAL_HOME;
const linearAdded = linear(homeA, ["service", "add", "lin", "--file", definition, "--space", "lin"]);
check("rig: the Linear definition with a HOME reference is saved", linearAdded.status === 0 && linearAdded.envelope?.outcome === "ok", shown(linearAdded));

const childAccount = linear(homeB, ["linear", "account", "add", "work", "--mode", "readonly", "--token-file", token]);
check("rig: the account is recorded only in the child's home", childAccount.status === 0 && existsSync(join(homeB, ".cotal", "linear", "work.json")) && !existsSync(join(homeA, ".cotal", "linear", "work.json")), shown(childAccount));
const validChild = linear(homeA, ["service", "start", "lin", "--space", "lin"]);
check("with the account only in the child's home, the start refuses the moved home before a child, not as a missing account", refusedBeforeChild(validChild), shown(validChild));

// With COTAL_HOME set, the child inherits it and reads the controller's home, so the same definition
// passes the home check and reaches the account lookup there, which has no account yet. It runs
// before the account moves to `a`, so no child is launched.
const pinned = linear(homeA, ["service", "start", "lin", "--space", "lin"], { COTAL_HOME: join(homeA, ".cotal") });
check("with COTAL_HOME set, the HOME reference is not refused and the start reaches the account lookup", pinned.status === 2 && pinned.envelope?.error?.code === "TARGET_NOT_FOUND"
  && /no Linear account with this name is recorded/.test(pinned.envelope.error.message) && pinned.envelope.target?.pid === null, shown(pinned));

rmSync(join(homeB, ".cotal", "linear"), { recursive: true, force: true });
const controllerAccount = linear(homeA, ["linear", "account", "add", "work", "--mode", "readonly", "--token-file", token]);
check("rig: the account is recorded only in the controller's home", controllerAccount.status === 0 && existsSync(join(homeA, ".cotal", "linear", "work.json")) && !existsSync(join(homeB, ".cotal", "linear", "work.json")), shown(controllerAccount));
const missingChild = linear(homeA, ["service", "start", "lin", "--space", "lin"]);
check("with the account missing from the child's home, the start refuses before a child is launched", refusedBeforeChild(missingChild), shown(missingChild));

finish();
process.exit(process.exitCode ?? 0);
