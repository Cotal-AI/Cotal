/** Boot the SHIPPED `web` command (`run-web.mts`) in a child process for a smoke, on a free port.
 *
 *  `run-web.mts` starts the dashboard when it is imported, so the suites cannot share it in-process;
 *  this is the one copy of the spawn, the port-in-use retry and the launch-link exchange they share
 *  instead (#4043). A copy per suite drifted in its cookie parsing, its launch-link match and its
 *  boot budget, and a change to any of those had to be found in every copy.
 *
 *  Not shipped and not imported by shipped code: this file lives under `smoke/`. */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PortInUseError, onFreePort } from "@cotal-ai/smoke-kit";

const RUN_WEB = fileURLToPath(new URL("./run-web.mts", import.meta.url));
/** How long a child has to print its launch link (or otherwise become ready) before the boot gives up. */
const BOOT_BUDGET_MS = 50_000;
const POLL_MS = 50;
const LAUNCH_URL = /http:\/\/127\.0\.0\.1:\d+\/\?k=[A-Za-z0-9_-]+/;
const SESSION_COOKIE = /(?:^|,\s*)cotal_web_session=([^;]+)/;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface WebOptions {
  /** The broker the dashboard dials. */
  server: string;
  space: string;
  /** The child's whole environment. Omitted, the child inherits this process's. */
  env?: NodeJS.ProcessEnv;
  /** Called with each child as it is spawned, so a suite's teardown owns it even if the boot fails. */
  onSpawn?: (child: ChildProcess) => void;
  /** Called with every chunk any child prints, for a suite that keeps (and resets) its own log. */
  onOutput?: (text: string) => void;
}

export interface WebChild {
  child: ChildProcess;
  port: number;
  /** Everything the serving child has printed so far, stdout and stderr together. It keeps growing. */
  output: () => string;
}

/** Spawn the dashboard on a free port and poll until `ready` says it serves, or the boot budget runs
 *  out. A child that reports its port taken is retried on another port. A child that never becomes
 *  ready is still returned, so the suite's own cell reports it with the output. */
export async function startWeb(opts: WebOptions & { ready: (output: string, port: number) => boolean | Promise<boolean> }): Promise<WebChild & { ready: boolean }> {
  let child!: ChildProcess;
  let printed = { text: "" };
  let ready = false;
  const port = await onFreePort(async (candidate) => {
    const attempt = { text: "" };
    printed = attempt;
    child = spawn(process.execPath, [
      "--import", "tsx", RUN_WEB,
      "--server", opts.server, "--space", opts.space, "--port", String(candidate), "--no-open",
    ], { stdio: ["ignore", "pipe", "pipe"], ...(opts.env === undefined ? {} : { env: opts.env }) });
    opts.onSpawn?.(child);
    const take = (d: Buffer) => { attempt.text += d.toString(); opts.onOutput?.(d.toString()); };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const taken = `Port ${candidate} is in use`;
    for (const deadline = Date.now() + BOOT_BUDGET_MS; Date.now() < deadline && !attempt.text.includes(taken);) {
      if (await opts.ready(attempt.text, candidate)) { ready = true; break; }
      await wait(POLL_MS);
    }
    if (!ready && attempt.text.includes(taken)) throw new PortInUseError(candidate, attempt.text);
    return candidate;
  });
  return { child, port, output: () => printed.text, ready };
}

export interface BootedWeb extends WebChild {
  /** The single-use launch link the child printed, or undefined if it printed none. */
  launchUrl: string | undefined;
  /** The status the link's exchange answered, or undefined if it never ran or did not answer. */
  exchangeStatus: number | undefined;
  /** `cotal_web_session=<value>` from the exchange, or undefined if it minted none. */
  cookie: string | undefined;
  /** Whether the exchange redirected, minted a session, and `/api/roster` answered 200 with it. */
  served: boolean;
}

/** {@link startWeb} until the launch link is printed, then spend the link ONCE and carry the session
 *  it mints. Re-presenting a single-use link tests its refusal, not the route behind it. */
export async function bootWeb(opts: WebOptions): Promise<BootedWeb> {
  const started = await startWeb({ ...opts, ready: (output) => LAUNCH_URL.test(output) });
  const launchUrl = started.output().match(LAUNCH_URL)?.[0];
  const exchange = launchUrl === undefined ? undefined : await fetch(launchUrl, { redirect: "manual" }).catch(() => undefined);
  const session = SESSION_COOKIE.exec(exchange?.headers.get("set-cookie") ?? "")?.[1];
  const cookie = session === undefined ? undefined : `cotal_web_session=${session}`;
  const roster = cookie === undefined
    ? undefined
    : await fetch(`http://127.0.0.1:${started.port}/api/roster`, { headers: { cookie } }).catch(() => undefined);
  return {
    child: started.child,
    port: started.port,
    output: started.output,
    launchUrl,
    exchangeStatus: exchange?.status,
    cookie,
    served: exchange?.status === 302 && cookie !== undefined && roster?.status === 200,
  };
}
