/**
 * Env-boundary smoke (P3) - what a spawned child inherits, and what it must never inherit.
 *
 * THIS CELL WAS DELIBERATELY FLIPPED. It used to assert that an operator's sentinel variable was
 * ABSENT from the child, because the launcher forwarded a fixed OS allow-list and nothing else. That
 * is no longer the behaviour: a harness the operator installed should run under `cotal spawn` the
 * way it runs in their own shell, so the child now inherits their environment. The name is kept
 * because the cell still tests isolation; what it isolates changed.
 *
 * A FLIP MUST NOT ASSERT LESS THAN WHAT IT REPLACES, so this is deliberately the stronger cell. The
 * old one turned on a SINGLE marker being absent. This one asserts the inversion of that marker AND
 * enumerates the per-session `COTAL_*` set that must still be reset - the half that did not flip and
 * the half that actually carries risk. A connector assigns those conditionally (`aclEnv` omits an
 * empty ACL, `materialEnv` returns `{}` with nothing to hand over, `if (opts.role)`), so an inherited
 * value is never overwritten and would reach a child that was never granted it.
 *
 * WHAT THE OLD ASSERTION WAS PROTECTING, and what survives. It stood for "the operator's unrelated
 * secrets do not reach the agent". That protection is GONE BY DECISION, not by accident, and only
 * ever held for secrets that live in the environment and nowhere else: HOME was always forwarded, so
 * a child with a shell has always been able to read ~/.aws and ~/.ssh off disk. An operator who
 * needs the old behaviour declares `spawn.env` in the cotal config. What survives unconditionally is
 * the part that was never about preference: one agent's identity cannot become another's.
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

const SENTINEL = "COTAL_P3_SENTINEL_UNRELATED"; // deliberately NOT under the COTAL_ reset: see below
const OPERATOR_SECRET = "P3_OPERATOR_SECRET";
const OPERATOR_VALUE = "inherited-marker-xyz";
process.env[OPERATOR_SECRET] = OPERATOR_VALUE; // an ordinary operator variable, now inherited

/** One name from every per-session family a connector assigns CONDITIONALLY. Each is set here, in
 *  the parent, and none may appear in the child. `COTAL_LAUNCH_MATERIAL` is the sharpest: it names a
 *  0600 file holding a credential and a control token. */
const PER_SESSION = [
  "COTAL_LAUNCH_MATERIAL", "COTAL_CREDS", "COTAL_SERVERS", "COTAL_CONTROL_TOKEN", "COTAL_OWNER",
  "COTAL_ACTOR", "COTAL_SENTINEL_CREDS", "COTAL_BEARER_CMD", "COTAL_LIFECYCLE_UID", "COTAL_ID",
  "COTAL_ROLE", "COTAL_SUBSCRIBE", "COTAL_ALLOW_PUBLISH", "COTAL_CAPABILITIES", "COTAL_EVENTS",
] as const;
for (const k of PER_SESSION) process.env[k] = `parent-${k}`;
/** A machine-wide operator knob: no connector assigns it per spawn, so it crosses. */
process.env.COTAL_HOME = "/tmp/operator-cotal-home";

const cwd = process.cwd();

/** Spawn `printenv` under a runtime with a connector-style spec, collect its env output, stop. */
async function childEnvOf(spawnFn: (spec: LaunchSpec) => { attach: () => unknown; stop: (o?: { graceful?: boolean }) => void }): Promise<string> {
  // Dump the child's env cross-platform — `printenv` is Unix-only; node (always present, and able to
  // start from the inherited env) prints each KEY=value the same way on Windows and POSIX.
  const dumpEnv = "for (const [k, v] of Object.entries(process.env)) console.log(`${k}=${v}`);";
  const spec: LaunchSpec = { command: process.execPath, args: ["-e", dumpEnv], env: launchEnv() };
  const h = spawnFn(spec);
  const sess = h.attach() as { onData: (fn: (b: Buffer) => void) => () => void; onExit: (fn: () => void) => () => void };
  let buf = "";
  sess.onData((b) => { buf += b.toString("utf8"); });
  await new Promise<void>((resolve) => sess.onExit(() => resolve()));
  await new Promise((r) => setTimeout(r, 150)); // drain
  h.stop({ graceful: false });
  return buf;
}

/** The assertions every runtime must satisfy, so a backend cannot pass by testing less. */
function assertBoundary(label: string, out: string): void {
  console.log(`${label}:`);
  // THE FLIP: an ordinary operator variable now reaches the child. This is the inversion of the
  // assertion this file used to make, stated on a real value rather than on mere presence.
  check("operator variable INHERITED (value intact)", out.includes(`${OPERATOR_SECRET}=${OPERATOR_VALUE}`));
  // THE HALF THAT DID NOT FLIP, enumerated rather than sampled.
  const leaked = PER_SESSION.filter((k) => new RegExp(`(^|\\n)${k}=`).test(out));
  check("every per-session COTAL_* was RESET, not inherited", leaked.length === 0, leaked);
  // ...and not merely blanked: a name absent from the keys must also not appear as a parent value.
  check("no per-session VALUE survived under another name", !out.includes("parent-COTAL_"));
  // The operator knob crosses, so the reset is a scalpel and not a blanket that breaks `cotal`.
  check("machine-wide COTAL_HOME crossed", /(^|\n)COTAL_HOME=\/tmp\/operator-cotal-home/.test(out));
  check("the sentinel name itself is not silently present", !out.includes(SENTINEL));
  // Case-insensitive: Windows spells this `Path`, not `PATH`.
  check("PATH present (the child can still run)", /(^|\n)PATH=/i.test(out));
  const homeVar = process.platform === "win32" ? "USERPROFILE" : "HOME";
  check(`${homeVar} present`, new RegExp(`(^|\\n)${homeVar}=`).test(out));
}

// pty — the default, always-available backend.
{
  const runtime = createRuntime("pty", "cotal-p3");
  const raw = await childEnvOf((spec) => runtime.spawn("p3-pty", spec, cwd));
  // ConPTY interleaves terminal-init escapes + a window-title OSC with the output, so strip control
  // sequences before asserting.
  assertBoundary("pty runtime", raw.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
}

// tmux — the `env -i` path: it CLEARS inheritance and sets exactly what the spec carried, so it is
// the one backend that could disagree with pty about what "inherit" means. Skipped when absent.
let tmuxOk = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); tmuxOk = true; } catch { /* not installed */ }
if (tmuxOk) {
  const runtime = createRuntime("tmux", "cotal-p3-smoke");
  // `sh -c 'printenv; sleep 5'` keeps the window alive long enough to capture-pane (printenv alone
  // exits instantly and the window closes). sh resolves via PATH.
  const spec: LaunchSpec = { command: "sh", args: ["-c", "printenv; sleep 5"], env: launchEnv() };
  const h = runtime.spawn("p3-tmux", spec, cwd);
  await new Promise((r) => setTimeout(r, 900)); // let printenv run + render
  let out = "";
  // `-S -` captures the FULL scrollback: the inherited env is long and an early line would otherwise
  // scroll off a short pane.
  try { out = execFileSync("tmux", ["capture-pane", "-p", "-S", "-", "-t", "cotal-p3-smoke:p3-tmux"], { encoding: "utf8" }); } catch { /* window gone */ }
  assertBoundary("tmux runtime", out);
  h.stop({ graceful: false });
  try { execFileSync("tmux", ["kill-session", "-t", "cotal-p3-smoke"], { stdio: "ignore" }); } catch { /* already gone */ }
} else {
  skip("tmux runtime env boundary", "tmux not installed");
}

for (const k of PER_SESSION) delete process.env[k];
delete process.env[OPERATOR_SECRET];
console.log(`\nENV-BOUNDARY SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
