/**
 * A MANAGER THAT MAY NO LONGER SERVE MUST NOT DESTROY THE AGENTS IT WAS SERVING.
 * Run: pnpm smoke:detach-not-teardown   (no broker; in-process manager with a fake runtime)
 *
 * THIS IS A REPRODUCTION FIRST. Written against the shipped behaviour and observed RED on it.
 *
 * THE DEFECT. `failClosedOnLeaseLoss` is the path a manager takes when it can no longer prove it
 * holds its liveness lease. Stopping SERVING is the correct conclusion there and is not in question.
 * Destroying the CHILDREN is a separate act that the same branch performs: it calls
 * `teardownManagedAgents()`, which hard-stops every managed child and then deprovisions its
 * credential, its durables and its broker footprint. A supervisor that has merely lost the argument
 * about who serves the space has learned nothing about whether its agents should die.
 *
 * WHY THAT IS NOT THEORETICAL. `/home/david/mesh-logs/manager.log` records four occurrences on the
 * live space "main" of "could not renew its liveness lease (timeout) - the key is still ours at
 * revision N ... so this instance keeps serving". Each of those survived only because the re-read
 * answered. The neighbouring branch, taken when the re-read ALSO times out past the lease TTL, ends
 * in this teardown; the same log in a probe space shows it firing. On the day this suite was
 * written that supervisor was holding twelve seats.
 *
 * WHAT THIS SUITE GRADES, AND WHAT IT DOES NOT. It grades the CALL SITE (`failClosedOnLeaseLoss`
 * itself, with only `process.exit` neutralised) and not merely a helper reached from it, because a
 * detach helper that nothing calls is exactly the shape this defect would survive. It does NOT
 * claim a pty child survives the manager's exit: measured separately, a `@lydell/node-pty` child
 * dies when its spawning process exits (positive control: the same child stays alive while the
 * parent lives), and no manager-side policy changes that. What this fixes is the manager
 * DELIBERATELY killing and deprovisioning; making the child outlive the process is the seat-host
 * slice, and this suite must not be read as proving it.
 *
 * THE POSITIVE CONTROL IS NOT OPTIONAL. "stops === 0" is also what a broken counter reports, and a
 * suite whose instrument never fires reads identically to a suite whose subject behaved. Cell 0
 * drives the ORDINARY shutdown path, which is deliberately left destructive, and requires the same
 * counter to reach 1. Without that, every zero below is unearned.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHandle, AttachSession } from "@cotal-ai/core";
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

const root = mkdtempSync(join(tmpdir(), "cotal-detach-"));
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
writeFileSync(join(root, ".cotal", "agents", "worker.md"), "---\nname: worker\n---\nworker persona\n");

/** A manager with no broker: every plane the exit paths touch is a stub that records nothing but
 *  answers, so what the cells observe is the exit path's own decision about the CHILDREN. */
function managerWith(handles: FakeHandle[], opts: { resumeAttemptId?: string } = {}): { manager: Manager; agents: Map<string, ManagedLike> } {
  const manager = new Manager({ space: "detach-smoke", runtime: "pty", workspaceRoot: root, resumeAttemptId: opts.resumeAttemptId });
  const agents = (manager as unknown as { agents: Map<string, ManagedLike> }).agents;
  (manager as unknown as { runtime: unknown }).runtime = { kind: "fake", spawn: () => handles[0] };
  (manager as unknown as { ep: unknown }).ep = {
    ref: () => ({ id: "local.manager", name: "manager", role: "manager" }),
    getRoster: () => [],
    on: () => {},
    off: () => {},
    releaseManagerLease: async () => {},
    stop: async () => {},
  };
  (manager as unknown as { attach: unknown }).attach = { stop: async () => {} };
  for (const h of handles) {
    agents.set(h.name, {
      id: `local.${h.name}`,
      name: h.name,
      lifecycleUid: `uid-${h.name}`,
      handle: h,
      suppressCleanup: false,
      terminalizing: false,
    });
  }
  return { manager, agents };
}

interface ManagedLike {
  id: string;
  name: string;
  lifecycleUid: string;
  handle: FakeHandle;
  suppressCleanup: boolean;
  terminalizing: boolean;
}

/** Run `fn` with `process.exit` neutralised, so a cell can drive a real exit path to completion and
 *  then inspect what it did. The stub THROWS a sentinel rather than returning, because the shipped
 *  signature is `never` and code after it is unreachable by contract — letting it return would run
 *  statements the real process never reaches and grade a path that does not exist. */
const EXITED = Symbol("process.exit");
async function withExitStubbed(fn: () => Promise<unknown>): Promise<{ exited: boolean; code?: number }> {
  const real = process.exit;
  let code: number | undefined;
  let exited = false;
  (process as unknown as { exit: (c?: number) => never }).exit = ((c?: number) => {
    exited = true;
    code = c;
    throw EXITED;
  }) as (c?: number) => never;
  try {
    await fn();
  } catch (e) {
    if (e !== EXITED) throw e;
  } finally {
    (process as unknown as { exit: typeof real }).exit = real;
  }
  return { exited, code };
}

/** Capture console.error for the duration of `fn` — the manager's only operator channel. */
async function withErrorCapture(fn: () => Promise<unknown>): Promise<string[]> {
  const real = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.error = real;
  }
  return lines;
}

// ── Cell 0 — POSITIVE CONTROL ────────────────────────────────────────────────────────────────
// The ordinary shutdown path is deliberately destructive and must stay so: `cotal down` and Ctrl-C
// mean shut the mesh down. If this cell does not see a stop, the counter is broken and every zero
// below is worthless rather than reassuring.
{
  const h = fakeHandle("worker");
  const { manager } = managerWith([h]);
  await manager.stop();
  check("CONTROL: the ordinary stop path stops the child (instrument fires)", h.stops === 1, `stops=${h.stops}`);
}

// ── Cell 1 — the graded cell: lease loss must not stop the children ──────────────────────────
{
  const a = fakeHandle("worker");
  const b = fakeHandle("worker2");
  const { manager } = managerWith([a, b]);
  const outcome = await withExitStubbed(() =>
    (manager as unknown as { failClosedOnLeaseLoss(p: string): Promise<never> }).failClosedOnLeaseLoss("smoke: lease key is GONE"),
  );
  check("lease loss still ends the process (the serving conclusion is unchanged)", outcome.exited && outcome.code === 1, outcome);
  check("lease loss does not stop child 1", a.stops === 0, `stops=${a.stops}`);
  check("lease loss does not stop child 2", b.stops === 0, `stops=${b.stops}`);
}

// ── Cell 2 — the footprint must be retained, not deprovisioned ───────────────────────────────
// `suppressCleanup` is the flag every deprovision call site filters on, so a detached agent that
// carries it cannot be selected for teardown by any later path in this process.
{
  const a = fakeHandle("worker");
  const { manager, agents } = managerWith([a]);
  const before = agents.get("worker")!;
  await withExitStubbed(() =>
    (manager as unknown as { failClosedOnLeaseLoss(p: string): Promise<never> }).failClosedOnLeaseLoss("smoke: lease key is GONE"),
  );
  check("lease loss marks the agent retained rather than deprovisionable", before.suppressCleanup === true, before.suppressCleanup);
  check("lease loss releases ownership of the agent (this instance stops managing it)", agents.size === 0, agents.size);
}

// ── Cell 3 — the detach must be announced, naming the seats left running ─────────────────────
// The motivating incident could not be attributed because the manager logs nothing when seats leave
// its ownership. A detach that is silent is indistinguishable from the teardown it replaced.
{
  const a = fakeHandle("worker");
  const { manager } = managerWith([a]);
  const lines = await withErrorCapture(() =>
    withExitStubbed(() =>
      (manager as unknown as { failClosedOnLeaseLoss(p: string): Promise<never> }).failClosedOnLeaseLoss("smoke: lease key is GONE"),
    ),
  );
  const detachLine = lines.find((l) => /detach/i.test(l) && l.includes("worker"));
  check("lease loss logs a detach line naming the seat", detachLine !== undefined, lines);
  check("the detach line says the seat was left running, not stopped", /left running|not stopped|still running/i.test(detachLine ?? ""), detachLine);
}

// ── Cell 4 — the boundary: a resume-pending cut must still STOP its children ─────────────────
// Detach is right for a manager that simply may no longer serve. It is WRONG while a maintenance
// cut has committed and not finalized: that inventory is still owed a replay, and a successor that
// replays it while these children are running spawns a SECOND copy of every seat under the same
// identities. That window keeps the retained stop — which stops the child WITHOUT deprovisioning
// it — and this cell exists so the two arms cannot be collapsed back into one by a later edit.
// `smoke:preserve-state` covers the same boundary from the resume side; it caught this exact
// regression when the first cut of the fix detached unconditionally.
{
  const a = fakeHandle("worker");
  const { manager } = managerWith([a], { resumeAttemptId: "cell4" });
  await withErrorCapture(() =>
    withExitStubbed(() =>
      (manager as unknown as { failClosedOnLeaseLoss(p: string): Promise<never> }).failClosedOnLeaseLoss("smoke: lease key is GONE"),
    ),
  );
  check("a resume-pending cut still stops its children on lease loss (never detaches them)", a.stops === 1, `stops=${a.stops}`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
