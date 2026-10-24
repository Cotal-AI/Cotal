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
 * A launch argument over 8192 characters refuses SCHEMA_INVALID, and a `--handler-args` argument over
 * 4096 refuses USAGE_INVALID, each naming its position and that limit, and neither is saved.
 *
 * A process definition whose envRefs read a variable the environment does not set refuses its start
 * before anything launches, naming that variable and the child variable it feeds, and `service show`
 * lists the references by name.
 *
 * A bare executable name is looked up on `add`'s PATH and saved as the absolute path found, so a
 * start under another PATH runs that same file. A PATH with a relative or empty entry refuses the
 * lookup, and so does a name not on PATH. A definition an earlier release saved with a bare name
 * refuses to start and records no instance.
 *
 * A process definition whose HTTP readiness never answers exits 3 naming the loopback address, the
 * expected status, the deadline and the refused connection it saw, never the URL's path, and its
 * Next stops that exact instance and names `service show`. One that answers 503 exits 5 naming that
 * status. A second instance whose readiness address the first one answers is refused before launch,
 * naming the address and that instance, and no instance is recorded for it. A process with process
 * readiness that exits at once fails its start, exit 5, recording its exit code, and its restart is
 * partial, exit 4, naming that exit code and its log.
 *
 * On Linux, a stop ends the server a service's shell backgrounded, so its address is free and the
 * next start is reachable on its own. A server that left the service's process group with `setsid`
 * outlives the stop, and the stop, `service status`, `cotal service` and `cotal status` each warn
 * SERVICE_ADDRESS_HELD naming its address and its PID. A start while it holds the address refuses
 * CONFLICT naming that PID and does not signal it. The suite then stops that server by PID. Before the
 * first stop, `service stop --dry-run` names the process group it would signal and its members, and
 * says a descendant that left the group is not signalled.
 *
 * A process executable that every other local account can write, or one in a folder they can
 * write, is refused at `add` naming that path with its `chmod o-w`, and so is a link in such a
 * folder, by the link's folder. A saved one that later becomes writable is refused at `start` and
 * `restart` before anything launches or stops. World write is used because group write is refused
 * or accepted by whether the host proves a private group. The Node services run a copy of Node in
 * the suite's private home, since a shared tool cache can be writable by other accounts.
 *
 * A saved executable that was moved or set to mode 0600, or a working directory that was removed or
 * set to mode 000, refuses the start DEPENDENCY_UNAVAILABLE, naming the path, what is wrong with it
 * and its fix: putting it back, or the `chmod` that restores the mode. A path that is gone also names
 * the `service remove` that lets the service be added again with another one, and an `add` of a path
 * that does not exist names the field to correct. No refused start records an instance.
 *
 * A definition whose readiness breaks the schema refuses SCHEMA_INVALID, exit 1, naming the field
 * and the rule it breaks, such as a timeoutMs out of range or a field the chosen type does not take.
 *
 * `service remove` of a controller stack member's definition refuses UNSUPPORTED and keeps it.
 *
 * `add` saves a definition with its space's root, and refuses a file that sets `root` itself. After
 * `space forget`, a space of that name prepared in another folder lists the definition as inherited
 * from that root, and `start`, `restart` and `install` of it refuse CONFLICT, naming the root and
 * `service remove`. A definition with no recorded root, as an earlier release saved, starts as before.
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
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSpaceAuth } from "@cotal-ai/core";
import { createSuite, freePort } from "@cotal-ai/smoke-kit";
import { authDir, loopbackListeners, recordMesh, saveSpaceAuth, spaceKey } from "@cotal-ai/workspace";

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
  warnings?: { code: string; target?: Record<string, unknown>; message: string }[];
}

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-service-prep-"));
const root = mkdtempSync(join(home, "project-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1" };
const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000 });
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
writeFileSync(workerFile, JSON.stringify({ schemaVersion: 1, space: "b1", launch: { type: "process", executable: "/bin/sh", args: ["-c", ""], cwd: root }, readiness: { type: "process", timeoutMs: 5000 } }));
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
const gone = run(["service", "show", "envsvc", "--space", "b1"]);
check("service show of a definition that is not saved is TARGET_NOT_FOUND, exit 2, naming where the saved ones are", gone.status === 2 && gone.envelope?.error?.code === "TARGET_NOT_FOUND" && gone.envelope.error.remedy === "see the saved definitions with `cotal service`", shown(gone));

// A readiness value that breaks the schema names the field and its rule, never the value, and its
// Next says to correct readiness.
const readinessCases: [string, unknown, string][] = [
  ["no timeoutMs", { type: "process" }, "readiness.timeoutMs is required for process readiness, which takes type, timeoutMs"],
  ["a zero timeoutMs", { type: "process", timeoutMs: 0 }, "readiness.timeoutMs must be a whole number of milliseconds from 1 to 120000"],
  ["a timeoutMs given as text", { type: "process", timeoutMs: "5000" }, "readiness.timeoutMs must be a whole number of milliseconds from 1 to 120000"],
  ["an unknown type", { type: "tcp", timeoutMs: 5000 }, "readiness.type must be process, http or adapter"],
  ["no type", { timeoutMs: 5000 }, "readiness.type is required: process, http or adapter"],
  ["an http readiness with no url", { type: "http", expectedStatus: 200, timeoutMs: 5000 }, "readiness.url is required for http readiness, which takes type, url, expectedStatus, timeoutMs"],
  ["a status out of range", { type: "http", url: "http://127.0.0.1:8080/health", expectedStatus: 700, timeoutMs: 5000 }, "readiness.expectedStatus must be a whole number from 100 to 599"],
  ["a field the type does not take", { type: "process", timeoutMs: 5000, retries: 3 }, "readiness.retries is not a field of process readiness, which takes type, timeoutMs"],
  ["a url off loopback", { type: "http", url: "https://example.com/health", expectedStatus: 200, timeoutMs: 5000 }, "readiness.url must be an http:// URL on 127.0.0.1 or [::1] with a path, such as http://127.0.0.1:8080/health"],
  ["a readiness that is not an object", "process", "readiness must be an object with a type of process, http or adapter and a timeoutMs"],
];
for (const [what, readiness, rule] of readinessCases) {
  const file = join(home, "readiness.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, space: "b1", launch: { type: "process", executable: "/bin/sh", args: ["-c", "exit 0"], cwd: root }, readiness }));
  const bad = run(["service", "add", "badready", "--file", file, "--space", "b1"]);
  check(`a definition with ${what} refuses SCHEMA_INVALID, exit 1, naming the rule, with a Next`,
    bad.status === 1 && bad.envelope?.error?.code === "SCHEMA_INVALID" && bad.envelope.error.message === `service definition: ${rule}` && bad.envelope.error.remedy === "correct readiness in the definition as the message says, then add it again", shown(bad));
}
check("no refused definition was saved", run(["service", "show", "badready", "--space", "b1"]).envelope?.error?.code === "TARGET_NOT_FOUND");

// An argument over its bound names its position and the bound, not only the field it is in.
{
  const file = join(home, "longarg.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, space: "b1", launch: { type: "process", executable: "/bin/sh", args: ["-c", "x".repeat(8193)], cwd: root }, readiness: { type: "process", timeoutMs: 5000 } }));
  const launch = run(["service", "add", "longarg", "--file", file, "--space", "b1"]);
  check("a launch argument over 8192 characters refuses SCHEMA_INVALID, exit 1, naming its position and the limit",
    launch.status === 1 && launch.envelope?.error?.code === "SCHEMA_INVALID" && launch.envelope.error.message === "service definition: launch argument 2 (launch.args[1]) has 8193 characters, and a launch argument holds at most 8192", shown(launch));
  const handler = run(["service", "add", "longep", "--preset", "exec-endpoint", "--root", root, "--contract", file, "--handler", "/bin/sh", "--handler-args", JSON.stringify(["x", "x".repeat(4097)]), "--space", "b1"]);
  check("a --handler-args argument over 4096 characters refuses USAGE_INVALID, exit 1, naming its position and the limit",
    handler.status === 1 && handler.envelope?.error?.code === "USAGE_INVALID" && handler.envelope.error.message === "--handler-args argument 2 has 4097 characters, and each holds at most 4096; the value was not printed", shown(handler));
  check("neither over-long definition was saved", ["longarg", "longep"].every((name) => run(["service", "show", name, "--space", "b1"]).envelope?.error?.code === "TARGET_NOT_FOUND"));
}

// A controller stack member's definition stays with its stack, whose up and down read it. Its name
// marks it, so a definition saved under one stands for the stack's here.
const member = run(["service", "add", "stack-manager", "--preset", "manager", "--root", root, "--runtime", "pty", "--space", "b1"]);
check("rig: a definition under a stack member's name is saved", member.status === 0, shown(member));
const keptMember = run(["service", "remove", "stack-manager", "--space", "b1", "--yes"]);
check("service remove of a stack member's definition refuses UNSUPPORTED, exit 2, naming down and space forget, and keeps it",
  keptMember.status === 2 && keptMember.envelope?.error?.code === "UNSUPPORTED" && keptMember.envelope.error.remedy === "it goes with the stack: cotal down --yes, then cotal space forget b1"
    && run(["service", "show", "stack-manager", "--space", "b1"]).status === 0, shown(keptMember));

// A bare executable name, looked up once on add's PATH. The pinned script and a decoy of the same
// name each record which one ran.
{
  const pinned = mkdtempSync(join(home, "pinned-")), decoy = mkdtempSync(join(home, "decoy-")), ran = join(home, "ran.log"), file = join(home, "bare.json");
  for (const [dir, mark] of [[pinned, "pinned"], [decoy, "decoy"]]) writeFileSync(join(dir, "smoke-tick"), `#!/bin/sh\necho ${mark} >> ${ran}\nexec sleep 60\n`, { mode: 0o700 });
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, space: "b1", launch: { type: "process", executable: "smoke-tick", args: [], cwd: root }, readiness: { type: "process", timeoutMs: 3000 } }));
  const hostPath = process.env.PATH ?? "";
  const refusedLookup = (r: ReturnType<typeof run>) => r.status === 2 && r.envelope?.error?.code === "UNSUPPORTED" && /this PATH has a relative or empty entry; nothing was saved/.test(r.envelope.error.message);
  const relative = run(["service", "add", "bare", "--file", file, "--space", "b1"], { PATH: `.:${pinned}:${hostPath}` });
  check("add with a relative PATH entry refuses the lookup UNSUPPORTED, exit 2", refusedLookup(relative), shown(relative));
  const empty = run(["service", "add", "bare", "--file", file, "--space", "b1"], { PATH: `${pinned}::${hostPath}` });
  check("add with an empty PATH entry refuses it the same way", refusedLookup(empty), shown(empty));
  const missing = run(["service", "add", "bare", "--file", file, "--space", "b1"]);
  check("add of a name not on PATH refuses DEPENDENCY_UNAVAILABLE, exit 2", missing.status === 2 && missing.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE", shown(missing));
  const afterRefused = run(["service", "--space", "b1"]);
  const definitionsNow = afterRefused.envelope?.result?.definitions as { name?: string }[] | undefined;
  check("none of the refused adds saved a definition", Array.isArray(definitionsNow) && !definitionsNow.some((row) => row.name === "bare"), definitionsNow);
  const added = run(["service", "add", "bare", "--file", file, "--space", "b1"], { PATH: `${pinned}:${hostPath}` });
  check("add saves the bare name as the absolute path it finds on PATH, and reports it", added.status === 0 && added.envelope?.result?.executable === join(pinned, "smoke-tick"), shown(added));
  const started = run(["service", "start", "bare", "--space", "b1"], { PATH: `${decoy}:${hostPath}` });
  const id = started.envelope?.result?.instanceId;
  check("a start under a PATH whose first match is another file runs the pinned one", started.status === 0 && readFileSync(ran, "utf8") === "pinned\n", { start: shown(started), ran: existsSync(ran) ? readFileSync(ran, "utf8") : null });
  check("rig: it stops", run(["service", "stop", "bare", "--instance", String(id), "--space", "b1", "--yes"]).status === 0);
  check("rig: the definition is forgotten", run(["service", "remove", "bare", "--space", "b1", "--yes"]).status === 0);
  // An earlier release saved the bare name itself.
  const definitions = join(env.COTAL_HOME, "services", spaceKey("b1"), "definitions");
  mkdirSync(definitions, { recursive: true, mode: 0o700 });
  writeFileSync(join(definitions, `${spaceKey("legacy")}.json`), JSON.stringify({ recordVersion: 1, revision: randomUUID(), value: JSON.parse(readFileSync(file, "utf8")) }), { mode: 0o600 });
  const legacy = run(["service", "start", "legacy", "--space", "b1"], { PATH: `${pinned}:${hostPath}` });
  check("a definition saved with a bare name refuses to start SCHEMA_INVALID, exit 1, naming the remove and add again",
    legacy.status === 1 && legacy.envelope?.error?.code === "SCHEMA_INVALID" && /names its executable by a bare name/.test(legacy.envelope.error.message) && /add it again/.test(legacy.envelope.error.remedy ?? ""), shown(legacy));
  const legacyRows = run(["service", "--space", "b1"]).envelope?.result?.instances as { definition?: string }[] | undefined;
  check("...and records no instance", Array.isArray(legacyRows) && !legacyRows.some((row) => row.definition === "legacy"), legacyRows);
  check("...and runs nothing", readFileSync(ran, "utf8") === "pinned\n");
  check("rig: the legacy definition is forgotten", run(["service", "remove", "legacy", "--space", "b1", "--yes"]).status === 0);
}

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
const node = join(home, "node");
copyFileSync(process.execPath, node);
chmodSync(node, 0o700);
const answering = (port: number, status: number) => ({ type: "process", executable: node, args: ["-e", `require("node:http").createServer((_, res) => { res.statusCode = ${status}; res.end(); }).listen(${port}, "127.0.0.1")`], cwd: root });
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
  check("...and quotes the last line it logged during that launch", (start.envelope?.error?.message ?? "").endsWith("the last line it logged is: broken"), shown(start));
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

// A shell that backgrounds the server answering its readiness, and one whose server leaves the
// service's process group.
if (process.platform === "linux") {
  const answers = async (port: number) => {
    try { await (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })).body?.cancel(); return true; } catch { return false; }
  };
  const shell = (port: number, prefix: string) => ({ type: "process", executable: "/bin/sh", args: ["-c", `${prefix}${node} -e 'require("node:http").createServer((_, res) => res.end()).listen(${port}, "127.0.0.1")' & wait`], cwd: root });
  const held = (r: ReturnType<typeof run>, port: number) => r.envelope?.warnings?.find((w) => w.code === "SERVICE_ADDRESS_HELD" && w.target?.address === `127.0.0.1:${port}`);
  {
    const port = await freePort(), file = join(home, "grouped.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, space: "b1", launch: shell(port, ""), readiness: { type: "http", url: `http://127.0.0.1:${port}/`, expectedStatus: 200, timeoutMs: 5000 } }));
    check("rig: a definition whose shell backgrounds its server is saved", run(["service", "add", "grouped", "--file", file, "--space", "b1"]).status === 0);
    check("rig: it starts reachable", run(["service", "start", "grouped", "--space", "b1"]).envelope?.result?.readinessObservation === "http-reachable");
    const preview = run(["service", "stop", "grouped", "--space", "b1", "--dry-run"]);
    const signal = preview.envelope?.result?.stopSignal as { scope?: string; pid?: number; processes?: number } | null | undefined;
    check("its stop --dry-run names the process group it would signal and its members, and signals nothing",
      preview.status === 0 && signal?.scope === "process-group" && (signal.processes ?? 0) >= 2 && preview.envelope?.result?.signalled === false && await answers(port), preview.envelope?.result);
    const text = spawnSync(process.execPath, [BIN, "service", "stop", "grouped", "--space", "b1", "--dry-run", "--plain"], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
    const flat = text.stdout.replace(/\s+/g, " ");
    check("...and its text names SIGTERM to that group and that a descendant which left it is not signalled",
      text.status === 0 && flat.includes(`Stop signal: SIGTERM to process group ${signal?.pid} (`) && flat.includes("One that left the group, such as with setsid, is not signalled."), text.stdout.slice(0, 1500));
    const stop = run(["service", "stop", "grouped", "--space", "b1", "--yes"]);
    check("its stop ends the backgrounded server, so nothing answers its address and no warning names it", stop.status === 0 && !await answers(port) && !held(stop, port), shown(stop));
    const again = run(["service", "start", "grouped", "--space", "b1"]);
    check("the next start is reachable, exit 0", again.status === 0 && again.envelope?.result?.readinessObservation === "http-reachable", shown(again));
    check("rig: it stops", run(["service", "stop", "grouped", "--space", "b1", "--yes"]).status === 0 && !await answers(port));
    check("rig: the definition is forgotten", run(["service", "remove", "grouped", "--space", "b1", "--yes"]).status === 0);
  }
  {
    // `cotal status` reads the services of a registered space, so this one is registered, at an
    // address where no broker listens.
    const heldRoot = mkdtempSync(join(home, "held-"));
    process.env.COTAL_HOME = env.COTAL_HOME;
    recordMesh({ space: "held", server: `nats://127.0.0.1:${await freePort()}`, root: heldRoot, mode: "open", origin: "manual", ts: new Date().toISOString() });
    delete process.env.COTAL_HOME;
    const port = await freePort(), file = join(home, "escaped.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, space: "held", launch: shell(port, "setsid "), readiness: { type: "http", url: `http://127.0.0.1:${port}/`, expectedStatus: 200, timeoutMs: 5000 } }));
    check("rig: a definition whose server leaves the process group is saved", run(["service", "add", "escaped", "--file", file, "--space", "held"]).status === 0);
    check("rig: it starts reachable", run(["service", "start", "escaped", "--space", "held"]).envelope?.result?.readinessObservation === "http-reachable");
    const stop = run(["service", "stop", "escaped", "--space", "held", "--yes"]);
    const warning = held(stop, port), pid = Number(/; process (\d+) \(node\) of this account listens there$/.exec(warning?.message ?? "")?.[1]);
    const listening = loopbackListeners(`http://127.0.0.1:${port}/`);
    check("its stop warns SERVICE_ADDRESS_HELD, naming the address and the server's PID", stop.status === 0 && warning?.target?.definition === "escaped" && (warning.message ?? "").startsWith(`something still answers 127.0.0.1:${port}, where escaped's HTTP readiness is checked, and no instance of escaped runs`) && listening.length === 1 && listening[0] === pid, { stop: shown(stop), listening });
    const blocked = run(["service", "start", "escaped", "--space", "held"]);
    check("a start while that server holds the address refuses CONFLICT, exit 2, naming its PID and program, and leaves it running",
      blocked.status === 2 && blocked.envelope?.error?.code === "CONFLICT" && (blocked.envelope.error.message ?? "").endsWith(`; process ${pid} (node) of this account listens there; nothing was launched`)
        && blocked.envelope.error.remedy === `stop process ${pid} (node), which is not an instance of escaped, then run the command again` && await answers(port), shown(blocked));
    const status = run(["service", "status", "escaped", "--space", "held"]);
    check("service status names it", status.status === 0 && held(status, port) !== undefined, shown(status));
    const listed = run(["service", "--space", "held"]);
    check("cotal service names it", held(listed, port) !== undefined, shown(listed));
    const report = run(["status", "--space", "held"]);
    check("cotal status names it", held(report, port) !== undefined, shown(report));
    for (const listener of listening) process.kill(listener);
    for (let i = 0; i < 40 && await answers(port); i++) await new Promise((done) => setTimeout(done, 100));
    const after = run(["service", "status", "escaped", "--space", "held"]);
    check("once that server is gone no warning names the address", !await answers(port) && after.status === 0 && !held(after, port), shown(after));
    check("rig: the definition is forgotten", run(["service", "remove", "escaped", "--space", "held", "--yes"]).status === 0);
  }
}

// A process executable another local account could write, by its own mode, its folder's, or the
// folder a link to it is in.
{
  const dir = mkdtempSync(join(home, "exe-")), script = join(dir, "run.sh"), file = join(home, "exe.json");
  writeFileSync(script, "#!/bin/sh\nexec sleep 60\n", { mode: 0o700 });
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, space: "b1", launch: { type: "process", executable: script, args: [], cwd: root }, readiness: { type: "process", timeoutMs: 3000 } }));
  const unsafe = (r: ReturnType<typeof run>, what: string, path: string) => r.status === 2 && r.envelope?.error?.code === "PERMISSION_DENIED"
    && r.envelope.error.message === `${what} is not protected against other local writers: ${realpathSync(path)} is writable by every local account` && r.envelope.error.remedy === `chmod o-w ${realpathSync(path)}`;
  chmodSync(script, 0o702);
  const fileAdd = run(["service", "add", "unsafe", "--file", file, "--space", "b1"]);
  check("add refuses a world-writable executable PERMISSION_DENIED, exit 2, naming it, with chmod o-w as its Next", unsafe(fileAdd, "the service executable", script), shown(fileAdd));
  chmodSync(script, 0o700);
  chmodSync(dir, 0o707);
  const folderAdd = run(["service", "add", "unsafe", "--file", file, "--space", "b1"]);
  check("add refuses an executable in a world-writable folder, naming the folder", unsafe(folderAdd, "the service executable", dir), shown(folderAdd));
  chmodSync(dir, 0o700);
  const links = mkdtempSync(join(home, "links-")), link = join(links, "run.sh"), linkFile = join(home, "link.json");
  symlinkSync(script, link);
  chmodSync(links, 0o707);
  writeFileSync(linkFile, JSON.stringify({ schemaVersion: 1, space: "b1", launch: { type: "process", executable: link, args: [], cwd: root }, readiness: { type: "process", timeoutMs: 3000 } }));
  const linkAdd = run(["service", "add", "linked", "--file", linkFile, "--space", "b1"]);
  check("add refuses a link in a world-writable folder to a protected file, naming the link's folder", unsafe(linkAdd, "the service executable's folder", links), shown(linkAdd));
  chmodSync(links, 0o700);
  const saved = run(["service", "--space", "b1"]);
  const savedNames = ((saved.envelope?.result?.definitions as { name: string }[] | undefined) ?? []).map((row) => row.name);
  check("no refused definition was saved", Array.isArray(saved.envelope?.result?.definitions) && !savedNames.includes("unsafe") && !savedNames.includes("linked"), savedNames);
  check("rig: the protected executable is saved", run(["service", "add", "unsafe", "--file", file, "--space", "b1"]).status === 0);
  const started = run(["service", "start", "unsafe", "--space", "b1"]);
  const id = started.envelope?.result?.instanceId;
  check("rig: it starts", started.status === 0 && typeof id === "string", shown(started));
  chmodSync(script, 0o702);
  const restart = run(["service", "restart", "unsafe", "--space", "b1", "--yes"]);
  check("a restart once the executable is world-writable refuses before it stops anything", unsafe(restart, "the service executable", script), shown(restart));
  const kept = run(["service", "status", "unsafe", "--space", "b1"]);
  check("the running instance is left running", kept.envelope?.result?.instanceId === id && kept.envelope?.result?.recordedState === "running", kept.envelope?.result);
  const another = run(["service", "start", "unsafe", "--new-instance", "--space", "b1"]);
  check("a start refuses it the same way", unsafe(another, "the service executable", script), shown(another));
  const listed = run(["service", "--space", "b1"]);
  check("the refused start recorded no instance", (listed.envelope?.result?.instances as { definition?: string }[] | undefined)?.filter((row) => row.definition === "unsafe").length === 1, listed.envelope?.result);
  chmodSync(script, 0o700);
  check("rig: its instance stops", run(["service", "stop", "unsafe", "--instance", String(id), "--space", "b1", "--yes"]).status === 0);
  check("rig: the definition is forgotten", run(["service", "remove", "unsafe", "--space", "b1", "--yes"]).status === 0);
}

// A saved executable that was moved or lost its execute bit, or a working directory that was removed
// or lost its modes, refuses the start, naming that path, what is wrong with it and the fix.
{
  const dir = realpathSync(mkdtempSync(join(home, "moved-"))), script = join(dir, "run.sh"), work = join(dir, "work"), file = join(home, "moved.json");
  writeFileSync(script, "#!/bin/sh\nexec sleep 60\n", { mode: 0o700 });
  mkdirSync(work, { mode: 0o700 });
  const definition = (executable: string) => JSON.stringify({ schemaVersion: 1, space: "b1", launch: { type: "process", executable, args: [], cwd: work }, readiness: { type: "process", timeoutMs: 3000 } });
  const unavailable = (r: ReturnType<typeof run>, message: string, remedy: string) => r.status === 2 && r.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE"
    && r.envelope.error.message === `${message}; no launch or write was attempted` && r.envelope.error.remedy === remedy;
  const replace = (thing: string) => `; to use another ${thing}, forget the service with cotal service remove moved --space b1 --yes and add it again`;
  writeFileSync(file, definition(join(dir, "nosuch.sh")));
  const missingAdd = run(["service", "add", "moved", "--file", file, "--space", "b1"]);
  check("add of an executable that does not exist refuses DEPENDENCY_UNAVAILABLE, exit 2, naming it and the field to correct",
    unavailable(missingAdd, `the declared executable ${join(dir, "nosuch.sh")} does not exist`, "correct launch.executable in the definition, then run the command again"), shown(missingAdd));
  writeFileSync(file, definition(script));
  check("rig: the definition is saved", run(["service", "add", "moved", "--file", file, "--space", "b1"]).status === 0);
  renameSync(script, `${script}.moved`);
  const moved = run(["service", "start", "moved", "--space", "b1"]);
  check("a start after the executable was moved refuses DEPENDENCY_UNAVAILABLE, exit 2, naming it, putting it back and the remove that replaces it",
    unavailable(moved, `the declared executable ${script} does not exist`, `put it back at ${script}, then run the command again${replace("file")}`), shown(moved));
  renameSync(`${script}.moved`, script);
  rmSync(work, { recursive: true });
  const removed = run(["service", "start", "moved", "--space", "b1"]);
  check("a start after the working directory was removed names it, creating it again and the remove that replaces it",
    unavailable(removed, `the declared working directory ${work} does not exist`, `create ${work} or put it back, then run the command again${replace("folder")}`), shown(removed));
  mkdirSync(work, { mode: 0o700 });
  // Root reads and enters any folder and runs a file with any execute bit, so these modes refuse only an ordinary account.
  if (process.getuid?.() !== 0) {
    chmodSync(script, 0o600);
    const plain = run(["service", "start", "moved", "--space", "b1"]);
    check("a start of an executable set to mode 0600 names that mode and chmod u+x",
      unavailable(plain, `the declared executable ${script} is not executable by you (mode 0600)`, `make it executable with chmod u+x ${script}, then run the command again`), shown(plain));
    chmodSync(script, 0o700);
    chmodSync(work, 0o000);
    const closed = run(["service", "start", "moved", "--space", "b1"]);
    check("a start in a working directory set to mode 000 names that mode and chmod u+rx",
      unavailable(closed, `the declared working directory ${work} cannot be read and entered by you (mode 0000)`, `let yourself read and enter it with chmod u+rx ${work}, then run the command again`), shown(closed));
    chmodSync(work, 0o700);
  }
  const listed = run(["service", "--space", "b1"]);
  check("no refused start recorded an instance", Array.isArray(listed.envelope?.result?.instances) && !(listed.envelope.result.instances as { definition?: string }[]).some((row) => row.definition === "moved"), listed.envelope?.result);
  const started = run(["service", "start", "moved", "--space", "b1"]);
  const id = started.envelope?.result?.instanceId;
  check("with each put back, the start runs it", started.status === 0 && typeof id === "string", shown(started));
  check("rig: its instance stops", run(["service", "stop", "moved", "--instance", String(id), "--space", "b1", "--yes"]).status === 0);
  check("rig: the definition is forgotten", run(["service", "remove", "moved", "--space", "b1", "--yes"]).status === 0);
}

// A definition records the root it was added in. After a forget, a space of the same name prepared
// in another folder lists it as inherited and refuses to launch it; one with no recorded root, as an
// earlier release saved, starts as before.
{
  const [rootA, rootB] = ["alt-", "neu-"].map((prefix) => realpathSync(mkdtempSync(join(home, prefix))));
  const tickFile = join(home, "tick.json");
  const tick = (extra: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 1, space: "inh", launch: { type: "process", executable: "/bin/sh", args: ["-c", "exec sleep 30"], cwd: rootA }, readiness: { type: "process", timeoutMs: 5000 }, ...extra });
  type Definition = { name: string; root: string | null; rootMatch: string };
  const definitionsOf = () => (run(["service", "--space", "inh"]).envelope?.result?.definitions ?? []) as Definition[];
  const prepared = run(["space", "create", "inh", "--root", rootA]);
  writeFileSync(tickFile, tick({ root: rootB }));
  const claimed = run(["service", "add", "claimed", "--file", tickFile, "--space", "inh"]);
  check("a definition file that sets root is refused SCHEMA_INVALID, exit 1, and nothing is saved",
    prepared.status === 0 && claimed.status === 1 && claimed.envelope?.error?.code === "SCHEMA_INVALID" && /sets root/.test(claimed.envelope.error.message) && !definitionsOf().some((row) => row.name === "claimed"), shown(claimed));
  writeFileSync(tickFile, tick());
  const added = run(["service", "add", "tick", "--file", tickFile, "--space", "inh"]);
  const saved = run(["service", "show", "tick", "--space", "inh"]);
  check("add saves the definition with the space's root", added.status === 0 && saved.envelope?.result?.root === rootA && saved.envelope.result.rootMatch === "this-root", shown(saved));
  const forgot = run(["space", "forget", "inh"]);
  const again = run(["space", "create", "inh", "--root", rootB]);
  check("rig: the space is forgotten and prepared again in another folder", forgot.status === 0 && again.status === 0, { forgot: shown(forgot), again: shown(again) });
  const inherited = definitionsOf().find((row) => row.name === "tick");
  check("the other folder's space lists it as inherited, with the root it was added in", inherited?.root === rootA && inherited.rootMatch === "inherited", inherited);
  const text = spawnSync(process.execPath, [BIN, "service", "--space", "inh"], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  check("  and its text marks it inherited from that root", text.status === 0 && text.stdout.includes(`inherited from ${rootA}`), text.stdout.slice(-1500));
  for (const [mode, extra] of [["start", []], ["restart", ["--yes"]], ["install", ["--dry-run"]]] as const) {
    const r = run(["service", mode, "tick", "--space", "inh", ...extra]);
    check(`${mode} of it refuses CONFLICT, exit 2, naming that root and service remove`,
      r.status === 2 && r.envelope?.error?.code === "CONFLICT" && r.envelope.error.message.includes(`added in ${rootA}, not in this space's root ${rootB}`)
        && r.envelope.error.remedy?.includes("cotal service remove tick --space inh --yes") === true, shown(r));
  }
  const after = run(["service", "--space", "inh"]);
  check("  and no instance of it is recorded", ((after.envelope?.result?.instances ?? []) as { definition: string }[]).every((row) => row.definition !== "tick"), shown(after));
  const dir = join(home, ".cotal", "services", spaceKey("inh"), "definitions");
  const record = JSON.parse(readFileSync(join(dir, `${spaceKey("tick")}.json`), "utf8")) as { value: Record<string, unknown> };
  delete record.value.root;
  writeFileSync(join(dir, `${spaceKey("old")}.json`), JSON.stringify(record), { mode: 0o600 });
  const old = definitionsOf().find((row) => row.name === "old");
  const started = run(["service", "start", "old", "--space", "inh"]);
  check("a definition with no recorded root is listed as root not recorded and starts as before",
    old?.root === null && old.rootMatch === "not-recorded" && started.status === 0 && started.envelope?.outcome === "ok", { old, started: shown(started) });
  const stopped = run(["service", "stop", "old", "--space", "inh", "--yes"]);
  check("rig: that start is stopped", stopped.status === 0, shown(stopped));
  const removed = run(["service", "remove", "tick", "--space", "inh", "--yes"]);
  check("the remove the refusal names forgets the inherited definition", removed.status === 0 && !definitionsOf().some((row) => row.name === "tick"), shown(removed));
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
