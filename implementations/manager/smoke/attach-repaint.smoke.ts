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
 */
import assert from "node:assert";
import WebSocket from "ws";
import { AttachEndpoint } from "../src/attach-endpoint.js";
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

async function main(): Promise<void> {
  await testPtyReconstruction();
  await testEndpointOrdering();
  console.log("\nATTACH REPAINT SMOKE OK ✅  (2 tests)");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
