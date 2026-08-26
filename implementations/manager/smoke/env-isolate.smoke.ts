/**
 * Env-boundary smoke (P3) - what a spawned child receives, and what it must never inherit.
 *
 * Reproduces #866 through the real manager PTY runtime: a manager process carrying Claude Code's
 * child-session marker used to hand it to every seat (envAllow absent, inherit-mode launchEnv),
 * silently disabling transcript persistence. The child must receive the fixed launch allow-list
 * only. Two named cells carry the load:
 *
 *   - "Claude host-session markers were withheld" — the marker is gone
 *   - "seat still launches: PATH keeps ~/.local/bin" — connector binaries remain resolvable
 *
 * `spawn.env` remains the explicit way to add a named value, including a host marker a persona has
 * opted into. Machine-wide operator knobs (`COTAL_HOME`, `COTAL_*_BIN`) still cross because no
 * connector assigns them per spawn.
 *
 * Run: pnpm smoke:env-isolate
 */
import { execFileSync } from "node:child_process";
import { createRuntime } from "../src/index.js";
import "@cotal-ai/cmux"; // registers the `cmux` runtime provider (skipped below if no surface)
import "@cotal-ai/tmux"; // registers the `tmux` runtime provider — exercised below when tmux is present
import { launchEnv } from "@cotal-ai/connector-core";
import type { LaunchSpec } from "@cotal-ai/core";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${extra ?? ""}`}`);
  if (!cond) failures++;
}
function skip(label: string, why: string): void {
  console.log(`• ${label} skipped (${why})`);
}

/** tmux capture-pane wraps long values (PATH especially) onto the next visual line. Join a
 *  continuation that does not start a new KEY= so ~/.local/bin is not split off PATH=. */
function unwrapCapture(out: string): string {
  const lines = out.split(/\r?\n/);
  const joined: string[] = [];
  for (const line of lines) {
    if (joined.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) joined[joined.length - 1] += line;
    else joined.push(line);
  }
  return joined.join("\n");
}

function pathEntries(out: string): string[] {
  const m = unwrapCapture(out).match(/(?:^|\n)PATH=([^\n]*)/i);
  if (!m) return [];
  return m[1].split(PATH_SEP);
}

/** A `COTAL_*` name no connector assigns and no keep-list entry names. It has to be INJECTED here
 *  to mean anything: asserting the absence of a string the parent never set cannot fail, and an
 *  earlier version of this file did exactly that. Injected, it proves an unenumerated `COTAL_*`
 *  name is withheld by the allow-list rather than by the enumerated `PER_SESSION` list. */
const SENTINEL = "COTAL_P3_SENTINEL_UNRELATED";
const OPERATOR_SECRET = "P3_OPERATOR_SECRET";
const OPERATOR_VALUE = "withhold-marker-xyz";
const EXPLICIT = "P3_EXPLICIT_CAPABILITY";
const PATH_SEP = process.platform === "win32" ? ";" : ":";
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "";
if (!HOME) throw new Error("env-isolate: HOME/USERPROFILE is unset, so ~/.local/bin cannot be formed and the PATH cell cannot run");
const LOCAL_BIN = `${HOME}/.local/bin`;
// The measured constraint: connector binaries live in ~/.local/bin. Inject it so the cell is
// live on a CI machine whose PATH does not already include that directory, then assert the child
// still received it. launchEnv copies PATH as a whole string, so a missing parent entry would make
// the cell fail for the wrong reason.
if (!(process.env.PATH ?? "").split(PATH_SEP).includes(LOCAL_BIN))
  process.env.PATH = `${LOCAL_BIN}${PATH_SEP}${process.env.PATH ?? ""}`;
process.env[SENTINEL] = "parent-sentinel-value";
process.env[OPERATOR_SECRET] = OPERATOR_VALUE;
process.env[EXPLICIT] = "explicit-value";
process.env.CLAUDE_CODE_CHILD_SESSION = "parent-session-marker-866";
process.env.CLAUDE_CODE_ENTRYPOINT = "parent-entrypoint-866";
process.env.CLAUDECODE = "parent-claudecode-866";
process.env.OPENCODE_SERVER_URL = "http://parent-opencode.invalid";
process.env.CODEX_HOME = "/tmp/parent-codex-home-must-not-cross";
process.env.PI_SESSION_ID = "parent-pi-session-must-not-cross";

/** One name from every per-session family a connector assigns CONDITIONALLY. Each is set here, in
 *  the parent, and none may appear in the child. `COTAL_LAUNCH_MATERIAL` is the sharpest: it names a
 *  0600 file holding a credential and a control token. */
const PER_SESSION = [
  "COTAL_LAUNCH_MATERIAL", "COTAL_CREDS", "COTAL_SERVERS", "COTAL_CONTROL_TOKEN", "COTAL_OWNER",
  "COTAL_ACTOR", "COTAL_SENTINEL_CREDS", "COTAL_BEARER_CMD", "COTAL_LIFECYCLE_UID", "COTAL_ID",
  "COTAL_ROLE", "COTAL_SUBSCRIBE", "COTAL_ALLOW_PUBLISH", "COTAL_CAPABILITIES", "COTAL_EVENTS",
] as const;
for (const k of PER_SESSION) process.env[k] = `parent-${k}`;
/** Machine-wide operator knobs: no connector assigns them per spawn, so they cross. */
process.env.COTAL_HOME = "/tmp/operator-cotal-home";
process.env.COTAL_CODEX_BIN = "/tmp/operator-codex-bin";

const cwd = process.cwd();

/** Spawn `printenv` under a runtime with a connector-style spec, collect its env output, stop. */
async function childEnvOf(spawnFn: (spec: LaunchSpec) => { attach: () => unknown; stop: (o?: { graceful?: boolean }) => void }, env: Record<string, string>): Promise<string> {
  // Dump the child's env cross-platform — `printenv` is Unix-only; node (always present, and able to
  // start from the inherited env) prints each KEY=value the same way on Windows and POSIX.
  const dumpEnv = "for (const [k, v] of Object.entries(process.env)) console.log(`${k}=${v}`);";
  const spec: LaunchSpec = { command: process.execPath, args: ["-e", dumpEnv], env };
  const h = spawnFn(spec);
  const sess = h.attach() as { onData: (fn: (b: Buffer) => void) => () => void; onExit: (fn: () => void) => () => void };
  let buf = "";
  sess.onData((b) => { buf += b.toString("utf8"); });
  await new Promise<void>((resolve) => sess.onExit(() => resolve()));
  await new Promise((r) => setTimeout(r, 150)); // drain
  h.stop({ graceful: false });
  return buf;
}

function stripPty(raw: string): string {
  return raw.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** The assertions every runtime must satisfy, so a backend cannot pass by testing less. */
function assertBoundary(label: string, out: string, opts: { explicit: boolean }): void {
  out = unwrapCapture(out);
  console.log(`${label}:`);
  check("ordinary operator variable was withheld", !out.includes(`${OPERATOR_SECRET}=${OPERATOR_VALUE}`));
  if (opts.explicit) check("explicit spawn.env value reached child", out.includes(`${EXPLICIT}=explicit-value`));
  else check("explicit spawn.env value did NOT leak onto the default path", !out.includes(`${EXPLICIT}=explicit-value`));
  const hostMarkers = ["CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE"]
    .filter((k) => new RegExp(`(^|\\n)${k}=`).test(out));
  check("Claude host-session markers were withheld", hostMarkers.length === 0, hostMarkers);
  const analog = ["OPENCODE_SERVER_URL", "CODEX_HOME", "PI_SESSION_ID"]
    .filter((k) => new RegExp(`(^|\\n)${k}=`).test(out));
  check("analogous host markers for other connectors were withheld", analog.length === 0, analog);
  const leaked = PER_SESSION.filter((k) => new RegExp(`(^|\\n)${k}=`).test(out));
  check("every per-session COTAL_* was RESET, not inherited", leaked.length === 0, leaked);
  check("no per-session VALUE survived under another name", !out.includes("parent-COTAL_"));
  check("machine-wide COTAL_HOME crossed", /(^|\n)COTAL_HOME=\/tmp\/operator-cotal-home/.test(out));
  check("machine-wide COTAL_CODEX_BIN crossed", /(^|\n)COTAL_CODEX_BIN=\/tmp\/operator-codex-bin/.test(out));
  check("an unenumerated COTAL_* name was RESET too (prefix, not a hardcoded list)", !out.includes(SENTINEL));
  check("PATH present (the child can still run)", /(^|\n)PATH=/i.test(out));
  check(
    "seat still launches: PATH keeps ~/.local/bin",
    pathEntries(out).includes(LOCAL_BIN),
    { LOCAL_BIN, path: pathEntries(out) },
  );
  const homeVar = process.platform === "win32" ? "USERPROFILE" : "HOME";
  check(`${homeVar} present`, new RegExp(`(^|\\n)${homeVar}=`).test(out));
}

// pty — the default, always-available backend. Default launchEnv (no spawn.env) is the 0.30.1 leak.
{
  const runtime = createRuntime("pty", "cotal-p3");
  const raw = await childEnvOf((spec) => runtime.spawn("p3-pty", spec, cwd), launchEnv());
  assertBoundary("pty runtime (default launchEnv, no spawn.env)", stripPty(raw), { explicit: false });
}

{
  const runtime = createRuntime("pty", "cotal-p3-explicit");
  const raw = await childEnvOf((spec) => runtime.spawn("p3-pty-explicit", spec, cwd), launchEnv({ envAllow: [EXPLICIT] }));
  assertBoundary("pty runtime (spawn.env extra)", stripPty(raw), { explicit: true });
}

// tmux — the `env -i` path: it CLEARS inheritance and sets exactly what the spec carried, so it is
// the one backend that could disagree with pty about what "inherit" means. Skipped when absent.
let tmuxOk = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); tmuxOk = true; } catch { /* not installed */ }
if (tmuxOk) {
  const runtime = createRuntime("tmux", "cotal-p3-smoke");
  // Dump via node (one KEY=value per line) rather than printenv: a long PATH wraps in a tmux pane
  // and a line-oriented PATH= match would miss ~/.local/bin on the continuation. sleep keeps the
  // window alive long enough to capture-pane.
  const dumpEnv = "for (const [k, v] of Object.entries(process.env)) console.log(`${k}=${v}`);";
  const spec: LaunchSpec = { command: process.execPath, args: ["-e", `${dumpEnv}; setTimeout(()=>{}, 5000)`], env: launchEnv({ envAllow: [EXPLICIT] }) };
  const h = runtime.spawn("p3-tmux", spec, cwd);
  await new Promise((r) => setTimeout(r, 900)); // let printenv run + render
  let out = "";
  // `-S -` captures the FULL scrollback: the inherited env is long and an early line would otherwise
  // scroll off a short pane.
  try { out = execFileSync("tmux", ["capture-pane", "-p", "-S", "-", "-t", "cotal-p3-smoke:p3-tmux"], { encoding: "utf8" }); } catch { /* window gone */ }
  assertBoundary("tmux runtime", out, { explicit: true });
  h.stop({ graceful: false });
  try { execFileSync("tmux", ["kill-session", "-t", "cotal-p3-smoke"], { stdio: "ignore" }); } catch { /* already gone */ }
} else {
  skip("tmux runtime env boundary", "tmux not installed");
}

for (const k of PER_SESSION) delete process.env[k];
delete process.env[SENTINEL];
delete process.env[OPERATOR_SECRET];
delete process.env[EXPLICIT];
delete process.env.CLAUDE_CODE_CHILD_SESSION;
delete process.env.CLAUDE_CODE_ENTRYPOINT;
delete process.env.CLAUDECODE;
delete process.env.OPENCODE_SERVER_URL;
delete process.env.CODEX_HOME;
delete process.env.PI_SESSION_ID;
delete process.env.COTAL_CODEX_BIN;
console.log(`\nENV-BOUNDARY SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
