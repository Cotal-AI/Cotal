import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { accessSync, constants, existsSync } from "node:fs";
import { arch, cpus, homedir, totalmem, userInfo } from "node:os";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import type { CompletionResult, ParsedArgs } from "@cotal-ai/core";
import { findMesh, spaceKey, spaceSegment } from "@cotal-ai/workspace";
import { describeManagerRecord, MANAGER_PID_PATH, managerRecordState, type ManagerRecord } from "../lib/manager-proc.js";
import { selfArgv } from "../lib/self-exec.js";
import { resolveRuntimeSpace } from "../lib/status.js";
import { c } from "../ui.js";

/**
 * `cotal service` — run the workstation's manager as a user service, so it survives logout
 * and reboot. On Linux that holds only while the user lingers, so install refuses without it.
 * The manager is the only daemon this installs; the broker and every other
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

/** The directory the RUNNING user manager searches for units. Resolved from the manager's own
 *  environment (`systemctl --user show-environment`), never from this process's env: a
 *  shell-only XDG/HOME override (or a sudo/su shell) would write the unit where no manager ever
 *  looks, producing a unit that can be written but never enabled. A REACHABLE systemctl that
 *  cannot reach the user bus is a hard refusal, not a fallback: guessing a directory in that
 *  state would report an install status about a unit no manager could ever load. */
function userUnitDir(): string {
  const env = systemctl(["show-environment"]);
  if (env.status === 0) {
    const vars = new Map(env.output.split("\n").map((l) => {
      const i = l.indexOf("=");
      return i < 0 ? [l, ""] : [l.slice(0, i), l.slice(i + 1).trim()];
    }));
    const xdg = vars.get("XDG_CONFIG_HOME");
    if (xdg) return join(xdg, "systemd", "user");
    const home = vars.get("HOME");
    if (home) return join(home, ".config", "systemd", "user");
    throw new Error(`the systemd user manager reported no XDG_CONFIG_HOME and no HOME in its environment - cannot determine the user unit directory`);
  }
  throw new Error(`the systemd user session is not reachable (\`systemctl --user show-environment\` -> ${env.output || "no output"}) - cannot determine the user unit directory`);
}

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

/** Make a path safe as the value of a systemd unit setting. systemd expands `%` specifiers
 *  (`%h`, `%n`, …) in EVERY value it reads from a unit, including `WorkingDirectory`,
 *  `EnvironmentFile=` paths and `ExecStart=` arguments; an unescaped `%` is a silent rewrite of
 *  the path (a root named `root%name` becomes `root<unit-name>`, the unit fails at CHDIR with
 *  status 200 while install reported success). `%%` is the literal-percent escape systemd
 *  defines for unit setting values (verified on this host for mid-string and trailing `%`).
 *  Only `%` is touched: this is the specifier escape, not shell quoting. */
const escapeSystemdSpecifiers = (value: string): string => value.replaceAll("%", "%%");

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
    // The operating system, not the hostname: a hostname names a network node (on cloud hosts it
    // is infrastructure metadata), it is not OS information, and publishing it in a status feed
    // leaks deployment details that nothing here needs.
    os: process.platform,
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

type ServiceStatus =
  | { installed: false; mesh: string }
  | {
      installed: true;
      mesh: string;
      root: string;
      unit: { name: string; state: string; enabled: boolean | "unknown" };
      manager: ManagerRecord;
      linger?: boolean | { error: string };
    };

/** systemd state for one unit: `inactive`/`not-found` handled without throwing. */
function systemdUnitStatus(unit: string): { state: string; enabled: boolean | "unknown" } {
  const active = systemctl(["is-active", unit]);
  const state = active.status === 0 ? active.output : active.output || "inactive";
  const enabledProbe = systemctl(["is-enabled", unit]);
  const enabled = enabledProbe.status === 0 ? true : /disabled/.test(enabledProbe.output) ? false : "unknown";
  return { state: state === "not-found" ? "not-found" : state, enabled };
}

/** A unit file's comment syntax. The provenance header is written and read through the same one,
 *  so a field reads back without the delimiters the writer wrapped it in. */
interface CommentSyntax { open: string; close: string }
const SYSTEMD_COMMENT: CommentSyntax = { open: "# ", close: "" };
const LAUNCHD_COMMENT: CommentSyntax = { open: "<!-- ", close: " -->" };

const comment = (syntax: CommentSyntax, text: string): string => `${syntax.open}${text}${syntax.close}`;

const provenanceHeader = (syntax: CommentSyntax, mesh: string, root: string): string[] =>
  [MARKER, `cotal-mesh: ${mesh}`, `cotal-root: ${root}`].map((text) => comment(syntax, text));

/** Read the provenance fields a unit/plist carries. The marker must be a WHOLE LINE at the
 *  very start of the file, exactly as this command writes it: a substring anywhere else (a
 *  Description= that quotes the phrase, a comment mid-file) is how an operator-written unit
 *  comes to look owned, and looking owned is what uninstall keys on. */
function readUnitFields(path: string, syntax: CommentSyntax): { mesh?: string; root?: string; marked: boolean } {
  const lines = readFileSync(path, "utf8").split("\n");
  const field = (name: string): string | undefined => {
    const open = `${syntax.open}${name}: `;
    const line = lines.find((l) => l.startsWith(open) && l.endsWith(syntax.close));
    return line?.slice(open.length, line.length - syntax.close.length);
  };
  return { mesh: field("cotal-mesh"), root: field("cotal-root"), marked: lines[0] === comment(syntax, MARKER) };
}

/** The mesh and root an installed unit records, for `status`. Both are REQUIRED, never
 *  synthesized: a unit with no recorded mesh is not provably this command's, so status does not
 *  present one as its own, and a unit with no absolute recorded root names no pidfile to judge
 *  its manager by (a blank or relative one resolves against the caller's directory, which may
 *  belong to another mesh). */
function recordedService(path: string, fields: { mesh?: string; root?: string }): { mesh: string; root: string } {
  if (!fields.mesh)
    throw new Error(`${path} carries no recorded mesh - it was not written by \`cotal service install\`; reinstall it under the mesh it should serve before removing or reading it as a service`);
  if (!fields.root || !isAbsolute(fields.root))
    throw new Error(`${path} records mesh "${fields.mesh}" but no absolute root, so its manager cannot be read - remove it with \`cotal service uninstall --mesh ${fields.mesh}\` and install it again`);
  return { mesh: fields.mesh, root: fields.root };
}

export async function service(args: ParsedArgs): Promise<void> {
  const [sub, ...rest] = args.positionals;
  const values = args.values as { mesh?: string; linger?: boolean; json?: boolean };
  // A mesh name becomes a filename and an environment value; a newline breaks both (a split unit
  // record, a two-line EnvironmentFile entry). Refuse rather than encode.
  if (values.mesh !== undefined && /[\r\n]/.test(values.mesh))
    throw new Error(`--mesh must be a single-line name (contains a line break)`);
  if (sub === "install") {
    if (rest.length) throw new Error("usage: cotal service install [--mesh <name>] [--linger]");
    if (values.json) throw new Error("--json is for `service status`");
    return install(values);
  }
  if (sub === "status") {
    if (rest.length) throw new Error("usage: cotal service status [--mesh <name>] [--json]");
    if (values.linger) throw new Error("--linger is for `service install`");
    return status(values);
  }
  if (sub === "uninstall") {
    if (rest.length) throw new Error("usage: cotal service uninstall [--mesh <name>]");
    if (values.json) throw new Error("--json is for `service status`");
    if (values.linger) throw new Error("--linger is for `service install`");
    return uninstall(values);
  }
  throw new Error("usage: cotal service <install [--mesh <name>] [--linger] | status [--mesh <name>] [--json] | uninstall [--mesh <name>]>");
}

/** The per-install private state root: `<unit dir>/cotal-service/<spaceKey>/`. A private
 *  COTAL_HOME keeps the service manager off the login user's `~/.cotal` (mesh registry, current
 *  pointer, onboard marker resolve under it), and XDG_CONFIG_HOME under the same directory keeps
 *  the pre-seeded connector store beside it. */
const serviceStateDir = (unitDir: string, mesh: string): string => join(unitDir, "cotal-service", spaceKey(mesh));

/** The 0600 EnvironmentFile the systemd unit loads: per-mesh facts never ride ExecStart argv
 *  (command lines are a publication surface on a multi-user host). */
const envFileName = (mesh: string): string => `cotal-manager@${spaceKey(mesh)}.env`;

/** The installing shell's PATH, which the unit pins. A service manager hands its units its own
 *  PATH (the systemd user manager's `/usr/local/bin:/usr/bin`, launchd's `/usr/bin:/bin`), which
 *  lacks `~/.local/bin` and Homebrew, so an inherited PATH boots a manager that reports a harness
 *  unavailable even though the operator's shell resolves it. An entry that is not absolute (an
 *  empty one means the current directory) is resolved against this shell's cwd, because the unit
 *  starts in the mesh root, where the same spelling names another directory. An entry with a `..`
 *  segment is pinned as the directory it reaches now, symlinks followed: the shell's lookup steps
 *  up from a symlink's target, a lexical resolve from its name. A PATH set to the empty string is
 *  one empty entry. Refused rather than guessed when unset, when a `..` entry reaches no
 *  directory, when a resolved entry contains the separator, and when it holds a line break the
 *  env file and plist cannot carry. */
function installerPath(): string {
  const raw = process.env.PATH;
  if (raw === undefined) throw new Error("PATH is not set - `cotal service install` pins this shell's PATH into the unit so the manager resolves the same harness binaries");
  const dirs = raw.split(delimiter).map((dir) => {
    if (isAbsolute(dir)) return dir;
    if (!dir.split(sep).includes("..")) return resolve(dir);
    try {
      // `.native` is libc realpath(3), which walks like the kernel; the JS one collapses `..` first.
      return realpathSync.native(dir);
    } catch {
      throw new Error(`PATH entry "${dir}" has a ".." segment and reaches no directory from here - make it absolute or remove it`);
    }
  });
  if (dirs.some((dir) => dir.includes(delimiter))) throw new Error(`PATH has a relative entry that resolves to a directory containing "${delimiter}" - run install from another directory or make the entry absolute`);
  const pinned = dirs.join(delimiter);
  if (/[\r\n]/.test(pinned)) throw new Error("PATH contains a line break - it cannot be pinned into the unit's environment");
  return pinned;
}

/** The manager's environment in the unit. Both arms render this one list (systemd into the
 *  EnvironmentFile, launchd into the plist's EnvironmentVariables), so a variable cannot reach
 *  one platform's unit and miss the other's. */
function unitEnv(mesh: string, server: string, stateDir: string, pathEnv: string): [name: string, value: string][] {
  return [
    ["PATH", pathEnv],
    ["COTAL_SPACE", mesh],
    // The REGISTERED server, never a default: a mesh on a non-default port would otherwise boot
    // its unit into a permanent crash loop on the supervise target mismatch.
    ["COTAL_SERVER", server],
    ["COTAL_HOME", stateDir],
    ["XDG_CONFIG_HOME", join(stateDir, "config")],
    // Seeding ran synchronously in the installer; the unit must never start a lazy seed (a
    // manager stopped mid-seed leaves a crash cursor every later manager refuses on).
    ["COTAL_SKIP_CONNECTOR_SEED", "1"],
  ];
}

function writeEnvFile(mesh: string, server: string, stateDir: string, pathEnv: string): string {
  const path = join(stateDir, envFileName(mesh));
  const body = [
    `# ${MARKER}`,
    // Double-quoted with `"` `\` `` ` `` `$` escaped, the only characters systemd unescapes inside
    // double quotes (it does no `$VAR` expansion here), so any value reaches the manager verbatim.
    ...unitEnv(mesh, server, stateDir, pathEnv).map(([name, value]) => `${name}="${value.replace(/["\\`$]/g, "\\$&")}"`),
    ``,
  ].join("\n");
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Seed connectors SYNCHRONOUSLY into the service's private config root, exactly the way the
 *  boot gate does, before the unit is enabled. A failure refuses the install: a deferred seed
 *  is how a service manager ends up running lazy seeding under supervision. */
function preseedService(stateDir: string): void {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(stateDir, "config"),
    COTAL_HOME: stateDir,
    // A source-checkout writer is normally refused so it cannot migrate the operator-global
    // store; here the target IS the private store this installer just created, which is the
    // sandboxed case the opt-in names.
    COTAL_ALLOW_CHECKOUT_SEED: "1",
  };
  const [node, ...entry] = selfArgv();
  const r = spawnSync(node, [...entry, "ext", "seed"], { encoding: "utf8", env, timeout: 10 * 60_000 });
  if (r.status !== 0)
    throw new Error(`connector pre-seed failed (a service unit must not start a lazy seed; a stopped seed leaves a crash cursor later managers refuse on): ${(r.stdout ?? "")}${r.stderr ?? ""}`.trim());
  console.log(c.dim(`• connectors pre-seeded under ${join(stateDir, "config")}`));
}

/** Copy the mesh's registry entry into the service's private COTAL_HOME so the supervised
 *  manager resolves the mesh exactly as an operator session would. Without the snapshot a
 *  private home is an empty registry, and `supervise` would refuse the space as unknown no
 *  matter what the EnvironmentFile says. Only the named mesh's entry is copied, never the
 *  whole registry (other meshes are not this unit's business). VALIDATES FIRST and writes
 *  nothing on a miss: the caller has not materialized any state yet, and an absent mesh must
 *  refuse before a 20-second pre-seed leaves a directory uninstall cannot name. */
function snapshotMeshEntry(mesh: string, stateDir: string): void {
  const entry = findMesh(mesh);
  if (!entry)
    throw new Error(`no mesh named "${mesh}" is registered - bring it up (\`cotal up\`) or register it (\`cotal meshes add\`) before \`cotal service install\``);
  const dir = join(stateDir, "meshes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${spaceSegment(mesh)}.json`), JSON.stringify(entry, null, 2));
}

function install(values: { mesh?: string; linger?: boolean }): void {
  const mesh = meshOf(values);
  // The REGISTERED mesh's root and server, not this process's cwd: `--mesh` is legal from any
  // directory, and a unit bound to whatever folder the operator stood in would write pidfiles
  // and logs into a root that is not the mesh's. findMesh is the validation gate; an unregistered
  // mesh refuses HERE, before any state is materialized.
  const entry = findMesh(mesh);
  if (!entry)
    throw new Error(`no mesh named "${mesh}" is registered - bring it up (\`cotal up\`) or register it (\`cotal meshes add\`) before \`cotal service install\``);
  const root = entry.root;
  const server = entry.server;
  // Before the incumbent check: an operator told to stop their manager first should not then be
  // refused for lingering and left with no manager at all.
  if (process.platform === "linux") requireLinger(values);
  // The manager is a singleton per space. Installing over a live one (typically `up --detach`'s)
  // would put the unit in a crash-restart loop against a lease it can never take, so refuse with
  // the exact remedy before anything is written.
  const incumbent = managerRecordState(undefined, undefined, mesh, root);
  if (incumbent.state === "alive")
    throw new Error(`a manager for mesh "${mesh}" is already running (pid ${incumbent.pid}, started by \`cotal up\` or by hand) - stop it first: \`cotal down manager\``);
  if (incumbent.state === "unknown" || incumbent.state === "unattributable")
    throw new Error(`the recorded manager for mesh "${mesh}" cannot be attributed (${incumbent.state}) - resolve \`${MANAGER_PID_PATH(mesh, root)}\` before installing the service`);
  // BEFORE anything is written: a re-exec that silently does not happen would report a
  // healthy service over nothing, so the argv is proven here, not at unit start. The mesh
  // facts do NOT ride this argv (see unitEnv).
  const exec = [...selfArgv(), "supervise"];
  const pathEnv = installerPath();
  if (process.platform === "linux") {
    assertSystemdUser();
    const unit = systemdUnitName(mesh);
    const dir = userUnitDir();
    const path = join(dir, unit);
    const stateDir = serviceStateDir(dir, mesh);
    // Validate FIRST, materialize after: an unregistered mesh (or a failed pre-seed) must not
    // leave a state directory that no unit file names, because uninstall works from the unit.
    snapshotMeshEntry(mesh, stateDir);
    preseedService(stateDir);
    const envFile = writeEnvFile(mesh, server, stateDir, pathEnv);
    const body = [
      ...provenanceHeader(SYSTEMD_COMMENT, mesh, root),
      `# Restart=always/20s: measured for manager units in production - a manager exits`
      + ` for reasons that are not failures (broker restarts, host suspend), so on-failure/5s`
      + ` thrashes while always/20s converges.`,
      `# StartLimit 20 starts per 30min: a manager that cannot start (a precondition only an operator`
      + ` can fix) stops after 20 attempts, about seven minutes at 20s apart, instead of restarting forever.`,
      `[Unit]`,
      `Description=Cotal manager for mesh ${mesh}`,
      `StartLimitIntervalSec=30min`,
      `StartLimitBurst=20`,
      ``,
      `[Service]`,
      `Type=simple`,
      // Every value below is a path systemd will re-read: specifiers must be escaped or the
      // unit fails at CHDIR/EXEC with status 200 over a path systemd itself rewrote.
      `WorkingDirectory=${escapeSystemdSpecifiers(root)}`,
      `EnvironmentFile=${escapeSystemdSpecifiers(envFile)}`,
      `ExecStart=${exec.map((t) => escapeSystemdSpecifiers(t.includes(" ") ? JSON.stringify(t) : t)).join(" ")}`,
      `Restart=always`,
      `RestartSec=20s`,
      ``,
      `[Install]`,
      `WantedBy=default.target`,
      ``,
    ].join("\n");
    mkdirSync(dir, { recursive: true });
    if (existsSync(path) && !readUnitFields(path, SYSTEMD_COMMENT).marked)
      throw new Error(`${path} already exists and was not written by \`cotal service install\` - remove it by hand if you want this command to own it`);
    writeFileSync(path, body);
    systemctl(["daemon-reload"]);
    const started = systemctl(["enable", "--now", unit]);
    if (started.status !== 0) throw new Error(`enabling ${unit} failed: ${started.output}`);
    console.log(c.green(`✓ service installed: ${unit}`) + c.dim(` - manager for mesh "${mesh}" under ${root} (env ${envFile})`));
    return;
  }
  if (process.platform === "darwin") {
    assertLaunchd();
    const label = launchdLabel(mesh);
    const dir = launchAgentsDir();
    const path = join(dir, `${label}.plist`);
    const stateDir = serviceStateDir(dir, mesh);
    // Same validate-first rule as the Linux arm.
    snapshotMeshEntry(mesh, stateDir);
    preseedService(stateDir);
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const body = [
      ...provenanceHeader(LAUNCHD_COMMENT, mesh, root),
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<plist version="1.0">`,
      `<dict>`,
      `  <key>Label</key><string>${label}</string>`,
      `  <key>ProgramArguments</key>`,
      `  <array>`,
      ...exec.map((t) => `    <string>${esc(t)}</string>`),
      `  </array>`,
      `  <key>WorkingDirectory</key><string>${esc(root)}</string>`,
      `  <key>EnvironmentVariables</key>`,
      `<dict>`,
      ...unitEnv(mesh, server, stateDir, pathEnv).map(([name, value]) => `    <key>${name}</key><string>${esc(value)}</string>`),
      `</dict>`,
      `  <key>RunAtLoad</key><true/>`,
      `  <key>KeepAlive</key><true/>`,
      `  <key>ThrottleInterval</key><integer>20</integer>`,
      `</dict>`,
      `</plist>`,
      ``,
    ].join("\n");
    mkdirSync(dir, { recursive: true });
    if (existsSync(path) && !readUnitFields(path, LAUNCHD_COMMENT).marked)
      throw new Error(`${path} already exists and was not written by \`cotal service install\` - remove it by hand if you want this command to own it`);
    writeFileSync(path, body);
    const loaded = run("launchctl", ["load", "-w", path]);
    if (loaded.status !== 0) throw new Error(`loading ${path} failed: ${loaded.output}`);
    console.log(c.green(`✓ service installed: ${label}`) + c.dim(` - manager for mesh "${mesh}" under ${root}`));
    return;
  }
  throw new Error(`\`cotal service\` is not supported on ${process.platform} - it needs systemd user units (Linux) or launchd agents (macOS)`);
}

/** Whether logind keeps this user's manager running without a session (lingering). Only a
 *  query that exits 0 and prints `yes` or `no` is an answer. Anything else (logind unreachable,
 *  no loginctl, other output) comes back as its error, because a Linger that could not be read
 *  is not "off". */
function readLinger(): boolean | { error: string } {
  const q = run("loginctl", ["show-user", String(process.getuid?.() ?? ""), "--property=Linger", "--value"]);
  if (q.status === 0 && (q.output === "yes" || q.output === "no")) return q.output === "yes";
  const how = q.status !== null ? `exited ${q.status}: ${q.output || "no output"}`
    : q.output ? `did not finish: ${q.output}` : "could not run (is loginctl installed?)";
  return { error: `\`loginctl show-user --property=Linger\` ${how}` };
}

/** The root command that enables lingering. logind can refuse an unprivileged enable-linger
 *  (`Access denied` over SSH), so this is printed for the operator; nothing here runs sudo. */
const lingerRemedy = (): string => `sudo loginctl enable-linger ${userInfo().username}`;

/** Without lingering systemd starts no user manager at boot and stops it at the user's last
 *  logout, so an enabled user unit is inert at boot: installing one would report a service the
 *  next reboot silently loses. Refuse BEFORE anything is written, with the root command that
 *  fixes it. `--linger` asks logind first; lingering is never enabled silently. */
function requireLinger(values: { linger?: boolean }): void {
  const linger = readLinger();
  if (typeof linger === "object")
    throw new Error(`could not read whether this user lingers, so install cannot confirm the service would start at boot: ${linger.error} - make that query answer, then re-run this install`);
  if (linger) {
    console.log(c.dim(`• lingering is enabled for this user - the user manager starts at boot`));
    return;
  }
  if (values.linger) {
    const on = run("loginctl", ["enable-linger", String(process.getuid?.() ?? "")]);
    if (on.status === 0) {
      console.log(c.dim(`• lingering enabled - the user manager now starts at boot`));
      return;
    }
    throw new Error(`\`loginctl enable-linger\` was refused (${on.output || "no output"}), so the service would not be boot-persistent - enable lingering as root with \`${lingerRemedy()}\`, then re-run this install`);
  }
  throw new Error(`lingering is off for this user, so the service would not be boot-persistent: systemd starts no user manager at boot, and the last logout stops it - enable lingering as root with \`${lingerRemedy()}\` (or pass --linger), then re-run this install`);
}

function readStatus(values: { mesh?: string }): ServiceStatus {
  const mesh = meshOf(values);
  const out: ServiceStatus = { installed: false, mesh };
  if (process.platform === "linux") {
    const unit = systemdUnitName(mesh);
    const path = join(userUnitDir(), unit);
    if (!existsSync(path)) return out;
    const recorded = recordedService(path, readUnitFields(path, SYSTEMD_COMMENT));
    const state = systemdUnitStatus(unit);
    return {
      installed: true,
      ...recorded,
      unit: { name: unit, state: state.state, enabled: state.enabled },
      manager: managerRecordState(undefined, undefined, recorded.mesh, recorded.root),
      linger: readLinger(),
    };
  }
  if (process.platform === "darwin") {
    const label = launchdLabel(mesh);
    const path = join(launchAgentsDir(), `${label}.plist`);
    if (!existsSync(path)) return out;
    const recorded = recordedService(path, readUnitFields(path, LAUNCHD_COMMENT));
    const listed = run("launchctl", ["list", label]);
    const pid = Number(listed.output.split("\t")[0]);
    return {
      installed: true,
      ...recorded,
      unit: { name: label, state: listed.status === 0 ? (Number.isInteger(pid) && pid > 0 ? "running" : "loaded") : "not-loaded", enabled: listed.status === 0 },
      manager: managerRecordState(undefined, undefined, recorded.mesh, recorded.root),
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
    const unit = s.unit;
    console.log(`  ${"unit".padEnd(16)} ${unit.name}`);
    console.log(`  ${"unit state".padEnd(16)} ${unit.state === "active" ? c.green(unit.state) : c.yellow(unit.state)}`);
    console.log(`  ${"enabled".padEnd(16)} ${unit.enabled === true ? c.green("yes") : unit.enabled === false ? c.red("no") : c.dim("unknown")}`);
    console.log(`  ${"root".padEnd(16)} ${s.root}`);
    const mgr = s.manager;
    console.log(`  ${"manager".padEnd(16)} ${mgr.state === "alive" ? c.green(`running (pid ${mgr.pid})`) : c.yellow(describeManagerRecord(mgr))}`);
    if (s.linger !== undefined) console.log(`  ${"linger".padEnd(16)} ${s.linger === true ? c.green("enabled") : s.linger === false ? c.yellow(`disabled - not boot-persistent; enable as root: ${lingerRemedy()}`) : c.yellow(`unknown - ${s.linger.error}`)}`);
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
    const dir = userUnitDir();
    const path = join(dir, unit);
    if (!existsSync(path))
      throw new Error(`no service unit for mesh "${mesh}" at ${path} - nothing installed by \`cotal service install\``);
    const fields = readUnitFields(path, SYSTEMD_COMMENT);
    if (!fields.marked)
      throw new Error(`${path} was not written by \`cotal service install\` (no provenance header) - this command refuses to remove operator-managed units`);
    // Provenance keys on the marker PLUS a recorded mesh equal to the one named, never the unit
    // name alone and never a substitution: a unit whose recorded mesh is MISSING is not
    // provably this command's (the marker line is two lines of text anyone can write), so it is
    // a hard refusal, the same rule `status` applies. The mesh is the identity an explicit
    // `--mesh` pins, so uninstall works from any directory: the unit's own records name the root
    // it serves, and a cwd-walked root here would refuse the very remedy this command's errors
    // hand out. A mesh mismatch is still a hard refusal.
    if (!fields.mesh)
      throw new Error(`${path} carries no recorded mesh - it was not written by \`cotal service install\` (the marker alone is not ownership); this command refuses to remove it`);
    if (fields.mesh !== mesh)
      throw new Error(`${path} was installed for mesh "${fields.mesh}", not "${mesh}" - uninstall the unit under its own mesh name: \`cotal service uninstall --mesh ${fields.mesh}\``);
    const stopped = systemctl(["disable", "--now", unit]);
    if (stopped.status !== 0) throw new Error(`disabling ${unit} failed: ${stopped.output}`);
    rmSync(path);
    rmSync(serviceStateDir(dir, fields.mesh), { recursive: true, force: true });
    systemctl(["daemon-reload"]);
    systemctl(["reset-failed", unit]);
    console.log(c.green(`✓ service removed: ${unit}`));
    if (readLinger() === true) console.log(c.dim(`• lingering is still enabled for this user - turn it off with \`loginctl disable-linger\` if you no longer want it`));
    return;
  }
  if (process.platform === "darwin") {
    assertLaunchd();
    const label = launchdLabel(mesh);
    const dir = launchAgentsDir();
    const path = join(dir, `${label}.plist`);
    if (!existsSync(path))
      throw new Error(`no launchd agent for mesh "${mesh}" at ${path} - nothing installed by \`cotal service install\``);
    const fields = readUnitFields(path, LAUNCHD_COMMENT);
    if (!fields.marked)
      throw new Error(`${path} was not written by \`cotal service install\` (no provenance header) - this command refuses to remove operator-managed units`);
    // Same mesh-pinned provenance rule as the Linux arm: the recorded mesh must be present and
    // equal; a missing record is a refusal, not a substitution.
    if (!fields.mesh)
      throw new Error(`${path} carries no recorded mesh - it was not written by \`cotal service install\` (the marker alone is not ownership); this command refuses to remove it`);
    if (fields.mesh !== mesh)
      throw new Error(`${path} was installed for mesh "${fields.mesh}", not "${mesh}" - uninstall the unit under its own mesh name: \`cotal service uninstall --mesh ${fields.mesh}\``);
    const unloaded = run("launchctl", ["unload", "-w", path]);
    if (unloaded.status !== 0) throw new Error(`unloading ${path} failed: ${unloaded.output}`);
    rmSync(path);
    rmSync(serviceStateDir(dir, fields.mesh), { recursive: true, force: true });
    console.log(c.green(`✓ service removed: ${label}`));
    return;
  }
  throw new Error(`\`cotal service\` is not supported on ${process.platform}`);
}

export function serviceComplete(argv: string[]): CompletionResult {
  if (argv.length <= 1) return { items: ["install", "status", "uninstall"].map((value) => ({ value })), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}
