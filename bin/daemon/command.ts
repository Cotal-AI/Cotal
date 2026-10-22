/**
 * `cotal daemon`: the local machine daemon's control surface, composed in this binary rather than
 * in an `implementations/*` package so it can later wire `@cotal-ai/auth` and `@cotal-ai/manager`
 * without one implementation importing another (AGENTS.md, repository map).
 *
 * This slice serves a local, authenticated endpoint for status and sign-in, and nothing else: no
 * Manager, no mesh or Cloud connection, no service install. Linux only. Sign-in runs inside the
 * daemon through stock `establishIdpSession`, so the session lands in the machine-home Cotal
 * directory where `cotal login` keeps it, and no token ever crosses the local endpoint. It is a
 * foreground foundation, not a resilient machine service: a daemon killed without cleanup leaves
 * its socket behind, and the next start refuses until the operator removes it (see the
 * ALREADY_RUNNING remedy). `state: "ready"` means the local control listener is bound and
 * verified; it says nothing about any mesh or Cloud connection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registry, type Command, type FlagSpec, type ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, jsonFlag, plainFlag, presentationOf, renderReport, terminalWidth, writeResult, type Report } from "@cotal-ai/workspace";
import { peerCredentials } from "@cotal-ai/seat";
import { normalizeIdpUrl } from "@cotal-ai/auth";
import type { Socket } from "node:net";
import { EndpointRefusal, daemonPaths, type EndpointProblemCode } from "./endpoint.js";
import { serveDaemon } from "./server.js";
import { loginViaDaemon, queryDaemon } from "./client.js";
import type { DaemonStatus, LoginResult } from "./protocol.js";

export const daemonFlags = [
  jsonFlag,
  plainFlag,
  { name: "idp", type: "string", value: "<auth base URL>", description: "login: the provider's auth base URL, e.g. <origin>/api/auth" },
  { name: "client-id", type: "string", value: "<id>", description: "login: the OAuth device-flow client id" },
] as const satisfies readonly FlagSpec[];

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

/** Sign in through the running daemon. The daemon talks to the IdP and keeps the session; this
 *  process only shows the approval prompt and the result, and never sees a token. Ctrl-C asks the
 *  daemon to cancel the attempt and waits for its answer. */
async function login(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const values = args.values as { idp?: string; "client-id"?: string };
  if (typeof values.idp !== "string") throw new CommandFailure("refused", "USAGE_INVALID", "cotal daemon login needs --idp <auth base URL>");
  let idp: string;
  try { idp = normalizeIdpUrl(values.idp); }
  catch { throw new CommandFailure("refused", "USAGE_INVALID", "use an HTTPS provider auth URL, or an HTTP loopback IP URL, without embedded credentials, a query or a fragment"); }
  if (values["client-id"] !== undefined && !values["client-id"].trim()) throw new CommandFailure("refused", "USAGE_INVALID", "--client-id cannot be empty");
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.once("SIGINT", onSignal);
  let reply;
  try {
    reply = await loginViaDaemon({
      paths: daemonPaths(), peerUid, idp, signal: abort.signal,
      ...(values["client-id"] !== undefined ? { clientId: values["client-id"] } : {}),
      onPrompt: (p) => {
        process.stderr.write(`${renderReport({ sections: [{ title: "Approve sign-in", blocks: [
          { kind: "fields", rows: [["Provider", idp], ["Open", p.verificationUriComplete], ["Or open", p.verificationUri], ["Approval code", p.userCode], ["Expires", p.expiresAt]] },
          { kind: "lines", lines: [{ text: "Waiting for the provider's approval. The daemon keeps the session. Ctrl-C cancels this sign-in on this machine. Do not share the approval link or code.", tone: "hint" }] },
        ] }] }, presentation === "plain" ? "plain" : "rich", terminalWidth(process.stderr))}\n`);
      },
    });
  } catch (e) {
    throw asFailure(e);
  } finally {
    process.off("SIGINT", onSignal);
  }
  if (!reply.ok) {
    if (reply.code === "LOGIN_IN_PROGRESS") throw new CommandFailure("refused", "CONFLICT", reply.message, { native: { code: reply.code } });
    if (reply.code === "ABANDONED") throw new CommandFailure("refused", "USAGE_INVALID", reply.message, { native: { code: reply.code } });
    throw new CommandFailure("failed", "OPERATION_FAILED", `the daemon refused the sign-in: ${reply.code} ${reply.message}`, { native: { code: reply.code } });
  }
  const r: LoginResult = reply.result;
  if (r.outcome === "cancelled") throw new CommandFailure("refused", "USAGE_INVALID", "the sign-in was cancelled on this machine; nothing was saved and nothing was revoked at the provider", { native: { code: "CANCELLED" } });
  if (r.outcome === "failed") {
    const native = { native: { code: r.reason.toUpperCase() } };
    // Denied, expired and unreachable end before stock writes anything: refusals at the provider's
    // boundary. Any other failure can come after stock saved the session, so it claims nothing about
    // what was saved; `cotal daemon login` again replaces whatever is there.
    if (r.reason === "unreachable") throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `${r.message}; no session was saved`, native);
    if (r.reason === "denied" || r.reason === "expired") throw new CommandFailure("refused", "PERMISSION_DENIED", `${r.message}; no session was saved`, native);
    throw new CommandFailure("failed", "OPERATION_FAILED", `${r.message}; a session may have been saved before the failure, so sign in again`, native);
  }
  writeResult(presentation, { command: "daemon login", target: { idp }, result: { attempt: reply.attempt, ...r } }, () => ({ sections: [
    { title: "Signed in", blocks: [{ kind: "fields", rows: [["Account", r.label || r.sub], ["Subject", r.sub], ["Provider", r.idp]] }, { kind: "lines", lines: [{ text: "The daemon holds this session in the machine's Cotal home. No session token is printed. Each space's grants decide access separately.", tone: "hint" }] }] },
  ] }));
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
  if (mode === "login") return login(args);
  throw new CommandFailure("refused", "USAGE_INVALID", mode === undefined ? "cotal daemon needs a mode: status, serve or login" : `unknown daemon mode ${JSON.stringify(mode)}`, { remedy: "cotal daemon status" });
}

const daemonCommand: Command = {
  kind: "command",
  name: "daemon",
  group: "Manager",
  summary: "the local machine daemon (Linux): serve its control endpoint, read its status, sign it in",
  positionals: "<status|serve|login>",
  flags: daemonFlags,
  subcommands: [
    { name: "status", summary: "ask the running daemon for its status over the local endpoint", flagNames: ["json", "plain"], outputs: ["json", "plain"], reads: true, prepareMeshTarget: false },
    { name: "serve", summary: "run the daemon in the foreground and serve its local endpoint (refusals honor --json)", flagNames: ["json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
    { name: "login", summary: "sign the running daemon in to a provider with device approval; the daemon keeps the session", flagNames: ["idp", "client-id", "json", "plain"], outputs: ["json", "plain"], prepareMeshTarget: false },
  ],
  prepareMeshTarget: false,
  examples: ["cotal daemon serve", "cotal daemon status", "cotal daemon status --json", "cotal daemon login --idp https://example.org/api/auth"],
  run,
};

registry.register(daemonCommand);
