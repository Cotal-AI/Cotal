/**
 * `cotal space`, `cotal space show [name]` and `cotal use [space]`, driven through the built binary.
 * The registry is written with the workspace's own writer into a sandboxed `COTAL_HOME`, so the
 * binary reads the records a real `up`, `meshes add` or catalog sync leaves. A real broker answers
 * for one space; another points at a port nothing listens on; a discovered one points at a listener
 * that counts connections, so the suite can show a read never dials it.
 * A registry record that does not parse refuses reads with SCHEMA_INVALID. Clearing the selection
 * reports that it cannot identify the folder's space but still clears the selection.
 *
 * Needs `nats-server` on PATH.
 *
 * Run: pnpm smoke:space-reads
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN, assertSmokeSandboxDown, createSuite, freePort, killAndAwaitExit, listenOn, recordSmokeSandbox, teardownOnSignal } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "cotal-space-reads-"));
const cotalHome = join(home, ".cotal");
mkdirSync(cotalHome, { mode: 0o700 });
const xdgConfigHome = join(home, ".config");
const xdgRuntimeDir = join(home, "runtime");
mkdirSync(xdgRuntimeDir, { mode: 0o700 });
const hintProject = mkdtempSync(join(home, "hint-root-"));
const hintSandbox = recordSmokeSandbox({ root: hintProject, cotalHome, xdgConfigHome });
// Set before the workspace is imported: it reads COTAL_HOME on each call, so the real ~/.cotal is
// never touched.
process.env.COTAL_HOME = cotalHome;
const { clearCurrent, findMesh, getCurrent, meshesDir, preparedSpacesDir, recordMesh, removeMesh, setCurrent, spaceSegment } = await import("@cotal-ai/workspace");
const { processServiceHost, requireProcessIdentity, serviceInstanceStore } = await import("../src/lib/service-instances.js");

const { check, finish } = createSuite();
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));

const DEAD = `nats://127.0.0.1:${await freePort()}`;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const run = (args: string[], extraEnv: Record<string, string> = {}, cwd = home) => {
  const options = {
    cwd,
    env: { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdgConfigHome, XDG_RUNTIME_DIR: xdgRuntimeDir, COTAL_HOME: cotalHome, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", ...extraEnv },
    encoding: "utf8" as const,
    timeout: 120_000,
  };
  assertSmokeSandboxDown(hintSandbox, args, options);
  const r = spawnSync(process.execPath, [BIN, ...args], options);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const json = (args: string[], cwd = home) => {
  const r = run([...args, "--json"], {}, cwd);
  let env: Record<string, any> | undefined;
  try {
    env = JSON.parse(r.stdout);
  } catch {
    env = undefined;
  }
  return { ...r, env };
};
const shown = (r: { status: number | null; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 600), stderr: r.stderr.slice(0, 400) });
const itemOf = (env: Record<string, any> | undefined, name: string) => (env?.result?.items as { space: string }[] | undefined)?.find((s) => s.space === name) as Record<string, unknown> | undefined;
const registryFiles = () => readdirSync(meshesDir()).sort().map((f) => `${f}:${readFileSync(join(meshesDir(), f), "utf8")}`);

function saveDormantBroker(space: string, project: string): string {
  const declaration = join(home, `${space}-broker.json`), config = join(project, ".cotal", "server.conf");
  writeFileSync(config, "", { mode: 0o600 });
  writeFileSync(declaration, JSON.stringify({ schemaVersion: 1, space,
    launch: { type: "adapter", adapter: "nats-broker", options: { root: project, config, binary: process.execPath, server: DEAD } },
    readiness: { type: "adapter", timeoutMs: 30_000 },
  }), { mode: 0o600 });
  const added = json(["service", "add", "stack-broker", "--space", space, "--file", declaration], project);
  const revision: unknown = added.env?.result?.revision;
  if (added.status !== 0 || typeof revision !== "string") throw new Error(`could not save the dormant broker fixture: ${JSON.stringify(shown(added))}`);
  return revision;
}

function checkRunningSpaceSearchPermission(space: string, project: string): void {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const control = join(project, ".cotal");
  chmodSync(control, 0o600);
  try {
    accessSync(project, constants.X_OK);
    const plain = run(["space", "show", space, "--plain"]);
    const denied = json(["space", "show", space]);
    const remedy = "Restore search permission before retrying.";
    check("plain space show preserves broker reachability and asks to restore control directory access",
      plain.status === 0 && /broker: +reachable/.test(plain.stdout) && plain.stderr.includes(control) && plain.stderr.includes(remedy) &&
      !plain.stdout.includes("folder was moved or deleted") && !plain.stdout.includes("down --space"), shown(plain));
    check("JSON space show warns about denied control directory lookup without marking the root gone",
      denied.status === 0 && denied.env?.result?.check === "reachable" && denied.env.result.rootGone === false &&
      denied.env.warnings.some((w: { code: string; target: { path?: string }; message: string }) =>
        w.code === "PERMISSION_DENIED" && w.target.path === control && w.message.includes(remedy)), shown(denied));
  } finally { chmodSync(control, 0o700); }
  const restored = json(["space", "show", space]);
  check("restoring search permission clears the warning without restarting the broker",
    restored.status === 0 && restored.env?.result?.check === "reachable" && restored.env.result.rootGone === false &&
    restored.env.warnings.length === 0, shown(restored));
}

// An implicit config scope outside a project requires a running broker.
function checkConfigScope(live: string): void {
  const space = "config-probe";
  const entry = { space, server: DEAD, root: hintProject, mode: "open", origin: "manual", ts: new Date().toISOString() } as const;
  recordMesh(entry);
  try {
    const set = json(["config", "set", "harness", "codex", "--space", space]);
    check("fixture: the offline space holds a harness override", set.status === 0, shown(set));
    const before = registryFiles();
    const plain = run(["config", "get", "harness", "--plain"]);
    const implicit = json(["config", "get", "harness"]);
    check("without a running space, plain and JSON use defaults", plain.status === 0 && /Value:\s+claude/.test(plain.stdout) && /Scope:\s+your defaults/.test(plain.stdout) &&
      implicit.status === 0 && implicit.env?.target === null && implicit.env.result.scope.space === null && implicit.env.result.setting.value === "claude", { plain: shown(plain), json: shown(implicit) });
    const explicit = json(["config", "get", "harness", "--space", space]);
    check("explicit config still reads the offline space without changing the registry", explicit.status === 0 && explicit.env?.result.setting.value === "codex" &&
      explicit.env.result.scope.from === "flag" && JSON.stringify(registryFiles()) === JSON.stringify(before), shown(explicit));
    setCurrent(space);
    const selected = json(["config", "get", "harness"]);
    check("a saved selection still reads the offline space", selected.status === 0 && selected.env?.result.setting.value === "codex" && selected.env.result.scope.from === "selected", shown(selected));
    clearCurrent();
    recordMesh({ ...entry, server: live });
    const running = json(["config", "get", "harness"]);
    check("the only running space supplies its override", running.status === 0 && running.env?.result.setting.value === "codex" && running.env.result.scope.from === "running", shown(running));
  } finally {
    clearCurrent();
    json(["config", "unset", "harness", "--space", space]);
    removeMesh(space);
  }
}

// ── An empty registry ────────────────────────────────────────────────────────────────────────────────
{
  const empty = json(["space"]);
  check("space --json on an empty registry is one ok envelope with no items", empty.status === 0 && empty.env?.outcome === "ok" && empty.env.target === null && empty.env.result.items.length === 0 && empty.env.result.current === null, shown(empty));
  const human = run(["space"]);
  check("the empty report says how to start or register a space", human.status === 0 && /No spaces registered\./.test(human.stdout) && /^ {2}cotal setup\s/m.test(human.stdout) && /^ {2}cotal space add <name> --server <url> --root <dir>\s/m.test(human.stdout), shown(human));
  const none = json(["use"]);
  check("bare use with nothing selected reports no selection", none.status === 0 && none.env?.result.current === null && none.env.target === null, shown(none));
}

// Exercise the same preparation with its directory intact, missing, and replaced by a file.
{
  const space = "lab-07", project = mkdtempSync(join(home, `${space}-`));
  const created = json(["space", "create", space, "--root", project]);
  if (created.status !== 0) throw new Error(`could not prepare the fixture: ${JSON.stringify(shown(created))}`);
  const record = join(preparedSpacesDir(), `${spaceSegment(space)}.json`);
  const preparedBefore = readFileSync(record);
  const show = () => run(["space", "show", space, "--plain"]);
  const who = () => json(["who", "--space", space]);
  const startup = (launcher: string) => `start it with \`${launcher} up\` in ${project}`;
  const recovery = (text: string) => text.includes(`cotal space forget ${space}`) &&
    text.includes(`cotal space create ${space} --root <dir>`) && !text.includes("cotal up");
  const intact = show(), intactTarget = who();
  check("an intact prepared folder is still a place to start the space",
    intact.status === 0 && ["cotal", "pnpm cotal"].some((launcher) => intact.stdout.includes(startup(launcher))) && intactTarget.status === 2 &&
      intactTarget.env?.error?.code === "TARGET_UNAVAILABLE" && intactTarget.env.error.remedy === startup("cotal"),
    [intact, intactTarget].map(shown));

  if (process.platform !== "win32") {
    chmodSync(project, 0);
    try {
      let searchable = true;
      try { accessSync(project, constants.X_OK); } catch { searchable = false; }
      if (!searchable) {
        const denied = json(["space", "show", space]), deniedTarget = who();
        check("a directory this account cannot enter offers restore-access advice instead of startup",
          denied.status === 0 && denied.env?.result?.rootMissing === true &&
            deniedTarget.status === 2 && deniedTarget.env?.error?.code === "TARGET_UNAVAILABLE" &&
            deniedTarget.env.error.remedy.includes("restore access") && !deniedTarget.env.error.remedy.includes("cotal up"), [denied, deniedTarget].map(shown));
        const deniedDelete = json(["space", "delete", space, "--dry-run"]);
        const asksForAccess = (r: ReturnType<typeof json>, code: string) => r.status === 2 && r.env?.error?.code === code &&
          r.env.error.message.includes(`${project} could not be accessed`) && r.env.error.remedy.includes("restore access") &&
          !r.env.error.remedy.includes("cotal reset store");
        check("delete preview asks for access instead of looking for the existing directory", asksForAccess(deniedDelete, "TARGET_UNAVAILABLE"), shown(deniedDelete));
      }
    } finally { chmodSync(project, 0o700); }
  }

  saveDormantBroker(space, project);

  renameSync(project, `${project}.saved`);
  const missing = show(), missingTarget = who();
  check("a missing prepared folder is still reported as missing",
    missing.status === 0 && missing.stdout.includes(`${project}, which no longer exists`) && recovery(missing.stdout) &&
      missingTarget.status === 2 && missingTarget.env?.error?.code === "TARGET_UNAVAILABLE" &&
      missingTarget.env.error.message.includes(`${project}, which no longer exists`) && recovery(missingTarget.env.error.remedy),
    [missing, missingTarget].map(shown));
  const bareProject = mkdtempSync(join(home, "bare-up-"));
  mkdirSync(join(bareProject, ".cotal"), { mode: 0o700 });
  // If target resolution admits startup, runtime preflight still prevents a launch.
  const bareUp = () => json(["up", "--open", "--runtime", "smoke-missing-runtime", "--server", DEAD], bareProject);
  setCurrent(space);
  const missingUp = bareUp();
  check("bare up refuses to start another space when the selected root is missing",
    missingUp.status === 2 && missingUp.env?.error?.code === "TARGET_UNAVAILABLE" && missingUp.env.error.message.includes(`${project}, which no longer exists`), shown(missingUp));

  const replacement = "replacement file\n";
  writeFileSync(project, replacement);
  clearCurrent();
  const plain = show(), detail = json(["space", "show", space]), target = who();
  const list = run(["space", "--plain"]), listed = json(["space"]);
  const fileMessage = `${project}, which is not a directory`;
  check("space show identifies a non-directory and offers recovery without startup advice",
    plain.status === 0 && plain.stdout.includes(fileMessage) && plain.stdout.includes("restore the original project folder") && recovery(plain.stdout), shown(plain));
  check("space list and detail JSON mark a non-directory as an unavailable project folder",
    detail.status === 0 && listed.status === 0 &&
      [detail.env?.result, listed.env?.result?.prepared?.[0]].every((row) => row?.rootMissing === true && !("rootProblem" in row)),
    [detail, listed].map(shown));
  check("space list labels a non-directory and does not offer startup advice for it",
    list.status === 0 && list.stdout.includes(`${project} (not a directory)`) && recovery(list.stdout), shown(list));
  check("who names the non-directory in its TARGET_UNAVAILABLE refusal and offers recovery",
    target.status === 2 && target.env?.error?.code === "TARGET_UNAVAILABLE" && target.env.error.message.includes(fileMessage) &&
      target.env.error.remedy.includes("restore the original project folder") && recovery(target.env.error.remedy), shown(target));
  const deletion = json(["space", "delete", space, "--dry-run"]);
  check("deletion preview names the non-directory without offering an unusable store reset",
    deletion.status === 2 && deletion.env?.error?.code === "TARGET_UNAVAILABLE" && deletion.env.error.message.includes(`${project} is not a directory`) &&
      deletion.env.error.remedy.includes("restore the original project folder") && deletion.env.error.remedy.includes(`cotal space forget ${space}`) &&
      !deletion.env.error.remedy.includes("cotal reset store"), shown(deletion));

  const selected = run(["use", space, "--plain"]);
  check("selecting the preparation does not offer startup at a file", selected.status === 0 && selected.stdout.includes(fileMessage) && recovery(selected.stdout), shown(selected));
  const elsewhere = mkdtempSync(join(home, "elsewhere-"));
  const create = json(["space", "create", space, "--root", elsewhere]);
  check("preparing the name elsewhere refuses with recovery advice", create.status === 2 && create.env?.error?.code === "CONFLICT" &&
    create.env.error.message.includes(fileMessage) && recovery(create.env.error.remedy), shown(create));
  const at = ["--space", space, "--server", DEAD];
  const addressed = json(["who", ...at]);
  check("an unreachable explicit broker still reports its address without offering startup at a file",
    addressed.status === 2 && addressed.env?.error?.code === "TARGET_UNAVAILABLE" && addressed.env.error.message.includes(DEAD) &&
      addressed.env.error.remedy.includes(`${project} is not a directory`) && recovery(addressed.env.error.remedy), shown(addressed));
  mkdirSync(join(elsewhere, ".cotal"), { mode: 0o700 });
  const diagnostic = json(["doctor", "auth", "--space", space], elsewhere);
  check("auth diagnostics do not direct the operator to the invalid prepared root", diagnostic.status === 2 && diagnostic.env?.error?.code === "AUTH_REQUIRED" &&
    diagnostic.env.error.remedy.includes(fileMessage) && recovery(diagnostic.env.error.remedy), shown(diagnostic));
  const up = ["up", "--foreground", "--no-manager", "--open", ...at];
  const explicit = run([...up, "--root", project], {}, elsewhere);
  check("explicit up --root refuses a file without starting anything or offering to prepare it", explicit.status === 2 &&
    explicit.stderr.includes("TARGET_UNAVAILABLE") && explicit.stderr.includes("a file occupies the project path") && recovery(explicit.stderr) &&
    !explicit.stderr.includes("prepare it with"), shown(explicit));
  const namedUp = run(up, {}, elsewhere);
  check("named up from another folder refuses without offering startup at a file", namedUp.status === 2 &&
    namedUp.stderr.includes("TARGET_UNAVAILABLE") && namedUp.stderr.includes(fileMessage) && recovery(namedUp.stderr), shown(namedUp));
  check("inspection and refusal leave the replacement file and prepared record intact",
    readFileSync(project, "utf8") === replacement && readFileSync(record).equals(preparedBefore) && readdirSync(join(elsewhere, ".cotal")).length === 0);
  const forgot = json(["space", "forget", space]);
  check("the stale preparation can be forgotten without touching the replacement file",
    forgot.status === 0 && !existsSync(record) && readFileSync(project, "utf8") === replacement, shown(forgot));
  const reprepare = json(["space", "create", space, "--root", elsewhere]);
  check("the space can then be prepared in a new directory", reprepare.status === 0 && reprepare.env?.result?.root === elsewhere, shown(reprepare));
  const definition = json(["service", "show", "stack-broker", "--space", space], elsewhere);
  check("forget releases the dormant definition bound to the file path",
    forgot.env?.result?.releasedDefinitions?.join() === "stack-broker" && definition.status === 2 &&
      definition.env?.error?.code === "TARGET_NOT_FOUND" && definition.env.error.message.includes("no saved service definition"),
    [forgot, definition].map(shown));
  const cleanup = json(["space", "forget", space]);
  check("the recovery fixture leaves no preparation for the rest of the suite", cleanup.status === 0 && !existsSync(record), shown(cleanup));
}

{
  const space = "nested-root", parent = mkdtempSync(join(home, "parent-")), project = join(parent, "child");
  mkdirSync(project, { mode: 0o700 });
  const created = json(["space", "create", space, "--root", project]);
  if (created.status !== 0) throw new Error(`could not prepare the nested fixture: ${JSON.stringify(shown(created))}`);
  const record = join(preparedSpacesDir(), `${spaceSegment(space)}.json`), before = readFileSync(record);
  renameSync(parent, `${parent}-moved`);
  writeFileSync(parent, "ancestor file\n");
  const add = json(["space", "add", space, "--server", DEAD, "--root", hintProject, "--force"]);
  check("space add diagnoses an ancestor file without suggesting local startup",
    add.status === 2 && add.env?.error?.code === "CONFLICT" && add.env.error.message.includes(`${project}, which is not a directory`) &&
      add.env.error.remedy.includes(`space forget ${space}`) && !add.env.error.remedy.includes("cotal up") &&
      readFileSync(parent, "utf8") === "ancestor file\n" && readFileSync(record).equals(before), shown(add));
  json(["space", "forget", space]);
}

// A stopped stack's copied journal must be adopted if the project is kept at its new location.
{
  const space = "moved-stack", project = mkdtempSync(join(home, "original-")), moved = `${project}-moved`;
  const created = json(["space", "create", space, "--root", project]);
  if (created.status !== 0) throw new Error(`could not prepare the moved fixture: ${JSON.stringify(shown(created))}`);
  const now = new Date().toISOString();
  const journal = ".cotal/stack-controller.json";
  const definitionRevision = saveDormantBroker(space, project);
  const instanceId = randomUUID(), requestId = randomUUID(), instances = serviceInstanceStore(space);
  const instance = {
    schemaVersion: 1 as const, instanceId, definition: "stack-broker", definitionRevision,
    space, host: processServiceHost(), requestId, launchRequestId: requestId, state: "stopped" as const,
    launcher: requireProcessIdentity(process.pid), readiness: "not-checked" as const, supervisor: "none" as const,
    foreground: false, createdAt: now, updatedAt: now,
  };
  instances.commit(instanceId, undefined, instance);
  const bytes = JSON.stringify({ schemaVersion: 1, kind: "cotal-stack-controller", root: project, space, mode: "open", server: DEAD,
    members: ["broker", "auth", "delivery", "manager"].map((role) => ({ role, definition: `stack-${role}`, instanceId: role === "broker" ? instanceId : null, state: role === "broker" ? "stopped" : "not-attempted" })),
    operation: { id: randomUUID(), kind: "down", phase: "completed", recordedAt: now, withAgents: false }, updatedAt: now,
  });
  writeFileSync(join(project, journal), bytes, { mode: 0o600 });
  renameSync(project, moved);
  const obstruction = join(home, "obstruction");
  writeFileSync(obstruction, "replacement\n");
  symlinkSync(obstruction, project, "file");
  const record = join(preparedSpacesDir(), `${spaceSegment(space)}.json`), before = readFileSync(record);
  instances.commit(instanceId, instances.read(instanceId), { ...instance, host: { ...instance.host, machine: "f".repeat(64) } });

  const show = run(["space", "show", "--plain"], {}, moved);
  const list = run(["space", "--plain"], {}, moved);
  const use = run(["use", space, "--plain"], {}, moved);
  const who = json(["who", "--space", space], moved);
  const movedRecovery = (text: string) => text.includes(`space forget ${space}`) &&
    text.includes(`space create ${space} --adopt --root ${moved}`) && !text.includes("cotal up");
  check("a foreign stopped instance at an obstructed old path does not get forget-and-adopt advice",
    [list, show, use, who].every((r) => r.stdout.includes("move this folder back") && !r.stdout.includes("--adopt") && !r.stdout.includes(`space forget ${space}`)) &&
      show.status === 0 && who.status === 2 && who.env?.error?.code === "TARGET_UNAVAILABLE" &&
      readFileSync(record).equals(before) && readFileSync(obstruction, "utf8") === "replacement\n" &&
      readFileSync(join(moved, journal), "utf8") === bytes, [list, show, use, who].map(shown));
  rmSync(project);
  instances.commit(instanceId, instances.read(instanceId), instance);
  const missingShow = run(["space", "show", "--plain"], {}, moved);
  const missingWho = json(["who", "--space", space], moved);
  check("a confirmed stopped local stack with a missing old path still gets adoption advice",
    missingShow.status === 0 && movedRecovery(missingShow.stdout) && missingWho.status === 2 &&
      missingWho.env?.error?.code === "TARGET_UNAVAILABLE" && movedRecovery(missingWho.env.error.remedy), [missingShow, missingWho].map(shown));
  instances.commit(instanceId, instances.read(instanceId), { ...instance, state: "starting" });
  const unresolved = json(["who", "--space", space], moved);
  check("a retained nonterminal instance is not offered adoption at a missing old path",
    unresolved.status === 2 && unresolved.env?.error?.code === "TARGET_UNAVAILABLE" &&
      unresolved.env.error.remedy.includes("move this folder back") && !unresolved.env.error.remedy.includes("--adopt"), shown(unresolved));
  instances.commit(instanceId, instances.read(instanceId), instance);
  const forgot = json(["space", "forget", space]);
  const adopted = json(["space", "create", space, "--adopt", "--root", moved], moved);
  check("the advertised adoption succeeds without modifying the file at the old path",
    forgot.status === 0 && forgot.env?.result?.releasedDefinitions?.join() === "stack-broker" && instances.read(instanceId) === undefined &&
      adopted.status === 0 && adopted.env?.result?.root === moved &&
      JSON.parse(readFileSync(join(moved, journal), "utf8")).root === moved && readFileSync(obstruction, "utf8") === "replacement\n", [forgot, adopted].map(shown));
  const cleanup = json(["space", "forget", space]);
  check("the moved fixture leaves no preparation", cleanup.status === 0, shown(cleanup));
}

{
  const space = "stopped-registration", project = mkdtempSync(join(home, "stopped-registration-"));
  recordMesh({ space, root: project, server: DEAD, mode: "open", origin: "up", stoppedByDown: true, ts: new Date().toISOString() });
  renameSync(project, `${project}-moved`);
  writeFileSync(project, "replacement file\n");
  const recovery = (text: string) => text.includes("not a directory") && text.includes(`space forget ${space}`) && !text.includes("cotal up");
  const selected = run(["use", space, "--plain"]), selection = json(["use"]);
  const show = run(["space", "show", space, "--plain"]), detail = json(["space", "show", space]);
  const who = json(["who", "--space", space]), status = run(["status", "--space", space, "--plain"]);
  check("an obstructed stopped registration has recovery advice and no restart hint",
    selected.status === 0 && recovery(selected.stdout) && selection.env?.result?.preparedState === "stopped" && selection.env.result.preparedRoot === project &&
      show.status === 0 && recovery(show.stdout) && detail.env?.result?.rootGone === true &&
      who.status === 2 && who.env?.error?.code === "TARGET_UNAVAILABLE" && recovery(`${who.env.error.message} ${who.env.error.remedy}`) &&
      status.status === 4 && recovery(status.stdout) && !status.stderr.includes("/.cotal/nats.pid"), [selected, selection, show, detail, who, status].map(shown));
  const forgot = json(["space", "forget", space]);
  check("forget removes the stopped registration but leaves the file untouched", forgot.status === 0 && findMesh(space) === undefined &&
    readFileSync(project, "utf8") === "replacement file\n", shown(forgot));
}

const brokerPort = await freePort();
const LIVE = `nats://127.0.0.1:${brokerPort}`;
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(brokerPort), "-sd", mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN))], { stdio: "ignore" });
teardownOnSignal(broker);
broker.on("error", () => {
  console.error("needs nats-server on PATH");
  process.exit(1);
});
// A discovered space's broker: it accepts and says nothing, and counts who dialed it.
let catalogDials = 0;
const catalogServer = createServer((socket) => {
  catalogDials++;
  socket.destroy();
});
const CATALOG = `nats://127.0.0.1:${await listenOn(catalogServer, await freePort())}`;
process.on("exit", () => {
  broker.kill("SIGKILL");
  catalogServer.close();
});

for (let i = 0; i < 50; i++) {
  const { isReachable } = await import("@cotal-ai/core");
  if (await isReachable(LIVE)) break;
  await new Promise((r) => setTimeout(r, 100));
}
checkConfigScope(LIVE);

const ts = new Date().toISOString();
const root = mkdtempSync(join(home, "root-"));
recordMesh({ space: "alpha", server: LIVE, root, mode: "open", origin: "up", ts });
recordMesh({ space: "beta", server: DEAD, root, mode: "auth", origin: "manual", tlsRequired: true, ts });
recordMesh({ space: "gamma", server: CATALOG, root, mode: "user", origin: "catalog", catalogOwner: "acct-1", catalogName: "Research Lab", catalogFetchedAt: ts, userAuth: { provider: "cotal", idp: { url: "https://idp.test", issuer: "https://idp.test", audience: "cotal" }, remote: true, endpoints: { url: "https://auth.test" }, sentinelCredsPath: join(root, "sentinel.creds") }, ts });

// ── The listing ──────────────────────────────────────────────────────────────────────────────────────
{
  const before = registryFiles();
  const list = json(["space"]);
  const alpha = itemOf(list.env, "alpha");
  const beta = itemOf(list.env, "beta");
  const gamma = itemOf(list.env, "gamma");
  check("space --json lists every registration", list.status === 0 && list.env?.result.items.length === 3, shown(list));
  check("a broker that answers reads as reachable", alpha?.check === "reachable" && alpha.origin === "up", alpha);
  check("a broker that does not answer reads as unreachable and keeps its registration", beta?.check === "unreachable" && beta.origin === "manual" && beta.tlsRequired === true, beta);
  check("a discovered space is not checked and keeps its catalog name", gamma?.check === "not-checked" && gamma.origin === "catalog" && (gamma.catalog as { name?: string } | null)?.name === "Research Lab", gamma);
  check("the listing never dials a discovered space's broker", catalogDials === 0, { catalogDials });
  check("the listing writes nothing to the registry", JSON.stringify(registryFiles()) === JSON.stringify(before));
  const human = run(["space"], { FORCE_COLOR: "1" });
  // The rich report draws a state mark before each connection state.
  const text = human.stdout.replace(/\x1b\[[0-9;]*m/g, "").replace(/[●○] /g, "");
  check("the report names each space, its broker state and its origin", human.status === 0 && /alpha\s+reachable/.test(text) && /beta\s+unreachable/.test(text) && /not checked/.test(text) && /discovered as Research Lab/.test(text) && /registered/.test(text), shown(human));
  const plain = run(["space", "--plain"], { FORCE_COLOR: "1" });
  check("--plain writes the report with no ANSI", plain.status === 0 && !/\x1b\[/.test(plain.stdout) && plain.stdout.includes("unreachable"), shown(plain));
  const both = run(["space", "--json", "--plain"]);
  check("--json with --plain is a USAGE_INVALID refusal", both.status === 1 && JSON.parse(both.stdout || "{}").error?.code === "USAGE_INVALID", shown(both));
}

// ── use ──────────────────────────────────────────────────────────────────────────────────────────────
{
  const offline = json(["use", "beta"]);
  check("use selects a space whose broker does not answer", offline.status === 0 && offline.env?.outcome === "ok" && offline.env.result.current === "beta" && offline.env.result.previous === null && getCurrent() === "beta", shown(offline));
  const again = json(["use", "beta"]);
  check("selecting the selected space again is a no-op", again.status === 0 && again.env?.outcome === "no-op" && getCurrent() === "beta", shown(again));
  const swap = json(["use", "alpha"]);
  check("use reports the selection it replaced", swap.status === 0 && swap.env?.result.current === "alpha" && swap.env.result.previous === "beta" && swap.env.target?.space === "alpha", shown(swap));
  const unknown = json(["use", "nope"]);
  check("use refuses an unregistered name with TARGET_NOT_FOUND, naming the known spaces, and keeps the selection",
    unknown.status === 2 && unknown.env?.error?.code === "TARGET_NOT_FOUND" && (unknown.env.error.message as string).startsWith(`no space named "nope" is registered or prepared here; known spaces: alpha, beta`) && getCurrent() === "alpha", shown(unknown));
  const unknownHuman = run(["use", "nope"]);
  check("the refusal of an unregistered name has no target and no Mesh heading", unknown.env?.target === null && unknownHuman.stderr.startsWith("Request refused\n"), shown(unknownHuman));
  const two = json(["use", "alpha", "beta"]);
  check("use with two names is a usage error", two.status === 1 && two.env?.error?.code === "USAGE_INVALID", shown(two));
  const listed = json(["space"]);
  check("the listing marks the selected space", itemOf(listed.env, "alpha")?.current === true && itemOf(listed.env, "beta")?.current === false && listed.env?.result.current === "alpha", listed.env?.result);
  const human = run(["use", "beta"], { FORCE_COLOR: "1" });
  check("use names the space it selected and the one it replaced", human.status === 0 && /selected beta \(was alpha\)/.test(human.stdout.replace(/\x1b\[[0-9;]*m/g, "")), shown(human));
  // --clear removes the selection; nothing else could, so a folder's space could not apply again.
  const cleared = json(["use", "--clear"]);
  check("use --clear removes the selection and reports no folder space outside a project", cleared.status === 0 && cleared.env?.outcome === "ok" && cleared.env.result.current === null && cleared.env.result.previous === "beta" && cleared.env.result.folder === null && cleared.env.target === null && getCurrent() === undefined, shown(cleared));
  const clearedAgain = json(["use", "--clear"]);
  check("use --clear with nothing selected is a no-op", clearedAgain.status === 0 && clearedAgain.env?.outcome === "no-op" && clearedAgain.env.result.previous === null, shown(clearedAgain));
  const named = json(["use", "alpha", "--clear"]);
  check("use --clear with a name is a usage error and selects nothing", named.status === 1 && named.env?.error?.code === "USAGE_INVALID" && getCurrent() === undefined, shown(named));
  const clearText = run(["use", "beta"]) && run(["use", "--clear"]);
  check("its receipt says what was cleared", clearText.status === 0 && /cleared the selection \(was beta\)/.test(clearText.stdout), shown(clearText));
  const none = json(["use", "none"]);
  check("with nothing selected, an unknown name offers the JSON inventory only", none.status === 2 && none.env?.error?.remedy === "see the registered and prepared spaces with `cotal space --json`", shown(none));
  run(["use", "alpha"]);
  const kept = json(["use", "none"]);
  const keptPlain = run(["use", "none", "--plain"]);
  for (const [format, advice] of [["--json", kept.env?.error?.remedy ?? ""], ["--plain", keptPlain.stderr]] as const) {
    check(`with a selection, both suggested commands retain ${format}`, kept.status === 2 && keptPlain.status === 2 && advice.includes(`cotal space ${format}\``) && advice.includes(`cotal use --clear ${format}\``) && getCurrent() === "alpha", advice);
  }
  // A name of any length is looked up whole. The refusal repeats its first 128 characters and its
  // length, so one over-long argument does not print a line as long as itself.
  const long = "x".repeat(100_000);
  const longName = json(["use", long]);
  check("an over-long unregistered name is refused with its first 128 characters and its length, and the selection is kept",
    longName.status === 2 && longName.env?.error?.code === "TARGET_NOT_FOUND" && (longName.env.error.message as string).startsWith(`no space named "${"x".repeat(128)}… (100000 characters)" is registered or prepared here; known spaces: alpha, beta`) && longName.stdout.length < 1_000 && getCurrent() === "alpha", shown(longName));
  check("its target is what a short name's refusal carries", JSON.stringify(longName.env?.target) === JSON.stringify(kept.env?.target), { long: longName.env?.target, short: kept.env?.target });
  const longText = run(["use", long]);
  check("its text refusal repeats the name the same way", longText.status === 2 && longText.stderr.includes(`no space named "${"x".repeat(128)}… (100000 characters)"`) && longText.stderr.length < 1_000, shown(longText));
  const edge = json(["use", "w".repeat(128)]);
  check("control: a 128-character unregistered name is repeated whole", edge.status === 2 && (edge.env?.error?.message as string).startsWith(`no space named "${"w".repeat(128)}" is registered`) && !/characters\)/.test(edge.stdout), shown(edge));
  const pointer = join(cotalHome, "current-mesh");
  writeFileSync(pointer, "\n");
  const damaged = json(["use"]), damagedText = run(["use", "--plain"]);
  check("bare use refuses an empty selection file without removing it",
    damaged.status === 1 && damaged.env?.outcome === "refused" && damaged.env.error?.code === "SCHEMA_INVALID" && damaged.env.error.message.includes(`${pointer} is empty`) && damaged.env.error.remedy.includes("cotal use --clear") && readFileSync(pointer, "utf8") === "\n", shown(damaged));
  check("plain use identifies the damaged file and how to clear it",
    damagedText.status === 1 && damagedText.stderr.includes(`${pointer} is empty`) && damagedText.stderr.includes("`cotal use --clear`"), shown(damagedText));
  const repaired = json(["use", "--clear"]), empty = json(["use"]);
  check("clearing a damaged record restores a successful empty read",
    repaired.status === 0 && repaired.env?.outcome === "ok" && empty.status === 0 && empty.env?.outcome === "ok" && empty.env.result.current === null, shown(empty));
  writeFileSync(pointer, "\n", { mode: 0o600 });
  const replaced = json(["use", "alpha"]);
  check("selecting a known space again replaces the damaged record", replaced.status === 0 && getCurrent() === "alpha", shown(replaced));
}

// ── show ─────────────────────────────────────────────────────────────────────────────────────────────
{
  const bare = json(["space", "show"]);
  check("bare show outside a project shows the selected space", bare.status === 0 && bare.env?.result.kind === "space" && bare.env.result.space === "alpha" && bare.env.result.current === true && bare.env.target?.space === "alpha", shown(bare));
  const beta = json(["space", "show", "beta"]);
  check("show reports an unreachable broker and the recorded TLS requirement", beta.status === 0 && beta.env?.result.check === "unreachable" && beta.env.result.tlsRequired === true && beta.env.result.origin === "manual", shown(beta));
  const dialsBefore = catalogDials;
  const gamma = json(["space", "show", "gamma"]);
  check("show never dials a discovered space's broker", gamma.status === 0 && gamma.env?.result.check === "not-checked" && catalogDials === dialsBefore, { ...shown(gamma), catalogDials });
  check("show gives a discovered space's catalog details and its login", gamma.env?.result.catalog?.fetchedAt === ts && gamma.env.result.userAuth?.idp?.url === "https://idp.test" && gamma.env.result.userAuth.remote === true, gamma.env?.result);
  check("show leaves the credential path out", !gamma.stdout.includes("sentinel") && !gamma.stdout.includes("auth.test"), shown(gamma));
  const unknown = json(["space", "show", "nope"]);
  check("show refuses an unregistered name with TARGET_NOT_FOUND", unknown.status === 2 && unknown.env?.error?.code === "TARGET_NOT_FOUND", shown(unknown));
  const unknownHuman = run(["space", "show", "nope"]);
  check("the show refusal names the requested value without claiming a resolved mesh", unknown.env?.target?.requested === "nope" && unknown.env?.target?.space === undefined && unknownHuman.stderr.startsWith("Request refused\n") && !unknownHuman.stderr.includes("Mesh: nope"), shown(unknownHuman));
  const human = run(["space", "show", "beta"]);
  check("the show report offers the command that selects it", human.status === 0 && /tls:\s+required/.test(human.stdout) && /cotal use beta/.test(human.stdout), shown(human));
  clearCurrent();
  const noSelection = json(["space", "show"]);
  check("bare show with nothing selected refuses with TARGET_NOT_FOUND and names both remedies", noSelection.status === 2 && noSelection.env?.error?.code === "TARGET_NOT_FOUND" && /cotal space show <name>/.test(noSelection.env.error.remedy) && /cotal use <name>/.test(noSelection.env.error.remedy), shown(noSelection));
  const extra = run(["space", "show", "alpha", "beta"]);
  check("show with two names is a usage error with nothing on stdout", extra.status === 1 && extra.stdout === "" && /usage: cotal space show/.test(extra.stderr), shown(extra));
  const bogus = run(["space", "bogus"]);
  check("an unknown subcommand is a usage error with the help on stderr", bogus.status === 1 && bogus.stdout === "" && /no subcommand "bogus"/.test(bogus.stderr) && /^Usage$/m.test(bogus.stderr), shown(bogus));
}

// ── A selected space that is not up ──────────────────────────────────────────────────────────────────
{
  // An open mesh, so the refusal comes from its broker and not from a missing seed.
  recordMesh({ space: "delta", server: DEAD, root, mode: "open", origin: "manual", ts });
  setCurrent("delta");
  const who = json(["who"]);
  check("a command run with the selected space down refuses with TARGET_UNAVAILABLE naming its broker", who.status === 2 && who.env?.error?.code === "TARGET_UNAVAILABLE" && String(who.env.error.message).includes(DEAD), shown(who));
  check("the stopped space stays selected and registered", getCurrent() === "delta" && findMesh("delta") !== undefined);
  clearCurrent();
}

// ── A selection that names no registration ───────────────────────────────────────────────────────────
{
  setCurrent("ghost");
  const list = json(["space"]);
  check("a selection that names no registration is reported with a warning", list.status === 0 && list.env?.result.current === "ghost" && list.env.result.currentRecorded === false && list.env.warnings.some((w: { code: string; target: { space?: string } }) => w.code === "SELECTION_NOT_REGISTERED" && w.target.space === "ghost") && !list.env.result.items.some((s: { current: boolean }) => s.current), shown(list));
  const bare = json(["use"]);
  check("bare use reports it as selected and not registered", bare.status === 0 && bare.env?.result.current === "ghost" && bare.env.result.currentRecorded === false && bare.env.warnings[0]?.code === "SELECTION_NOT_REGISTERED", shown(bare));
  const human = run(["space"]);
  check("the report puts that warning on stderr", human.status === 0 && /selected space "ghost" is not registered/.test(human.stderr) && !/ghost/.test(human.stdout), shown(human));
  check("reading it changes nothing", getCurrent() === "ghost");
  const who = json(["who"]);
  check("a command run under that selection refuses with TARGET_NOT_FOUND rather than reaching another space", who.status === 2 && who.env?.error?.code === "TARGET_NOT_FOUND" && /the selected space "ghost" is not registered here/.test(who.env.error.message), shown(who));
  const whoHuman = run(["who"]);
  check("the refusal tells how to select a registered space", whoHuman.status === 2 && whoHuman.stdout === "" && /select one with `cotal use <name>`/.test(whoHuman.stderr), shown(whoHuman));
}

// ── An over-long space name ──────────────────────────────────────────────────────────────────────────
{
  // The name is looked up whole; what a refusal or report repeats is its first 128 characters and its
  // length.
  const previous = getCurrent();
  const long = "x".repeat(100_000);
  const shownLong = `"${"x".repeat(128)}… (100000 characters)"`;
  const short = json(["who", "--space", "nope"]);
  const who = json(["who", "--space", long]);
  check("an over-long --space is refused with its first 128 characters and its length", who.status === 2 && who.env?.error?.code === "TARGET_NOT_FOUND" && who.env.error.message === `no space named ${shownLong} is registered here` && who.stdout.length < 1_000, shown(who));
  check("its target is what a short name's refusal carries", JSON.stringify(who.env?.target) === JSON.stringify(short.env?.target), { long: who.env?.target, short: short.env?.target });
  const whoText = run(["who", "--space", long]);
  check("its text refusal repeats the name the same way", whoText.status === 2 && whoText.stderr.includes(`no space named ${shownLong}`) && whoText.stderr.length < 1_000, shown(whoText));
  const status = json(["status", "--space", long]);
  check("status --space reports the over-long name the same way", status.status === 0 && status.env?.result?.selected?.message === `no space named ${shownLong} is registered here` && status.stdout.length < 10_000, shown(status));
  const statusText = run(["status", "--space", long]);
  check("its text report has no line longer than a few hundred characters", statusText.status === 0 && statusText.stdout.includes(`no space named ${shownLong}`) && Math.max(...statusText.stdout.split("\n").map((l) => l.length)) < 400, shown(statusText));
  setCurrent(long);
  const selected = json(["who"]);
  check("a selected over-long name is repeated the same way", selected.status === 2 && selected.env?.error?.message === `the selected space ${shownLong} is not registered here`, shown(selected));
  check("the selection itself is kept whole", getCurrent() === long);
  const edge = json(["who", "--space", "w".repeat(128)]);
  check("control: a 128-character --space is repeated whole", edge.status === 2 && edge.env?.error?.message === `no space named "${"w".repeat(128)}" is registered here`, shown(edge));
  if (previous === undefined) clearCurrent();
  else setCurrent(previous);
}

// ── help and completion ──────────────────────────────────────────────────────────────────────────────
{
  const help = run(["help", "space"]);
  check("help space lists show with folder-first precedence and structured output", help.status === 0 && /^\s+show\s/m.test(help.stdout) && /show this folder's space if it has one,\s+otherwise the selected space/.test(help.stdout) && /Structured output: json, plain/.test(help.stdout), shown(help));
  const showHelp = run(["help", "space", "show"]);
  check("help space show gives folder-first and explicit-name examples", showHelp.status === 0 &&
    /cotal space show\s+show this folder's space,\s+or the selected one/.test(showHelp.stdout) &&
    /cotal space show alpha\s+show alpha from any folder/.test(showHelp.stdout), shown(showHelp));
  const useHelp = run(["help", "use"]);
  check("help use gives the optional space and --clear", useHelp.status === 0 && /cotal use \[<space> \| --clear\]/.test(useHelp.stdout), shown(useHelp));
  const subs = run(["__complete", "space", ""]);
  check("completion offers show after space", /^show(\t|$)/m.test(subs.stdout), shown(subs));
  const names = run(["__complete", "space", "show", ""]);
  check("completion offers the registered names after space show", ["alpha", "beta", "gamma"].every((n) => new RegExp(`^${n}$`, "m").test(names.stdout)), shown(names));
  const useNames = run(["__complete", "use", ""]);
  check("completion offers the registered names after use", ["alpha", "beta", "gamma"].every((n) => new RegExp(`^${n}$`, "m").test(useNames.stdout)), shown(useNames));
  // A --space value is a space on every command, so each completes the names use does.
  // `down` is a template literal, which the sandbox guard reads as text: this completes it and never runs it.
  for (const words of [["status"], ["watch"], [`down`], ["team", "boot"], ["config", "set"]]) {
    const spaces = run(["__complete", ...words, "--space", ""]);
    check(`completion offers the registered names for ${words.join(" ")} --space`, ["alpha", "beta", "gamma"].every((n) => new RegExp(`^${n}$`, "m").test(spaces.stdout)) && !/^--/m.test(spaces.stdout) && spaces.stdout.trimEnd().endsWith(":nofiles"), shown(spaces));
  }
  const modes = run(["__complete", "space", "add", "x", "--mode", ""]);
  check("completion offers auth, open and user after space add --mode", ["auth", "open", "user"].every((n) => new RegExp(`^${n}$`, "m").test(modes.stdout)), shown(modes));
  for (const flag of ["--root", "--file"]) {
    const files = run(["__complete", "space", "add", "x", flag, ""]);
    check(`space add ${flag} completes from the shell's file names`, files.stdout.trimEnd() === ":default", shown(files));
  }
}

// The create hint must name a usable folder even when the selection already matches this root.
{
  const selected = getCurrent();
  const project = hintProject;
  const other = mkdtempSync(join(home, "hint-other-"));
  const child = mkdtempSync(join(project, "child-"));
  const localHint = /cotal space create <name>\s+Prepare another local space in this folder/;
  const otherHint = /cotal space create <name> --root <dir>\s+Prepare another local space in another folder/;
  const prepared = run(["space", "create", "hint-live"], {}, project);
  check("rig: create prepares the hint's project root", prepared.status === 0, shown(prepared));
  try {
    const withUnknown = json(["space", "show", "hint-live", "--wibble"], project);
    const corrected = json(["space", "show", "hint-live"], project);
    check("space show tells you to drop an unknown option and keep the supplied name",
      withUnknown.status === 1 && withUnknown.stderr === "" && withUnknown.env?.outcome === "refused"
      && withUnknown.env.error?.code === "USAGE_INVALID" && withUnknown.env.error.message === "Unknown option '--wibble'"
      && withUnknown.env.error.remedy === "drop the unknown option"
      && corrected.status === 0 && corrected.stderr === "" && corrected.env?.result?.space === "hint-live",
      { withUnknown: shown(withUnknown), corrected: shown(corrected) });
    setCurrent("alpha");
    const selection = json(["use"], project);
    check("bare use reports the prepared folder without changing the selection or target", selection.status === 0 && selection.env?.target?.space === "alpha" && selection.env?.result?.current === "alpha" && selection.env?.result?.folder === "hint-live" && getCurrent() === "alpha", shown(selection));
    const selectionPlain = run(["use", "--plain"], {}, project);
    check("plain use names the selection and how to reach the prepared folder's space", selectionPlain.status === 0 && /^selected: alpha$/m.test(selectionPlain.stdout) && selectionPlain.stdout.includes("--space hint-live") && selectionPlain.stdout.includes("cotal use --clear"), shown(selectionPlain));
    const cleared = json(["use", "--clear"], project);
    const clearedAgain = json(["use", "--clear"], project);
    check("use --clear reports the prepared folder's space with and without a selection to remove",
      cleared.status === 0 && cleared.env?.outcome === "ok" && cleared.env.result.current === null && cleared.env.result.previous === "alpha" && cleared.env.result.folder === "hint-live"
      && clearedAgain.status === 0 && clearedAgain.env?.outcome === "no-op" && clearedAgain.env.result.current === null && clearedAgain.env.result.previous === null && clearedAgain.env.result.folder === "hint-live"
      && getCurrent() === undefined, { cleared: shown(cleared), clearedAgain: shown(clearedAgain) });
    setCurrent("alpha");
    const preparedDir = join(cotalHome, "prepared");
    renameSync(preparedDir, `${preparedDir}.saved`);
    try {
      writeFileSync(preparedDir, "not a directory\n");
      const refusedUse = run(["use", "beta", "--plain"], {}, project);
      check("use refuses when the prepared records path is a file", refusedUse.status === 1 && refusedUse.stderr.includes("SCHEMA_INVALID") && refusedUse.stderr.includes(`${preparedDir} is a file, not a folder`), shown(refusedUse));
      const retainedUse = json(["use"]);
      check("a refused selection leaves the previous space selected", retainedUse.status === 0 && retainedUse.env?.result?.current === "alpha", shown(retainedUse));
    } finally {
      rmSync(preparedDir, { force: true });
      renameSync(`${preparedDir}.saved`, preparedDir);
    }
    const bare = run(["space", "show", "--plain"], {}, project);
    check("bare show prefers the prepared project space to the selection", bare.status === 0 && /^space:\s+hint-live$/m.test(bare.stdout), shown(bare));
    const named = run(["space", "show", "alpha", "--plain"], {}, project);
    check("a name lets show inspect another space from a prepared project", named.status === 0 && /^ *space:\s+alpha \(selected\)$/m.test(named.stdout), shown(named));
    const list = run(["space", "--plain"], {}, project);
    check("a prepared root offers another folder, not creation in this folder", list.status === 0 && otherHint.test(list.stdout) && !localHint.test(list.stdout), shown(list));
    const started = run(["up", "--no-manager", "--server", `nats://127.0.0.1:${await freePort()}`], {}, project);
    check("rig: the prepared space starts a real local broker", started.status === 0, shown(started));
    if (started.status === 0) checkRunningSpaceSearchPermission("hint-live", project);
    const used = run(["use", "hint-live"]);
    check("rig: this root's space is also selected", used.status === 0, shown(used));
    for (const args of [["space", "--plain"], ["space"]]) {
      const live = run(args, {}, project);
      check(`a running selected root offers --root with ${args.join(" ")}`, live.status === 0 && otherHint.test(live.stdout) && !localHint.test(live.stdout), shown(live));
    }
    const refused = run(["space", "create", "hint-second", "--json"], {}, project);
    check("creation in the occupied root still refuses CONFLICT", refused.status === 2 && JSON.parse(refused.stdout || "{}").error?.code === "CONFLICT", shown(refused));
    const explicit = run(["space", "create", "hint-second", "--root", other], {}, project);
    check("following the suggested --root command prepares another space", explicit.status === 0, shown(explicit));
    const stopped = run(["down", "--yes"], {}, project);
    check("rig: the local stack stops", stopped.status === 0, shown(stopped));
    const after = run(["space", "--plain"], {}, project);
    check("a stopped root still offers another folder", after.status === 0 && otherHint.test(after.stdout) && !localHint.test(after.stdout), shown(after));
    const forgot = run(["space", "forget", "hint-live"], {}, project);
    check("rig: the stopped space is forgotten but keeps its trust", forgot.status === 0, shown(forgot));
    const retained = run(["space", "--plain"], {}, project);
    check("retained trust still prevents suggesting creation in the occupied root", retained.status === 0 && otherHint.test(retained.stdout) && !localHint.test(retained.stdout), shown(retained));
    const free = run(["space", "--plain"], {}, child);
    check("a free child folder still offers creation in this folder", free.status === 0 && localHint.test(free.stdout) && !otherHint.test(free.stdout), shown(free));
    const created = run(["space", "create", "hint-third"], {}, child);
    check("following the free-folder hint prepares a local space", created.status === 0, shown(created));
  } finally {
    run(["down", "--yes"], {}, project);
    for (const name of ["hint-live", "hint-second", "hint-third"]) run(["space", "forget", name]);
    if (selected === undefined) clearCurrent();
    else setCurrent(selected);
  }
}

// ── A record that does not parse ─────────────────────────────────────────────────────────────────────
{
  const file = join(meshesDir(), "space.6f6d656761.json");
  writeFileSync(file, '{"space":"omega"');
  const selected = getCurrent();
  const elsewhere = mkdtempSync(join(home, "create-root-"));
  for (const args of [["space"], ["space", "show", "alpha"], ["use"], ["use", "alpha"], ["space", "forget", "alpha"], ["space", "create", "zeta", "--root", elsewhere], ["send", "-c", "general", "hi"], ["persona"]]) {
    const r = json(args);
    check(`cotal ${args.join(" ")} refuses a record that does not parse with SCHEMA_INVALID, exit 1, naming the file`, r.status === 1 && r.env?.outcome === "refused" && r.env.error?.code === "SCHEMA_INVALID" && String(r.env.error.message).includes(file), shown(r));
  }
  const cleared = json(["use", "--clear"]);
  check("JSON clear removes the selection and reports the unreadable folder scope separately", cleared.status === 0 && cleared.env?.outcome === "ok" &&
    cleared.env.completeness === "partial" && cleared.env.result.current === null && cleared.env.result.previous === selected && cleared.env.result.folder === null &&
    cleared.env.warnings.some((w: { code: string; target: { file?: string } }) => w.code === "SCHEMA_INVALID" && w.target.file === file) && getCurrent() === undefined, shown(cleared));
  if (selected !== undefined) setCurrent(selected);
  const plain = run(["use", "--clear", "--plain"]);
  check("plain clear also succeeds and reports the unreadable record", plain.status === 0 && plain.stdout.includes("cleared the selection") &&
    plain.stderr.includes(file) && getCurrent() === undefined && readFileSync(file, "utf8") === '{"space":"omega"', shown(plain));
  if (selected !== undefined) setCurrent(selected);
  rmSync(file);
  check("those refusals changed nothing: alpha is registered, the selection is kept and zeta was not prepared", findMesh("alpha") !== undefined && getCurrent() === selected && !existsSync(join(elsewhere, ".cotal")), { selected, now: getCurrent() });
}

// The broker and the listener would keep the process alive past the last cell.
await killAndAwaitExit(broker);
catalogServer.close();
finish();
