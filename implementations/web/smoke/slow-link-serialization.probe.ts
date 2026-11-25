import { throttledWriter } from "./slow-link-throttle.js";
import { createSuite } from "@cotal-ai/smoke-kit";

const { check, finish, passed, failed } = createSuite();

const callbacks: (() => void)[] = [];
const writes: string[] = [];
const writer = throttledWriter(
  { destroyed: false, write: (chunk, done) => { writes.push(chunk.toString()); done(); return true; } },
  { oneWayMs: 0, bytesPerSec: 1 },
  { now: () => 0, schedule: (callback) => { callbacks.push(callback); return callback; }, cancel: () => {} },
);
writer.push(Buffer.from("a"));
writer.push(Buffer.from("b"));
check("slow-link serialization arms only one chunk callback at a time", callbacks.length === 1, callbacks.length);
while (callbacks.length) callbacks.shift()!();
check("slow-link serialization writes same-deadline chunks in FIFO order", writes.join("") === "ab", writes);
writer.close();

console.log(`SLOW LINK SERIALIZATION: ${passed()} passed, ${failed()} failed`);
finish();
process.exit(failed() ? 1 : 0);
