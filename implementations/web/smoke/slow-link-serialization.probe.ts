import { throttledWriter } from "./slow-link-throttle.js";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};

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

console.log(`SLOW LINK SERIALIZATION: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
