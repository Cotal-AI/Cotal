/**
 * `cotal setup` asks for the destination, the application, the runtimes, the project folder and the
 * space. This suite drives the built binary in a sandboxed home whose connectors are seeded once,
 * with a PATH that holds `codex` and `tmux` (stand-ins) and not `claude` or `cmux`. A stand-in npm
 * registry serves the tmux and herdr runtimes packed from this checkout.
 *
 * Scripted: every input is a flag, a missing one is refused before anything is written, Cloud is
 * refused as in development, and a refusal leaves the sandbox as it was. A local space is prepared
 * the way `space create` prepares it, its default persona lands in the project's `.cotal/agents`,
 * and the application becomes the space's `harness` preference. A rerun changes nothing. A harness
 * whose host tool is missing leaves the rest saved and the result partial. A self-hosted space is
 * one registered here, whose root is the project, or one registered from a connection file; either
 * way the persona lands in the catalog `cotal spawn` reads for that space. Without `--runtime` no
 * runtime beyond `pty` is set up. A named runtime is installed at this cotal's version and its
 * provider is asked whether it answers; an unknown name or a missing host tool is refused before
 * anything is written, and a runtime left unnamed is never removed.
 *
 * On a terminal: Cloud is shown and cannot be chosen, every answer is shown before the save,
 * Change asks again with the answers kept, Cancel saves nothing, and a missing project folder is
 * created only after the operator agrees. Installed runtimes and those whose host tool is found
 * start selected, and a selected runtime whose host tool is missing is reported and not installed.
 *
 * Needs `nats-server` on PATH. Linux and macOS run the terminal cells under a pty.
 *
 * Run: pnpm smoke:setup-destination
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { SMOKE_BROKER_TOKEN, createSuite, freePort, listenOn, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { clean, nodePty, wait, type Pty } from "./_console-pty.js";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "cotal-setup-destination-"));
// Set before the workspace is imported: it reads COTAL_HOME on each call.
process.env.COTAL_HOME = join(home, ".cotal");
const xdg = join(home, ".config");
process.env.XDG_CONFIG_HOME = xdg;
mkdirSync(process.env.COTAL_HOME, { recursive: true });
const { findMesh, findPreparedSpace, loadExtensionsManifest, loadMeshes, readPreferences, recordMesh, resolveMeshTarget, resolveOnPath } = await import("@cotal-ai/workspace");
const { loadAgentFile } = await import("@cotal-ai/core");
const { userExchangeIssuer } = await import("../src/commands/meshes-add.js");
const { check, finish } = createSuite();

// A PATH with node, nats-server and stand-ins for `codex` and `tmux`, and no `claude` or `cmux`.
// `herdr` 0.7.0, older than the runtime drives, and `orca`, which the registry does not serve, are
// put on PATH only for the cells that name them.
const bin = join(home, "bin");
const more = join(home, "bin-more");
mkdirSync(bin);
mkdirSync(more);
const natsServer = resolveOnPath("nats-server");
if (!natsServer) {
  console.error("needs nats-server on PATH");
  process.exit(1);
}
symlinkSync(natsServer, join(bin, process.platform === "win32" ? "nats-server.exe" : "nats-server"));
function tool(dir: string, name: string, out = ""): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${out ? `echo ${out}\n` : ""}exit 0\n`);
  chmodSync(join(dir, name), 0o755);
  writeFileSync(join(dir, `${name}.cmd`), `@${out ? `echo ${out}` : "exit /b 0"}\r\n`);
}
tool(bin, "codex");
tool(bin, "tmux");
tool(more, "herdr", "herdr 0.7.0");
tool(more, "orca");
// CMUX_BUNDLED_CLI_PATH names the cmux tool inside a cmux terminal, so it is dropped with the rest.
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && !["FORCE_COLOR", "NO_COLOR", "PATH", "CMUX_BUNDLED_CLI_PATH"].includes(k)));
const env: Record<string, string> = {
  ...(HOST_ENV as Record<string, string>),
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: xdg,
  COTAL_HOME: process.env.COTAL_HOME,
  COTAL_SKIP_CONNECTOR_SEED: "1",
  COTAL_SKIP_ASSIST: "1",
  PATH: [bin, ...(process.platform === "win32" ? [join(process.execPath, "..")] : ["/usr/bin", "/bin"])].join(delimiter),
  TERM: "xterm-256color",
};

// An open broker, one that refuses a bare connect, and a stand-in exchange for a bundle's pins.
const brokers: ReturnType<typeof spawn>[] = [];
const ptys: Pty[] = [];
async function broker(extra: string[]): Promise<string> {
  const port = await freePort();
  const b = spawn(natsServer!, ["-a", "127.0.0.1", "-p", String(port), "-sd", mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN)), ...extra], { stdio: "ignore" });
  teardownOnSignal(b);
  brokers.push(b);
  return `nats://127.0.0.1:${port}`;
}
const AUTH_LIVE = await broker(["--user", "u", "--pass", "p"]);
const exchange = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") return void res.end(JSON.stringify({ ok: true, issuer: userExchangeIssuer("hosted") }));
  if (req.url === "/jwks") return void res.end(JSON.stringify({ keys: [{ kid: "k1", kty: "RSA" }] }));
  res.statusCode = 404;
  res.end("{}");
});
const exchangeUrl = `http://127.0.0.1:${await listenOn(exchange, await freePort())}`;
process.on("exit", () => {
  for (const b of brokers) b.kill("SIGKILL");
  for (const p of ptys) p.kill();
  exchange.close();
  rmSync(home, { recursive: true, force: true });
});
const { isReachable } = await import("@cotal-ai/core");
for (let i = 0; i < 50 && !(await isReachable(AUTH_LIVE)); i++) await wait(100);

const run = (args: string[], cwd = home, extraEnv: Record<string, string> = {}) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
const json = async (args: string[], cwd = home, extraEnv: Record<string, string> = {}) => {
  const r = await run([...args, "--json"], cwd, extraEnv);
  let envelope: Record<string, any> | undefined;
  try {
    envelope = JSON.parse(r.stdout);
  } catch {
    envelope = undefined;
  }
  return { ...r, env: envelope };
};
const shown = (r: { status: number | null; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });
const refused = (r: Awaited<ReturnType<typeof json>>, exit: number, code: string) => r.status === exit && r.env?.outcome === "refused" && r.env.error?.code === code;
/** Every file under the home except the seeded extensions, so a refusal can be shown to write nothing. */
function files(dir = home): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(home, path);
    if (rel === join(".config", "cotal", "extensions") || rel === join(".config", "cotal", "seed") || rel === "bin") continue;
    if (statSync(path).isDirectory()) out.push(`${rel}/`, ...files(path));
    else out.push(rel);
  }
  return out.sort();
}
const project = (name: string) => {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const harnessOf = (space: string) => readPreferences().spaces[space]?.harness;
const literal = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

// The connectors setup offers, seeded once into this sandbox.
const seeded = spawnSync(process.execPath, [BIN, "ext", "seed"], { cwd: home, env: { ...env, COTAL_SKIP_CONNECTOR_SEED: "", COTAL_ALLOW_CHECKOUT_SEED: "1" }, encoding: "utf8", timeout: 300_000 });
if (seeded.status !== 0) {
  console.error(`✗ seeding the connectors failed: ${seeded.stderr.slice(-800)}`);
  process.exit(1);
}

// A stand-in npm registry serving the official tmux and herdr runtimes, packed from this checkout,
// at this cotal's version, beside a newer `latest` that has no tarball, so an install that resolves
// to the newest fails. Every other package is not found. Set after the seed, so only the runtime
// installs read it.
const REPO = join(import.meta.dirname, "..", "..", "..");
const VERSION = (JSON.parse(readFileSync(join(REPO, "bin", "package.json"), "utf8")) as { version: string }).version;
const NEWER = "99.0.0";
const packed = mkdtempSync(join(tmpdir(), "cotal-setup-runtimes-"));
const served = new Map<string, { manifest: Record<string, unknown>; file: string; integrity: string; shasum: string }>();
for (const name of ["tmux", "herdr"]) {
  const dir = join(REPO, "extensions", name);
  const pack = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packed, dir], { encoding: "utf8", shell: process.platform === "win32" });
  if (pack.status !== 0) {
    console.error(`✗ packing ${dir} failed: ${pack.stderr.slice(-800)}`);
    process.exit(1);
  }
  const [info] = JSON.parse(pack.stdout) as { name: string; version: string; filename: string; integrity: string; shasum: string }[];
  if (info!.version !== VERSION) {
    console.error(`✗ ${info!.name} is ${info!.version} and this cotal is ${VERSION}`);
    process.exit(1);
  }
  served.set(info!.name, { manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), file: info!.filename, integrity: info!.integrity, shasum: info!.shasum });
}
const registryServer = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? "").split("?")[0]!.slice(1));
  const tarball = [...served.values()].find((p) => path === `tarballs/${p.file}`);
  if (tarball) return void res.end(readFileSync(join(packed, tarball.file)));
  const pkg = served.get(path);
  if (!pkg) {
    res.statusCode = 404;
    return void res.end(JSON.stringify({ error: "not found" }));
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    _id: path,
    name: path,
    "dist-tags": { latest: NEWER },
    versions: {
      [VERSION]: { ...pkg.manifest, _id: `${path}@${VERSION}`, dist: { tarball: `${registry}/tarballs/${pkg.file}`, integrity: pkg.integrity, shasum: pkg.shasum } },
      [NEWER]: { ...pkg.manifest, version: NEWER, _id: `${path}@${NEWER}`, dist: { tarball: `${registry}/tarballs/missing-${NEWER}.tgz`, integrity: pkg.integrity, shasum: pkg.shasum } },
    },
  }));
});
const registry = `http://127.0.0.1:${await listenOn(registryServer, await freePort())}`;
Object.assign(env, { npm_config_registry: `${registry}/`, npm_config_cache: join(packed, "cache"), npm_config_update_notifier: "false" });
process.on("exit", () => {
  registryServer.close();
  rmSync(packed, { recursive: true, force: true });
});
const withMore = { PATH: [more, env.PATH].join(delimiter) };
const installed = (pkg: string) => loadExtensionsManifest().extensions.find((e) => e.pkg === pkg);

const FULL = (space: string, dir: string, harness = "codex") => ["setup", "--destination", "local", "--harness", harness, "--project", dir, "--space", space];

// ── A script names every input, and a refusal writes nothing ──────────────────────────────────────
{
  const dirs = { cloud: project("p-cloud"), mars: project("p-mars"), harness: project("p-harness"), name: project("p-name"), file: project("p-file"), runtime: project("p-runtime") };
  const before = files();
  const missing = await json(["setup", "--destination", "local"]);
  check("a script missing inputs is USAGE_INVALID, exit 1, naming each missing flag",
    refused(missing, 1, "USAGE_INVALID") && /--harness, --project, --space/.test(missing.env?.error?.message ?? "") && /--destination local --harness <connector> --project <dir> --space <name>/.test(missing.env?.error?.remedy ?? ""), shown(missing));
  const yes = await run(["setup", "--yes"]);
  check("setup --yes alone is refused the same way, exit 1", yes.status === 1 && /pass --destination, --harness, --project, --space/.test(yes.stderr), shown(yes));
  const cloud = await json(FULL("c1", dirs.cloud).map((a) => (a === "local" ? "cloud" : a)));
  check("--destination cloud is UNSUPPORTED, exit 2, as in development", refused(cloud, 2, "UNSUPPORTED") && /in development/.test(cloud.env?.error?.message ?? ""), shown(cloud));
  const cloudAlone = await json(["setup", "--destination", "cloud"]);
  check("--destination cloud is refused as UNSUPPORTED before any missing input", refused(cloudAlone, 2, "UNSUPPORTED"), shown(cloudAlone));
  const mars = await json(FULL("m1", dirs.mars).map((a) => (a === "local" ? "mars" : a)));
  check("an unknown destination is USAGE_INVALID", refused(mars, 1, "USAGE_INVALID") && /local or self-hosted/.test(mars.env?.error?.message ?? ""), shown(mars));
  const harness = await json(FULL("h1", dirs.harness, "nope"));
  check("an unknown harness is USAGE_INVALID, naming the installed ones", refused(harness, 1, "USAGE_INVALID") && /no harness "nope"; known harnesses: .*codex/.test(harness.env?.error?.message ?? ""), shown(harness));
  const absent = await json(FULL("a1", join(home, "absent")));
  check("a script's project folder must exist: USAGE_INVALID", refused(absent, 1, "USAGE_INVALID") && /is not a directory/.test(absent.env?.error?.message ?? "") && !existsSync(join(home, "absent")), shown(absent));
  const name = await json(FULL("bad name", dirs.name));
  check("a space name that is not a token is USAGE_INVALID", refused(name, 1, "USAGE_INVALID"), shown(name));
  const homeProject = await json(FULL("h2", home));
  check("the home folder is no project: CONFLICT naming --project", refused(homeProject, 2, "CONFLICT") && /--project <dir>/.test(homeProject.env?.error?.remedy ?? ""), shown(homeProject));
  const fileLocal = await json([...FULL("f1", dirs.file), "--connection-file", join(home, "x.json")]);
  check("--connection-file with a local destination is USAGE_INVALID", refused(fileLocal, 1, "USAGE_INVALID"), shown(fileLocal));
  const runtime = await json([...FULL("r1", dirs.runtime), "--runtime", "bogus"]);
  check("an unknown --runtime is USAGE_INVALID, naming the runtimes setup offers",
    refused(runtime, 1, "USAGE_INVALID") && /--runtime bogus is not a runtime: pass pty, orca, tmux, cmux, herdr/.test(runtime.env?.error?.message ?? ""), shown(runtime));
  const noTool = await json([...FULL("r2", dirs.runtime), "--runtime", "cmux"]);
  check("a --runtime whose host tool is not on PATH is DEPENDENCY_UNAVAILABLE, naming the tool",
    refused(noTool, 2, "DEPENDENCY_UNAVAILABLE") && /the cmux runtime drives cmux, which is not on PATH/.test(noTool.env?.error?.message ?? "") && installed("@cotal-ai/cmux") === undefined, shown(noTool));
  check("no refusal wrote anything", JSON.stringify(files()) === JSON.stringify(before), { before, after: files() });
}

// ── A local space ─────────────────────────────────────────────────────────────────────────────────
{
  const dir = project("research");
  const first = await json(FULL("research", dir));
  const r = first.env?.result;
  const written = (r?.written ?? []).map((w: { what: string }) => w.what);
  check("a local setup is ok, exit 0, and prepares the space as space create does",
    first.status === 0 && first.env?.outcome === "ok" && r?.spaceState === "created" && findPreparedSpace("research")?.root === dir && existsSync(join(dir, ".cotal")), shown(first));
  check("it lists what it wrote: the prepared space, the default persona and the harness preference",
    ["prepared space", "default persona", "harness preference of research"].every((w) => written.includes(w)), written);
  const runtimes = (r?.runtimes ?? []) as { name: string; state: string; selected: boolean; tool: { found: string | null } | null }[];
  check("without --runtime only pty is set up, and each official runtime is listed with its host tool",
    runtimes.map((x) => `${x.name}:${x.state}:${x.selected}`).join() === "pty:built-in:true,orca:left-out:false,tmux:left-out:false,cmux:left-out:false,herdr:left-out:false"
      && runtimes.find((x) => x.name === "tmux")?.tool?.found === "tmux" && runtimes.find((x) => x.name === "cmux")?.tool?.found === null && installed("@cotal-ai/tmux") === undefined, runtimes);
  const persona = join(dir, ".cotal", "agents", "default.md");
  check("the default persona lands in the project's .cotal/agents and parses", existsSync(persona) && loadAgentFile(persona).name === "default_agent");
  check("the application is the space's harness preference", harnessOf("research") === "codex", readPreferences().spaces);
  check("the next command is cotal up in the project", r?.next?.command === "cotal up" && r.next.cwd === dir, r?.next);
  const space = await json(["space"]);
  check("cotal space lists it as prepared in the project", space.env?.result?.prepared?.some((p: { space: string; root: string }) => p.space === "research" && p.root === dir), shown(space));

  const before = files();
  const again = await json(FULL("research", dir));
  check("a rerun with the same answers is a no-op, exit 0, and writes nothing",
    again.status === 0 && again.env?.outcome === "no-op" && again.env.result.spaceState === "prepared" && again.env.result.written.length === 0 && JSON.stringify(files().filter((f) => !f.endsWith("setup.log"))) === JSON.stringify(before.filter((f) => !f.endsWith("setup.log"))), shown(again));
  const plain = await run([...FULL("research", dir), "--plain"]);
  check("its plain report says the space is already set up", plain.status === 0 && /research is already set up for codex/.test(plain.stdout) && /already prepared/.test(plain.stdout), shown(plain));

  const startedRoot = project("started-here");
  recordMesh({ space: "startedspace", server: "nats://127.0.0.1:4997", root: startedRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const started = await json(FULL("startedspace", startedRoot));
  check("a space started here before is reported as started, and its next command is spawn",
    started.status === 0 && started.env?.result.spaceState === "started" && started.env.result.next.command === "cotal spawn --space startedspace" && findPreparedSpace("startedspace") === undefined, shown(started));

  const other = await json(FULL("research2", dir));
  check("a second space in the same project is CONFLICT", refused(other, 2, "CONFLICT") && /already the root of "research"/.test(other.env?.error?.message ?? ""), shown(other));
  const moved = await json(FULL("research", project("elsewhere")));
  check("the same space in another folder is CONFLICT, naming where it is prepared", refused(moved, 2, "CONFLICT") && literal(`already prepared in ${dir}`).test(moved.env?.error?.message ?? ""), shown(moved));
}

// ── A harness whose host tool is missing ──────────────────────────────────────────────────────────
{
  const dir = project("p-claude");
  const partial = await json(FULL("claudespace", dir, "claude"));
  check("a harness not on PATH is partial, exit 4, naming the tool",
    partial.status === 4 && partial.env?.outcome === "partial" && partial.env.error?.code === "OPERATION_PARTIAL" && /claude needs claude on PATH/.test(partial.env.error.message) && partial.env.result.harness.missing.join() === "claude", shown(partial));
  check("and the rest is saved: the space, the persona and the preference",
    findPreparedSpace("claudespace")?.root === dir && existsSync(join(dir, ".cotal", "agents", "default.md")) && harnessOf("claudespace") === "claude");
  const human = await run(FULL("claudespace", dir, "claude"));
  check("its report does not call the space set up", human.status === 4 && /saved claudespace; claude is not set up yet/.test(human.stdout) && !/already set up/.test(human.stdout), shown(human));
}

// ── A self-hosted space ───────────────────────────────────────────────────────────────────────────
{
  const teamRoot = project("team");
  recordMesh({ space: "team", server: "nats://127.0.0.1:4999", root: teamRoot, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  const hosted = (space: string, dir: string, extra: string[] = []) => ["setup", "--destination", "self-hosted", "--harness", "codex", "--project", dir, "--space", space, ...extra];
  const notTeam = project("not-team");
  const before = files();
  const elsewhere = await json(hosted("team", notTeam));
  check("a project other than the registration's root is CONFLICT, naming the root", refused(elsewhere, 2, "CONFLICT") && elsewhere.env?.error?.remedy === `pass --project ${teamRoot}`, shown(elsewhere));
  const unknown = await json(hosted("nobody", teamRoot));
  check("an unregistered space with no connection file is TARGET_NOT_FOUND", refused(unknown, 2, "TARGET_NOT_FOUND") && /--connection-file/.test(unknown.env?.error?.remedy ?? ""), shown(unknown));
  const local = await json(hosted("research", join(home, "research")));
  check("a space prepared here is not self-hosted: CONFLICT", refused(local, 2, "CONFLICT") && /--destination local/.test(local.env?.error?.remedy ?? ""), shown(local));
  check("those refusals wrote nothing", JSON.stringify(files()) === JSON.stringify(before));

  const ok = await json(hosted("team", teamRoot));
  const target = resolveMeshTarget(home, { space: "team" });
  check("a registered space is set up where spawn reads its personas",
    ok.status === 0 && ok.env?.result.spaceState === "registered" && existsSync(join(target.personaRoot, "default.md")) && target.root === teamRoot, { run: shown(ok), personaRoot: target.personaRoot });
  check("its next command is spawn in that space", ok.env?.result.next.command === "cotal spawn --space team" && ok.env.result.next.cwd === null, ok.env?.result.next);

  const userRoot = project("hosted-root");
  const bundle = {
    space: "hosted",
    server: AUTH_LIVE,
    tlsRequired: false,
    userAuth: { provider: "cotal", idp: { url: "https://idp.example.test/", issuer: "https://idp.example.test/", audience: "cotal-mesh" }, endpoints: { url: exchangeUrl } },
    sentinelCreds: "-----BEGIN NATS USER JWT-----\nsentinel-material\n------END NATS USER JWT------",
  };
  const file = join(home, "hosted.json");
  writeFileSync(file, JSON.stringify(bundle));
  const wrongName = await json(hosted("other", userRoot, ["--connection-file", file]));
  check("a connection file for another space is CONFLICT", refused(wrongName, 2, "CONFLICT") && /"hosted"/.test(wrongName.env?.error?.message ?? "") && findMesh("other") === undefined, shown(wrongName));
  const added = await json(hosted("hosted", userRoot, ["--connection-file", file]));
  check("a connection file registers the space with the project as its root",
    added.status === 0 && added.env?.result.spaceState === "added" && findMesh("hosted")?.root === userRoot && findMesh("hosted")?.mode === "user" && added.env.result.written.some((w: { what: string }) => w.what === "space registration"), shown(added));
  check("and its persona lands where spawn reads for that space", existsSync(join(resolveMeshTarget(home, { space: "hosted" }).personaRoot, "default.md")));
  const again = await json(hosted("hosted", userRoot, ["--connection-file", file]));
  check("the same connection file again is a no-op", again.status === 0 && again.env?.outcome === "no-op" && again.env.result.spaceState === "registered", shown(again));
  writeFileSync(join(home, "moved.json"), JSON.stringify({ ...bundle, server: "nats://127.0.0.1:4998" }));
  const moved = await json(hosted("hosted", userRoot, ["--connection-file", join(home, "moved.json")]));
  check("a connection file naming another broker for a registered space is CONFLICT", refused(moved, 2, "CONFLICT") && /cotal space forget hosted/.test(moved.env?.error?.remedy ?? ""), shown(moved));
}

// ── Runtimes ──────────────────────────────────────────────────────────────────────────────────────
type Row = { name: string; state: string; selected: boolean; reachable: boolean | null; package: string | null; tool: { names: string[]; found: string | null } | null };
const rows = (r: Awaited<ReturnType<typeof json>>): Row[] => r.env?.result?.runtimes ?? [];
const row = (r: Awaited<ReturnType<typeof json>>, name: string) => rows(r).find((x) => x.name === name);
{
  const dir = project("rt");
  const added = await json([...FULL("rt", dir), "--runtime", "tmux"]);
  check("a named runtime is added at this cotal's version and its provider answers",
    added.status === 0 && added.env?.outcome === "ok" && row(added, "tmux")?.state === "added" && row(added, "tmux")?.reachable === true && row(added, "tmux")?.package === "@cotal-ai/tmux"
      && installed("@cotal-ai/tmux")?.version === VERSION && installed("@cotal-ai/tmux")?.spec === `@cotal-ai/tmux@${VERSION}`, { run: shown(added), installed: installed("@cotal-ai/tmux") });
  check("the install is listed among the writes, and its progress goes to stderr",
    added.env?.result.written.some((w: { what: string }) => w.what === "tmux runtime") && /added @cotal-ai\/tmux/.test(added.stderr), shown(added));
  const listed = await json(["runtimes"]);
  check("cotal runtimes reports it installed and reachable", listed.env?.result?.items?.some((x: { name: string; state: string; reachable: boolean }) => x.name === "tmux" && x.state === "installed" && x.reachable === true), shown(listed));
  const again = await json([...FULL("rt", dir), "--runtime", "tmux"]);
  check("naming it again is a no-op that finds it set up", again.status === 0 && again.env?.outcome === "no-op" && row(again, "tmux")?.state === "set-up" && row(again, "tmux")?.reachable === true, shown(again));
  const bare = await run(["ext", "add", "@cotal-ai/tmux"]);
  check("ext add of a first-party name with no version installs this cotal's version, not the registry's newest",
    bare.status === 0 && installed("@cotal-ai/tmux")?.version === VERSION && installed("@cotal-ai/tmux")?.spec === `@cotal-ai/tmux@${VERSION}`, { run: shown(bare), installed: installed("@cotal-ai/tmux") });

  const orca = await json([...FULL("rt", dir), "--runtime", "orca"], home, withMore);
  check("a runtime that does not install is left out, the result is partial, and the others stay",
    orca.status === 4 && row(orca, "orca")?.state === "left-out" && row(orca, "orca")?.selected === true && /the orca runtime did not install/.test(orca.env?.error?.message ?? "")
      && installed("@cotal-ai/orca") === undefined && installed("@cotal-ai/tmux") !== undefined, shown(orca));
  const bundled = await json([...FULL("rt", dir), "--runtime", "cmux"], home, { CMUX_BUNDLED_CLI_PATH: join(more, "orca") });
  check("the variable a driver reads for its tool counts as the tool",
    bundled.status === 4 && row(bundled, "cmux")?.tool?.found === join(more, "orca") && /the cmux runtime did not install/.test(bundled.env?.error?.message ?? ""), shown(bundled));
  const none = await json(FULL("rt", dir));
  check("setup without --runtime removes none", none.status === 0 && rows(none).filter((x) => x.state === "set-up").map((x) => x.name).join() === "tmux" && installed("@cotal-ai/tmux") !== undefined, shown(none));
}

// ── On a terminal ─────────────────────────────────────────────────────────────────────────────────
function terminal(cwd: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
  const pty = nodePty([BIN, "setup", ...args], { cwd, env: { ...env, ...extraEnv }, cols: 140, rows: 40 });
  ptys.push(pty);
  const s = { raw: "", code: undefined as number | undefined, text: () => clean(s.raw) };
  pty.onData((d) => (s.raw += d));
  pty.onExit((e) => (s.code = e.exitCode));
  // A session that missed a question is off script: its later questions would only time out one by
  // one, so they are not waited for, and the session is stopped instead of awaited.
  let lost = false;
  const at = async (marker: string, from = 0): Promise<boolean> => {
    for (const t0 = Date.now(); Date.now() - t0 < (lost ? 0 : 90_000); await wait(100)) if (s.text().indexOf(marker, from) >= 0) return true;
    return s.text().indexOf(marker, from) >= 0;
  };
  // Output already answered: a question asked again is looked for after it.
  let cursor = 0;
  /** Waits for `marker` past the last answered question, then sends `keys`. */
  const answer = async (marker: string, keys: string): Promise<boolean> => {
    const found = await at(marker, cursor);
    if (found) cursor = s.text().indexOf(marker, cursor) + marker.length;
    else lost = true;
    await wait(250);
    pty.write(keys);
    return found;
  };
  const exited = async (): Promise<boolean> => {
    if (lost && s.code === undefined) pty.kill();
    for (const t0 = Date.now(); Date.now() - t0 < 120_000; await wait(100)) if (s.code !== undefined) return !lost;
    return false;
  };
  return { s, at, answer, exited, write: (keys: string) => pty.write(keys), cursor: () => cursor };
}
const ENTER = "\r";
const DOWN = "\x1b[B";
const DESTINATION = "Where does your space run?";
const APPLICATION = "Which application do your agents run in?";
const RUNTIMES = "Which runtimes do your agents run in?";
const PROJECT = "Project folder";
const SPACE_NAME = "Space name";
const SAVE = "Save it?";

if (process.platform !== "win32") {
  {
    const dir = project("pty-cloud");
    const before = files();
    const t = terminal(dir);
    check("a terminal is asked where the space runs, with Cloud shown as in development", (await t.at(DESTINATION)) && /Cloud \(in development\)/.test(t.s.text()), t.s.text().slice(-600));
    t.write(DOWN);
    await wait(300);
    t.write(DOWN);
    await wait(500);
    const frame = t.s.text().slice(t.s.text().lastIndexOf(DESTINATION));
    check("Cloud cannot be chosen: moving past Self-hosted comes back to Local", /● Local/.test(frame.slice(frame.lastIndexOf("Local") - 4)), frame.slice(-400));
    t.write("\x03");
    check("Ctrl-C leaves setup and saves nothing", (await t.exited()) && JSON.stringify(files()) === JSON.stringify(before), { code: t.s.code });
  }
  {
    const dir = project("pty-local");
    const t = terminal(dir);
    const asked = [
      await t.answer(DESTINATION, ENTER),
      await t.answer(APPLICATION, ENTER),
      await t.answer(RUNTIMES, ENTER),
      await t.answer(PROJECT, ENTER),
      await t.answer(SPACE_NAME, ENTER),
    ];
    check("the terminal asks destination, application, runtimes, project and space in turn", asked.every(Boolean), t.s.text().slice(-900));
    check("the answers are shown before the save",
      (await t.at(SAVE)) && t.s.text().includes(`project      ${dir}`) && /space\s+pty-local/.test(t.s.text()) && /application\s+codex/.test(t.s.text()) && /runtimes\s+pty, tmux/.test(t.s.text()), t.s.text().slice(-900));
    check("nothing is written before the save", findPreparedSpace("pty-local") === undefined);
    await t.answer(SAVE, ENTER);
    check("saving prepares the space and records the application", (await t.exited()) && t.s.code === 0 && findPreparedSpace("pty-local")?.root === dir && harnessOf("pty-local") === "codex" && existsSync(join(dir, ".cotal", "agents", "default.md")), { code: t.s.code, out: t.s.text().slice(-900) });
  }
  {
    const dir = project("pty-change");
    const before = files();
    const t = terminal(dir, ["--space", "kept"]);
    await t.answer(DESTINATION, ENTER);
    await t.answer(APPLICATION, ENTER);
    await t.answer(RUNTIMES, ENTER);
    await t.answer(PROJECT, ENTER);
    check("a space given as a flag is not asked", (await t.at(SAVE)) && !t.s.text().includes(SPACE_NAME) && /space\s+kept/.test(t.s.text()), t.s.text().slice(-700));
    await t.answer(SAVE, DOWN + ENTER);
    const asked = [await t.answer(DESTINATION, ENTER), await t.answer(APPLICATION, ENTER), await t.answer(RUNTIMES, ENTER), await t.answer(PROJECT, ENTER), await t.answer(SPACE_NAME, ENTER)];
    const reviewed = await t.at(SAVE, t.cursor());
    const second = t.s.text().slice(t.cursor());
    check("Change asks every question again, with the answers so far as the defaults", asked.every(Boolean) && reviewed && /space\s+kept/.test(second) && /application\s+codex/.test(second), second.slice(-700));
    await t.answer(SAVE, DOWN + DOWN + ENTER);
    check("Cancel saves nothing and exits 0", (await t.exited()) && t.s.code === 0 && /nothing was saved/.test(t.s.text()) && JSON.stringify(files()) === JSON.stringify(before), { code: t.s.code, out: t.s.text().slice(-500) });
  }
  {
    const work = project("pty-work");
    const fresh = join(home, "pty-fresh");
    const t = terminal(work);
    await t.answer(DESTINATION, ENTER);
    await t.answer(APPLICATION, ENTER);
    await t.answer(RUNTIMES, ENTER);
    await t.answer(PROJECT, "\x7f".repeat(work.length + 2) + fresh + ENTER);
    check("a project folder that does not exist is offered for creation", (await t.at("does not exist. Create it?")) && !existsSync(fresh), t.s.text().slice(-600));
    await t.answer("Create it?", ENTER);
    await t.answer(SPACE_NAME, ENTER);
    check("the review says it is created on save", (await t.at(SAVE)) && /\(created on save\)/.test(t.s.text()) && !existsSync(fresh), t.s.text().slice(-600));
    await t.answer(SAVE, ENTER);
    check("saving creates it and prepares the space there", (await t.exited()) && t.s.code === 0 && statSync(fresh).isDirectory() && findPreparedSpace("pty-fresh")?.root === fresh, { code: t.s.code, out: t.s.text().slice(-600) });
  }
  {
    const t = terminal(project("pty-hosted"));
    await t.answer(DESTINATION, DOWN + ENTER);
    await t.answer(APPLICATION, ENTER);
    await t.answer(RUNTIMES, ENTER);
    check("self-hosted offers the registered spaces and a connection file", (await t.at("Which space?")) && /team/.test(t.s.text()) && /Register one from a connection file/.test(t.s.text()), t.s.text().slice(-700));
    const registered = loadMeshes().filter((m) => m.origin === "manual" || m.origin === "catalog").map((m) => m.space);
    await t.answer("Which space?", DOWN.repeat(registered.indexOf("team")) + ENTER);
    check("a registered space takes its root as the project, unasked", (await t.at(SAVE, t.cursor())) && t.s.text().includes(`project      ${join(home, "team")}`) && !t.s.text().includes(PROJECT), t.s.text().slice(-700));
    await t.answer(SAVE, ENTER);
    check("and saving sets it up", (await t.exited()) && t.s.code === 0, { code: t.s.code, out: t.s.text().slice(-500) });
  }
  {
    const dir = project("pty-runtimes");
    // herdr and orca are on PATH here and not installed; tmux is installed; cmux is neither.
    const t = terminal(dir, ["--destination", "local", "--harness", "codex", "--project", dir, "--space", "pty-rt"], withMore);
    const asked = await t.at(RUNTIMES);
    await wait(500);
    const listed = t.s.text().slice(t.s.text().lastIndexOf("Runtimes"));
    const frame = t.s.text().slice(t.s.text().lastIndexOf(RUNTIMES));
    check("before the question every runtime is listed with its state and host tool, pty as built in",
      asked && /pty\s+built in, always set up/.test(listed) && /orca\s+not set up · orca found/.test(listed) && /tmux\s+set up · tmux found/.test(listed) && /cmux\s+not set up · cmux not on PATH/.test(listed) && /herdr\s+not set up · herdr found/.test(listed), listed.slice(0, 900));
    check("installed runtimes and those whose tool was found start selected",
      /◼ orca\b/.test(frame) && /◼ tmux\b/.test(frame) && /◼ herdr\b/.test(frame) && /◻ cmux\b/.test(frame), frame.slice(0, 900));
    // The cursor starts on orca: leave orca, tmux and herdr, choose cmux.
    await t.answer(RUNTIMES, " " + DOWN + " " + DOWN + " " + DOWN + " " + ENTER);
    const reviewed = await t.at(SAVE, t.cursor());
    const text = t.s.text();
    const at = text.lastIndexOf(`◇  ${RUNTIMES}`);
    const answer = at < 0 ? "" : text.slice(at + RUNTIMES.length + 3, text.indexOf("Your setup", at));
    check("the answer names the runtimes chosen, and the review lists them",
      reviewed && /\bcmux\b/.test(answer) && !/found|PATH|set up/.test(answer) && /runtimes\s+pty, cmux/.test(text.slice(t.cursor())), { answer, tail: text.slice(-700) });
    await t.answer(SAVE, ENTER);
    check("a chosen runtime whose host tool is missing is reported and not installed, and those left out are kept",
      (await t.exited()) && t.s.code === 4 && /the cmux runtime is not ready/.test(t.s.text()) && /the cmux runtime needs cmux on PATH/.test(t.s.text()) && !/installing @cotal-ai\/cmux/.test(t.s.text())
        && installed("@cotal-ai/cmux") === undefined && installed("@cotal-ai/tmux") !== undefined, { code: t.s.code, out: t.s.text().slice(-900) });
  }
}

// ── A runtime whose provider does not answer, after the terminal cells so it is not preselected there
{
  const dir = join(home, "rt");
  const herdr = await json([...FULL("rt", dir), "--runtime", "herdr"], home, withMore);
  check("a runtime whose provider does not answer is added, and the result is partial, exit 4",
    herdr.status === 4 && herdr.env?.outcome === "partial" && row(herdr, "herdr")?.state === "added" && row(herdr, "herdr")?.reachable === false
      && /the herdr runtime is set up but does not answer here/.test(herdr.env.error?.message ?? "") && installed("@cotal-ai/herdr")?.version === VERSION, shown(herdr));
  check("a runtime left unnamed stays set up", row(herdr, "tmux")?.state === "set-up" && row(herdr, "tmux")?.selected === false && installed("@cotal-ai/tmux") !== undefined, rows(herdr));
  const plain = await run([...FULL("rt", dir), "--runtime", "herdr", "--plain"], home, withMore);
  check("its report names the runtime that is not ready", plain.status === 4 && /set up rt for codex; the herdr runtime is not ready/.test(plain.stdout) && /herdr - already set up - does not answer/.test(plain.stdout), shown(plain));
  const none = await json(FULL("rt", dir));
  check("a rerun without --runtime removes neither", none.status === 0 && rows(none).filter((x) => x.state === "set-up").map((x) => x.name).join() === "tmux,herdr" && installed("@cotal-ai/herdr") !== undefined, shown(none));
}

finish();
process.exit(process.exitCode ?? 0);
