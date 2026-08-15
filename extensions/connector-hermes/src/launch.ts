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
 *   - an isolated **HERMES_HOME** profile so the operator's own ~/.hermes is never touched
 *
 * The manager runs this in a PTY; stdio is inherited so the gateway's output is what you attach to.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentFile } from "@cotal-ai/core";
import { hasIdentity, configFromEnv, controlEndpoint, ORIENTATION_BOOTSTRAP, MESH_FIRST_STEER } from "@cotal-ai/connector-core";
import { startSidecar } from "./sidecar.js";

/** Hermes API line this connector is written + pinned against (see pyproject.toml). A different
 *  major.minor may move the plugin/platform/hook signatures, so we assert and fail loudly. */
const HERMES_PIN = "0.16";

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
    writeFileSync(join(home, "SOUL.md"), `${opts.persona.trim()}\n\n${ORIENTATION_BOOTSTRAP}\n\n${MESH_FIRST_STEER}\n`);
}

/** Assert the installed hermes-agent is on the pinned API line, or throw. No silent degrade: a
 *  different major.minor can shift the plugin/platform/hook contract this connector depends on. */
function assertHermesVersion(): void {
  let raw: string;
  try {
    raw = execFileSync(
      "uv",
      ["run", "--project", PKG_DIR, "--quiet", "python", "-c", "from importlib.metadata import version; print(version('hermes-agent'))"],
      { encoding: "utf8" },
    ).trim();
  } catch (e) {
    throw new Error(`could not resolve the hermes-agent version via uv — is uv installed and hermes-agent available? (${(e as Error).message})`);
  }
  const line = raw.split(".").slice(0, 2).join(".");
  if (line !== HERMES_PIN)
    throw new Error(`hermes-agent ${raw} is not on the pinned ${HERMES_PIN} line this connector targets — pin ${HERMES_PIN}.x or update src/launch.ts + pyproject.toml together`);
  log(`hermes-agent ${raw} (pinned line ${HERMES_PIN}) ✓`);
}

async function main(): Promise<void> {
  // No identity → a plain run, not a launcher-spawned agent. Stay off the mesh.
  if (!hasIdentity()) {
    log("no COTAL_NAME — not a managed session; staying off the mesh");
    process.exit(0);
  }
  const config = configFromEnv();

  const home = join(tmpdir(), `cotal-hermes-${tok(config.space)}-${tok(config.name)}`);
  const persona = process.env.COTAL_AGENT_FILE
    ? loadAgentFile(process.env.COTAL_AGENT_FILE).persona
    : undefined;
  setupProfile(home, { model: process.env.HERMES_MODEL, persona });

  // Paths shared by the sidecar and the gateway child — set in our env so startSidecar reads
  // them, and forwarded verbatim to the child so the plugin connects to the same sockets/file.
  const control = controlEndpoint(config.space, config.name);
  const bridgeSock = bridgeSocketPath(config.space, config.name);
  const toolsFile = join(home, "cotal-tools.json");
  process.env.COTAL_CONTROL_SOCKET = control.path;
  process.env.COTAL_CONTROL_TOKEN = control.token; // first-frame auth, shared sidecar↔plugin via env
  process.env.COTAL_BRIDGE_SOCKET = bridgeSock;
  process.env.COTAL_TOOLS_FILE = toolsFile;

  const sidecar = startSidecar();

  // Fail loudly before we hand control to the gateway if the Hermes API line is wrong.
  assertHermesVersion();

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HERMES_HOME: home,
    COTAL_CONTROL_SOCKET: control.path,
    COTAL_CONTROL_TOKEN: control.token,
    COTAL_BRIDGE_SOCKET: bridgeSock,
    COTAL_TOOLS_FILE: toolsFile,
  };

  log(`launching hermes gateway as ${config.name}${config.role ? `/${config.role}` : ""} (HERMES_HOME=${home})`);
  const child = spawn("uv", ["run", "--project", PKG_DIR, "hermes", "gateway", "run"], {
    env: childEnv,
    stdio: "inherit",
  });

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

main().catch((e) => {
  // Same ordering, same reason, and it is `connector-codex/src/host-main.ts`'s reason rather than a
  // new one: the LAST line is what a detached operator sees — the manager reports a failed launch
  // as "<name> exited on launch - last output: <last line>" (`manager.ts:3928`) and then reaps the
  // agent. Ending on the stack handed them a frame, which is ALWAYS a path, instead of the cause.
  //
  // NOT A FIX FOR THE WIRE HOP. `tail` travels back in a control reply; this only stops it being a
  // frame by construction. A cause message can still carry a path (`ENOENT: … open '/…'`), so this
  // converts a certainty into a probability. Bounding `tail` where it enters the reply is the close.
  const err = e as Error;
  const stack = err.stack?.split("\n").slice(1).join("\n");
  if (stack?.trim()) log(stack);
  log(`fatal: ${err.message || String(e)}`);
  process.exit(1);
});
