import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { connectSteerClient, softInterruptWithLateReply } from "../src/steer-replies.js";

/** Real SDK socket controls for late reply identity and reservation disposal. */
export async function checkSteerReplies(root: string, check: (name: string, condition: boolean) => void): Promise<void> {
  const pending: Array<{ id: number; reply: (frame: object) => void }> = [];
  const socketPath = join(root, "reply-controls.sock");
  const server = createServer((socket) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
      let end: number;
      while ((end = data.indexOf("\n")) >= 0) {
        const frame = JSON.parse(data.slice(0, end)) as { id: number; req: string };
        data = data.slice(end + 1);
        const reply = (value: object): void => { socket.write(JSON.stringify({ v: 1, ...value }) + "\n"); };
        if (frame.req === "hello") reply({ ev: "hello_ok", reply_to: frame.id, version: 1, server: "owned-reply-control" });
        else pending.push({ id: frame.id, reply });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const first = await connectSteerClient(socketPath, 30);
  const second = await connectSteerClient(socketPath, 30);
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
  try {
    const answers: string[] = [];
    const a = softInterruptWithLateReply(first, "session", "first", (ok) => answers.push(`first:${ok}`));
    await a.request.catch(() => {});
    const b = softInterruptWithLateReply(second, "session", "second", (ok) => answers.push(`second:${ok}`));
    await b.request.catch(() => {});
    assert.equal(pending.length, 2);
    check("late replies: clients independently reuse the same SDK request id", pending[0]!.id === pending[1]!.id);
    pending[0]!.reply({ ev: "ok", reply_to: pending[0]!.id + 1000 });
    await wait();
    check("late replies: an unrelated request id accepts no steer", answers.length === 0);
    pending[0]!.reply({ ev: "ok", reply_to: pending[0]!.id });
    await wait();
    check("late replies: positive old-client reply cannot settle a new client's same id", answers.join() === "first:true");
    pending[1]!.reply({ ev: "error", reply_to: pending[1]!.id, code: "invalid_request", message: "owned refusal" });
    await wait();
    check("late replies: matching late error is refusal, never acceptance", answers.join() === "first:true,second:false");
    const disposed = softInterruptWithLateReply(second, "session", "disposed", () => answers.push("disposed"));
    await disposed.request.catch(() => {});
    disposed.dispose();
    pending[2]!.reply({ ev: "ok", reply_to: pending[2]!.id });
    await wait();
    check("late replies: a released reservation ignores its late positive reply", !answers.includes("disposed"));
    const early = softInterruptWithLateReply(second, "session", "early-disposed", () => answers.push("early"));
    early.dispose();
    await early.request.catch(() => {});
    pending[3]!.reply({ ev: "ok", reply_to: pending[3]!.id });
    await wait();
    check("late replies: disposal before timeout cannot re-register acceptance", !answers.includes("early"));
    const closed = softInterruptWithLateReply(second, "session", "closed", () => answers.push("closed"));
    await closed.request.catch(() => {});
    await second.close();
    closed.dispose();
    check("late replies: closing a client never claims native acceptance", !answers.includes("closed"));
    a.dispose();
    b.dispose();
  } finally {
    await first.close();
    await second.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
