/**
 * A MANAGER NEVER ENDS ITS OWN PROCESS OVER ITS LIVENESS LEASE.
 * Run: pnpm smoke:lease-loss-keeps-serving   (no broker; in-process manager with a fake runtime)
 *
 * THIS IS A REPRODUCTION FIRST. Written against the shipped behaviour and observed RED on it.
 *
 * THE DEFECT. `renewLease` fail-closed: one tick past the lease TTL with no answer from the broker, or
 * on a key read back gone or held by another pid, it stopped serving, detached or stopped every seat it
 * held, and called `process.exit(1)`. On the live space "netcup" (2026-08-27) the broker denied the
 * manager's KV publishes for a few seconds; the renew failed, the re-read failed, and ten seconds later
 * the manager was gone, and with it every pty seat it held (a pty child dies with its parent). Nothing
 * restarted it. The outage lasted until an operator noticed, ten hours later.
 *
 * WHAT THIS SUITE GRADES. Every verdict the lease re-read can return (`unknown`, `gone`, `taken`) and
 * the recovery after it, driven through the real `renewLease` against a stub endpoint, with
 * `process.exit` neutralised so a regression is observed rather than fatal. For each: the process is not
 * ended, no child is stopped, no agent leaves the managed map, and the operator gets one line, not one
 * per tick. `gone` must also put the key back.
 *
 * THE POSITIVE CONTROL IS NOT OPTIONAL. "stops === 0" is also what a broken counter reports. Cell 0
 * drives the ORDINARY shutdown path, which stays destructive, and requires the same counter to reach 1.
 * Without that, every zero below is unearned.
 *
 * NOT GRADED: the wire. Whether the broker actually answers `gone` after an expiry, and whether a real
 * manager survives a real blackout, is `smoke:lease-renew` (a real broker behind a relay that can stall
 * and drop). This suite is the in-process half: the decision, with every plane stubbed.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHandle, AttachSession, ManagerLeaseInfo } from "@cotal-ai/core";
import { Manager } from "../src/manager.js";

let failures = 0;
let checks = 0;
function check(label: string, condition: boolean, extra?: unknown): void {
  checks++;
  console.log(`${condition ? "ok" : "not ok"} - ${label}${condition ? "" : `: ${String(extra ?? "")}`}`);
  if (!condition) failures++;
}

interface FakeHandle extends AgentHandle {
  stops: number;
}

function fakeHandle(name: string): FakeHandle {
  let state: "running" | "exited" = "running";
  const exits = new Set<() => void>();
  const session: AttachSession = {
    cols: 80,
    rows: 24,
    backlog: () => Buffer.alloc(0),
    onData: () => () => {},
    onExit: (fn) => { exits.add(fn); return () => exits.delete(fn); },
    write: () => {},
    resize: () => {},
  };
  const handle: FakeHandle = {
    name,
    kind: "fake",
    stops: 0,
    status: () => state,
    stop: () => {
      handle.stops++;
      state = "exited";
      for (const fn of exits) fn();
    },
    waitForExit: () => state === "exited"
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const done = (): void => { exits.delete(done); resolve(); };
          exits.add(done);
        }),
    interrupt: () => {},
    attach: () => session,
  };
  return handle;
}

const root = mkdtempSync(join(tmpdir(), "cotal-lease-loss-"));
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
writeFileSync(join(root, ".cotal", "agents", "worker.md"), "---\nname: worker\n---\nworker persona\n");

interface ManagedLike {
  id: string;
  name: string;
  lifecycleUid: string;
  handle: FakeHandle;
  suppressCleanup: boolean;
  terminalizing: boolean;
}

/** What one renew tick sees from the broker. `renew` and `read` throw or answer as told; `acquire`
 *  records whether the manager tried to put a gone key back. */
interface LeaseWire {
  renew: () => Promise<number>;
  read: () => Promise<{ info: ManagerLeaseInfo; revision: number } | undefined>;
  acquire?: () => Promise<number>;
}

interface Driven {
  manager: Manager;
  agents: Map<string, ManagedLike>;
  /** One renew tick through the real `renewLease`, with `process.exit` neutralised. */
  tick: () => Promise<{ exited: boolean; lines: string[] }>;
  revision: () => number | undefined;
  acquires: () => number;
}

/** A manager with no broker: every plane the lease path touches is a stub that answers as the cell
 *  says, so what the cells observe is the renew loop's own decision about the PROCESS and the CHILDREN. */
function managerWith(handles: FakeHandle[], wire: LeaseWire, opts: { resumeAttemptId?: string } = {}): Driven {
  const manager = new Manager({ space: "lease-loss-smoke", runtime: "pty", workspaceRoot: root, resumeAttemptId: opts.resumeAttemptId });
  const m = manager as unknown as {
    agents: Map<string, ManagedLike>;
    runtime: unknown; ep: unknown; attach: unknown;
    leaseInfo?: Omit<ManagerLeaseInfo, "since">; leaseRevision?: number;
    renewLease(): Promise<void>;
  };
  let acquires = 0;
  m.runtime = { kind: "fake", spawn: () => handles[0] };
  m.ep = {
    ref: () => ({ id: "local.manager", name: "manager", role: "manager" }),
    getRoster: () => [],
    on: () => {},
    off: () => {},
    renewManagerLease: wire.renew,
    readOwnManagerLease: wire.read,
    acquireManagerLease: async () => { acquires++; if (!wire.acquire) throw new Error("acquire not expected in this cell"); return wire.acquire(); },
    releaseManagerLease: async () => {},
    stop: async () => {},
  };
  m.attach = { stop: async () => {} };
  m.leaseInfo = { holder: "local.manager", instanceId: "smoke-instance", runtime: "pty", root, pid: process.pid };
  m.leaseRevision = 1;
  for (const h of handles) {
    m.agents.set(h.name, {
      id: `local.${h.name}`,
      name: h.name,
      lifecycleUid: `uid-${h.name}`,
      handle: h,
      suppressCleanup: false,
      terminalizing: false,
    });
  }
  const tick = async (): Promise<{ exited: boolean; lines: string[] }> => {
    const lines: string[] = [];
    const realError = console.error;
    const realExit = process.exit;
    let exited = false;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    (process as unknown as { exit: (c?: number) => never }).exit = (() => { exited = true; throw new Error("process.exit called"); }) as never;
    try {
      await m.renewLease();
    } catch (e) {
      if (!exited) throw e;
    } finally {
      console.error = realError;
      (process as unknown as { exit: typeof realExit }).exit = realExit;
    }
    return { exited, lines };
  };
  return { manager, agents: m.agents, tick, revision: () => m.leaseRevision, acquires: () => acquires };
}

const timeout = async (): Promise<never> => { throw new Error("timeout"); };
const other: ManagerLeaseInfo = { holder: "local.other", instanceId: "smoke-instance", runtime: "pty", root, pid: process.pid + 1, since: 0 };

// ── Cell 0 — POSITIVE CONTROL ────────────────────────────────────────────────────────────────
// The ordinary shutdown path is deliberately destructive and must stay so: `cotal down` and Ctrl-C
// mean shut the mesh down. If this cell does not see a stop, the counter is broken and every zero
// below is worthless rather than reassuring.
{
  const h = fakeHandle("worker");
  const { manager } = managerWith([h], { renew: timeout, read: timeout });
  await manager.stop();
  check("CONTROL: the ordinary stop path stops the child (instrument fires)", h.stops === 1, `stops=${h.stops}`);
}

// ── Cell 1 — unknown: the broker cannot be asked, for as long as that lasts ──────────────────
{
  const a = fakeHandle("worker");
  const b = fakeHandle("worker2");
  const d = managerWith([a, b], { renew: timeout, read: timeout });
  const first = await d.tick();
  check("unknown: the process is not ended", first.exited === false, first);
  check("unknown: no child is stopped", a.stops === 0 && b.stops === 0, `stops=${a.stops},${b.stops}`);
  check("unknown: every agent stays in the managed map", d.agents.size === 2, d.agents.size);
  check("unknown: the operator is told it is still serving and retrying", first.lines.some((l) => /serving, retrying/.test(l)), first.lines);
  // Ten hours of ticks is one line, not fourteen thousand.
  const more = [await d.tick(), await d.tick(), await d.tick()];
  check("unknown: repeated ticks in the same state print nothing more", more.every((t) => t.lines.length === 0 && !t.exited), more.map((t) => t.lines));
  // ── Cell 4 — recovery: the broker answers again ─────────────────────────────────────────────
  const dm = d.manager as unknown as { ep: { renewManagerLease: () => Promise<number> } };
  dm.ep.renewManagerLease = async () => 9;
  const back = await d.tick();
  check("recovery: a renew that lands moves the revision and says so once", d.revision() === 9 && back.lines.length === 1 && /✓/.test(back.lines[0] ?? ""), { revision: d.revision(), lines: back.lines });
  const quiet = await d.tick();
  check("recovery: the next ordinary renew prints nothing", quiet.lines.length === 0, quiet.lines);
  check("recovery: nothing was stopped along the way", a.stops === 0 && b.stops === 0 && d.agents.size === 2, `stops=${a.stops},${b.stops} agents=${d.agents.size}`);
}

// ── Cell 2 — gone: the key expired while this process was still here ─────────────────────────
{
  const a = fakeHandle("worker");
  const d = managerWith([a], { renew: timeout, read: async () => undefined, acquire: async () => 42 });
  const t = await d.tick();
  check("gone: the process is not ended", t.exited === false, t);
  check("gone: the key is put back (acquire called once) and the new revision is adopted", d.acquires() === 1 && d.revision() === 42, { acquires: d.acquires(), revision: d.revision() });
  check("gone: no child is stopped and the agent stays managed", a.stops === 0 && d.agents.size === 1, `stops=${a.stops} agents=${d.agents.size}`);
  check("gone: the operator is told the key was gone and re-acquired", t.lines.some((l) => /gone/.test(l) && /re-acquired/.test(l)), t.lines);
}

// ── Cell 3 — taken: a same-id process holds the key ──────────────────────────────────────────
{
  const a = fakeHandle("worker");
  const d = managerWith([a], { renew: timeout, read: async () => ({ info: other, revision: 7 }) });
  const t = await d.tick();
  check("taken: the process is not ended", t.exited === false, t);
  check("taken: no child is stopped and the agent stays managed", a.stops === 0 && d.agents.size === 1, `stops=${a.stops} agents=${d.agents.size}`);
  check("taken: the held revision is not adopted from another process's key", d.revision() === 1, d.revision());
  check("taken: the operator is told which pid holds it and to stop one of the two", t.lines.some((l) => l.includes(`pid ${other.pid}`) && /stop one of them/.test(l)), t.lines);
}

// ── Cell 5 — a resume-pending cut keeps its children too ─────────────────────────────────────
// The old exit path had a second arm for a maintenance cut that had committed and not finalized: it
// stopped the children rather than detaching them. There is no exit now, so there is no arm; this cell
// pins that a later edit does not bring a "retained stop" back under any lease verdict.
{
  const a = fakeHandle("worker");
  const d = managerWith([a], { renew: timeout, read: timeout }, { resumeAttemptId: "cell5" });
  const t = await d.tick();
  check("resume-pending: the process is not ended and the child is not stopped", t.exited === false && a.stops === 0, { exited: t.exited, stops: a.stops });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
