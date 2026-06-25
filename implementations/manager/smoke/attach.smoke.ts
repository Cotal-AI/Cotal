/**
 * Runtime attach smoke (no NATS, no test runner) — run with: pnpm smoke:attach
 *
 * Guards that `cotal attach` gives runtime-correct guidance: only `pty` streams over the WS
 * attach endpoint; `tmux`/`cmux` are watched natively, so each handle's attach() must throw its
 * OWN hint (this is what manager.opAttach surfaces). Regression target: before, opAttach assumed
 * "not pty == tmux" and told cmux users to run a tmux command. Spawns a throwaway `sleep` so it
 * needs no claude/mesh; tmux/cmux are skipped (logged) when not present on the machine.
 */
import { execFileSync } from "node:child_process";
import { createRuntime } from "../src/index.js";
import "@cotal-ai/cmux"; // registers the `cmux` runtime provider
import "@cotal-ai/tmux"; // registers the `tmux` runtime provider
import type { LaunchSpec } from "@cotal-ai/core";

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}
function skip(label: string, why: string): void {
  console.log(`• ${label} skipped (${why})`);
}
function attachError(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

const SESSION = "cotal-smoke";
const spec: LaunchSpec = { command: "sleep", args: ["60"] };
const cwd = process.cwd();

// pty (default) — the one streamable backend: attach() returns a live session, never throws.
{
  const h = createRuntime("pty", SESSION).spawn("smoke-pty", spec, cwd);
  let sess: { onData?: unknown; cols?: unknown } | undefined;
  const err = attachError(() => (sess = h.attach()));
  check(
    "pty: attach() returns a live session (streams, no throw)",
    err === "" && typeof sess?.onData === "function" && typeof sess?.cols === "number",
  );
  h.stop({ graceful: false });
}

// Runtime-selection contract (no fallbacks): `auto` is deterministic pty — even inside $TMUX. tmux
// and cmux are explicit-only, so being in a tmux session must NOT auto-select tmux.
{
  const prevTmux = process.env.TMUX;
  delete process.env.TMUX;
  check("auto resolves to pty (no $TMUX)", createRuntime("auto", SESSION).kind === "pty");
  process.env.TMUX = "/tmp/fake-tmux-socket";
  check("auto resolves to pty even inside $TMUX (no auto-detect, no fallback)", createRuntime("auto", SESSION).kind === "pty");
  if (prevTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = prevTmux;
}

// tmux — watched natively: attach() points you at `tmux attach-session -t <session>` + `select-window -t @N`.
{
  let rt: ReturnType<typeof createRuntime> | null = null;
  try {
    rt = createRuntime("tmux", SESSION);
  } catch (e) {
    skip("tmux", (e as Error).message);
  }
  if (rt) {
    const h = rt.spawn("smoke-tmux", spec, cwd);
    const err = attachError(() => h.attach());
    check(
      "tmux: attach() points at `tmux attach-session` + a select-window-by-id hint (not a stream)",
      err.includes("tmux attach-session -t cotal-smoke") && err.includes("select-window"),
    );
    check("tmux: hint is tmux-specific, never a cmux tab", !err.includes("cmux tab"));
    h.stop({ graceful: false });
    try {
      execFileSync("tmux", ["kill-session", "-t", SESSION], { stdio: "ignore" });
    } catch {
      /* session already gone */
    }
  }
}

// cmux — watched natively: attach() points you at the `cotal-<name>` tab, NOT tmux.
{
  let rt: ReturnType<typeof createRuntime> | null = null;
  try {
    rt = createRuntime("cmux", SESSION);
  } catch (e) {
    skip("cmux", (e as Error).message);
  }
  if (rt) {
    let h: ReturnType<typeof rt.spawn> | null = null;
    try {
      h = rt.spawn("smoke-cmux", spec, cwd);
    } catch (e) {
      skip("cmux", `spawn: ${(e as Error).message}`); // e.g. not inside a live cmux surface
    }
    if (h) {
      const err = attachError(() => h!.attach());
      check(
        'cmux: attach() points to the "cotal-smoke-cmux" tab (not tmux)',
        err.includes('switch to the "cotal-smoke-cmux" cmux tab') && !err.includes("tmux attach"),
      );
      h.stop({ graceful: false });
    }
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
