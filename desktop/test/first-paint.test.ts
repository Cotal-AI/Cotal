import assert from "node:assert/strict";
import { test } from "node:test";
import { reportFirstPaint } from "../src/first-paint";

test("first paint waits for the mark and a frame, then reports once", async () => {
  const original = globalThis.requestAnimationFrame;
  const frames: FrameRequestCallback[] = [];
  let decoded!: () => void;
  let reports = 0;
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  try {
    const pending = reportFirstPaint({ decode: () => new Promise<void>(resolve => { decoded = resolve; }) } as HTMLImageElement, async () => { reports++; });
    assert.equal(frames.length, 0);
    assert.equal(reports, 0);
    decoded(); await Promise.resolve();
    assert.equal(frames.length, 1);
    frames.shift()!(0); await Promise.resolve();
    assert.equal(reports, 0, "the first callback runs before the frame is painted");
    frames.shift()!(16); await pending;
    assert.equal(reports, 1);
    assert.equal(frames.length, 0);
  } finally { globalThis.requestAnimationFrame = original; }
});
