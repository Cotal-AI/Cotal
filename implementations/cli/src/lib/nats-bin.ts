import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { BROKER_FLOOR, meetsBrokerFloor } from "@cotal-ai/core";
import { CommandFailure, isCommandFailure, protectedLocalEntry, resolveOnPath } from "@cotal-ai/workspace";

/** Platform-package prefix the bundled binary ships under. Swapping providers
 *  (e.g. to our own @cotal-ai/nats-server-*) is a one-line change here. */
const BUNDLED_PKG_PREFIX = "@eplightning/nats-server";

const FLOOR = `${BROKER_FLOOR.major}.${BROKER_FLOOR.minor}`;

/** The nats-server a broker start runs: its path, where it was found, and the version it reports.
 *  `skipped` is a nats-server on PATH that was passed over, with the reason. `refused` is the refusal
 *  a broker launch would give this one; it was not run, so its version is null. */
export interface NatsServer { path: string; source: "path" | "bundled"; version: string | null; skipped?: { path: string; reason: string }; refused?: CommandFailure }

/** The version a `nats-server --version` run printed, such as "2.14.0", or null when it printed none. */
function reportedVersion(run: ReturnType<typeof spawnSync>): string | null {
  if (run.error || run.status !== 0) return null;
  return /\bv?(\d+\.\d+\.\d+\S*)/.exec(String(run.stdout ?? ""))?.[1] ?? null;
}

/** The refusal a broker launch would give the physical file at `path` as its executable, by the rule
 *  it applies to it and the folders above it, or undefined when it would give none or the file
 *  cannot be read here. */
function refusal(path: string, what: string): CommandFailure | undefined {
  try { protectedLocalEntry(realpathSync(path), what); return undefined; }
  catch (error) { return isCommandFailure(error) ? error : undefined; }
}

/** Find the nats-server binary: PATH first (an operator-installed server wins), then the bundled
 *  platform package. A file a broker launch would refuse as unprotected, such as one under a
 *  group-writable Homebrew Cellar on macOS, is never run, not even for its version. A PATH one like
 *  that gives way to a bundled one that passes the rule. When neither passes, the result carries the
 *  refusal for the PATH one, or for the bundled one when there is none on PATH. Throws when neither
 *  is available. */
export async function findNatsServer(): Promise<NatsServer> {
  const found = resolveOnPath("nats-server");
  const pathRefused = found === undefined ? undefined : refusal(found, "the nats-server on PATH");
  if (!pathRefused) {
    const onPath = spawnSync("nats-server", ["--version"], { encoding: "utf8" });
    if (!onPath.error && onPath.status === 0) return { path: found ?? "nats-server", source: "path", version: reportedVersion(onPath) };
  }
  // With no protected bundled one, the refused PATH one stays the choice, so its refusal names the fix.
  const refusedOnPath = (): NatsServer => ({ path: found!, source: "path", version: null, refused: pathRefused });
  let bin: string;
  try { bin = await bundledBinaryPath(); }
  catch (error) { if (pathRefused) return refusedOnPath(); throw error; }
  const bundledRefused = refusal(bin, "the bundled nats-server");
  if (bundledRefused) return pathRefused ? refusedOnPath() : { path: bin, source: "bundled", version: null, refused: bundledRefused };
  const version = reportedVersion(spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 }));
  return { path: bin, source: "bundled", version, ...(pathRefused ? { skipped: { path: found!, reason: pathRefused.message } } : {}) };
}

/** The bundled platform package's nats-server path. Throws, naming the likely cause, when it is not installed. */
async function bundledBinaryPath(): Promise<string> {
  const pkg = `${BUNDLED_PKG_PREFIX}-${process.platform}-${process.arch}`;
  try {
    const mod = (await import(pkg)) as { getBinaryPath(): string };
    return mod.getBinaryPath();
  } catch {
    // The bundled binary requires Node >= 22; npm silently skips an optional dependency whose
    // engine the running Node doesn't satisfy, so an install done under an older Node lacks it —
    // and npx reuses that binary-less tree even after Node is upgraded. Name the likely cause.
    const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
    const staleInstallHint = Number.isInteger(nodeMajor) && nodeMajor < 22
      ? `This is Node ${process.version}; the bundled broker needs Node >= 22. Upgrade Node, then reinstall.\n`
      : `This usually means cotal was first installed under Node < 22 (npm skips the broker binary\nthere) and the stale install is being reused. Reinstall under Node >= 22.\n`;
    throw new Error(
      `nats-server not found on PATH, and the bundled binary for ${process.platform}/${process.arch} (${pkg}) is not installed.\n` +
        staleInstallHint +
        `  npm i -g cotal-ai         # global install\n` +
        `  rm -rf ~/.npm/_npx        # if you use npx, clear its cache first, then re-run\n` +
        `Or install nats-server yourself (https://github.com/nats-io/nats-server/releases) and put it on PATH.`,
    );
  }
}

/** Why the stack refuses this nats-server, or null. One a launch would refuse as unprotected is named
 *  by that refusal. A server on PATH must report the stack's broker floor or newer, so an old one
 *  never replaces the bundled broker unnoticed. */
export function natsServerProblem(server: NatsServer): string | null {
  if (server.refused) return server.source === "path" ? `${server.refused.message}; there is no protected bundled nats-server to use instead` : server.refused.message;
  if (server.source !== "path" || (server.version !== null && meetsBrokerFloor(server.version))) return null;
  return `the nats-server on PATH at ${server.path} reports ${server.version === null ? "no version" : `version ${server.version}`}, and this stack needs nats-server ${FLOOR} or newer`;
}

/** The nats-server a broker start runs: {@link findNatsServer}, refusing one {@link natsServerProblem} names. */
export async function resolveNatsServer(): Promise<NatsServer> {
  const server = await findNatsServer();
  const problem = natsServerProblem(server);
  if (problem && server.refused)
    throw new CommandFailure(server.refused.outcome, server.refused.code, `${problem}; nothing was run or started`, { target: server.refused.target, ...(server.refused.remedy ? { remedy: server.refused.remedy } : {}) });
  if (problem)
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `${problem}; nothing was started`, {
      target: { executable: server.path, version: server.version },
      remedy: `upgrade ${server.path} to nats-server ${FLOOR} or newer, or take it off PATH so cotal uses its bundled nats-server`,
    });
  return server;
}

/** How a report names a nats-server. */
export function natsServerLabel(server: NatsServer): string {
  const version = server.version === null ? "nats-server, version not reported" : `nats-server ${server.version}`;
  const label = server.source === "path" ? `${version} on PATH at ${server.path}` : `bundled ${version} at ${server.path}`;
  return server.skipped ? `${label}; the one on PATH at ${server.skipped.path} is not protected against other local writers, so it was not used` : label;
}
