/** Drive the built runtime's native attach instructions after real tmux pane moves (#3743).
 *  Uses a private tmux server and sleeping shell children, never a mesh or an agent harness. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentHandle } from "@cotal-ai/core";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { TmuxRuntime } from "./dist/index.js";

if (process.platform === "win32") skipSuite("tmux native attach requires a POSIX host");
const root = mkdtempSync(join(tmpdir(), "cotal-tmux-hint-"));
const previous = new Map(["HOME", "TMUX_TMPDIR", "TMUX"].map(key => [key, process.env[key]]));
process.env.HOME = root;
process.env.TMUX_TMPDIR = root;
delete process.env.TMUX;
const session = "attach-hint";
const run = (...args: string[]) => execFileSync("tmux", ["-u", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 }).trim();
let socket: string | undefined;
let passed = 0, failed = 0;
function check(name: string, ok: boolean): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}
function hint(handle: AgentHandle): string {
  try { handle.attach(); } catch (error) { return (error as Error).message; }
  throw new Error("the external runtime unexpectedly streamed a terminal");
}

try {
  run("-f", "/dev/null", "new-session", "-d", "-s", session, "-x", "200", "-y", "50", "sleep 120");
  socket = run("display-message", "-p", "#{socket_path}");
  if (!socket.startsWith(root + "/")) throw new Error("tmux did not start inside the private socket directory");
  run("set-option", "-t", session, "window-size", "manual");
  const runtime = new TmuxRuntime(session);
  const spawned = runtime.spawn("seat-hint", { command: "/bin/sh", args: ["-c", "exec sleep 120"], env: { PATH: "/usr/bin:/bin" } }, root);
  if (!spawned.reference) throw new Error("spawn returned no reference");
  const adopted = runtime.adopt(spawned.reference);
  const parts = /^(\d+)\.(@\d+)\.(%\d+)$/.exec(spawned.reference.id);
  if (!parts) throw new Error("spawn returned an invalid tmux reference");
  const [, server, originalWindow, pane] = parts;
  check("the runtime opened the private server's pane", server === run("display-message", "-p", "#{pid}"));
  check("the original window initially holds the seat", run("display-message", "-p", "-t", originalWindow!, "#{pane_id}") === pane);
  check("spawned and adopted handles report the live seat", spawned.status() === "running" && adopted.status() === "running");

  const follow = (phase: string) => {
    for (const [kind, handle] of [["spawned", spawned], ["adopted", adopted]] as const) {
      const text = hint(handle);
      const commands = [...text.matchAll(/`tmux (select-window|select-pane) -t ([%@]\d+)`/g)];
      check(`${phase}: ${kind} guidance targets the pane without a stale window name`, commands.length > 0 && commands.every(command => command[2] === pane) && !text.includes('(window "'));
      let selected = false;
      try {
        for (const command of commands) run(command[1]!, "-t", command[2]!);
        selected = commands.length > 0 && run("display-message", "-p", "-t", session, "#{pane_id}") === pane;
      } catch { /* A stale window command is a failed hint, not a fixture abort. */ }
      check(`${phase}: ${kind} instructions select the actual seat`, selected);
    }
  };
  follow("initial");
  const other = run("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${session}:`, "-n", "unrelated", "sleep 120");
  run("swap-pane", "-d", "-s", pane!, "-t", other);
  check("swap leaves the original window holding the unrelated pane", run("display-message", "-p", "-t", originalWindow!, "#{pane_id}") === other);
  follow("swapped");
  run("rename-window", "-t", pane!, "renamed-seat");
  follow("renamed");
  run("join-pane", "-d", "-s", pane!, "-t", other);
  run("select-pane", "-t", other);
  check("join leaves the unrelated pane active before following the hint", run("display-message", "-p", "-t", originalWindow!, "#{pane_id}") === other);
  follow("joined");
  run("break-pane", "-d", "-s", pane!, "-t", `${session}:`);
  follow("broken-out");
  check("both handles still track the running moved seat", spawned.status() === "running" && adopted.status() === "running");
  if (passed + failed !== 26) throw new Error(`ran ${passed + failed} checks, expected 26`);
} finally {
  try {
    if (socket) run("-S", socket, "kill-server");
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}
console.log(`tmux-attach-hint: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
