/**
 * `cotal space`, `cotal space show [name]` and `cotal use [space]`, driven through the built binary.
 * The registry is written with the workspace's own writer into a sandboxed `COTAL_HOME`, so the
 * binary reads the records a real `up`, `meshes add` or catalog sync leaves. A real broker answers
 * for one space; another points at a port nothing listens on; a discovered one points at a listener
 * that counts connections, so the suite can show a read never dials it.
 *
 * Needs `nats-server` on PATH.
 *
 * Run: pnpm smoke:space-reads
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN, createSuite, freePort, killAndAwaitExit, listenOn, teardownOnSignal } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "cotal-space-reads-"));
// Set before the workspace is imported: it reads COTAL_HOME on each call, so the real ~/.cotal is
// never touched.
process.env.COTAL_HOME = join(home, ".cotal");
const { clearCurrent, findMesh, getCurrent, meshesDir, recordMesh, setCurrent } = await import("@cotal-ai/workspace");

const { check, finish } = createSuite();
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));

const brokerPort = await freePort();
const LIVE = `nats://127.0.0.1:${brokerPort}`;
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(brokerPort), "-sd", mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN))], { stdio: "ignore" });
teardownOnSignal(broker);
broker.on("error", () => {
  console.error("needs nats-server on PATH");
  process.exit(1);
});
const DEAD = `nats://127.0.0.1:${await freePort()}`;
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
  rmSync(home, { recursive: true, force: true });
});

const run = (args: string[], extraEnv: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: home,
    env: { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: process.env.COTAL_HOME!, COTAL_SKIP_CONNECTOR_SEED: "1", ...extraEnv },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const json = (args: string[]) => {
  const r = run([...args, "--json"]);
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

for (let i = 0; i < 50; i++) {
  const { isReachable } = await import("@cotal-ai/core");
  if (await isReachable(LIVE)) break;
  await new Promise((r) => setTimeout(r, 100));
}

// ── An empty registry ────────────────────────────────────────────────────────────────────────────────
{
  const empty = json(["space"]);
  check("space --json on an empty registry is one ok envelope with no items", empty.status === 0 && empty.env?.outcome === "ok" && empty.env.target === null && empty.env.result.items.length === 0 && empty.env.result.current === null, shown(empty));
  const human = run(["space"]);
  check("the empty report says how to start or register a space", human.status === 0 && /No spaces registered\./.test(human.stdout) && /^ {2}cotal setup\s/m.test(human.stdout) && /^ {2}cotal space add <name> --server <url>\s/m.test(human.stdout), shown(human));
  const none = json(["use"]);
  check("bare use with nothing selected reports no selection", none.status === 0 && none.env?.result.current === null && none.env.target === null, shown(none));
}

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
  check("use refuses an unregistered name with TARGET_NOT_FOUND and keeps the selection", unknown.status === 2 && unknown.env?.error?.code === "TARGET_NOT_FOUND" && getCurrent() === "alpha", shown(unknown));
  const two = json(["use", "alpha", "beta"]);
  check("use with two names is a usage error", two.status === 1 && two.env?.error?.code === "USAGE_INVALID", shown(two));
  const listed = json(["space"]);
  check("the listing marks the selected space", itemOf(listed.env, "alpha")?.current === true && itemOf(listed.env, "beta")?.current === false && listed.env?.result.current === "alpha", listed.env?.result);
  const human = run(["use", "beta"], { FORCE_COLOR: "1" });
  check("use names the space it selected and the one it replaced", human.status === 0 && /selected beta \(was alpha\)/.test(human.stdout.replace(/\x1b\[[0-9;]*m/g, "")), shown(human));
  run(["use", "alpha"]);
}

// ── show ─────────────────────────────────────────────────────────────────────────────────────────────
{
  const bare = json(["space", "show"]);
  check("bare show shows the selected space", bare.status === 0 && bare.env?.result.kind === "space" && bare.env.result.space === "alpha" && bare.env.result.current === true && bare.env.target?.space === "alpha", shown(bare));
  const beta = json(["space", "show", "beta"]);
  check("show reports an unreachable broker and the recorded TLS requirement", beta.status === 0 && beta.env?.result.check === "unreachable" && beta.env.result.tlsRequired === true && beta.env.result.origin === "manual", shown(beta));
  const dialsBefore = catalogDials;
  const gamma = json(["space", "show", "gamma"]);
  check("show never dials a discovered space's broker", gamma.status === 0 && gamma.env?.result.check === "not-checked" && catalogDials === dialsBefore, { ...shown(gamma), catalogDials });
  check("show gives a discovered space's catalog details and its login", gamma.env?.result.catalog?.fetchedAt === ts && gamma.env.result.userAuth?.idp?.url === "https://idp.test" && gamma.env.result.userAuth.remote === true, gamma.env?.result);
  check("show leaves the credential path out", !gamma.stdout.includes("sentinel") && !gamma.stdout.includes("auth.test"), shown(gamma));
  const unknown = json(["space", "show", "nope"]);
  check("show refuses an unregistered name with TARGET_NOT_FOUND", unknown.status === 2 && unknown.env?.error?.code === "TARGET_NOT_FOUND", shown(unknown));
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

// ── help and completion ──────────────────────────────────────────────────────────────────────────────
{
  const help = run(["help", "space"]);
  check("help space lists show and its structured output", help.status === 0 && /^\s+show\s/m.test(help.stdout) && /Structured output: json, plain/.test(help.stdout), shown(help));
  const useHelp = run(["help", "use"]);
  check("help use gives the optional space", useHelp.status === 0 && /cotal use \[<space>\]/.test(useHelp.stdout), shown(useHelp));
  const subs = run(["__complete", "space", ""]);
  check("completion offers show after space", /^show(\t|$)/m.test(subs.stdout), shown(subs));
  const names = run(["__complete", "space", "show", ""]);
  check("completion offers the registered names after space show", ["alpha", "beta", "gamma"].every((n) => new RegExp(`^${n}$`, "m").test(names.stdout)), shown(names));
  const useNames = run(["__complete", "use", ""]);
  check("completion offers the registered names after use", ["alpha", "beta", "gamma"].every((n) => new RegExp(`^${n}$`, "m").test(useNames.stdout)), shown(useNames));
}

// The broker and the listener would keep the process alive past the last cell.
await killAndAwaitExit(broker);
catalogServer.close();
finish();
