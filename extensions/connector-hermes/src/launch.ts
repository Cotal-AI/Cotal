/**
 * Hermes launcher / supervisor — the `hermes` connector's command (run from source via tsx).
 *
 * Hermes is a long-lived gateway daemon that creates a fresh `AIAgent` per inbound message, so the
 * mesh endpoint must outlive every turn — it can't ride inside a per-turn MCP server the way it
 * does for Claude Code / Codex. This process OWNS the single {@link MeshAgent} (via the shared
 * {@link startSidecar}) and supervises `hermes gateway run` as its child:
 *
 *   - connector-core **control socket** ← Python presence hooks (relay.ts pattern) → presence
 *   - **bridge socket** ⇄ Python gateway adapter + cotal_* tools (inbound wake/drive, outbound)
 *   - **tools file** → the cotal_* descriptors the plugin registers at load
 *   - an isolated **HERMES_HOME** profile so the operator's own ~/.hermes is never touched, unless
 *     the operator opts in with COTAL_HERMES_ADOPT_HOME to put their OWN Hermes on the mesh
 *
 * The manager runs this in a PTY; stdio is inherited so the gateway's output is what you attach to.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, cpSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { LAUNCH_MATERIAL_ENV, discardLaunchMaterial, loadAgentFile, readLaunchMaterial, writeLaunchMaterial } from "@cotal-ai/core";
import { hasIdentity, configFromEnv, controlEndpoint, SUN_PATH_MAX_BYTES, ORIENTATION_BOOTSTRAP, MESH_FIRST_STEER, WORKFLOW_STEER } from "@cotal-ai/connector-core";
import { hermesUvCommand, spawnHermesGateway } from "./binary.js";
import { startSidecar } from "./sidecar.js";
import { HERMES_FORK_RECORD, hermesSeatHome } from "./seat-home.js";

/** Hermes API range this connector is written against (keep in sync with pyproject.toml).
 *
 *  A RANGE rather than a single line, with both ends load-bearing:
 *
 *  FLOOR 0.18. `BasePlatformAdapter.connect` gained a keyword-only `is_reconnect` at 0.18.0
 *  (tag v2026.7.1) and the gateway passes it at every call site from that version on. The
 *  adapter in plugin/cotal/adapter.py accepts it, so it can no longer be driven by a 0.16/0.17
 *  gateway the way it was written for: those call `connect()` positionally with no keyword, which
 *  still binds, but nothing below 0.18 supplies the reconnect signal the adapter now acts on.
 *  Below the floor the connector is untested rather than merely older, so it is refused.
 *
 *  CEILING 0.22 (exclusive). Everything through 0.21.x is verified compatible on the surfaces
 *  this connector binds: the four gateway.platforms.base imports resolve, Platform and
 *  PlatformConfig are unchanged, all five registered hooks are still in VALID_HOOKS, and
 *  register_platform / register_tool / register_hook keep their signatures. 0.22 does not exist
 *  yet, so admitting it would be a claim about code nobody has read.
 *
 *  Refusing outside the range is deliberate: a silent degrade here surfaces as a TypeError at
 *  platform connect, after a clean-looking plugin load. */
const HERMES_MIN = "0.18";
const HERMES_MAX_EXCLUSIVE = "0.22";

/** This package's root (where pyproject.toml + plugin/ live), resolved from this source file. */
const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_SRC = join(PKG_DIR, "plugin", "cotal");

/** How long a managed gateway may drain after SIGTERM before it is killed. The runtime that stops
 *  this launcher SIGKILLs it 3s after its own SIGTERM, and the managed root can only be removed
 *  once the gateway has exited, so the drain must end with room to spare inside that window. */
const GATEWAY_DRAIN_MS = 1_500;

/** `pid` and every process below it. The gateway runs as `uv` over the Hermes python process, and
 *  uv cannot forward a SIGKILL, so killing the gateway means killing the tree. */
function processTree(pid: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || parent === undefined) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const tree = [pid];
  for (let i = 0; i < tree.length; i++) tree.push(...(children.get(tree[i]) ?? []));
  return tree;
}

/** The bridge socket's path id is unpredictable, unlike the control endpoint's: `id` folds in the
 *  launch's own control token alongside space/name/pid, so a same-uid process cannot compute the
 *  path from public identity the way the old `space`+`name` name let it. The token is what
 *  authenticates the socket (see bridge.ts); the path merely stops it being guessed at a glance. */
function bridgeSocketPath(space: string, name: string, token: string): string {
  const id = createHash("sha256")
    .update(`${space}\0${name}\0${process.pid}\0${token}\0bridge`)
    .digest("base64url")
    .slice(0, 32);
  const path = join(tmpdir(), `cotal-hermes-bridge-${id}.sock`);
  const bytes = Buffer.byteLength(path);
  if (bytes > SUN_PATH_MAX_BYTES) {
    const tail = `/cotal-hermes-bridge-${id}.sock`.length;
    throw new Error(
      `bridge socket path is ${bytes} bytes, over the ${SUN_PATH_MAX_BYTES}-byte sun_path limit on ` +
        `${process.platform}, so it cannot be bound and the kernel would report only EINVAL: ${path}. ` +
        `The socket name is a fixed ${tail} bytes, so the temp root must be at most ` +
        `${SUN_PATH_MAX_BYTES - tail} bytes — TMPDIR is ${Buffer.byteLength(tmpdir())} bytes ` +
        `(${tmpdir()}). Point TMPDIR at a shorter directory.`,
    );
  }
  return path;
}

function log(msg: string): void {
  process.stderr.write(`[cotal-hermes] ${msg}\n`);
}

/** A launch this connector refuses on what it was given. The message is the whole diagnosis, so
 *  it is printed without a stack: a stack names lines in a bundle and points the operator at
 *  this code, when what they need to change is their own invocation. */
export class LaunchRefused extends Error {}

/** A double-quoted YAML basic-string literal (escaped). */
const yamlStr = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Build the isolated Hermes profile (HERMES_HOME) so the operator's ~/.hermes is never touched.
 * Drops the cotal plugin into the profile's plugins dir, enables it + the cotal platform, and
 * turns approvals off (an autonomous spawned gateway has no human at the TUI to approve commands).
 */
export function setupProfile(home: string, opts: { model: string | undefined; persona?: string }): void {
  // A managed profile is a temporary directory and reads nothing from ~/.hermes, so the model the
  // operator configured there is not a model this gateway has. With none resolved here, hermes
  // would pick a default of its own over a provider this profile may hold no key for, and that is
  // the one degradation the launch cannot see: the seat still joins the mesh and still accepts a
  // turn, and the first sign is a provider refusal mid-turn whose advice points at the operator's
  // credentials. Refuse before anything is written, so a refused launch leaves no directory a
  // later spawn could take for a working profile.
  if (!opts.model)
    throw new LaunchRefused(
      "a managed Hermes profile does not read ~/.hermes, and no model was resolved for it — " +
        `set one with --model, the agent file's model:, or HERMES_MODEL, or run the gateway on your own profile with ${ADOPT_HOME_ENV}=$HOME/.hermes`,
    );
  mkdirSync(home, { recursive: true });
  const pluginDst = join(home, "plugins", "cotal");
  rmSync(pluginDst, { recursive: true, force: true });
  mkdirSync(join(home, "plugins"), { recursive: true });
  cpSync(PLUGIN_SRC, pluginDst, { recursive: true });

  const lines = [
    "# Cotal-managed Hermes profile — regenerated each launch; do not edit.",
    "plugins:",
    "  enabled: [cotal]",
    "gateway:",
    "  platforms:",
    "    cotal:",
    "      enabled: true",
    "approvals:",
    "  mode: off",
  ];
  lines.push(`model: ${yamlStr(opts.model)}`);
  writeFileSync(join(home, "config.yaml"), lines.join("\n") + "\n");

  // Persona → SOUL.md (Hermes' identity file) — the one place a system prompt can be set. Append the
  // orientation bootstrap so the agent orients first; gated on persona so we don't clobber the default SOUL.
  if (opts.persona)
    writeFileSync(join(home, "SOUL.md"), `${opts.persona.trim()}\n\n${ORIENTATION_BOOTSTRAP}\n\n${MESH_FIRST_STEER}\n\n${WORKFLOW_STEER}\n`);
}

/** A major.minor as a sortable pair, or null when the string is not one. Compared numerically,
 *  because a string compare puts "0.9" above "0.18" and would admit the versions the floor exists
 *  to refuse. */
function parseLine(raw: string): [number, number] | null {
  const parts = raw.trim().split(".");
  if (parts.length < 2) return null;
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 0 || minor < 0) return null;
  return [major, minor];
}

const cmp = (a: [number, number], b: [number, number]): number => a[0] - b[0] || a[1] - b[1];

/** Opt-in: run the gateway in the operator's OWN Hermes profile instead of a disposable one.
 *  Set to the absolute path of the profile directory (`$HOME/.hermes`, or any HERMES_HOME). Unset
 *  means the managed default, which is what a spawned seat should almost always use. */
export const ADOPT_HOME_ENV = "COTAL_HERMES_ADOPT_HOME";

/** Resolve the adopt-home opt-in, or undefined for the managed default. A relative value is
 *  refused: it would resolve against whatever directory the launcher runs in, and a `~` no shell
 *  expanded would name a directory called `~` there, so the profile written to would depend on
 *  where the seat started. */
export function adoptedHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[ADOPT_HOME_ENV]?.trim();
  if (!raw) return undefined;
  if (!isAbsolute(raw))
    throw new LaunchRefused(`${ADOPT_HOME_ENV}=${raw} is not an absolute path — set it to the full path of your Hermes profile directory, e.g. ${ADOPT_HOME_ENV}=$HOME/.hermes`);
  return raw;
}

/**
 * Install the cotal plugin into an EXISTING Hermes profile, and change nothing else about it.
 *
 * Two needs are served by this connector and only one of them is served by the managed profile
 * above. A fresh disposable seat wants isolation. An operator who already has a working Hermes
 * wants THAT one on the mesh, with its configured credentials and integrations, because those
 * are the reason the seat is worth anything: a Hermes wired to a notification path can reach its
 * operator, and a temp HERMES_HOME cannot, since the integrations live in the real profile.
 *
 * What this writes is exactly one directory, `plugins/cotal`, which is this connector's own asset
 * and is refreshed each launch so a connector upgrade lands. What it deliberately does NOT write:
 *
 *   config.yaml  the managed path regenerates it wholesale and turns approvals off. Doing that to
 *                a real profile would discard the operator's model, platform and approval
 *                settings, and silently disable the approvals a human profile is entitled to.
 *   SOUL.md      the operator's own identity file. The managed path overwrites it with the
 *                persona; here that would destroy the agent the operator built.
 *
 * Because config.yaml is not written, enabling the plugin is the operator's decision and this
 * refuses rather than making it for them. That is the "no fallbacks" rule doing real work: a
 * silent enable would be a write to a human's configuration that they never asked for.
 */
export function setupAdoptedProfile(home: string, opts: { persona?: string }): void {
  if (!existsSync(home))
    throw new Error(`${ADOPT_HOME_ENV}=${home} does not exist — point it at an existing Hermes profile directory (usually ~/.hermes)`);
  if (!statSync(home).isDirectory())
    throw new Error(`${ADOPT_HOME_ENV}=${home} is not a directory`);

  // A persona is applied by overwriting SOUL.md, which this mode must not touch. Accepting one and
  // never applying it would leave the operator waiting on an identity that never took effect, so
  // it is refused the same way an unsubmittable initial prompt is.
  if (opts.persona)
    throw new Error(`${ADOPT_HOME_ENV} runs the operator's own profile, whose SOUL.md is not overwritten, so the agent file's persona cannot be applied — remove the persona from the agent file, or drop ${ADOPT_HOME_ENV} to use a managed profile`);

  const pluginDst = join(home, "plugins", "cotal");
  rmSync(pluginDst, { recursive: true, force: true });
  mkdirSync(join(home, "plugins"), { recursive: true });
  cpSync(PLUGIN_SRC, pluginDst, { recursive: true });

  // Verify the operator enabled us, and say precisely what to add when they have not. Reading the
  // file is not parsing it: this looks for the two things that must be true, and a profile whose
  // YAML says them in a shape this does not recognise gets a loud instruction rather than a
  // silent rewrite.
  const configPath = join(home, "config.yaml");
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const pluginEnabled = /^\s*enabled:.*\bcotal\b/m.test(config) || /^\s*-\s*cotal\s*$/m.test(config);
  const platformEnabled = /^\s*cotal:\s*$/m.test(config);
  if (!pluginEnabled || !platformEnabled)
    throw new Error(
      `${ADOPT_HOME_ENV}=${home} but its config.yaml does not enable the cotal plugin and platform, and this mode does not edit an operator's config. Add:\n` +
        "  plugins:\n    enabled: [cotal]\n  gateway:\n    platforms:\n      cotal:\n        enabled: true\n" +
        `(plugin files were installed at ${pluginDst})`,
    );
}

/** Assert the installed hermes-agent is within the supported API range, or throw. No silent
 *  degrade: a version outside it can shift the plugin/platform/hook contract this connector
 *  depends on, and the failure that produces lands at platform connect rather than at load. */
export function assertHermesVersion(opts: {
  env?: NodeJS.ProcessEnv;
  pkgDir?: string;
  execFileImpl?: (file: string, args: readonly string[], options: { encoding: "utf8" }) => string;
  logImpl?: (message: string) => void;
} = {}): void {
  let raw: string;
  try {
    const execFileImpl = opts.execFileImpl ?? ((file, args, options) => execFileSync(file, args, options));
    raw = execFileImpl(
      hermesUvCommand(opts.env),
      ["run", "--project", opts.pkgDir ?? PKG_DIR, "--quiet", "python", "-c", "from importlib.metadata import version; print(version('hermes-agent'))"],
      { encoding: "utf8" },
    ).trim();
  } catch (e) {
    throw new Error(`could not resolve the hermes-agent version via uv — is uv installed and hermes-agent available? (${(e as Error).message})`);
  }
  const supported = `>=${HERMES_MIN},<${HERMES_MAX_EXCLUSIVE}`;
  const line = parseLine(raw);
  // An unparseable version is refused rather than waved through: "the version could not be read"
  // must not be the one input that satisfies a guard whose whole job is refusing the unknown.
  if (line === null)
    throw new Error(`could not read a major.minor out of the hermes-agent version ${JSON.stringify(raw)} — this connector supports ${supported}`);
  if (cmp(line, parseLine(HERMES_MIN)!) < 0)
    throw new Error(`hermes-agent ${raw} is below the ${HERMES_MIN} floor this connector supports (${supported}) — the gateway only passes the is_reconnect signal the cotal adapter needs from ${HERMES_MIN} on; upgrade hermes-agent, or use a connector release pinned to the older line`);
  if (cmp(line, parseLine(HERMES_MAX_EXCLUSIVE)!) >= 0)
    throw new Error(`hermes-agent ${raw} is at or above the ${HERMES_MAX_EXCLUSIVE} ceiling this connector supports (${supported}) — the plugin/platform/hook contract has not been checked against it; update src/launch.ts + pyproject.toml together after verifying the surfaces in plugin/cotal/`);
  (opts.logImpl ?? log)(`hermes-agent ${raw} (supported range ${supported}) ✓`);
}

/** What {@link forkHermesSession} returns: the seat's fork and where it came from. */
export interface HermesFork {
  source: string;
  fork: string;
  title: string | null;
  messages: number;
  transcriptSha256: string;
  created: boolean;
}

/**
 * Fork Hermes session `source` from the operator's profile `sourceHome` into the seat's profile
 * `seatHome`, or return the fork the seat already owns. Runs plugin/cotal/resume.py under the
 * project-pinned Hermes, so the copy goes through Hermes' own session store: the source database is
 * opened read-only, and the fork is a new session the way the gateway's `/branch` makes one. A
 * session that cannot be found or read is a {@link LaunchRefused} naming it.
 */
export function forkHermesSession(opts: { sourceHome: string; source: string; seatHome: string; env?: NodeJS.ProcessEnv }): HermesFork {
  const env = opts.env ?? process.env;
  mkdirSync(opts.seatHome, { recursive: true });
  // `-P` keeps the plugin directory off sys.path: its tools.py would shadow Hermes' own `tools`.
  const r = spawnSync(
    hermesUvCommand(env),
    ["run", "--project", PKG_DIR, "--quiet", "python", "-P", join(PLUGIN_SRC, "resume.py"), "fork", opts.sourceHome, opts.source, opts.seatHome],
    { encoding: "utf8", env: { ...env, HERMES_HOME: opts.seatHome } },
  );
  if (r.error) throw new Error(`could not run the Hermes session fork via uv: ${r.error.message}`);
  if (r.status === 3) throw new LaunchRefused(r.stderr.trim());
  if (r.status !== 0) throw new Error(`the Hermes session fork failed (exit ${r.status ?? r.signal}): ${r.stderr.trim()}`);
  return JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as HermesFork;
}

async function main(): Promise<void> {
  // No identity → a plain run, not a launcher-spawned agent. Stay off the mesh.
  if (!hasIdentity()) {
    log("no COTAL_NAME — not a managed session; staying off the mesh");
    process.exit(0);
  }
  const config = configFromEnv();

  const adopt = adoptedHome();
  const persona = process.env.COTAL_AGENT_FILE
    ? loadAgentFile(process.env.COTAL_AGENT_FILE).persona
    : undefined;
  // Managed (default): a disposable profile under tmp, regenerated every launch and removed when the
  // seat stops. Adopted (opt-in): the operator's own profile, into which only this connector's
  // plugin directory is written, and which is never removed.
  const managed = adopt ? undefined : hermesSeatHome(config.space, config.name);
  const home = adopt ?? managed!.home;
  if (adopt) setupAdoptedProfile(home, { persona });
  else setupProfile(home, { model: process.env.HERMES_MODEL, persona });

  // `cotal spawn --resume`: fork before the seat joins the mesh, so a session that cannot be read is
  // refused while nothing has joined. A relaunch reuses the fork and does not read the source again.
  const resume = process.env.COTAL_HERMES_RESUME?.trim();
  let fork: HermesFork | undefined;
  if (resume) {
    if (adopt) throw new LaunchRefused(`${ADOPT_HOME_ENV} runs the operator's own profile, which already holds session ${resume}; continue it there with Hermes' own /resume`);
    const sourceHome = process.env.COTAL_HERMES_RESUME_HOME?.trim();
    if (!sourceHome) throw new Error("COTAL_HERMES_RESUME is set without COTAL_HERMES_RESUME_HOME");
    // The manager reads the fork's provenance where the launch named it, so a profile elsewhere (a
    // TMPDIR that differs from the manager's) would leave it unrecorded.
    if (process.env.COTAL_HERMES_RESUME_RECORD !== join(home, HERMES_FORK_RECORD))
      throw new Error(`the seat's Hermes profile ${home} is not where the launch records its fork (${process.env.COTAL_HERMES_RESUME_RECORD ?? "unset"})`);
    assertHermesVersion();
    fork = forkHermesSession({ sourceHome, source: resume, seatHome: home });
    log(`${fork.created ? "forked" : "continuing the fork of"} Hermes session ${fork.source}${fork.title ? ` ${JSON.stringify(fork.title)}` : ""} as ${fork.fork} (${fork.messages} messages, transcript sha256:${fork.transcriptSha256})`);
  }

  // Paths shared by the sidecar and the gateway child — set in our env so startSidecar reads
  // them, and forwarded verbatim to the child so the plugin connects to the same sockets/file.
  const control = controlEndpoint(config.space, config.name);
  const bridgeSock = bridgeSocketPath(config.space, config.name, control.token);
  const toolsFile = join(home, "cotal-tools.json");
  // This launcher mints the control endpoint itself, so it has to hand the token onward to two
  // readers: the in-process sidecar below, and the gateway child. It rides the launch-material file
  // rather than an environment variable, so that the gateway's descendants do not INHERIT a
  // control-plane bearer none of them asked for.
  //
  // Say what that does and does not buy, because the stronger sentence that used to be here was
  // wrong. This connector keeps the material POINTER in the gateway's environment, because the
  // gateway child is a later reader. So a descendant running as the same user can still open the
  // file deliberately. What changes is that nothing receives the token by accident, which is the
  // narrowed contract this whole change is honest about rather than a claim that the token is out of
  // reach.
  //
  // MERGED onto the material this launcher was itself launched with, not written fresh over it: the
  // sidecar re-parses the environment for its mesh config, and a control-only file would leave it
  // reading a launch with no creds in it, which is open mode wearing the wrong hat. Merging keeps
  // one carrier per launch, which is the invariant configFromEnv enforces.
  const inherited = process.env[LAUNCH_MATERIAL_ENV]?.trim();
  const material = writeLaunchMaterial({
    ...(inherited ? readLaunchMaterial(inherited) : {}),
    controlToken: control.token,
  });
  process.env[LAUNCH_MATERIAL_ENV] = material;
  // The inherited copy has been folded into the merged one and has no reader left. Leaving it on
  // disk would mean this connector, alone among the five, keeps TWO files holding the same
  // credential for the life of the seat, which is a second copy nobody asked for and a longer
  // exposure than the carrier's own contract describes. Best-effort: the merged file is already in
  // place, so a failure to unlink is untidy rather than unsafe.
  // Same discard the sessions use, so the superseded copy's private directory goes with it instead
  // of being left behind empty, and so this connector cannot grow its own idea of what is safe to
  // delete.
  if (inherited) discardLaunchMaterial(inherited);
  process.env.COTAL_CONTROL_SOCKET = control.path;
  process.env.COTAL_BRIDGE_SOCKET = bridgeSock;
  process.env.COTAL_TOOLS_FILE = toolsFile;

  const sidecar = startSidecar();

  // Fail loudly before we hand control to the gateway if the Hermes API line is wrong.
  if (!fork) assertHermesVersion();

  // A managed gateway's temp files land inside the root a stop removes, not in the shared temp dir.
  const gatewayTmp = managed && join(managed.root, "tmp");
  if (gatewayTmp) mkdirSync(gatewayTmp, { recursive: true });
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HERMES_HOME: home,
    ...(gatewayTmp ? { TMPDIR: gatewayTmp } : {}),
    [LAUNCH_MATERIAL_ENV]: material,
    COTAL_CONTROL_SOCKET: control.path,
    COTAL_BRIDGE_SOCKET: bridgeSock,
    COTAL_TOOLS_FILE: toolsFile,
    // The adapter branches each new mesh chat from this fork (plugin/cotal/resume.py seed_chat).
    ...(fork ? { COTAL_HERMES_FORK_SESSION: fork.fork } : {}),
  };

  log(`launching hermes gateway as ${config.name}${config.role ? `/${config.role}` : ""} (HERMES_HOME=${home})`);
  const child = spawnHermesGateway({ pkgDir: PKG_DIR, env: childEnv });
  const gatewayExit = new Promise<void>((done) => child.once("exit", () => done()));

  // Remove the managed root, but only once the gateway can no longer write into it: let it drain,
  // kill its tree if it is still up, and wait for its exit. Removing earlier would let a draining
  // gateway recreate part of the directory after it was deleted.
  const removeManaged = async (root: string): Promise<void> => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      let timer: NodeJS.Timeout | undefined;
      const drained = await Promise.race([
        gatewayExit.then(() => true),
        new Promise<boolean>((done) => (timer = setTimeout(() => done(false), GATEWAY_DRAIN_MS))),
      ]);
      clearTimeout(timer);
      if (!drained) {
        log(`gateway still running ${GATEWAY_DRAIN_MS}ms after SIGTERM; killing it before removing ${root}`);
        for (const pid of processTree(child.pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
        await gatewayExit;
      }
    }
    rmSync(root, { recursive: true, force: true });
  };

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    const [, removed] = await Promise.allSettled([sidecar.stop(), managed && removeManaged(managed.root)]);
    if (removed.status === "rejected")
      log(`could not remove the managed profile ${managed!.root}, so it is left on disk: ${(removed.reason as Error).message}`);
    process.exit(code);
  };

  child.on("exit", (code) => void shutdown(code ?? 0));
  child.on("error", (e) => {
    log(`failed to launch hermes gateway: ${e.message} — is uv (and hermes-agent) available?`);
    void shutdown(1);
  });
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    log(e instanceof LaunchRefused ? `refused: ${e.message}` : `fatal: ${(e as Error).stack ?? String(e)}`);
    process.exit(1);
  });
}
