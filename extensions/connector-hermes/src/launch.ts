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
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, cpSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCH_MATERIAL_ENV, discardLaunchMaterial, loadAgentFile, readLaunchMaterial, writeLaunchMaterial } from "@cotal-ai/core";
import { hasIdentity, configFromEnv, controlEndpoint, ORIENTATION_BOOTSTRAP, MESH_FIRST_STEER, WORKFLOW_STEER } from "@cotal-ai/connector-core";
import { hermesUvCommand, spawnHermesGateway } from "./binary.js";
import { startSidecar } from "./sidecar.js";

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

const ILLEGAL = /[^A-Za-z0-9_-]/g;
const tok = (s: string): string => s.trim().replace(ILLEGAL, "_").slice(0, 40) || "_";

/** This package's root (where pyproject.toml + plugin/ live), resolved from this source file. */
const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_SRC = join(PKG_DIR, "plugin", "cotal");

function bridgeSocketPath(space: string, name: string): string {
  return join(tmpdir(), `cotal-hermes-bridge-${tok(space)}-${tok(name)}.sock`);
}

function log(msg: string): void {
  process.stderr.write(`[cotal-hermes] ${msg}\n`);
}

/** A double-quoted YAML basic-string literal (escaped). */
const yamlStr = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Build the isolated Hermes profile (HERMES_HOME) so the operator's ~/.hermes is never touched.
 * Drops the cotal plugin into the profile's plugins dir, enables it + the cotal platform, and
 * turns approvals off (an autonomous spawned gateway has no human at the TUI to approve commands).
 */
function setupProfile(home: string, opts: { model?: string; persona?: string }): void {
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
  if (opts.model) lines.push(`model: ${yamlStr(opts.model)}`);
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
 *  Set to the profile directory (`~/.hermes`, or any HERMES_HOME). Unset means the managed
 *  default, which is what a spawned seat should almost always use. */
export const ADOPT_HOME_ENV = "COTAL_HERMES_ADOPT_HOME";

/** Resolve the adopt-home opt-in, or undefined for the managed default. */
export function adoptedHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[ADOPT_HOME_ENV]?.trim();
  return raw ? raw : undefined;
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
  // Managed (default): a disposable profile under tmp, regenerated every launch. Adopted (opt-in):
  // the operator's own profile, into which only this connector's plugin directory is written.
  const home = adopt ?? join(tmpdir(), `cotal-hermes-${tok(config.space)}-${tok(config.name)}`);
  if (adopt) setupAdoptedProfile(home, { persona });
  else setupProfile(home, { model: process.env.HERMES_MODEL, persona });

  // Paths shared by the sidecar and the gateway child — set in our env so startSidecar reads
  // them, and forwarded verbatim to the child so the plugin connects to the same sockets/file.
  const control = controlEndpoint(config.space, config.name);
  const bridgeSock = bridgeSocketPath(config.space, config.name);
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
  assertHermesVersion();

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HERMES_HOME: home,
    [LAUNCH_MATERIAL_ENV]: material,
    COTAL_CONTROL_SOCKET: control.path,
    COTAL_BRIDGE_SOCKET: bridgeSock,
    COTAL_TOOLS_FILE: toolsFile,
  };

  log(`launching hermes gateway as ${config.name}${config.role ? `/${config.role}` : ""} (HERMES_HOME=${home})`);
  const child = spawnHermesGateway({ pkgDir: PKG_DIR, env: childEnv });

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    try {
      await sidecar.stop();
    } finally {
      process.exit(code);
    }
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
    log(`fatal: ${(e as Error).stack ?? String(e)}`);
    process.exit(1);
  });
}
