/**
 * What `cotal setup` writes into ACP clients, the thread links, and the registry launcher, in a
 * throwaway HOME. No broker, no client application.
 *
 *  - T3 Code: an instance per space runs this Cotal's Node and entry with `acp --space`; a hand-added
 *    instance for the space is adopted, keeping its id, name, enablement and other keys; every other
 *    setting stays byte for byte; the old file is backed up beside it; a rerun writes nothing; a file
 *    that does not parse and an id held by another provider are refused; the Cotal locations the shell
 *    set travel in the instance's environment; a long space name still makes a valid id; refresh
 *    points every Cotal instance at the running Cotal; status names a command that is gone.
 *  - Zed: a custom agent per space, written into a settings file with comments and trailing commas
 *    that keeps them; a hand-added agent without a `type` is adopted and keeps the keys Zed wrote; a
 *    settings file reached through a symbolic link stays linked.
 *  - Thread links read back per space in the order they were stored, and a broken line is refused.
 *  - The launcher finds `cotal` on PATH or in `~/.local/bin`, runs `cotal acp <args>` and passes its
 *    exit status on; with no Cotal, or a Cotal without its ACP extension, it serves a stub agent that
 *    offers the terminal sign-in and asks for it on `session/new`.
 *
 * Run: pnpm --filter @cotal-ai/acp test
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { parse } from "jsonc-parser";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, x?: unknown): void => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ FAIL: ${n}`, x ?? ""); } };
const throws = (f: () => unknown): string | undefined => { try { f(); return undefined; } catch (e) { return (e as Error).message; } };

const home = mkdtempSync(join(tmpdir(), "acp-clients-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.T3CODE_HOME;
delete process.env.COTAL_HOME;
delete process.env.XDG_CONFIG_HOME;
const { t3Provider, t3SettingsPath, t3InstanceId } = await import("../src/setup/t3.js");
const { zedProvider, zedSettingsPath } = await import("../src/setup/zed.js");
const { threadStore } = await import("../src/cli.js");
const { findCotal, serveStub } = await import("../src/launcher.js");

// A Node and an entry that exist, as the CLI's own argv names them.
const node = process.execPath;
const entry = join(home, "cotal.js");
writeFileSync(entry, "");
const cotal = [node, entry];
const backups = (path: string) => readdirSync(join(path, "..")).filter((f) => f.startsWith("settings.json.cotal-backup-"));
const t3Run = (space?: string, argv = cotal) => t3Provider.connector!.run({ cotal: argv, ...(space ? { space } : {}) }) as string;
const zedRun = (space?: string, argv = cotal) => zedProvider.connector!.run({ cotal: argv, ...(space ? { space } : {}) }) as string;

// ── T3 Code ───────────────────────────────────────────────────────────────────────────────────────
const t3 = t3SettingsPath();
check("T3 is unavailable while it has no base directory and no `t3` on PATH", t3Provider.available!() === false || existsSync(join(home, ".t3")));
mkdirSync(join(home, ".t3", "userdata"), { recursive: true });
check("T3 is available once its base directory exists", t3Provider.available!() === true);
check("T3 status asks for setup while it has no Cotal provider", JSON.stringify(t3Provider.status!({ version: "0", skillsRemedy: "" })) === JSON.stringify([{ label: "T3 Code", state: "off", text: "no Cotal provider · run `cotal setup`" }]));
check("T3 setup refuses a run with no space", throws(() => t3Run())?.includes("needs the space") === true);
const added = t3Run("demo");
const fresh = JSON.parse(readFileSync(t3, "utf8")) as { providerInstances: Record<string, Record<string, unknown>> };
check("a first run adds instance cotal-<space> that runs this Cotal's Node and entry with acp --space",
  /added/.test(added) && JSON.stringify(fresh.providerInstances["cotal-demo"]) === JSON.stringify({ driver: "acpRegistry", displayName: "Cotal (demo)", enabled: true, config: { source: "local", commandPath: node, commandArgs: [entry, "acp", "--space", "demo"] } }), fresh);
check("a new settings file is private and has no backup", (statSync(t3).mode & 0o777) === 0o600 && backups(t3).length === 0, statSync(t3).mode.toString(8));

// David's hand-added provider, beside settings T3 wrote.
const hand = `{
    "theme": "dark",
    "providerInstances": {
        "cotal": {
            "driver": "acpRegistry",
            "displayName": "Cotal",
            "accentColor": "#7c3aed",
            "enabled": false,
            "config": { "source": "local", "commandPath": "/opt/old/bin/cotal", "commandArgs": ["acp", "--space", "cotal_cloud"] },
            "environment": [{ "name": "FOO", "value": "bar", "sensitive": false }]
        },
        "codex": { "driver": "codex", "enabled": true }
    },
    "telemetry": false
}
`;
writeFileSync(t3, hand);
chmodSync(t3, 0o640);
process.env.COTAL_HOME = join(home, "elsewhere");
const adopted = t3Run("cotal_cloud");
const after = JSON.parse(readFileSync(t3, "utf8")) as { theme: string; telemetry: boolean; providerInstances: Record<string, Record<string, unknown>> };
const cloud = after.providerInstances.cotal!;
check("a hand-added instance for the space is adopted, not duplicated", /updated/.test(adopted) && Object.keys(after.providerInstances).join() === "cotal,codex", Object.keys(after.providerInstances));
check("the adopted instance runs this Cotal, keeping its id, name, colour and enablement",
  (cloud.config as Record<string, unknown>).commandPath === node && JSON.stringify((cloud.config as Record<string, unknown>).commandArgs) === JSON.stringify([entry, "acp", "--space", "cotal_cloud"]) && cloud.displayName === "Cotal" && cloud.accentColor === "#7c3aed" && cloud.enabled === false, cloud);
check("a Cotal home the shell set travels in the instance's environment, beside the person's own variables",
  JSON.stringify(cloud.environment) === JSON.stringify([{ name: "FOO", value: "bar", sensitive: false }, { name: "COTAL_HOME", value: join(home, "elsewhere"), sensitive: false }]), cloud.environment);
check("every other setting is kept, and the file keeps its mode", after.theme === "dark" && after.telemetry === false && JSON.stringify(after.providerInstances.codex) === '{"driver":"codex","enabled":true}' && (statSync(t3).mode & 0o777) === 0o640);
const t3Backups = backups(t3);
check("the old file is backed up beside it, as it was", t3Backups.length === 1 && readFileSync(join(t3, "..", t3Backups[0]!), "utf8") === hand, t3Backups);
const before = readFileSync(t3, "utf8");
check("a rerun with nothing to change writes nothing", /is current/.test(t3Run("cotal_cloud")) && readFileSync(t3, "utf8") === before && backups(t3).length === 1);
delete process.env.COTAL_HOME;
check("a second space gets its own instance", /added/.test(t3Run("demo")) && Object.keys((JSON.parse(readFileSync(t3, "utf8")) as typeof after).providerInstances).includes("cotal-demo"));
const t3Status = t3Provider.status!({ version: "0", skillsRemedy: "" });
check("T3 status names the spaces it reaches", t3Status[0]?.state === "ok" && t3Status[0].text === "Cotal for cotal_cloud, demo", t3Status);
const moved = [node, join(home, "moved", "cotal.js")];
mkdirSync(join(home, "moved"));
writeFileSync(moved[1]!, "");
check("refresh points every Cotal instance at the running Cotal, keeping each space", /now run this Cotal/.test(t3Provider.refresh!.run({ cotal: moved }) as string)
  && Object.values((JSON.parse(readFileSync(t3, "utf8")) as typeof after).providerInstances).filter((i) => i.driver === "acpRegistry").every((i) => (i.config as { commandArgs: string[] }).commandArgs[0] === moved[1]));
rmSync(moved[1]!);
const stale = t3Provider.status!({ version: "0", skillsRemedy: "" });
check("T3 status warns when an instance's entry is gone, and says to run cotal update", stale[0]?.state === "warn" && stale[0].text.includes(`${moved[1]} is gone`) && stale[0].text.includes("cotal update"), stale);
writeFileSync(t3, `{"providerInstances": {"cotal-other": {"driver": "codex"}}}`);
check("an id another provider holds is refused, naming it", throws(() => t3Run("other"))?.includes("already has a provider cotal-other") === true);
writeFileSync(t3, "{ not json");
check("a file that does not parse is refused and left as it was", throws(() => t3Run("demo"))?.includes("is not valid T3 Code settings") === true && readFileSync(t3, "utf8") === "{ not json");
const long = "s".repeat(64);
check("a long space name still makes a valid T3 id", /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(t3InstanceId(long)) && t3InstanceId(long).length === 64 && t3InstanceId(long) !== t3InstanceId(`${long.slice(0, 63)}t`));
rmSync(t3);
check("refresh with no settings file reports not installed", t3Provider.refresh!.run({ cotal }) === "not installed");

// ── Zed ───────────────────────────────────────────────────────────────────────────────────────────
process.env.XDG_CONFIG_HOME = join(home, ".config");
const zed = zedSettingsPath();
check("Zed's settings live in XDG_CONFIG_HOME on Linux", process.platform !== "linux" || zed === join(home, ".config", "zed", "settings.json"), zed);
mkdirSync(join(zed, ".."), { recursive: true });
const zedText = `// Zed settings
{
  "theme": "One Dark", // the person's theme
  "agent_servers": {
    "Cotal": {
      "command": "cotal",
      "args": ["acp", "--space", "cotal_cloud"],
      "default_config_options": { "model": "claude/opus" },
    },
  },
}
`;
writeFileSync(zed, zedText);
check("Zed is available once its config directory exists", zedProvider.available!() === true);
zedRun("cotal_cloud");
const zedAfter = readFileSync(zed, "utf8");
const zedValue = parse(zedAfter, [], { allowTrailingComma: true }) as { theme: string; agent_servers: Record<string, Record<string, unknown>> };
check("comments and trailing commas survive the edit", zedAfter.startsWith("// Zed settings\n") && zedAfter.includes("// the person's theme") && zedValue.theme === "One Dark", zedAfter);
check("a hand-added agent without a type is adopted as a custom agent running this Cotal, keeping what Zed wrote",
  JSON.stringify(zedValue.agent_servers.Cotal) === JSON.stringify({ command: node, args: [entry, "acp", "--space", "cotal_cloud"], default_config_options: { model: "claude/opus" }, type: "custom", env: { XDG_CONFIG_HOME: join(home, ".config") } }), zedValue.agent_servers);
zedRun("demo");
const both = parse(readFileSync(zed, "utf8"), [], { allowTrailingComma: true }) as typeof zedValue;
check("another space gets its own agent, named for the space, with the config home the shell set", JSON.stringify(both.agent_servers["Cotal (demo)"]) === JSON.stringify({ type: "custom", command: node, args: [entry, "acp", "--space", "demo"], env: { XDG_CONFIG_HOME: join(home, ".config") } }), both.agent_servers);
check("Zed status names the spaces it reaches", zedProvider.status!({ version: "0", skillsRemedy: "" })[0]?.text === "Cotal for cotal_cloud, demo");
// A settings file kept in a dotfiles folder and linked into place.
const dotfiles = join(home, "dotfiles");
mkdirSync(dotfiles);
const real = join(dotfiles, "zed-settings.json");
writeFileSync(real, "{}\n");
rmSync(zed);
symlinkSync(real, zed);
zedRun("linked");
check("a linked settings file stays linked, and its target takes the change", lstatSync(zed).isSymbolicLink() && readFileSync(real, "utf8").includes("Cotal (linked)"), readFileSync(real, "utf8"));
check("the backup of a linked file sits beside its target", readdirSync(dotfiles).some((f) => f.startsWith("zed-settings.json.cotal-backup-")), readdirSync(dotfiles));

// ── Thread links ──────────────────────────────────────────────────────────────────────────────────
const linksDir = join(home, ".cotal", "acp");
const links = threadStore(linksDir);
check("no link file reads as no links", links.read("a").length === 0);
links.add("a", { thread: "t1", lifecycleUid: "u1" });
links.add("b", { thread: "t1", lifecycleUid: "u9" });
links.add("a", { thread: "t1", lifecycleUid: "u2" });
check("links read back per space, in the order they were stored", JSON.stringify(links.read("a")) === JSON.stringify([{ thread: "t1", lifecycleUid: "u1" }, { thread: "t1", lifecycleUid: "u2" }]), links.read("a"));
check("the link file is private", (statSync(join(linksDir, "threads")).mode & 0o077) === 0, statSync(join(linksDir, "threads")).mode.toString(8));
writeFileSync(join(linksDir, "threads"), "{\"space\":\"a\"}\n", { flag: "a" });
check("a line that is not a link is refused, naming the file", throws(() => links.read("a"))?.includes("line 4 is not a thread link") === true);

// ── The launcher ──────────────────────────────────────────────────────────────────────────────────
if (process.platform !== "win32") {
  const bin = join(home, "bin");
  mkdirSync(bin);
  const log = join(home, "cotal-args");
  const fakeCotal = (dir: string, withAcp: boolean) => {
    writeFileSync(join(dir, "cotal"), `#!/bin/sh\nif [ "$1 $2" = "acp --help" ]; then exit ${withAcp ? 0 : 1}; fi\necho "$@" > "${log}"\nexit 7\n`);
    chmodSync(join(dir, "cotal"), 0o755);
  };
  check("with no cotal anywhere the launcher finds none", findCotal({ PATH: bin }, "linux", home) === undefined);
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  fakeCotal(join(home, ".local", "bin"), true);
  check("the get.cotal.ai launcher in ~/.local/bin is found when PATH lacks it", findCotal({ PATH: bin }, "linux", home) === join(home, ".local", "bin", "cotal"));
  fakeCotal(bin, true);
  check("a cotal on PATH comes first", findCotal({ PATH: bin }, "linux", home) === join(bin, "cotal"));

  const launcher = join(import.meta.dirname, "..", "src", "cotal-acp.ts");
  const tsx = join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsx");
  /** Run the launcher, writing each of `requests` once the reply before it arrived, then closing stdin. */
  const run = (path: string, args: string[], requests: object[] = []): Promise<{ code: number | null; stdout: string }> => new Promise((resolve) => {
    // npm's global prefix is cleared so a Cotal installed on the machine running the smoke stays out of reach.
    const child = spawn(tsx, [launcher, ...args], { env: { ...process.env, HOME: home, PATH: `${path}:${join(process.execPath, "..")}`, npm_config_global_prefix: "" }, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    let sent = 0;
    const next = () => (sent < requests.length ? child.stdin.write(`${JSON.stringify(requests[sent++])}\n`) : child.stdin.end());
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.split("\n").filter(Boolean).length >= sent) next();
    });
    child.on("exit", (code) => resolve({ code, stdout }));
    next();
  });
  const ran = await run(bin, ["--space", "demo"]);
  check("the launcher runs `cotal acp <args>` and passes its exit status on", ran.code === 7 && readFileSync(log, "utf8").trim() === "acp --space demo", { ran, args: existsSync(log) ? readFileSync(log, "utf8") : null });

  fakeCotal(bin, false);
  rmSync(join(home, ".local", "bin", "cotal"));
  const stubbed = await run(bin, [], [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} } },
    { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: home, mcpServers: [] } },
  ]);
  const replies = stubbed.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { id: number; result?: { authMethods?: { type: string; args: string[] }[] }; error?: { code: number; message: string } });
  check("a Cotal without its ACP extension gets the stub, which offers the terminal sign-in", replies.find((r) => r.id === 1)?.result?.authMethods?.[0]?.type === "terminal" && replies.find((r) => r.id === 1)?.result?.authMethods?.[0]?.args[0] === "--auth", stubbed);
  check("and asks for the sign-in on session/new, saying the extension is missing", replies.find((r) => r.id === 2)?.error?.code === -32000 && replies.find((r) => r.id === 2)!.error!.message.includes("ACP extension"), replies);

  // The sign-in (`--auth`) adds what is missing, then signs in through the Cotal it found.
  const calls = join(home, "cotal-calls");
  const added = join(home, "acp-added");
  const extensionless = join(home, "cotal-extensionless");
  writeFileSync(extensionless, `#!/bin/sh\necho "$@" >> "${calls}"\nif [ "$1 $2" = "acp --help" ]; then [ -e "${added}" ]; exit $?; fi\nif [ "$1 $2" = "ext add" ]; then : > "${added}"; fi\nexit 0\n`);
  chmodSync(extensionless, 0o755);
  writeFileSync(join(bin, "cotal"), readFileSync(extensionless));
  const signedIn = await run(bin, ["--auth"]);
  check("--auth on a Cotal without the extension adds it, then runs `cotal acp --auth`", signedIn.code === 0 && readFileSync(calls, "utf8").trim().split("\n").join(" | ") === "acp --help | ext add @cotal-ai/acp | acp --auth", { signedIn, calls: readFileSync(calls, "utf8") });

  // With no Cotal, `sh` stands in for the get.cotal.ai installer and leaves a Cotal in ~/.local/bin.
  rmSync(join(bin, "cotal"));
  rmSync(calls);
  const shBin = join(home, "sh-bin");
  mkdirSync(shBin);
  const installed = join(home, "installer-args");
  writeFileSync(join(shBin, "sh"), `#!/bin/sh\necho "$@" > "${installed}"\n/bin/cp "${extensionless}" "${join(home, ".local", "bin", "cotal")}"\nexit 0\n`);
  chmodSync(join(shBin, "sh"), 0o755);
  const fresh = await run(shBin, ["--auth"]);
  check("--auth with no Cotal runs the get.cotal.ai installer, then continues with the Cotal it installed", fresh.code === 0 && readFileSync(installed, "utf8").trim() === "-c curl -fsSL https://get.cotal.ai | sh" && readFileSync(calls, "utf8").trim().endsWith("acp --auth"), { fresh, calls: existsSync(calls) ? readFileSync(calls, "utf8") : null });
}

// The stub over an in-memory connection, as a registry check meets it with no Cotal installed.
{
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  void serveStub("Cotal is not installed on this computer.", toAgent.readable, toClient.writable);
  const conn = client({ name: "registry-check" }).connect(ndJsonStream(toAgent.writable, toClient.readable));
  const r = await conn.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  check("the stub advertises the terminal sign-in to a client that declares nothing", r.authMethods?.length === 1 && (r.authMethods[0] as { type?: string }).type === "terminal", r.authMethods);
  const e = await conn.agent.request(methods.agent.session.new, { cwd: home, mcpServers: [] }).then(() => undefined, (err: { code?: number }) => err);
  check("its session/new fails with -32000", e?.code === -32000, e);
  conn.close();
}

rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
