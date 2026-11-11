import assert from "node:assert/strict";
import { test } from "node:test";
import { reportFirstPaint } from "../src/first-paint";

test("first paint reports once after decode and layout without any frame callback", async () => {
  const original = globalThis.requestAnimationFrame;
  let decoded!: () => void;
  const events: string[] = [];
  globalThis.requestAnimationFrame = () => { throw new Error("Hidden pages have no frame clock"); };
  try {
    const header = { get offsetHeight() { events.push("layout"); return 100; } } as HTMLElement;
    const pending = reportFirstPaint({ decode: () => new Promise<void>(resolve => { decoded = resolve; }) } as HTMLImageElement, header, async () => { events.push("report"); });
    assert.deepEqual(events, []);
    decoded(); await pending;
    assert.deepEqual(events, ["layout", "report"]);
  } finally { globalThis.requestAnimationFrame = original; }
});
