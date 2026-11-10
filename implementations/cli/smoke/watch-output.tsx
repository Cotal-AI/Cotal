/** Output proofs used by smoke:view. These execute the stream and mount the Ink watch surface. */
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import React, { act } from "react";
import { render } from "ink";
import type { CotalEndpoint, Presence } from "@cotal-ai/core";
import { MeshView } from "@cotal-ai/workspace/view";
import { runWatchStream } from "../src/watch-json.js";
import { WatchView } from "../src/watch-view.js";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check() && Date.now() < deadline) await pause();
  assert.ok(check(), "watch output did not arrive before the deadline");
}
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const working = /\balice\b[^\n]*working - progress unknown/;

class Observer extends EventEmitter {
  readonly space = "watch-output";
  stopped = false;
  rows: Presence[] = [
    { card: { id: "alice-id", name: "alice", kind: "agent" }, status: "working", ts: 1 },
    { card: { id: "bob-id", name: "bob", kind: "agent" }, status: "waiting", ts: 1 },
  ];
  async start(): Promise<void> { this.emit("transport", { connected: true }); }
  async stop(): Promise<void> { this.stopped = true; }
  getRoster(): Presence[] { return this.rows; }
  tap(): void {}
  channelDeliveryClass() { return "live" as const; }
  async listChannels() { return []; }
  async dmHistory() { return []; }
  async readMembership() { return { asOf: undefined, members: [] }; }
  async watchMembership() { return { stop: async () => undefined }; }
}

export async function checkWatchOutput(): Promise<void> {
  const ep = new Observer();
  const lines: string[] = [];
  const log = console.log, error = console.error, exitCode = process.exitCode;
  const beforeInterrupt = process.listenerCount("SIGINT");
  const beforeTerminate = process.listenerCount("SIGTERM");
  assert.equal(beforeInterrupt, 0, "watch proof must run before other signal owners start");
  assert.equal(beforeTerminate, 0, "watch proof must run before other signal owners start");
  console.log = (...args: unknown[]) => { lines.push(strip(args.join(" "))); };
  console.error = () => {};
  let settled = false;
  const stream = runWatchStream(ep as unknown as CotalEndpoint, ep.space, undefined, "roster", "plain").finally(() => { settled = true; });
  try {
    await until(() => working.test(lines.join("\n")) || settled);
    const output = lines.join("\n");
    assert.match(output, /\balice\b[^\n]*working - progress unknown/, "the real watch stream prints working with unknown progress");
    assert.match(output, /\bbob\b[^\n]*waiting/);
    assert.doesNotMatch(output, /\bbob\b[^\n]*progress unknown/);
    ep.rows = ep.rows.map((row) => row.card.name === "alice" ? { ...row, status: "idle" } : row);
    const prior = lines.length;
    ep.emit("roster", ep.rows);
    await until(() => /\balice\b[^\n]*idle/.test(lines.slice(prior).join("\n")) || settled);
    assert.match(lines.slice(prior).join("\n"), /\balice\b[^\n]*idle/, "the real stream updates the emitted snapshot");
  } finally {
    // Only this test's in-process stream owns these handlers. No OS signal is sent.
    try {
      if (!settled) process.emit("SIGINT");
      await stream;
    } finally {
      console.log = log;
      console.error = error;
      process.exitCode = exitCode;
    }
  }
  assert.ok(ep.stopped, "stream closes its observer");
  assert.equal(process.listenerCount("SIGINT"), beforeInterrupt);
  assert.equal(process.listenerCount("SIGTERM"), beforeTerminate);

  const observer = new Observer();
  const view = new MeshView(observer as unknown as CotalEndpoint);
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  let frame = "";
  const stdout = new Writable({ write(bytes, _encoding, done) { const text = strip(String(bytes)); if (text.trim()) frame = text; done(); } }) as unknown as NodeJS.WriteStream;
  stdout.columns = 200;
  stdout.rows = 40;
  stdout.isTTY = true;
  let app: ReturnType<typeof render> | undefined;
  const priorAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await view.start();
    await act(async () => { app = render(React.createElement(WatchView, { view, initialFilter: "roster", onLeave: () => {} }), { stdin, stdout, debug: true, patchConsole: false, exitOnCtrlC: false }); });
    await until(() => working.test(frame));
    assert.match(frame, /\balice\b[^\n]*working - progress unknown/, "the mounted watch view paints working with unknown progress");
    assert.match(frame, /\bbob\b[^\n]*waiting/);
    assert.doesNotMatch(frame, /\bbob\b[^\n]*progress unknown/);
    await act(async () => {
      observer.rows = observer.rows.map((row) => row.card.name === "alice" ? { ...row, status: "idle" } : row);
      const changed = once(view, "change", { signal: AbortSignal.timeout(4000) });
      observer.emit("roster", observer.rows);
      await changed;
    });
    await until(() => /\balice\b[^\n]*idle/.test(frame));
    assert.match(frame, /\balice\b[^\n]*idle/, "the mounted watch view repaints changed presence");
  } finally {
    await act(async () => { app?.unmount(); });
    app?.cleanup();
    stdin.destroy();
    stdout.destroy();
    await view.stop();
    if (priorAct === undefined) Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    else Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", priorAct);
  }
  assert.ok(observer.stopped, "mounted view's observer closes");
  assert.equal(view.listenerCount("change"), 0, "the mounted watch view releases its subscription");
  console.log("watch output proofs: stream and mounted view passed, including presence updates");
}
