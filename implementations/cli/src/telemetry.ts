import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { basename, join } from "node:path";
import { Worker } from "node:worker_threads";
import { findSubcommand, type Command, type Registry } from "@cotal-ai/core";
import {
  CommandFailure,
  claimTelemetryInstallEvent,
  effectiveTelemetry,
  extensionProvides,
  homeCotalDir,
  isCommandFailure,
  isConnectRefusal,
  isWorkspaceTargetError,
  loadExtensionsManifest,
  markTelemetryNoticeShown,
  readMeshRegistry,
  type ErrorCode,
  type Outcome,
  type TelemetryLevel,
  type TelemetrySettings,
} from "@cotal-ai/workspace";
import { metadataPositionals } from "./lib/command-path.js";
import { cliVersion, SeedWriterRefusal } from "./seed/paths.js";

/**
 * Anonymous usage telemetry for the CLI: one small event per command, sent as the process exits, and
 * at `regular` one install event per UTC day. docs/telemetry.mdx lists every field. Nothing here
 * reads an argument value, a path or a name; the error text a failure carries at `regular` goes
 * through {@link scrubErrorText} first. Nothing here can change a command's outcome: every failure
 * is swallowed, and the send is bounded by {@link SEND_TIMEOUT_MS}.
 */

export const TELEMETRY_URL = "https://cotal.ai/v1/telemetry";
export const SEND_TIMEOUT_MS = 1500;
export const TELEMETRY_NOTICE =
  'Cotal collects anonymous usage data at the "regular" level (command names, outcomes, error text with values and paths masked, version, OS, installed connectors; never arguments, paths, names or content). Change it with `cotal telemetry minimal` or `cotal telemetry off`. Details: https://docs.cotal.ai/telemetry';

const MAX_MESSAGE = 500;
const MAX_STACK = 2000;
const MAX_FRAMES = 12;
const HOME = homedir();
const QUOTED = /(["'`])(?:(?!\1)[^\n]){0,400}\1/g;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`)]+/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const PATH = /(?:~|[A-Za-z]:)?(?:[\\/][^\s\\/'"`:)]+){2,}/g;
const TOKEN = /[A-Za-z0-9_-]{32,}/g;
const FRAME_PATH = /(?:file:\/\/)?(?:[A-Za-z]:)?[\\/][^\s()]+/g;

/** Mask identifying values before sending a diagnostic. The local read-policy refusal includes
 *  the entire allow list in brackets, with no quotes around its individual channel names. */
export function scrubErrorText(text: string, max = MAX_MESSAGE): string {
  if (text.includes(" is not within allowSubscribe [")) return "subscription is not within allowSubscribe".slice(0, max);
  return text
    .split(HOME).join("~")
    .replace(QUOTED, "$1<value>$1")
    .replace(URL, "<url>")
    .replace(EMAIL, "<email>")
    .replace(IPV4, "<ip>")
    .replace(PATH, "<path>")
    .replace(TOKEN, "<token>")
    .slice(0, max);
}

/** The frames of a stack with every file path cut down to its part inside `node_modules` (the
 *  installed package and file, never the directory it is installed under); a frame outside one is
 *  `<path>`. The first line, the message, is not part of it. */
export function scrubStack(stack: string): string {
  const frames = stack.split("\n").slice(1).map((line) => line.trim()).filter((line) => line.startsWith("at ")).slice(0, MAX_FRAMES);
  return frames
    .map((line) => line.replace(FRAME_PATH, (p) => { const inside = /.*node_modules[\\/]/.exec(p); return inside ? p.slice(inside[0].length) : "<path>"; }))
    .join("\n")
    .slice(0, MAX_STACK);
}

interface ErrorText {
  readonly message: string | null;
  readonly stack: string | null;
}

const localDiagnostics = new WeakSet<Error>();

/** Keep this error's operator text and stack out of telemetry without changing the local failure. */
export function localDiagnostic<T extends Error>(error: T): T {
  localDiagnostics.add(error);
  return error;
}

export function telemetryErrorText(command: string, error: unknown, flags: readonly string[] = []): ErrorText {
  // A pinned input usage error can repeat the terminal text in the original command's retry.
  if (command === "input" && flags.includes("--on") && isCommandFailure(error) && error.code === "USAGE_INVALID") return { message: null, stack: null };
  if (error instanceof Error && (localDiagnostics.has(error) || error instanceof SeedWriterRefusal || error.cause instanceof SeedWriterRefusal)) return { message: null, stack: null };
  // Credential-file refusals name the local file, even after a command restates the connection error.
  if (flags.includes("--creds") && (isConnectRefusal(error) || isCommandFailure(error)) && error.target !== null &&
      typeof error.target === "object" && "path" in error.target && typeof error.target.path === "string") return { message: null, stack: null };
  // The connection error includes the stopped project's local restart instructions in its text.
  if (isConnectRefusal(error) && isWorkspaceTargetError(error.cause) && error.cause.code === "not-started") return { message: null, stack: null };
  // Help shows the requested topic and can suggest commands from local extensions.
  if (command === "help" && isCommandFailure(error) && error.code === "USAGE_INVALID") return { message: null, stack: null };
  // A manager's negative attach lookup names the agent and the answering instance.
  if (command === "attach" && isCommandFailure(error) && error.code === "TARGET_NOT_FOUND" && error.native?.code === "not-found") return { message: null, stack: null };
  // A spawn diagnostic can include native terminal output or the original launch arguments.
  if (command === "spawn" && isCommandFailure(error) && (error.native !== undefined
      || (error.code === "USAGE_INVALID" && error.message.includes("--on <instance>")))) return { message: null, stack: null };
  // A missing Manager pin names the requested instance, its space and any running instances.
  if (isCommandFailure(error) && (error.code === "TARGET_NOT_FOUND" || error.code === "TARGET_UNAVAILABLE") &&
      error.target !== null && typeof error.target === "object" && "requestedManagerInstance" in error.target &&
      typeof error.target.requestedManagerInstance === "string") return { message: null, stack: null };
  if (error instanceof Error) return { message: scrubErrorText(error.message), stack: error.stack ? scrubStack(error.stack) : null };
  return { message: scrubErrorText(String(error)), stack: null };
}

/** The intake: the public one, or `COTAL_TELEMETRY_URL` for a self-hosted intake. Throws the typed
 *  refusal of a value that is not an http or https URL, since every send to it would fail unseen. */
export function telemetryUrl(env: NodeJS.ProcessEnv = process.env): string {
  const named = env.COTAL_TELEMETRY_URL;
  if (!named) return TELEMETRY_URL;
  const protocol = globalThis.URL.canParse(named) ? new globalThis.URL(named).protocol : undefined;
  if (protocol !== "http:" && protocol !== "https:") throw new CommandFailure("refused", "USAGE_INVALID", "COTAL_TELEMETRY_URL must be an http or https URL", { remedy: "unset it, or set it to your intake's http or https URL", selfContained: true });
  return named;
}

/** Commands that send nothing: `telemetry` itself, internal entries, hidden daemon runners, and the
 *  bearer exchange a seat runs on the user's behalf. */
function silent(cmd: Command): boolean {
  return cmd.name === "telemetry" || cmd.name === "agent-bearer" || cmd.hidden === true || cmd.name.startsWith("__");
}

const MAX_FLAGS = 32;
const FLAG = /^--?[A-Za-z][\w-]*/;

/** The names of the flags in `words`, values stripped: `--server=x` and `--server x` both read as
 *  `--server`, and a word after `--` is text. An unknown flag counts by name too. */
export function flagNames(cmd: Command, words: readonly string[]): string[] {
  const valued = new Set((cmd.flags ?? []).flatMap((flag) => (flag.type === "string" ? [`--${flag.name}`, ...(flag.short ? [`-${flag.short}`] : [])] : [])));
  const names = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--") break;
    const name = FLAG.exec(word)?.[0];
    if (!name) continue;
    names.add(name);
    if (valued.has(name) && name === word) i++;
  }
  return [...names].slice(0, MAX_FLAGS);
}

/** The registered subcommand the first positional names, never a user value. */
function subcommandName(cmd: Command, words: readonly string[]): string | null {
  return findSubcommand(cmd, metadataPositionals(cmd, words).positionals[0]?.value)?.name ?? null;
}

/**
 * The account hash sent at `regular`: sha256 of the IdP URL and the subject id of this home's
 * cached sign-in, cut to 32 hex characters, so one person counts once across machines and
 * workspaces. The id itself is never sent. `null` with no cached sign-in, and on any read problem;
 * with several sign-ins, the first by IdP URL.
 */
export function accountHash(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(homeCotalDir(), "idp-sessions.json"), "utf8")) as { sessions?: Record<string, { sub?: unknown } | null> };
    const accounts = Object.entries(parsed.sessions ?? {})
      .filter((entry): entry is [string, { sub: string }] => typeof entry[1]?.sub === "string" && entry[1].sub !== "")
      .map(([idp, session]) => `${idp}\n${session.sub}`)
      .sort();
    return accounts.length === 0 ? null : createHash("sha256").update(accounts[0]!).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

interface Pending {
  readonly level: Exclude<TelemetryLevel, "off">;
  readonly settings: TelemetrySettings;
  /** At `regular`, {@link accountHash}; `null` at `minimal`. */
  readonly account: string | null;
  readonly command: string;
  readonly subcommand: string | null;
  readonly flags: string[];
  readonly startedAt: number;
  readonly version: string;
  failure?: { outcome: Outcome; code: ErrorCode | null };
  error?: ErrorText;
}

let pending: Pending | undefined;

/** Record the command's failure outcome and its typed code, if it has one. */
export function recordTelemetryFailure(outcome: Outcome, code: ErrorCode | null, error?: unknown): void {
  if (!pending) return;
  pending.failure = { outcome, code };
  if (error !== undefined) recordTelemetryError(error);
}

/** Record the error a command threw, once: the first one recorded is the original, and a wrapper
 *  the kernel builds from it afterwards does not replace it. */
export function recordTelemetryError(error: unknown): void {
  if (pending && !pending.error) pending.error = telemetryErrorText(pending.command, error, pending.flags);
}

/**
 * Arm the exit hook for `cmd`, once: decide the level, print the one-time notice, and register the
 * send on `exit`, which fires for a normal return, a set exit code, `process.exit()` anywhere and an
 * uncaught failure. Throws the typed refusal of a bad `COTAL_TELEMETRY` or settings file, and of a
 * bad `COTAL_TELEMETRY_URL` at a level that sends; the kernel reports it as it reports any refusal.
 */
export function armTelemetry(registry: Registry, cmd: Command, words: readonly string[], startedAt: number): void {
  if (pending || silent(cmd)) return;
  const raw = cmd.rawArgs === true;
  const subcommand = raw || !cmd.subcommands?.length ? null : subcommandName(cmd, words);
  if (subcommand?.startsWith("__")) return;
  const effective = whenSettingsFree(() => effectiveTelemetry(process.env, true, 0));
  if (!effective?.settings || effective.level === "off") return;
  const url = telemetryUrl();
  let settings = effective.settings;
  if (effective.source === "file" && effective.level === "regular" && !settings.noticeShownAt && process.stderr.isTTY) {
    const marked = whenSettingsFree(() => markTelemetryNoticeShown(0));
    if (marked) { settings = marked; console.error(TELEMETRY_NOTICE); }
  }
  pending = {
    level: effective.level,
    settings,
    account: effective.level === "regular" ? accountHash() : null,
    command: cmd.name,
    subcommand,
    flags: raw ? [] : flagNames(cmd, words),
    startedAt,
    version: cliVersion(),
  };
  process.once("exit", (code) => {
    try {
      sendTelemetry(url, eventsAtExit(registry, pending!, code, new Date()));
    } catch {
      // Telemetry never changes a command's outcome.
    }
  });
}

function whenSettingsFree<T>(read: () => T): T | undefined {
  try { return read(); } catch (error) {
    if (isCommandFailure(error) && error.native?.code === "TELEMETRY_BUSY") return undefined;
    throw error;
  }
}

const sameUtcDay = (a: string, b: Date): boolean => a.slice(0, 10) === b.toISOString().slice(0, 10);

/** The bodies to send: at `regular`, the day's install event first when none was sent today. */
function eventsAtExit(registry: Registry, p: Pending, code: number, now: Date): string[] {
  const bodies: string[] = [];
  // Bundled docs never open the extension inventory. Leave the install event due for another command.
  if (p.command !== "docs" && p.level === "regular" && !(p.settings.lastInstallEventAt && sameUtcDay(p.settings.lastInstallEventAt, now))) {
    try {
      const body = JSON.stringify(installEvent(registry, p, now));
      if (claimTelemetryInstallEvent(p.settings.installId, now)) bodies.push(body);
    } catch {
      // A busy settings writer or unreadable inventory costs the install event, never the command event.
    }
  }
  bodies.push(JSON.stringify(commandEvent(p, code, now)));
  return bodies;
}

/** Whether `CI` marks a CI run: set to anything but `0` or `false`, which is how a script of the
 *  operator's own says it is not one. */
function inCi(value: string | undefined): boolean {
  return value !== undefined && !["", "0", "false"].includes(value.trim().toLowerCase());
}

function base(p: Pending) {
  return {
    v: 1 as const,
    installId: p.settings.installId,
    level: p.level,
    version: p.version,
    os: process.platform,
    arch: process.arch,
    node: Number.parseInt(process.versions.node, 10),
    ci: inCi(process.env.CI),
  };
}

/** Prefer the recorded failure to the generic meaning of a nonzero exit code. */
function classify(p: Pending, exitCode: number): { outcome: "ok" | "error" | "refused"; errorCode: ErrorCode | null } {
  if (exitCode === 0) return { outcome: "ok", errorCode: null };
  if (p.failure) return { outcome: p.failure.outcome === "refused" ? "refused" : "error", errorCode: p.failure.code };
  if (exitCode === 2) return { outcome: "refused", errorCode: null };
  return { outcome: "error", errorCode: exitCode === 3 ? "OPERATION_UNKNOWN" : exitCode === 4 ? "OPERATION_PARTIAL" : null };
}

function commandEvent(p: Pending, exitCode: number, now: Date) {
  const { outcome, errorCode } = classify(p, exitCode);
  const minimal = { ...base(p), event: "command" as const, command: p.command, outcome, exitCode, durationMs: now.getTime() - p.startedAt };
  if (p.level === "minimal") return minimal;
  const error = outcome === "ok" ? undefined : p.error;
  return {
    ...minimal,
    account: p.account,
    subcommand: p.subcommand,
    flags: p.flags,
    errorCode,
    errorMessage: error?.message ?? null,
    errorStack: error?.stack ?? null,
    interactive: process.stdout.isTTY === true,
    shell: process.env.SHELL ? basename(process.env.SHELL) : null,
    terminal: process.env.TERM_PROGRAM || null,
  };
}

/** `npm/10.8.2 node/v22…` from `npm_config_user_agent` reads as `npm@10`. */
function packageManager(): string | null {
  const agent = /^([a-z]+)\/(\d+)/.exec(process.env.npm_config_user_agent ?? "");
  return agent ? `${agent[1]}@${agent[2]}` : null;
}

/** `installer` under the launcher get.cotal.ai writes (it exports `COTAL_LAUNCHER=1`), `npm` when
 *  the binary runs from a `node_modules` tree, else `unknown`. */
function installMethod(): "installer" | "npm" | "unknown" {
  if (process.env.COTAL_LAUNCHER === "1") return "installer";
  return (process.argv[1] ?? "").split(/[\\/]/).includes("node_modules") ? "npm" : "unknown";
}

function installEvent(registry: Registry, p: Pending, now: Date) {
  const manifest = loadExtensionsManifest().extensions;
  const connectors: { kind: string; version: string }[] = [];
  const extensions: { name: string; version: string }[] = [];
  const runtimes = new Set(registry.all().filter((ext) => ext.kind === "runtime").map((ext) => ext.name));
  for (const ext of manifest) {
    const provides = extensionProvides(ext);
    for (const ref of provides) if (ref.kind === "runtime") runtimes.add(ref.name);
    const connector = provides.find((ref) => ref.kind === "connector");
    if (connector) connectors.push({ kind: connector.name, version: ext.version });
    else if (ext.pkg.startsWith("@cotal-ai/")) extensions.push({ name: ext.pkg, version: ext.version });
  }
  const meshes = readMeshRegistry().entries;
  return {
    ...base(p),
    event: "install" as const,
    account: p.account,
    osRelease: release(),
    packageManager: packageManager(),
    installMethod: installMethod(),
    connectors,
    extensions,
    runtimes: [...runtimes],
    meshes: meshes.length,
    hostedMesh: meshes.some((mesh) => mesh.mode === "user"),
    uptimeDays: Math.max(0, Math.floor((now.getTime() - Date.parse(p.settings.createdAt)) / 86_400_000)),
  };
}

// The sender runs on a worker thread, which has its own event loop, while this thread waits on a
// shared flag: that is what lets the send finish inside an `exit` listener, where the main loop
// never turns again. Each body is posted in order with no retry under one shared deadline, so the
// worker is done at the timeout at the latest; the wait ends when the last settles or at that same
// timeout, and the process then exits as it was going to.
const SENDER = `
const { workerData } = require("node:worker_threads");
const flag = new Int32Array(workerData.flag);
const signal = AbortSignal.timeout(${SEND_TIMEOUT_MS});
(async () => {
  for (const body of workerData.bodies) {
    try {
      await fetch(workerData.url, { method: "POST", headers: { "content-type": "application/json" }, body, signal });
    } catch {}
  }
})().finally(() => { Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); });
`;

/** Post each body to `url`, blocking the calling thread for at most {@link SEND_TIMEOUT_MS}. */
export function sendTelemetry(url: string, bodies: readonly string[]): void {
  const flag = new SharedArrayBuffer(4);
  new Worker(SENDER, { eval: true, workerData: { url, bodies, flag }, stdout: true, stderr: true });
  Atomics.wait(new Int32Array(flag), 0, 0, SEND_TIMEOUT_MS);
}
