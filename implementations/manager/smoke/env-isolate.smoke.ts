/**
 * Env-isolation smoke (P3) — proves a spawned child inherits ONLY the connector-declared env,
 * not the manager's `process.env`. No NATS, no test runner — run with: pnpm smoke:env-isolate
 *
 * Puts a sentinel "secret" in the manager's process.env, spawns `printenv` via the PtyRuntime
 * with a connector-style spec (`env: launchEnv()` — the OS allow-list, no sentinel), captures the
 * child's own env output, and asserts: the sentinel is ABSENT (the operator's unrelated secrets
 * don't bleed in) while PATH/HOME ARE present (the OS allow-list carried the child needs to run).
 * tmux is exercised the same way when present (its `env -i` path); cmux needs a cmux surface.
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

const SENTINEL = "COTAL_P3_SENTINEL";
const SENTINEL_VALUE = "leak-marker-xyz";
process.env[SENTINEL] = SENTINEL_VALUE; // the operator's unrelated secret sitting in the shell
const cwd = process.cwd();

/** Spawn `printenv` under a runtime with a connector-style spec, collect its env output, stop. */
async function childEnvOf(spawnFn: (spec: LaunchSpec) => { attach: () => unknown; stop: (o?: { graceful?: boolean }) => void }): Promise<string> {
  // A connector-style spec: env is the OS allow-list only (launchEnv) — the sentinel is NOT in it.
  // Dump the child's env cross-platform — `printenv` is Unix-only; node (always present, and able to
  // start from the allow-list alone) prints each KEY=value the same way on Windows and POSIX.
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

// pty — the default, always-available backend.
{
  const runtime = createRuntime("pty", "cotal-p3");
  const raw = await childEnvOf((spec) => runtime.spawn("p3-pty", spec, cwd));
  // ConPTY interleaves terminal-init escapes + a window-title OSC with the output, so the first var
  // (PATH) lands after escapes, not at a clean line start — strip control sequences before asserting.
  const out = raw.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  console.log("pty runtime:");
  check("sentinel ABSENT from child env (no process.env bleed)", !out.includes(SENTINEL));
  // Case-insensitive: launchEnv forwards each var under the OS's own key casing, so on Windows this
  // is `Path=`, not `PATH=` (the allow-list copy preserves the source key — see launchEnv).
  check("PATH present (OS allow-list carried)", /(^|\n)PATH=/i.test(out));
  // Home dir var is platform-specific: HOME on POSIX, USERPROFILE on Windows.
  const homeVar = process.platform === "win32" ? "USERPROFILE" : "HOME";
  check(`${homeVar} present (OS allow-list carried)`, new RegExp(`(^|\\n)${homeVar}=`).test(out));
  check("sentinel value not present", !out.includes(SENTINEL_VALUE));
}

// tmux — same `env -i` isolation path; skipped when tmux isn't installed. tmux is watched
// natively (attach() throws), so read the pane text via `tmux capture-pane` instead of streaming.
let tmuxOk = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); tmuxOk = true; } catch { /* not installed */ }
if (tmuxOk) {
  const runtime = createRuntime("tmux", "cotal-p3-smoke");
  // `sh -c 'printenv; sleep 5'` keeps the window alive long enough to capture-pane (printenv
  // alone exits instantly and the window closes). sh resolves via PATH in the allow-list.
  const spec: LaunchSpec = { command: "sh", args: ["-c", "printenv; sleep 5"], env: launchEnv() };
  const h = runtime.spawn("p3-tmux", spec, cwd);
  await new Promise((r) => setTimeout(r, 900)); // let printenv run + render
  let out = "";
  // `-S -` captures the FULL scrollback, not just the visible screen — printenv dumps the whole
  // allow-list (~20 lines) and PATH (an early line) would otherwise scroll off a short pane.
  try { out = execFileSync("tmux", ["capture-pane", "-p", "-S", "-", "-t", "cotal-p3-smoke:p3-tmux"], { encoding: "utf8" }); } catch { /* window gone */ }
  console.log("tmux runtime:");
  check("sentinel ABSENT from child env (env -i cleared inheritance)", !out.includes(SENTINEL));
  check("PATH present (OS allow-list set after -i)", /PATH=/.test(out));
  h.stop({ graceful: false });
  try { execFileSync("tmux", ["kill-session", "-t", "cotal-p3-smoke"], { stdio: "ignore" }); } catch { /* already gone */ }
} else {
  skip("tmux runtime env-isolation", "tmux not installed");
}

delete process.env[SENTINEL];
console.log(`\nENV-ISOLATE SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
