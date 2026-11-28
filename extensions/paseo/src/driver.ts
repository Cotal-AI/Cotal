import { execFile, execFileSync } from "node:child_process";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";

const MAX_BUFFER = 4 * 1024 * 1024;
const PROBE_CACHE_MS = 250;
/** Bounds every CLI call. Each `paseo` call loads the CLI and opens a daemon connection, so it takes
 *  about a second on a loaded host; only daemon discovery uses it. */
const CALL_MS = 10_000;
const CONNECT_MS = 10_000;

export interface DaemonStatus {
  reachable: boolean;
  /** The address the daemon listens on, such as `127.0.0.1:6767`. */
  listen?: string;
  /** Why the daemon cannot drive terminals, such as a terminal worker from a newer Paseo holding
   *  them. Absent when it can. */
  terminalsUnavailable?: string;
}

type ExecError = Error & { code?: string; stderr?: Buffer | string; stdout?: Buffer | string; status?: number };

let refusalCache: { at: number; value: string | undefined } | undefined;

/** Paseo terminals are a local runtime boundary: the launcher script lives on this host. Never let
 *  an ambient `PASEO_HOST` point discovery at another daemon. `PASEO_HOME` still selects the local
 *  daemon instance. */
export function localCliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of Object.keys(clean)) if (key.toUpperCase() === "PASEO_HOST") delete clean[key];
  return clean;
}

function bin(): string {
  return process.env.COTAL_PASEO_BIN?.trim() || "paseo";
}

const STATUS_ARGS = ["daemon", "status", "--json"];

function execOptions() {
  return {
    env: localCliEnv(),
    encoding: "utf8" as const,
    maxBuffer: MAX_BUFFER,
    timeout: CALL_MS,
    // SIGKILL, because Node waits for a timed-out child to exit, and one that handles SIGTERM
    // would outlast the timeout.
    killSignal: "SIGKILL" as const,
  };
}

function failure(err: unknown): Error {
  const e = err as ExecError;
  if (e.code === "ENOENT") return new Error(`paseo CLI not found (${bin()}); install @getpaseo/cli or set COTAL_PASEO_BIN`);
  const detail = String(e.stderr || e.stdout || e.message || err).trim().replace(/\s+/g, " ");
  return new Error(`paseo ${STATUS_ARGS.join(" ")} failed (exit ${e.status ?? "unknown"}): ${detail}`);
}

export function parseStatus(stdout: string): DaemonStatus {
  let parsed: { connectedDaemon?: unknown; listen?: unknown; terminals?: unknown };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch (e) {
    throw new Error(`paseo ${STATUS_ARGS.join(" ")} returned non-JSON output: ${(e as Error).message}`);
  }
  return {
    reachable: parsed.connectedDaemon === "reachable",
    ...(typeof parsed.listen === "string" ? { listen: parsed.listen } : {}),
    ...(typeof parsed.terminals === "string" ? { terminalsUnavailable: parsed.terminals } : {}),
  };
}

export function daemonStatus(): DaemonStatus {
  try {
    return parseStatus(execFileSync(bin(), STATUS_ARGS, { ...execOptions(), stdio: ["ignore", "pipe", "pipe"] }));
  } catch (err) {
    throw err instanceof Error && err.message.startsWith("paseo ") ? err : failure(err);
  }
}

export function daemonStatusAsync(): Promise<DaemonStatus> {
  return new Promise((resolve, reject) => {
    execFile(bin(), STATUS_ARGS, execOptions(), (err, stdout, stderr) => {
      if (err) reject(failure(Object.assign(err, { stdout, stderr })));
      else {
        try {
          resolve(parseStatus(stdout));
        } catch (e) {
          reject(e);
        }
      }
    });
  });
}

/** Why this runtime cannot use the daemon `status` describes, or undefined when it can. */
export function statusRefusal(status: DaemonStatus): string | undefined {
  if (!status.reachable || !status.listen) return "paseo runtime: the Paseo daemon is not reachable (run `paseo daemon status`)";
  if (status.terminalsUnavailable) return `paseo runtime: the Paseo daemon cannot drive terminals: ${status.terminalsUnavailable}`;
  return undefined;
}

/** Why the local Paseo daemon cannot take a spawn right now, or undefined when it can. */
export function refusal(): string | undefined {
  const cacheable = !process.env.COTAL_PASEO_BIN?.trim();
  if (cacheable && refusalCache && Date.now() - refusalCache.at < PROBE_CACHE_MS) return refusalCache.value;
  let value: string | undefined;
  try {
    value = statusRefusal(daemonStatus());
  } catch (err) {
    value = `paseo runtime: ${(err as Error).message}`;
  }
  if (cacheable) refusalCache = { at: Date.now(), value };
  return value;
}

/** True when the local Paseo daemon answers and can drive terminals. */
export function available(): boolean {
  return refusal() === undefined;
}

/** The SDK's WebSocket URL for a daemon listening on `listen`. Only TCP is supported: Node's
 *  WebSocket cannot reach a daemon that listens on a Unix socket. */
export function daemonUrl(listen: string): string {
  if (!/^(?:\[[^\]]+\]|[^/:\s]+):\d+$/.test(listen))
    throw new Error(`paseo runtime: the daemon listens on ${JSON.stringify(listen)}; only a TCP host:port listen address is supported`);
  return `ws://${listen}/ws`;
}

/** Open one SDK connection to the local daemon `paseo daemon status` reports. A password-protected
 *  daemon needs `PASEO_PASSWORD`, as for the Paseo CLI. */
export async function connect(): Promise<PaseoClient> {
  const status = await daemonStatusAsync();
  const refused = statusRefusal(status);
  if (refused !== undefined || !status.listen) throw new Error(refused);
  const password = process.env.PASEO_PASSWORD;
  const client = createPaseoClient({
    url: daemonUrl(status.listen),
    clientId: `cotal-paseo-${process.pid}`,
    connectTimeoutMs: CONNECT_MS,
    reconnect: { enabled: true },
    ...(password ? { password } : {}),
  });
  try {
    await client.connect();
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
  return client;
}
