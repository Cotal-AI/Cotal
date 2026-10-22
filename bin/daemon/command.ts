/**
 * `cotal daemon`: the local machine daemon's control surface, composed in this binary rather than
 * in an `implementations/*` package so it can later wire `@cotal-ai/auth` and `@cotal-ai/manager`
 * without one implementation importing another (AGENTS.md, repository map).
 *
 * This slice serves a local, authenticated status endpoint and nothing else: no sign-in, no
 * Manager, no service install. Linux only. It is a foreground foundation, not a resilient machine
 * service: a daemon killed without cleanup leaves its socket behind, and the next start refuses
 * until the operator removes it (see the ALREADY_RUNNING remedy). `state: "ready"` means the local
 * control listener is bound and verified; it says nothing about any mesh or Cloud connection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registry, type Command, type FlagSpec, type ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, jsonFlag, plainFlag, presentationOf, writeResult, type Report } from "@cotal-ai/workspace";
import { peerCredentials } from "@cotal-ai/seat";
import type { Socket } from "node:net";
import { EndpointRefusal, daemonPaths, type EndpointProblemCode } from "./endpoint.js";
import { serveDaemon } from "./server.js";
import { queryDaemon } from "./client.js";
import type { DaemonStatus } from "./protocol.js";

export const daemonFlags = [jsonFlag, plainFlag] as const satisfies readonly FlagSpec[];

/** This binary's own version: the nearest package.json above this module (bin/ in a source run). */
export function binVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "cotal-ai" && typeof pkg.version === "string") return pkg.version;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    dir = dirname(dir);
  }
  throw new Error("cannot determine the cotal-ai version: no cotal-ai package.json above the daemon module");
}

const peerUid = (sock: Socket): number => peerCredentials(sock).uid;

const REFUSAL: Record<EndpointProblemCode, { code: "UNSUPPORTED" | "TARGET_UNAVAILABLE" | "CONFLICT" | "PERMISSION_DENIED"; remedy?: string }> = {
  UNSUPPORTED_PLATFORM: { code: "UNSUPPORTED" },
  NO_RUNTIME_DIR: { code: "TARGET_UNAVAILABLE", remedy: "run from a logged-in session with a per-user runtime directory (systemd-logind sets XDG_RUNTIME_DIR)" },
  NOT_RUNNING: { code: "TARGET_UNAVAILABLE", remedy: "start it with cotal daemon serve" },
  ALREADY_RUNNING: { code: "CONFLICT", remedy: "run cotal daemon status: if it answers, a daemon is already running. If it refuses NOT_RUNNING, a previous daemon exited without cleanup and the entry is stale; confirm no cotal daemon process is running, then remove the socket path named above by hand and start again. The daemon never removes it for you" },
  DIR_NOT_DIRECTORY: { code: "PERMISSION_DENIED", remedy: "inspect the path; nothing was changed" },
  DIR_SYMLINK: { code: "PERMISSION_DENIED", remedy: "inspect the path; nothing was changed" },
  DIR_WRONG_OWNER: { code: "PERMISSION_DENIED", remedy: "inspect the path; nothing was changed" },
  DIR_WRONG_MODE: { code: "PERMISSION_DENIED", remedy: "inspect the directory; the daemon never changes the mode of an existing directory" },
  SOCKET_NOT_SOCKET: { code: "PERMISSION_DENIED", remedy: "inspect the path; nothing was removed" },
  SOCKET_WRONG_OWNER: { code: "PERMISSION_DENIED", remedy: "inspect the path; nothing was removed" },
  SOCKET_WRONG_MODE: { code: "PERMISSION_DENIED", remedy: "inspect the socket; nothing was sent" },
  PEER_UID_MISMATCH: { code: "PERMISSION_DENIED", remedy: "another user's process holds the daemon endpoint; nothing was sent" },
};

function asFailure(e: unknown): unknown {
  if (!(e instanceof EndpointRefusal)) return e;
  const r = REFUSAL[e.code];
  return new CommandFailure("refused", r.code, e.message, { ...(r.remedy ? { remedy: r.remedy } : {}), native: { code: e.code } });
}

function statusView(s: DaemonStatus): Report {
  return { sections: [{ title: "Daemon", blocks: [{ kind: "fields", rows: [["State", s.state], ["Version", s.version], ["Protocol", String(s.protocol)], ["PID", String(s.pid)], ["Started", s.startedAt], ["Uptime", `${Math.round(s.uptimeMs / 1000)}s`]] }] }] };
}

async function status(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  let reply;
  try {
    reply = await queryDaemon({ paths: daemonPaths(), peerUid });
  } catch (e) {
    throw asFailure(e);
  }
  if (!reply.ok) throw new CommandFailure("failed", "OPERATION_FAILED", `the daemon refused the status request: ${reply.error.code} ${reply.error.message}`);
  writeResult(presentation, { command: "daemon status", target: null, result: reply.result }, statusView);
}

async function serve(): Promise<void> {
  let running;
  try {
    running = await serveDaemon({ paths: daemonPaths(), version: binVersion(), peerUid, log: (l) => process.stderr.write(`${l}\n`) });
  } catch (e) {
    throw asFailure(e);
  }
  process.stdout.write(`daemon ready at ${running.paths.socket}\n`);
  await new Promise<void>((resolve) => {
    const stop = () => void running.close().then(resolve, resolve);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}

async function run(args: ParsedArgs): Promise<void> {
  const [mode, ...rest] = args.positionals;
  if (rest.length) throw new CommandFailure("refused", "USAGE_INVALID", `cotal daemon ${mode} takes no positionals`);
  if (mode === "status") return status(args);
  if (mode === "serve") return serve();
  throw new CommandFailure("refused", "USAGE_INVALID", mode === undefined ? "cotal daemon needs a mode: status or serve" : `unknown daemon mode ${JSON.stringify(mode)}`, { remedy: "cotal daemon status" });
}

const daemonCommand: Command = {
  kind: "command",
  name: "daemon",
  group: "Manager",
  summary: "the local machine daemon (Linux): serve its control endpoint, read its status",
  positionals: "<status|serve>",
  flags: daemonFlags,
  subcommands: [
    { name: "status", summary: "ask the running daemon for its status over the local endpoint", outputs: ["json", "plain"], reads: true, prepareMeshTarget: false },
    { name: "serve", summary: "run the daemon in the foreground and serve its local endpoint (refusals honor --json)", flagNames: ["json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
  ],
  prepareMeshTarget: false,
  examples: ["cotal daemon serve", "cotal daemon status", "cotal daemon status --json"],
  run,
};

registry.register(daemonCommand);
