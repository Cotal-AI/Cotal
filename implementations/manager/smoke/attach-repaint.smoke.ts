/**
 * Repaint-on-attach: a late or concurrent attach must paint the child's CURRENT screen, not a
 * partial one. The manager mirrors each PTY into a headless terminal and, on attach, replays a
 * serialized snapshot of it — the alternate-screen buffer of a full-screen TUI, or the scrollback
 * of an inline one — so the client repaints deterministically without the child having to emit a
 * SIGWINCH-driven redraw. (The old raw byte-ring replay couldn't reconstruct an alt-screen, so a
 * same-size re/co-attach was left staring at a stale partial frame.)
 *
 * A) PtyRuntime: a real pty runs a tiny full-screen program; its backlog() reconstructs the current
 *    alt-screen — twice over (a repeat/concurrent attach is deterministic), and it tracks the live
 *    screen as the child redraws.
 * B) AttachEndpoint: with an async backlog, the client gets the snapshot FIRST, then live output in
 *    order and exactly once — output arriving mid-snapshot is buffered, not lost or raced ahead.
 * C) attachClient teardown: the snapshot re-enters the child's alternate screen on OUR terminal, so
 *    on detach the client must leave it again — but ONLY when the child was full-screen. An inline
 *    child keeps its native scrollback untouched. (Regression: leaving the terminal in the alt buffer
 *    stranded it with no scrollback, and the wheel walked shell history via xterm alt-scroll.)
 */
import assert from "node:assert";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { AttachEndpoint } from "../src/attach-endpoint.js";
import { attachClient } from "../src/attach-client.js";
import { PtyRuntime } from "../src/runtime/pty.js";
import type { AttachSession, LaunchSpec } from "@cotal-ai/core";
import type { AgentHandle } from "../src/runtime/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const str = (b: Buffer | Promise<Buffer>) => Promise.resolve(b).then((x) => x.toString("utf8"));

// A full-screen program: enter the alternate screen, draw PHASE-ONE, then after 400ms clear and
// draw PHASE-TWO. `\x1b` is written as `\\x1b` so the node -e source contains the literal escape.
const CHILD = [
  "-e",
  "const w=s=>process.stdout.write(s);" +
    "w('\\x1b[?1049h\\x1b[2J\\x1b[H');" +
    "w('PHASE-ONE-MARKER top line');" +
    "setTimeout(()=>w('\\x1b[2J\\x1b[HPHASE-TWO-MARKER redrawn'),400);" +
    "setTimeout(()=>{},4000);",
];

async function testPtyReconstruction(): Promise<void> {
  const rt = new PtyRuntime();
  const spec = { command: process.execPath, args: CHILD, env: { PATH: process.env.PATH ?? "" } } as LaunchSpec;
  const handle = rt.spawn("probe", spec, process.cwd());
  try {
    await sleep(250); // let PHASE-ONE render into the mirror
    const snap1 = await str(handle.attach().backlog());
    assert.match(snap1, /\x1b\[\?1049h/, "A: snapshot re-enters the alternate screen");
    assert.match(snap1, /PHASE-ONE-MARKER/, "A: snapshot reconstructs the current alt-screen content");
    assert.doesNotMatch(snap1, /PHASE-TWO/, "A: PHASE-TWO not drawn yet");

    // A second attach's snapshot is identical — reconstruction is deterministic, so a repeat or
    // concurrent attach gets the full screen every time (the bug was the 2nd/3rd attach going partial).
    const snap2 = await str(handle.attach().backlog());
    assert.strictEqual(snap2, snap1, "A: repeat attach reconstructs the same full screen");

    await sleep(300); // now past the 400ms redraw
    const snap3 = await str(handle.attach().backlog());
    assert.match(snap3, /PHASE-TWO-MARKER/, "A: snapshot tracks the live redraw");
    assert.doesNotMatch(snap3, /PHASE-ONE/, "A: the cleared PHASE-ONE is gone");
    console.log("  ✓ pty reconstructs the alt-screen on (repeat) attach and tracks redraws");
  } finally {
    handle.stop({ graceful: false });
  }
}

async function testEndpointOrdering(): Promise<void> {
  // Snapshot resolves after 50ms; live chunks are emitted at 20ms (mid-snapshot → must be buffered
  // behind it) and 90ms (post-snapshot → straight through). Expect exactly "SNAP" then both, in order.
  let dataFn: ((c: Buffer) => void) | undefined;
  const session = {
    cols: 80,
    rows: 24,
    backlog: () => new Promise<Buffer>((res) => setTimeout(() => res(Buffer.from("SNAP")), 50)),
    onData: (fn: (c: Buffer) => void) => {
      dataFn = fn;
      return () => (dataFn = undefined);
    },
    onExit: () => () => {},
    write: () => {},
    resize: () => {},
  } as unknown as AttachSession;
  const handle = {
    name: "a",
    kind: "pty",
    status: () => "running",
    stop: () => {},
    interrupt: () => {},
    attach: () => session,
  } as unknown as AgentHandle;

  const ep = new AttachEndpoint((n) => (n === "a" ? handle : undefined), () => [], () => [], 0);
  await ep.start();
  try {
    const got: string[] = [];
    const ws = new WebSocket(ep.url("a"));
    ws.on("message", (d: Buffer) => got.push(d.toString("utf8")));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    setTimeout(() => dataFn?.(Buffer.from("LIVE")), 20); // mid-snapshot → buffered
    setTimeout(() => dataFn?.(Buffer.from("AFTER")), 90); // post-snapshot → live
    await sleep(220);
    ws.close();
    await sleep(20);

    assert.strictEqual(got[0], "SNAP", "B: snapshot arrives first");
    assert.strictEqual(got.join(""), "SNAPLIVEAFTER", "B: live output ordered after the snapshot, exactly once");
    console.log("  ✓ endpoint sends the snapshot first, then buffered + live output in order");
  } finally {
    await ep.stop();
  }
}

// Drive the real attachClient through one attach→detach and return the bytes it wrote to the
// (faked-TTY) terminal. The server hands back `snapshot` on connect; Ctrl-] (0x1d) on stdin detaches.
async function driveDetach(snapshot: string, marker: string): Promise<string> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const { port } = wss.address() as AddressInfo;
  wss.on("connection", (sock) => sock.send(Buffer.from(snapshot, "latin1")));

  let captured = "";
  const realWrite = process.stdout.write;
  const realTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  process.stdout.write = ((chunk: string | Buffer): boolean => {
    captured += Buffer.isBuffer(chunk) ? chunk.toString("latin1") : String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const done = attachClient(`ws://127.0.0.1:${port}/attach/x`);
    // Detach only once the snapshot has actually been painted to our terminal (poll, don't guess a
    // fixed sleep — a late snapshot on a loaded runner would fail the alt case / pass inline vacuously).
    for (let i = 0; i < 200 && !captured.includes(marker); i++) await sleep(10);
    assert.ok(captured.includes(marker), "C: snapshot painted before detach");
    process.stdin.emit("data", Buffer.from([0x1d])); // Ctrl-] → detach → cleanup()
    await done;
  } finally {
    process.stdout.write = realWrite;
    Object.defineProperty(process.stdout, "isTTY", { value: realTTY, configurable: true });
    await new Promise<void>((res) => wss.close(() => res()));
  }
  return captured;
}

async function testDetachLeavesAltScreen(): Promise<void> {
  const alt = await driveDetach("\x1b[?1049h\x1b[H\x1b[?1002hFULLSCREEN-VIEW", "FULLSCREEN-VIEW");
  assert.match(alt, /\x1b\[\?1049l/, "C: detach from a full-screen child leaves the alternate screen");
  // Must NOT touch `?1007` — attach never enabled alt-scroll, so disabling it would clobber the
  // operator's own preference for later apps. Leaving the alt buffer already makes alt-scroll inert.
  assert.doesNotMatch(alt, /\x1b\[\?1007/, "C: detach does not touch the operator's alt-scroll mode");

  const inline = await driveDetach("inline conversation line\r\n$ ", "inline conversation line");
  assert.doesNotMatch(inline, /\x1b\[\?1049l/, "C: detach from an inline child keeps native scrollback (no alt-screen toggle)");
  console.log("  ✓ attach client leaves the alt-screen on detach only when the child entered it");
}

async function main(): Promise<void> {
  await testPtyReconstruction();
  await testEndpointOrdering();
  await testDetachLeavesAltScreen();
  console.log("\nATTACH REPAINT SMOKE OK ✅  (3 tests)");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
