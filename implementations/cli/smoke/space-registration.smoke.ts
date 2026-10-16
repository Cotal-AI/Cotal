/**
 * `cotal space add` and `cotal space forget`, driven through the built binary in a sandboxed
 * `COTAL_HOME`. An open broker and one that refuses a bare connect answer for real, another address
 * has nothing listening, and a stand-in exchange answers for a user-auth bundle's pins. Each refusal
 * is checked for its code and exit, and for writing nothing; each success for the record it writes
 * and for leaving the selection as it was.
 *
 * Needs `nats-server` on PATH.
 *
 * Run: pnpm smoke:space-registration
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN, createSuite, freePort, listenOn, teardownOnSignal } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "cotal-space-registration-"));
// Set before the workspace is imported: it reads COTAL_HOME on each call.
process.env.COTAL_HOME = join(home, ".cotal");
const { clearCurrent, findMesh, getCurrent, meshesDir, recordMesh, setCurrent } = await import("@cotal-ai/workspace");
const { userExchangeIssuer } = await import("../src/commands/meshes-add.js");

const { check, finish } = createSuite();
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));

const brokerPort = await freePort();
const LIVE = `nats://127.0.0.1:${brokerPort}`;
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(brokerPort), "-sd", mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN))], { stdio: "ignore" });
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
const run = (args: string[], extraEnv: Record<string, string> = {}) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: home,
      env: { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: process.env.COTAL_HOME!, COTAL_SKIP_CONNECTOR_SEED: "1", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
const json = async (args: string[]) => {
  const r = await run([...args, "--json"]);
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
  const overUp = await json(["space", "add", "started", "--server", LIVE, "--root", root, "--force"]);
  check("--force does not replace a space this machine started", refused(overUp, 2, "CONFLICT") && findMesh("started")?.origin === "up", shown(overUp));

  const before = registryFiles();
  const dead = await json(["space", "add", "dead1", "--server", DEAD, "--root", root]);
  check("a broker that does not answer is TARGET_UNAVAILABLE, exit 2", refused(dead, 2, "TARGET_UNAVAILABLE"), shown(dead));
  const wantsAuth = await json(["space", "add", "o2", "--server", AUTH_LIVE, "--mode", "open", "--root", root]);
  check("an open claim on a broker that requires auth is CONFLICT", refused(wantsAuth, 2, "CONFLICT"), shown(wantsAuth));
  const noTrust = await json(["space", "add", "a2", "--server", AUTH_LIVE, "--mode", "auth", "--root", root]);
  check("an auth claim with no trust under --root is DEPENDENCY_UNAVAILABLE", refused(noTrust, 2, "DEPENDENCY_UNAVAILABLE"), shown(noTrust));
  const plaintext = await json(["space", "add", "far", "--server", "nats://broker.example.com:4222", "--root", root]);
  check("a hostname with no TLS is UNSUPPORTED: credentials would cross the network unprotected", refused(plaintext, 2, "UNSUPPORTED"), shown(plaintext));
  const noRoot = await json(["space", "add", "r2", "--server", LIVE, "--root", join(home, "missing")]);
  check("a --root that is not a directory is USAGE_INVALID", refused(noRoot, 1, "USAGE_INVALID"), shown(noRoot));
  check("no refused add wrote anything", JSON.stringify(registryFiles()) === JSON.stringify(before));

  const forced = await json(["space", "add", "dead1", "--server", DEAD, "--root", root, "--force"]);
  check("--force adds a space whose broker is down, marked not checked", forced.status === 0 && forced.env?.result.verified === false && findMesh("dead1") !== undefined, shown(forced));

  clearCurrent();
  const unselected = await json(["space", "add", "open3", "--server", LIVE, "--root", root]);
  check("with nothing selected, an added space is not selected either", unselected.status === 0 && getCurrent() === undefined, { current: getCurrent() });
  setCurrent("keep");

  const human = await run(["space", "add", "open4", "--server", LIVE, "--root", root], { FORCE_COLOR: "1" });
  const text = human.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  check("the human report says it was added and how to select it", human.status === 0 && /✓ added open4/.test(text) && /broker answered/.test(text) && /select it with `cotal use open4`/.test(text), shown(human));
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

  const stopped = await json(["space", "forget", "started"]);
  check("a stopped space this machine started is forgotten", stopped.status === 0 && stopped.env?.result.kind === "space-forgotten" && stopped.env.result.origin === "up" && findMesh("started") === undefined, shown(stopped));
  const manual = await json(["space", "forget", "open1"]);
  check("a space added by hand is forgotten; the selection stays", manual.status === 0 && manual.env?.result.selectionCleared === false && findMesh("open1") === undefined && getCurrent() === "keep", shown(manual));
  check("forgetting keeps the root's files", existsSync(join(root, ".cotal")));
  const human = await run(["space", "forget", "keep"]);
  check("forgetting the selected space clears the selection and says so", human.status === 0 && getCurrent() === undefined && /forgot keep/.test(human.stdout) && /no space is selected now/.test(human.stdout), shown(human));
}

finish();
process.exit(process.exitCode ?? 0);
