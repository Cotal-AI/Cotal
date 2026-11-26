/**
 * `npx @cotal-ai/acp`: how an ACP client that installs agents from the ACP Registry starts Cotal. It
 * keeps no state of its own. It finds the Cotal installed on this computer and runs its `cotal acp`
 * with the same arguments, so the agent, its spaces and its sign-in are the person's own.
 *
 * When this computer has no Cotal, or a Cotal without its ACP extension, it answers as a stub agent
 * that offers only its terminal sign-in. The client runs this command again with `--auth` in a
 * terminal, which installs Cotal (`curl -fsSL https://get.cotal.ai | sh`, or npm on Windows) or adds
 * the extension, then runs `cotal acp --auth` to sign in or set up a space. It imports Node's
 * built-ins and the ACP SDK only, so `npx` installs neither `@cotal-ai/core` nor `@cotal-ai/workspace`.
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { TERMINAL_AUTH } from "./auth-method.js";

const INSTALL = "curl -fsSL https://get.cotal.ai | sh";
const NOT_INSTALLED = "Cotal is not installed on this computer. Sign in to Cotal to install it and set up a space.";
const NO_EXTENSION = "Cotal is installed, but its ACP extension is not. Sign in to Cotal to add it.";

const log = (line: string): void => void process.stderr.write(`cotal-acp: ${line}\n`);

function executable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The `cotal` this computer runs: the first on PATH, then the get.cotal.ai launcher in
 *  `~/.local/bin`, then npm's global prefix. A client started from a desktop often has a PATH without
 *  either folder. */
export function findCotal(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string | undefined {
  const names = platform === "win32" ? ["cotal.cmd", "cotal.exe"] : ["cotal"];
  const prefix = env.npm_config_global_prefix?.trim() || undefined;
  const dirs = [
    ...(env.PATH ?? env.Path ?? "").split(delimiter).filter((dir) => dir !== ""),
    join(home, ".local", "bin"),
    ...(prefix ? [platform === "win32" ? prefix : join(prefix, "bin")] : []),
    ...(platform === "win32" && env.APPDATA ? [join(env.APPDATA, "npm")] : []),
  ];
  for (const dir of dirs) for (const name of names) if (executable(join(dir, name), platform)) return join(dir, name);
  return undefined;
}

/** The executable and arguments that run `cotal <args>`. A Windows `.cmd` shim runs under `cmd.exe`,
 *  the only way Node starts one. */
function invocation(cotal: string, args: readonly string[]): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform !== "win32" || !/\.cmd$/i.test(cotal)) return { file: cotal, args: [...args] };
  const quoted = (arg: string) => `"${arg.replace(/"/g, '""')}"`;
  return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${[cotal, ...args].map(quoted).join(" ")}"`], windowsVerbatimArguments: true };
}

/** Whether this Cotal runs `cotal acp`: its ACP extension is added. */
function hasAcp(cotal: string): boolean {
  const run = invocation(cotal, ["acp", "--help"]);
  return spawnSync(run.file, run.args, { stdio: "ignore", windowsVerbatimArguments: run.windowsVerbatimArguments, windowsHide: true }).status === 0;
}

/** Run `cotal <args>` in this terminal and return its exit status. */
function runSync(cotal: string, args: readonly string[]): number {
  const run = invocation(cotal, args);
  const result = spawnSync(run.file, run.args, { stdio: "inherit", windowsVerbatimArguments: run.windowsVerbatimArguments });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Run `cotal <args>` with this process's standard streams, and resolve with its exit status. */
function runCotal(cotal: string, args: readonly string[]): Promise<number> {
  const run = invocation(cotal, args);
  const child = spawn(run.file, run.args, { stdio: "inherit", windowsVerbatimArguments: run.windowsVerbatimArguments, windowsHide: !args.includes("--auth") });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** Install Cotal the way get.cotal.ai says, in this terminal, and resolve with the installer's status. */
function install(): number {
  const windows = process.platform === "win32";
  log(`Cotal is not installed on this computer. Installing it with \`${windows ? "npm install -g cotal-ai" : INSTALL}\`.`);
  const result = windows
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm install -g cotal-ai"], { stdio: "inherit" })
    : spawnSync("sh", ["-c", INSTALL], { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** The agent a client meets when `cotal acp` cannot run here: every session asks for the sign-in, and
 *  the sign-in is the terminal method that installs what is missing. */
export async function serveStub(why: string, input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>): Promise<void> {
  const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  const app = agent({ name: "cotal" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "cotal", title: "Cotal", version },
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      authMethods: [{ ...TERMINAL_AUTH, description: "Installs what Cotal needs on this computer, then signs in to a space or sets one up." }],
    }))
    .onRequest(methods.agent.authenticate, () => {
      throw RequestError.authRequired(undefined, why);
    })
    .onRequest(methods.agent.session.new, () => {
      throw RequestError.authRequired(undefined, why);
    });
  await app.connect(ndJsonStream(output, input)).closed;
}

/** Start Cotal's ACP agent with `args`, as `npx @cotal-ai/acp <args>` does, and return the exit status. */
export async function launch(args: readonly string[]): Promise<number> {
  const auth = args.includes("--auth");
  let cotal = findCotal();
  if (!cotal) {
    if (!auth) return stub(NOT_INSTALLED);
    const status = install();
    if (status !== 0) return status;
    cotal = findCotal();
    if (!cotal) {
      log("The installer finished, but no `cotal` command was found. Open a new terminal and run `cotal setup`.");
      return 1;
    }
  }
  if (!hasAcp(cotal)) {
    if (!auth) return stub(NO_EXTENSION);
    log("Adding Cotal's ACP extension with `cotal ext add @cotal-ai/acp`.");
    const status = runSync(cotal, ["ext", "add", "@cotal-ai/acp"]);
    if (status !== 0) return status;
  }
  return runCotal(cotal, ["acp", ...args]);
}

async function stub(why: string): Promise<number> {
  log(why);
  await serveStub(why, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>, Writable.toWeb(process.stdout) as WritableStream<Uint8Array>);
  return 0;
}
