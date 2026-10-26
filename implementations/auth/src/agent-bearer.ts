// `cotal agent-bearer`, in a module that loads neither core's root nor this package's: a seat execs it
// for every bearer, and the CLI's whole command surface cost several hundred milliseconds per bearer.
// The `@cotal-ai/auth/agent-bearer` subpath is this module, and the `cotal` entry dispatches to
// `runAgentBearerEntry` before it loads anything else.
import { readFileSync } from "node:fs";
import { parseCommandArgs, type Command, type ParsedArgs } from "@cotal-ai/core/command";
import { isLoopbackLiteral } from "@cotal-ai/core/loopback";
import { writePrivateRecord } from "@cotal-ai/core/secret-fs";
import { assertLifecycleToken } from "@cotal-ai/core/subjects";
import type { AgentAuthHealth } from "@cotal-ai/workspace";
import { probeLiveness } from "@cotal-ai/workspace/liveness";
import { exchangeRateLimit, readAuthResponseJson } from "./response-json.js";
import { loadAuthServiceInfo } from "./store-file.js";

/** Record one `agent-bearer` attempt in the manager-composed health file, 0o600 and never through a
 *  symlink ({@link writePrivateRecord}). */
export function writeAgentAuthHealth(path: string, state: "ok" | "failed", reason?: string): void {
  writePrivateRecord(path, JSON.stringify({ state, at: new Date().toISOString(), ...(reason ? { reason } : {}) } satisfies AgentAuthHealth));
}

/** `cotal agent-bearer` — the ONE thing a spawned user-mode agent execs to refresh its auth: read
 *  its spawn-time secret from the 0600 token file, exchange it at the space's auth service (agent
 *  grant type), print the fresh bearer to STDOUT, exit. Machine-facing: stdout carries the bearer
 *  and NOTHING else; every failure is a stderr sentence + exit 1 (the endpoint surfaces it as a
 *  loud "error" event and retries). A rate-limited exchange is the one exception: stdout carries
 *  `retry-after <seconds>`, the exit is 2, and the endpoint waits that long before it runs this
 *  again. The secret rides a file, never argv (ps-visible) or env. */
async function runAgentBearer(args: ParsedArgs): Promise<void> {
  const v = args.values as {
    dir?: string; space?: string; owner?: string; actor?: string;
    "token-file"?: string; "health-file"?: string; "exchange-url"?: string;
    "manager-call"?: boolean; "manager-instance"?: string;
  };
  const { dir, space, owner, actor } = v;
  const tokenFile = v["token-file"];
  if (!space || !owner || !actor || !tokenFile || (!dir && !v["exchange-url"]))
    throw new Error("usage: cotal agent-bearer [--dir <state-dir> | --exchange-url <https://base>] --space <s> --owner <u_…> --actor <a> --token-file <path> [--health-file <path>]");
  // Every attempt's outcome lands in the manager-composed health file (core's AgentAuthHealth) —
  // the `ps` window into a detached agent's bearer life. Best-effort: health reporting must never
  // turn a successful exchange into a failure.
  const managerCall = v["manager-call"] === true;
  if (v["manager-instance"] !== undefined && !managerCall)
    throw new Error("agent-bearer: --manager-instance requires --manager-call");
  const managerInstance = v["manager-instance"] === undefined
    ? undefined
    : assertLifecycleToken(v["manager-instance"], "manager instance");
  const health = (state: "ok" | "failed", reason?: string) => {
    if (managerCall) return;
    const path = v["health-file"];
    if (!path) return;
    try {
      writeAgentAuthHealth(path, state, reason);
    } catch { /* the exchange outcome still stands */ }
  };
  try {
    let actorToken: string;
    try {
      actorToken = readFileSync(tokenFile, "utf8").trim();
    } catch (e) {
      throw new Error(`agent-bearer: can't read the actor token file at ${tokenFile} (${e instanceof Error ? e.message : String(e)}) - respawn this agent to re-provision it`);
    }
    const remote = v["exchange-url"];
    let exchangeUrl: string;
    let headers: Record<string, string> = { "content-type": "application/json" };
    if (remote) {
      let u: URL;
      try { u = new URL(remote); }
      catch { throw new Error(`agent-bearer: --exchange-url is not a URL (got ${JSON.stringify(remote)})`); }
      // Match the remote-registration and enrollment transport rule: HTTPS, except a loopback HTTP
      // literal where the actor token never leaves this machine. Names such as localhost get no
      // exception because name resolution chooses where the credential goes.
      if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackLiteral(u.hostname)))
        throw new Error(`agent-bearer: --exchange-url must be https://, except for a loopback HTTP literal (got ${u.protocol}//) - the actor token must never cross plaintext off this machine`);
      u.pathname = `${u.pathname.replace(/\/$/, "")}/exchange`;
      u.search = "";
      u.hash = "";
      exchangeUrl = u.toString();
    } else {
      const info = loadAuthServiceInfo(dir!);
      // Proof required: only `alive` counts as running. The old two-state probe called EPERM dead, so
      // a service running as ANOTHER USER produced "not running - restart it with `cotal up`" about a
      // service that was up the whole time; the contract resolves EPERM to alive and fixes exactly
      // that. `unknown` still refuses, because telling an operator to talk to an endpoint whose
      // liveness cannot be established is worse than telling them to restart.
      const svc = info === undefined ? "absent" : probeLiveness(info.pid);
      if (svc === "unknown")
        throw new Error(
          `agent-bearer: the user-auth service for space "${space}" records pid ${info!.pid}, whose liveness cannot be determined - the kernel answered neither "running" nor "no such process" (a seccomp filter or LSM policy does this inside some sandboxes). Refusing rather than reporting it down: verify with \`ps -p ${info!.pid}\` before restarting anything.`,
        );
      if (svc !== "alive" || info === undefined)
        throw new Error(`agent-bearer: the user-auth service for space "${space}" is not running - restart it with \`cotal up\``);
      exchangeUrl = `${info.url}/exchange`;
      headers = { ...headers, authorization: `Bearer ${info.cap}` };
    }
    let res: Response;
    try {
      res = await fetch(exchangeUrl, {
        method: "POST",
        headers,
        redirect: "manual",
        body: JSON.stringify({
          owner,
          actor,
          actorToken,
          ...(managerCall ? { view: "manager-caller", ...(managerInstance !== undefined ? { managerInstanceId: managerInstance } : {}) } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new Error(
        remote
          ? `agent-bearer: the pinned exchange did not answer at ${exchangeUrl} (${e instanceof Error ? e.message : String(e)})`
          : `agent-bearer: the user-auth service did not answer at ${exchangeUrl.replace(/\/exchange$/, "")} (${e instanceof Error ? e.message : String(e)}) - restart it with \`cotal up\``,
      );
    }
    if (res.status >= 300 && res.status < 400)
      throw new Error(`agent-bearer: the pinned exchange answered ${res.status} with redirect Location ${JSON.stringify(res.headers.get("location") ?? "")} - redirects are refused so an HTTPS pin cannot walk the actor token onto plaintext or another host`);
    if (!res.ok) {
      const body = (await readAuthResponseJson(res, `agent-bearer: the exchange at ${exchangeUrl}`)) as { error?: string };
      const limited = exchangeRateLimit(res.status, body, actor);
      if (limited) {
        // The endpoint that runs this reads the wait here and does not run it again before then.
        process.stdout.write(`retry-after ${limited.retryAfterSeconds}\n`);
        throw Object.assign(new Error(`agent-bearer: ${limited.message}; ${limited.remedy}`), { exitCode: 2 });
      }
      throw new Error(`agent-bearer: exchange refused: ${body.error ?? `HTTP ${res.status}`}`);
    }
    const out = (await readAuthResponseJson(res, `agent-bearer: the exchange at ${exchangeUrl}`)) as { token?: string };
    if (typeof out.token !== "string" || !out.token)
      throw new Error("agent-bearer: the auth service's exchange returned no token - its build may be stale; restart it with `cotal up`");
    health("ok");
    process.stdout.write(`${out.token}\n`);
  } catch (e) {
    health("failed", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** The `agent-bearer` command, registered with the CLI's surface and run directly by {@link runAgentBearerEntry}. */
export const agentBearerCommand: Command = {
  kind: "command",
  name: "agent-bearer",
  // Spawned agents exec it; people never run it, so help leaves it out.
  hidden: true,
  group: "Manager",
  summary: "print one fresh agent bearer for a spawned user-mode agent (machine-facing; exec'd by agent endpoints)",
  usage: "cotal agent-bearer [--dir <state-dir> | --exchange-url <https://base>] --space <s> --owner <u_…> --actor <a> --token-file <path>",
  flags: [
    { name: "dir", type: "string", value: "<state-dir>", description: "local arm: the space's user-auth state dir" },
    { name: "exchange-url", type: "string", value: "<https://base>", description: "remote arm: pinned public exchange base URL (HTTPS required; no local capability)" },
    { name: "space", type: "string", value: "<s>", description: "the space the bearer is scoped to" },
    { name: "owner", type: "string", value: "<u_…>", description: "the agent's owner token" },
    { name: "actor", type: "string", value: "<a>", description: "the agent's actor token" },
    { name: "token-file", type: "string", value: "<path>", description: "0600 file holding the spawn-time agent secret" },
    { name: "health-file", type: "string", value: "<path>", description: "write each attempt's outcome here (read by the manager's ps)" },
    { name: "manager-call", type: "boolean", description: "mint a token bound to one manager instance" },
    { name: "manager-instance", type: "string", value: "<id>", description: "select the manager instance for --manager-call" },
  ],
  // Every failure is one stderr sentence, never a stack: the seat surfaces the sentence. It exits 1,
  // or 2 for a rate limit.
  run: async (args) => {
    try {
      await runAgentBearer(args);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      const exitCode = (e as { exitCode?: unknown } | undefined)?.exitCode;
      process.exit(typeof exitCode === "number" ? exitCode : 1);
    }
  },
};

/** Run `cotal agent-bearer <argv>` without loading the rest of the CLI. False when `argv` does not
 *  parse, so the caller hands it to its full dispatcher, which refuses it with the command's help as
 *  for any other command. */
export async function runAgentBearerEntry(argv: string[]): Promise<boolean> {
  let args: ParsedArgs;
  try {
    args = parseCommandArgs(agentBearerCommand, argv);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) return false;
    throw e;
  }
  await agentBearerCommand.run(args);
  return true;
}
