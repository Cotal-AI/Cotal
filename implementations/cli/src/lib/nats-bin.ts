import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { BROKER_FLOOR, meetsBrokerFloor } from "@cotal-ai/core";
import { CommandFailure, isCommandFailure, protectedLocalEntry, resolveOnPath } from "@cotal-ai/workspace";

/** Platform-package prefix the bundled binary ships under. Swapping providers
 *  (e.g. to our own @cotal-ai/nats-server-*) is a one-line change here. */
const BUNDLED_PKG_PREFIX = "@eplightning/nats-server";

const FLOOR = `${BROKER_FLOOR.major}.${BROKER_FLOOR.minor}`;

/** The nats-server a broker start runs: its path, where it was found, and the version it reports.
 *  `skipped` is a nats-server on PATH that was passed over, with the reason. */
export interface NatsServer { path: string; source: "path" | "bundled"; version: string | null; skipped?: { path: string; reason: string } }

/** The version a `nats-server --version` run printed, such as "2.14.0", or null when it printed none. */
function reportedVersion(run: ReturnType<typeof spawnSync>): string | null {
  if (run.error || run.status !== 0) return null;
  return /\bv?(\d+\.\d+\.\d+\S*)/.exec(String(run.stdout ?? ""))?.[1] ?? null;
}

/** Why a broker launch would refuse the physical file at `path` as its executable, by the rule it
 *  applies to it and the folders above it, or undefined when it would not or it cannot be read here. */
function unprotected(path: string): string | undefined {
  try { protectedLocalEntry(realpathSync(path), "the nats-server on PATH"); return undefined; }
  catch (error) { return isCommandFailure(error) && error.code === "PERMISSION_DENIED" ? error.message : undefined; }
}

/** Find the nats-server binary: PATH first (an operator-installed server wins), then the bundled
 *  platform package. A PATH one that a broker launch would refuse as unprotected, such as one under a
 *  group-writable Homebrew Cellar on macOS, gives way to a bundled one that passes that rule, and is
 *  not run. Without such a bundled one it stays the choice, so the launch names its refusal and fix.
 *  Throws when neither is available. */
export async function findNatsServer(): Promise<NatsServer> {
  const found = resolveOnPath("nats-server");
  const reason = found === undefined ? undefined : unprotected(found);
  if (found !== undefined && reason !== undefined) {
    const bundled = await bundledNatsServer().catch(() => undefined);
    if (bundled && unprotected(bundled.path) === undefined) return { ...bundled, skipped: { path: found, reason } };
  }
  const onPath = spawnSync("nats-server", ["--version"], { encoding: "utf8" });
  if (!onPath.error && onPath.status === 0) return { path: found ?? "nats-server", source: "path", version: reportedVersion(onPath) };
  return bundledNatsServer();
}

/** The bundled platform package's nats-server. Throws, naming the likely cause, when it is not installed. */
async function bundledNatsServer(): Promise<NatsServer> {
  const pkg = `${BUNDLED_PKG_PREFIX}-${process.platform}-${process.arch}`;
  let bin: string;
  try {
    const mod = (await import(pkg)) as { getBinaryPath(): string };
    bin = mod.getBinaryPath();
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
  return { path: bin, source: "bundled", version: reportedVersion(spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 })) };
}

/** Why the stack refuses this nats-server, or null. A server on PATH must report the stack's broker
 *  floor or newer, so an old one never replaces the bundled broker unnoticed. */
export function natsServerProblem(server: NatsServer): string | null {
  if (server.source !== "path" || (server.version !== null && meetsBrokerFloor(server.version))) return null;
  return `the nats-server on PATH at ${server.path} reports ${server.version === null ? "no version" : `version ${server.version}`}, and this stack needs nats-server ${FLOOR} or newer`;
}

/** The nats-server a broker start runs: {@link findNatsServer}, refusing one {@link natsServerProblem} names. */
export async function resolveNatsServer(): Promise<NatsServer> {
  const server = await findNatsServer();
  const problem = natsServerProblem(server);
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
