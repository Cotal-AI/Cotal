/**
 * Fail-closed live-shaped command policy for the mutation tools.
 *
 * Discovery can be broad; execution cannot. A config whose command resolves to a live-named
 * suite, or to a suite whose source declares real infrastructure (REAL Manager, REAL agent
 * processes, REAL pty children, REAL broker), is refused before any child is spawned. The
 * `:live` / `-live` suffix is not enough on its own: several broker-starting suites carry no
 * such marker in the script name.
 *
 * Unresolvable `smoke:*` tokens refuse rather than run. A command with no smoke token and no
 * inspectable suite source is allowed only when it also lacks a live-shaped name.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const INFRASTRUCTURE_MARKERS = Object.freeze([
  "REAL Manager",
  "REAL agent processes",
  "REAL pty children",
  "REAL broker",
]);

const SMOKE_TOKEN = /\bsmoke:[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*/g;
const LIVE_NAMED = /(?::live|-live)$/;
const LAUNCHED_FILE = /(?:^|[\s;|&])(?:tsx|(?:\S*\/)?node)\s+([^\s;|&]+)/g;

export function smokeTokens(command) {
  if (typeof command !== "string") return [];
  return command.match(SMOKE_TOKEN) ?? [];
}

export function isLiveNamedToken(token) {
  return typeof token === "string" && LIVE_NAMED.test(token);
}

export function infrastructureMarkerIn(source) {
  if (typeof source !== "string") return undefined;
  return INFRASTRUCTURE_MARKERS.find((marker) => source.includes(marker));
}

function packageScripts(cwd, readFile) {
  try {
    const pkg = JSON.parse(readFile(join(cwd, "package.json"), "utf8"));
    if (!pkg || typeof pkg.scripts !== "object" || pkg.scripts === null) return {};
    return pkg.scripts;
  } catch {
    return undefined;
  }
}

function launchedFiles(command) {
  if (typeof command !== "string") return [];
  return [...command.matchAll(LAUNCHED_FILE)]
    .map((m) => m[1])
    .filter((file) => file !== undefined && !file.startsWith("-"));
}

function resolveFile(cwd, file) {
  if (typeof file !== "string" || file === "") return undefined;
  return isAbsolute(file) ? file : join(cwd, file);
}

/**
 * @param {string} command
 * @param {{ cwd?: string, readFile?: typeof readFileSync, exists?: typeof existsSync }} [options]
 * @returns {string | null} refusal reason, or null when the command may run
 */
export function liveShapedCommandReason(command, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const readFile = options.readFile ?? readFileSync;
  const exists = options.exists ?? existsSync;

  if (typeof command !== "string" || command.trim() === "") {
    return "command is missing";
  }

  const tokens = smokeTokens(command);
  for (const token of tokens) {
    if (isLiveNamedToken(token)) return `${token} is live-named`;
  }

  const scripts = tokens.length ? packageScripts(cwd, readFile) : {};
  if (tokens.length && scripts === undefined) {
    return "package.json scripts are unreadable; refusing to execute a smoke command";
  }

  const files = [];
  for (const token of tokens) {
    const body = scripts[token];
    if (typeof body !== "string" || body.trim() === "") {
      return `${token} does not resolve to a package script`;
    }
    if (smokeTokens(body).some(isLiveNamedToken)) {
      return `${token} is live-named`;
    }
    files.push(...launchedFiles(body));
  }
  files.push(...launchedFiles(command));
  if (tokens.length && files.length === 0) {
    return `${tokens.join(", ")} does not resolve to a suite source`;
  }

  const seen = new Set();
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    const absolute = resolveFile(cwd, file);
    if (absolute === undefined) continue;
    if (!exists(absolute)) {
      return `${file} does not resolve to a suite source`;
    }
    let source;
    try {
      source = readFile(absolute, "utf8");
    } catch {
      return `${file} is unreadable; refusing to execute`;
    }
    const marker = infrastructureMarkerIn(source);
    if (marker !== undefined) return `${file} declares ${marker}`;
  }

  return null;
}

/**
 * @param {{ command?: string, mutations?: { command?: string }[] }} fixture
 * @param {{ cwd?: string, readFile?: typeof readFileSync, exists?: typeof existsSync }} [options]
 * @returns {string | null}
 */
export function liveShapedFixtureReason(fixture, options = {}) {
  const commands = [
    fixture?.command,
    ...(Array.isArray(fixture?.mutations) ? fixture.mutations.map((m) => m?.command) : []),
  ].filter((cmd) => typeof cmd === "string");
  if (commands.length === 0) {
    return liveShapedCommandReason("", options);
  }
  for (const command of commands) {
    const reason = liveShapedCommandReason(command, options);
    if (reason) return reason;
  }
  return null;
}
