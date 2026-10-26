/**
 * The wake preview frame stays inside the feed's 4096-unit bound, and no peer control character
 * reaches a preview row.
 *
 * A peer controls each message body, and `renderInboxPreview` bounds rows by code point. A control
 * character or lone surrogate is one code point, but JSON writes it as a six-unit `\uXXXX` escape.
 * Three short rows full of them made the frame larger than `openWakeFeed().send` accepts. That
 * throw happens inside the gateway's synchronous wake, so the recipient lost its native wake, and
 * raw ESC reached Claude Code's terminal UI. These cells drive the shipped renderer and the shipped
 * feed through a real socket reader.
 */
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { renderInboxPreview, type InboxItem, type RenderedInboxPreview } from "@cotal-ai/connector-core";
import { spawn } from "node:child_process";
import { openWakeFeed, wakeSocketPath } from "../src/wake-feed.js";
import { approvalEvent, approvalFrame } from "../src/approval-notice.js";

const FRAME_LIMIT = 4_096;
const LONGEST_ID = "x".repeat(128);
const PEER_CONTROL = /(?!\n)\p{Cc}|\p{Cs}/u;

const dm = (n: number, text: string): InboxItem => ({
  id: String(n), recvKey: String(n), ts: n, fromId: `u.a${n}`, fromName: "a", kind: "dm", mentionsMe: false, historical: false, text,
});
const frameLength = (id: string, preview: RenderedInboxPreview) => JSON.stringify({ id, preview }).length;

const feed = await openWakeFeed(process.pid);
// A Windows named pipe can report the client's `connect` before the feed's server has taken the
// connection, so the first send waits until the feed itself counts this reader, for a bounded time.
const joined = new Promise<void>((resolve) => feed.onReader(resolve));
const reader: Socket = connect(wakeSocketPath(process.pid));
await new Promise<void>((resolve, reject) => { reader.once("connect", resolve); reader.once("error", reject); });
let joinWait: NodeJS.Timeout | undefined;
await Promise.race([
  joined,
  new Promise<never>((_, reject) => { joinWait = setTimeout(() => reject(new Error("the wake feed never counted the connected reader")), 5_000); }),
]);
clearTimeout(joinWait);
let received = "";
reader.setEncoding("utf8");
reader.on("data", (chunk: string) => { received += chunk; });
const nextFrame = async (): Promise<string> => {
  for (let i = 0; i < 100 && !received.includes("\n"); i++) await new Promise((r) => setTimeout(r, 10));
  const end = received.indexOf("\n");
  assert.ok(end >= 0, "the reader received a frame");
  const frame = received.slice(0, end);
  received = received.slice(end + 1);
  return frame;
};

/** A second reader bound to one native session, as the monitor binds with `--session`. */
async function sessionReader(session: string): Promise<{ lines: string[]; close(): void }> {
  const counted = new Promise<void>((resolve) => feed.onReader(resolve));
  const s = connect(wakeSocketPath(process.pid));
  await new Promise<void>((resolve, reject) => { s.once("connect", resolve); s.once("error", reject); });
  s.write(`${JSON.stringify({ op: "watch", session, inline: 1 })}\n`);
  await counted;
  for (let i = 0; i < 100 && !feed.watched(session); i++) await new Promise((r) => setTimeout(r, 10));
  const lines: string[] = [];
  let buf = "";
  s.setEncoding("utf8");
  s.on("data", (chunk: string) => { buf += chunk; for (let end; (end = buf.indexOf("\n")) >= 0;) { lines.push(buf.slice(0, end)); buf = buf.slice(end + 1); } });
  return { lines, close: () => s.destroy() };
}

const failures: string[] = [];
const cell = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${name}: ${(e as Error).message}`);
    console.log(`  ✗ ${name}: ${(e as Error).message}`);
  }
};

try {
  await cell("a decision frame reaches only the readers of the session that asked, and the shipped reader prints its line", async () => {
    const asked = await sessionReader("session-that-asked");
    const other = await sessionReader("another-session");
    const notice = { name: "approval_probe", status: "approved" as const, id: "b".repeat(26) };
    assert.equal(feed.notifyApproval("session-that-asked", notice), true, "a reader of the asking session heard the decision");
    for (let i = 0; i < 100 && asked.lines.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(asked.lines, [JSON.stringify({ approval: notice })]);
    assert.deepEqual(other.lines, [], "another session's reader hears nothing");
    assert.equal(received, "", "the unbound reader hears nothing either");
    assert.equal(feed.notifyApproval("nobody-listening", notice), false, "no reader, no delivery, and the host is told so");
    assert.throws(() => feed.notifyApproval("session-that-asked", { ...notice, id: "B" }), /not an approval notice/);
    asked.close();
    other.close();
    assert.deepEqual(approvalFrame(JSON.parse(asked.lines[0]!)), notice, "the reader's validator accepts exactly what the feed wrote");
    assert.equal(approvalEvent(notice), `Cotal: the person approved connection "approval_probe". Finish it: call cotal_connect with name "approval_probe" and approval_id "${"b".repeat(26)}".`);
    // The shipped reader process, bound to the asking session as the native module binds it.
    // A seat's own environment would make the reader exit as a managed session; the person's shell has none.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_")));
    const monitor = spawn(process.execPath, ["--import", "tsx", "src/monitor.ts", "--native", "--session", "reader-session"], { cwd: new URL("..", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    monitor.stdout.setEncoding("utf8");
    monitor.stdout.on("data", (chunk: string) => { out += chunk; });
    monitor.stderr.setEncoding("utf8");
    monitor.stderr.on("data", (chunk: string) => { err += chunk; });
    try {
      for (let i = 0; i < 300 && !feed.watched("reader-session"); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(feed.watched("reader-session"), "the reader process bound its session on the feed");
      assert.equal(feed.notifyApproval("reader-session", { ...notice, status: "denied" }), true);
      for (let i = 0; i < 100 && !out.includes("\n"); i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(out, `${approvalEvent({ ...notice, status: "denied" })}\n`, `the reader printed the decision line and nothing else: ${JSON.stringify(out)} / stderr ${JSON.stringify(err)}`);
    } finally { monitor.kill(); }
  });

  await cell("three control-character rows from a one-letter peer are delivered within the frame bound", async () => {
    const preview = renderInboxPreview({ unread: 3, items: [1, 2, 3].map((n) => dm(n, "\u0001".repeat(400))) });
    const length = frameLength(LONGEST_ID, preview);
    console.log(`    frame ${length}/${FRAME_LIMIT} units`);
    assert.equal(feed.send(LONGEST_ID, preview), true, "a connected reader heard the wake");
    const frame = await nextFrame();
    assert.equal(frame.length, length);
    assert.ok(frame.length <= FRAME_LIMIT, `frame ${frame.length} exceeds ${FRAME_LIMIT}`);
  });

  await cell("ESC, C1 controls and lone surrogates never reach a preview row, while line breaks keep their indent", async () => {
    const preview = renderInboxPreview({ unread: 1, items: [dm(4, "\u001b[2J\u001b[31mred\u009b0m \ud800 tail\nnext")] });
    const row = preview.rows[0]!;
    assert.ok(!PEER_CONTROL.test(row), `row carries a control: ${JSON.stringify(row)}`);
    assert.ok(row.includes("red") && row.includes("tail"), "printable text is kept");
    assert.ok(row.includes("\n  next"), "a line break is still rendered as an indented continuation");
  });

  await cell("the worst-case frame at the largest snapshot is counted within the bound", async () => {
    // Two JSON units per code point is the most any neutralized row can cost: a quote or backslash
    // escapes to two, and an astral character is a surrogate pair. Eight rows is inboxSnapshot's cap.
    const items = Array.from({ length: 8 }, (_, n) => dm(n + 10, '"'.repeat(400)));
    const preview = renderInboxPreview({ unread: Number.MAX_SAFE_INTEGER, items });
    const length = frameLength(LONGEST_ID, preview);
    console.log(`    worst-case frame ${length}/${FRAME_LIMIT} units`);
    assert.ok(length <= FRAME_LIMIT, `worst-case frame ${length} exceeds ${FRAME_LIMIT}`);
    assert.equal(feed.send(LONGEST_ID, preview), true);
    assert.equal((await nextFrame()).length, length);
  });
} finally {
  reader.destroy();
  feed.close();
}

assert.deepEqual(failures, [], `wake preview frame cells red=${failures.length}/3:\n${failures.join("\n")}`);
console.log("✓ wake preview frame cells passed (4/4)");
