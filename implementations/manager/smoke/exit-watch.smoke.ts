import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import type { AgentHandle, AttachSession } from "@cotal-ai/core";
import { Manager } from "../dist/manager.js";
import { createRuntime, pollProvedExit, watchProvedExit } from "../dist/runtime/index.js";

function streaming(initial: "running" | "exited" = "running") {
  let state = initial;
  const exits = new Set<() => void>();
  const session: AttachSession = {
    cols: 80,
    rows: 24,
    backlog: () => Buffer.alloc(0),
    onData: () => () => {},
    onExit: (fn) => { exits.add(fn); return () => { exits.delete(fn); }; },
    write: () => {},
    resize: () => {},
  };
  const handle: AgentHandle = {
    name: "exit-watch",
    kind: "smoke",
    status: () => state,
    stop: () => {},
    interrupt: () => {},
    attach: () => session,
  };
  return {
    handle,
    exit() {
      state = "exited";
      for (const fn of exits) fn();
    },
  };
}

for (const initial of ["running", "exited"] as const) {
  for (const watching of [false, true]) {
    test(`streaming ${initial}, watching=${watching}`, () => {
      const runtime = streaming(initial);
      let calls = 0;
      assert.equal(watchProvedExit(runtime.handle, () => { calls++; }, () => watching), true);
      if (initial === "running") runtime.exit();
      assert.equal(calls, watching ? 1 : 0, "streaming exit must honor watching");
    });
  }
}

test("a streaming watch stops delivering after its owner stops watching", () => {
  const runtime = streaming();
  let watching = true;
  let calls = 0;
  watchProvedExit(runtime.handle, () => { calls++; }, () => watching);
  watching = false;
  runtime.exit();
  assert.equal(calls, 0, "a late exit must not notify the old owner");
});

test("a streaming callback can finish its watch before a repeated exit", () => {
  const runtime = streaming();
  let done = false;
  let calls = 0;
  watchProvedExit(runtime.handle, () => { calls++; done = true; }, () => !done);
  runtime.exit();
  runtime.exit();
  assert.equal(calls, 1, "a completed watch must not deliver again");
});

for (const watching of [false, true]) {
  test(`polling control, watching=${watching}`, async () => {
    const runtime = streaming("exited");
    let calls = 0;
    let waits = 0;
    runtime.handle.attach = () => { throw new Error("no exit stream"); };
    runtime.handle.waitForExit = async () => { waits++; };
    assert.equal(pollProvedExit(runtime.handle, () => { calls++; }, () => watching, 1), true);
    await sleep(30);
    assert.equal(calls, watching ? 1 : 0, "polling exit must honor watching");
    assert.equal(waits, watching ? 1 : 0);
  });
}

for (const cancel of [false, true]) {
  test(`polling proof completes after cancellation=${cancel}`, { timeout: 2_000 }, async () => {
    const runtime = streaming("exited");
    let watching = true;
    let calls = 0;
    let prove!: () => void;
    const proof = new Promise<void>((resolve) => { prove = resolve; });
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    runtime.handle.waitForExit = () => { started(); return proof; };
    assert.equal(pollProvedExit(runtime.handle, () => { calls++; }, () => watching, 1), true);
    // Keep the test alive while the product's unref'ed poll starts the proof.
    const keepAlive = setTimeout(() => {}, 2_000);
    try {
      await waiting;
      watching = !cancel;
      prove();
      await sleep(0);
      assert.equal(calls, cancel ? 0 : 1, "exit proof must recheck watching at delivery");
    } finally {
      watching = false;
      prove();
      clearTimeout(keepAlive);
    }
  });
}

test("a non-streaming handle without proof support is reported unsupported", () => {
  const runtime = streaming();
  runtime.handle.attach = () => { throw new Error("no exit stream"); };
  assert.equal(watchProvedExit(runtime.handle, () => assert.fail("unsupported exit"), () => true), false);
});

for (const replaceRow of [false, true]) {
  test(`manager ignores the old exit after replacing ${replaceRow ? "the row" : "its handle"}`, () => {
    const old = streaming();
    const next = streaming();
    const agent = { name: "exit-watch", handle: old.handle };
    // Isolate the real watchExit method from broker setup and terminal cleanup effects.
    const manager = Object.create(Manager.prototype) as {
      agents: Map<string, typeof agent>;
      watchExit(a: typeof agent): void;
      onAgentExit(a: typeof agent): void;
    };
    manager.agents = new Map([[agent.name, agent]]);
    const exited: typeof agent[] = [];
    manager.onAgentExit = (a) => { exited.push(a); };
    manager.watchExit(agent);
    const replacement = replaceRow ? { name: agent.name, handle: next.handle } : agent;
    replacement.handle = next.handle;
    manager.agents.set(agent.name, replacement);
    manager.watchExit(replacement);
    old.exit();
    assert.deepEqual(exited, [], "the old handle must not retire the replacement");
    next.exit();
    assert.deepEqual(exited, [replacement], "the current handle still delivers its exit");
  });
}

for (const alreadyExited of [false, true]) {
  for (const watching of [false, true]) {
    test(`built PTY runtime, alreadyExited=${alreadyExited}, watching=${watching}`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "cotal-exit-watch-"));
      const handle = createRuntime("pty", "exit-watch").spawn("exit-watch", {
        command: process.execPath,
        args: ["-e", ""],
        env: {
          PATH: dirname(process.execPath), HOME: cwd, TMPDIR: tmpdir(),
          ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
        },
      }, cwd);
      const timeout = setTimeout(() => handle.stop({ graceful: false }), 5_000);
      let calls = 0;
      try {
        if (alreadyExited) await handle.waitForExit!();
        assert.equal(watchProvedExit(handle, () => { calls++; }, () => watching), true);
        await handle.waitForExit!();
        await sleep(0); // The real runtime also queues an exit for late subscribers.
        if (watching) assert.ok(calls > 0, "a watched real child exit must be delivered");
        else assert.equal(calls, 0, "an unwatched real child exit must not be delivered");
        assert.equal(handle.exitInfo?.()?.code, 0, "the child exited normally before the timeout");
      } finally {
        clearTimeout(timeout);
        if (handle.status() === "running") {
          handle.stop({ graceful: false });
          await handle.waitForExit!();
        }
      }
    });
  }
}
