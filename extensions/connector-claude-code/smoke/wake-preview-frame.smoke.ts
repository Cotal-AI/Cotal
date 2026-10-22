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
import { openWakeFeed, wakeSocketPath } from "../src/wake-feed.js";

const FRAME_LIMIT = 4_096;
const LONGEST_ID = "x".repeat(128);
const PEER_CONTROL = /(?!\n)\p{Cc}|\p{Cs}/u;

const dm = (n: number, text: string): InboxItem => ({
  id: String(n), recvKey: String(n), ts: n, fromId: `u.a${n}`, fromName: "a", kind: "dm", mentionsMe: false, historical: false, text,
});
const frameLength = (id: string, preview: RenderedInboxPreview) => JSON.stringify({ id, preview }).length;

const feed = await openWakeFeed(process.pid);
const reader: Socket = connect(wakeSocketPath(process.pid));
await new Promise<void>((resolve, reject) => { reader.once("connect", resolve); reader.once("error", reject); });
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
console.log("✓ wake preview frame cells passed (3/3)");
