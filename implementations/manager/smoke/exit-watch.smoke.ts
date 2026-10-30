/** Exit notifications belong only to the handle still being watched.
 * Run: pnpm smoke:exit-watch (real PTY children, no broker or managed agents).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { AgentHandle } from "@cotal-ai/core";
import { launchEnv } from "@cotal-ai/connector-core";
import { watchProvedExit, pollProvedExit } from "../src/runtime/index.js";
import { PtyRuntime } from "../src/runtime/pty.js";
import { Manager } from "../src/manager.js";

let pass = 0, fail = 0;
const check = (label: string, condition: boolean): void => {
  if (condition) pass++; else fail++;
  console.log(`  ${condition ? "✓" : "✗ FAIL:"} ${label}`);
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

const root = mkdtempSync(join(tmpdir(), "cotal-exit-watch-"));
const handles: AgentHandle[] = [];
async function child(name: string): Promise<AgentHandle> {
  const handle = new PtyRuntime().spawn(name, {
    command: process.execPath,
    args: ["-e", "process.stdin.resume();process.stdin.on('data',()=>process.exit(0));process.stdout.write('exit-watch-ready\\n')"],
    env: launchEnv(),
  }, root);
  handles.push(handle);
  const ready = deferred();
  let output = "";
  const off = handle.attach().onData((chunk) => {
    output += chunk.toString();
    if (output.includes("exit-watch-ready")) ready.resolve();
  });
  try { await bounded(ready.promise, `${name} ready`); } finally { off(); }
  check(`${name}: real child is running`, handle.status() === "running" && !!handle.pid);
  return handle;
}
async function end(handle: AgentHandle): Promise<void> {
  const proof = handle.waitForExit!();
  handle.attach().write("exit\r");
  await bounded(proof, `${handle.name} exit`);
  check(`${handle.name}: native exit proved`, handle.status() === "exited");
}

// Observe disposal of the actual runtime subscription without replacing its exit event.
function observedStream(handle: AgentHandle, replay = false) {
  let disposed = 0;
  const observed: AgentHandle = {
    ...handle,
    attach: () => {
      const session = handle.attach();
      return { ...session, onExit: (fn: () => void) => {
        const off = session.onExit(fn);
        if (replay) fn();
        return () => { disposed++; off(); };
      } };
    },
  };
  return { handle: observed, disposed: () => disposed };
}

try {
  for (const mode of ["live", "cancelled", "never-watched"] as const) {
    const handle = await child(`stream-${mode}`);
    let watching = mode !== "never-watched", calls = 0;
    const observed = observedStream(handle);
    check(`${handle.name}: stream available`, watchProvedExit(observed.handle, () => { calls++; }, () => watching));
    if (mode === "cancelled") watching = false;
    await end(handle);
    check(`${handle.name}: only current watcher notified`, calls === (mode === "live" ? 1 : 0));
    check(`${handle.name}: subscription disposed after exit`, observed.disposed() === 1);
  }
  for (const watching of [false, true]) {
    const handle = await child(`already-exited-${watching}`);
    await end(handle);
    for (const replay of [false, true]) {
      let calls = 0;
      const observed = observedStream(handle, replay);
      const label = `${handle.name}, synchronous replay ${replay}`;
      check(`${label}: stream available`, watchProvedExit(observed.handle, () => { calls++; }, () => watching));
      check(`${label}: current watcher notified once`, calls === (watching ? 1 : 0));
      check(`${label}: subscription disposed after exit`, observed.disposed() === 1);
    }
    if (watching) {
      let current = true, calls = 0;
      const observed = observedStream(handle);
      observed.handle.status = () => { current = false; return handle.status(); };
      check("status delivery: stream available", watchProvedExit(observed.handle, () => { calls++; }, () => current));
      check("status delivery: rechecks ownership after reading status", calls === 0);
      check("status delivery: subscription disposed", observed.disposed() === 1);
    }
  }
  // The adapter hides only attach and delays delivery of actual native exit proof. It cannot
  // invent an exit: status and the proof both come from the real PTY handle.
  for (const cancel of [false, true]) {
    const handle = await child(`pending-proof-${cancel}`);
    await end(handle);
    const started = deferred(), release = deferred(), delivered = deferred();
    let watching = true, calls = 0;
    const polling: AgentHandle = {
      ...handle,
      attach: () => { throw new Error("fixture has no terminal stream"); },
      waitForExit: async () => {
        started.resolve();
        await handle.waitForExit!();
        await release.promise;
      },
    };
    check(`${handle.name}: polling available`, pollProvedExit(polling, () => {
      calls++; delivered.resolve();
    }, () => watching, 5));
    try {
      await bounded(started.promise, "poll began exit proof");
      check(`${handle.name}: no notification before proof`, calls === 0);
      if (cancel) watching = false;
      release.resolve();
      // A full event-loop turn drains the promise chain, without using a silence timeout as proof.
      await nextTurn();
      if (!cancel) await bounded(delivered.promise, "current polling watcher notified");
      check(`${handle.name}: only current watcher notified`, calls === (cancel ? 0 : 1));
    } finally {
      watching = false;
      release.resolve();
    }
  }
  // Drive the manager's real watch binding around a handle swap. Intercept only the next
  // lifecycle operation: this checks notification ownership, not broker-backed retirement.
  for (const polling of [false, true]) {
    const old = await child(`manager-old-${polling}`), replacement = await child(`manager-replacement-${polling}`);
    type Row = { name: string; handle: AgentHandle };
    const manager = new Manager({ space: "exit-watch-smoke", runtime: "pty", workspaceRoot: root });
    const internals = manager as unknown as {
      agents: Map<string, Row>;
      watchExit(row: Row): void;
      onAgentExit(row: Row): void;
    };
    let notifications = 0;
    internals.onAgentExit = () => { notifications++; };
    const started = deferred(), release = deferred();
    const row = { name: "restarted", handle: old };
    if (polling) {
      await end(old);
      row.handle = {
        ...old,
        attach: () => { throw new Error("fixture has no terminal stream"); },
        waitForExit: async () => {
          started.resolve();
          await old.waitForExit!();
          await release.promise;
        },
      };
    }
    internals.agents.set(row.name, row);
    internals.watchExit(row);
    try {
      // This drives watchProvedExit's shipped five-second polling interval.
      if (polling) await bounded(started.promise, "manager began native exit proof");
      row.handle = replacement;
      internals.watchExit(row);
      if (polling) { release.resolve(); await nextTurn(); }
      else await end(old);
      check(`manager polling ${polling}: old handle cannot notify for replacement`, notifications === 0);
      await end(replacement);
      check(`manager polling ${polling}: current handle notifies once`, notifications === 1);
    } finally {
      internals.agents.clear();
      release.resolve();
    }
  }
} finally {
  for (const handle of handles) {
    handle.stop({ graceful: false });
    await bounded(handle.waitForExit!(), `${handle.name} cleanup`);
  }
  rmSync(root, { recursive: true, force: true });
}
check("all 56 expected assertions ran", pass + fail === 56);
console.log(`\nEXIT WATCH ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exitCode = fail === 0 ? 0 : 1;
