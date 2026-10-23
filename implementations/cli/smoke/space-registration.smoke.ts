/**
 * `cotal space add`, `cotal space create` and `cotal space forget`, driven through the built binary
 * in a sandboxed `COTAL_HOME`. An open broker and one that refuses a bare connect answer for real,
 * another address has nothing listening, and a stand-in exchange answers for a user-auth bundle's
 * pins. Each refusal is checked for its code and exit, and for writing nothing; each success for the
 * record it writes and for leaving the selection as it was. An open space must be one the broker
 * serves, so the open broker serves the names that are added and refuses one it does not. On Linux, a space started as a controller
 * stack is written as its stack journal and instance records, with nothing launched. A prepared space
 * is then started with `cotal up` in its root and stopped again, after an `up` naming a runtime with
 * no installed provider, and one naming a missing channels file, have refused and left the root as
 * it was. Create and a later `up` write the
 * default persona when the root has none, and leave an edited one byte-identical. A registration
 * whose root is not an absolute path is refused at the space claim on the controller route and on the
 * legacy route, each with its reason, its remedy and exit 2, and the registration is kept. An `up` in
 * a folder other local accounts can write refuses before it writes anything, naming the folder and its
 * parent with one remedy.
 *
 * Needs `nats-server` on PATH.
 *
 * Run: pnpm smoke:space-registration
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SMOKE_BROKER_TOKEN, assertSmokeSandboxDown, createSuite, freePort, listenOn, recordSmokeSandbox, teardownOnSignal } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "cotal-space-registration-"));
// Set before the workspace is imported: it reads COTAL_HOME on each call.
process.env.COTAL_HOME = join(home, ".cotal");
const { MANAGER_PIDFILE, cacheLocalProcess, canonicalLocalProcessPath, clearCurrent, extensionsManifestPath, findMesh, findPreparedSpace, getCurrent, meshesDir, recordMesh, removeMesh, saveExtensionsManifest, setCurrent } = await import("@cotal-ai/workspace");
const { userExchangeIssuer } = await import("../src/commands/meshes-add.js");
const { processServiceHost, requireProcessIdentity, serviceInstanceStore } = await import("../src/lib/service-instances.js");
const { stackJournalPath, writeStackJournal } = await import("../src/lib/stack-journal.js");

const { check, finish } = createSuite();
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));

const brokerPort = await freePort();
const LIVE = `nats://127.0.0.1:${brokerPort}`;
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(brokerPort), "-js", "-sd", mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN))], { stdio: "ignore" });
teardownOnSignal(broker);
const authPort = await freePort();
const AUTH_LIVE = `nats://127.0.0.1:${authPort}`;
const authBroker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(authPort), "--user", "u", "--pass", "p", "-sd", mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN))], { stdio: "ignore" });
teardownOnSignal(authBroker);
for (const b of [broker, authBroker])
  b.on("error", () => {
    console.error("needs nats-server on PATH");
    process.exit(1);
  });
const DEAD = `nats://127.0.0.1:${await freePort()}`;

// A stand-in exchange: /health answers with the issuer the space's pins name, /jwks with a key.
let exchangeIssuer = userExchangeIssuer("hosted");
const exchange = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") return void res.end(JSON.stringify({ ok: true, issuer: exchangeIssuer }));
  if (req.url === "/jwks") return void res.end(JSON.stringify({ keys: [{ kid: "k1", kty: "RSA" }] }));
  res.statusCode = 404;
  res.end("{}");
});
const exchangeUrl = `http://127.0.0.1:${await listenOn(exchange, await freePort())}`;

const standIns: ReturnType<typeof spawn>[] = [];
process.on("exit", () => {
  broker.kill("SIGKILL");
  authBroker.kill("SIGKILL");
  for (const p of standIns) p.kill("SIGKILL");
  exchange.close();
  rmSync(home, { recursive: true, force: true });
});

// Asynchronous, so the stand-in exchange in this process can answer while the binary runs.
const runEnv = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: process.env.COTAL_HOME!, COTAL_SKIP_CONNECTOR_SEED: "1" };
const run = (args: string[], extraEnv: Record<string, string> = {}, cwd = home) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...runEnv, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
const json = async (args: string[], cwd = home) => {
  const r = await run([...args, "--json"], {}, cwd);
  let env: Record<string, any> | undefined;
  try {
    env = JSON.parse(r.stdout);
  } catch {
    env = undefined;
  }
  return { ...r, env };
};
const shown = (r: { status: number | null; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 700), stderr: r.stderr.slice(0, 400) });
const registryFiles = () => (existsSync(meshesDir()) ? readdirSync(meshesDir()).sort().map((f) => `${f}:${readFileSync(join(meshesDir(), f), "utf8")}`) : []);
const refused = (r: Awaited<ReturnType<typeof json>>, exit: number, code: string) => r.status === exit && r.env?.outcome === "refused" && r.env.error?.code === code;
/** A project folder with a `.cotal`, as a space root. */
const projectRoot = (name: string) => {
  const dir = join(home, name);
  mkdirSync(join(dir, ".cotal"), { recursive: true });
  return dir;
};

for (let i = 0; i < 50; i++) {
  const { isReachable } = await import("@cotal-ai/core");
  if ((await isReachable(LIVE)) && (await isReachable(AUTH_LIVE))) break;
  await new Promise((r) => setTimeout(r, 100));
}
// An open space must be one the broker serves, so the open broker serves the names added below.
const SERVED = ["open1", "open3", "open4", "open5"];
{
  const { setupSpaceStreams } = await import("@cotal-ai/core");
  for (const space of SERVED) await setupSpaceStreams({ servers: LIVE, space });
}

const root = projectRoot("proj");
const ISSUER = "https://idp.example.test/";
const bundle = (over: Record<string, unknown> = {}) => ({
  space: "hosted",
  server: AUTH_LIVE,
  tlsRequired: false,
  userAuth: { provider: "cotal", idp: { url: ISSUER, issuer: ISSUER, audience: "cotal-mesh" }, endpoints: { url: exchangeUrl } },
  sentinelCreds: "-----BEGIN NATS USER JWT-----\nsentinel-material\n------END NATS USER JWT------",
  ...over,
});
// A bundle that would be added, so a usage refusal that let it through would show.
const file = join(home, "hosted.json");
writeFileSync(file, JSON.stringify(bundle()));
const userRoot = projectRoot("hosted-root");
recordMesh({ space: "keep", server: DEAD, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
setCurrent("keep");

// ── Usage refusals, before anything is read or dialed ─────────────────────────────────────────────────
{
  const before = registryFiles();
  check("add with no name and no bundle is USAGE_INVALID, exit 1", refused(await json(["space", "add", "--server", LIVE]), 1, "USAGE_INVALID"));
  const noServer = await json(["space", "add", "x", "--root", root]);
  check("add with no --server is USAGE_INVALID with an example remedy", refused(noServer, 1, "USAGE_INVALID") && /--server nats:\/\//.test(noServer.env?.error?.remedy ?? ""), shown(noServer));
  check("--file with --from is USAGE_INVALID", refused(await json(["space", "add", "--file", file, "--from", "https://x.test", "--root", userRoot]), 1, "USAGE_INVALID"));
  check("--file with --mode open is USAGE_INVALID", refused(await json(["space", "add", "--file", file, "--mode", "open", "--root", userRoot]), 1, "USAGE_INVALID"));
  check("--mode user with no bundle is USAGE_INVALID", refused(await json(["space", "add", "x", "--server", LIVE, "--mode", "user", "--root", root]), 1, "USAGE_INVALID"));
  check("a malformed --server is USAGE_INVALID", refused(await json(["space", "add", "x", "--server", "not a url", "--root", root]), 1, "USAGE_INVALID"));
  check("--mode with another value is USAGE_INVALID", refused(await json(["space", "add", "x", "--server", LIVE, "--mode", "token", "--root", root]), 1, "USAGE_INVALID"));
  check("an add flag on another form is USAGE_INVALID", refused(await json(["space", "--server", LIVE]), 1, "USAGE_INVALID") && refused(await json(["space", "forget", "keep", "--force"]), 1, "USAGE_INVALID"));
  const fromScript = await json(["space", "add", "--from", "https://hosted.test"]);
  check("--from without a terminal is USAGE_INVALID and names --file", refused(fromScript, 1, "USAGE_INVALID") && /--file/.test(fromScript.env?.error?.remedy ?? ""), shown(fromScript));
  check("--from over http is USAGE_INVALID", refused(await json(["space", "add", "--from", "http://hosted.test"]), 1, "USAGE_INVALID"));
  check("no usage refusal wrote anything", JSON.stringify(registryFiles()) === JSON.stringify(before));
}

// ── Adding a space from --server ───────────────────────────────────────────────────────────────────────
{
  const added = await json(["space", "add", "open1", "--server", LIVE, "--root", root]);
  const r = added.env?.result;
  check("an open broker is added: ok, verified, not a replacement", added.status === 0 && added.env?.outcome === "ok" && r?.kind === "space-added" && r.verified === true && r.replaced === false, shown(added));
  check("its record is the space show detail: open, manual, reachable", r?.space?.space === "open1" && r.space.mode === "open" && r.space.origin === "manual" && r.space.check === "reachable" && r.space.root === root, r?.space);
  check("the registry holds it", findMesh("open1")?.server === LIVE && findMesh("open1")?.origin === "manual");
  check("the selection is unchanged", getCurrent() === "keep" && r?.space?.current === false, getCurrent());

  const again = await json(["space", "add", "open1", "--server", LIVE, "--root", root]);
  check("adding a registered name is CONFLICT, exit 2, naming forget and --force", refused(again, 2, "CONFLICT") && /space forget open1/.test(again.env?.error?.remedy ?? "") && /--force/.test(again.env?.error?.remedy ?? ""), shown(again));
  const replaced = await json(["space", "add", "open1", "--server", DEAD, "--root", root, "--force"]);
  check("--force replaces a registration added by hand, unchecked", replaced.status === 0 && replaced.env?.result.replaced === true && replaced.env.result.verified === false && replaced.env.result.space.check === "not-checked" && findMesh("open1")?.server === DEAD, shown(replaced));

  recordMesh({ space: "started", server: LIVE, root, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const overUpBare = await json(["space", "add", "started", "--server", LIVE, "--root", root]);
  check("adding a space this machine started is CONFLICT and does not offer --force", refused(overUpBare, 2, "CONFLICT") && (overUpBare.env?.error?.message ?? "").includes("a space this machine started") && !/--force/.test(overUpBare.env?.error?.remedy ?? ""), shown(overUpBare));
  const overUp = await json(["space", "add", "started", "--server", LIVE, "--root", root, "--force"]);
  check("--force does not replace a space this machine started", refused(overUp, 2, "CONFLICT") && findMesh("started")?.origin === "up", shown(overUp));

  const before = registryFiles();
  const dead = await json(["space", "add", "dead1", "--server", DEAD, "--root", root]);
  check("a broker that does not answer is TARGET_UNAVAILABLE, exit 2", refused(dead, 2, "TARGET_UNAVAILABLE"), shown(dead));
  const unserved = await json(["space", "add", "open", "--server", LIVE, "--mode", "open", "--root", root]);
  check("an open name the broker does not serve is TARGET_NOT_FOUND, exit 2, naming the spaces it serves",
    refused(unserved, 2, "TARGET_NOT_FOUND") && unserved.env?.error?.message === `the broker at ${LIVE} serves no space named "open"; it serves ${SERVED.map((space) => `"${space}"`).join(", ")}` && /--force/.test(unserved.env?.error?.remedy ?? ""), shown(unserved));
  const wantsAuth = await json(["space", "add", "o2", "--server", AUTH_LIVE, "--mode", "open", "--root", root]);
  check("an open claim on a broker that requires auth is CONFLICT", refused(wantsAuth, 2, "CONFLICT"), shown(wantsAuth));
  check("its refusal and the copy cost it names are one line", (wantsAuth.env?.error?.message ?? "").includes("signing seed") && !(wantsAuth.env?.error?.message ?? "").includes("\n"), wantsAuth.env?.error?.message);
  const noTrust = await json(["space", "add", "a2", "--server", AUTH_LIVE, "--mode", "auth", "--root", root]);
  check("an auth claim with no trust under --root is DEPENDENCY_UNAVAILABLE", refused(noTrust, 2, "DEPENDENCY_UNAVAILABLE"), shown(noTrust));
  const plaintext = await json(["space", "add", "far", "--server", "nats://broker.example.com:4222", "--root", root]);
  check("a hostname with no TLS is UNSUPPORTED: credentials would cross the network unprotected", refused(plaintext, 2, "UNSUPPORTED"), shown(plaintext));
  const noRoot = await json(["space", "add", "r2", "--server", LIVE, "--root", join(home, "missing")]);
  check("a --root that is not a directory is USAGE_INVALID", refused(noRoot, 1, "USAGE_INVALID"), shown(noRoot));
  const fromHome = await json(["space", "add", "r3", "--server", LIVE]);
  check("with no --root, the home folder is no project: USAGE_INVALID naming --root", refused(fromHome, 1, "USAGE_INVALID") && /--root <dir> is required/.test(fromHome.env?.error?.message ?? ""), shown(fromHome));
  const fromHomeText = await run(["space", "add", "r3", "--server", LIVE, "--mode", "open"]);
  check("its human refusal is one line and a remedy that says what to pass, without the command's help",
    fromHomeText.status === 1 && /--root <dir> is required/.test(fromHomeText.stderr) && /any folder will do/.test(fromHomeText.stderr) && !/Usage/.test(fromHomeText.stderr), shown(fromHomeText));
  const link = `${home}-link`;
  symlinkSync(home, link, "junction");
  const viaLink = await run(["space", "add", "r4", "--server", LIVE, "--json"], { HOME: link, USERPROFILE: link, COTAL_HOME: join(link, ".cotal") }, link);
  rmSync(link, { force: true });
  check("nor is a home reached through a symlink", viaLink.status === 1 && /"code":"USAGE_INVALID"/.test(viaLink.stdout) && /--root <dir> is required/.test(viaLink.stdout), shown(viaLink));
  check("no refused add wrote anything", JSON.stringify(registryFiles()) === JSON.stringify(before));

  const forced = await json(["space", "add", "dead1", "--server", DEAD, "--root", root, "--force"]);
  check("--force adds a space whose broker is down, marked not checked", forced.status === 0 && forced.env?.result.verified === false && findMesh("dead1") !== undefined, shown(forced));

  clearCurrent();
  const unselected = await json(["space", "add", "open3", "--server", LIVE, "--root", root]);
  check("with nothing selected, an added space is not selected either", unselected.status === 0 && getCurrent() === undefined, { current: getCurrent() });
  setCurrent("keep");

  const human = await run(["space", "add", "open4", "--server", LIVE, "--root", root], { FORCE_COLOR: "1" });
  const text = human.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  check("the human report says it was added and how to select it", human.status === 0 && /✓ added open4/.test(text) && /broker answered and serves this space/.test(text) && /select it with `cotal use open4`/.test(text), shown(human));
  const plain = await run(["space", "add", "open5", "--server", LIVE, "--root", root, "--plain"], { FORCE_COLOR: "1" });
  check("--plain writes it with no ANSI", plain.status === 0 && !/\x1b\[/.test(plain.stdout) && /added open5/.test(plain.stdout), shown(plain));
}

// ── Adding a user-auth space from a bundle ─────────────────────────────────────────────────────────────
{

  const before = registryFiles();
  const wrongName = await json(["space", "add", "other", "--file", file, "--root", userRoot]);
  check("a bundle for another space is CONFLICT", refused(wrongName, 2, "CONFLICT") && /"hosted"/.test(wrongName.env?.error?.message ?? ""), shown(wrongName));
  writeFileSync(join(home, "broken.json"), "{ not json");
  check("a bundle that is not JSON is SCHEMA_INVALID, exit 1", refused(await json(["space", "add", "--file", join(home, "broken.json"), "--root", userRoot]), 1, "SCHEMA_INVALID"));
  check("a missing bundle file is USAGE_INVALID", refused(await json(["space", "add", "--file", join(home, "absent.json"), "--root", userRoot]), 1, "USAGE_INVALID"));
  exchangeIssuer = "https://someone-else.test/";
  const foreign = await json(["space", "add", "--file", file, "--root", userRoot]);
  check("an exchange that answers as another issuer is CONFLICT", refused(foreign, 2, "CONFLICT"), shown(foreign));
  exchangeIssuer = userExchangeIssuer("hosted");
  writeFileSync(join(home, "open-broker.json"), JSON.stringify(bundle({ server: LIVE })));
  const openBroker = await json(["space", "add", "--file", join(home, "open-broker.json"), "--root", userRoot]);
  check("a bundle whose broker accepts a bare connect is CONFLICT", refused(openBroker, 2, "CONFLICT"), shown(openBroker));
  check("no refused bundle wrote anything", JSON.stringify(registryFiles()) === JSON.stringify(before) && !existsSync(join(userRoot, ".cotal", "user-auth")));

  const added = await json(["space", "add", "--file", file, "--root", userRoot]);
  const entry = findMesh("hosted");
  check("a bundle adds the space it names: user mode, remote, verified", added.status === 0 && added.env?.result.space.space === "hosted" && added.env.result.space.mode === "user" && added.env.result.verified === true && entry?.userAuth?.remote === true, shown(added));
  const sentinel = entry?.userAuth?.sentinelCredsPath;
  check("its sentinel credential lands in a private file, not in the record", !!sentinel && existsSync(sentinel) && (process.platform === "win32" || (statSync(sentinel).mode & 0o077) === 0) && !JSON.stringify(registryFiles()).includes("sentinel-material"), sentinel);
  check("the selection is unchanged", getCurrent() === "keep");
  check("the result carries the pins, not the sentinel", added.env?.result?.space?.userAuth?.idp.issuer === ISSUER && !added.stdout.includes("sentinel-material"), added.env?.result?.space?.userAuth);
}

// ── Forgetting a registration ──────────────────────────────────────────────────────────────────────────
{
  const unknown = await json(["space", "forget", "never"]);
  check("forgetting an unknown name is TARGET_NOT_FOUND, exit 2", refused(unknown, 2, "TARGET_NOT_FOUND") && /cotal space/.test(unknown.env?.error?.remedy ?? ""), shown(unknown));
  check("forget takes exactly one name", refused(await json(["space", "forget"]), 1, "USAGE_INVALID") && refused(await json(["space", "forget", "a", "b"]), 1, "USAGE_INVALID"));

  recordMesh({ space: "listed", server: LIVE, root, mode: "user", origin: "catalog", catalogOwner: "acct-1", userAuth: { provider: "cotal", idp: { url: "https://idp.test", issuer: "https://idp.test", audience: "cotal" }, remote: true, endpoints: { url: "https://auth.test" }, sentinelCredsPath: join(root, "sentinel.creds") }, ts: new Date(0).toISOString() });
  const catalog = await json(["space", "forget", "listed"]);
  check("a discovered space is not forgotten: CONFLICT, and its record stays", refused(catalog, 2, "CONFLICT") && findMesh("listed") !== undefined && /cotal sync/.test(catalog.env?.error?.remedy ?? ""), shown(catalog));

  const ownedRoot = projectRoot("owned");
  const standIn = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], { stdio: "ignore" });
  standIns.push(standIn);
  writeFileSync(join(ownedRoot, ".cotal", "nats.pid"), String(standIn.pid), { mode: 0o600 });
  recordMesh({ space: "running", server: LIVE, root: ownedRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const live = await json(["space", "forget", "running"]);
  check("a space this machine is running is LIFECYCLE_BLOCKED, naming cotal down", refused(live, 2, "LIFECYCLE_BLOCKED") && /cotal down/.test(live.env?.error?.remedy ?? "") && findMesh("running") !== undefined, shown(live));

  // `cotal up` runs a space as a controller stack: service instances with no pidfile. The stack
  // journal and instance records are written here as a stack leaves them, and nothing is launched. A
  // member pinned to this process runs; one pinned to an exited stand-in is gone.
  if (process.platform === "linux") {
    const exited = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], { stdio: "ignore" });
    standIns.push(exited);
    const gonePid = requireProcessIdentity(exited.pid!);
    await new Promise((done) => { exited.once("exit", done); exited.kill("SIGKILL"); });
    const ts = new Date().toISOString();
    /** One member's instance record. A stopped one carries the generic process-exit receipt. */
    const member = (space: string, definition: string, pinned: { pid: number; token: string }, stopped: boolean): string => {
      const id = randomUUID(), requestId = randomUUID();
      serviceInstanceStore(space).commit(id, undefined, {
        schemaVersion: 1, instanceId: id, definition, definitionRevision: `rev-${definition}`, space, host: processServiceHost(),
        requestId, launchRequestId: requestId, state: stopped ? "stopped" : "running", launcher: requireProcessIdentity(process.pid), process: pinned,
        readiness: stopped ? "not-checked" : "process-running", supervisor: "none", foreground: false, createdAt: ts, updatedAt: ts,
        ...(stopped ? { processStop: { kind: "process-exit" as const, requestId, process: pinned, signal: "SIGTERM" as const, observedAt: ts } } : {}),
      });
      return id;
    };
    /** A registered space this machine started, whose root holds its stack journal. */
    const stack = (space: string, mode: "open" | "auth", rows: { broker?: string; delivery?: string }, state: "started" | "stopped"): string => {
      const stackRoot = realpathSync.native(projectRoot(space));
      const row = (role: "broker" | "auth" | "delivery" | "manager", instanceId: string | undefined) =>
        ({ role, definition: `stack-${role}`, instanceId: instanceId ?? null, state: instanceId ? state : "not-attempted" as const });
      writeStackJournal(stackRoot, undefined, {
        schemaVersion: 1, kind: "cotal-stack-controller", root: stackRoot, space, server: LIVE, mode,
        members: [row("broker", rows.broker), row("auth", undefined), row("delivery", rows.delivery), row("manager", undefined)],
        operation: { id: randomUUID(), kind: state === "started" ? "up" : "down", phase: "completed", recordedAt: ts, withAgents: false }, updatedAt: ts,
      });
      recordMesh({ space, server: LIVE, root: stackRoot, mode, origin: "up", ts });
      return stackRoot;
    };

    const runningRoot = stack("stackrun", "open", { broker: member("stackrun", "stack-broker", requireProcessIdentity(process.pid), false) }, "started");
    const before = registryFiles(), selected = getCurrent(), journal = readFileSync(stackJournalPath(runningRoot), "utf8");
    const running = await json(["space", "forget", "stackrun"]);
    check("a space whose controller stack still runs is LIFECYCLE_BLOCKED, naming the member and cotal down",
      refused(running, 2, "LIFECYCLE_BLOCKED") && /stack-broker/.test(running.env?.error?.message ?? "") && /cotal down/.test(running.env?.error?.remedy ?? ""), shown(running));
    check("...and it writes nothing: the registration, the selection and the stack journal stay",
      JSON.stringify(registryFiles()) === JSON.stringify(before) && getCurrent() === selected && readFileSync(stackJournalPath(runningRoot), "utf8") === journal, shown(running));

    stack("stackgone", "open", { broker: member("stackgone", "stack-broker", gonePid, false) }, "started");
    const unsettled = await json(["space", "forget", "stackgone"]);
    const warned = (unsettled.env?.warnings ?? []).filter((w: { code: string }) => w.code === "STACK_MEMBER_UNSETTLED");
    check("a member proven gone with no stop receipt does not block forget, and the output warns",
      unsettled.status === 0 && unsettled.env?.result.kind === "space-forgotten" && findMesh("stackgone") === undefined &&
        warned.length === 1 && /stack-broker/.test(warned[0].message) && /never stopped cleanly/.test(warned[0].message), shown(unsettled));

    // Only a delivery member is recorded: its generic stop leaves the process-exit receipt this suite
    // can write, where the broker's and the manager's receipts carry native evidence.
    stack("stackdone", "auth", { delivery: member("stackdone", "stack-delivery", gonePid, true) }, "stopped");
    const settled = await json(["space", "forget", "stackdone"]);
    check("a space whose stack stopped with its receipts is forgotten",
      settled.status === 0 && settled.env?.result.kind === "space-forgotten" && settled.env.result.origin === "up" && findMesh("stackdone") === undefined &&
        settled.env.warnings.length === 0, shown(settled));
  } else console.log("  - controller stack forget cells skipped: service records need Linux machine and boot identity");

  const stopped = await json(["space", "forget", "started"]);
  check("a stopped space this machine started is forgotten", stopped.status === 0 && stopped.env?.result.kind === "space-forgotten" && stopped.env.result.origin === "up" && findMesh("started") === undefined, shown(stopped));
  const manual = await json(["space", "forget", "open1"]);
  check("a space added by hand is forgotten; the selection stays", manual.status === 0 && manual.env?.result.selectionCleared === false && findMesh("open1") === undefined && getCurrent() === "keep", shown(manual));
  check("forgetting keeps the root's files", existsSync(join(root, ".cotal")));
  const human = await run(["space", "forget", "keep"]);
  check("forgetting the selected space clears the selection and says so", human.status === 0 && getCurrent() === undefined && /forgot keep/.test(human.stdout) && /no space is selected now/.test(human.stdout), shown(human));
}

// ── A root other local accounts can write ──────────────────────────────────────────────────────────────
// `space create` refuses such a root, so `up` refuses it too, before anything is written: a stack it
// started there could not be stopped from it. World write refuses on every host, and one refusal names
// the folder and its parent. The folder has its own `.cotal`, so a `.cotal` in an ancestor such as the
// temporary directory does not become its root.
{
  const exposed = realpathSync(mkdtempSync(join(tmpdir(), "cotal-space-registration-exposed-")));
  const parent = join(exposed, "shared"), folder = join(parent, "proj");
  mkdirSync(join(folder, ".cotal"), { recursive: true });
  chmodSync(parent, 0o777);
  chmodSync(folder, 0o777);
  const before = registryFiles();
  const up = await json(["up", "--open", "--server", LIVE], folder);
  check("up in a folder other accounts can write is PERMISSION_DENIED, exit 2, naming it and its parent with one remedy, and writes nothing",
    refused(up, 2, "PERMISSION_DENIED") && (up.env?.error?.message ?? "").includes(`${folder} and ${parent} are writable by every local account`) &&
      up.env?.error?.remedy === `chmod o-w ${folder} ${parent}` && readdirSync(join(folder, ".cotal")).length === 0 && JSON.stringify(registryFiles()) === JSON.stringify(before), shown(up));
  rmSync(exposed, { recursive: true, force: true });
}

// ── Preparing a space with create, then starting it with up ────────────────────────────────────────────
{
  const before = registryFiles();
  const fresh = join(home, "fresh");
  mkdirSync(fresh);
  const created = await json(["space", "create", "demo"], fresh);
  const r = created.env?.result;
  check("create prepares the space in this folder and makes its .cotal: ok, nothing registered", created.status === 0 && created.env?.outcome === "ok" && r?.kind === "space-created" && r.space === "demo" && r.root === fresh && existsSync(join(fresh, ".cotal")) && findPreparedSpace("demo")?.root === fresh && JSON.stringify(registryFiles()) === JSON.stringify(before), shown(created));
  check("create leaves the selection as it is", getCurrent() === undefined && r?.current === false, getCurrent());
  const personaFile = join(fresh, ".cotal", "agents", "default.md");
  check("create writes the default persona into the root's catalog and lists it with the prepared record",
    existsSync(personaFile) && r?.written?.some((w: { what: string; path: string }) => w.what === "default persona" && w.path.endsWith(join(".cotal", "agents", "default.md"))) &&
      r.written.some((w: { what: string }) => w.what === "prepared space"), r?.written);
  // Recorded once create has been checked for making its .cotal, so whatever starts in it is stopped
  // with the suite.
  const sandbox = recordSmokeSandbox({ root: fresh, cotalHome: process.env.COTAL_HOME!, xdgConfigHome: runEnv.XDG_CONFIG_HOME });
  // Before its first up the root has no controller stack, and `down --yes` there gives the answer a
  // bare `down` gives instead of refusing --yes.
  assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: fresh, env: runEnv });
  const unstarted = await run(["down", "--yes"], {}, fresh);
  check("down --yes on the prepared root that never started says its stack is not running and exits 0",
    unstarted.status === 0 && /is not running/.test(unstarted.stdout), shown(unstarted));
  // It never ran a manager either, so --with-agents has no agent to stop and answers the same.
  assertSmokeSandboxDown(sandbox, ["down", "--with-agents", "--yes"], { cwd: fresh, env: runEnv });
  const unstartedReap = await run(["down", "--with-agents", "--yes"], {}, fresh);
  check("down --with-agents --yes on the prepared root that never started says its stack is not running and exits 0",
    unstartedReap.status === 0 && /is not running/.test(unstartedReap.stdout), shown(unstartedReap));

  const spare = join(home, "spare");
  mkdirSync(spare);
  const again = await json(["space", "create", "demo", "--root", spare]);
  check("a prepared name is CONFLICT, exit 2, naming its root", refused(again, 2, "CONFLICT") && again.env?.error?.message.includes(fresh), shown(again));
  check("a registered name is CONFLICT", refused(await json(["space", "create", "listed", "--root", spare]), 2, "CONFLICT"));
  check("a folder already prepared for a space is CONFLICT", refused(await json(["space", "create", "other"], fresh), 2, "CONFLICT"));
  check("a folder a registration names as its root is CONFLICT", refused(await json(["space", "create", "other", "--root", root]), 2, "CONFLICT"));
  const { createBrokerAuth, createSpaceAccountAuth } = await import("@cotal-ai/core");
  const { authDir, saveBrokerAuth, saveSpaceAccountAuth } = await import("@cotal-ai/workspace");
  const accountRoot = projectRoot("account-root");
  const brokerAuth = await createBrokerAuth("held");
  saveBrokerAuth(authDir(accountRoot), brokerAuth);
  saveSpaceAccountAuth(authDir(accountRoot), await createSpaceAccountAuth(brokerAuth, "held"));
  check("a folder whose .cotal holds another space's account is CONFLICT", refused(await json(["space", "create", "other", "--root", accountRoot]), 2, "CONFLICT"));
  const heldElsewhere = await json(["space", "add", "alias", "--server", AUTH_LIVE, "--root", accountRoot]);
  check("an auth broker whose --root holds another space's trust is refused naming that space first",
    refused(heldElsewhere, 2, "DEPENDENCY_UNAVAILABLE") && (heldElsewhere.env?.error?.message ?? "").startsWith(`the broker at ${AUTH_LIVE} requires auth, and`) && (heldElsewhere.env?.error?.message ?? "").includes('holds the trust for "held", not "alias"'), shown(heldElsewhere));
  check("the home folder is CONFLICT", refused(await json(["space", "create", "other", "--root", home]), 2, "CONFLICT"));
  check("a --root that is not a directory is USAGE_INVALID", refused(await json(["space", "create", "other", "--root", join(home, "absent")]), 1, "USAGE_INVALID"));
  check("create takes exactly one name", refused(await json(["space", "create"], spare), 1, "USAGE_INVALID") && refused(await json(["space", "create", "a", "b"], spare), 1, "USAGE_INVALID"));
  check("an add flag other than --root on create is USAGE_INVALID", refused(await json(["space", "create", "other", "--server", LIVE], spare), 1, "USAGE_INVALID"));
  check("no refused create prepared anything or made a .cotal", findPreparedSpace("other") === undefined && findPreparedSpace("a") === undefined && !existsSync(join(spare, ".cotal")) && !existsSync(join(home, "absent")));
  const add = await json(["space", "add", "demo", "--server", LIVE, "--root", root]);
  check("adding a prepared name is CONFLICT, naming cotal up", refused(add, 2, "CONFLICT") && /cotal up/.test(add.env?.error?.remedy ?? "") && findMesh("demo") === undefined, shown(add));

  const list = await json(["space"]);
  check("space lists it apart from the registrations", list.env?.result.prepared.some((p: { space: string; root: string }) => p.space === "demo" && p.root === fresh) && !list.env.result.items.some((s: { space: string }) => s.space === "demo"), list.env?.result);
  const show = await json(["space", "show", "demo"]);
  check("space show shows it as prepared", show.status === 0 && show.env?.result.kind === "prepared-space" && show.env.result.root === fresh, shown(show));
  const named = await json(["who", "--space", "demo"]);
  check("a command naming it with --space is TARGET_UNAVAILABLE, naming its root", refused(named, 2, "TARGET_UNAVAILABLE") && /prepared but not started/.test(named.env?.error?.message ?? "") && named.env?.error?.remedy?.includes(fresh), shown(named));
  const inRoot = await json(["who"], fresh);
  check("a command run in its root with nothing selected is TARGET_UNAVAILABLE", refused(inRoot, 2, "TARGET_UNAVAILABLE") && /prepared but not started/.test(inRoot.env?.error?.message ?? ""), shown(inRoot));
  // The refusal's target names the space and its root, from the resolver and from the connect path.
  const endpoints = await json(["endpoints", "--space", "demo"]);
  check("each of those refusals names the space and its root under target",
    [named, inRoot, endpoints].every((r) => refused(r, 2, "TARGET_UNAVAILABLE") && JSON.stringify(r.env?.target) === JSON.stringify({ space: "demo", root: fresh })), [named, inRoot, endpoints].map((r) => r.env?.target ?? shown(r)));
  const selected = await json(["use", "demo"]);
  check("use selects it and names its root", selected.status === 0 && getCurrent() === "demo" && selected.env?.result.preparedRoot === fresh && selected.env.result.currentRecorded === false, shown(selected));
  // The default report says it under Brokers; the recorded-meshes diagnostics say it again under --verbose.
  const status = await run(["status", "--plain"]);
  check("status says the selected space is prepared, not started", status.status === 0 && /Selected space 'demo' is prepared, not started/.test(status.stdout), shown(status));
  const verbose = await run(["status", "--plain", "--verbose"]);
  check("status --verbose notes the selected space is prepared, not started", verbose.status === 0 && /current mesh "demo" is prepared, not started/.test(verbose.stdout), shown(verbose));
  const listed = await json(["space"]);
  check("a selected prepared space is not warned about as missing", listed.status === 0 && listed.env?.warnings.length === 0 && listed.env.result.prepared[0]?.current === true, listed.env?.warnings);
  const human = await run(["space", "--plain"]);
  check("the listing shows it under its own heading", /Prepared, not started/.test(human.stdout) && /demo \(selected\)/.test(human.stdout), shown(human));
  const target = await json(["who"]);
  check("a command that targets it is TARGET_UNAVAILABLE, naming cotal up in its root", refused(target, 2, "TARGET_UNAVAILABLE") && /cotal up/.test(target.env?.error?.remedy ?? "") && target.env?.error?.remedy?.includes(fresh), shown(target));

  // Under a root that hosts other spaces, so `up` would make this folder a root of its own.
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  const server = `nats://127.0.0.1:${await freePort()}`;
  const away = await json(["up", "--detach", "--open", "--no-manager", "--server", server, "--space", "demo"], elsewhere);
  check("up --space for it from another folder refuses, naming its root, and makes nothing there", refused(away, 2, "TARGET_UNAVAILABLE") && away.env?.error?.message.includes(`prepared in ${fresh}`) && !existsSync(join(elsewhere, ".cotal")), shown(away));
  const otherName = await json(["up", "--detach", "--open", "--no-manager", "--server", server, "--space", "other"], fresh);
  check("up --space for another space in its root refuses", refused(otherName, 2, "CONFLICT") && /root of "demo"/.test(otherName.env?.error?.message ?? "") && findMesh("other") === undefined, shown(otherName));
  check("that refusal names the command that runs the folder's own space",
    (otherName.env?.error?.remedy ?? "").includes("cotal up --space demo") && !(otherName.env?.error?.remedy ?? "").includes("drop"), shown(otherName));
  // The address is the suite's own broker, so without the check this up would still refuse before
  // its broker started, and the cell would go red on the code and the files it wrote.
  const cotalFiles = () => (readdirSync(join(fresh, ".cotal"), { recursive: true }) as string[]).sort().map((p) => {
    const stat = statSync(join(fresh, ".cotal", p));
    return `${p}:${stat.isDirectory() ? "dir" : stat.size}:${stat.mtimeMs}`;
  }).join(",");
  const beforeRuntime = { files: cotalFiles(), registry: registryFiles() };
  const noProvider = await json(["up", "--open", "--runtime", "tmux", "--server", LIVE], fresh);
  check("up with a runtime no installed extension provides is DEPENDENCY_UNAVAILABLE, exit 2, naming cotal ext add, and leaves the root and registrations unchanged",
    refused(noProvider, 2, "DEPENDENCY_UNAVAILABLE") && noProvider.env?.target?.runtime === "tmux" && (noProvider.env?.error?.remedy ?? "").includes("cotal ext add @cotal-ai/tmux") &&
      cotalFiles() === beforeRuntime.files && JSON.stringify(registryFiles()) === JSON.stringify(beforeRuntime.registry) && findPreparedSpace("demo")?.root === fresh, shown(noProvider));
  const missingChannels = join(fresh, "missing-channels.json");
  const noChannels = await json(["up", "--open", "--channels", missingChannels, "--server", server], fresh);
  check("up with a missing --channels file is USAGE_INVALID, exit 1, naming the file, and leaves the root and registrations unchanged",
    refused(noChannels, 1, "USAGE_INVALID") && (noChannels.env?.error?.message ?? "").includes(missingChannels) &&
      cotalFiles() === beforeRuntime.files && JSON.stringify(registryFiles()) === JSON.stringify(beforeRuntime.registry) && findPreparedSpace("demo")?.root === fresh, shown(noChannels));

  const up = await run(["up", "--detach", "--open", "--no-manager", "--server", server], {}, fresh);
  const started = findMesh("demo");
  check("up in its root starts it under its name, and the prepared record goes", up.status === 0 && started?.root === fresh && started.server === server && started.origin === "up" && findPreparedSpace("demo") === undefined, shown(up));
  check("the selection still names it", getCurrent() === "demo", getCurrent());
  const reads = await json(["space", "show", "demo"]);
  check("space show now reports its broker answering", reads.env?.result.kind === "space" && reads.env.result.check === "reachable", reads.env?.result);
  // Another up of the running space refreshes it: it writes back a default persona that went
  // missing, and leaves one you edited byte-identical.
  rmSync(personaFile);
  const reseeded = await json(["up", "--detach", "--open", "--no-manager", "--server", server], fresh);
  check("up of the running space writes back a missing default persona and lists the write",
    reseeded.status === 0 && reseeded.env?.outcome === "ok" && existsSync(personaFile) && reseeded.env.result.written?.some((w: { what: string }) => w.what === "default persona"), shown(reseeded));
  const editedPersona = `${readFileSync(personaFile, "utf8")}\nYou review pull requests.\n`;
  writeFileSync(personaFile, editedPersona);
  const reup = await json(["up", "--detach", "--open", "--no-manager", "--server", server], fresh);
  check("another up leaves an edited default persona byte-identical and is a no-op",
    reup.status === 0 && reup.env?.outcome === "no-op" && readFileSync(personaFile, "utf8") === editedPersona && reup.env.result.written?.length === 0, shown(reup));
  // A bare up names no space, address or mode. The folder's stack journal and its registration name
  // the space, so it runs the same stack again. --no-manager keeps the stack as this suite started it.
  const bare = await json(["up", "--detach", "--no-manager"], fresh);
  check("a second bare up in the same root runs the same space and is a no-op",
    bare.status === 0 && bare.env?.outcome === "no-op" && bare.env.result.space === "demo" && bare.env.result.server === server && findMesh("demo")?.root === fresh, shown(bare));
  // Two locally started registrations for one root give a bare up no single space to run.
  recordMesh({ space: "twin", server, root: fresh, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const twin = await json(["up", "--detach", "--no-manager"], fresh);
  removeMesh("twin");
  const twinMessage = twin.env?.error?.message ?? "";
  check("a bare up in a root registered to two spaces refuses, naming both, and picks neither",
    refused(twin, 2, "CONFLICT") && /"demo"/.test(twinMessage) && /"twin"/.test(twinMessage) && (twin.env?.error?.remedy ?? "").includes("--space"), shown(twin));
  // A prepared root starts as a controller stack, whose whole-stack down takes --yes outside a terminal.
  // Without it the refusal is one line and its remedy, not the command's help.
  assertSmokeSandboxDown(sandbox, ["down"], { cwd: fresh, env: runEnv });
  const unconfirmed = await run(["down"], {}, fresh);
  check("a bare down of the running stack outside a terminal refuses for --yes, with its remedy and without the command help",
    unconfirmed.status === 1 && /requires --yes/.test(unconfirmed.stderr) && /cotal down --yes/.test(unconfirmed.stderr) && !/Usage|Options/.test(unconfirmed.stderr) && findMesh("demo")?.root === fresh, shown(unconfirmed));
  assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: fresh, env: runEnv });
  const down = await run(["down", "--yes"], {}, fresh);
  check("down stops it", down.status === 0, shown(down));
  // The stopped stack keeps its recorded address and broker inputs. Another --server, or a --host it
  // did not record, refuses before anything is written, naming the recorded value and the bare up
  // that starts the stack there.
  const recordedRoot = realpathSync(fresh), journalBefore = readFileSync(stackJournalPath(fresh), "utf8");
  const moved = await json(["up", "--detach", "--no-manager", "--server", `nats://127.0.0.1:${await freePort()}`], fresh);
  check("up --server naming another address is CONFLICT, exit 2, naming the recorded address and bare cotal up from the root",
    refused(moved, 2, "CONFLICT") && (moved.env?.error?.message ?? "").includes(`recorded at ${server}`) &&
      moved.env?.error?.remedy === `run bare cotal up from ${recordedRoot} to start it at ${server}`, shown(moved));
  const bound = await json(["up", "--detach", "--no-manager", "--host", "127.0.0.1", "--server", server], fresh);
  check("up --host naming an unrecorded bind host is CONFLICT, exit 2, naming it, its recorded value and bare cotal up",
    refused(bound, 2, "CONFLICT") && (bound.env?.error?.message ?? "").includes("--host 127.0.0.1 (recorded: none)") &&
      (bound.env?.error?.remedy ?? "").includes(`run bare cotal up from ${recordedRoot}`), shown(bound));
  check("neither refusal changed the stack journal", readFileSync(stackJournalPath(fresh), "utf8") === journalBefore);
  // A second bare down of the stopped stack stops nothing: it needs no --yes, writes nothing, and
  // every presentation shows the same no-op.
  const journalBytes = () => readFileSync(stackJournalPath(fresh), "utf8");
  const stoppedJournal = journalBytes();
  assertSmokeSandboxDown(sandbox, ["down"], { cwd: fresh, env: runEnv });
  const secondDown = await run(["down"], {}, fresh);
  check("a second bare down without --yes says the stack is not running, names cotal up, and exits 0",
    secondDown.status === 0 && /is not running/.test(secondDown.stdout) && /cotal up/.test(secondDown.stdout) && !/--yes/.test(secondDown.stderr), shown(secondDown));
  assertSmokeSandboxDown(sandbox, ["down", "--json"], { cwd: fresh, env: runEnv });
  const secondDownJson = await json(["down"], fresh);
  check("--json reports it as a no-op of the stopped stack",
    secondDownJson.status === 0 && secondDownJson.env?.outcome === "no-op" && secondDownJson.env.result?.kind === "stack-not-running" && secondDownJson.env.result.space === "demo", shown(secondDownJson));
  assertSmokeSandboxDown(sandbox, ["down", "--dry-run", "--json"], { cwd: fresh, env: runEnv });
  const stoppedPreview = await json(["down", "--dry-run"], fresh);
  check("--dry-run of the stopped stack shows the same no-op",
    stoppedPreview.status === 0 && stoppedPreview.env?.outcome === "no-op" && stoppedPreview.env.result?.kind === "stack-not-running", shown(stoppedPreview));
  assertSmokeSandboxDown(sandbox, ["down", "--plain"], { cwd: fresh, env: runEnv });
  const plainAgain = await run(["down", "--plain"], {}, fresh);
  check("--plain of the stopped stack shows the same no-op", plainAgain.status === 0 && /is not running/.test(plainAgain.stdout), shown(plainAgain));
  check("none of them wrote: the stack journal is byte-identical", journalBytes() === stoppedJournal);
  // A manager another space recorded under the same root still runs, so the stopped stack's second
  // down does not call the root's stack stopped. A process of this suite stands in for it, and the
  // down leaves it, its record and the journal as they were.
  const otherManager = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  standIns.push(otherManager);
  const otherRecord = canonicalLocalProcessPath(MANAGER_PIDFILE, { root: fresh, space: "other" });
  writeFileSync(otherRecord, String(otherManager.pid), { mode: 0o600 });
  const otherPath = join(".cotal", basename(otherRecord));
  const otherLine = `manager at ${otherPath} (pid ${otherManager.pid})`;
  // The text refusal shows the evidence without --json.
  assertSmokeSandboxDown(sandbox, ["down"], { cwd: fresh, env: runEnv });
  const otherText = await run(["down"], {}, fresh);
  check("the text refusal names the other space's manager record and its pid",
    otherText.status === 2 && otherText.stderr.includes(otherLine) && otherManager.exitCode === null && existsSync(otherRecord), shown(otherText));
  // Following the printed next step: each pid it names sits at the path it names, and is the live
  // process. Only the next step says "pid <n> at <path>".
  const remedyChecks = [...otherText.stderr.matchAll(/pid (\d+) at (\S+?)[,;]/g)].map(([, pid, path]) => ({ pid, path }));
  check("following the remedy reaches the recorded path, which holds the live pid it names",
    remedyChecks.length === 1 && remedyChecks.every(({ pid, path }) => existsSync(join(fresh, path)) && readFileSync(join(fresh, path), "utf8").trim() === pid && pid === String(otherManager.pid)) &&
      otherManager.exitCode === null && otherManager.signalCode === null, { stderr: otherText.stderr.slice(0, 700), remedyChecks });
  assertSmokeSandboxDown(sandbox, ["down", "--json"], { cwd: fresh, env: runEnv });
  const otherSpace = await json(["down"], fresh);
  const recorded: string[] = otherSpace.env?.target?.processes ?? [];
  check("a live manager recorded for another space under the root keeps a second bare down from a no-op, names the record and its pid in the remedy, and stays running with its record",
    refused(otherSpace, 2, "LIFECYCLE_BLOCKED") && (otherSpace.env?.error?.remedy ?? "").includes(`pid ${otherManager.pid} at ${otherPath}`) &&
      recorded.includes(otherLine) &&
      otherManager.exitCode === null && otherManager.signalCode === null && existsSync(otherRecord) && journalBytes() === stoppedJournal, shown(otherSpace));
  if (otherManager.exitCode === null && otherManager.signalCode === null) await new Promise((done) => { otherManager.once("exit", done); otherManager.kill("SIGKILL"); });
  rmSync(otherRecord);
  // An installed extension records its processes at `.cotal/daemon/worker.pid` and
  // `.cotal/worker.record`. A separate root holds both for a live process of this suite, and this
  // root links to them, first through `.cotal/daemon`, then at `.cotal/worker.record`. The stopped
  // stack's records are read without following a link before it is called stopped, so each down
  // refuses at the link and reads nothing behind it; the process, its records and the journal stay.
  const priorXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = runEnv.XDG_CONFIG_HOME;
  saveExtensionsManifest({ extensions: [{ pkg: "@example/workers", version: "0.0.0", spec: "@example/workers", commands: [], localProcesses: [
    cacheLocalProcess({ kind: "local-process", name: "nested-worker", label: "nested worker", pidFile: "daemon/worker.pid" }),
    cacheLocalProcess({ kind: "local-process", name: "record-worker", label: "record worker", pidFile: "worker.record" }),
  ] }] });
  const workersManifest = extensionsManifestPath();
  if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = priorXdg;
  const separate = join(home, "separate");
  mkdirSync(join(separate, ".cotal", "daemon"), { recursive: true });
  const outsideWorker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  standIns.push(outsideWorker);
  for (const record of [join("daemon", "worker.pid"), "worker.record"]) writeFileSync(join(separate, ".cotal", record), String(outsideWorker.pid), { mode: 0o600 });
  /** Bare `down --json` with this root's `.cotal/<at>` linked to the separate root's, and whether it
   *  refused naming only that link, with no pid read behind it and nothing changed. */
  const downThroughLink = async (at: string, name: string) => {
    const link = join(fresh, ".cotal", at), path = join(".cotal", at);
    symlinkSync(join(separate, ".cotal", at), link);
    assertSmokeSandboxDown(sandbox, ["down", "--json"], { cwd: fresh, env: runEnv });
    const linked = await json(["down"], fresh);
    const refusedAtLink = refused(linked, 2, "LIFECYCLE_BLOCKED") && (linked.env?.target?.processes ?? []).join("\n") === `${name} at ${path} (link, not followed)` &&
      (linked.env?.error?.remedy ?? "").includes(path) && !`${linked.stdout}${linked.stderr}`.includes(`pid ${outsideWorker.pid}`) &&
      outsideWorker.exitCode === null && outsideWorker.signalCode === null && lstatSync(link).isSymbolicLink() && journalBytes() === stoppedJournal;
    unlinkSync(link);
    return { refusedAtLink, shown: shown(linked) };
  };
  const throughDir = await downThroughLink("daemon", "nested-worker");
  check("a stopped stack whose .cotal/daemon links to another root's live record refuses at the link, names it, and reads nothing behind it", throughDir.refusedAtLink, throughDir.shown);
  const throughLeaf = await downThroughLink("worker.record", "record-worker");
  check("a stopped stack whose .cotal/worker.record links to another root's live record refuses at the link, names it, and reads nothing behind it", throughLeaf.refusedAtLink, throughLeaf.shown);
  if (outsideWorker.exitCode === null && outsideWorker.signalCode === null) await new Promise((done) => { outsideWorker.once("exit", done); outsideWorker.kill("SIGKILL"); });
  rmSync(workersManifest);
  rmSync(separate, { recursive: true });

  // A prepared space whose folder was deleted cannot start there: every surface says the folder is gone.
  const goneRoot = join(home, "gone");
  mkdirSync(goneRoot);
  await json(["space", "create", "gone"], goneRoot);
  rmSync(goneRoot, { recursive: true });
  const goneTarget = await json(["who", "--space", "gone"]);
  check("a prepared space whose folder was deleted is TARGET_UNAVAILABLE, saying the folder is gone and naming space forget",
    refused(goneTarget, 2, "TARGET_UNAVAILABLE") && (goneTarget.env?.error?.message ?? "").includes(`${goneRoot}, which no longer exists`) && (goneTarget.env?.error?.remedy ?? "").includes("cotal space forget gone"), shown(goneTarget));
  const gonePersona = await json(["persona", "--space", "gone"]);
  check("persona names the deleted folder and space forget",
    refused(gonePersona, 2, "TARGET_UNAVAILABLE") && (gonePersona.env?.error?.message ?? "").includes(`${goneRoot}, which no longer exists`) && (gonePersona.env?.error?.remedy ?? "").includes("cotal space forget gone"), shown(gonePersona));
  const goneForgot = await run(["space", "forget", "gone"]);
  check("forget says the folder no longer exists", goneForgot.status === 0 && goneForgot.stdout.includes(`its folder ${goneRoot} no longer exists`) && findPreparedSpace("gone") === undefined, shown(goneForgot));

  const later = join(home, "later");
  mkdirSync(later);
  await json(["space", "create", "later"], later);
  const forgot = await json(["space", "forget", "later"]);
  check("a prepared space is forgotten; the .cotal create made stays", forgot.status === 0 && forgot.env?.result.origin === "prepared" && forgot.env.result.server === null && findPreparedSpace("later") === undefined && existsSync(join(later, ".cotal")), shown(forgot));
  const laterPersona = join(later, ".cotal", "agents", "default.md");
  const kept = `${readFileSync(laterPersona, "utf8")}\nYou triage issues.\n`;
  writeFileSync(laterPersona, kept);
  const recreated = await json(["space", "create", "later"], later);
  check("a second create in the same root leaves an edited default persona byte-identical and lists only the prepared record",
    recreated.status === 0 && readFileSync(laterPersona, "utf8") === kept && recreated.env?.result.written?.map((w: { what: string }) => w.what).join() === "prepared space", shown(recreated));
}

// ── A space claim that refuses, on the controller and legacy routes ────────────────────────────────────
{
  // Recorded as ".", the root resolves the registration to itself and takes the controller route.
  // Recorded as "../elsewhere", it does not, so the root takes the legacy route, which has no --json
  // receipt. Each route gets its own root: a refused controller attempt leaves its stack journal.
  const server = `nats://127.0.0.1:${await freePort()}`;
  for (const [space, recorded, route] of [["relhere", ".", "controller"], ["relaway", "../elsewhere", "legacy"]] as const) {
    const claimRoot = projectRoot(`claim-${route}`);
    recordMesh({ space, server, root: recorded, mode: "auth", origin: "up", ts: new Date(0).toISOString() });
    const before = registryFiles();
    const args = ["up", "--detach", "--no-manager", "--space", space, "--server", server];
    if (route === "controller") {
      const claimed = await json(args, claimRoot);
      check("on the controller route, a registration with a relative root is refused at the claim: CONFLICT, exit 2, naming the root and `cotal meshes rm`, with the registration kept",
        refused(claimed, 2, "CONFLICT") && (claimed.env?.error?.message ?? "").includes(`registered to ${recorded}, which is not an absolute path`) &&
          (claimed.env?.error?.remedy ?? "").includes(`cotal meshes rm ${space}`) && JSON.stringify(registryFiles()) === JSON.stringify(before), shown(claimed));
    } else {
      const claimed = await run(args, {}, claimRoot);
      const text = claimed.stderr.replace(/\x1b\[[0-9;]*m/g, ""), lines = text.split("\n").map((line) => line.trim());
      check("on the legacy route, the same refusal: refused CONFLICT, exit 2, naming the root, with `cotal meshes rm` as the next step and the registration kept",
        claimed.status === 2 && text.includes("Request refused") && /Outcome:\s+refused/.test(text) && /Code:\s+CONFLICT/.test(text) && text.includes(`registered to ${recorded}, which is not an absolute path`) &&
          lines.some((line) => line.startsWith(`drop that record with \`cotal meshes rm ${space}\``)) && JSON.stringify(registryFiles()) === JSON.stringify(before), shown(claimed));
    }
    removeMesh(space);
  }
}

// ── An explicit --store-dir, checked before anything is written ────────────────────────────────────────
// A regular file, or a path under one, is a usage refusal that names it, on up and on backup restore.
// A directory other local accounts can write in the store's existing path refuses as a project root
// does; world write refuses on every host. None of them writes a stack journal.
{
  const storeRoot = projectRoot("store-checks");
  const file = join(home, "store-file");
  writeFileSync(file, "x");
  const exposed = realpathSync(mkdtempSync(join(tmpdir(), "cotal-space-registration-store-")));
  // Called through the module so this section adds no import to the file's shared import line.
  (await import("node:fs")).chmodSync(exposed, 0o777);
  const asFile = await json(["up", "--server", DEAD, "--store-dir", file], storeRoot);
  check("up --store-dir naming a regular file is USAGE_INVALID, exit 1, naming it as not a directory",
    refused(asFile, 1, "USAGE_INVALID") && (asFile.env?.error?.message ?? "").includes(`the --store-dir path ${file} is not a directory`), shown(asFile));
  const underFile = await json(["up", "--server", DEAD, "--store-dir", join(file, "sub")], storeRoot);
  check("up --store-dir under a regular file names that file",
    refused(underFile, 1, "USAGE_INVALID") && (underFile.env?.error?.message ?? "").includes(`${file}, in the --store-dir path ${join(file, "sub")}, is not a directory`), shown(underFile));
  const restoreFile = await json(["backup", "restore", join(home, "no-backup"), "--store-dir", file], storeRoot);
  check("backup restore --store-dir naming a regular file is the same USAGE_INVALID, exit 1",
    refused(restoreFile, 1, "USAGE_INVALID") && (restoreFile.env?.error?.message ?? "").includes(`the --store-dir path ${file} is not a directory`), shown(restoreFile));
  const writable = await json(["up", "--server", DEAD, "--store-dir", join(exposed, "store")], storeRoot);
  check("up --store-dir in a directory every account can write is PERMISSION_DENIED, exit 2, naming it with its chmod",
    refused(writable, 2, "PERMISSION_DENIED") && (writable.env?.error?.message ?? "").includes(`${exposed} is writable by every local account`) &&
      writable.env?.error?.remedy === `chmod o-w ${exposed}` && !existsSync(join(exposed, "store")), shown(writable));
  check("no store refusal wrote a stack journal", !existsSync(stackJournalPath(storeRoot)));
  rmSync(exposed, { recursive: true, force: true });
}

finish();
process.exit(process.exitCode ?? 0);
