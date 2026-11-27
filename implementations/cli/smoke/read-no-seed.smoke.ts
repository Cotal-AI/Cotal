/**
 * A read installs nothing. Each read runs through the built binary in a fresh sandbox with the seed
 * gate live (no `COTAL_SKIP_CONNECTOR_SEED`). From a source checkout the gate refuses to seed, so a
 * read that still reached it would fail with that refusal; a read must run past it and leave the
 * seed store and the extension manifest unwritten. A command that is not a read still meets the
 * gate. A read that would load a built-in installed at another version than the binary's names it
 * with `cotal ext seed` instead of importing it.
 *
 * Run: pnpm smoke:read-no-seed
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createSuite } from "@cotal-ai/smoke-kit";
import { resolveComspec, resolveOnPath } from "@cotal-ai/workspace";
import { displayCmd } from "../src/lib/self-exec.js";
import { shellWord } from "../src/lib/endpoint-errors.js";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}
const VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "bin", "package.json"), "utf8")) as { version: string }).version;
const { check, finish } = createSuite();
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const roots: string[] = [];
process.on("exit", () => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A fresh home whose own `.cotal` stops the root walk, so no project above the temp dir is read. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "cotal-read-no-seed-"));
  roots.push(home);
  mkdirSync(join(home, ".cotal"));
  const xdg = join(home, ".config");
  const run = (args: string[], extraEnv: Record<string, string> = {}, cwd = home) => {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: join(home, ".cotal"), ...extraEnv },
      encoding: "utf8",
      timeout: 120_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { home, xdg, run };
}

if (process.platform === "win32") {
  const { home, xdg } = sandbox();
  const system = process.env.SystemRoot ?? "C:\\Windows";
  const cmd = resolveComspec(), powershell = join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env = {
    ...Object.fromEntries(Object.entries(HOST_ENV).filter(([name]) => !/^(?:COTAL_.*|PATH|APPDATA|LOCALAPPDATA|TEMP|TMP)$/i.test(name))),
    PATH: [join(system, "System32"), dirname(powershell)].join(";"),
    USERPROFILE: home, HOME: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home,
    COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1",
    DO_NOT_TRACK: "1", NO_COLOR: "1",
  };
  const options = { cwd: home, env, encoding: "utf8" as const, timeout: 60_000, windowsHide: true };
  const bin = dirname(dirname(BIN));
  const manifest = readFileSync(join(bin, "package.json"), "utf8");
  const dependencies = (JSON.parse(manifest) as { dependencies: Record<string, string> }).dependencies;
  for (const prefix of ["npm's & ( [1] prefix", "npm $v %TEMP% !b `t 'q & ( [ caf\u00e9 prefix"]) {
    const modules = join(home, prefix, "node_modules"), pkg = join(modules, "cotal-ai");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), manifest);
    cpSync(join(bin, "dist"), join(pkg, "dist"), { recursive: true });
    for (const name of Object.keys(dependencies)) {
      const link = join(modules, name);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(realpathSync(join(bin, "node_modules", name)), link, "junction");
    }
    const entry = join(pkg, "dist", "cotal.js");
    const root = spawnSync(process.execPath, [entry, "ext", "root"], options);
    const safeRoot = root.status === 0 && root.stdout.trim() === join(xdg, "cotal", "extensions");
    check(`installed ext root stays inside the sandbox for ${prefix}`, safeRoot, root);
    if (!safeRoot) continue;
    const status = spawnSync(process.execPath, [entry, "status"], options);
    const command = /^  (.+? setup --help) +See setup flags for scripts\./m.exec(status.stdout)?.[1];
    check(`installed status prints setup help for ${prefix} with Cotal off PATH`,
      status.status === 0 && !resolveOnPath("cotal", env) && Boolean(command), status);
    if (!command) continue;
    const ps = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restricted",
      "-EncodedCommand", Buffer.from(`${command}\nexit $LASTEXITCODE`, "utf16le").toString("base64")], options);
    const prompt = spawnSync(cmd, [`/d /s /c "${command}"`], { ...options, windowsVerbatimArguments: true });
    for (const [shell, result] of [["Restricted PowerShell", ps], ["Command Prompt", prompt]] as const) {
      check(`the command for ${prefix} opens setup help unchanged in ${shell}`,
        result.status === 0 && /^cotal setup\r?$/m.test(result.stdout) && result.stderr === "", result);
    }
    const launcher = command.slice(0, -" setup --help".length);
    const useDash = `${launcher} use --json -- -missing-space`;
    const psUse = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restricted",
      "-EncodedCommand", Buffer.from(`${useDash}\nexit $LASTEXITCODE`, "utf16le").toString("base64")], options);
    const cmdUse = spawnSync(cmd, [`/d /s /c "${useDash}"`], { ...options, windowsVerbatimArguments: true });
    for (const [shell, result] of [["Restricted PowerShell", psUse], ["Command Prompt", cmdUse]] as const) {
      const receipt = result.stdout ? JSON.parse(result.stdout) : undefined;
      check(`the launcher for ${prefix} preserves -- and -missing-space in ${shell}`,
        result.status === 2 && receipt?.command === "use" && receipt?.error?.code === "TARGET_NOT_FOUND" &&
        receipt?.error?.message?.includes('"-missing-space"') === true, result);
    }
  }
}
const shown = (r: { status: number | null; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 600) });
const GATE = /refusing to reconcile the operator-global seed store/;
/** Mode 000 hides a file from chmodSync, so restoration goes through the directory. */
function chmodUnreadable(path: string, mode = 0): void {
  if (mode === 0) chmodSync(path, 0);
  else spawnSync("chmod", [mode.toString(8), path], { stdio: "ignore" });
}

// ── Reads run past the seed gate and write nothing ──────────────────────────────────────────────────
{
  const { xdg, run } = sandbox();
  const reads: { args: string[]; exit: number }[] = [
    { args: ["status", "--json"], exit: 0 },
    { args: ["ext", "--json"], exit: 0 },
    { args: ["ext", "list", "--json"], exit: 0 },
    { args: ["ext", "root"], exit: 0 },
    { args: ["runtimes", "--json"], exit: 0 },
    { args: ["docs", "--json"], exit: 0 },
    { args: ["config", "--json"], exit: 0 },
    { args: ["space", "--json"], exit: 0 },
    { args: ["use", "--json"], exit: 0 },
    { args: ["use", "nosuch", "--json"], exit: 2 },
    { args: ["meshes"], exit: 0 },
    { args: ["meshes", "list"], exit: 0 },
    { args: ["ps", "--json"], exit: 2 },
    { args: ["models", "--json"], exit: 2 },
    { args: ["who", "--json"], exit: 2 },
  ];
  for (const { args, exit } of reads) {
    const r = run(args);
    check(`${args.filter((a) => a !== "--json").join(" ")} is a read: it runs past the seed gate, exit ${exit}`, r.status === exit && !GATE.test(r.stderr) && !/✓ added/.test(r.stderr), shown(r));
  }
  check("the reads wrote no seed store and no extension manifest",
    !existsSync(join(xdg, "cotal", "seed")) && !existsSync(join(xdg, "cotal", "extensions", "extensions.json")),
    { seed: existsSync(join(xdg, "cotal", "seed")), manifest: existsSync(join(xdg, "cotal", "extensions", "extensions.json")) });
  const human = run(["status"], { NO_COLOR: "1" });
  const next = human.stdout.split("\nNext\n")[1]?.split("\n").map(line => line.trim().replace(/ +/g, " "));
  check("status on a fresh machine leads with Cloud sign-in and still points at application setup",
    human.status === 0
      && human.stdout.split("\n").some(line => line.trim() === "Agent applications: ○ not set up")
      && next?.[0] === `${displayCmd()} login Sign in to Cotal Cloud`
      && next.some(line => line.startsWith(`${displayCmd()} setup --help See setup flags for scripts.`)), shown(human));
}

{
  const { home, xdg, run } = sandbox();
  const manifest = join(home, "mesh.yaml");
  writeFileSync(manifest, `apiVersion: cotal/v1
kind: Mesh
space: team-audit
agent: claude
agents:
  planner: {instructions: Plan.}
channels:
  general: {deliveryClass: live, subscribe: [planner], allowPublish: [planner]}
`);
  const view = ["topology", "view", "-f", manifest];
  const hasGraph = (r: ReturnType<typeof run>) => r.status === 0 &&
    ["team-audit", "planner", "#general"].every((text) => r.stdout.includes(text));
  const r = run(view);
  check("topology view renders the access graph without seeding connectors",
    hasGraph(r) && r.stderr === "", shown(r));
  check("topology view wrote no seed store or extension manifest",
    !existsSync(join(xdg, "cotal", "seed")) && !existsSync(join(xdg, "cotal", "extensions", "extensions.json")));

  const config = join(xdg, "cotal");
  const root = join(config, "extensions"), stage = join(config, ".extensions.stage-probe.ready");
  const old = join(config, ".extensions.rollback-probe"), journal = join(config, ".extensions-promotion.json");
  const pkg = "topology-promotion-fixture", version = "1.0.0";
  const pkgDir = join(stage, "node_modules", pkg);
  mkdirSync(pkgDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version }));
  writeFileSync(join(stage, "extensions.json"), JSON.stringify({ extensions: [{ pkg, spec: pkg, version, commands: [] }] }));
  const stat = lstatSync(stage);
  const promotion = JSON.stringify({ v: 1, root, stage, old, stageIdentity: { dev: String(stat.dev), ino: String(stat.ino), birth: stat.birthtimeMs } });
  writeFileSync(journal, promotion, { mode: 0o600 });

  const pending = run(view);
  check("topology view renders the graph and leaves the pending extension promotion untouched",
    hasGraph(pending) && pending.stderr === "" && !existsSync(root) && !existsSync(old) && !existsSync(join(config, "seed")) &&
    existsSync(join(pkgDir, "package.json")) && existsSync(journal) && readFileSync(journal, "utf8") === promotion, shown(pending));

  const list = run(["ext", "list", "--json"]);
  check("ext list still recovers the pending promotion and reports the installed package",
    list.status === 0 && JSON.parse(list.stdout).result.items.some((item: { pkg: string }) => item.pkg === pkg) &&
    existsSync(join(root, "node_modules", pkg, "package.json")) && !existsSync(stage) && !existsSync(journal), shown(list));

  const inventory = join(root, "extensions.json");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(inventory, "invalid manifest\n");
  const corrupt = run(view);
  check("topology view reports corrupt inventory without rewriting it",
    corrupt.status === 1 && corrupt.stdout === "" && /corrupt extensions manifest/.test(corrupt.stderr) &&
    corrupt.stderr.includes("cotal ext seed --repair") && readFileSync(inventory, "utf8") === "invalid manifest\n", shown(corrupt));
}

{
  const { home, xdg, run } = sandbox();
  const root = join(xdg, "cotal", "extensions");
  const manifest = join(root, "extensions.json");
  const corrupt = "{}\n";
  mkdirSync(root, { recursive: true });
  writeFileSync(manifest, corrupt);
  const offline = { COTAL_NO_UPDATE_CHECK: "1", COTAL_TELEMETRY: "off" };
  for (const args of [["version"], ["--version"], ["-V"]]) {
    const r = run(args, offline);
    check(`${args[0]} reports the running version with an unreadable inventory`,
      r.status === 4 && r.stdout.split("\n")[0] === `cotal-ai ${VERSION}` &&
      r.stdout.includes("run `cotal ext seed --repair` to preserve the damaged file and rebuild the built-in inventory") &&
      r.stderr.includes(`corrupt extensions manifest ${manifest}: no "extensions" array`), shown(r));
  }
  for (const args of [["config", "get", "harness", "--json"], ["--json", "config"], ["completion", "-j"]]) {
    const r = run(args, offline);
    const receipt = r.stdout ? JSON.parse(r.stdout) : undefined;
    const harness = receipt?.result?.setting ?? receipt?.result?.settings?.find((setting: { key: string }) => setting.key === "harness");
    const command = args.includes("config") ? "config" : "completion";
    check(`${args.join(" ")} reads local settings with a corrupt manifest`,
      r.status === 0 && r.stderr === "" && receipt?.command === command && receipt.outcome === "ok" &&
      (command === "config" ? harness?.key === "harness" && harness.winner?.source === "default" : Array.isArray(receipt.result?.shells)), shown(r));
  }
  const override = run(["config", "get", "harness", "--json"], { ...offline, COTAL_DEFAULT_AGENT: "custom-harness" });
  const refusal = override.stdout ? JSON.parse(override.stdout) : undefined;
  check("config get classifies a corrupt manifest when it must validate an environment harness",
    override.status === 1 && override.stderr === "" && refusal?.command === "config" && refusal.outcome === "refused" &&
    refusal.error?.code === "SCHEMA_INVALID" && refusal.error.message.includes(manifest) &&
    refusal.error.remedy.includes("cotal ext seed --repair"), shown(override));
  for (const flag of ["auto", "notify"]) {
    const write = run(["--json", "update", `--${flag}`, "off"], offline);
    const read = run(["update", `--${flag}`, "-j"], offline);
    for (const [verb, r] of [["writes", write], ["reads", read]] as const) {
      const receipt = r.stdout ? JSON.parse(r.stdout) : undefined;
      check(`update --${flag} ${verb} the preference with a corrupt manifest`,
        r.status === 0 && r.stderr === "" && receipt?.outcome === "ok" &&
        receipt.result?.kind === "update-preference" && receipt.result.preference === flag && receipt.result.enabled === false, shown(r));
    }
  }
  const settings = JSON.parse(readFileSync(join(home, ".cotal", "update-settings.json"), "utf8"));
  check("both preferences were saved", settings.auto === false && settings.notify === false, settings);

  for (const words of [["ext", "root"], ["x", "root"]]) {
    const resolved = run(words, offline);
    check(`${words.join(" ")} prints only the path to the corrupt manifest`,
      resolved.status === 0 && resolved.stdout === `${root}\n` && resolved.stderr === "", shown(resolved));
  }
  for (const words of [["ext", "list", "--json"], ["--json", "x"]]) {
    const r = run(words, offline);
    const receipt = r.stdout ? JSON.parse(r.stdout) : undefined;
    check(`${words.join(" ")} reports a structured refusal with repair advice`,
      r.status === 1 && r.stderr === "" && receipt?.command === "ext" && receipt.outcome === "refused" &&
      receipt.result === null && receipt.error?.code === "SCHEMA_INVALID" &&
      receipt.error.message.includes("corrupt extensions manifest") && receipt.error.remedy.includes("cotal ext seed --repair"), shown(r));
  }
  const corruptFailure = (error: { code?: string; message?: string; remedy?: string } | undefined) =>
    error?.code === "SCHEMA_INVALID" && error.message?.includes(manifest) === true && error.remedy?.includes("cotal ext seed --repair") === true;
  for (const [command, args] of [
    ["space", ["--json", "space"]],
    ["doctor auth", ["doctor", "auth", "--json"]],
    ["history", ["h", "general", "--space", "absent", "-j"]],
  ] as const) {
    const r = run([...args], offline);
    const receipt = r.stdout ? JSON.parse(r.stdout) : undefined;
    check(`${args.join(" ")} reports one finite refusal without running`,
      r.status === 1 && r.stderr === "" && receipt?.schemaVersion === 1 && receipt.command === command &&
      receipt.outcome === "refused" && receipt.result === null && corruptFailure(receipt.error), shown(r));
  }
  for (const [stream, args] of [
    ["watch", ["watch", "--space", "absent", "--json"]],
    ["history", ["history", "general", "--space", "absent", "--follow", "--json"]],
    ["membership", ["channel", "members", "general", "--space", "absent", "--follow", "--json"]],
  ] as const) {
    const r = run([...args], offline);
    const records = r.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const [error, end] = records;
    const target = stream === "watch" ? { requestedSpace: "absent" }
      : stream === "history" ? { space: "absent", channel: "general", dms: false } : { space: "absent", channel: "general" };
    check(`${stream} reports the corrupt manifest as a stream setup failure`,
      r.status === 1 && r.stderr === "" && records.length === 2 && error.stream === stream && end.stream === stream &&
      error.type === "error" && corruptFailure(error.data) && end.type === "end" && end.data?.reason === "setup-failed" &&
      isDeepStrictEqual(error.target, target) && isDeepStrictEqual(end.target, target), shown(r));
  }
  const add = run(["ext", "add", "example-extension"], { ...offline, npm_config_offline: "true" });
  check("ext add still refuses a corrupt manifest without installing anything",
    add.status === 1 && add.stdout === "" && add.stderr.includes("corrupt extensions manifest"), shown(add));
  check("the damaged inventory and its directory are unchanged",
    readFileSync(manifest, "utf8") === corrupt && isDeepStrictEqual(readdirSync(root), ["extensions.json"]) && !existsSync(join(xdg, "cotal", "seed")));

  const remedy = "restore this account's read access to the extensions manifest and its path, then retry";
  writeFileSync(manifest, '{"extensions":[]}\n');
  const locked = () => (statSync(manifest).mode & 0o777) === 0 && statSync(manifest).size === Buffer.byteLength('{"extensions":[]}\n');
  try {
    chmodUnreadable(manifest);
    const deniedFailure = (error: { code?: string; message?: string; remedy?: string } | undefined) =>
      error?.code === "PERMISSION_DENIED" && error.message?.includes(`cannot read the extensions manifest at ${manifest} (EACCES)`) === true && error.remedy === remedy;
    for (const [command, args] of [
      ["space", ["space", "--json"]],
      ["ext", ["ext", "list", "--json"]],
    ] as const) {
      const r = run([...args], offline);
      const receipt = r.stdout ? JSON.parse(r.stdout) : undefined;
      check(`${args.join(" ")} reports an unreadable manifest as one permission refusal`,
        r.status === 2 && r.stderr === "" && receipt?.command === command && receipt.outcome === "refused" && receipt.result === null && deniedFailure(receipt.error) && locked(), shown(r));
    }
    const watched = run(["watch", "--space", "absent", "--json"], offline);
    const watchRecords = watched.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    check("watch reports an unreadable manifest as setup error and end records",
      watched.status === 2 && watched.stderr === "" && watchRecords.length === 2 && watchRecords[0]?.type === "error" && deniedFailure(watchRecords[0]?.data) &&
      watchRecords[1]?.type === "end" && watchRecords[1]?.data?.reason === "setup-failed" && locked(), shown(watched));
    for (const [label, args] of [["plain", ["space", "--plain"]], ["text", ["space"]]] as const) {
      const r = run([...args], { ...offline, NO_COLOR: "1" });
      check(`space ${label} names the unreadable manifest and its read-access remedy`,
        r.status === 2 && r.stdout === "" && r.stderr.includes("PERMISSION_DENIED") && r.stderr.includes(manifest) && r.stderr.includes(remedy) && locked(), shown(r));
    }
    chmodUnreadable(manifest, 0o600);
    const readableAgain = run(["space", "--json"], offline);
    check("space --json succeeds again once the manifest is readable",
      readableAgain.status === 0 && JSON.parse(readableAgain.stdout).outcome === "ok", shown(readableAgain));
  } finally {
    chmodUnreadable(manifest, 0o600);
  }

  const repair = "run `cotal ext seed --repair` to preserve the damaged file and rebuild the built-in inventory";
  const entryFailure = (error: { code?: string; message?: string; remedy?: string } | undefined) =>
    error?.code === "SCHEMA_INVALID" && error.message?.includes(`corrupt extensions manifest ${manifest}: invalid extension inventory entry at index 0`) === true && error.remedy === repair;
  for (const body of ['{"extensions":[null]}\n', '{"extensions":[{}]}\n', '{"extensions":[{"pkg":"example-extension"}]}\n', '{"extensions":[{"pkg":"example-extension","commands":[null]}]}\n']) {
    writeFileSync(manifest, body);
    for (const [command, args] of [["space", ["space", "--json"]], ["ext", ["ext", "list", "--json"]]] as const) {
      const r = run([...args], offline);
      const receipt = r.stdout ? JSON.parse(r.stdout) : undefined;
      check(`${args.join(" ")} refuses ${body.trim()} as a corrupt manifest`,
        r.status === 1 && r.stderr === "" && receipt?.command === command && receipt.outcome === "refused" && entryFailure(receipt.error) && readFileSync(manifest, "utf8") === body, shown(r));
    }
    const streamed = run(["watch", "--space", "absent", "--json"], offline);
    const records = streamed.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    check(`watch refuses ${body.trim()} as setup error and end records`,
      streamed.status === 1 && streamed.stderr === "" && records.length === 2 && records[0]?.type === "error" && entryFailure(records[0]?.data) &&
      records[1]?.type === "end" && records[1]?.data?.reason === "setup-failed" && readFileSync(manifest, "utf8") === body, shown(streamed));
    const version = run(["version", "--json"], offline);
    const versionReceipt = version.stdout ? JSON.parse(version.stdout) : undefined;
    check(`version --json keeps a partial report for ${body.trim()} and uses the repair command`,
      version.status === 4 && version.stderr === "" && versionReceipt?.outcome === "partial" && versionReceipt.error?.code === "OPERATION_PARTIAL" &&
      versionReceipt.error?.remedy === repair && versionReceipt.warnings?.[0]?.message === `the extensions manifest could not be read: corrupt extensions manifest ${manifest}: invalid extension inventory entry at index 0` &&
      readFileSync(manifest, "utf8") === body, shown(version));
  }
}

{
  const { xdg, run } = sandbox();
  const before = run(["ext", "list", "--json"]);
  for (const [args, usage] of [
    [["config", "set", "editor"], /usage: cotal config set <key> <value>/],
    [["ext", "add"], /usage: cotal ext .*ext add <npm-package>/],
    [["ext", "add", "one", "two"], /usage: cotal ext .*ext add <npm-package>/],
    [["ext", "rm"], /usage: cotal ext .*ext remove <name>/],
  ] as const) {
    const r = run([...args]);
    check(`${args.join(" ")} refuses before seeding`, r.status === 1 && r.stdout === "" && usage.test(r.stderr) && !GATE.test(r.stderr), shown(r));
  }
  const saved = run(["config", "set", "editor", "vi", "--json"]);
  const editor = run(["config", "get", "editor", "--json"], { VISUAL: "", EDITOR: "" });
  check("config set saves an editor without seeding", saved.status === 0 && editor.status === 0 && JSON.parse(editor.stdout).result.setting.value === "vi", { saved: shown(saved), editor: shown(editor) });
  const after = run(["ext", "list", "--json"]);
  check("usage refusals and saving an editor leave the extension inventory empty",
    before.status === 0 && after.status === 0 && before.stdout === after.stdout && JSON.parse(after.stdout).result.items.length === 0 &&
      !existsSync(join(xdg, "cotal", "seed")) && !existsSync(join(xdg, "cotal", "extensions", "extensions.json")), shown(after));
}

{
  const { home, xdg, run } = sandbox();
  const offline = { npm_config_offline: "true", npm_config_cache: join(home, "empty-npm-cache"), DO_NOT_TRACK: "1", USER: "config-smoke", LOGNAME: "config-smoke" };
  const saved = run(["config", "set", "name", "Audit", "--user", "--json"], offline);
  const unset = run(["config", "unset", "name", "--user", "--json"], offline);
  const get = run(["config", "get", "name", "--user", "--json"], offline);
  check("config unset removes a saved name offline without seeding connectors",
    saved.status === 0 && unset.status === 0 && JSON.parse(unset.stdout).result.previous === "Audit" &&
      get.status === 0 && JSON.parse(get.stdout).result.setting.winner?.source !== "user" &&
      unset.stderr === "" && !existsSync(join(xdg, "cotal", "seed")) && !existsSync(join(xdg, "cotal", "extensions")),
    { saved: shown(saved), unset: shown(unset), get: shown(get) });
}

{
  const { home, xdg, run } = sandbox();
  const offline = { npm_config_offline: "true", npm_config_cache: join(home, "empty-npm-cache"), COTAL_TELEMETRY: "off" };
  for (const args of [["history", "limit", "--json"], ["h", "--json", "limit", "--yes"]]) {
    const r = run(args, offline);
    check(`${args.join(" ")} reaches space preflight offline without seeding`,
      r.status === 2 && r.stderr === "" && JSON.parse(r.stdout).error?.code === "TARGET_NOT_FOUND", shown(r));
  }
  check("history limit reads write no seed store or extensions", !existsSync(join(xdg, "cotal", "seed")) && !existsSync(join(xdg, "cotal", "extensions")));
  for (const flag of ["max-age", "per-sender", "inbox-max-age", "inbox-per-agent", "dm-max-age", "dm-per-sender"]) {
    const r = run(["history", "limit", `--${flag}=none`, "--yes", "--json"], offline);
    const error = r.stdout ? JSON.parse(r.stdout).error : undefined;
    check(`history limit --${flag} still reaches the seed gate`, r.status === 2 && error?.code === "DEPENDENCY_UNAVAILABLE" && GATE.test(error.message), shown(r));
  }
}

{
  const { home, xdg, run } = sandbox();
  const offline = { COTAL_NO_UPDATE_CHECK: "1", COTAL_TELEMETRY: "off" };
  for (const [selector, space, diagnosis] of [
    [["--server", "http://127.0.0.1:1"], null, /--server scheme "http" is not a broker scheme/],
    [["--space", ""], null, /--space\/-s is empty; name one space/],
  ] as const) {
    for (const [args, target] of [
      [["watch"], { requestedSpace: space }],
      [["history", "general", "--follow"], { space, channel: "general", dms: false }],
    ] as const) {
      const r = run([...args, ...selector, "--json"], offline);
      const records = r.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
      const [error, end] = records;
      check(`${args.join(" ")} frames an invalid ${selector[0]} as a stream failure`,
        r.status === 1 && r.stderr === "" && records.length === 2 && records.every((record) =>
          record.schemaVersion === 1 && record.stream === args[0] && isDeepStrictEqual(record.target, target)) &&
        error.type === "error" && error.data.code === "USAGE_INVALID" && diagnosis.test(error.data.message) &&
        end.type === "end" && end.data.reason === "setup-failed", shown(r));
    }
    const finite = run(["history", "general", ...selector, "--json"], offline);
    const receipt = JSON.parse(finite.stdout);
    check(`finite history keeps its refusal receipt for an invalid ${selector[0]}`,
      finite.status === 1 && finite.stderr === "" && receipt.command === "history" && receipt.outcome === "refused" &&
      receipt.error.code === "USAGE_INVALID" && diagnosis.test(receipt.error.message), shown(finite));
  }
  check("invalid stream selectors do not seed extensions or select a mesh",
    !existsSync(join(xdg, "cotal", "extensions")) && !existsSync(join(home, ".cotal", "current-mesh")));
}

// ── Argument and migration refusals leave a fresh installation untouched ──────────────────────────
{
  const { home, xdg, run } = sandbox();
  const project = join(home, "project");
  mkdirSync(project);
  const offline = { npm_config_offline: "true", npm_config_cache: join(home, "empty-npm-cache"), COTAL_TELEMETRY: "off" };
  const invalid = run(["space", "create", "dotted.name", "--json"], offline, project);
  const receipt = invalid.stdout ? JSON.parse(invalid.stdout) : undefined;
  check("space create refuses an invalid name before the connector gate",
    invalid.status === 1 && invalid.stderr === "" && receipt?.outcome === "refused" &&
    receipt.target?.requested === "dotted.name" && receipt.error?.code === "USAGE_INVALID" &&
    receipt.error.message.includes("a space name is 1 to 64 letters") &&
    receipt.error.remedy === "choose a name of only letters, digits, underscores and hyphens", shown(invalid));

  const launch = ["--name", "example"];
  const catalog = run(["start", "--config", "default", ...launch], offline, project);
  const path = "./Owner's persona.md";
  const file = run(["start", `--config=${path}`, ...launch, "--prompt", "review the first draft"], offline, project);
  const command = (r: ReturnType<typeof run>) => r.stderr.split("\n").find(line => line.startsWith("  "))?.trim();
  const migratedCatalog = command(catalog);
  const migratedFile = command(file);
  check("start refuses without the gate and prints the catalog retry",
    catalog.status === 1 && catalog.stdout === "" && catalog.stderr.includes("`cotal start` was removed") &&
    !GATE.test(catalog.stderr) && migratedCatalog?.endsWith(" spawn default --detach --name example") === true, shown(catalog));
  check("start replaces a file config with a quoted --file and retains launch options",
    file.status === 1 && file.stdout === "" && !GATE.test(file.stderr) &&
    migratedFile?.endsWith(` spawn --detach --file ${shellWord(path)} --name example --prompt 'review the first draft'`) === true, shown(file));
  check("refusals leave the project, seed store and extensions untouched",
    readdirSync(project).length === 0 && !existsSync(join(xdg, "cotal", "seed")) && !existsSync(join(xdg, "cotal", "extensions")));
}

// ── A command that is not a read still meets the gate ───────────────────────────────────────────────
{
  const { run } = sandbox();
  for (const args of [["space", "forget", "nope"], ["meshes", "rm", "nope"], ["ext", "add", "@acme/none"]]) {
    const r = run(args);
    check(`${args.join(" ")} is not a read: the seed gate runs first and refuses from a source checkout`, r.status === (args[0] === "space" ? 2 : 1) && GATE.test(r.stderr), shown(r));
  }
}

// ── A read never loads a built-in installed at another version ──────────────────────────────────────
{
  const { home, xdg, run } = sandbox();
  const pkg = "@cotal-ai/connector-claude-code";
  const pkgDir = join(xdg, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-claude-code");
  mkdirSync(pkgDir, { recursive: true });
  const marker = join(home, "imported");
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version: "0.0.1", type: "module", main: "index.js" }));
  writeFileSync(join(pkgDir, "index.js"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "imported");\n`);
  writeFileSync(join(xdg, "cotal", "extensions", "extensions.json"), JSON.stringify({
    extensions: [{
      pkg, version: "0.0.1", spec: `${pkg}@0.0.1`, source: "seeded",
      provides: [{ kind: "connector", name: "claude" }, { kind: "connector-setup", name: "claude" }], commands: [],
      connectors: [{ name: "claude", requires: [], eventPlane: true, setup: { kind: "connector-setup", name: "claude" } }],
    }],
  }));
  const r = run(["status", "--json"]);
  let rows: { name: string; state: string; text: string }[] = [];
  try {
    rows = (JSON.parse(r.stdout) as { result: { machine: { integrations: typeof rows } } }).result.machine.integrations;
  } catch {
    rows = [];
  }
  const row = rows.find((i) => i.name === "claude setup");
  check("status names the older built-in and the command that brings it to this version",
    row?.state === "error" && row.text === `${pkg} is 0.0.1 and this cotal is ${VERSION} - run \`cotal ext seed\` to bring it to this version`, { status: r.status, rows });
  check("and never imported it", !existsSync(marker));
}

// A real ext add must preserve the declaration the lazy command's seed decision reads.
{
  const { home, xdg, run } = sandbox();
  const fixture = join(home, "read-extension");
  mkdirSync(fixture);
  writeFileSync(join(fixture, "package.json"), JSON.stringify({
    name: "read-cache-fixture", version: "1.0.0", type: "module", main: "index.js",
    peerDependencies: { "@cotal-ai/core": "*" },
  }));
  const core = pathToFileURL(join(import.meta.dirname, "..", "..", "..", "packages", "core", "dist", "index.js")).href;
  writeFileSync(join(fixture, "index.js"), `import { registry } from ${JSON.stringify(core)};
registry.register({ kind: "command", name: "inspect-read-cache", summary: "owned read fixture", reads: true,
  positionals: "[list | write]", subcommands: [{ name: "list", summary: "read list", reads: true }, { name: "write", summary: "non-read control" }],
  run: async () => console.log("fixture-read-ran") });
`);
  const added = run(["ext", "add", fixture], { COTAL_SKIP_CONNECTOR_SEED: "1" });
  check("control: real ext add caches the owned read extension", added.status === 0 && existsSync(join(xdg, "cotal", "extensions", "extensions.json")), shown(added));
  const bare = run(["inspect-read-cache"]);
  check("an installed bare read runs past the seed gate", bare.status === 0 && bare.stdout.trim() === "fixture-read-ran" && !GATE.test(bare.stderr), shown(bare));
  const sub = run(["inspect-read-cache", "list"]);
  check("an installed read subcommand runs past the seed gate", sub.status === 0 && sub.stdout.trim() === "fixture-read-ran" && !GATE.test(sub.stderr), shown(sub));
  const write = run(["inspect-read-cache", "write"]);
  check("an installed non-read subcommand still meets the seed gate", write.status === 1 && GATE.test(write.stderr) && !write.stdout.includes("fixture-read-ran"), shown(write));
}

finish();
