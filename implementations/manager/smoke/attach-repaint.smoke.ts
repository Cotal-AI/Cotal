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
 *    screen as the child redraws. (The snapshot-ordering leg — snapshot first, then buffered + live
 *    output in order — now lives in the mesh session bridge; see mesh-attach-plane.)
 * B) attachClient teardown: the snapshot re-enters the child's alternate screen on OUR terminal, so
 *    on detach the client must leave it again — but ONLY when the child was full-screen. An inline
 *    child keeps its native scrollback untouched. (Regression: leaving the terminal in the alt buffer
 *    stranded it with no scrollback, and the wheel walked shell history via xterm alt-scroll.) Driven
 *    through a transport-agnostic mock — the teardown is identical over the mesh §13.6 session.
 */
import assert from "node:assert";
import { attachClient, type TerminalTransport } from "../../cli/src/lib/attach-client.js"; // dev-only cross-impl smoke import
import { PtyRuntime } from "../src/runtime/pty.js";
import type { LaunchSpec } from "@cotal-ai/core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll `read` until `done`, or throw naming what was still missing. A fixed sleep is a race against
 *  the child's render; this is the same shape the detach leg already uses, and its timeout message
 *  distinguishes "never rendered" from "rendered the wrong thing". */
async function until(read: () => Promise<string>, done: (s: string) => boolean, ms: number, what: string): Promise<string> {
  const deadline = Date.now() + ms;
  let last = "";
  for (;;) {
    last = await read();
    if (done(last)) return last;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${ms}ms waiting for ${what}; last snapshot was ${last.length} bytes: ${JSON.stringify(last.slice(0, 120))}`);
    await sleep(10);
  }
}
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
    // POLL for PHASE-ONE rather than sleeping a fixed window. A 250ms sleep raced the child's first
    // render: on a loaded box the snapshot came back EMPTY and the suite died here having asserted
    // nothing at all — exit 1, zero checks, indistinguishable in the output from a real defect. The
    // detach case below already polls for exactly this reason; this leg was the one that did not.
    // The ceiling is generous and the timeout is DIAGNOSTIC: a genuine regression still fails, and
    // says whether it saw nothing or saw the wrong thing.
    const snap1 = await until(
      () => str(handle.attach().backlog()),
      (s) => /\x1b\[\?1049h/.test(s) && s.includes("PHASE-ONE-MARKER"),
      5_000,
      "the child to render PHASE-ONE into the alt screen",
    );
    assert.match(snap1, /\x1b\[\?1049h/, "A: snapshot re-enters the alternate screen");
    assert.match(snap1, /PHASE-ONE-MARKER/, "A: snapshot reconstructs the current alt-screen content");
    assert.doesNotMatch(snap1, /PHASE-TWO/, "A: PHASE-TWO not drawn yet");

    // A second attach's snapshot is identical — reconstruction is deterministic, so a repeat or
    // concurrent attach gets the full screen every time (the bug was the 2nd/3rd attach going partial).
    const snap2 = await str(handle.attach().backlog());
    assert.strictEqual(snap2, snap1, "A: repeat attach reconstructs the same full screen");

    // POLL for the redraw too. This sleep was 300ms on the assumption that the FIRST wait had
    // already burned 250 of the child's 400ms redraw timer — so replacing that one with a poll,
    // which returns as soon as PHASE-ONE appears, moved the failure here instead of fixing it. A
    // fixed wait that depends on how long an EARLIER fixed wait took is two races, not one.
    const snap3 = await until(
      () => str(handle.attach().backlog()),
      (s) => s.includes("PHASE-TWO-MARKER"),
      5_000,
      "the child's 400ms redraw to land",
    );
    assert.match(snap3, /PHASE-TWO-MARKER/, "A: snapshot tracks the live redraw");
    assert.doesNotMatch(snap3, /PHASE-ONE/, "A: the cleared PHASE-ONE is gone");
    console.log("  ✓ pty reconstructs the alt-screen on (repeat) attach and tracks redraws");
  } finally {
    handle.stop({ graceful: false });
  }
}

// Drive the real attachClient through one attach→detach and return the bytes it wrote to the
// (faked-TTY) terminal. A transport-agnostic MOCK delivers `snapshot` once ready (the reconstructed
// screen); Ctrl-] (0x1d) on stdin detaches, which resolves the transport's onEnd.
async function driveDetach(snapshot: string, marker: string): Promise<string> {
  let onEndCb: ((err?: Error, reason?: string) => void) | undefined;
  const transport: TerminalTransport = {
    onReady: (cb) => { queueMicrotask(cb); },
    onData: (cb) => { queueMicrotask(() => cb(Buffer.from(snapshot, "latin1"))); },
    onEnd: (cb) => { onEndCb = cb; },
    send: () => {},
    resize: () => {},
    close: () => { onEndCb?.(undefined, "detached"); },
  };

  let captured = "";
  const realWrite = process.stdout.write;
  const realTTY = process.stdout.isTTY;
  const realDetach = process.env.COTAL_DETACH_KEY;
  delete process.env.COTAL_DETACH_KEY;
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  process.stdout.write = ((chunk: string | Buffer): boolean => {
    captured += Buffer.isBuffer(chunk) ? chunk.toString("latin1") : String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const done = attachClient(transport);
    // Detach only once the snapshot has actually been painted to our terminal (poll, don't guess a
    // fixed sleep — a late snapshot on a loaded runner would fail the alt case / pass inline vacuously).
    for (let i = 0; i < 200 && !captured.includes(marker); i++) await sleep(10);
    assert.ok(captured.includes(marker), "B: snapshot painted before detach");
    process.stdin.emit("data", Buffer.from([0x1d])); // Ctrl-] → detach → cleanup()
    await done;
  } finally {
    process.stdout.write = realWrite;
    Object.defineProperty(process.stdout, "isTTY", { value: realTTY, configurable: true });
    if (realDetach === undefined) delete process.env.COTAL_DETACH_KEY;
    else process.env.COTAL_DETACH_KEY = realDetach;
  }
  return captured;
}

async function testDetachLeavesAltScreen(): Promise<void> {
  const alt = await driveDetach("\x1b[?1049h\x1b[H\x1b[?1002hFULLSCREEN-VIEW", "FULLSCREEN-VIEW");
  assert.match(alt, /\x1b\[\?1049l/, "B: detach from a full-screen child leaves the alternate screen");
  // Must NOT touch `?1007` — attach never enabled alt-scroll, so disabling it would clobber the
  // operator's own preference for later apps. Leaving the alt buffer already makes alt-scroll inert.
  assert.doesNotMatch(alt, /\x1b\[\?1007/, "B: detach does not touch the operator's alt-scroll mode");

  const inline = await driveDetach("inline conversation line\r\n$ ", "inline conversation line");
  assert.doesNotMatch(inline, /\x1b\[\?1049l/, "B: detach from an inline child keeps native scrollback (no alt-screen toggle)");
  console.log("  ✓ attach client leaves the alt-screen on detach only when the child entered it");
}

async function testWheelCoalescing(): Promise<void> {
  let onEndCb: ((err?: Error, reason?: string) => void) | undefined;
  const sent: string[] = [];
  const transport: TerminalTransport = {
    onReady: (cb) => { queueMicrotask(cb); },
    onData: (cb) => { queueMicrotask(() => { void cb(Buffer.from("\x1b[?1049h\x1b[HSCROLL-VIEW", "latin1")); }); },
    onEnd: (cb) => { onEndCb = cb; },
    send: (bytes) => { sent.push(bytes.toString("latin1")); },
    resize: () => {},
    close: () => { onEndCb?.(undefined, "detached"); },
  };

  let captured = "";
  const realWrite = process.stdout.write;
  const realTTY = process.stdout.isTTY;
  const realDetach = process.env.COTAL_DETACH_KEY;
  delete process.env.COTAL_DETACH_KEY;
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  process.stdout.write = ((chunk: string | Buffer): boolean => {
    captured += Buffer.isBuffer(chunk) ? chunk.toString("latin1") : String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const done = attachClient(transport);
    for (let i = 0; i < 200 && !captured.includes("SCROLL-VIEW"); i++) await sleep(5);
    assert.ok(captured.includes("SCROLL-VIEW"), "C: alternate-screen snapshot painted before wheel input");
    const up = Buffer.from("\x1b[<64;40;12M", "latin1");
    for (let i = 0; i < 100; i++) process.stdin.emit("data", up);
    await sleep(5);
    assert.strictEqual(sent.filter((x) => x === "\x1b[5~").length, 0, "C: burst is held for coalescing, not emitted per report");
    await sleep(30);
    assert.strictEqual(sent.filter((x) => x === "\x1b[5~").length, 1, "C: 100 wheel reports become one PageUp command");

    process.stdin.emit("data", Buffer.from("\x1b[<65;40;12M", "latin1"));
    process.stdin.emit("data", Buffer.from("a"));
    assert.deepStrictEqual(sent.slice(-2), ["\x1b[6~", "a"], "C: raw input flushes the pending wheel first and preserves order");
    process.stdin.emit("data", Buffer.from([0x1d]));
    await done;
  } finally {
    process.stdout.write = realWrite;
    Object.defineProperty(process.stdout, "isTTY", { value: realTTY, configurable: true });
    if (realDetach === undefined) delete process.env.COTAL_DETACH_KEY;
    else process.env.COTAL_DETACH_KEY = realDetach;
  }
  console.log("  ✓ rapid wheel reports coalesce across stdin reads without reordering keyboard input");
}

async function testStdoutDrainBackpressure(): Promise<void> {
  let onDataCb: ((bytes: Buffer) => void | Promise<void>) | undefined;
  let onEndCb: ((err?: Error, reason?: string) => void) | undefined;
  const transport: TerminalTransport = {
    onReady: (cb) => { queueMicrotask(cb); },
    onData: (cb) => { onDataCb = cb; },
    onEnd: (cb) => { onEndCb = cb; },
    send: () => {},
    resize: () => {},
    close: () => { onEndCb?.(undefined, "detached"); },
  };
  const realWrite = process.stdout.write;
  process.stdout.write = (() => false) as typeof process.stdout.write;
  try {
    const done = attachClient(transport);
    for (let i = 0; i < 100 && !onDataCb; i++) await sleep(1);
    assert.ok(onDataCb, "D: attach registered its output consumer");
    let accepted = false;
    const pending = Promise.resolve(onDataCb!(Buffer.from("SLOW-STDOUT"))).then(() => { accepted = true; });
    await sleep(10);
    assert.strictEqual(accepted, false, "D: a false stdout.write holds transport acceptance and therefore rail credit");
    process.stdout.emit("drain");
    await pending;
    assert.strictEqual(accepted, true, "D: stdout drain releases transport acceptance");
    transport.close();
    await done;
  } finally {
    process.stdout.write = realWrite;
  }
  console.log("  ✓ receiver credit waits for local stdout drain instead of acknowledging unread bytes");
}

async function main(): Promise<void> {
  await testPtyReconstruction();
  await testDetachLeavesAltScreen();
  await testWheelCoalescing();
  await testStdoutDrainBackpressure();
  console.log("\nATTACH REPAINT SMOKE OK ✅  (4 tests)");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
