/**
 * #3595: `watchProvedExit` calls `onExit` until `watching` turns false on a streaming handle
 * too, not only on one it has to poll.
 *
 * The streaming branch used to subscribe the caller's `onExit` for good and fire it for a
 * child that had already exited, without reading `watching`. A caller that trusted the
 * contract then heard an exit for a handle it no longer watched. The poller already stopped.
 *
 * Broker-free and process-free. The handles are stand-ins: one whose `attach` returns a
 * session, and one whose `attach` throws so the poller runs.
 *
 * Run: pnpm smoke:watch-proved-exit
 */
import type { AgentHandle, AttachSession } from "@cotal-ai/core";
import { pollProvedExit, watchProvedExit } from "../src/runtime/index.js";

let pass = 0, fail = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

/** A handle whose attach returns one session. `fire` delivers the exit the session recorded. */
function streaming(status: "running" | "exited"): AgentHandle & { fire(): void; subscribers(): number } {
  const subs = new Set<() => void>();
  return {
    name: "stand-in",
    kind: "stand-in",
    status: () => status,
    stop() {},
    interrupt() {},
    attach(): AttachSession {
      return {
        cols: 80,
        rows: 24,
        backlog: () => Buffer.alloc(0),
        onData: () => () => {},
        onExit: (fn) => {
          subs.add(fn);
          return () => subs.delete(fn);
        },
        write() {},
        resize() {},
      };
    },
    fire() {
      for (const fn of [...subs]) fn();
    },
    subscribers: () => subs.size,
  };
}

/** A handle with no exit stream. `waitForExit` is absent when `provable` is false. */
function polling(provable: boolean): AgentHandle & { waits: number } {
  const handle: AgentHandle & { waits: number } = {
    name: "poll-stand-in",
    kind: "stand-in",
    waits: 0,
    status: () => "exited",
    stop() {},
    interrupt() {},
    attach(): AttachSession {
      throw new Error("no stream");
    },
  };
  if (provable) handle.waitForExit = async () => { handle.waits++; };
  return handle;
}

// (a) the defect: watching is already false
{
  const live = streaming("running");
  let calls = 0;
  const returned = watchProvedExit(live, () => { calls++; }, () => false);
  check("#3595: a streaming watch still returns true when watching is already false", returned === true);
  check("#3595: a streaming watch that is already not watching leaves no subscriber", live.subscribers() === 0, live.subscribers());
  live.fire();
  live.fire();
  check("#3595: an exit after watching turned false calls nothing, twice", calls === 0, calls);

  const gone = streaming("exited");
  let goneCalls = 0;
  const returnedGone = watchProvedExit(gone, () => { goneCalls++; }, () => false);
  check("#3595: an already-exited child is not reported while watching is false", returnedGone === true && goneCalls === 0, { returnedGone, goneCalls });
  check("#3595: the already-exited check leaves no subscriber either", gone.subscribers() === 0, gone.subscribers());
}

// (b) watching turns false after the watch started
{
  let watching = true;
  const live = streaming("running");
  let calls = 0;
  const returned = watchProvedExit(live, () => { calls++; }, () => watching);
  check("#3595: a streaming watch returns true while watching", returned === true && live.subscribers() === 1);
  live.fire();
  check("#3595: the exit is delivered once while watching is true", calls === 1, calls);
  watching = false;
  live.fire();
  live.fire();
  check("#3595: the exit stops once watching turns false, and the subscriber is dropped", calls === 1 && live.subscribers() === 0, { calls, subscribers: live.subscribers() });

  const gone = streaming("exited");
  let goneCalls = 0;
  watchProvedExit(gone, () => { goneCalls++; }, () => true);
  check("#3595: an already-exited child is reported at once while watching is true", goneCalls === 1, goneCalls);
}

// (c) a backend that queues the exit instead of leaving a status
{
  const queued = streaming("running");
  const real = queued.attach.bind(queued);
  queued.attach = () => {
    const session = real();
    const onExit = session.onExit.bind(session);
    session.onExit = (fn) => {
      queueMicrotask(fn);
      return onExit(fn);
    };
    return session;
  };
  let off = 0;
  const returnedOff = watchProvedExit(queued, () => { off++; }, () => false);
  const queuedOn = streaming("running");
  const realOn = queuedOn.attach.bind(queuedOn);
  queuedOn.attach = () => {
    const session = realOn();
    const onExit = session.onExit.bind(session);
    session.onExit = (fn) => {
      queueMicrotask(fn);
      return onExit(fn);
    };
    return session;
  };
  let on = 0;
  const returnedOn = watchProvedExit(queuedOn, () => { on++; }, () => true);
  await new Promise((r) => setTimeout(r, 20));
  check("#3595: a queued exit is not delivered while watching is false", returnedOff === true && off === 0, { returnedOff, off });
  check("CONTROL: the same queued exit is delivered once while watching is true", returnedOn === true && on === 1, { returnedOn, on });
}

// (d) the polling branch is unchanged
{
  const off = polling(true);
  let offCalls = 0;
  const returnedOff = pollProvedExit(off, () => { offCalls++; }, () => false, 20);
  const on = polling(true);
  let onCalls = 0;
  const returnedOn = pollProvedExit(on, () => { onCalls++; }, () => true, 20);
  const via = polling(true);
  let viaCalls = 0;
  const returnedVia = watchProvedExit(via, () => { viaCalls++; }, () => false);
  const bare = polling(false);
  const returnedBare = watchProvedExit(bare, () => {}, () => true);
  await new Promise((r) => setTimeout(r, 80));
  check("CONTROL: the poller returns true and calls nothing while watching is false", returnedOff === true && offCalls === 0 && off.waits === 0, { returnedOff, offCalls, waits: off.waits });
  check("CONTROL: the poller calls once while watching is true", returnedOn === true && onCalls === 1 && on.waits === 1, { returnedOn, onCalls, waits: on.waits });
  check("CONTROL: a streaming watch whose attach throws delegates to the poller and calls nothing while watching is false", returnedVia === true && viaCalls === 0 && via.waits === 0, { returnedVia, viaCalls, waits: via.waits });
  check("CONTROL: a handle that can neither stream nor prove an exit makes the watch return false", returnedBare === false);
}

console.log(`\nWATCH-PROVED-EXIT ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
