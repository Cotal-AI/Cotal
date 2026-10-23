import { homedir, release } from "node:os";
import { basename } from "node:path";
import { Worker } from "node:worker_threads";
import { findSubcommand, type Command, type Registry } from "@cotal-ai/core";
import {
  effectiveTelemetry,
  extensionProvides,
  loadExtensionsManifest,
  markTelemetryInstallEvent,
  markTelemetryNoticeShown,
  readMeshRegistry,
  type ErrorCode,
  type Outcome,
  type TelemetryLevel,
  type TelemetrySettings,
} from "@cotal-ai/workspace";
import { metadataPositionals } from "./lib/command-path.js";
import { cliVersion } from "./seed/paths.js";

/**
 * Anonymous usage telemetry for the CLI: one small event per command, sent as the process exits, and
 * at `regular` one install event per UTC day. docs/telemetry.md lists every field. Nothing here
 * reads an argument value, a path or a name; the error text a failure carries at `regular` goes
 * through {@link scrubErrorText} first. Nothing here can change a command's outcome: every failure
 * is swallowed, and the send is bounded by {@link SEND_TIMEOUT_MS}.
 */

export const TELEMETRY_URL = "https://cotal.ai/v1/telemetry";
export const SEND_TIMEOUT_MS = 1500;
export const TELEMETRY_NOTICE =
  'Cotal collects anonymous usage data at the "regular" level (command names, outcomes, error text with values and paths masked, version, OS, installed connectors; never arguments, paths, names or content). Change it with "cotal telemetry minimal" or "cotal telemetry off". Details: https://docs.cotal.ai/telemetry';

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

/** An error message with what could identify someone masked: quoted words (the CLI quotes every
 *  user value it echoes), URLs, email addresses, IPv4 addresses, paths (the home directory first,
 *  so a path under it reads as one) and any token-shaped run of 32 characters or more. */
export function scrubErrorText(text: string, max = MAX_MESSAGE): string {
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
  readonly message: string;
  readonly stack: string | null;
}

function errorText(error: unknown): ErrorText {
  if (error instanceof Error) return { message: scrubErrorText(error.message), stack: error.stack ? scrubStack(error.stack) : null };
  return { message: scrubErrorText(String(error)), stack: null };
}

/** The intake: the public one, or `COTAL_TELEMETRY_URL` for a self-hosted intake. */
export function telemetryUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.COTAL_TELEMETRY_URL || TELEMETRY_URL;
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

interface Pending {
  readonly level: Exclude<TelemetryLevel, "off">;
  readonly settings: TelemetrySettings;
  readonly command: string;
  readonly subcommand: string | null;
  readonly flags: string[];
  readonly startedAt: number;
  readonly version: string;
  failure?: { outcome: Outcome; code: ErrorCode };
  error?: ErrorText;
}

let pending: Pending | undefined;

/** Record the typed failure the kernel is exiting with, so the event carries its code, and its
 *  text unless {@link recordTelemetryError} already recorded the error it was classified from. */
export function recordTelemetryFailure(outcome: Outcome, code: ErrorCode, error?: unknown): void {
  if (!pending) return;
  pending.failure = { outcome, code };
  if (error !== undefined) recordTelemetryError(error);
}

/** Record the error a command threw, once: the first one recorded is the original, and a wrapper
 *  the kernel builds from it afterwards does not replace it. */
export function recordTelemetryError(error: unknown): void {
  if (pending && !pending.error) pending.error = errorText(error);
}

/**
 * Arm the exit hook for `cmd`, once: decide the level, print the one-time notice, and register the
 * send on `exit`, which fires for a normal return, a set exit code, `process.exit()` anywhere and an
 * uncaught failure. Throws the typed refusal of a bad `COTAL_TELEMETRY` or settings file; the kernel
 * reports it as it reports any refusal.
 */
export function armTelemetry(registry: Registry, cmd: Command, words: readonly string[], startedAt: number): void {
  if (pending || silent(cmd)) return;
  const effective = effectiveTelemetry(process.env);
  if (effective.level === "off" || !effective.settings) return;
  let settings = effective.settings;
  if (effective.source === "file" && effective.level === "regular" && !settings.noticeShownAt && process.stderr.isTTY) {
    console.error(TELEMETRY_NOTICE);
    settings = markTelemetryNoticeShown();
  }
  const raw = cmd.rawArgs === true;
  pending = {
    level: effective.level,
    settings,
    command: cmd.name,
    subcommand: raw ? null : subcommandName(cmd, words),
    flags: raw ? [] : flagNames(cmd, words),
    startedAt,
    version: cliVersion(),
  };
  process.once("exit", (code) => {
    try {
      sendTelemetry(telemetryUrl(), eventsAtExit(registry, pending!, code, new Date()));
    } catch {
      // Telemetry never changes a command's outcome.
    }
  });
}

const sameUtcDay = (a: string, b: Date): boolean => a.slice(0, 10) === b.toISOString().slice(0, 10);

/** The bodies to send: at `regular`, the day's install event first when none was sent today. */
function eventsAtExit(registry: Registry, p: Pending, code: number, now: Date): string[] {
  const bodies: string[] = [];
  if (p.level === "regular" && !(p.settings.lastInstallEventAt && sameUtcDay(p.settings.lastInstallEventAt, now))) {
    try {
      const body = JSON.stringify(installEvent(registry, p, now));
      markTelemetryInstallEvent(now);
      bodies.push(body);
    } catch {
      // An unreadable manifest or registry costs the install event, never the command event.
    }
  }
  bodies.push(JSON.stringify(commandEvent(p, code, now)));
  return bodies;
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
    ci: Boolean(process.env.CI),
  };
}

/** The outcome and code an exit carries: the typed failure the kernel recorded, else what the exit
 *  code alone says (2 is a refusal, 3 and 4 each stand for one code, and any other non-zero code is
 *  an error whose code the kernel never saw). */
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
