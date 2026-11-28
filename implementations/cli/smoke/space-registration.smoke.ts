/**
 * `cotal space add`, `cotal space create` and `cotal space forget`, driven through the built binary
 * in a sandboxed `COTAL_HOME`. An open broker and one that refuses a bare connect answer for real,
 * another address has nothing listening, and a stand-in exchange answers for a user-auth bundle's
 * pins. Each refusal is checked for its code and exit, and for writing nothing; each success for the
 * record it writes and for leaving the selection as it was. An open space must be one the broker
 * serves, so the open broker serves the names that are added and refuses one it does not. A forget
 * removes the space's per-space preferences and the chat sessions the terminal app remembered for it,
 * counting them, refuses on a preferences file it cannot read,
 * and is partial when it cannot remove them, naming the chmod first when other accounts can write
 * their folder. A forget of a running space names `cotal down`: on a legacy root it says that down
 * drops the record, and for a controller stack, whose down keeps it prepared, it names forget again.
 * `meshes rm` of that stack says the same and names `space forget`.
 * When two registry files are damaged, an exact-name forget removes only its own record and warns
 * about the other one it leaves behind, instead of refusing with the other's remedy, while the
 * listing still refuses while any damaged record remains.
 * `space add` refuses a name `space create` refuses. A refusal for a name no space has, from
 * create, show or forget, carries it as `target.requested` with no `Mesh:` heading, while a
 * registration an earlier release made under such a name is still headed with it.
 * On Linux, a space started as a controller
 * stack is written as its stack journal and instance records, with nothing launched. A stack journal
 * whose members this home has no record of, with a live manager, reports missing member
 * records: create, down and status name that fact, and so do ps and who with
 * another space selected. A folder path with a control
 * character or a bidirectional formatting mark is refused by create and up before anything is written. A stopped stack whose broker
 * bind does not serve its recorded address refuses up and is started again with the --host it names.
 * A space name over 64 characters is refused by create, `up --space`, `space add` and `meshes add`
 * before anything is written, and `up` of a longer name an earlier release prepared refuses before its
 * journal is written.
 * A service saved for a space survives its forget, which names it, and the next space of that name,
 * in another folder, names it on its up, until the remove the forget named forgets it.
 * A prepared space
 * is then started with `cotal up` in its root and stopped again, after an `up` naming a runtime with
 * no installed provider, ones naming a missing or invalid channels file, and one with an invalid
 * default channels file, have refused and left the root as it was; a default channels file that
 * begins with a UTF-8 byte-order mark seeds as the JSON after it, and one saved as UTF-16 is refused
 * by its encoding. That `up` reads its `--channels` seed once, from a FIFO written once, and seeds
 * the channel from it. A `channel set` or `remove` of what a default seed sets warns that the next
 * start writes it back. Create and a later `up` write the
 * default persona when the root has none, and leave an edited one byte-identical. Under umask 0002,
 * create makes `.cotal` and its persona catalog 0700. A registration
 * whose root is not an absolute path is refused at the space claim on the controller route and on the
 * legacy route, each with its reason, its remedy and exit 2, and the registration is kept. An `up` in
 * a folder other local accounts can write refuses before it writes anything, naming the folder and its
 * parent with one remedy.
 * A running broker-only stack previews the same manager requirement that `down --with-agents`
 * refuses on. After stopping that stack, which never ran a manager, retirement is a no-op.
 *
 * Needs `nats-server` on PATH.
 *
 * Run: pnpm smoke:space-registration
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
// These saved definitions are inspected, never launched. Their executable must belong to this account.
const fixtureExecutable = join(home, "fixture-executable");
writeFileSync(fixtureExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
// Set before the workspace is imported: it reads COTAL_HOME on each call.
process.env.COTAL_HOME = join(home, ".cotal");
const { MANAGER_PIDFILE, cacheLocalProcess, canonicalLocalProcessPath, clearCurrent, extensionsManifestPath, findMesh, findPreparedSpace, getCurrent, meshFile, meshesDir, preparedSpacesDir, recordMesh, recordPreparedSpace, removeMesh, removePreparedSpace, resolveOnPath, saveExtensionsManifest, setCurrent, setAdoptedCurrent, readCurrentSelection, shellPath, spaceSegment } = await import("@cotal-ai/workspace");
const { userExchangeIssuer } = await import("../src/commands/meshes-add.js");
const { processServiceHost, requireProcessIdentity, serviceInstanceStore } = await import("../src/lib/service-instances.js");
await import("../src/lib/broker-service.js");
const { serviceDefinitionStore } = await import("../src/lib/service-definitions.js");
const { readStackJournal, stackJournalPath, writeStackJournal } = await import("../src/lib/stack-journal.js");

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
const runEnv = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: process.env.COTAL_HOME!, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1" };
const launcher = resolveOnPath("cotal", runEnv) ? "cotal" : "pnpm cotal";
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
  // After a `--` every argument is a name, so --json goes before it.
  const end = args.indexOf("--");
  const r = await run(end < 0 ? [...args, "--json"] : [...args.slice(0, end), "--json", ...args.slice(end)], {}, cwd);
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
  const { setupSpaceStreams, seedChannelRegistry } = await import("@cotal-ai/core");
  for (const space of SERVED) await setupSpaceStreams({ servers: LIVE, space });
  await seedChannelRegistry({ servers: LIVE, space: "open1", file: { channels: { general: { description: "General" } } } });
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
const emptyInventory = await run(["space", "--plain"]);
const registrationTemplate = /^[ \t]*(cotal space add <name> --server <url>[^\n]*?)[ \t]{2,}Register an existing broker/m;
const emptyCommand = registrationTemplate.exec(emptyInventory.stdout)?.[1];
const outsideCommand = "cotal space add <name> --server <url> --root <dir>";
check("empty inventory outside a project names the required root and which folder to use",
  emptyInventory.status === 0 && emptyCommand === outsideCommand &&
    emptyInventory.stdout.includes("any existing folder for an open space") && emptyInventory.stdout.includes(".cotal/auth"), shown(emptyInventory));
recordMesh({ space: "keep", server: DEAD, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
setCurrent("keep");

// ── Usage refusals, before anything is read or dialed ─────────────────────────────────────────────────
{
  const before = registryFiles();
  const options = ["--server", LIVE, "--root", root, "--mode", "open"];
  const missingName = await json(["space", "add", ...options], userRoot);
  check("a missing name asks to insert it into the same registration command", refused(missingName, 1, "USAGE_INVALID") && missingName.env?.error?.remedy === "repeat the same command with the space name after `add`", shown(missingName));
  const missingBoth = await json(["space", "add", "--root", root]);
  check("without a name or server the remedy asks for both", refused(missingBoth, 1, "USAGE_INVALID") && missingBoth.env?.error?.remedy?.includes("--server <url>"), shown(missingBoth));
  const retry = await run(["space", "add", "open1", ...options, "--json"], { COTAL_HOME: join(home, "name-retry-home") }, userRoot);
  const registered = JSON.parse(retry.stdout).result;
  check("inserting the name returns a verified JSON registration for the requested root and broker", retry.status === 0 && registered?.verified === true && registered.space?.root === root && registered.space?.server === LIVE, shown(retry));
  const noServer = await json(["space", "add", "x", "--root", root]);
  check("add with no --server is USAGE_INVALID with an example remedy", refused(noServer, 1, "USAGE_INVALID") && /--server nats:\/\//.test(noServer.env?.error?.remedy ?? ""), shown(noServer));
  check("--file with --from is USAGE_INVALID", refused(await json(["space", "add", "--file", file, "--from", "https://x.test", "--root", userRoot]), 1, "USAGE_INVALID"));
  check("--file with --mode open is USAGE_INVALID", refused(await json(["space", "add", "--file", file, "--mode", "open", "--root", userRoot]), 1, "USAGE_INVALID"));
  check("--mode user with no bundle is USAGE_INVALID", refused(await json(["space", "add", "x", "--server", LIVE, "--mode", "user", "--root", root]), 1, "USAGE_INVALID"));
  check("a malformed --server is USAGE_INVALID", refused(await json(["space", "add", "x", "--server", "not a url", "--root", root]), 1, "USAGE_INVALID"));
  const fenced = await json(["space", "add", "x", "--server", "nats://broker.example.com:4222", "--mode", "open", "--root", root]);
  check("a host name without TLS is refused, and its next step is the tls:// form of the same address",
    refused(fenced, 2, "UNSUPPORTED") && fenced.env?.error?.remedy === "use tls://broker.example.com:4222, or pass --tls" && !(fenced.env.error.message ?? "").includes("Pass the address itself"), shown(fenced));
  check("--mode with another value is USAGE_INVALID", refused(await json(["space", "add", "x", "--server", LIVE, "--mode", "token", "--root", root]), 1, "USAGE_INVALID"));
  check("an add flag on another form is USAGE_INVALID", refused(await json(["space", "--server", LIVE]), 1, "USAGE_INVALID") && refused(await json(["space", "forget", "keep", "--force"]), 1, "USAGE_INVALID"));
  const fromScript = await json(["space", "add", "--from", "https://hosted.test"]);
  check("discovery with JSON explains why it cannot prompt and how to keep JSON output", refused(fromScript, 1, "USAGE_INVALID") && fromScript.env?.error?.message.includes("--json disables") && fromScript.env.error.remedy.includes("without --json") && fromScript.env.error.remedy.includes("replace --from <url> with --file <bundle.json>"), shown(fromScript));
  const fromUrl = "https://127.0.0.1:37831/example";
  const plainDiscovery = ["space", "add", "remote", "--from", fromUrl, "--plain"];
  for (const [args, env, reason] of [
    [["--no-input"], {}, "--no-input disables prompts"],
    [[], {}, "stdin and stdout must both be connected to a terminal"],
    [[], { COTAL_NO_PROMPT: "1" }, "COTAL_NO_PROMPT=1 disables prompts"],
  ] as const) {
    const result = await run([...plainDiscovery, ...args], env);
    const refusal = result.stderr.split("\n\n").slice(0, 2).join("\n\n");
    check(`plain discovery refuses before fetching: ${reason}`, result.status === 1 && result.stdout === "" &&
      refusal.includes("USAGE_INVALID") && refusal.includes(reason) && refusal.includes("No discovery document was fetched") &&
      ["cotal", "pnpm cotal"].some((cli) => refusal.includes(`\`${cli} space add remote --from ${fromUrl} --plain\``)) &&
      refusal.includes("replace --from <url> with --file <bundle.json>") && !refusal.includes("--json"), shown(result));
  }
  check("--from over http is USAGE_INVALID", refused(await json(["space", "add", "--from", "http://hosted.test"]), 1, "USAGE_INVALID"));
  // A name that starts with - reads as an option, so use, --space and the stack's own children could not take it.
  const dashed = await json(["space", "add", "--server", LIVE, "--root", root, "--force", "--", "-x"]);
  check("add of a name that starts with - is USAGE_INVALID, saying it cannot be passed as a flag value, even with --force",
    refused(dashed, 1, "USAGE_INVALID") && (dashed.env?.error?.message ?? "").includes('the space name "-x" starts with "-", so it cannot be passed as a flag value') &&
      dashed.env?.error?.remedy === "choose a name that starts with a letter, digit or underscore", shown(dashed));
  const starred = await json(["space", "add", "a*b", "--server", LIVE, "--root", root, "--force"]);
  check("add of a name space create refuses is USAGE_INVALID, with the name as target.requested, even with --force, and records nothing",
    refused(starred, 1, "USAGE_INVALID") && /1 to 64 letters, digits, underscores or hyphens/.test(starred.env?.error?.message ?? "") && starred.env?.target?.requested === "a*b" && findMesh("a*b") === undefined, shown(starred));
  // A space added from elsewhere is carried by the same local files as one created here.
  for (const length of [65, 117]) {
    const long = "r".repeat(length), limit = `the space name has ${length} characters, and a space name holds at most 64`;
    const added = await json(["space", "add", long, "--server", LIVE, "--mode", "open", "--root", root, "--force", "--yes"]);
    check(`space add of a ${length}-character name is USAGE_INVALID, exit 1, naming the limit`, refused(added, 1, "USAGE_INVALID") && (added.env?.error?.message ?? "").startsWith(limit), shown(added));
    const meshes = await run(["meshes", "add", long, "--server", LIVE, "--mode", "open", "--root", root, "--force"]);
    check(`meshes add of a ${length}-character name exits 1 naming the limit`, meshes.status === 1 && meshes.stderr.includes(limit), shown(meshes));
  }
  check("no usage refusal wrote anything", JSON.stringify(registryFiles()) === JSON.stringify(before));
}

// ── Adding a space from --server ───────────────────────────────────────────────────────────────────────
{
  const outside = await run(["space", "--plain"]);
  const inside = await run(["space", "--plain"], {}, root);
  check("nonempty inventory names --root only when the project cannot be inferred",
    outside.status === 0 && registrationTemplate.exec(outside.stdout)?.[1] === outsideCommand &&
    inside.status === 0 && registrationTemplate.exec(inside.stdout)?.[1] === "cotal space add <name> --server <url>", { outside: shown(outside), inside: shown(inside) });
  if (!emptyCommand) throw new Error(`inventory printed no registration command: ${emptyInventory.stdout}`);
  const args: Record<string, string> = { "<name>": "open1", "<url>": LIVE, "<dir>": root };
  const added = await json(emptyCommand.split(" ").slice(1).map((arg) => args[arg] ?? arg));
  const r = added.env?.result;
  check("an open broker is added: ok, verified, not a replacement", added.status === 0 && added.env?.outcome === "ok" && r?.kind === "space-added" && r.verified === true && r.replaced === false, shown(added));
  check("its record is the space show detail: open, manual, reachable", r?.space?.space === "open1" && r.space.mode === "open" && r.space.origin === "manual" && r.space.check === "reachable" && r.space.root === root, r?.space);
  check("the registry holds it", findMesh("open1")?.server === LIVE && findMesh("open1")?.origin === "manual");
  check("the selection is unchanged", getCurrent() === "keep" && r?.space?.current === false, getCurrent());

  const sent = await json(["send", "--space", "open1", "-c", "general", "x"]);
  check("control: send to an answering registered broker stores the message", sent.status === 0 && sent.env?.outcome === "ok" && sent.env.result?.stored === true, shown(sent));

  const conflictingServer = await json(["space", "add", "open1", "--server", DEAD, "--root", root]);
  const conflictStep = conflictingServer.env?.error?.remedy ?? "";
  check("a conflicting manual add explains the unchecked replacement, its verification and what forgetting clears",
    refused(conflictingServer, 2, "CONFLICT") && conflictStep.includes("without checking the broker") &&
    conflictStep.includes("repeat the same add without --force to verify it") && conflictStep.includes("`cotal space forget open1`") &&
    conflictStep.includes("selection, per-space preferences and remembered chat sessions") && findMesh("open1")?.server === LIVE, shown(conflictingServer));
  const replaced = await json(["space", "add", "open1", "--server", DEAD, "--root", root, "--force"]);
  check("--force replaces a registration added by hand, unchecked", replaced.status === 0 && replaced.env?.result.replaced === true && replaced.env.result.verified === false && replaced.env.result.space.check === "not-checked" && findMesh("open1")?.server === DEAD, shown(replaced));

  const beforeSend = registryFiles();
  const offline = await json(["send", "--space", "open1", "-c", "general", "x"]);
  check("send to an unreachable registration refuses with space forget in its JSON remedy",
    refused(offline, 2, "TARGET_UNAVAILABLE") && offline.env?.error?.remedy === "start it where it runs, or `cotal space forget open1` to unregister it", shown(offline));
  const offlineHuman = await run(["send", "--space", "open1", "-c", "general", "x"]);
  check("the human refusal names space forget, not legacy removal or local startup, and keeps the registrations",
    offlineHuman.status === 2 && offlineHuman.stderr.includes("cotal space forget open1") && !offlineHuman.stderr.includes("cotal meshes rm") && !offlineHuman.stderr.includes("cotal up") &&
      JSON.stringify(registryFiles()) === JSON.stringify(beforeSend), shown(offlineHuman));

  recordMesh({ space: "started", server: LIVE, root, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const overUpBare = await json(["space", "add", "started", "--server", LIVE, "--root", root]);
  check("adding a space this machine started is CONFLICT and does not offer --force", refused(overUpBare, 2, "CONFLICT") && (overUpBare.env?.error?.message ?? "").includes("a space this machine started") && !/--force/.test(overUpBare.env?.error?.remedy ?? ""), shown(overUpBare));
  const showStep = overUpBare.env?.error?.remedy?.match(/`cotal (space show started --json)`/)?.[1];
  const inspection = showStep ? await run(showStep.split(" ")) : undefined;
  check("the suggested JSON inspection reads the existing registration", inspection?.status === 0 && inspection.stdout.trimStart().startsWith("{") && JSON.parse(inspection.stdout).result?.root === root, showStep);
  const overUpPlain = await run(["space", "add", "started", "--server", LIVE, "--root", root, "--plain"]);
  check("plain registration conflict keeps the plain inspection", overUpPlain.status === 2 && overUpPlain.stderr.includes("`cotal space show started --plain`"), shown(overUpPlain));
  const overUp = await json(["space", "add", "started", "--server", LIVE, "--root", root, "--force"]);
  check("--force does not replace a space this machine started", refused(overUp, 2, "CONFLICT") && findMesh("started")?.origin === "up", shown(overUp));

  const before = registryFiles();
  const dead = await json(["space", "add", "dead1", "--server", DEAD, "--root", root]);
  check("a broker that does not answer is TARGET_UNAVAILABLE, exit 2", refused(dead, 2, "TARGET_UNAVAILABLE") && /no broker answered/.test(dead.env?.error?.message ?? ""), shown(dead));
  check("…and its next step is --force, for a space that is down right now", (dead.env?.error?.remedy ?? "").includes(`pass --force to add "dead1" unchecked`), shown(dead));
  const deadPort = new URL(DEAD).port;
  check("a port that takes no connection says so, with the port check as its remedy",
    (dead.env?.error?.message ?? "").endsWith(`nothing accepted a connection at 127.0.0.1:${deadPort}`) && dead.env?.error?.remedy === `check that the mesh is up and listening on port ${deadPort} of 127.0.0.1, or pass --server with the port it listens on; pass --force to add "dead1" unchecked, as for a space that is down right now`, shown(dead));
  const otherScheme = await json(["space", "add", "open", "--server", `tls://127.0.0.1:${brokerPort}`, "--mode", "open", "--root", root]);
  check("a TLS-required address refuses a plaintext listener without downgrading",
    refused(otherScheme, 2, "DEPENDENCY_UNAVAILABLE") && otherScheme.env?.error?.message === `the listener at tls://127.0.0.1:${brokerPort} does not offer the required TLS - check the address and configure TLS on the broker`, shown(otherScheme));
  const unserved = await json(["space", "add", "open", "--server", LIVE, "--mode", "open", "--root", root]);
  check("an open name the broker does not serve is TARGET_NOT_FOUND, exit 2, naming the spaces it serves",
    refused(unserved, 2, "TARGET_NOT_FOUND") && unserved.env?.error?.message === `the broker at ${LIVE} serves no space named "open"; it serves ${SERVED.map((space) => `"${space}"`).join(", ")}` && /--force/.test(unserved.env?.error?.remedy ?? ""), shown(unserved));
  // Reading an unserved name on a real open broker must not make it registerable (#8392).
  {
    const { dialerFor } = await import("@cotal-ai/core");
    const { jetstreamManager } = await import("@nats-io/jetstream");
    const nc = await dialerFor(LIVE)({ servers: LIVE });
    try {
      const jsm = await jetstreamManager(nc);
      const streams = async () => {
        const names: string[] = [];
        for await (const name of jsm.streams.names()) names.push(name);
        return names.sort();
      };
      const before = await streams();
      const lookedUp = await json(["who", "--space", "open", "--server", LIVE]);
      check("who reports a complete empty roster for an unserved open space",
        lookedUp.status === 0 && lookedUp.env?.completeness === "complete" && lookedUp.env?.target?.space === "open" && lookedUp.env?.result?.items?.length === 0, shown(lookedUp));
      const after = await streams();
      check("who creates no streams or buckets for an unserved open space", before.join() === after.join(), { before, after });
      const retried = await json(["space", "add", "open", "--server", LIVE, "--mode", "open", "--root", root]);
      check("verified registration still refuses after who, and records nothing",
        refused(retried, 2, "TARGET_NOT_FOUND") && findMesh("open") === undefined, shown(retried));
    } finally {
      await nc.close();
    }
  }
  // The guided form offers the same served names, so the operator picks one instead of typing it blind.
  {
    const { addWizard } = await import("../src/commands/meshes-wizard.js");
    const asked: { message: string; options?: unknown[] }[] = [];
    const answers: unknown[] = ["open3", false];
    const next = (message: string) => {
      if (!answers.length) throw new Error(`the wizard asked more than the script answers: "${message}"`);
      return answers.shift();
    };
    const io = {
      intro() {}, outro() {}, note() {}, cancel() {},
      log: { info() {}, warn() {}, error() {} },
      spinner: () => ({ start() {}, stop() {} }),
      async text(o: { message: string }) { asked.push({ message: o.message }); return next(o.message); },
      async select(o: { message: string; options: { value: unknown }[] }) { asked.push({ message: o.message, options: o.options.map((x) => x.value) }); return next(o.message); },
      async confirm(o: { message: string }) { asked.push({ message: o.message }); return next(o.message); },
    };
    const declined = await addWizard({ server: LIVE, root: projectRoot("wizard-open") }, home, io as never);
    const which = asked.find((a) => a.message === "Which space on that broker?");
    check("the guided form offers the spaces an open broker serves", declined === false && SERVED.every((space) => which?.options?.includes(space)), asked);
    check("…and a picked name goes on to the final question, where declining writes nothing", asked.some((a) => a.message === "Register this mesh?") && findMesh("open3") === undefined, asked);
  }
  const wantsAuth = await json(["space", "add", "o2", "--server", AUTH_LIVE, "--mode", "open", "--root", root]);
  check("an open claim on a broker that requires auth is CONFLICT", refused(wantsAuth, 2, "CONFLICT"), shown(wantsAuth));
  check("its refusal and the copy cost it names are one line", (wantsAuth.env?.error?.message ?? "").includes("signing seed") && !(wantsAuth.env?.error?.message ?? "").includes("\n"), wantsAuth.env?.error?.message);
  const noTrust = await json(["space", "add", "a2", "--server", AUTH_LIVE, "--mode", "auth", "--root", root]);
  check("an auth claim with no trust under --root is DEPENDENCY_UNAVAILABLE", refused(noTrust, 2, "DEPENDENCY_UNAVAILABLE"), shown(noTrust));
  // A machine without the signing seed is told what it can use instead, and is not offered `--mode
  // open`, which a broker that requires auth refuses.
  const seedless = (m: string) => m.includes("`cotal auth mint`") && m.includes("`--creds <file> --server <url>`") && !m.includes("--mode open");
  check("…naming an owner's minted credential with --creds, not --mode open", seedless(noTrust.env?.error?.message ?? ""), noTrust.env?.error?.message);
  check("the open claim's refusal names the same route", seedless(wantsAuth.env?.error?.message ?? ""), wantsAuth.env?.error?.message);
  const plaintext = await json(["space", "add", "far", "--server", "nats://broker.example.com:4222", "--root", root]);
  check("a hostname with no TLS is UNSUPPORTED: credentials would cross the network unprotected", refused(plaintext, 2, "UNSUPPORTED"), shown(plaintext));
  const noRoot = await json(["space", "add", "r2", "--server", LIVE, "--root", join(home, "missing")]);
  check("an invalid --root names the directory requirement for an open space", refused(noRoot, 1, "USAGE_INVALID") && noRoot.env?.error?.message === "--root must name an existing directory" && noRoot.env.error.remedy.includes(join(home, "missing")) && noRoot.env.error.remedy.includes("for an open space it may be empty"), shown(noRoot));
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const parent = projectRoot("sealed-parent"), child = join(parent, "project");
    mkdirSync(child);
    chmodSync(parent, 0o600);
    try {
      const hidden = await json(["space", "add", "r2", "--server", LIVE, "--root", child]);
      check("a registration root hidden by parent permissions is not reported as a missing directory", refused(hidden, 2, "PERMISSION_DENIED") && hidden.env?.error?.remedy.includes(child) && !findMesh("r2"), shown(hidden));
    } finally { chmodSync(parent, 0o700); }
  }
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
  check("…and its registration records that its mode was not checked", findMesh("dead1")?.unchecked === true && forced.env?.result.space.modeChecked === false, findMesh("dead1"));
  const listedUnchecked = await json(["space"]);
  check("space --json marks that mode unchecked and a checked one checked",
    listedUnchecked.env?.result.items.find((item: { space: string }) => item.space === "dead1")?.modeChecked === false && listedUnchecked.env?.result.items.find((item: { space: string }) => item.space === "started")?.modeChecked === true, listedUnchecked.env?.result.items);
  setCurrent("dead1");
  const shownUnchecked = await run(["space", "show", "dead1", "--plain"]);
  check("space show tells the user to wait for an offline broker without forgetting it",
    shownUnchecked.status === 0 && /broker:\s+unreachable/.test(shownUnchecked.stdout) && /mode:\s+open, not checked: added with --force/.test(shownUnchecked.stdout) &&
    shownUnchecked.stdout.includes("wait for the broker to answer") && !shownUnchecked.stdout.includes("cotal space forget"), shown(shownUnchecked));
  const beforeVerify = registryFiles();
  const verifyOffline = await json(["space", "add", "dead1", "--server", DEAD, "--root", root]);
  const retarget = await json(["space", "add", "dead1", "--server", LIVE, "--root", root]);
  check("offline verification preserves the registration and selection and cannot retarget it",
    refused(verifyOffline, 2, "TARGET_UNAVAILABLE") && refused(retarget, 2, "CONFLICT") &&
    JSON.stringify(registryFiles()) === JSON.stringify(beforeVerify) && getCurrent() === "dead1", { verify: shown(verifyOffline), retarget: shown(retarget) });
  const whoUnchecked = await json(["whoami", "--space", "dead1"]);
  check("whoami does not state an unchecked mode as fact: partial, exit 4, MODE_NOT_CHECKED",
    whoUnchecked.status === 4 && whoUnchecked.env?.outcome === "partial" && whoUnchecked.env.result.modeChecked === false && whoUnchecked.env.warnings.some((w: { code: string }) => w.code === "MODE_NOT_CHECKED"), shown(whoUnchecked));
  const next = /^run `cotal (space show dead1)` to check the broker without removing its registration$/.exec(whoUnchecked.env?.error?.remedy ?? "");
  const inspected = next && await run(next[1]!.split(" "));
  check("following the whoami remedy leaves the offline space selected and registered",
    inspected?.status === 0 && inspected.stdout.includes("wait for the broker to answer") &&
    JSON.stringify(registryFiles()) === JSON.stringify(beforeVerify) && getCurrent() === "dead1", { who: shown(whoUnchecked), inspected: inspected && shown(inspected) });
  setCurrent("keep");
  const legacyForced = await run(["meshes", "add", "legacy-unchecked", "--server", DEAD, "--root", root, "--mode", "open", "--force"]);
  check("legacy meshes add also records the mode as unchecked when forced",
    legacyForced.status === 0 && legacyForced.stdout.includes("recorded without verifying") && findMesh("legacy-unchecked")?.unchecked === true, shown(legacyForced));
  const legacyWho = await json(["whoami", "--space", "legacy-unchecked"]);
  check("whoami reports partial access for a legacy forced registration",
    legacyWho.status === 4 && legacyWho.env?.outcome === "partial" && legacyWho.env.result.modeChecked === false && legacyWho.env.warnings.some((w: { code: string }) => w.code === "MODE_NOT_CHECKED"), shown(legacyWho));
  const legacyShow = await run(["space", "show", "legacy-unchecked", "--plain"]);
  check("space show marks a legacy forced registration as unchecked",
    legacyShow.status === 0 && /mode:\s+open, not checked: added with --force/.test(legacyShow.stdout), shown(legacyShow));

  clearCurrent();
  const unselected = await json(["space", "add", "open3", "--server", LIVE, "--root", root]);
  check("with nothing selected, an added space is not selected either", unselected.status === 0 && getCurrent() === undefined, { current: getCurrent() });
  setCurrent("keep");

  const human = await run(["space", "add", "open4", "--server", LIVE, "--root", root], { FORCE_COLOR: "1" });
  const text = human.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  check("the human report says it was added and how to select it", human.status === 0 && /✓ added open4/.test(text) && /broker answered and serves this space/.test(text) && /select it with `cotal use open4`/.test(text), shown(human));
  const emptyRoot = mkdtempSync(join(home, "empty-registration-"));
  const addedAtEmptyRoot = await json(["space", "add", "open4", "--server", LIVE, "--root", emptyRoot, "--mode", "open", "--force"]);
  const linkedRoot = `${emptyRoot}-link`;
  symlinkSync(emptyRoot, linkedRoot, "junction");
  setCurrent("open4");
  const sameRegistration = ["space", "add", "open4", "--server", `${LIVE}/`, "--root", `${emptyRoot}/.`, "--mode", "open"];
  const differentTls = await json([...sameRegistration, "--tls"]);
  check("an unchecked registration still refuses an in-place change to its TLS requirement",
    refused(differentTls, 2, "CONFLICT") && findMesh("open4")?.unchecked === true, shown(differentTls));
  const checkedAtEmptyRoot = await json(sameRegistration);
  check("a trailing slash verifies the same unchecked broker in place and preserves the selection",
    addedAtEmptyRoot.status === 0 && checkedAtEmptyRoot.status === 0 && checkedAtEmptyRoot.env?.result.replaced === true &&
      checkedAtEmptyRoot.env.result.verified === true && findMesh("open4")?.unchecked !== true && getCurrent() === "open4", shown(checkedAtEmptyRoot));
  const addedThroughLink = await json(["space", "add", "open4", "--server", LIVE, "--root", linkedRoot, "--mode", "open", "--force"]);
  const realRegistration = ["space", "add", "open4", "--server", LIVE, "--root", emptyRoot, "--mode", "open"];
  const checkedThroughRealPath = await json(realRegistration);
  check("the physical root verifies an unchecked registration made through a link and preserves the selection",
    addedThroughLink.status === 0 && addedThroughLink.env?.result.space.root === linkedRoot &&
      checkedThroughRealPath.status === 0 && checkedThroughRealPath.env?.result.replaced === true && checkedThroughRealPath.env.result.verified === true &&
      findMesh("open4")?.unchecked !== true && getCurrent() === "open4", shown(checkedThroughRealPath));

  const beforeRepeat = registryFiles();
  const repeated = await run([...realRegistration, "--plain"]);
  check("repeating a checked registration reports it already exists and verifies the broker",
    repeated.status === 0 && repeated.stdout.includes("open4 is already registered") &&
    repeated.stdout.includes("checked: broker answered and serves this space"), shown(repeated));
  const sameThroughLink = ["space", "add", "open4", "--server", `${LIVE}/`, "--root", linkedRoot, "--mode", "open"];
  const repeatedJson = await json(sameThroughLink);
  const changedTls = await json([...sameThroughLink, "--tls"]);
  const changedRoot = await json(["space", "add", "open4", "--server", LIVE, "--root", root, "--mode", "open"]);
  check("equivalent broker and root spellings recheck as a no-op and report the existing registration",
    repeatedJson.status === 0 && repeatedJson.env?.outcome === "no-op" && repeatedJson.env.result.verified === true &&
    repeatedJson.env.result.replaced === false && repeatedJson.env.result.space.recordedAt === checkedThroughRealPath.env?.result.space.recordedAt &&
    repeatedJson.env.result.space.server === LIVE && repeatedJson.env.result.space.root === emptyRoot, shown(repeatedJson));
  check("a checked registration still refuses a different root or TLS requirement and keeps its record and selection",
    refused(changedTls, 2, "CONFLICT") && refused(changedRoot, 2, "CONFLICT") &&
    JSON.stringify(registryFiles()) === JSON.stringify(beforeRepeat) && getCurrent() === "open4", { tls: shown(changedTls), root: shown(changedRoot) });
  clearCurrent();
  const fromEmptyRoot = await run(["space", "show", "--plain"], {}, emptyRoot);
  check("bare show uses the empty registered folder with no selection",
    fromEmptyRoot.status === 0 && fromEmptyRoot.stdout.includes("Mesh: open4") && fromEmptyRoot.stdout.includes("this folder's space") &&
      !existsSync(join(emptyRoot, ".cotal")), shown(fromEmptyRoot));
  const nested = join(emptyRoot, "nested");
  const leaf = join(nested, "leaf");
  mkdirSync(leaf, { recursive: true });
  const fromNested = await run(["space", "show", "--plain"], {}, leaf);
  check("bare show finds an enclosing registered root with no .cotal and no selection",
    fromNested.status === 0 && fromNested.stdout.includes("Mesh: open4") && fromNested.stdout.includes("this folder's space") &&
      !existsSync(join(emptyRoot, ".cotal")) && getCurrent() === undefined, shown(fromNested));
  setCurrent("keep");
  const withSelection = await json(["space", "show"], leaf);
  check("bare show prefers the enclosing registered folder to an explicit selection without changing it",
    withSelection.status === 0 && withSelection.env?.result.space === "open4" && withSelection.env.result.root === emptyRoot &&
      withSelection.env.result.check === "reachable" && getCurrent() === "keep", shown(withSelection));
  const plain = await run(["space", "add", "open5", "--server", LIVE, "--root", root, "--plain"], { FORCE_COLOR: "1" });
  check("--plain writes it with no ANSI", plain.status === 0 && !/\x1b\[/.test(plain.stdout) && /added open5/.test(plain.stdout), shown(plain));

  const secondAtEmptyRoot = await json(["space", "add", "open5", "--server", LIVE, "--root", emptyRoot, "--mode", "open", "--force"]);
  const ambiguous = await json(["space", "show"], leaf);
  const ambiguousPlain = await run(["space", "show", "--plain"], {}, leaf);
  check("bare show refuses two registrations at the enclosing root and names both explicit choices",
    secondAtEmptyRoot.status === 0 && refused(ambiguous, 2, "TARGET_AMBIGUOUS") && ambiguousPlain.status === 2 && getCurrent() === "keep", shown(ambiguous));
  for (const [format, refusal] of [["--json", ambiguous.env?.error?.remedy], ["--plain", ambiguousPlain.stderr]] as const) {
    const choices = [...String(refusal).matchAll(/ (space show (open[45]) (--json|--plain))`/g)];
    check(`both retry commands keep ${format}`, choices.map((choice) => `${choice[2]} ${choice[3]}`).join(", ") === `open4 ${format}, open5 ${format}`, refusal);
    for (const [, args, name] of choices) {
      const retry = await run(args!.split(" "), {}, leaf);
      check(`following the ${format} retry reports ${name}`, retry.status === 0 && (format === "--json"
        ? JSON.parse(retry.stdout).result.space === name : retry.stdout.includes(`Mesh: ${name}`)), shown(retry));
    }
  }
  const secondAtNestedRoot = await json(["space", "add", "open5", "--server", LIVE, "--root", nested, "--mode", "open", "--force"]);
  const nearest = await json(["space", "show"], leaf);
  check("bare show uses the nearer registered root when both ancestors have registrations",
    secondAtNestedRoot.status === 0 && nearest.status === 0 && nearest.env?.result.space === "open5" && nearest.env.result.root === nested, shown(nearest));
  check("forget the second registration without changing its root", (await json(["space", "forget", "open5"])).status === 0);

  if (process.platform !== "win32") {
    const spacedRoot = projectRoot("registrations with 'quotes' and `backticks`");
    const unchecked = await json(["space", "add", "open5", "--server", LIVE, "--root", spacedRoot, "--mode", "open", "--force"]);
    check("a forced registration keeps a root with spaces and quotes", unchecked.status === 0 && unchecked.env?.result.space.root === spacedRoot && unchecked.env?.result.verified === false, shown(unchecked));
    setCurrent("open5");
    const detail = await run(["space", "show", "open5", "--plain"]);
    const hint = /check its mode without removing the registration: (`+)(cotal space add .+?)\1$/m.exec(detail.stdout);
    const verified = hint && spawnSync("sh", ["-c", `cotal() { ${shellPath(process.execPath)} ${shellPath(BIN)} "$@"; }\n${hint[2]}`], {
      cwd: home, env: runEnv, encoding: "utf8", timeout: 120_000,
    });
    const checked = await json(["space", "show", "open5"]);
    check("the printed verification command verifies the exact root and keeps the selection",
      detail.status === 0 && verified?.status === 0 && checked.status === 0 && checked.env?.result.modeChecked === true && checked.env?.result.root === spacedRoot && checked.env?.result.current === true,
      { detail: shown(detail), shell: verified && shown(verified), checked: shown(checked) });
    setCurrent("keep");
  }

  // Withdraw the checked space from the smoke broker while keeping the other spaces available.
  const { chatStream, dialerFor, presenceBucket, setupSpaceStreams } = await import("@cotal-ai/core");
  const { jetstreamManager } = await import("@nats-io/jetstream");
  const nc = await dialerFor(LIVE)({ servers: LIVE });
  try {
    const { streams } = await jetstreamManager(nc);
    await streams.delete(chatStream("open4"));
    await streams.delete(`KV_${presenceBucket("open4")}`);
    const beforeMissing = registryFiles();
    const missing = await json(realRegistration);
    check("a checked recheck on a broker that no longer serves the space keeps the record and gives a safe remedy",
      refused(missing, 2, "TARGET_NOT_FOUND") && missing.env?.error?.message.includes('it serves "open1", "open3", "open5"') &&
      missing.env?.error?.remedy === 'start or restore "open4" on that broker, then retry' &&
      JSON.stringify(registryFiles()) === JSON.stringify(beforeMissing) && getCurrent() === "keep", shown(missing));
  } finally {
    await nc.close();
    await setupSpaceStreams({ servers: LIVE, space: "open4" });
  }
}

// ── Adding a user-auth space from a bundle ─────────────────────────────────────────────────────────────
{

  const before = registryFiles();
  const wrongName = await json(["space", "add", "other", "--file", file, "--root", userRoot]);
  check("a bundle for another space is CONFLICT", refused(wrongName, 2, "CONFLICT") && /"hosted"/.test(wrongName.env?.error?.message ?? ""), shown(wrongName));
  writeFileSync(join(home, "broken.json"), "{ not json");
  check("a bundle that is not JSON is SCHEMA_INVALID, exit 1", refused(await json(["space", "add", "--file", join(home, "broken.json"), "--root", userRoot]), 1, "SCHEMA_INVALID"));
  check("a missing bundle file is USAGE_INVALID", refused(await json(["space", "add", "--file", join(home, "absent.json"), "--root", userRoot]), 1, "USAGE_INVALID"));
  writeFileSync(join(home, "dashed.json"), JSON.stringify(bundle({ space: "-hosted" })));
  const dashedBundle = await json(["space", "add", "--file", join(home, "dashed.json"), "--root", userRoot]);
  check("a bundle for a space whose name starts with - is USAGE_INVALID, and nothing is written",
    refused(dashedBundle, 1, "USAGE_INVALID") && /cannot be passed as a flag value/.test(dashedBundle.env?.error?.message ?? "") && JSON.stringify(registryFiles()) === JSON.stringify(before), shown(dashedBundle));
  exchangeIssuer = "https://someone-else.test/";
  const foreign = await json(["space", "add", "--file", file, "--root", userRoot]);
  check("an exchange that answers as another issuer is CONFLICT", refused(foreign, 2, "CONFLICT"), shown(foreign));
  exchangeIssuer = userExchangeIssuer("hosted");
  // A bundle's broker is diagnosed like a --server one when it does not answer, over TLS too.
  const closed = await freePort();
  writeFileSync(join(home, "closed-broker.json"), JSON.stringify(bundle({ server: `tls://127.0.0.1:${closed}` })));
  const closedBroker = await json(["space", "add", "--file", join(home, "closed-broker.json"), "--root", userRoot]);
  check("a bundle whose tls:// broker port takes no connection says so, with the port check as its remedy",
    refused(closedBroker, 2, "TARGET_UNAVAILABLE") && (closedBroker.env?.error?.message ?? "").includes(`nothing accepted a connection at 127.0.0.1:${closed}`) &&
      (closedBroker.env?.error?.remedy ?? "").startsWith(`check that the mesh is up and listening on port ${closed} of 127.0.0.1`), shown(closedBroker));
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

  // Two damaged registry files must not send forgets in a circle (#7826): each exact-name forget
  // removes only its own record and warns about the other one it leaves behind, while the
  // listing still refuses while any damaged record remains.
  const kiloAdded = await json(["space", "add", "kilo", "--server", DEAD, "--root", root, "--force"]);
  const limaAdded = await json(["space", "add", "lima", "--server", DEAD, "--root", root, "--force"]);
  check("rig: two offline spaces are added", kiloAdded.status === 0 && limaAdded.status === 0 && findMesh("kilo") !== undefined && findMesh("lima") !== undefined, [kiloAdded, limaAdded].map((r) => shown(r)));
  const kiloFile = join(meshesDir(), `${spaceSegment("kilo")}.json`), limaFile = join(meshesDir(), `${spaceSegment("lima")}.json`);
  writeFileSync(kiloFile, "not JSON\n");
  writeFileSync(limaFile, `{"space":"lima",\n`);
  const damagedBefore = registryFiles();
  for (const name of [".", ".."]) {
    const invalid = await json(["space", "forget", name]);
    check(`forget refuses ${name} as an invalid name before reading the damaged registry`,
      refused(invalid, 1, "USAGE_INVALID") && invalid.env?.error?.message.includes("Nothing was forgotten") &&
        invalid.env.error.remedy.includes("`cotal space`") && JSON.stringify(registryFiles()) === JSON.stringify(damagedBefore), shown(invalid));
  }
  const listedDamaged = await json(["space"]);
  check("a listing still refuses while any damaged record remains, naming the first damaged file",
    refused(listedDamaged, 1, "SCHEMA_INVALID") && (listedDamaged.env?.error?.message ?? "").includes(kiloFile) && (listedDamaged.env?.error?.remedy ?? "").includes("cotal space forget kilo"), shown(listedDamaged));
  const forgetKilo = await json(["space", "forget", "kilo"]);
  check("forget of one damaged space succeeds while another record is damaged, and removes only its own file",
    forgetKilo.status === 0 && forgetKilo.env?.result.kind === "space-forgotten" && !existsSync(kiloFile) && existsSync(limaFile), shown(forgetKilo));
  check("...and it warns about the damaged record it leaves, naming the forget that clears it",
    forgetKilo.env?.warnings.some((w: { code: string; message: string }) => w.code === "MESH_REGISTRY_DAMAGED" && w.message.includes(limaFile) && w.message.includes("cotal space forget lima")), forgetKilo.env?.warnings);
  const listedOneDamaged = await json(["space"]);
  check("...and the listing still refuses on the record that remains",
    refused(listedOneDamaged, 1, "SCHEMA_INVALID") && (listedOneDamaged.env?.error?.message ?? "").includes(limaFile), shown(listedOneDamaged));
  const forgetLima = await json(["space", "forget", "lima"]);
  const listedClean = await json(["space"]);
  check("forget of the second damaged space then succeeds, and the listing works again",
    forgetLima.status === 0 && forgetLima.env?.result.kind === "space-forgotten" && !existsSync(limaFile) && findMesh("lima") === undefined && listedClean.status === 0, shown(forgetLima));

  recordMesh({ space: "dir-record", server: DEAD, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  const directory = join(meshesDir(), `${spaceSegment("dir-record")}.json`), backup = `${directory}.saved`;
  renameSync(directory, backup);
  mkdirSync(directory, { mode: 0o700 });
  const keptFile = join(directory, "keep.txt");
  writeFileSync(keptFile, "keep this\n");
  const listDirectory = await json(["space"]);
  const forgetDirectory = await json(["space", "forget", "dir-record"]);
  const moveAside = listDirectory.env?.error?.remedy;
  check("a directory at a registry record path names the directory and advises moving it aside, not forgetting",
    refused(listDirectory, 1, "SCHEMA_INVALID") && listDirectory.env?.error?.message.includes(`${directory} is a directory`) && moveAside?.includes(`move the directory ${directory} aside`) && !moveAside.includes("space forget"), shown(listDirectory));
  check("forget refuses before changing a directory or its contents, with the same recovery",
    refused(forgetDirectory, 1, "SCHEMA_INVALID") && forgetDirectory.env?.error?.message.includes("nothing was forgotten") && forgetDirectory.env.error.remedy === moveAside && readFileSync(keptFile, "utf8") === "keep this\n", shown(forgetDirectory));
  const aside = join(home, "registration-directory-aside");
  renameSync(directory, aside);
  renameSync(backup, directory);
  const restored = await json(["space"]);
  check("moving the directory aside and restoring the record recovers the inventory",
    restored.status === 0 && findMesh("dir-record") !== undefined && readFileSync(join(aside, "keep.txt"), "utf8") === "keep this\n", shown(restored));
  check("the restored regular file can be forgotten", (await json(["space", "forget", "dir-record"])).status === 0);

  // A healthy registration is not a recovery target, even for a locally started space.
  const upServer = `nats://127.0.0.1:${await freePort()}`;
  recordMesh({ space: "up1", server: upServer, root, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  recordMesh({ space: "beta", server: DEAD, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  const betaFile = join(meshesDir(), `${spaceSegment("beta")}.json`);
  writeFileSync(betaFile, "not JSON\n");
  const forgetUp1 = await json(["space", "forget", "up1"]);
  const up1File = join(meshesDir(), `${spaceSegment("up1")}.json`);
  check("forget of a healthy started space refuses while another record is damaged and preserves both files",
    refused(forgetUp1, 1, "SCHEMA_INVALID") && existsSync(up1File) && existsSync(betaFile), shown(forgetUp1));
  check("...and it names the damaged file and the exact forget that clears it",
    (forgetUp1.env?.error?.message ?? "").includes(betaFile) && (forgetUp1.env?.error?.remedy ?? "").includes("cotal space forget beta"), shown(forgetUp1));
  const forgetBeta = await json(["space", "forget", "beta"]);
  check("forget of the damaged record succeeds and leaves the healthy space registered",
    forgetBeta.status === 0 && forgetBeta.env?.result.kind === "space-forgotten" && !existsSync(betaFile) && findMesh("up1") !== undefined, shown(forgetBeta));
  const retryUp1 = await json(["space", "forget", "up1"]);
  check("forget of the healthy started space works after recovery", retryUp1.status === 0 && !existsSync(up1File), shown(retryUp1));

  if (process.platform === "linux") {
    // A missing folder is not an exception to the healthy-record refusal. After recovery,
    // the usual gone-folder checks can confirm that nothing still runs at its broker address.
    const up2Server = `nats://127.0.0.1:${await freePort()}`;
    const goneRoot = join(home, "deleted-up2");
    recordMesh({ space: "up2", server: up2Server, root: goneRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
    recordMesh({ space: "gamma", server: DEAD, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
    const gammaFile = join(meshesDir(), `${spaceSegment("gamma")}.json`);
    writeFileSync(gammaFile, "not JSON\n");
    const forgetUp2 = await json(["space", "forget", "up2"]);
    const up2File = join(meshesDir(), `${spaceSegment("up2")}.json`);
    check("forget of a healthy space whose folder is gone refuses while another record is damaged",
      refused(forgetUp2, 1, "SCHEMA_INVALID") && (forgetUp2.env?.error?.remedy ?? "").includes("cotal space forget gamma") && existsSync(up2File) && existsSync(gammaFile), shown(forgetUp2));
    const forgetGamma = await json(["space", "forget", "gamma"]);
    check("forget of that damaged record succeeds without removing the gone-folder registration",
      forgetGamma.status === 0 && forgetGamma.env?.result.kind === "space-forgotten" && !existsSync(gammaFile) && findMesh("up2") !== undefined, shown(forgetGamma));
    const retryUp2 = await json(["space", "forget", "up2"]);
    check("forget of the healthy gone-folder space works after recovery", retryUp2.status === 0 && !existsSync(up2File), shown(retryUp2));
  }

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
  check("...and on a legacy root, whose down drops the record, the remedy says so", live.env?.error?.remedy === `stop it with \`cotal down\` in ${ownedRoot}, which also drops its record`, live.env?.error);

  // A folder deleted while its broker runs takes the pidfiles and journal the running check reads, so
  // that broker shows only at its recorded address (#7325). A plain listener stands in for it.
  const orphanHold = createServer();
  const orphanServer = `nats://127.0.0.1:${await listenOn(orphanHold, await freePort())}`;
  const orphanRoot = join(home, "deleted-while-running");
  recordMesh({ space: "orphan", server: orphanServer, root: orphanRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const orphan = await json(["space", "forget", "orphan"]);
  check("a space whose folder is gone while its broker address still listens is LIFECYCLE_BLOCKED, and its record stays",
    refused(orphan, 2, "LIFECYCLE_BLOCKED") && (orphan.env?.error?.message ?? "").includes(`"orphan" started in ${orphanRoot}, which no longer exists, but something still listens at ${orphanServer}`) && findMesh("orphan") !== undefined, shown(orphan));
  check("...and the remedy leaves an unrelated listener running and names the folder to restore",
    orphan.env?.error?.remedy === `identify the listener at ${new URL(orphanServer).host}. If it belongs to this space, have its owner stop the stack; otherwise leave it running. Retry \`cotal space forget orphan\` when the address is free or after you restore the original project folder to ${orphanRoot}`, orphan.env?.error);
  // A listener at an address another registration names is that space's broker.
  recordMesh({ space: "sharedgone", server: LIVE, root: join(home, "deleted-shared"), mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const shared = await json(["space", "forget", "sharedgone"]);
  check("...but one whose address another registration names is forgotten", shared.status === 0 && findMesh("sharedgone") === undefined, shown(shared));
  await new Promise<void>((done) => orphanHold.close(() => done()));
  const freed = await json(["space", "forget", "orphan"]);
  check("...and once nothing listens there it is forgotten", freed.status === 0 && freed.env?.result.kind === "space-forgotten" && findMesh("orphan") === undefined, shown(freed));

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
    const member = (space: string, definition: string, pinned: { pid: number; token: string }, stopped: boolean, extra: { kernelStopRequired?: true } = {}): string => {
      const id = randomUUID(), requestId = randomUUID();
      serviceInstanceStore(space).commit(id, undefined, {
        schemaVersion: 1, instanceId: id, definition, definitionRevision: `rev-${definition}`, space, host: processServiceHost(),
        requestId, launchRequestId: requestId, state: stopped ? "stopped" : "running", launcher: requireProcessIdentity(process.pid), process: pinned,
        readiness: stopped ? "not-checked" : "process-running", supervisor: "none", foreground: false, createdAt: ts, updatedAt: ts,
        ...(stopped ? { processStop: { kind: "process-exit" as const, requestId, process: pinned, signal: "SIGTERM" as const, observedAt: ts } } : {}), ...extra,
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
    /** The broker definition `cotal up` saves for a stack at `stackRoot`. Nothing is launched. */
    const brokerDefinition = (space: string, stackRoot: string) => {
      const config = join(stackRoot, ".cotal", "server.conf");
      writeFileSync(config, "", { mode: 0o600 });
      serviceDefinitionStore(space).commit("stack-broker", undefined, { schemaVersion: 1, space, launch: { type: "adapter", adapter: "nats-broker", options: { root: stackRoot, config, binary: fixtureExecutable, server: LIVE } }, readiness: { type: "adapter", timeoutMs: 30_000 } });
    };

    const runningRoot = stack("stackrun", "open", { broker: member("stackrun", "stack-broker", requireProcessIdentity(process.pid), false) }, "started");
    const before = registryFiles(), selected = getCurrent(), journal = readFileSync(stackJournalPath(runningRoot), "utf8");
    const running = await json(["space", "forget", "stackrun"]);
    check("a space whose controller stack still runs is LIFECYCLE_BLOCKED, naming the member and cotal down",
      refused(running, 2, "LIFECYCLE_BLOCKED") && /stack-broker/.test(running.env?.error?.message ?? "") && /cotal down/.test(running.env?.error?.remedy ?? ""), shown(running));
    check("...and since a stack's down keeps it as a prepared space, the remedy names forget again",
      running.env?.error?.remedy === `stop it with \`cotal down --yes\` in ${runningRoot} to explicitly confirm the stop. The stop keeps it as a prepared space there. Then run \`cotal space forget stackrun\` again.`, running.env?.error);
    const meshesRm = await run(["meshes", "rm", "stackrun"]);
    check("meshes rm of it refuses too, saying its down keeps it prepared and naming space forget",
      meshesRm.status === 1 && meshesRm.stderr.includes(`- \`cotal down\` there stops it and keeps it as a prepared space there, which \`cotal space forget stackrun\` then removes`) && findMesh("stackrun") !== undefined, meshesRm);
    check("...and it writes nothing: the registration, the selection and the stack journal stay",
      JSON.stringify(registryFiles()) === JSON.stringify(before) && getCurrent() === selected && readFileSync(stackJournalPath(runningRoot), "utf8") === journal, shown(running));

    // A controller stack whose folder was deleted while it ran: its instance records still show the
    // member running, so forget names the stop for a gone folder (#7325).
    const deletedRoot = stack("stackdeleted", "open", { broker: member("stackdeleted", "stack-broker", requireProcessIdentity(process.pid), false) }, "started");
    brokerDefinition("stackdeleted", deletedRoot);
    rmSync(deletedRoot, { recursive: true, force: true });
    const deleted = await json(["space", "forget", "stackdeleted"]);
    check("a controller stack whose folder is gone while a member runs is LIFECYCLE_BLOCKED, naming that member, and its record stays",
      refused(deleted, 2, "LIFECYCLE_BLOCKED") && (deleted.env?.error?.message ?? "").includes(`"stackdeleted" started in ${deletedRoot}, which no longer exists, but its stack's broker still runs`) && findMesh("stackdeleted") !== undefined, shown(deleted));
    check("...and the remedy is the gone-folder stop, which drops the record",
      deleted.env?.error?.remedy === "stop it with `cotal down --space stackdeleted --yes`, which also drops this record", deleted.env?.error);

    // The broker crashed: its record requires the exact-exit stop it never got, so its definition stays.
    const goneRoot = stack("stackgone", "open", { broker: member("stackgone", "stack-broker", gonePid, false, { kernelStopRequired: true }) }, "started");
    brokerDefinition("stackgone", goneRoot);
    const unsettled = await json(["space", "forget", "stackgone"]);
    const warned = (unsettled.env?.warnings ?? []).filter((w: { code: string }) => w.code === "STACK_MEMBER_UNSETTLED");
    check("a member proven gone with no stop receipt does not block forget, and the output warns",
      unsettled.status === 0 && unsettled.env?.result.kind === "space-forgotten" && findMesh("stackgone") === undefined &&
        warned.length === 1 && /stack-broker/.test(warned[0].message) && /never stopped cleanly/.test(warned[0].message), shown(unsettled));
    const kept = (unsettled.env?.warnings ?? []).filter((w: { code: string }) => w.code === "STACK_DEFINITIONS_KEPT");
    check("...its stack definition is kept, and the warning names the route that releases it",
      kept.length === 1 && /stack-broker/.test(kept[0].message) && kept[0].message.includes(`\`cotal down --yes\` in ${goneRoot}, then run \`cotal space forget stackgone\` again`) &&
        unsettled.env?.result.releasedDefinitions.length === 0 && serviceDefinitionStore("stackgone").read("stack-broker") !== undefined, shown(unsettled));
    check("...and its kept services do not repeat a stack definition the warning names", JSON.stringify(unsettled.env?.result.keptServices) === "[]", unsettled.env?.result);

    // Only a delivery member is recorded: its generic stop leaves the process-exit receipt this suite
    // can write, where the broker's and the manager's receipts carry native evidence.
    const doneRoot = stack("stackdone", "auth", { delivery: member("stackdone", "stack-delivery", gonePid, true) }, "stopped");
    brokerDefinition("stackdone", doneRoot);
    const doneJournal = readFileSync(stackJournalPath(doneRoot), "utf8");
    const settled = await json(["space", "forget", "stackdone"]);
    check("a space whose stack stopped with its receipts is forgotten",
      settled.status === 0 && settled.env?.result.kind === "space-forgotten" && settled.env.result.origin === "up" && findMesh("stackdone") === undefined &&
        settled.env.warnings.length === 0, shown(settled));
    check("...and the stack definitions saved for its root are removed, so another folder can start the name",
      JSON.stringify(settled.env?.result.releasedDefinitions) === JSON.stringify(["stack-broker"]) && serviceDefinitionStore("stackdone").read("stack-broker") === undefined, shown(settled));
    check("...and the stack journal, whose delivery instance forget did not remove, is left as it was", readFileSync(stackJournalPath(doneRoot), "utf8") === doneJournal, shown(settled));

    // A damaged registration must not hide the instances or prepared root that still name its stack.
    for (const active of [true, false]) {
      const name = active ? "damagedrunning" : "damagedstopped";
      const at = stack(name, "auth", { delivery: member(name, "stack-delivery", active ? requireProcessIdentity(process.pid) : gonePid, !active) }, active ? "started" : "stopped");
      brokerDefinition(name, at);
      recordPreparedSpace({ space: name, root: at, ts });
      const file = join(meshesDir(), `${spaceSegment(name)}.json`);
      const unrelatedFile = join(meshesDir(), `${spaceSegment("unrelateddamaged")}.json`);
      const good = readFileSync(file, "utf8");
      writeFileSync(file, `{"space":"${name}",`);
      writeFileSync(unrelatedFile, "not JSON\n");
      const result = await json(["space", "forget", name]);
      if (active) {
        check("a damaged registration with a running stack refuses before either record or definitions are removed",
          refused(result, 2, "LIFECYCLE_BLOCKED") && existsSync(file) && existsSync(unrelatedFile) && findPreparedSpace(name)?.root === at && serviceDefinitionStore(name).read("stack-broker") !== undefined, shown(result));
        writeFileSync(file, good);
        removePreparedSpace(name);
      } else {
        check("forget of a damaged registration releases stopped stack definitions and prepared state in one call",
          result.status === 0 && !existsSync(file) && existsSync(unrelatedFile) && findPreparedSpace(name) === undefined && serviceDefinitionStore(name).read("stack-broker") === undefined && result.env?.result.releasedDefinitions.includes("stack-broker"), shown(result));
      }
      rmSync(unrelatedFile);
    }

    // A prepared space releases the definitions saved for its own root, and only those.
    const prepRoot = realpathSync.native(projectRoot("prepdone")), otherRoot = realpathSync.native(projectRoot("prepother"));
    for (const [space, at] of [["prepdone", prepRoot], ["prepother", otherRoot]] as const) check(`rig: ${space} is prepared`, (await json(["space", "create", space, "--root", at])).status === 0);
    brokerDefinition("prepdone", prepRoot);
    brokerDefinition("prepother", prepRoot);
    if (process.getuid?.() !== 0) {
      const mode = statSync(prepRoot).mode & 0o777;
      chmodSync(prepRoot, 0o000);
      try {
        const denied = await json(["space", "forget", "prepdone"]);
        check("forget preserves the preparation when it cannot inspect the project for a running owner",
          refused(denied, 2, "PERMISSION_DENIED") && denied.env?.error?.message.includes("nothing was forgotten") &&
          denied.env.error.remedy.includes("restore access to the project folder") && findPreparedSpace("prepdone")?.root === prepRoot, shown(denied));
      } finally { chmodSync(prepRoot, mode); }
    }
    const control = join(prepRoot, ".cotal"), parked = join(prepRoot, "saved-control");
    renameSync(control, parked);
    try {
      symlinkSync(".cotal", control);
      try {
        const loop = await json(["space", "forget", "prepdone"]);
        check("a project record link loop blocks forget before any change", refused(loop, 2, "LIFECYCLE_BLOCKED") && loop.env?.error?.message.includes("nothing was forgotten") && findPreparedSpace("prepdone")?.root === prepRoot && lstatSync(control).isSymbolicLink(), shown(loop));
      } finally { unlinkSync(control); }
    } finally { renameSync(parked, control); }
    const prepared = await json(["space", "forget", "prepdone"]), other = await json(["space", "forget", "prepother"]);
    check("forgetting a prepared space removes the stack definitions saved for its root",
      prepared.status === 0 && JSON.stringify(prepared.env?.result.releasedDefinitions) === JSON.stringify(["stack-broker"]) && serviceDefinitionStore("prepdone").read("stack-broker") === undefined, shown(prepared));
    check("...and keeps one saved for another folder, without a warning",
      other.status === 0 && other.env?.result.releasedDefinitions.length === 0 && other.env.warnings.length === 0 && serviceDefinitionStore("prepother").read("stack-broker") !== undefined, shown(other));
    check("...and names it among the services it keeps for a later space of the name", JSON.stringify(other.env?.result.keptServices) === JSON.stringify(["stack-broker"]), other.env?.result);
  } else console.log("  - controller stack forget cells skipped: service records need Linux machine and boot identity");

  const stopped = await json(["space", "forget", "started"]);
  check("a stopped space this machine started is forgotten", stopped.status === 0 && stopped.env?.result.kind === "space-forgotten" && stopped.env.result.origin === "up" && findMesh("started") === undefined, shown(stopped));
  const manual = await json(["space", "forget", "open1"]);
  check("a space added by hand is forgotten; the selection stays", manual.status === 0 && manual.env?.result.selectionCleared === false && findMesh("open1") === undefined && getCurrent() === "keep", shown(manual));
  check("forgetting keeps the root's files", existsSync(join(root, ".cotal")));
  const human = await run(["space", "forget", "keep"]);
  check("forgetting the selected space clears the selection and says so", human.status === 0 && getCurrent() === undefined && /forgot keep/.test(human.stdout) && /no space is selected now/.test(human.stdout), shown(human));

  // A space's per-space preferences go with it. A preferences file that cannot be read refuses before
  // anything is forgotten; one that cannot be written after the record is gone leaves the run partial.
  const prefsDir = join(home, ".config", "cotal"), prefsFile = join(prefsDir, "preferences.json");
  const saved = () => (JSON.parse(readFileSync(prefsFile, "utf8")) as { spaces: Record<string, Record<string, string>> }).spaces;
  const setUp: number[] = [];
  // These are open spaces, so the open broker serves them before they are added.
  const { setupSpaceStreams } = await import("@cotal-ai/core");
  for (const space of ["withprefs", "shownprefs", "badprefs", "lockedprefs", "exposedprefs"]) await setupSpaceStreams({ servers: LIVE, space });
  for (const name of ["withprefs", "shownprefs", "badprefs", "lockedprefs", "exposedprefs"]) setUp.push((await json(["space", "add", name, "--server", LIVE, "--root", root])).status ?? -1);
  for (const [name, key, value] of [["withprefs", "persona", "rev"], ["withprefs", "harness", "opencode"], ["shownprefs", "persona", "rev"], ["badprefs", "persona", "rev"], ["lockedprefs", "persona", "rev"], ["exposedprefs", "persona", "rev"]])
    setUp.push((await json(["config", "set", key!, value!, "--space", name!])).status ?? -1);
  check("five spaces are added and their preferences saved", setUp.every((status) => status === 0), setUp);
  // The chat sessions the terminal app remembered for a space go with it too.
  const { mintLifecycleUid } = await import("@cotal-ai/core");
  const { rememberChatSession, rememberedChatSessions } = await import("@cotal-ai/workspace/chat");
  const remember = (space: string, n: number) => rememberChatSession({ space, server: LIVE }, { mode: "open", space, principal: `local.lead${n}`, lifecycleUid: mintLifecycleUid(), label: "lead", allowSubscribe: [], allowPublish: [] });
  remember("withprefs", 1);
  remember("withprefs", 2);
  remember("shownprefs", 3);
  const withPrefs = await json(["space", "forget", "withprefs"]);
  check("forget removes the space's preferences, lists each key and value, and keeps another space's",
    withPrefs.status === 0 && JSON.stringify(withPrefs.env?.result.removedPreferences) === JSON.stringify({ persona: "rev", harness: "opencode" }) && saved().withprefs === undefined && saved().shownprefs?.persona === "rev", shown(withPrefs));
  check("forget removes the chat sessions the terminal app remembered for the space, counts them, and keeps another space's",
    withPrefs.env?.result.removedChatSessions === 2 && rememberedChatSessions({ space: "withprefs", server: LIVE }).sessions.length === 0 && rememberedChatSessions({ space: "shownprefs", server: LIVE }).sessions.length === 1, shown(withPrefs));
  const shownPrefs = await run(["space", "forget", "shownprefs"]);
  check("the receipt names each removed value and the config set that restores one",
    shownPrefs.status === 0 && shownPrefs.stdout.includes("removed its per-space preferences: persona=rev - `cotal config set <key> <value> --space shownprefs` sets one again"), shown(shownPrefs));
  check("the receipt says how many remembered chat sessions it removed", shownPrefs.stdout.includes("removed the 1 chat session(s) the terminal app remembered for it"), shown(shownPrefs));
  const prefsText = readFileSync(prefsFile, "utf8");
  writeFileSync(prefsFile, "{");
  const badPrefs = await json(["space", "forget", "badprefs"]);
  writeFileSync(prefsFile, prefsText);
  check("a preferences file that cannot be read refuses the forget and keeps the record", refused(badPrefs, 1, "SCHEMA_INVALID") && findMesh("badprefs") !== undefined, shown(badPrefs));
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    chmodSync(prefsDir, 0o500);
    const locked = await json(["space", "forget", "lockedprefs"]);
    chmodSync(prefsDir, 0o700);
    check("preferences that cannot be removed leave the forget partial, exit 4, naming config unset",
      locked.status === 4 && locked.env?.outcome === "partial" && findMesh("lockedprefs") === undefined && saved().lockedprefs?.persona === "rev" &&
        (locked.env?.error?.remedy ?? "").includes("cotal config unset <key> --space lockedprefs"), shown(locked));
    // A folder other accounts can write refuses the removal, and the remedy protects it first.
    chmodSync(prefsDir, 0o757);
    const exposed = await json(["space", "forget", "exposedprefs"]);
    chmodSync(prefsDir, 0o700);
    check("preferences in a folder other accounts can write are kept, and the partial's remedy starts with its chmod",
      exposed.status === 4 && exposed.env?.outcome === "partial" && findMesh("exposedprefs") === undefined && saved().exposedprefs?.persona === "rev" &&
        (exposed.env?.error?.remedy ?? "").startsWith(`chmod o-w ${prefsDir}; then see them with`), shown(exposed));
  }
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
      up.env?.error?.remedy === `chmod go-w ${folder} ${parent}` && readdirSync(join(folder, ".cotal")).length === 0 && JSON.stringify(registryFiles()) === JSON.stringify(before), shown(up));
  rmSync(exposed, { recursive: true, force: true });
}

// ── A controller stack running under another Cotal home ───────────────────────────────────────────────
// The root's journal names member instances this home holds no record of, and its manager record
// fronts a live process of this suite, so the stack runs under another COTAL_HOME.
if (process.platform === "linux") {
  const awayRoot = realpathSync.native(projectRoot("away"));
  const ts = new Date().toISOString();
  const row = (role: "broker" | "auth" | "delivery" | "manager") =>
    role === "broker" || role === "manager" ? { role, definition: `stack-${role}`, instanceId: randomUUID(), state: "started" as const } : { role, definition: `stack-${role}`, instanceId: null, state: "not-attempted" as const };
  writeStackJournal(awayRoot, undefined, {
    schemaVersion: 1, kind: "cotal-stack-controller", root: awayRoot, space: "away", server: LIVE, mode: "open",
    members: [row("broker"), row("auth"), row("delivery"), row("manager")],
    operation: { id: randomUUID(), kind: "up", phase: "completed", recordedAt: ts, withAgents: false }, updatedAt: ts,
  });
  const awayManager = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  standIns.push(awayManager);
  const awayRecord = canonicalLocalProcessPath(MANAGER_PIDFILE, { root: awayRoot, space: "away" });
  writeFileSync(awayRecord, String(awayManager.pid), { mode: 0o600 });
  const journal = readFileSync(stackJournalPath(awayRoot), "utf8"), before = registryFiles();
  const otherHome = (r: Awaited<ReturnType<typeof json>>) =>
    refused(r, 2, "TARGET_UNAVAILABLE") && /member records.*missing|member records are missing/.test(r.env?.error?.message ?? "") && /COTAL_HOME set to the Cotal home the stack was started under/.test(r.env?.error?.remedy ?? "");
  const unchanged = () => readFileSync(stackJournalPath(awayRoot), "utf8") === journal && JSON.stringify(registryFiles()) === JSON.stringify(before) && awayManager.exitCode === null;
  const create = await json(["space", "create", "away", "--root", awayRoot]);
  check("space create over a stack running under another Cotal home refuses TARGET_UNAVAILABLE with the COTAL_HOME step, and prepares nothing",
    otherHome(create) && findPreparedSpace("away") === undefined && unchanged(), shown(create));
  for (const args of [["down", "--yes"], ["down", "--dry-run"]]) {
    const stop = await json(args, awayRoot);
    check(`${args.join(" ")} there refuses TARGET_UNAVAILABLE with the COTAL_HOME step, and stops nothing`, otherHome(stop) && unchanged(), shown(stop));
  }
  // Another space selected does not release the folder to it: this stack runs, under another home,
  // so it is not a stopped space of this folder that its `cotal up` restarts.
  {
    const selected = getCurrent();
    recordMesh({ space: "awaysel", server: DEAD, root: home, mode: "open", origin: "manual", ts });
    setAdoptedCurrent("awaysel");
    const read = await json(["ps"], awayRoot), text = await run(["who"], {}, awayRoot);
    if (selected === undefined) clearCurrent(); else setCurrent(selected);
    removeMesh("awaysel");
    check("ps and who there with another space selected still refuse with the COTAL_HOME step, naming no stopped space of this folder",
      otherHome(read) && text.status === 2 && /member records.*missing|member records are missing/.test(text.stderr) && !/this folder holds|restart it with `cotal up`/.test(text.stdout + text.stderr) && unchanged(), { ps: shown(read), who: shown(text) });
  }
  // A space this home prepared at the root does not hide the other home.
  recordPreparedSpace({ space: "away", root: awayRoot, ts });
  const previousSelection = readCurrentSelection();
  clearCurrent();
  const status = await json(["status"], awayRoot);
  if (previousSelection) {
    if (previousSelection.source === "adopted") setAdoptedCurrent(previousSelection.space); else setCurrent(previousSelection.space);
  }
  const broker = status.env?.result?.folder?.processes?.find((row: { name: string }) => row.name === "nats");
  const warning = status.env?.warnings?.find((row: { code: string }) => row.code === "FOLDER_BROKER_UNAVAILABLE");
  check("status is partial when a prepared root has a live stack with missing member records and no recorded home",
    status.status === 4 && status.env?.error?.code === "OPERATION_PARTIAL" && broker?.state === "unknown" &&
      warning?.target?.root === awayRoot && warning?.target?.space === "away" && /member records are missing/.test(warning.message ?? "") &&
      status.env?.result?.selected?.code === "not-started" && /member records are missing/.test(status.env.result.selected.message ?? "") &&
      status.env?.result?.hints?.some((hint: string) => hint.includes("COTAL_HOME set to the Cotal home the stack was started under")),
    { status: status.status, broker, selected: status.env?.result?.selected, warnings: status.env?.warnings, error: status.env?.error, hints: status.env?.result?.hints });
  removePreparedSpace("away");
  await new Promise((done) => { awayManager.once("exit", done); awayManager.kill("SIGKILL"); });
  rmSync(awayRecord);
} else console.log("  - other Cotal home cells skipped: a controller stack needs Linux machine and boot identity");

// ── A broker bind that does not serve the recorded address ─────────────────────────────────────────────
// A stack whose recorded bind host, or the default 127.0.0.1 when none was recorded, does not serve
// its recorded address starts a broker no client reaches. Made here from a stopped stack's journal,
// it refuses up before anything starts and names the --host that replaces the recorded one.
if (process.platform === "linux") {
  const pinned = join(home, "pinned");
  mkdirSync(pinned);
  const selected = getCurrent();
  const server = `nats://127.0.0.1:${await freePort()}`;
  const created = await json(["space", "create", "pinned"], pinned);
  const sandbox = recordSmokeSandbox({ root: pinned, cotalHome: process.env.COTAL_HOME!, xdgConfigHome: runEnv.XDG_CONFIG_HOME });
  const started = await json(["up", "--detach", "--open", "--no-manager", "--server", server], pinned);
  const runtimeDir = join(pinned, "runtime");
  mkdirSync(runtimeDir, { mode: 0o700 });
  const fixtureEnv = { ...runEnv, XDG_RUNTIME_DIR: runtimeDir };
  const startForeground = (args: string[]) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: pinned, env: fixtureEnv, stdio: "ignore" });
    teardownOnSignal(child);
    return { child, closed: new Promise<void>((resolve) => child.once("close", () => resolve())) };
  };
  let peer: ReturnType<typeof startForeground> | undefined;
  let manager: ReturnType<typeof startForeground> | undefined;
  let stopped: Awaited<ReturnType<typeof run>>;
  try {
    peer = startForeground(["join", "--name", "roster-peer", "--channel", "general"]);
    let roster = await run(["who", "--plain"], {}, pinned);
    for (let i = 0; i < 20 && !roster.stdout.includes("roster-peer") && peer.child.exitCode === null; i++)
      roster = await run(["who", "--plain"], {}, pinned);
    const brokerOnly = await run(["status", "--plain"], {}, pinned);
    const absent = await json(["ps"], pinned);
    check("broker-only status points to the live roster, not the unavailable managed-agent list",
      brokerOnly.status === 0 && /cotal who --space pinned\s+See the live roster/.test(brokerOnly.stdout) && !/^\s*(?:pnpm )?cotal ps\s/m.test(brokerOnly.stdout)
        && roster.status === 0 && /^\s*roster-peer.*\bno\b/m.test(roster.stdout) && refused(absent, 2, "TARGET_UNAVAILABLE"),
      { status: brokerOnly, who: roster, ps: shown(absent) });

    manager = startForeground(["supervise", "--space", "pinned", "--server", server, "--console-port", String(await freePort())]);
    let ps = await run(["ps", "--plain"], {}, pinned);
    for (let i = 0; i < 20 && ps.status !== 0 && manager.child.exitCode === null; i++) ps = await run(["ps", "--plain"], {}, pinned);
    const instanceId = /^\s*instance:\s+(\S+)/m.exec(ps.stdout)?.[1];
    const outside = await run(["status", "--plain"], {}, pinned);
    const observation = (await json(["status"], pinned)).env?.result?.outsideStackManager;
    check("status identifies the answering manager outside a broker-only stack",
      ps.status === 0 && instanceId !== undefined && outside.status === 0
        && outside.stdout.includes(`answering - instance ${instanceId} - outside this stack`)
        && !outside.stdout.includes("bare `cotal up` adds it") && /cotal ps --space pinned\s+List managed agents/.test(outside.stdout)
        && observation?.endpoint === "answered" && observation.instanceId === instanceId,
      { status: outside, ps, observation });
  } finally {
    for (const child of [manager, peer]) {
      if (!child) continue;
      child.child.kill();
      await child.closed;
    }
    assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: pinned, env: runEnv });
    stopped = await run(["down", "--yes"], {}, pinned);
  }
  check("a stack is started and stopped at a fresh root", created.status === 0 && started.status === 0 && stopped.status === 0, { created: shown(created), started: shown(started), stopped: shown(stopped) });
  const journalPath = stackJournalPath(pinned);
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  writeFileSync(journalPath, JSON.stringify({ ...journal, broker: { ...journal.broker, host: "127.0.0.2" } }));
  const pinnedBytes = readFileSync(journalPath, "utf8");
  for (const args of [["up", "--detach", "--no-manager"], ["up", "--detach", "--no-manager", "--host", "127.0.0.3"]]) {
    const r = await json(args, pinned);
    check(`${args.join(" ")} over a recorded bind host that does not serve the address refuses CONFLICT, names cotal up --host 127.0.0.1, and starts nothing`,
      refused(r, 2, "CONFLICT") && /broker binds 127\.0\.0\.2, which does not serve/.test(r.env?.error?.message ?? "") && (r.env?.error?.remedy ?? "").includes("cotal up --host 127.0.0.1") &&
        readFileSync(journalPath, "utf8") === pinnedBytes, shown(r));
  }
  const recovered = await json(["up", "--detach", "--no-manager", "--host", "127.0.0.1"], pinned);
  check("the named --host replaces the recorded bind host and starts the stack", recovered.status === 0 && JSON.parse(readFileSync(journalPath, "utf8")).broker?.host === "127.0.0.1", shown(recovered));
  assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: pinned, env: runEnv });
  const down = await run(["down", "--yes"], {}, pinned);
  check("and down stops it", down.status === 0, shown(down));
  // An address other than 127.0.0.1 recorded with no bind host: the broker binds the default.
  const otherAddress = server.replace("127.0.0.1", "127.0.0.2");
  const { host: _host, ...unbound } = JSON.parse(readFileSync(journalPath, "utf8")).broker;
  writeFileSync(journalPath, JSON.stringify({ ...JSON.parse(readFileSync(journalPath, "utf8")), server: otherAddress, broker: unbound }));
  const unboundBytes = readFileSync(journalPath, "utf8");
  const bare = await json(["up", "--detach", "--no-manager"], pinned);
  check("bare up over a recorded 127.0.0.2 address with no bind host refuses CONFLICT, names cotal up --host 127.0.0.2, and starts nothing",
    refused(bare, 2, "CONFLICT") && /broker binds 127\.0\.0\.1, as no bind host was recorded, which does not serve/.test(bare.env?.error?.message ?? "") &&
      (bare.env?.error?.remedy ?? "").includes("cotal up --host 127.0.0.2") && readFileSync(journalPath, "utf8") === unboundBytes, shown(bare));
  const bound = await json(["up", "--detach", "--no-manager", "--host", "127.0.0.2"], pinned);
  check("--host 127.0.0.2 is recorded and starts the stack there", bound.status === 0 && JSON.parse(readFileSync(journalPath, "utf8")).broker?.host === "127.0.0.2", shown(bound));
  assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: pinned, env: runEnv });
  const downAgain = await run(["down", "--yes"], {}, pinned);
  check("and down stops it again", downAgain.status === 0, shown(downAgain));
  // Its first up selected it; the cells after this one start from the selection before it.
  if (selected === undefined) clearCurrent(); else setCurrent(selected);
} else console.log("  - recorded bind host cells skipped: a controller stack needs Linux machine and boot identity");

// ── up says when it selects the space it started ───────────────────────────────────────────────────────
if (process.platform === "linux") {
  const selected = getCurrent();
  clearCurrent();
  const first = join(home, "selfirst"), second = join(home, "selsecond");
  mkdirSync(first);
  mkdirSync(second);
  const server = `nats://127.0.0.1:${await freePort()}`;
  await json(["space", "create", "selfirst"], first);
  await json(["space", "create", "selsecond"], second);
  const sandbox = recordSmokeSandbox({ root: first, cotalHome: process.env.COTAL_HOME!, xdgConfigHome: runEnv.XDG_CONFIG_HOME });
  const up = await run(["up", "--detach", "--open", "--no-manager", "--server", server], {}, first);
  check("with nothing selected, up selects the space it started and says so",
    up.status === 0 && getCurrent() === "selfirst" && up.stdout.includes(`automatically selected "selfirst"`), shown(up));
  const offline = await json(["space", "add", "seloffline", "--force", "--server", DEAD, "--root", second], second);
  const liveTarget = await json(["who"], second);
  const offlineIdentity = await run(["whoami", "--plain"], {}, second);
  const offlineIdentityJson = await json(["whoami"], second);
  const explicitIdentity = await run(["whoami", "--space", "selfirst", "--plain"], {}, second);
  const uncertainty = "cannot check whether this folder takes precedence";
  check("whoami reports local identity without claiming an offline folder overrides the adopted selection",
    offline.status === 0 && liveTarget.status === 0 && liveTarget.env?.target?.space === "selfirst" &&
      offlineIdentity.status === 4 && offlineIdentity.stdout.startsWith("Mesh: seloffline\n") &&
      offlineIdentity.stdout.includes(uncertainty) && !offlineIdentity.stdout.includes("applies outside it") &&
      offlineIdentityJson.status === 4 && offlineIdentityJson.env?.target?.space === "seloffline" &&
      offlineIdentityJson.env?.warnings.some((w: { code: string; message: string }) => w.code === "BROKER_NOT_PROBED" && w.message.includes(uncertainty)) &&
      explicitIdentity.status === 0 && explicitIdentity.stdout.startsWith("Mesh: selfirst\n") && !explicitIdentity.stdout.includes(uncertainty),
    { liveTarget: shown(liveTarget), offlineIdentity: shown(offlineIdentity), json: shown(offlineIdentityJson), explicit: shown(explicitIdentity) });
  check("forget the offline registration before starting the prepared space", (await json(["space", "forget", "seloffline"], second)).status === 0);
  assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: first, env: runEnv });
  await run(["down", "--yes"], {}, first);
  const secondSandbox = recordSmokeSandbox({ root: second, cotalHome: process.env.COTAL_HOME!, xdgConfigHome: runEnv.XDG_CONFIG_HOME });
  const kept = await run(["up", "--detach", "--open", "--no-manager", "--server", server, "--max-payload", "131072"], {}, second);
  check("with another space selected, up keeps it and says it stays selected outside this folder",
    kept.status === 0 && getCurrent() === "selfirst" && kept.stdout.includes(`"selsecond" up; "selfirst" stays automatically selected outside this folder`) && !kept.stdout.includes(`selected "selsecond"`), shown(kept));
  const before = await json(["space"], second);
  check("space inventory marks the running folder target without changing the selection",
    before.status === 0 && before.env?.result.current === "selfirst" && before.env.result.folder === "selsecond", shown(before));
  const added = await json(["space", "add", "seloffline", "--force", "--server", DEAD, "--root", second], second);
  const who = await json(["who"], second);
  const show = await json(["space", "show"], second);
  const inventory = await json(["space"], second);
  const status = await json(["status"], second);
  check("the only running registration in this folder takes precedence over an adopted selection",
    added.status === 0 && who.status === 0 && who.env?.target?.space === "selsecond" &&
      readCurrentSelection()?.source === "adopted" && getCurrent() === "selfirst" && findMesh("seloffline")?.server === DEAD, shown(who));
  const multipleIdentity = await json(["whoami"], second);
  check("whoami keeps a successful identity report when multiple folder registrations compete with the adopted selection",
    multipleIdentity.status === 0 && multipleIdentity.env?.target?.space === "selfirst" &&
      multipleIdentity.env?.warnings.some((w: { code: string; message: string }) => w.code === "SELECTION_NOT_FOLDER_SPACE" && w.message.includes(uncertainty)), shown(multipleIdentity));
  check("space inventory marks the roster target and still lists the offline registration",
    inventory.status === 0 && inventory.env?.result.current === "selfirst" && inventory.env.result.folder === who.env?.target?.space &&
      inventory.env.result.items.some((row: { space: string; check: string }) => row.space === "seloffline" && row.check === "unreachable"), shown(inventory));
  check("status inventory also marks the roster target while keeping the saved selection",
    status.status === 0 && status.env?.result.meshes.current === "selfirst" && status.env.result.meshes.folder === who.env?.target?.space, shown(status));
  check("space show still refuses to choose among the folder's registrations", refused(show, 2, "TARGET_AMBIGUOUS"), shown(show));
  check("forget the offline registration", (await json(["space", "forget", "seloffline"], second)).status === 0);
  assertSmokeSandboxDown(secondSandbox, ["down", "--yes"], { cwd: second, env: runEnv });
  const stopped = await run(["down", "--yes"], {}, second);
  check("and down stops it", stopped.status === 0, shown(stopped));
  const identity = await run(["whoami", "--space", "selsecond", "--plain"], {}, second);
  const restart = /start it again with `(?:pnpm )?cotal (up --no-manager)`/.exec(identity.stdout);
  check("whoami names the stopped space and tells how to restart the broker without a Manager",
    identity.status === 0 && /^  server: +stopped$/m.test(identity.stdout) && identity.stdout.includes('"selsecond" is stopped') &&
      restart !== null && identity.stdout.includes(`in ${second}`), shown(identity));
  if (restart?.[1]) {
    const restarted = await json(restart[1].split(" "), second);
    check("the printed restart works with the saved payload below the Manager minimum", restarted.status === 0, shown(restarted));
    assertSmokeSandboxDown(secondSandbox, ["down", "--yes"], { cwd: second, env: runEnv });
    check("down stops the restarted broker", (await json(["down", "--yes"], second)).status === 0);
  }
  if (selected === undefined) clearCurrent(); else setCurrent(selected);
} else console.log("  - up selection cells skipped: a controller stack needs Linux machine and boot identity");

// ── A saved service stays with the space's name ────────────────────────────────────────────────────────
// Saved services belong to the space name, so a forget keeps them and names them, and the next space
// of that name, in another folder, names them on its up as inherited. An up in the folder that saved
// one names it without saying a space was forgotten.
if (process.platform === "linux") {
  const selected = getCurrent();
  const first = join(home, "inheritfirst"), second = join(home, "inheritsecond");
  mkdirSync(first);
  mkdirSync(second);
  const server = `nats://127.0.0.1:${await freePort()}`, definition = join(home, "inherit-tick.json");
  writeFileSync(definition, JSON.stringify({ schemaVersion: 1, space: "inherit", launch: { type: "process", executable: fixtureExecutable, args: [], cwd: first }, readiness: { type: "process", timeoutMs: 3000 } }));
  await json(["space", "create", "inherit"], first);
  const sandbox = recordSmokeSandbox({ root: first, cotalHome: process.env.COTAL_HOME!, xdgConfigHome: runEnv.XDG_CONFIG_HOME });
  const fresh = await json(["up", "--detach", "--open", "--no-manager", "--server", server], first);
  check("an up whose space has no saved service of its own names none", fresh.status === 0 && JSON.stringify(fresh.env?.result.savedServices) === "[]", shown(fresh));
  const added = await json(["service", "add", "tick", "--file", definition], first);
  check("rig: a service is saved for the space", added.status === 0, shown(added));
  const own = await json(["up", "--detach", "--open", "--no-manager", "--server", server], first);
  check("an up whose space saved a service here names it, and names none as inherited", own.status === 0 && JSON.stringify(own.env?.result.savedServices) === JSON.stringify(["tick"]) && JSON.stringify(own.env?.result.inheritedServices) === "[]", shown(own));
  const ownText = await run(["up", "--detach", "--open", "--no-manager", "--server", server], {}, first);
  check("...and its text says up does not start it without saying a space was forgotten",
    ownText.status === 0 && ownText.stdout.includes("saved services up does not start: tick") && ownText.stdout.includes("`cotal service show <name> --space inherit` shows what one runs") && !ownText.stdout.includes("forgotten"), shown(ownText));
  assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: first, env: runEnv });
  await run(["down", "--yes"], {}, first);
  const forgot = await run(["space", "forget", "inherit"], {}, first);
  check("forget keeps the saved service, names it and the remove that forgets it in a later space of the name",
    forgot.status === 0 && serviceDefinitionStore("inherit").read("tick") !== undefined &&
      forgot.stdout.includes("kept its saved services (tick): a later space named inherit inherits them, and `cotal service remove <name> --space inherit --yes` in that space forgets one"), shown(forgot));
  await json(["space", "create", "inherit"], second);
  const secondSandbox = recordSmokeSandbox({ root: second, cotalHome: process.env.COTAL_HOME!, xdgConfigHome: runEnv.XDG_CONFIG_HOME });
  const later = await json(["up", "--detach", "--open", "--no-manager", "--server", server], second);
  check("the next space of that name, in another folder, names the service it inherits on its up", later.status === 0 && JSON.stringify(later.env?.result.savedServices) === JSON.stringify(["tick"]) && JSON.stringify(later.env?.result.inheritedServices) === JSON.stringify(["tick"]), shown(later));
  const text = await run(["up", "--detach", "--open", "--no-manager", "--server", server], {}, second);
  check("...and its text receipt says up does not start it, that a forgotten space left it, and the remove that forgets it",
    text.status === 0 && text.stdout.includes("saved services up does not start: tick") && text.stdout.includes("tick came from a space forgotten under the name inherit in another folder and does not start here; `cotal service remove <name> --space inherit --yes` forgets one"), shown(text));
  assertSmokeSandboxDown(secondSandbox, ["down", "--yes"], { cwd: second, env: runEnv });
  await run(["down", "--yes"], {}, second);
  const removed = await json(["service", "remove", "tick", "--space", "inherit", "--yes"], second);
  check("the remove the forget named forgets it there", removed.status === 0 && serviceDefinitionStore("inherit").read("tick") === undefined, shown(removed));
  const clean = await json(["space", "forget", "inherit"], second);
  check("a forget whose space has no saved service left keeps none", clean.status === 0 && JSON.stringify(clean.env?.result.keptServices) === "[]", shown(clean));
  if (selected === undefined) clearCurrent(); else setCurrent(selected);
} else console.log("  - saved service inheritance cells skipped: a controller stack needs Linux machine and boot identity");

// ── Preparing a space with create, then starting it with up ────────────────────────────────────────────
{
  const parent = join(home, "new-project-parent");
  const project = join(parent, "nested");
  const missingAdoption = await json(["space", "create", "new-root", "--root", project, "--adopt"]);
  check("--adopt refuses a missing root without creating it", refused(missingAdoption, 1, "USAGE_INVALID") && !existsSync(parent), shown(missingAdoption));
  const previousUmask = process.umask(0o000);
  const creating = json(["space", "create", "new-root", "--root", project]);
  process.umask(previousUmask);
  const created = await creating;
  check("create prepares a missing explicit root and lists the folder it created",
    created.status === 0 && findPreparedSpace("new-root")?.root === project &&
    existsSync(join(project, ".cotal", "agents", "default.md")) &&
    created.env?.result.written.some((w: { what: string; path: string }) => w.what === "project folder" && w.path === project), shown(created));
  if (process.platform !== "win32") {
    check("under umask 000, both new project directories are private", created.status === 0 && [parent, project].every((path) => (statSync(path).mode & 0o777) === 0o700));
    chmodSync(parent, 0o777);
    const unsafe = join(parent, "not-created");
    const rejected = await json(["space", "create", "unsafe-root", "--root", unsafe]);
    chmodSync(parent, 0o700);
    check("create refuses a missing root below an unsafe ancestor without creating it", refused(rejected, 2, "PERMISSION_DENIED") && !existsSync(unsafe), shown(rejected));
  }
  removePreparedSpace("new-root");
}
{
  const project = projectRoot("retry-create");
  const agents = join(project, ".cotal", "agents");
  writeFileSync(agents, "obstacle");
  const failed = await json(["space", "create", "retry-space"], project);
  const prepared = findPreparedSpace("retry-space");
  const file = join(preparedSpacesDir(), `${spaceSegment("retry-space")}.json`);
  const before = prepared && readFileSync(file, "utf8");
  check("a failed persona seed leaves the preparation in place", failed.status === 3 && failed.env?.error?.code === "OPERATION_UNKNOWN" && prepared?.root === project, shown(failed));
  renameSync(agents, `${agents}.old`);
  const retried = await json(["space", "create", "retry-space"], project);
  check("the same create fills in just the default persona without replacing the prepared record",
    retried.status === 0 && existsSync(join(agents, "default.md")) && retried.env?.result.preparedAt === prepared?.ts &&
    retried.env?.result.written.map((w: { what: string }) => w.what).join() === "default persona" && before === readFileSync(file, "utf8"), shown(retried));
  check("the same name in another root still conflicts", refused(await json(["space", "create", "retry-space"], root), 2, "CONFLICT"));
  removePreparedSpace("retry-space");
}
{
  const before = registryFiles();
  const fresh = join(home, "fresh");
  mkdirSync(fresh);
  // Under a group-writable umask, which the binary inherits at spawn.
  const previousUmask = process.umask(0o002);
  const creating = json(["space", "create", "demo"], fresh);
  process.umask(previousUmask);
  const created = await creating;
  const r = created.env?.result;
  check("create prepares the space in this folder and makes its .cotal: ok, nothing registered", created.status === 0 && created.env?.outcome === "ok" && r?.kind === "space-created" && r.space === "demo" && r.root === fresh && existsSync(join(fresh, ".cotal")) && findPreparedSpace("demo")?.root === fresh && JSON.stringify(registryFiles()) === JSON.stringify(before), shown(created));
  check("create leaves the selection as it is", getCurrent() === undefined && r?.current === false, getCurrent());
  const personaFile = join(fresh, ".cotal", "agents", "default.md");
  check("create writes the default persona into the root's catalog and lists it with the prepared record",
    existsSync(personaFile) && r?.written?.some((w: { what: string; path: string }) => w.what === "default persona" && w.path.endsWith(join(".cotal", "agents", "default.md"))) &&
      r.written.some((w: { what: string }) => w.what === "prepared space"), r?.written);
  if (process.platform !== "win32") {
    const modes = [".cotal", join(".cotal", "agents")].map((p) => (statSync(join(fresh, p)).mode & 0o777).toString(8));
    check("under umask 0002, create makes .cotal and its persona catalog 0700", modes.join(",") === "700,700", modes);
  }
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
  // A copy of that folder keeps the account, while the registration still names the original as the
  // space's root, so the refusal says where the records came from.
  recordMesh({ space: "held", server: DEAD, root: accountRoot, mode: "auth", origin: "manual", ts: new Date().toISOString() });
  const accountCopy = join(home, "account-copy");
  spawnSync("cp", ["-a", accountRoot, accountCopy]);
  const inCopy = await json(["space", "create", "other", "--root", accountCopy]);
  removeMesh("held");
  rmSync(accountCopy, { recursive: true, force: true });
  check("a copy of a folder whose records name another root is CONFLICT, naming that root",
    refused(inCopy, 2, "CONFLICT") && inCopy.env?.error?.message === `${accountCopy} holds records copied or moved from ${accountRoot}, the root of "held"`, shown(inCopy));
  const heldElsewhere = await json(["space", "add", "alias", "--server", AUTH_LIVE, "--root", accountRoot]);
  check("an auth broker whose --root holds another space's trust is refused naming that space first",
    refused(heldElsewhere, 2, "DEPENDENCY_UNAVAILABLE") && heldElsewhere.env?.error?.message === "the broker requires auth, but this folder holds trust for a different space" && heldElsewhere.env.error.remedy.includes('holds the trust for "held", not "alias"') && heldElsewhere.env.error.remedy.includes(AUTH_LIVE), shown(heldElsewhere));
  check("the home folder is CONFLICT", refused(await json(["space", "create", "other", "--root", home]), 2, "CONFLICT"));
  const rootFile = join(home, "plain-file-root");
  writeFileSync(rootFile, "keep");
  check("a --root that is a regular file is USAGE_INVALID", refused(await json(["space", "create", "other", "--root", rootFile]), 1, "USAGE_INVALID") && readFileSync(rootFile, "utf8") === "keep");
  // A --root through a symlink keeps its refusal, and the Next names the physical path it resolves to.
  if (process.platform !== "win32") {
    const physicalRoot = join(home, "physical-root");
    mkdirSync(physicalRoot);
    const linkedRoot = join(home, "linked-root");
    symlinkSync(physicalRoot, linkedRoot);
    const throughLink = await json(["space", "create", "other", "--root", linkedRoot]);
    check("a --root through a symlink is PERMISSION_DENIED, with its physical path as the Next and nothing written",
      refused(throughLink, 2, "PERMISSION_DENIED") && (throughLink.env?.error?.message ?? "").endsWith(`${linkedRoot} is a symbolic link`) &&
        throughLink.env?.error?.remedy === `use the physical path ${realpathSync.native(physicalRoot)}` && !existsSync(join(physicalRoot, ".cotal")) && findPreparedSpace("other") === undefined, shown(throughLink));
  }
  // A folder this account cannot write is refused before anything is written. Root can write anywhere.
  if (process.getuid?.() !== 0) {
    const readOnly = join(home, "read-only");
    mkdirSync(readOnly, { mode: 0o500 });
    const denied = await json(["space", "create", "other", "--root", readOnly]);
    check("a --root this account cannot write is PERMISSION_DENIED, exit 2, with nothing written",
      refused(denied, 2, "PERMISSION_DENIED") && (denied.env?.error?.message ?? "").startsWith(`${readOnly} is not writable by this account`) && !existsSync(join(readOnly, ".cotal")) && findPreparedSpace("other") === undefined, shown(denied));
    chmodSync(readOnly, 0o700);
    if (process.platform !== "win32") {
      const child = join(readOnly, "project");
      mkdirSync(child);
      chmodSync(readOnly, 0o600);
      try {
        const inaccessible = await json(["space", "create", "other", "--root", child]);
        check("create distinguishes an inaccessible root from a non-directory", refused(inaccessible, 2, "PERMISSION_DENIED") && inaccessible.env?.target?.root === child && inaccessible.env.error.remedy.includes("parent directories"), shown(inaccessible));
      } finally { chmodSync(readOnly, 0o700); }
      check("create wrote nothing below the inaccessible parent", !existsSync(join(child, ".cotal")) && findPreparedSpace("other") === undefined);
    }
    // A Cotal home this account cannot write is refused too, and the empty .cotal the attempt made is removed.
    const lockedHome = join(home, "locked-home");
    const homeless = join(home, "homeless");
    mkdirSync(lockedHome, { mode: 0o500 });
    mkdirSync(homeless);
    const noHome = await run(["space", "create", "other", "--root", homeless, "--json"], { COTAL_HOME: join(lockedHome, ".cotal") });
    const noHomeEnv = JSON.parse(noHome.stdout || "{}") as Record<string, any>;
    check("a Cotal home this account cannot write is PERMISSION_DENIED, exit 2, naming it, with nothing left in the root",
      refused({ ...noHome, env: noHomeEnv }, 2, "PERMISSION_DENIED") && (noHomeEnv.error?.message ?? "").startsWith(`this account cannot write this machine's Cotal home ${join(lockedHome, ".cotal")}`) && readdirSync(homeless).length === 0 && findPreparedSpace("other") === undefined, shown(noHome));
    chmodSync(lockedHome, 0o700);
  }
  // A .cotal that links to a folder that does not exist is refused naming both, with nothing written.
  const dangling = join(home, "dangling");
  mkdirSync(dangling);
  symlinkSync(join(home, "nowhere"), join(dangling, ".cotal"));
  const linked = await json(["space", "create", "other", "--root", dangling]);
  check("a .cotal linking to a missing folder is TARGET_NOT_FOUND, exit 2, naming the link and its target",
    refused(linked, 2, "TARGET_NOT_FOUND") && linked.env?.error?.message === `${join(dangling, ".cotal")} links to ${join(home, "nowhere")}, which does not exist; nothing was written` && !existsSync(join(home, "nowhere")) && findPreparedSpace("other") === undefined, shown(linked));
  // A folder that is, or is in, a control directory is no project: a .cotal made there would sit
  // among that project's credentials and records, and up would start a second stack inside it. The
  // physical path a link leads to counts as well as the path given. Outside the home folder, whose
  // .cotal up would otherwise refuse to inherit first.
  if (process.platform !== "win32") {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "cotal-space-registration-control-")));
    const project = join(outer, "project"), control = join(project, ".cotal");
    mkdirSync(join(control, "agents"), { recursive: true, mode: 0o700 });
    const next = `if you meant the enclosing project, repeat your command with \`--root ${project}\`, or choose a folder outside any .cotal with --root <dir>`;
    const nested = () => readdirSync(control, { recursive: true }).map(String).filter((entry) => entry.split("/").includes(".cotal"));
    for (const [label, args, cwd, root] of [
      ["run in the control directory", ["space", "create", "inner"], control, control],
      ["run in a folder in it", ["space", "create", "inner"], join(control, "agents"), join(control, "agents")],
      ["given it as --root", ["space", "create", "inner", "--root", control], outer, control],
    ] as const) {
      const r = await json([...args], cwd);
      check(`space create ${label} is CONFLICT, exit 2, naming the project it belongs to, with nothing written`,
        refused(r, 2, "CONFLICT") && r.env?.error?.message === `${root} is ${root === control ? "" : "in "}the control directory ${control}, which holds the Cotal records of the project ${project}, so it cannot be a project folder; nothing was written` &&
          r.env.error.remedy === next && r.env.target?.controlDirectory === control && nested().length === 0 && findPreparedSpace("inner") === undefined, shown(r));
    }
    const link = join(project, "ctl");
    symlinkSync(control, link);
    const throughLink = await json(["space", "create", "inner", "--root", link], outer);
    check("a --root that links to the control directory is refused the same way, by the path it leads to",
      refused(throughLink, 2, "CONFLICT") && (throughLink.env?.error?.message ?? "").startsWith(`${link} is the control directory ${control}, which holds the Cotal records of the project ${project}`) && nested().length === 0 && findPreparedSpace("inner") === undefined, shown(throughLink));
    const machine = await json(["space", "create", "inner", "--root", process.env.COTAL_HOME!], outer);
    check("the machine's own Cotal home is refused as a control directory that holds this machine's records",
      refused(machine, 2, "CONFLICT") && machine.env?.error?.message === `${process.env.COTAL_HOME} is the control directory ${process.env.COTAL_HOME}, which holds this machine's own records, so it cannot be a project folder; nothing was written` &&
        machine.env.error.remedy === "create the space in a project folder with --root <dir>" && !existsSync(join(process.env.COTAL_HOME!, ".cotal")), shown(machine));
    // A home COTAL_HOME redirects is a folder the operator chose and may hold project folders beside
    // its records, as the hosted layout does with its space root at $COTAL_HOME/cotal. Only the home
    // itself and its record entries are control paths there.
    const redirected = join(outer, "cloud");
    mkdirSync(join(redirected, "meshes", "hosted"), { recursive: true, mode: 0o700 });
    mkdirSync(join(redirected, "cotal"), { mode: 0o700 });
    const underRedirected = (root: string) => run(["space", "create", "hosted", "--root", root, "--json"], { COTAL_HOME: redirected }, outer);
    const projectInHome = await underRedirected(join(redirected, "cotal"));
    check("a project folder beside a redirected home's records is a project of its own",
      projectInHome.status === 0 && existsSync(join(redirected, "cotal", ".cotal")) && !existsSync(join(redirected, ".cotal")), { status: projectInHome.status, stdout: projectInHome.stdout.slice(0, 400), stderr: projectInHome.stderr.slice(0, 400) });
    const recordInHome = await underRedirected(join(redirected, "meshes", "hosted"));
    check("a folder inside a redirected home's record entry is still refused as the home's control directory",
      recordInHome.status === 2 && recordInHome.stdout.includes(`${join(redirected, "meshes", "hosted")} is in the control directory ${redirected}, which holds this machine's own records`) && !existsSync(join(redirected, "meshes", "hosted", ".cotal")), { status: recordInHome.status, stdout: recordInHome.stdout.slice(0, 400) });
    const homeItself = await underRedirected(redirected);
    check("a redirected home itself is still refused as a control directory",
      homeItself.status === 2 && homeItself.stdout.includes(`${redirected} is the control directory ${redirected}`) && !existsSync(join(redirected, ".cotal")), { status: homeItself.status, stdout: homeItself.stdout.slice(0, 400) });
    // A .cotal an earlier release made in the control directory is not started either.
    mkdirSync(join(control, ".cotal"), { mode: 0o700 });
    const upInside = await json(["up", "--server", DEAD, "--no-manager"], control);
    check("up in a control directory that holds a .cotal of its own is CONFLICT, exit 2, naming the project, and starts nothing",
      refused(upInside, 2, "CONFLICT") && upInside.env?.error?.message === `${control} is the control directory ${control}, which holds the Cotal records of the project ${project}, so it cannot be a project folder; nothing was started or written` &&
        upInside.env.error.remedy === `repeat your original startup command with \`--root ${project}\` for the enclosing project` && readdirSync(join(control, ".cotal")).length === 0, shown(upInside));
    const upRoot = await json(["up", "--root", control, "--server", DEAD, "--no-manager"], outer);
    check("so is up --root naming it", refused(upRoot, 2, "CONFLICT") && (upRoot.env?.error?.message ?? "").startsWith(`${control} is the control directory ${control}`) && readdirSync(join(control, ".cotal")).length === 0, shown(upRoot));
    rmSync(join(control, ".cotal"), { recursive: true });
    // A project folder inside another project, outside its control directory, is a project of its own.
    const sub = join(project, "sub");
    mkdirSync(sub);
    const inner = await json(["space", "create", "inner"], sub);
    check("control: a folder inside a project, outside its .cotal, is still prepared", inner.status === 0 && inner.env?.result?.root === sub && existsSync(join(sub, ".cotal")) && findPreparedSpace("inner")?.root === sub, shown(inner));
    check("control: forgetting it", (await json(["space", "forget", "inner"])).status === 0 && findPreparedSpace("inner") === undefined);
    rmSync(outer, { recursive: true, force: true });
  }
  // A folder whose path holds a control character could be prepared but never started, and a
  // bidirectional formatting mark can show one path as another, so create and up refuse both before
  // anything is written.
  // Outside the home folder, whose .cotal up would otherwise refuse to inherit first.
  const { oneLine } = await import("@cotal-ai/core");
  const outsideBase = process.platform === "linux" ? "/var/tmp" : tmpdir();
  if (process.platform === "linux") for (const parent of [outsideBase, "/var", "/"]) if (existsSync(join(parent, ".cotal"))) throw new Error(`unsafe fixture ancestor: ${parent}`);
  const outside = realpathSync(mkdtempSync(join(outsideBase, "cotal-space-registration-odd-")));
  for (const [label, name] of [["a tab", "tab\tfolder"], ["a newline", "line\nfolder"], ["an escape character", "esc\u001bfolder"], ["a delete character", "del\u007ffolder"], ["the bidirectional formatting mark U+202E", "rlo\u202efolder"]]) {
    const odd = join(outside, name);
    mkdirSync(odd);
    const created = await json(["space", "create", "oddpath", "--root", odd]);
    check(`a --root whose path holds ${label} is USAGE_INVALID, exit 1, naming it, with nothing written`,
      refused(created, 1, "USAGE_INVALID") && (created.env?.error?.message ?? "") === `the folder path ${oneLine(odd)} contains ${label}, and a project path may hold neither control characters nor bidirectional formatting marks; nothing was written` && !existsSync(join(odd, ".cotal")) && findPreparedSpace("oddpath") === undefined, shown(created));
    const up = await json(["up", "--server", DEAD], odd);
    check(`up in that folder is USAGE_INVALID, exit 1, and writes no stack journal`,
      refused(up, 1, "USAGE_INVALID") && (up.env?.error?.message ?? "").startsWith(`the folder path ${oneLine(odd)} contains ${label}`) && !existsSync(join(odd, ".cotal")), shown(up));
    rmSync(odd, { recursive: true, force: true });
  }
  rmSync(outside, { recursive: true, force: true });
  // A prepared folder that is moved keeps none of its space, so a bare up there would start the
  // default. With that space selected and its recorded folder gone, up refuses and names the step.
  {
    const before = join(home, "moving-before"), after = join(home, "moving-after");
    mkdirSync(before);
    check("control: create prepares the space that will move", (await json(["space", "create", "moving"], before)).status === 0);
    renameSync(before, after);
    const previous = getCurrent();
    setCurrent("moving");
    const moved = await json(["up", "--server", DEAD], after);
    check("a bare up in the moved folder refuses TARGET_UNAVAILABLE, exit 2, naming the gone folder and the step",
      refused(moved, 2, "TARGET_UNAVAILABLE") && (moved.env?.error?.message ?? "").includes(`"moving" is prepared in ${before}, which no longer exists`) && moved.env?.error?.remedy?.startsWith("restore the original project folder at its recorded path, then repeat your startup command in that folder") === true && !moved.env.error.remedy.includes("space forget") && findMesh("main") === undefined && !existsSync(join(after, ".cotal", "auth")), shown(moved));
    const again = await json(["space", "create", "moving"], after);
    check("create there offers restoring the original folder before forgetting its space",
      refused(again, 2, "CONFLICT") && (again.env?.error?.message ?? "").endsWith("which no longer exists") && again.env?.error?.remedy === "restore the original project folder at its recorded path, or forget it with `cotal space forget moving`, then run this create again", shown(again));
    renameSync(after, before);
    const restored = await json(["space", "show", "moving"], before);
    check("restoring the original folder makes the same preparation usable without forgetting it", restored.status === 0 && restored.env?.result?.root === before && restored.env.result.rootMissing === false && getCurrent() === "moving", shown(restored));
    renameSync(before, after);
    check("control: forget clears the way", (await json(["space", "forget", "moving"])).status === 0);
    if (previous === undefined) clearCurrent(); else setCurrent(previous);
    rmSync(after, { recursive: true, force: true });
  }
  check("create takes exactly one name", refused(await json(["space", "create"], spare), 1, "USAGE_INVALID") && refused(await json(["space", "create", "a", "b"], spare), 1, "USAGE_INVALID"));
  check("an add flag other than --root on create is USAGE_INVALID", refused(await json(["space", "create", "other", "--server", LIVE], spare), 1, "USAGE_INVALID"));
  for (const name of ["a b", "dot.name", "é"]) {
    const bad = await json(["space", "create", name], spare);
    check(`a name cotal up cannot start (${name.length > 20 ? `${name.length} characters` : name}) is USAGE_INVALID, with the remedy in its envelope`,
      refused(bad, 1, "USAGE_INVALID") && /1 to 64 letters, digits, underscores or hyphens/.test(bad.env?.error?.message ?? "") && bad.env?.error?.remedy === "choose a name of only letters, digits, underscores and hyphens", shown(bad));
  }
  const dashed = await json(["space", "create", "--", "-x"], spare);
  check("a name that starts with - is USAGE_INVALID, saying it cannot be passed as a flag value",
    refused(dashed, 1, "USAGE_INVALID") && /cannot be passed as a flag value/.test(dashed.env?.error?.message ?? "") && dashed.env?.error?.remedy === "choose a name that starts with a letter, digit or underscore", shown(dashed));
  const dashedUp = await json(["up", "--space=-x", "--server", DEAD, "--no-manager"], spare);
  check("up --space=-x is USAGE_INVALID before anything is started or written",
    refused(dashedUp, 1, "USAGE_INVALID") && (dashedUp.env?.error?.message ?? "").endsWith("cannot be passed as a flag value; nothing was started or written") && dashedUp.env?.error?.remedy === "choose a name that starts with a letter, digit or underscore", shown(dashedUp));
  check("no refused create prepared anything or made a .cotal", ["other", "a", "a b", "dot.name", "é", "-x"].every((name) => findPreparedSpace(name) === undefined) && !existsSync(join(spare, ".cotal")) && !existsSync(join(home, "absent")));
  // A name no space has resolves to nothing, so its refusal carries the name as target.requested and
  // has no `Mesh:` heading. A registration an earlier release made under such a name still has one.
  for (const args of [["space", "create", "a*b"], ["space", "show", "a*b"], ["space", "forget", "a*b"], ["space", "show", "nosuchspace"], ["space", "forget", "nosuchspace"]]) {
    const r = await json(args, spare);
    check(`${args.join(" ")} is refused with the name as target.requested and no Mesh: heading`,
      r.status !== 0 && r.env?.outcome === "refused" && r.env.target?.requested === args[2] && r.env.target.space === undefined && !/^Mesh:/m.test(r.stderr), shown(r));
  }
  recordMesh({ space: "a*b", server: DEAD, root: home, mode: "open", origin: "manual", ts: new Date().toISOString() });
  const odd = await run(["space", "show", "a*b"]);
  check("space show of a registration an earlier release made under such a name still heads it Mesh: <name>", odd.status === 0 && odd.stdout.startsWith("Mesh: a*b"), shown(odd));
  check("space show quotes a legacy name that a shell could expand", odd.stdout.includes(`\`${launcher} use 'a*b'\``), shown(odd));
  removeMesh("a*b");
  // A space name holds at most 64 characters, so its hex fits every local file name that carries it.
  const longName = "y".repeat(65), longest = "y".repeat(64);
  const tooLong = await json(["space", "create", longName], spare);
  check("a 65-character name is USAGE_INVALID naming the 64-character limit, and nothing is written",
    refused(tooLong, 1, "USAGE_INVALID") && (tooLong.env?.error?.message ?? "").startsWith("the space name has 65 characters, and a space name holds at most 64") && findPreparedSpace(longName) === undefined && !existsSync(join(spare, ".cotal")), shown(tooLong));
  const upTooLong = await json(["up", "--server", DEAD, "--space", longName], spare);
  check("up --space with a 65-character name is USAGE_INVALID before anything is written", refused(upTooLong, 1, "USAGE_INVALID") && /at most 64/.test(upTooLong.env?.error?.message ?? "") && !existsSync(join(spare, ".cotal")), shown(upTooLong));
  const fits = await json(["space", "create", longest], spare);
  check("control: a 64-character name is prepared", fits.status === 0 && findPreparedSpace(longest) !== undefined, shown(fits));
  check("control: forget it", (await json(["space", "forget", longest])).status === 0 && findPreparedSpace(longest) === undefined);
  rmSync(join(spare, ".cotal"), { recursive: true, force: true });
  // An earlier release prepared longer names; up there refuses before its journal is written.
  const earlier = mkdtempSync(join(home, "earlier-"));
  mkdirSync(join(earlier, ".cotal"), { mode: 0o700 });
  recordPreparedSpace({ space: "y".repeat(100), root: earlier, ts: new Date().toISOString() });
  const upEarlier = await json(["up", "--server", DEAD], earlier);
  check("up of a 100-character space an earlier release prepared is USAGE_INVALID naming space forget, and writes no journal",
    refused(upEarlier, 1, "USAGE_INVALID") && /has 100 characters/.test(upEarlier.env?.error?.message ?? "") && (upEarlier.env?.error?.remedy ?? "").includes(`cotal space forget ${"y".repeat(100)}`) && !existsSync(join(earlier, ".cotal", "stack-controller.json")), shown(upEarlier));
  removePreparedSpace("y".repeat(100));
  rmSync(earlier, { recursive: true, force: true });
  const add = await json(["space", "add", "demo", "--server", LIVE, "--root", root]);
  check("adding a prepared name is CONFLICT, naming cotal up", refused(add, 2, "CONFLICT") && /cotal up/.test(add.env?.error?.remedy ?? "") && findMesh("demo") === undefined, shown(add));

  const list = await json(["space"]);
  check("space lists it apart from the registrations", list.env?.result.prepared.some((p: { space: string; root: string }) => p.space === "demo" && p.root === fresh) && !list.env.result.items.some((s: { space: string }) => s.space === "demo"), list.env?.result);
  const show = await json(["space", "show", "demo"]);
  check("space show shows it as prepared", show.status === 0 && show.env?.result.kind === "prepared-space" && show.env.result.root === fresh && show.env.result.rootMissing === false, shown(show));
  check("a space that never started reads as prepared, with no last operation, in the listing and in space show",
    list.env?.result.prepared.some((p: { space: string; state: string; lastOperation: unknown }) => p.space === "demo" && p.state === "prepared" && p.lastOperation === null) && show.env?.result.state === "prepared" && show.env.result.lastOperation === null, { list: list.env?.result.prepared, show: show.env?.result });
  const named = await json(["who", "--space", "demo"]);
  check("a command naming it with --space is TARGET_UNAVAILABLE, naming its root", refused(named, 2, "TARGET_UNAVAILABLE") && /prepared but not started/.test(named.env?.error?.message ?? "") && named.env?.error?.remedy?.includes(fresh), shown(named));
  for (const form of [["history", "general"], ["send", "-c", "general", "hello"]]) {
    const explicit = await json([...form, "--space", "demo", "--server", DEAD]);
    check(`${form[0]} on an unreachable explicit broker gives a startup command for the prepared project`,
      refused(explicit, 2, "TARGET_UNAVAILABLE") && explicit.env?.target?.space === "demo" && explicit.env.target.root === fresh
        && explicit.env.error?.message.includes(DEAD) && explicit.env.error.remedy?.includes(`--space demo --server '${DEAD}'`)
        && explicit.env.error.remedy.includes("cotal up --root ") && explicit.env.error.remedy.includes("check that address"), shown(explicit));
  }
  const raw = await json(["history", "general", "--space", "not-prepared", "--server", DEAD]);
  check("without preparation, an unreachable explicit broker only gives an address check",
    refused(raw, 2, "TARGET_UNAVAILABLE") && raw.env?.error?.remedy === "check that address and that a broker runs there", shown(raw));
  const live = ["--space", "demo", "--server", LIVE];
  const sent = await json(["send", "-c", "general", "explicit broker control", ...live]);
  const history = await json(["history", "general", ...live]);
  check("a live explicit broker is still used for send and history even when the name is prepared here",
    sent.status === 0 && history.status === 0 && history.stdout.includes("explicit broker control") && findPreparedSpace("demo")?.root === fresh,
    [sent, history].map(shown));
  const channelForms = [["channel"], ["channel", "show", "general"], ["channel", "set", "general", "--desc", "x"], ["channel", "defaults"], ["channel", "members", "general"], ["channel", "remove", "general", "--yes"]];
  const channelRefusals: Awaited<ReturnType<typeof json>>[] = [];
  for (const form of channelForms) channelRefusals.push(await json([...form, "--space", "demo"]));
  check("every channel form naming it is TARGET_UNAVAILABLE, exit 2, naming its root",
    channelRefusals.every((r) => refused(r, 2, "TARGET_UNAVAILABLE") && r.env?.error?.remedy?.includes(fresh)), channelRefusals.map(shown));
  const channelHuman = await run(["channel", "set", "general", "--desc", "x", "--space", "demo"]);
  check("the human channel refusal gives its code and Next", channelHuman.status === 2 && /Code:\s+TARGET_UNAVAILABLE/.test(channelHuman.stderr) && channelHuman.stderr.includes(fresh), shown(channelHuman));
  const inRoot = await json(["who"], fresh);
  check("a command run in its root with nothing selected is TARGET_UNAVAILABLE", refused(inRoot, 2, "TARGET_UNAVAILABLE") && /prepared but not started/.test(inRoot.env?.error?.message ?? ""), shown(inRoot));
  // The refusal's target names the space and its root, from the resolver and from the connect path.
  const endpoints = await json(["endpoints", "--space", "demo"]);
  check("each of those refusals names the space and its root under target",
    [named, inRoot, endpoints].every((r) => refused(r, 2, "TARGET_UNAVAILABLE") && JSON.stringify(r.env?.target) === JSON.stringify({ space: "demo", root: fresh })), [named, inRoot, endpoints].map((r) => r.env?.target ?? shown(r)));
  setAdoptedCurrent("demo");
  const selected = await json(["use", "demo"]);
  check("use promotes the same adopted selection to explicit", selected.status === 0 && readCurrentSelection()?.source === "explicit" && selected.env?.outcome === "ok", shown(selected));
  check("use selects it and names its root", selected.status === 0 && getCurrent() === "demo" && selected.env?.result.preparedRoot === fresh && selected.env.result.currentRecorded === false, shown(selected));
  const besidePrepared = await run(["meshes", "add", "beside-prepared", "--server", DEAD, "--root", root, "--mode", "open", "--force"], {}, fresh);
  const stillPrepared = await json(["use"], fresh);
  check("meshes add preserves an explicitly selected prepared space and does not announce a new default",
    besidePrepared.status === 0 && findMesh("beside-prepared")?.server === DEAD && !besidePrepared.stdout.includes("it is now the default mesh") &&
      stillPrepared.env?.result.current === "demo" && stillPrepared.env.result.preparedState === "prepared" && readCurrentSelection()?.source === "explicit",
    { add: shown(besidePrepared), selection: stillPrepared.env?.result });
  const preparedTarget = await json(["who"], fresh);
  check("after registration, commands still refuse the selected prepared space instead of targeting the new entry",
    refused(preparedTarget, 2, "TARGET_UNAVAILABLE") && preparedTarget.env?.target?.space === "demo", shown(preparedTarget));
  const removedBesidePrepared = await run(["meshes", "rm", "beside-prepared"]);
  check("removing that registration preserves the prepared selection",
    removedBesidePrepared.status === 0 && getCurrent() === "demo" && readCurrentSelection()?.source === "explicit", shown(removedBesidePrepared));
  // The default report says it under Spaces; the recorded-meshes diagnostics say it again under --verbose.
  const status = await run(["status", "--plain"]);
  check("status says the selected space is prepared, not started", status.status === 0 && /Selected space 'demo' is prepared, not started/.test(status.stdout), shown(status));
  const verbose = await run(["status", "--plain", "--verbose"]);
  check("status --verbose notes the selected space is prepared, not started", verbose.status === 0 && /current mesh "demo" is prepared, not started/.test(verbose.stdout), shown(verbose));
  const listed = await json(["space"]);
  check("a selected prepared space is not warned about as missing", listed.status === 0 && listed.env?.warnings.length === 0 && listed.env.result.prepared[0]?.current === true, listed.env?.warnings);
  // After the prepared-list reads above, so a second prepared space does not reorder them.
  const longestRoot = join(home, "longestRoot");
  mkdirSync(longestRoot);
  const sixtyFour = await json(["space", "create", "b".repeat(64)], longestRoot);
  check("a 64-character name is prepared", sixtyFour.status === 0 && findPreparedSpace("b".repeat(64)) !== undefined, shown(sixtyFour));
  // An existing prepared name reaches the same controller startup checks as before.
  const legacy = join(home, "legacy");
  mkdirSync(join(legacy, ".cotal", "agents"), { recursive: true, mode: 0o700 });
  recordPreparedSpace({ space: "sp ace", root: legacy, ts: new Date().toISOString() });
  const legacyUp = await json(["up", "--root", legacy, "--space", "sp ace", "--server", `nats://127.0.0.1:${await freePort()}`], legacy);
  check("up of a legacy name that is not a routing token says no member was started and quotes the name in its next step",
    refused(legacyUp, 1, "SCHEMA_INVALID") && /started no member/.test(legacyUp.env?.error?.message ?? "") && (legacyUp.env?.error?.remedy ?? "").includes("--space 'sp ace'"), shown(legacyUp));
  const human = await run(["space", "--plain"]);
  // Spaces this suite started and stopped above are listed with it, so the heading has a State column.
  check("the listing shows it under its own heading, as not started", /^Prepared spaces$/m.test(human.stdout) && /demo \(selected\) +not started/.test(human.stdout), shown(human));
  const target = await json(["who"]);
  check("a command that targets it is TARGET_UNAVAILABLE, naming cotal up in its root", refused(target, 2, "TARGET_UNAVAILABLE") && /cotal up/.test(target.env?.error?.remedy ?? "") && target.env?.error?.remedy?.includes(fresh), shown(target));

  // Under a root that hosts other spaces, so `up` would make this folder a root of its own.
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  const server = `nats://127.0.0.1:${await freePort()}`;
  const away = await json(["up", "--detach", "--open", "--no-manager", "--server", server, "--space", "demo"], elsewhere);
  check("up --space for it from another folder refuses, naming its root, and makes nothing there", refused(away, 2, "TARGET_UNAVAILABLE") && away.env?.error?.message.includes(`prepared in ${fresh}`) && !existsSync(join(elsewhere, ".cotal")), shown(away));
  check("that refusal names the up --root that starts it from here", away.env?.error?.remedy === `start it in its folder with \`cotal up --root ${fresh} --space demo\`, or \`cotal space forget demo\` to start it here`, shown(away));
  const otherName = await json(["up", "--detach", "--open", "--no-manager", "--server", server, "--space", "other", "--root", fresh], elsewhere);
  check("up --space for another space in its root refuses", refused(otherName, 2, "CONFLICT") && /root of "demo"/.test(otherName.env?.error?.message ?? "") && findMesh("other") === undefined, shown(otherName));
  check("the retry for the folder's own space keeps its root when called from elsewhere",
    (otherName.env?.error?.remedy ?? "").includes(`\`cotal up --root ${fresh} --space demo\``) && !existsSync(join(elsewhere, ".cotal")), shown(otherName));
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
  const serverHost = new URL(server).hostname;
  const hostPort = await run(["up", "--detach", "--open", "--no-manager", "--server", server, "--host", `${serverHost}:${new URL(server).port}`], {}, fresh);
  check("up with a port-bearing --host refuses, exit 1, pointing at --server, and leaves the root and registrations unchanged",
    hostPort.status === 1 && /is not a valid bind host/.test(hostPort.stderr) && /the port comes from --server/.test(hostPort.stderr) &&
      cotalFiles() === beforeRuntime.files && JSON.stringify(registryFiles()) === JSON.stringify(beforeRuntime.registry) && findPreparedSpace("demo")?.root === fresh, shown(hostPort));
  // --json answers these refusals in its envelope, as it does every other usage refusal.
  const hostPair = await json(["up", "--detach", "--open", "--no-manager", "--server", server, "--host", "127.0.0.2"], fresh);
  check("up --json with a --host naming another address than --server is a USAGE_INVALID envelope, exit 1, and leaves the root unchanged",
    refused(hostPair, 1, "USAGE_INVALID") && /--host 127\.0\.0\.2 and --server .* name different addresses/.test(hostPair.env?.error?.message ?? "") &&
      cotalFiles() === beforeRuntime.files, shown(hostPair));
  const otherAddress = server.replace("127.0.0.1", "127.0.0.2");
  const unbound = await json(["up", "--detach", "--open", "--no-manager", "--server", otherAddress], fresh);
  check("up --json --server naming 127.0.0.2 with no --host is USAGE_INVALID, exit 1, naming --host 127.0.0.2, and leaves the root unchanged",
    refused(unbound, 1, "USAGE_INVALID") && unbound.env?.error?.remedy === "pass --host 127.0.0.2 to bind the broker there" &&
      cotalFiles() === beforeRuntime.files && JSON.stringify(registryFiles()) === JSON.stringify(beforeRuntime.registry), shown(unbound));
  // Content the registry would not take refuses before anything starts, naming the file and the entry.
  const badSeeds: [string, string, string][] = [
    ["a channel name channel set refuses", '{"channels":{"bad name!":{}}}', 'invalid channel "bad name!"'],
    ["a replay window that is not a duration", '{"channels":{"ops":{"replayWindow":"2x"}}}', 'channel "ops" replayWindow: invalid duration "2x"'],
    ["a file that is not an object", "[1,2]", "it must be a JSON object"],
    ["a misspelled top-level key", '{"chanels":{"ops":{}}}', 'unknown key "chanels"'],
    ["a misspelled channel field", '{"channels":{"ops":{"replayWindw":"6h"}}}', 'channel "ops" has an unknown key "replayWindw"'],
  ];
  for (const [what, text, named] of badSeeds) {
    const seedPath = join(fresh, "bad-channels.json");
    writeFileSync(seedPath, text);
    const badSeed = await json(["up", "--open", "--channels", seedPath, "--server", server], fresh);
    check(`up with ${what} in --channels is SCHEMA_INVALID, exit 1, naming the file and the entry, and leaves the root unchanged`,
      refused(badSeed, 1, "SCHEMA_INVALID") && (badSeed.env?.error?.message ?? "").includes(seedPath) && (badSeed.env?.error?.message ?? "").includes(named) &&
        cotalFiles() === beforeRuntime.files && JSON.stringify(registryFiles()) === JSON.stringify(beforeRuntime.registry), shown(badSeed));
  }
  const durableSeed = join(fresh, "durable-channels.json");
  writeFileSync(durableSeed, '{"channels":{"wire.seeded":{"deliveryClass":"durable","replay":false}}}');
  const durableChannel = await json(["up", "--open", "--no-manager", "--channels", durableSeed, "--server", LIVE], fresh);
  check("open up refuses an explicit durable channel before writing or starting a stack",
    refused(durableChannel, 2, "UNSUPPORTED") && durableChannel.env?.error?.message?.includes(durableSeed) && durableChannel.env?.error?.message?.includes('channel "wire.seeded"') &&
      durableChannel.env?.error?.remedy?.includes('"live"') && durableChannel.env?.error?.remedy?.includes("authenticated space") &&
      cotalFiles() === beforeRuntime.files && JSON.stringify(registryFiles()) === JSON.stringify(beforeRuntime.registry), shown(durableChannel));
  // The `✗` line quotes the parser's excerpt of a file that is not JSON with its control characters
  // escaped, so an escape sequence in a cloned file never reaches the terminal.
  const escSeed = join(fresh, "esc-channels.json");
  writeFileSync(escSeed, '{"channels": \u001b[2J}');
  const escaped = await run(["up", "--open", "--channels", escSeed, "--server", server], { LC_ALL: "C.UTF-8" }, fresh);
  check("up with a --channels file holding an escape sequence quotes its excerpt escaped, exit 1, and leaves the root unchanged",
    escaped.status === 1 && escaped.stderr.startsWith("✗ ") && escaped.stderr.includes('"{"channels": \\u001b[2J}"') && !/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(escaped.stdout + escaped.stderr) &&
      cotalFiles() === beforeRuntime.files, shown(escaped));
  unlinkSync(escSeed);
  const utf16Seed = join(fresh, "utf16-channels.json");
  writeFileSync(utf16Seed, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"channels":{}}', "utf16le")]));
  const utf16 = await json(["up", "--open", "--channels", utf16Seed, "--server", server], fresh);
  check("up with a --channels file saved as UTF-16 is USAGE_INVALID, exit 1, naming its encoding and the step to save it as UTF-8",
    refused(utf16, 1, "USAGE_INVALID") && utf16.env?.error?.message === `the channels file ${utf16Seed} cannot be read: it is saved as UTF-16, and Cotal reads only UTF-8` &&
      utf16.env?.error?.remedy === `save ${utf16Seed} as UTF-8` && cotalFiles() === beforeRuntime.files, shown(utf16));
  unlinkSync(utf16Seed);
  // The default file is read once the root is settled, so it refuses after the stack lock's layout
  // exists and before a store, a broker or a registration.
  const defaultSeed = join(fresh, ".cotal", "channels.json");
  writeFileSync(defaultSeed, '{"defaults":{"deliveryClass":"durable"},"channels":{"ops":{"deliveryClass":"live"}}}');
  const durableDefault = await json(["up", "--open", "--no-manager", "--server", LIVE], fresh);
  check("open up refuses a durable seed default even when every named channel is live",
    refused(durableDefault, 2, "UNSUPPORTED") && durableDefault.env?.error?.message?.includes(defaultSeed) && durableDefault.env?.error?.message?.includes("defaults.deliveryClass") &&
      !existsSync(join(fresh, ".cotal", "nats")) && JSON.stringify(registryFiles()) === JSON.stringify(beforeRuntime.registry), shown(durableDefault));
  writeFileSync(defaultSeed, '{"chanels":{}}');
  const badDefault = await json(["up", "--open", "--server", server], fresh);
  check("an invalid default .cotal/channels.json refuses the same way, with a remedy to fix or remove it, before a store or a registration",
    refused(badDefault, 1, "SCHEMA_INVALID") && (badDefault.env?.error?.message ?? "").includes(defaultSeed) && badDefault.env?.error?.remedy === `fix or remove ${defaultSeed}` &&
      !existsSync(join(fresh, ".cotal", "nats")) && JSON.stringify(registryFiles()) === JSON.stringify(beforeRuntime.registry) && findPreparedSpace("demo")?.root === fresh, shown(badDefault));
  // So does one that is not JSON at all: the default file's content is invalid, not the command line.
  writeFileSync(defaultSeed, '{"channels":');
  const unparsedDefault = await json(["up", "--open", "--server", server], fresh);
  check("a default .cotal/channels.json that is not JSON refuses USAGE_INVALID, with the same remedy, before a store or a registration",
    refused(unparsedDefault, 1, "USAGE_INVALID") && (unparsedDefault.env?.error?.message ?? "").includes(defaultSeed) && unparsedDefault.env?.error?.remedy === `fix or remove ${defaultSeed}` &&
      !existsSync(join(fresh, ".cotal", "nats")) && JSON.stringify(registryFiles()) === JSON.stringify(beforeRuntime.registry), shown(unparsedDefault));
  unlinkSync(defaultSeed);
  // A FIFO there would block the read, so it is refused by its file type before it is opened.
  if (process.platform !== "win32") {
    spawnSync("mkfifo", [defaultSeed]);
    const fifoDefault = await json(["up", "--open", "--server", server], fresh);
    check("a default .cotal/channels.json that is a FIFO refuses naming it, without waiting on it, before a store or a registration",
      refused(fifoDefault, 1, "USAGE_INVALID") && fifoDefault.env?.error?.message === `the channels file ${defaultSeed} is not a regular file, such as a FIFO; it was not read` &&
        !existsSync(join(fresh, ".cotal", "nats")) && JSON.stringify(registryFiles()) === JSON.stringify(beforeRuntime.registry), shown(fifoDefault));
    unlinkSync(defaultSeed);
  }
  // A channels file that begins with a UTF-8 byte-order mark, as some Windows editors save one, seeds
  // as the JSON after it.
  writeFileSync(defaultSeed, '\uFEFF{"channels":{"bomseed":{"description":"saved with a BOM"}}}');

  // Its seed comes through a FIFO written once, which a second open would wait on forever.
  const seedFifo = join(home, "channels-seed.fifo");
  spawnSync("mkfifo", ["-m", "600", seedFifo]);
  const feeder = spawn("sh", ["-c", 'printf %s "$1" > "$2"', "sh", '{"channels":{"news":{"description":"Neuigkeiten","deliveryClass":"live"}}}', seedFifo], { stdio: "ignore" });
  const coRooted = await json(["space", "add", "co-rooted-remote", "--server", DEAD, "--root", fresh, "--mode", "open", "--force"], fresh);
  check("a manual connection can register at the prepared root", coRooted.status === 0 && findMesh("co-rooted-remote")?.root === fresh, shown(coRooted));
  const up = await run(["up", "--detach", "--open", "--no-manager", "--server", server], {}, fresh);
  const started = findMesh("demo");
  check("up starts the prepared space and consumes its record despite the co-rooted manual connection",
    up.status === 0 && started?.root === fresh && started.server === server && started.origin === "up" && findPreparedSpace("demo") === undefined, shown(up));
  const who = await json(["who", "--space", "demo"], fresh);
  check("the local broker answers and the manual connection is unchanged", who.status === 0 && findMesh("co-rooted-remote")?.server === DEAD, shown(who));
  const forgetRemote = await json(["space", "forget", "co-rooted-remote"], fresh);
  check("forget the manual connection independently of the running local stack", forgetRemote.status === 0, shown(forgetRemote));
  const bomSeeded = await json(["channel", "show", "bomseed", "--space", "demo"]);
  // An explicit --channels replaces the default file, and only a start seeds, so the FIFO seed is
  // read by the next start after a down.
  check("down --yes stops it for the FIFO start", (await json(["down", "--yes"], fresh)).status === 0);
  const fifoUp = await run(["up", "--detach", "--open", "--no-manager", "--server", server, "--channels", seedFifo], {}, fresh);
  feeder.kill();
  unlinkSync(seedFifo);
  const seeded = await run(["channel", "--space", "demo", "--plain"], {}, fresh);
  const seededLive = await json(["channel", "show", "news", "--space", "demo"], fresh);
  check("it reads a --channels FIFO once and seeds the live channel from it",
    fifoUp.status === 0 && seeded.status === 0 && seeded.stdout.includes("Neuigkeiten") && seededLive.env?.result?.registry?.channels?.news?.deliveryClass === "live",
    { up: shown(fifoUp), seeded: shown(seeded), live: shown(seededLive) });
  check("the selection still names it", getCurrent() === "demo", getCurrent());
  check("a default channels file that begins with a UTF-8 byte-order mark seeds its channels",
    bomSeeded.status === 0 && JSON.stringify(bomSeeded.env?.result ?? null).includes("saved with a BOM"), shown(bomSeeded));
  // A default seed in the root sets those fields again at the next start, and the edit says so. It
  // begins with a byte-order mark, which the start ignores, so the warning reads past it too.
  writeFileSync(defaultSeed, '\uFEFF{"channels":{"news":{"description":"Neuigkeiten"}}}');
  const seededField = await json(["channel", "set", "news", "--desc", "von Hand", "--space", "demo"], fresh);
  const seedWarning = seededField.env?.warnings?.find((w: { code: string }) => w.code === "CHANNEL_SEED_REAPPLIES");
  check("channel set of a field the default seed sets warns that the next start writes it back, naming the file",
    seededField.status === 0 && seedWarning?.message === `the default seed ${defaultSeed} also sets #news's description, so the next start of this space with \`cotal up\` writes the file's value back` && seededField.stderr.includes(`! the default seed ${defaultSeed}`), shown(seededField));
  const otherField = await json(["channel", "set", "news", "--instructions", "Kurz.", "--space", "demo"], fresh);
  check("a field the seed does not set gets no such warning", otherField.status === 0 && otherField.env?.warnings?.length === 0, shown(otherField));
  const seededRemove = await json(["channel", "remove", "news", "--yes", "--space", "demo"], fresh);
  check("channel remove of a channel the default seed names warns that the next start saves it again",
    seededRemove.status === 0 && seededRemove.env?.warnings?.some((w: { code: string; message: string }) => w.code === "CHANNEL_SEED_REAPPLIES" && w.message === `the default seed ${defaultSeed} names #news, so the next start of this space with \`cotal up\` saves its entry again`) === true, shown(seededRemove));
  unlinkSync(defaultSeed);
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
  check("...and its JSON says the selection still names the space and this up did not change it",
    bare.env?.result.selection?.current === "demo" && bare.env.result.selection.changed === false, bare.env?.result.selection);
  const durableOps = '{"channels":{"ops":{"deliveryClass":"durable","replay":false}}}';
  writeFileSync(defaultSeed, durableOps);
  const seedRefresh = await json(["up", "--no-manager"], fresh);
  const refreshedOps = await run(["channel", "show", "ops", "--plain"], {}, fresh);
  check("a healthy open controller refresh keeps the registry live despite a durable default file",
    seedRefresh.status === 0 && seedRefresh.env?.outcome === "no-op" && refreshedOps.status === 0 &&
      /Delivery:\s+live/.test(refreshedOps.stdout) && !/Metadata:\s+configured/.test(refreshedOps.stdout),
    { up: shown(seedRefresh), channel: shown(refreshedOps) });
  unlinkSync(defaultSeed);
  // The receipt's Next runs as printed: down stops only the stack of the folder it runs in.
  check("up in its root offers unqualified up and down using the same launcher in its Next",
    ["cotal", "pnpm cotal"].some((launcher) =>
      new RegExp(`^ +${launcher} up +Add the manager to this stack$`, "m").test(up.stdout) &&
      new RegExp(`^ +${launcher} down +Stop every recorded member$`, "m").test(up.stdout)), up.stdout);
  const remote = await run(["up", "--detach", "--no-manager", "--root", fresh], {}, elsewhere);
  check("up --root from another folder says where cotal down runs and offers cotal up --root",
    remote.status === 0 && remote.stdout.includes(`cotal down`) && remote.stdout.includes(`Stop every recorded member; run it from ${fresh}`) && remote.stdout.includes(`cotal up --root ${fresh}`), shown(remote));
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
  const beforeAgentStop = readFileSync(stackJournalPath(fresh), "utf8");
  assertSmokeSandboxDown(sandbox, ["down", "--with-agents", "--dry-run", "--json"], { cwd: fresh, env: runEnv });
  const liveReapPreview = await json(["down", "--with-agents", "--dry-run"], fresh);
  assertSmokeSandboxDown(sandbox, ["down", "--with-agents", "--yes", "--json"], { cwd: fresh, env: runEnv });
  const liveReap = await json(["down", "--with-agents", "--yes"], fresh);
  const liveRefusal = liveReap.env?.error;
  const liveStopPlan = liveReapPreview.env?.result;
  check("retiring agents on a running broker-only stack refuses without writing or stopping a member",
    refused(liveReap, 2, "LIFECYCLE_BLOCKED") && liveRefusal?.message.includes("started without a manager") && liveRefusal.remedy?.includes("`cotal down --yes`") && readFileSync(stackJournalPath(fresh), "utf8") === beforeAgentStop, shown(liveReap));
  check("the broker-only retirement preview shows the same refusal and alternative without signalling or querying manager impact",
    liveReapPreview.status === 0 && liveReapPreview.env?.completeness === "partial" && liveStopPlan?.blockedBy?.code === liveRefusal?.code
      && liveStopPlan?.blockedBy?.message === liveRefusal?.message && liveStopPlan?.blockedBy?.remedy === liveRefusal?.remedy
      && liveStopPlan?.signalled === false && liveStopPlan?.nativeImpactChecked === false && liveStopPlan?.members?.some((member: { role: string; process: string }) => member.role === "broker" && member.process === "running")
      && liveReapPreview.env.warnings?.some((warning: { code: string; message: string }) => warning.code === liveRefusal?.code && warning.message === `the real stop would refuse: ${liveRefusal?.message}; ${liveRefusal?.remedy}`), shown(liveReapPreview));
  assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: fresh, env: runEnv });
  const down = await run(["down", "--yes"], {}, fresh);
  check("down stops it", down.status === 0, shown(down));
  const stoppedHistory = await json(["history", "news", "--space", "demo"], elsewhere);
  for (const requestedSpace of [null, "demo"]) {
    const watch = await run(["watch", "--json", ...(requestedSpace === null ? [] : ["--space", requestedSpace])], {}, fresh);
    const records = watch.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
      type: string; target: { requestedSpace?: string | null; space?: string }; data: { code?: string; message?: string; remedy?: string; reason?: string };
    });
    check(`watch --json reports the stopped space with ${requestedSpace === null ? "automatic" : "explicit"} selection`,
      watch.status === 2 && records.map((r) => r.type).join() === "error,end" &&
      records.every((r) => r.target.requestedSpace === requestedSpace && r.target.space === "demo") &&
      records[0]?.data.code === "TARGET_UNAVAILABLE" && records[0].data.message === stoppedHistory.env?.error?.message &&
      records[0].data.remedy === stoppedHistory.env?.error?.remedy && records[1]?.data.reason === "setup-failed", shown(watch));
  }
  for (const args of [
    ["history", "news", "--server", server],
    ["history", "news", "--server", `${server}/`],
    ["send", "-c", "news", "test", "--server", server],
  ]) {
    const explicit = await json([...args, "--space", "demo"], elsewhere);
    check(`${args.join(" ")} reports the clean stop and restart root just like name-only history`,
      refused(stoppedHistory, 2, "TARGET_UNAVAILABLE") && refused(explicit, 2, "TARGET_UNAVAILABLE") &&
      explicit.env?.target?.space === "demo" && explicit.env.target.root === fresh &&
      explicit.env.error.message === stoppedHistory.env?.error.message && explicit.env.error.remedy === stoppedHistory.env?.error.remedy &&
      explicit.env.error.message === '"demo" is stopped; its last operation, `cotal down`, completed' &&
      explicit.env.error.remedy === `start it again with \`cotal up --no-manager\` in ${fresh}`, shown(explicit));
  }
  const stoppedHistoryOverride = await json(["history", "news", "--space", "demo", "--server", DEAD], elsewhere);
  check("history at a different address still refers to that address, not the stopped stack",
    refused(stoppedHistoryOverride, 2, "TARGET_UNAVAILABLE") && stoppedHistoryOverride.env?.error.message === `can't reach a broker at ${DEAD}` &&
    stoppedHistoryOverride.env.error.remedy === "check that address and that a broker runs there", shown(stoppedHistoryOverride));
  const fixSeed = `fix or remove ${defaultSeed}`;
  for (const [seed, problem, exit, seedRemedy] of [
    ["{\n", "is not valid JSON", 1, fixSeed],
    ['{"defaults":{"replay":"yes"}}', 'is invalid: "defaults" replay', 1, fixSeed],
    [durableOps, 'requests durable delivery for channel "ops"', 2, 'set deliveryClass to "live" in those entries, or use an authenticated space for durable delivery'],
  ] as const) {
    writeFileSync(defaultSeed, seed);
    const badUp = await json(["up", "--no-manager"], fresh);
    const status = await json(["status", "--space", "demo"], fresh);
    const statusText = await run(["status", "--space", "demo"], {}, fresh);
    const ps = await json(["ps", "--space", "demo"], elsewhere);
    const diagnosis = `the channels file ${defaultSeed} ${problem}`;
    check(`up, status and ps agree on the stopped stack's seed ${problem}`,
      badUp.status === exit && badUp.env?.error?.message?.includes(diagnosis) && badUp.env.error.remedy === seedRemedy &&
        status.status === 0 && status.env?.result?.selected?.code === "not-started" && status.env.result.selected.message.includes("is stopped") && status.env.result.selected.channelSeedBlocksRestart === true &&
        status.env.result.hints.some((hint: string) => hint.includes(diagnosis) && hint.includes(seedRemedy)) &&
        statusText.stdout.includes(seedRemedy) && !statusText.stdout.includes(`start it again with \`${launcher} up`) && !/^ +(?:pnpm )?cotal up(?:\s|$)/m.test(statusText.stdout) &&
        refused(ps, 2, "TARGET_UNAVAILABLE") && ps.env?.error?.message?.includes(diagnosis) && ps.env.error.remedy === seedRemedy &&
        readFileSync(defaultSeed, "utf8") === seed, { up: shown(badUp), status: status.env?.result?.hints, text: shown(statusText), ps: shown(ps) });
    const components = await run(["status", "--components", "--space", "demo"], {}, fresh);
    const [report = "", health = ""] = components.stdout.split("\nComponent Health\n");
    check(`component health reports the stopped target without restart advice when the seed ${problem}`,
      components.status === 1 && report.includes(`Restart blocked: ${diagnosis}`) && report.includes(seedRemedy) &&
        /^  target +absent · not-started · "demo" is stopped/m.test(health) && !health.includes(`\`${launcher} up`),
      { status: components.status, health, report, stderr: components.stderr });
  }
  writeFileSync(defaultSeed, "{}\n");
  const repairedPs = await json(["ps", "--space", "demo"], fresh);
  check("repairing the seed restores broker-only restart advice", refused(repairedPs, 2, "TARGET_UNAVAILABLE") && repairedPs.env?.error?.remedy === `start it again with \`${launcher} up --no-manager\` in ${fresh}`, shown(repairedPs));
  const repairedComponents = await run(["status", "--components", "--space", "demo"], {}, fresh);
  const repairedHealth = repairedComponents.stdout.split("\nComponent Health\n")[1] ?? "";
  check("repairing the seed restores restart advice on the absent component row",
    repairedComponents.status === 1 && !repairedComponents.stdout.includes("Restart blocked:") &&
      /^  target +absent · not-started · "demo" is stopped/m.test(repairedHealth) && repairedHealth.includes(`start it again with \`${launcher} up --no-manager\` in ${fresh}`),
    { status: repairedComponents.status, health: repairedHealth, stderr: repairedComponents.stderr });
  unlinkSync(defaultSeed);
  // The stopped stack keeps its recorded address and effective broker inputs. A different --server
  // or --host refuses before anything is written, naming the recorded value and the bare up
  // that starts the stack there.
  const recordedRoot = realpathSync(fresh), journalBefore = readFileSync(stackJournalPath(fresh), "utf8");
  const moved = await json(["up", "--detach", "--no-manager", "--server", `nats://127.0.0.1:${await freePort()}`], fresh);
  check("up --server naming another address is CONFLICT, exit 2, naming the recorded address and bare cotal up from the root",
    refused(moved, 2, "CONFLICT") && (moved.env?.error?.message ?? "").includes(`recorded at ${server}`) &&
      moved.env?.error?.remedy === `run bare \`cotal up\` from ${recordedRoot} to start it at ${server}`, shown(moved));
  // While another program holds the recorded address, bare up refuses too, so this refusal names that
  // address and the process of this account that listens there, and says no command moves the stack.
  const occupier = createServer();
  const port = await listenOn(occupier, Number(new URL(server).port));
  try {
    const held = await json(["up", "--detach", "--no-manager", "--server", `nats://127.0.0.1:${await freePort()}`], fresh);
    check("...and while another program holds that address, it names the address and that process, and says no command moves the stack",
      refused(held, 2, "CONFLICT") && new RegExp(`a recorded stack is not moved to another address, and another process holds that address 127\\.0\\.0\\.1:${port}, where process ${process.pid} \\(\\S+\\) of this account listens$`).test(held.env?.error?.message ?? "") &&
        held.env?.error?.remedy === `stop the process listening on 127.0.0.1:${port}, then run bare \`cotal up\` from ${recordedRoot}; no command moves a stack that ran to another address, so it starts only at ${server}`, shown(held));
  } finally { await new Promise<void>((done) => occupier.close(() => done())); }
  // Omit --server to use the recorded address and reach the recorded-input comparison.
  const bound = await json(["up", "--detach", "--no-manager", "--host", "127.0.0.2"], fresh);
  check("up --host naming a different bind is CONFLICT, exit 2, naming both hosts and the broker-only cotal up, and prepares nothing",
    refused(bound, 2, "CONFLICT") && (bound.env?.error?.message ?? "").includes("--host 127.0.0.2 (recorded: 127.0.0.1)") &&
      (bound.env?.error?.message ?? "").includes("nothing was prepared") &&
      (bound.env?.error?.remedy ?? "").includes(`run \`cotal up --no-manager\` from ${recordedRoot}`), shown(bound));
  check("none of these refusals changed the stack journal", readFileSync(stackJournalPath(fresh), "utf8") === journalBefore);
  const brokerBefore = readStackJournal(fresh)?.journal.broker;
  const sameBind = await json(["up", "--no-manager", "--server", server, "--host", "127.0.0.1"], fresh);
  const brokerAfter = readStackJournal(fresh)?.journal.broker;
  check("up --host naming the implicit loopback bind starts the stack and leaves the journal's broker inputs unchanged, with host omitted",
    sameBind.status === 0 && sameBind.env?.outcome === "ok" && sameBind.env.result.server === server &&
      brokerBefore !== undefined && brokerBefore.host === undefined && JSON.stringify(brokerAfter) === JSON.stringify(brokerBefore),
    { up: shown(sameBind), brokerBefore, brokerAfter });
  assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: fresh, env: runEnv });
  check("down stops the stack restarted with its implicit loopback bind", (await json(["down", "--yes"], fresh)).status === 0);
  // With no space selected, a start selects its own space and its JSON says so. The selection stays
  // through the space's down.
  clearCurrent();
  const selects = await json(["up", "--detach", "--no-manager"], fresh);
  check("with no space selected, up selects its space and its JSON says this up changed the selection",
    selects.status === 0 && getCurrent() === "demo" && selects.env?.result.selection?.current === "demo" && selects.env.result.selection.changed === true, shown(selects));
  assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: fresh, env: runEnv });
  const restopped = await run(["down", "--yes"], {}, fresh);
  check("...and down stops it again with the space still selected", restopped.status === 0 && getCurrent() === "demo", { ...shown(restopped), current: getCurrent() });
  // After its down, the space reads as stopped with its last operation, as `status` reads it.
  const stoppedList = await json(["space"]), stoppedListHuman = await run(["space", "--plain"]);
  check("after down, space lists it as stopped with its last operation, under a State column",
    stoppedList.env?.result.prepared.some((p: { space: string; state: string; lastOperation: unknown }) => p.space === "demo" && p.state === "stopped" && p.lastOperation === "`cotal down`, completed")
      && /^Prepared spaces$/m.test(stoppedListHuman.stdout) && /demo \(selected\) +stopped - `cotal down`, completed/.test(stoppedListHuman.stdout), { json: stoppedList.env?.result.prepared, human: stoppedListHuman.stdout });
  const stoppedShow = await json(["space", "show"], fresh), stoppedShowHuman = await run(["space", "show", "--plain"], {}, fresh);
  check("...space show gives the same state and names cotal up --no-manager in its root",
    stoppedShow.env?.result.state === "stopped" && stoppedShow.env.result.lastOperation === "`cotal down`, completed"
      && /^broker: +stopped - `cotal down`, completed$/m.test(stoppedShowHuman.stdout) && stoppedShowHuman.stdout.includes(`start it again with \`${launcher} up --no-manager\` in ${fresh}`), { json: stoppedShow.env?.result, human: stoppedShowHuman.stdout });
  const stoppedUse = await json(["use"]), stoppedUseHuman = await run(["use", "--plain"]);
  check("...and use reports it as stopped, not as prepared and not started",
    stoppedUse.env?.result.preparedState === "stopped" && stoppedUse.env.result.lastOperation === "`cotal down`, completed"
      && stoppedUseHuman.stdout.includes(`stopped; its last operation, \`cotal down\`, completed - start it again with \`cotal up --no-manager\` in ${fresh}`) && !/not started/.test(stoppedUseHuman.stdout), { json: stoppedUse.env?.result, human: stoppedUseHuman.stdout });
  const selectStopped = await json(["use", "demo"], fresh);
  const besideStopped = await run(["meshes", "add", "beside-stopped", "--server", DEAD, "--root", root, "--mode", "open", "--force"], {}, fresh);
  const stillStopped = await json(["use"], fresh);
  check("meshes add preserves an explicitly selected stopped space and does not announce a new default",
    selectStopped.status === 0 && besideStopped.status === 0 && findMesh("beside-stopped")?.server === DEAD && !besideStopped.stdout.includes("it is now the default mesh") &&
      stillStopped.env?.result.current === "demo" && stillStopped.env.result.preparedState === "stopped" && readCurrentSelection()?.source === "explicit",
    { add: shown(besideStopped), selection: stillStopped.env?.result });
  const stoppedTarget = await json(["who"], fresh);
  check("after registration, commands still refuse the selected stopped space instead of targeting the new entry",
    refused(stoppedTarget, 2, "TARGET_UNAVAILABLE") && stoppedTarget.env?.target?.space === "demo", shown(stoppedTarget));
  const removedBesideStopped = await run(["meshes", "rm", "beside-stopped"]);
  check("removing that registration preserves the stopped selection",
    removedBesideStopped.status === 0 && getCurrent() === "demo" && readCurrentSelection()?.source === "explicit", shown(removedBesideStopped));
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
  // The down that stopped it did not take --with-agents, but no manager ever ran in this stack.
  assertSmokeSandboxDown(sandbox, ["down", "--with-agents", "--dry-run", "--json"], { cwd: fresh, env: runEnv });
  const reapPreview = await json(["down", "--with-agents", "--dry-run"], fresh);
  assertSmokeSandboxDown(sandbox, ["down", "--with-agents", "--yes", "--json"], { cwd: fresh, env: runEnv });
  const reap = await json(["down", "--with-agents", "--yes"], fresh);
  check("down --with-agents --yes of a stopped stack that never ran a manager is a no-op",
    reap.status === 0 && reap.env?.outcome === "no-op" && reap.env.result?.kind === "stack-not-running", shown(reap));
  check("its dry run shows the same no-op without a manager warning",
    reapPreview.status === 0 && reapPreview.env?.outcome === "no-op" && reapPreview.env.result?.kind === "stack-not-running" && reapPreview.env.warnings?.length === 0, shown(reapPreview));
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
  const goneAdd = await json(["space", "add", "gone", "--server", DEAD, "--root", projectRoot("remote-registration"), "--force", "--yes"]);
  const goneRemedy = goneAdd.env?.error?.remedy ?? "";
  check("adding a prepared name from another root names the missing project to restore or the registration to forget",
    refused(goneAdd, 2, "CONFLICT") && goneRemedy.includes("restore its project folder first") && goneRemedy.includes(goneRoot) && goneRemedy.includes("--space gone") && goneRemedy.includes("space forget gone") && findPreparedSpace("gone")?.root === goneRoot && findMesh("gone") === undefined, shown(goneAdd));
  const goneTarget = await json(["who", "--space", "gone"]);
  check("a prepared space whose folder was deleted is TARGET_UNAVAILABLE, saying the folder is gone and naming space forget",
    refused(goneTarget, 2, "TARGET_UNAVAILABLE") && (goneTarget.env?.error?.message ?? "").includes(`${goneRoot}, which no longer exists`) && (goneTarget.env?.error?.remedy ?? "").includes("cotal space forget gone"), shown(goneTarget));
  const gonePersona = await json(["persona", "--space", "gone"]);
  check("persona names the deleted folder and space forget",
    refused(gonePersona, 2, "TARGET_UNAVAILABLE") && (gonePersona.env?.error?.message ?? "").includes(`${goneRoot}, which no longer exists`) && (gonePersona.env?.error?.remedy ?? "").includes("cotal space forget gone"), shown(gonePersona));
  const goneShow = await json(["space", "show", "gone"]);
  const goneShowPlain = await run(["space", "show", "gone", "--plain"]);
  check("space show says the folder is gone and names forget and create, not cotal up",
    goneShow.status === 0 && goneShow.env?.result.kind === "prepared-space" && goneShow.env.result.rootMissing === true &&
      goneShowPlain.stdout.includes(`prepared in ${goneRoot}, which no longer exists`) && goneShowPlain.stdout.includes(`forget it with \`${launcher} space forget gone\`, then prepare it again with \`${launcher} space create gone --root <dir>\``) && !goneShowPlain.stdout.includes("cotal up"), { json: shown(goneShow), plain: shown(goneShowPlain) });
  const goneList = await json(["space"]);
  const goneListPlain = await run(["space", "--plain"]);
  check("the space listing marks the folder gone and names forget and create for it",
    goneList.status === 0 && goneList.env?.result?.prepared?.find((p: { space: string }) => p.space === "gone")?.rootMissing === true &&
      goneListPlain.stdout.includes(`${goneRoot} (no longer exists)`) && goneListPlain.stdout.includes(`${launcher} space forget gone`) && goneListPlain.stdout.includes(`\`${launcher} space create gone --root <dir>\``), { json: shown(goneList), plain: shown(goneListPlain) });
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
  // Prepared there and recorded as ".", the root resolves the registration to itself and takes the
  // controller route. Recorded as "../elsewhere" with no prepared record, it does not, so the root
  // takes the legacy route, which has no --json receipt. Each route gets its own root: a refused
  // controller attempt leaves its stack journal.
  const server = `nats://127.0.0.1:${await freePort()}`;
  for (const [space, recorded, route] of [["relhere", ".", "controller"], ["relaway", "../elsewhere", "legacy"]] as const) {
    const claimRoot = projectRoot(`claim-${route}`);
    if (route === "controller") await json(["space", "create", space], claimRoot);
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
// A regular file, or a path under one, is a usage refusal that names it, on up and on backup restore,
// and so is a control directory or a path in one. A directory other local accounts can write in the
// store's existing path refuses as a project root does; world write refuses on every host. None of
// them writes a stack journal.
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
    refused(restoreFile, 1, "USAGE_INVALID") && (restoreFile.env?.error?.message ?? "").includes(`the --store-dir path ${file} is not a directory`) &&
      (restoreFile.env?.error?.remedy ?? "").includes("does not exist yet, inside an existing writable directory"), shown(restoreFile));
  const writable = await json(["up", "--server", DEAD, "--store-dir", join(exposed, "store")], storeRoot);
  check("up --store-dir in a directory every account can write is PERMISSION_DENIED, exit 2, naming it with its chmod",
    refused(writable, 2, "PERMISSION_DENIED") && (writable.env?.error?.message ?? "").includes(`${exposed} is writable by every local account`) &&
      writable.env?.error?.remedy === `chmod go-w ${exposed}` && !existsSync(join(exposed, "store")), shown(writable));
  // A control directory, or a path in one, refuses as usage, other than the root's own default store.
  const control = join(storeRoot, ".cotal");
  const asControl = await json(["up", "--server", DEAD, "--store-dir", control], storeRoot);
  check("up --store-dir naming the root's .cotal is USAGE_INVALID, exit 1, naming the control directory",
    refused(asControl, 1, "USAGE_INVALID") && (asControl.env?.error?.message ?? "").includes(`the --store-dir path ${control} is the control directory ${control}`) && !existsSync(join(control, "jetstream")), shown(asControl));
  const homeStore = join(process.env.COTAL_HOME!, "nats");
  const inHome = await json(["up", "--server", DEAD, "--store-dir", homeStore], storeRoot);
  check("up --store-dir in the machine home's .cotal is the same refusal",
    refused(inHome, 1, "USAGE_INVALID") && (inHome.env?.error?.message ?? "").includes(`the --store-dir path ${homeStore} is in the control directory ${process.env.COTAL_HOME}`), shown(inHome));
  const restoreControl = await json(["backup", "restore", join(home, "no-backup"), "--store-dir", join(control, "auth")], storeRoot);
  check("backup restore --store-dir in the root's .cotal is the same refusal",
    refused(restoreControl, 1, "USAGE_INVALID") && (restoreControl.env?.error?.message ?? "").includes(`is in the control directory ${control}`) &&
      (restoreControl.env?.error?.remedy ?? "").includes("does not exist yet, inside an existing writable directory") &&
      (restoreControl.env?.error?.remedy ?? "").includes("outside the control directory"), shown(restoreControl));
  // A link would be recorded as the store path, which no reset removes: it refuses, naming its target.
  const real = join(realpathSync(home), "operator's store");
  mkdirSync(real, { mode: 0o700 });
  const link = join(home, "store-link");
  symlinkSync(real, link);
  const asLink = await json(["up", "--server", DEAD, "--store-dir", link], storeRoot);
  const storeRetry = asLink.env?.error?.remedy?.match(/^name the directory itself with (--store-dir .+)$/)?.[1];
  check("up --store-dir naming a link is USAGE_INVALID, exit 1, naming the directory it points to",
    refused(asLink, 1, "USAGE_INVALID") && (asLink.env?.error?.message ?? "").includes(`the --store-dir path ${link} is a link to ${real}`) && !!storeRetry && readdirSync(real).length === 0, shown(asLink));
  if (process.platform !== "win32") {
    // The next flag check proves the pasted path passes validation without starting a broker.
    const pasted = storeRetry && spawnSync("sh", ["-c", `exec "$@" ${storeRetry}`, "sh", process.execPath, BIN, "up", "--server", DEAD, "--restore-only", "x"],
      { cwd: storeRoot, env: runEnv, encoding: "utf8", timeout: 30_000 });
    check("pasting the store retry passes store validation with a space and an apostrophe", !!pasted && pasted.status === 1 &&
      pasted.stderr.includes("--restore-only takes registry"), pasted ? shown(pasted) : shown(asLink));
  }
  const restoreLink = await json(["backup", "restore", join(home, "no-backup"), "--store-dir", link], storeRoot);
  check("backup restore --store-dir naming a link is the same refusal",
    refused(restoreLink, 1, "USAGE_INVALID") && (restoreLink.env?.error?.message ?? "").includes(`the --store-dir path ${link} is a link to ${real}`), shown(restoreLink));
  rmSync(real, { recursive: true, force: true });
  // The next flag check refuses instead, so the root's own .cotal/nats passed the store check.
  const ownStore = await json(["up", "--server", DEAD, "--store-dir", join(control, "nats"), "--restore-only", "x"], storeRoot);
  check("up --store-dir naming the root's own .cotal/nats passes the store check",
    refused(ownStore, 1, "USAGE_INVALID") && (ownStore.env?.error?.message ?? "").includes("--restore-only takes registry"), shown(ownStore));
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const sealed = join(home, "store-sealed");
    mkdirSync(sealed);
    chmodSync(sealed, 0o500);
    const uncreatable = await json(["up", "--server", DEAD, "--store-dir", join(sealed, "store")], storeRoot);
    check("up --store-dir under a directory this account cannot write is PERMISSION_DENIED, exit 2, naming it",
      refused(uncreatable, 2, "PERMISSION_DENIED") && (uncreatable.env?.error?.message ?? "").includes(`cannot be created, because this account cannot write ${sealed}`) &&
        !existsSync(join(sealed, "store")), shown(uncreatable));
    chmodSync(sealed, 0o700);
  }
  check("no store refusal wrote a stack journal", !existsSync(stackJournalPath(storeRoot)));
  rmSync(exposed, { recursive: true, force: true });
}

// ── A --store-dir that does not exist, while the last served store holds data ───────────────────────
// It is taken for a mistyped path and refused, and nothing is created. A directory created first
// names a new store on purpose and passes.
{
  const lastRoot = projectRoot("store-last");
  // Its own address: `DEAD` is the one a hand-added registration holds in this suite, and a start
  // there is refused by that claim before it reaches the store rules these cells are about.
  const unheld = `nats://127.0.0.1:${await freePort()}`;
  const last = join(lastRoot, "altstore");
  const typo = join(lastRoot, "altstoer");
  mkdirSync(join(last, "jetstream"), { recursive: true });
  writeFileSync(join(lastRoot, ".cotal", "server-open.conf"), `jetstream { store_dir: ${JSON.stringify(last)} }\n`);
  writeFileSync(join(lastRoot, "cotal.yaml"), `apiVersion: cotal/v1\nkind: Mesh\nspace: store-last\nbroker: { servers: "${unheld}", auth: false }\nchannels:\n  lobby: { description: "base" }\n`);
  const mistyped = await run(["up", "-f", "cotal.yaml", "--dry-run", "--store-dir", typo], {}, lastRoot);
  check("up -f --store-dir naming a missing path while the last store holds data refuses CONFLICT, exit 2, naming both",
    mistyped.status === 2 && mistyped.stderr.includes("CONFLICT") && mistyped.stderr.includes(`served the store ${last}, and --store-dir names ${typo}, which does not exist`) &&
      mistyped.stderr.includes(`reopen it with --store-dir ${last}`), shown(mistyped));
  check("the refused start created no store", !existsSync(typo));
  mkdirSync(typo);
  const created = await run(["up", "-f", "cotal.yaml", "--dry-run", "--store-dir", typo], {}, lastRoot);
  check("the same start with the directory created first is not refused", created.status === 0, shown(created));
}

if (process.platform !== "win32" && process.getuid?.() !== 0) {
  const name = "retained", folder = projectRoot("with space"), file = meshFile(name);
  const add = await json(["space", "add", name, "--root", folder, "--mode", "open", "--server", DEAD, "--force"], folder);
  const previous = readCurrentSelection();
  const selected = await json(["use", name], folder);
  check("the permission fixture is a valid selected registration", add.status === 0 && selected.status === 0 && getCurrent() === name, shown(selected));
  const contents = readFileSync(file, "utf8");
  chmodSync(file, 0o000);
  try {
    for (const verb of ["show", "forget"]) {
      const r = await json(["space", verb, name], folder);
      check(`space ${verb} refuses a registration it cannot read and tells the user to restore access`,
        refused(r, 2, "PERMISSION_DENIED") && r.env?.target?.file === file && /^restore read access to /.test(r.env.error?.remedy ?? ""), shown(r));
    }
    check("the refused forget keeps the registration and the selection", existsSync(file) && getCurrent() === name);
  } finally {
    if (existsSync(file)) chmodSync(file, 0o600);
  }
  check("restoring read access recovers the original registration", existsSync(file) && readFileSync(file, "utf8") === contents && (await json(["space", "show", name], folder)).status === 0);
  const forgotten = await json(["space", "forget", name], folder);
  check("normal forget can remove the readable registration and clear its selection", forgotten.status === 0 && !existsSync(file) && getCurrent() === undefined, shown(forgotten));
  if (previous?.source === "explicit") setCurrent(previous.space);
  else if (previous) setAdoptedCurrent(previous.space);
}

// ── A regular file where the prepared spaces folder belongs ─────────────────────────────────────────
// Every command that reads that folder refuses by it, as it refuses an unreadable registry folder.
{
  const dir = preparedSpacesDir(), aside = `${dir}.aside`, held = existsSync(dir);
  if (held) renameSync(dir, aside);
  writeFileSync(dir, "not a folder");
  const folder = projectRoot("prepared-file");
  for (const args of [["space"], ["space", "create", "pf"], ["use", "pf"], ["space", "show", "pf"], ["up", "--server", DEAD, "--no-manager"]]) {
    const r = await json(args, folder);
    check(`${args.slice(0, 2).join(" ")} with a file at the prepared spaces folder refuses SCHEMA_INVALID, exit 1, saying it is a file and how to move it aside`,
      refused(r, 1, "SCHEMA_INVALID") && r.env?.target?.file === dir && r.env.error?.message === `${dir} is a file, not a folder` &&
        r.env.error?.remedy === `move ${dir} aside, for example \`mv -- ${shellPath(dir)} ${shellPath(`${dir}.old`)}\`; Cotal makes the folder when it next prepares a space`, shown(r));
  }
  check("...and none of them wrote: the folder is still the file, and the project has only its .cotal", readFileSync(dir, "utf8") === "not a folder" && readdirSync(folder).join() === ".cotal");
  // status names the folder and reports the rest, exit 4, with a space selected that is not registered.
  const selection = getCurrent();
  setCurrent("pf");
  const report = await json(["status"], folder);
  if (selection === undefined) clearCurrent(); else setCurrent(selection);
  const hints: string[] = report.env?.result?.hints ?? [];
  check("status with that space selected is partial, exit 4, naming the folder under meshes.unreadable, with each hint once",
    report.status === 4 && report.env?.outcome === "partial" && Boolean(report.env.result?.meshes?.unreadable?.some((u: { file: string }) => u.file === dir)) && new Set(hints).size === hints.length, shown(report));
  rmSync(dir);
  if (held) renameSync(aside, dir);
  // A record in it that does not parse, or is not a prepared space record, is skipped with a warning
  // naming its file, and refuses only a command about the space its file is named for.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  recordPreparedSpace({ space: "pready", root: projectRoot("prepared-ready"), ts: new Date().toISOString() });
  const damaged = join(dir, `${spaceSegment("pf")}.json`);
  for (const [label, body] of [["unparsed", "{ not json"], ["unshaped", '{"space":"pf"}'], ["null", "null"]]) {
    writeFileSync(damaged, body);
    const list = await json(["space"], folder);
    const skipped = list.env?.warnings?.find((w: { code: string }) => w.code === "PREPARED_RECORD_SKIPPED");
    check(`space with a damaged prepared record (${label}) lists the rest and warns PREPARED_RECORD_SKIPPED, naming the file and its forget`,
      list.status === 0 && list.env?.result?.prepared?.some((p: { space: string }) => p.space === "pready") && skipped?.target?.file === damaged && skipped.target.space === "pf" &&
        skipped.message.endsWith("so it is skipped; remove it with `cotal space forget pf`"), shown(list));
    const other = await json(["space", "show", "pready"], folder);
    check(`space show of another space beside that record (${label}) succeeds`, other.status === 0 && other.env?.outcome === "ok", shown(other));
    if (label === "null") {
      const selected = await json(["use", "pready"], folder);
      check("use selects the healthy prepared space beside a null record",
        selected.status === 0 && selected.env?.result?.current === "pready" && getCurrent() === "pready", shown(selected));
    }
    if (label !== "unshaped") {
      const report = await json(["status"], folder);
      check(`status names that record (${label}) under meshes.unreadable, exit 4, with one warning for it`,
        report.status === 4 && Boolean(report.env?.result?.meshes?.unreadable?.some((u: { file: string }) => u.file === damaged)) &&
          (report.env?.warnings ?? []).filter((w: { target?: { file?: string } }) => w.target?.file === damaged).length === 1, shown(report));
      const text = await run(["status"], {}, folder);
      check(`status text says the record (${label}) is skipped once on stderr`, text.status === 4 && text.stderr.replace(/\n\s+/g, " ").split("so it is skipped").length === 2, shown(text));
    }
    const own = await json(["use", "pf"], folder);
    check(`use pf with its own record damaged (${label}) refuses SCHEMA_INVALID, exit 1, naming that file and the forget that removes it`,
      refused(own, 1, "SCHEMA_INVALID") && own.env?.target?.file === damaged && own.env.error?.message === `${damaged} is not a usable prepared space record` &&
        own.env.error?.remedy === "remove it with `cotal space forget pf`", shown(own));
    if (label === "null") {
      check("refusing to select its null record leaves the selection and record untouched", getCurrent() === "pready" && readFileSync(damaged, "utf8") === body);
      if (selection === undefined) clearCurrent(); else setCurrent(selection);
    }
    const forget = await json(["space", "forget", "pf"], folder);
    check(`space forget pf removes its damaged record (${label}), with no root`,
      forget.status === 0 && forget.env?.result?.kind === "space-forgotten" && forget.env.result.root === null && !existsSync(damaged), shown(forget));
  }
  mkdirSync(damaged, { mode: 0o700 });
  const preparedDirectory = await json(["space"], folder);
  const forgetPreparedDirectory = await json(["space", "forget", "pf"], folder);
  check("an occupied prepared record path warns with the same move-aside step that forget gives",
    preparedDirectory.status === 0 && refused(forgetPreparedDirectory, 1, "SCHEMA_INVALID") && forgetPreparedDirectory.env?.error?.message.includes("nothing was forgotten") && statSync(damaged).isDirectory() &&
      preparedDirectory.env?.warnings?.some((w: { code: string; message: string }) => w.code === "PREPARED_RECORD_SKIPPED" && w.message.includes(`${damaged} is a directory`) && w.message.endsWith(`so it is skipped; ${forgetPreparedDirectory.env?.error?.remedy}`) && !w.message.includes("space forget")), shown(forgetPreparedDirectory));
  renameSync(damaged, join(home, "prepared-directory-aside"));
  const stray = join(dir, "stray.json");
  writeFileSync(stray, "{ not json");
  const strayList = await json(["space"], folder);
  check("a damaged file named for no space is skipped with a warning to remove it",
    strayList.status === 0 && Boolean(strayList.env?.warnings?.some((w: { code: string; target: { file: string; space: unknown }; message: string }) =>
      w.code === "PREPARED_RECORD_SKIPPED" && w.target.file === stray && w.target.space === null && w.message.endsWith("so it is skipped; remove it"))), shown(strayList));
  rmSync(stray);
  // A valid record this account may not read, as one left owned by root, is not called damaged: its
  // step gives the file back and keeps it, and the refusal is a denial.
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    recordPreparedSpace({ space: "pf", root: projectRoot("prepared-denied"), ts: new Date().toISOString() });
    chmodSync(damaged, 0o000);
    const giveBack = `make it readable by this account again, for example with \`sudo chown "$(id -un)" ${shellPath(damaged)}\` and \`chmod 600 ${shellPath(damaged)}\`; the record is kept`;
    const list = await json(["space"], folder);
    const skipped = list.env?.warnings?.find((w: { code: string }) => w.code === "PREPARED_RECORD_SKIPPED");
    check("space beside an unreadable prepared record warns that it could not be read, naming the step that gives it back",
      list.status === 0 && skipped?.target?.file === damaged && skipped.message.startsWith(`${damaged} could not be read (EACCES`) && skipped.message.endsWith(`so it is skipped; ${giveBack}`) && !skipped.message.includes("does not parse"), shown(list));
    const own = await json(["use", "pf"], folder);
    check("use pf with its own record unreadable refuses PERMISSION_DENIED, exit 2, naming that file and the step that gives it back, not its forget",
      refused(own, 2, "PERMISSION_DENIED") && own.env?.target?.file === damaged && own.env.error?.message === `${damaged} cannot be read by this account` && own.env.error?.remedy === giveBack, shown(own));
    const forget = await json(["space", "forget", "pf"], folder);
    check("space forget gives the same permission refusal and keeps the unreadable record",
      refused(forget, 2, "PERMISSION_DENIED") && forget.env?.target?.file === damaged &&
      forget.env.error?.message === own.env?.error?.message && forget.env.error?.remedy === giveBack && existsSync(damaged), shown(forget));
    chmodSync(damaged, 0o600);
    const readable = await json(["space", "show", "pf"], folder);
    check("once it is readable again, space show pf reads it", readable.status === 0 && readable.env?.outcome === "ok", shown(readable));
    const retried = await json(["space", "forget", "pf"], folder);
    check("once readable, space forget reports the prepared root and removes the record",
      retried.status === 0 && retried.env?.result?.root === readable.env?.result?.root && !existsSync(damaged), shown(retried));
  }
  removePreparedSpace("pready");

  // A damaged registration record refuses every command that reads the registry, so its own forget
  // must clear it (#7335): the refusal names that forget, and the forget removes the file.
  mkdirSync(meshesDir(), { recursive: true, mode: 0o700 });
  const registration = join(meshesDir(), `${spaceSegment("pold")}.json`);
  const corrupt = '{"space":"pold",';
  writeFileSync(registration, corrupt);
  const blocked = await json(["space"], folder);
  check("space with a damaged registration record refuses SCHEMA_INVALID, exit 1, naming the forget that removes it",
    refused(blocked, 1, "SCHEMA_INVALID") && blocked.env?.target?.file === registration &&
      blocked.env.error?.remedy === "restore the record from backup, or remove it with `cotal space forget pold`", shown(blocked));
  const preview = await run(["space", "delete", "pold", "--dry-run", "--plain"], {}, folder);
  check("delete preview names the damaged registration and its recovery without contacting a broker",
    preview.status === 2 && preview.stderr.includes("TARGET_UNAVAILABLE") && preview.stderr.includes(registration) &&
      preview.stderr.includes("no broker was contacted") && preview.stderr.includes(blocked.env?.error?.remedy ?? "missing remedy"), shown(preview));
  const applied = await json(["space", "delete", "pold", "--yes"], folder);
  check("confirmed delete reports the same registry refusal and keeps the damaged record",
    refused(applied, 2, "TARGET_UNAVAILABLE") && applied.env?.target?.space === "pold" &&
      applied.env.error?.message === `${blocked.env?.error?.message}; no broker was contacted for this read` &&
      applied.env.error?.remedy === blocked.env?.error?.remedy && readFileSync(registration, "utf8") === corrupt, shown(applied));
  const forgetRegistration = await json(["space", "forget", "pold"], folder);
  check("space forget pold removes its damaged registration record, with no broker, root or origin",
    forgetRegistration.status === 0 && forgetRegistration.env?.result?.kind === "space-forgotten" && forgetRegistration.env.result.server === null &&
      forgetRegistration.env.result.root === null && forgetRegistration.env.result.origin === null && !existsSync(registration), shown(forgetRegistration));
  const text = await run(["space", "forget", "pold"], {}, folder);
  check("  and a second forget finds nothing to forget, exit 2", text.status === 2 && /no space named "pold" is registered here/.test(text.stderr), shown(text));
  check("space lists again once it is gone", (await json(["space"], folder)).status === 0);
  for (const legacy of [false, true]) {
    const name = legacy ? "damagedlegacy" : "damagedprepared";
    const at = projectRoot(name), elsewhere = projectRoot(`${name}-new`);
    const prepared = await json(["space", "create", name, "--root", at]);
    check(`rig: ${name} is prepared`, prepared.status === 0, shown(prepared));
    const file = join(meshesDir(), `${legacy ? encodeURIComponent(name) : spaceSegment(name)}.json`);
    writeFileSync(file, `{"space":"${name}",`, { mode: 0o600 });
    const rm = await run(["meshes", "rm", name, "--force"], {}, folder);
    check("meshes rm of a damaged registration names its safe forget route and keeps both records",
      rm.status === 1 && rm.stderr.includes(`cotal space forget ${name}`) && existsSync(file) && findPreparedSpace(name)?.root === at, shown(rm));
    const forgotten = await json(["space", "forget", name], folder);
    check("one forget clears both the damaged registration and its prepared record",
      forgotten.status === 0 && forgotten.env?.result.root === at && !existsSync(file) && findPreparedSpace(name) === undefined, shown(forgotten));
    const reused = await json(["space", "create", name, "--root", elsewhere]);
    check("the forgotten name can immediately be prepared in a different folder", reused.status === 0, shown(reused));
    removePreparedSpace(name);
  }
}

if (process.platform !== "win32") {
  const recoveryHome = join(home, "operator's recovery");
  mkdirSync(recoveryHome, { mode: 0o700 });
  const file = join(recoveryHome, "prepared");
  writeFileSync(file, "not a folder");
  const env = { COTAL_HOME: recoveryHome, NO_COLOR: "1" };
  const inventory = await run(["space", "--plain"], env);
  const move = /for example `(mv [^`]+)`/.exec(inventory.stderr)?.[1];
  const pasted = move && spawnSync("sh", ["-c", move], { cwd: home, env: { ...runEnv, ...env }, encoding: "utf8", timeout: 30_000 });
  const recovered = await run(["space", "--plain"], env);
  check("pasting the prepared folder repair preserves the file and allows inventory to run", inventory.status === 1 &&
    inventory.stderr.includes(`${file} is a file, not a folder`) && !!pasted && pasted.status === 0 && !existsSync(file) &&
    existsSync(`${file}.old`) && readFileSync(`${file}.old`, "utf8") === "not a folder" && recovered.status === 0,
    { inventory: shown(inventory), move: pasted ? shown(pasted) : move, recovered: shown(recovered) });
}

// A selection hint must accept the exact name of a retained offline registration.
{
  const space = "-old";
  const env = { COTAL_HOME: join(home, "legacy-selection-home") };
  const root = join(home, "legacy-selection-root");
  mkdirSync(root);
  mkdirSync(join(env.COTAL_HOME, "meshes"), { recursive: true });
  writeFileSync(join(env.COTAL_HOME, "meshes", `${space}.json`), JSON.stringify({ space, root, server: DEAD, mode: "open", origin: "manual", ts: new Date().toISOString() }));
  const show = await run(["space", "show", "--", space], env);
  const command = /select it with `(?:pnpm )?cotal ([^`]+)`/.exec(show.stdout)?.[1];
  const selected = command && await run(command.split(" "), env);
  const current = await run(["use", "--json"], env);
  check("following the space show hint selects an offline historical space with a leading dash",
    show.status === 0 && !!selected && selected.status === 0 && current.status === 0 && JSON.parse(current.stdout).result.current === space,
    { show: shown(show), selected: selected && shown(selected), current: shown(current) });
}

// An open space registered by an earlier release must still start under its exact old name.
if (process.platform !== "win32") {
  const project = join(home, "legacy-open");
  mkdirSync(join(project, ".cotal"), { recursive: true, mode: 0o700 });
  const space = "bad space";
  const server = `nats://127.0.0.1:${await freePort()}`;
  const registration = { space, root: project, server, mode: "open", origin: "up", ts: new Date().toISOString() } as const;
  recordMesh(registration);
  const sandbox = recordSmokeSandbox({ root: project, cotalHome: runEnv.COTAL_HOME, xdgConfigHome: runEnv.XDG_CONFIG_HOME });
  const child = spawn(process.execPath, [BIN, "up", "--open", "--foreground", "--no-manager", "--space", space, "--server", server], {
    cwd: project, env: runEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  teardownOnSignal(child);
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const ready = /up at|wrote default persona|Foreground stack lifetime/;
  try {
    for (let i = 0; i < 240 && child.exitCode === null && !ready.test(output); i++)
      await new Promise((resolve) => setTimeout(resolve, 250));
    const shownSpace = await json(["space", "show", space], project);
    check("foreground up of a registered odd name starts its exact open space", ready.test(output) && shownSpace.status === 0 && shownSpace.env?.result?.check === "reachable", { output: output.slice(-1500), show: shown(shownSpace) });
    const preview = await json(["space", "delete", space, "--dry-run"], project);
    check("space delete previews the exact odd name and its live streams without changing anything",
      preview.status === 0 && preview.env?.target?.space === space && preview.env.result.effectAttempted === false &&
        preview.env.result.streams.some((stream: { name: string; state: string }) => stream.name === "CHAT_bad_space" && stream.state === "present"), shown(preview));
    recordMesh({ ...registration, space: "-legacy", origin: "manual" });
    const dashed = await json(["space", "delete", "--dry-run", "--", "-legacy"], project);
    check("space delete still accepts registered leading-dash tokens after --", dashed.status === 0 && dashed.env?.target?.space === "-legacy", shown(dashed));
    removeMesh("-legacy");
    recordMesh({ ...registration, space: "bad_space", origin: "manual" });
    const ambiguous = await json(["space", "delete", space, "--dry-run"], project);
    check("space delete refuses ambiguous streams shared by two open-space names",
      refused(ambiguous, 2, "CONFLICT") && /maps to the same streams/.test(ambiguous.env?.error?.message ?? ""), shown(ambiguous));
    removeMesh("bad_space");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: project, env: runEnv });
      const down = await run(["down", "--yes"], {}, project);
      if (down.status !== 0) child.kill("SIGTERM");
    }
    await closed;
  }
}

finish();
process.exit(process.exitCode ?? 0);
