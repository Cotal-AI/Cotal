import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { accessSync, constants, existsSync } from "node:fs";
import { arch, cpus, homedir, hostname, totalmem } from "node:os";
import { join } from "node:path";
import type { CompletionResult, ParsedArgs } from "@cotal-ai/core";
import {
  commandIsCotalSupervisor,
  localProcessPath,
  MANAGER_PIDFILE,
  parsePid,
  probeLiveness,
  readProcessCommand,
  spaceKey,
} from "@cotal-ai/workspace";
import { cotalRoot } from "../lib/paths.js";
import { selfArgv } from "../lib/self-exec.js";
import { resolveRuntimeSpace } from "../lib/status.js";
import { c } from "../ui.js";

/**
 * `cotal service` — run the workstation's manager as a user service, so it survives logout
 * and reboot. The manager is the only daemon this installs; the broker and every other
 * component keep their existing lifecycle. The unit's ExecStart is this CLI's own argv plus
 * the `supervise` subcommand, so the supervised process is the same one the operator would
 * run by hand (`selfArgv()` refuses when this process is not the cotal entry).
 *
 * Linux installs a systemd user unit under `~/.config/systemd/user/`, one per mesh
 * (`cotal-manager@<spaceKey>.service`); macOS installs a launchd agent plist under
 * `~/Library/LaunchAgents/`. Any other platform, or an absent systemd/launchd, throws with a
 * message naming what is missing. No fallback.
 *
 * Every file written here starts with the {@link MARKER} provenance comment; `uninstall`
 * refuses to remove a file without it, so an operator-written unit is never destroyed.
 */

/** The provenance header every file this command writes carries; uninstall checks it. */
const MARKER = "installed by `cotal service install`";

const systemdUserDir = (): string =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");
const launchAgentsDir = (): string => join(process.env.HOME ?? homedir(), "Library", "LaunchAgents");

/** The systemd user unit name for a mesh (one unit per mesh; `<spaceKey>` is case-safe). */
export const systemdUnitName = (mesh: string): string => `cotal-manager@${spaceKey(mesh)}.service`;
/** The launchd agent label for a mesh. */
export const launchdLabel = (mesh: string): string => `ai.cotal.manager.${spaceKey(mesh)}`;

/** The machine facts the hosting side asks about when placing a workstation. */
export interface HostFacts {
  arch: string;
  os: string;
  cpuCount: number;
  memoryBytes: number;
  kvm: "present" | "absent" | "denied";
}

/** `/dev/kvm` presence and access. `denied` means it exists but this user cannot use it. */
function kvmState(): HostFacts["kvm"] {
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return "present";
  } catch {
    return existsSync("/dev/kvm") ? "denied" : "absent";
  }
}

export function hostFacts(): HostFacts {
  return {
    arch: arch(),
    os: `${process.platform} ${hostname()}`,
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
    kvm: process.platform === "linux" ? kvmState() : "absent",
  };
}

/** One command run, never throwing: the caller decides what a non-zero status means. */
function run(cmd: string, args: string[]): { status: number | null; output: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 60_000 });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** The mesh a `service` subcommand acts on: `--mesh <name>`, else this folder's runtime space. */
function meshOf(values: { mesh?: string }): string {
  return values.mesh ?? resolveRuntimeSpace(process.cwd());
}

/** The manager's pid + attribution for an explicit root, mirroring `managerRecordState`
 *  (which resolves its root from cwd); `service status` must judge the unit's recorded root,
 *  not whatever folder the operator is standing in. */
function managerHealthFor(root: string, mesh: string): { state: string; pid?: number } {
  const pidPath = localProcessPath(MANAGER_PIDFILE, { root, space: mesh });
  if (!existsSync(pidPath)) return { state: "absent" };
  const raw = readFileSync(pidPath, "utf8").trim();
  if (raw === "") return { state: "absent" };
  const pid = parsePid(raw);
  if (pid === undefined) return { state: "unattributable" };
  const liveness = probeLiveness(pid);
  if (liveness !== "alive") return { state: liveness, pid };
  const cmd = readProcessCommand(pid);
  if (cmd.kind !== "command") return { state: "alive", pid };
  return { state: commandIsCotalSupervisor(cmd.command) ? "alive" : "foreign", pid };
}

/** `systemctl --user …`; a missing binary or a user session that cannot be reached is a
 *  hard refusal naming what is missing (no fallback). */
function systemctl(args: string[]): { status: number | null; output: string } {
  const probe = run("systemctl", ["--user", ...args]);
  if (probe.status === null && !probe.output)
    throw new Error(`systemd user session is not available on this machine: \`systemctl --user ${args.join(" ")}\` could not run (is systemctl installed?)`);
  if (probe.status === null) throw new Error(`\`systemctl --user ${args.join(" ")}\` could not run: ${probe.output}`);
  return probe;
}

function assertSystemdUser(): void {
  if (process.platform !== "linux")
    throw new Error(`\`cotal service\` needs systemd user units (Linux) or launchd agents (macOS); this is ${process.platform}`);
  const probe = run("systemctl", ["--user", "is-system-running"]);
  if (probe.status === null)
    throw new Error(`systemd user session is not available: ${probe.output || "`systemctl --user` could not run (is systemctl installed?)"}`);
  if (probe.status !== 0 && !/^(degraded|running)$/m.test(probe.output))
    throw new Error(`systemd user session is not usable: \`systemctl --user is-system-running\` -> ${probe.output}`);
}

function assertLaunchd(): void {
  if (process.platform !== "darwin")
    throw new Error(`\`cotal service\` needs launchd agents (macOS) or systemd user units (Linux); this is ${process.platform}`);
  const probe = run("launchctl", ["version"]);
  if (probe.status !== 0)
    throw new Error(`launchd is not usable: \`launchctl version\` -> ${probe.output || "not found"}`);
}

function humanBytes(n: number): string {
  const gib = n / (1024 ** 3);
  return Number.isInteger(gib) ? `${gib} GiB` : `${gib.toFixed(1)} GiB`;
}

interface ServiceStatus {
  installed: boolean;
  mesh: string;
  root?: string;
  unit?: { name: string; state: string; enabled: boolean | "unknown" };
  manager?: { state: string; pid?: number };
  linger?: boolean;
}

/** systemd state for one unit: `inactive`/`not-found` handled without throwing. */
function systemdUnitStatus(unit: string): { state: string; enabled: boolean | "unknown" } {
  const active = systemctl(["is-active", unit]);
  const state = active.status === 0 ? active.output : active.output || "inactive";
  const enabledProbe = systemctl(["is-enabled", unit]);
  const enabled = enabledProbe.status === 0 ? true : /disabled/.test(enabledProbe.output) ? false : "unknown";
  return { state: state === "not-found" ? "not-found" : state, enabled };
}

/** Read the provenance fields a unit/plist carries. */
function readUnitFields(path: string, meshPrefix: string, rootPrefix: string): { mesh?: string; root?: string; marked: boolean } {
  const text = readFileSync(path, "utf8");
  const mesh = text.split("\n").find((l) => l.startsWith(meshPrefix))?.slice(meshPrefix.length).trim();
  const root = text.split("\n").find((l) => l.startsWith(rootPrefix))?.slice(rootPrefix.length).trim();
  return { mesh, root, marked: text.includes(MARKER) };
}

export async function service(args: ParsedArgs): Promise<void> {
  const [sub] = args.positionals;
  const values = args.values as { mesh?: string; linger?: boolean; json?: boolean };
  if (sub === "install") return install(values);
  if (sub === "status") return status(values);
  if (sub === "uninstall") return uninstall(values);
  throw new Error("usage: cotal service <install [--mesh <name>] [--linger] | status [--mesh <name>] [--json] | uninstall [--mesh <name>]>");
}

function install(values: { mesh?: string; linger?: boolean }): void {
  const mesh = meshOf(values);
  const root = cotalRoot();
  // BEFORE anything is written: a re-exec that silently does not happen would report a
  // healthy service over nothing, so the argv is proven here, not at unit start.
  const exec = [...selfArgv(), "supervise", "--space", mesh];
  if (process.platform === "linux") {
    assertSystemdUser();
    const unit = systemdUnitName(mesh);
    const path = join(systemdUserDir(), unit);
    const body = [
      `# ${MARKER}`,
      `# cotal-mesh: ${mesh}`,
      `# cotal-root: ${root}`,
      `[Unit]`,
      `Description=Cotal manager for mesh ${mesh}`,
      ``,
      `[Service]`,
      `Type=simple`,
      `WorkingDirectory=${root}`,
      `ExecStart=${exec.map((t) => (t.includes(" ") ? JSON.stringify(t) : t)).join(" ")}`,
      `Restart=on-failure`,
      `RestartSec=5s`,
      ``,
      `[Install]`,
      `WantedBy=default.target`,
      ``,
    ].join("\n");
    mkdirSync(systemdUserDir(), { recursive: true });
    if (existsSync(path) && !readUnitFields(path, "# cotal-mesh:", "# cotal-root:").marked)
      throw new Error(`${path} already exists and was not written by \`cotal service install\` - remove it by hand if you want this command to own it`);
    writeFileSync(path, body);
    systemctl(["daemon-reload"]);
    const started = systemctl(["enable", "--now", unit]);
    if (started.status !== 0) throw new Error(`enabling ${unit} failed: ${started.output}`);
    linger(values, mesh);
    console.log(c.green(`✓ service installed: ${unit}`) + c.dim(` - manager for mesh "${mesh}" under ${root}`));
    return;
  }
  if (process.platform === "darwin") {
    assertLaunchd();
    const label = launchdLabel(mesh);
    const path = join(launchAgentsDir(), `${label}.plist`);
    const body = [
      `<!-- ${MARKER} -->`,
      `<!-- cotal-mesh: ${mesh} -->`,
      `<!-- cotal-root: ${root} -->`,
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<plist version="1.0">`,
      `<dict>`,
      `  <key>Label</key><string>${label}</string>`,
      `  <key>ProgramArguments</key>`,
      `  <array>`,
      ...exec.map((t) => `    <string>${t.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`),
      `  </array>`,
      `  <key>WorkingDirectory</key><string>${root}</string>`,
      `  <key>RunAtLoad</key><true/>`,
      `  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>`,
      `</dict>`,
      `</plist>`,
      ``,
    ].join("\n");
    mkdirSync(launchAgentsDir(), { recursive: true });
    if (existsSync(path) && !readUnitFields(path, "<!-- cotal-mesh:", "<!-- cotal-root:").marked)
      throw new Error(`${path} already exists and was not written by \`cotal service install\` - remove it by hand if you want this command to own it`);
    writeFileSync(path, body);
    const loaded = run("launchctl", ["load", "-w", path]);
    if (loaded.status !== 0) throw new Error(`loading ${path} failed: ${loaded.output}`);
    console.log(c.green(`✓ service installed: ${label}`) + c.dim(` - manager for mesh "${mesh}" under ${root}`));
    return;
  }
  throw new Error(`\`cotal service\` is not supported on ${process.platform} - it needs systemd user units (Linux) or launchd agents (macOS)`);
}

/** Linger only when asked, never silently; report an already-lingering user instead of touching it. */
function linger(values: { linger?: boolean }, mesh: string): void {
  const current = run("loginctl", ["show-user", String(process.getuid?.() ?? ""), "--property=Linger", "--value"]);
  const enabled = current.status === 0 && current.output.trim() === "yes";
  if (values.linger) {
    if (enabled) {
      console.log(c.dim(`• lingering already enabled for this user`));
      return;
    }
    const on = run("loginctl", ["enable-linger", String(process.getuid?.() ?? "")]);
    if (on.status !== 0) throw new Error(`enabling linger failed: ${on.output}`);
    console.log(c.dim(`• lingering enabled - the user manager now starts at boot`));
    return;
  }
  if (enabled) console.log(c.yellow(`! lingering is already enabled for this user (the service survives logout with or without it)`));
  else console.log(c.dim(`• the service stops at this user's last logout - pass --linger to keep it running (and start it at boot)`));
  void mesh;
}

function readStatus(values: { mesh?: string }): ServiceStatus {
  const mesh = meshOf(values);
  const out: ServiceStatus = { installed: false, mesh };
  if (process.platform === "linux") {
    const unit = systemdUnitName(mesh);
    const path = join(systemdUserDir(), unit);
    if (!existsSync(path)) return out;
    const fields = readUnitFields(path, "# cotal-mesh:", "# cotal-root:");
    const state = systemdUnitStatus(unit);
    return {
      installed: true,
      mesh: fields.mesh ?? mesh,
      ...(fields.root ? { root: fields.root } : {}),
      unit: { name: unit, state: state.state, enabled: state.enabled },
      ...(fields.root ? { manager: managerHealthFor(fields.root, fields.mesh ?? mesh) } : {}),
      linger: run("loginctl", ["show-user", String(process.getuid?.() ?? ""), "--property=Linger", "--value"]).output.trim() === "yes",
    };
  }
  if (process.platform === "darwin") {
    const label = launchdLabel(mesh);
    const path = join(launchAgentsDir(), `${label}.plist`);
    if (!existsSync(path)) return out;
    const fields = readUnitFields(path, "<!-- cotal-mesh:", "<!-- cotal-root:");
    const listed = run("launchctl", ["list", label]);
    const pid = Number(listed.output.split("\t")[0]);
    return {
      installed: true,
      mesh: fields.mesh ?? mesh,
      ...(fields.root ? { root: fields.root } : {}),
      unit: { name: label, state: listed.status === 0 ? (Number.isInteger(pid) && pid > 0 ? "running" : "loaded") : "not-loaded", enabled: listed.status === 0 },
      ...(fields.root ? { manager: managerHealthFor(fields.root, fields.mesh ?? mesh) } : {}),
    };
  }
  throw new Error(`\`cotal service\` is not supported on ${process.platform}`);
}

function status(values: { mesh?: string; json?: boolean }): void {
  const s = readStatus(values);
  const facts = hostFacts();
  if (values.json) {
    console.log(JSON.stringify({ ...s, host: facts }, null, 2));
    return;
  }
  console.log(c.bold("cotal service status"));
  if (!s.installed) {
    console.log(c.dim(`  service not installed for mesh "${s.mesh}" - install with: cotal service install --mesh ${s.mesh}`));
  } else {
    const unit = s.unit!;
    console.log(`  ${"unit".padEnd(16)} ${unit.name}`);
    console.log(`  ${"unit state".padEnd(16)} ${unit.state === "active" ? c.green(unit.state) : c.yellow(unit.state)}`);
    console.log(`  ${"enabled".padEnd(16)} ${unit.enabled === true ? c.green("yes") : unit.enabled === false ? c.red("no") : c.dim("unknown")}`);
    if (s.root) console.log(`  ${"root".padEnd(16)} ${s.root}`);
    const mgr = s.manager!;
    console.log(`  ${"manager".padEnd(16)} ${mgr.state === "alive" ? c.green(`running (pid ${mgr.pid})`) : c.yellow(mgr.state)}`);
    if (s.linger !== undefined) console.log(`  ${"linger".padEnd(16)} ${s.linger ? c.green("enabled") : c.dim("disabled")}`);
  }
  console.log(`  ${"arch".padEnd(16)} ${facts.arch}`);
  console.log(`  ${"os".padEnd(16)} ${facts.os}`);
  console.log(`  ${"/dev/kvm".padEnd(16)} ${facts.kvm === "present" ? c.green("present") : c.yellow(facts.kvm)}`);
  console.log(`  ${"cpus".padEnd(16)} ${facts.cpuCount}`);
  console.log(`  ${"memory".padEnd(16)} ${humanBytes(facts.memoryBytes)}`);
}

function uninstall(values: { mesh?: string }): void {
  const mesh = meshOf(values);
  if (process.platform === "linux") {
    assertSystemdUser();
    const unit = systemdUnitName(mesh);
    const path = join(systemdUserDir(), unit);
    if (!existsSync(path))
      throw new Error(`no service unit for mesh "${mesh}" at ${path} - nothing installed by \`cotal service install\``);
    const fields = readUnitFields(path, "# cotal-mesh:", "# cotal-root:");
    if (!fields.marked)
      throw new Error(`${path} was not written by \`cotal service install\` (no provenance header) - this command refuses to remove operator-managed units`);
    const stopped = systemctl(["disable", "--now", unit]);
    if (stopped.status !== 0) throw new Error(`disabling ${unit} failed: ${stopped.output}`);
    rmSync(path);
    systemctl(["daemon-reload"]);
    systemctl(["reset-failed", unit]);
    const lingerOn = run("loginctl", ["show-user", String(process.getuid?.() ?? ""), "--property=Linger", "--value"]).output.trim() === "yes";
    console.log(c.green(`✓ service removed: ${unit}`));
    if (lingerOn) console.log(c.dim(`• lingering is still enabled for this user - turn it off with \`loginctl disable-linger\` if you no longer want it`));
    return;
  }
  if (process.platform === "darwin") {
    assertLaunchd();
    const label = launchdLabel(mesh);
    const path = join(launchAgentsDir(), `${label}.plist`);
    if (!existsSync(path))
      throw new Error(`no launchd agent for mesh "${mesh}" at ${path} - nothing installed by \`cotal service install\``);
    const fields = readUnitFields(path, "<!-- cotal-mesh:", "<!-- cotal-root:");
    if (!fields.marked)
      throw new Error(`${path} was not written by \`cotal service install\` (no provenance header) - this command refuses to remove operator-managed units`);
    const unloaded = run("launchctl", ["unload", "-w", path]);
    if (unloaded.status !== 0) throw new Error(`unloading ${path} failed: ${unloaded.output}`);
    rmSync(path);
    console.log(c.green(`✓ service removed: ${label}`));
    return;
  }
  throw new Error(`\`cotal service\` is not supported on ${process.platform}`);
}

export function serviceComplete(argv: string[]): CompletionResult {
  if (argv.length <= 1) return { items: ["install", "status", "uninstall"].map((value) => ({ value })), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}
