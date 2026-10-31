/** Native write diagnostics on a fresh private tmux socket; no model or operator session. */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tmux from "./dist/driver.js";
import { TmuxRuntime } from "./dist/runtime.js";
import { SpawnRefused } from "@cotal-ai/core";

if (process.platform === "win32" || !tmux.available()) {
  console.log("tmux driver writes: skipped, POSIX with tmux is required");
  process.exit(0);
}

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean): void {
  console.log(`  ${condition ? "✓" : "x FAIL:"} ${name}`);
  if (condition) passed++;
  else failed++;
}
function caught(fn: () => unknown): Error | undefined {
  try { fn(); } catch (err) { return err instanceof Error ? err : undefined; }
  return undefined;
}
function native(args: string[]): string {
  return execFileSync("tmux", ["-u", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function failure(name: string, args: string[], call: () => unknown, operation: string, reason: string): void {
  const direct = spawnSync("tmux", ["-u", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  check(`${name}: native tmux supplies the diagnostic`, direct.status === 1 && direct.stderr.includes(reason));
  const err = caught(call);
  check(`${name}: the driver names the operation and native reason`,
    err !== undefined && err.message.startsWith(`tmux: couldn't ${operation}:`) && err.message.includes(direct.stderr.trim()));
  const cause = err?.cause as { status?: number; stderr?: unknown } | undefined;
  check(`${name}: the original failed call is retained`, cause?.status === direct.status && String(cause?.stderr) === direct.stderr);
}
async function waitFor(pred: () => boolean): Promise<boolean> {
  const end = Date.now() + 5_000;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return pred();
}

const root = mkdtempSync(join(tmpdir(), "tmux-writes-"));
const previous = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, TMUX_TMPDIR: process.env.TMUX_TMPDIR };
delete process.env.TMUX;
delete process.env.TMUX_PANE;
process.env.TMUX_TMPDIR = root;
const session = "diagnostics";
let socket: string | undefined;
let server: string | undefined;
let stopped = false;
try {
  // Do not load an operator's tmux configuration into this private server.
  native(["-f", "/dev/null", "new-session", "-d", "-s", "fixture-anchor", "-c", root, "/bin/sleep 30"]);
  [socket, server] = native(["display-message", "-p", "#{socket_path}\t#{pid}"]).split("\t");
  check("private server socket belongs to this fixture", socket.startsWith(`${root}/`) && /^\d+$/.test(server));
  tmux.ensureSession(session, root);
  tmux.ensureSession(session, root);
  check("ensureSession preserves an existing session", tmux.serverPid() === server);

  failure("selectWindow", ["select-window", "-t", "@999999"], () => tmux.selectWindow("@999999"), "select window @999999", "can't find window");
  failure("send", ["send-keys", "-l", "-t", "%999999", "--", "probe"], () => tmux.send("probe", "%999999"), "send text to %999999", "can't find pane");
  failure("sendKey", ["send-keys", "-t", "%999999", "--", "Enter"], () => tmux.sendKey("Enter", "%999999"), "send key to %999999", "can't find pane");
  failure("sendKey on matching server", ["send-keys", "-t", "%999999", "--", "Enter"],
    () => tmux.sendKey("Enter", "%999999", { server, timeoutMs: 1_000 }), "send key to %999999", "can't find pane");
  check("a mismatched server does not execute the invalid-target key command",
    caught(() => tmux.sendKey("Enter", "%999999", { server: "0", timeoutMs: 1_000 })) === undefined);

  const marker = join(root, "received");
  const runtime = new TmuxRuntime(session);
  const handle = runtime.spawn("write-control", {
    command: "/bin/sh",
    args: ["-c", 'IFS= read -r line; printf "%s" "$line" > "$1"; exec /bin/sleep 30', "probe", marker],
    env: {},
  }, root);
  const window = tmux.windowRefs(session, "write-control")[0]!;
  const pane = native(["list-panes", "-t", window, "-F", "#{pane_id}"]);
  tmux.selectWindow(window);
  check("selectWindow focuses the real window", native(["display-message", "-p", "-t", `${session}:`, "#{window_id}"]) === window);
  tmux.send("native-write-control", pane);
  // If the wrong-server key were delivered, it would erase the line before the matching Enter.
  tmux.sendKey("C-u", pane, { server: "0", timeoutMs: 1_000 });
  tmux.sendKey("Enter", pane, { server, timeoutMs: 1_000 });
  check("text and matching-server Enter arrive while wrong-server erase does not", await waitFor(() => existsSync(marker)) && readFileSync(marker, "utf8") === "native-write-control");
  handle.stop({ graceful: false });
  await handle.waitForExit!();
  check("runtime hard stop closes its window", !tmux.windowAliveRef(window));

  const unsafe = join(root, "unsafe");
  const socketDir = join(unsafe, `tmux-${process.getuid!()}`);
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  chmodSync(socketDir, 0o777);
  process.env.TMUX_TMPDIR = unsafe;
  try {
    failure("ensureSession", ["new-session", "-d", "-s", "refused", "-x", "200", "-y", "50", "-c", root],
      () => tmux.ensureSession("refused", root), "create session refused", "unsafe permissions");
    const refused = caught(() => new TmuxRuntime("refused").spawn("probe", { command: "/bin/true", args: [] }, root));
    check("runtime SpawnRefused retains the native creation reason", refused instanceof SpawnRefused && refused.message.includes("unsafe permissions"));
  } finally {
    chmodSync(socketDir, 0o700);
    process.env.TMUX_TMPDIR = root;
  }
} finally {
  process.env.TMUX_TMPDIR = root;
  if (socket !== undefined && server !== undefined) {
    // Re-read this exact socket's identity before retiring only the fixture's server.
    if (native(["-S", socket, "display-message", "-p", "#{pid}"]) !== server) throw new Error("private tmux server identity changed; refusing cleanup");
    native(["-S", socket, "kill-server"]);
    stopped = await waitFor(() => spawnSync("tmux", ["-S", socket!, "display-message", "-p", "#{pid}"], { stdio: "ignore" }).status !== 0);
    check("the owned server stopped before its directory is removed", stopped);
  }
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (stopped) rmSync(root, { recursive: true, force: true });
}
console.log(`tmux driver writes: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
