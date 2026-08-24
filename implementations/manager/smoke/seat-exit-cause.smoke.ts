/**
 * WHEN A SEAT LEAVES, THE MANAGER MUST SAY WHY.
 * Run: pnpm smoke:seat-exit-cause   (no broker; in-process manager, plus real pty children in cells 7-9)
 *
 * THIS IS A REPRODUCTION FIRST. Written against the shipped behaviour and observed RED on it: the
 * manager logged NOTHING when a seat left its ownership, on any path.
 *
 * THE DEFECT, and how it was found. A live supervisor lost several seats while it kept running.
 * Its log carried no per-seat exit line and no timestamps, so "the supervisor reaped them" and
 * "they died on their own" were indistinguishable after the fact, and the incident could not be
 * attributed from supervisor state at all. Two facts were missing and they are different facts:
 * WHICH PATH gave up the slot, and WHAT THE RUNTIME SAW when the child ended.
 *
 * WHY BOTH HALVES ARE GRADED SEPARATELY. A line that names the path but not the exit status cannot
 * tell a clean `/exit` from a SIGKILL; a line that names the status but not the path cannot tell a
 * crash from a despawn. The incident needed both, so cells 1-3 grade the path and cells 4-6 grade
 * the runtime detail.
 *
 * THE ABSENT CASE IS GRADED, AND IT IS THE POINT OF THE OPTIONAL CONTRACT. `AgentHandle.exitInfo`
 * is optional: tmux/cmux/orca/herdr attach to an externally-owned process and genuinely cannot see
 * how it ended. Cell 5 requires that to print as UNAVAILABLE and name the runtime. A zero there
 * would be a fabricated clean exit on exactly the seats whose death nobody can account for — the
 * failure this suite exists to prevent, not a tidy default.
 *
 * THE POSITIVE CONTROL IS NOT OPTIONAL. Cells 0-6 assert on captured stderr, so a capture that
 * silently caught nothing would read as "no wrong line was printed" rather than as a broken
 * instrument. Cell 0 requires the capture to see a line the manager is already known to print.
 *
 * CELLS 7-9 START REAL CHILDREN, and they were added because the mutation harness refused to grade
 * the runtime half without them. Cells 0-6 use fake handles: they prove the manager PRINTS what a
 * runtime reports, and reach `runtime/pty.ts` not at all. Reverting the pty capture came back
 * UNGRADABLE rather than killed against those cells alone — correctly, since a suite that never
 * loads a file cannot be said to test it. The discarded `{ exitCode, signal }` is the ROOT of the
 * missing information, so it gets cells that actually spawn, exit, and read the result back.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHandle, AttachSession } from "@cotal-ai/core";
import { Manager } from "../src/manager.js";
import { PtyRuntime } from "../src/runtime/pty.js";

let failures = 0;
let checks = 0;
function check(label: string, condition: boolean, extra?: unknown): void {
  checks++;
  console.log(`${condition ? "ok" : "not ok"} - ${label}${condition ? "" : `: ${String(extra ?? "")}`}`);
  if (!condition) failures++;
}

type ExitInfo = { code?: number; signal?: number } | undefined;

/** `exitInfo` is deliberately configurable per handle: omitted entirely models a runtime that does
 *  not implement the optional member, which is a DIFFERENT state from one that implements it and
 *  has nothing to report yet. */
function fakeHandle(
  name: string,
  opts: { kind?: string; exitInfo?: () => ExitInfo; pid?: number } = {},
): AgentHandle {
  let state: "running" | "exited" = "running";
  const exits = new Set<() => void>();
  const session: AttachSession = {
    cols: 80, rows: 24,
    backlog: () => Buffer.alloc(0),
    onData: () => () => {},
    onExit: (fn) => { exits.add(fn); return () => exits.delete(fn); },
    write: () => {}, resize: () => {},
  };
  const handle: AgentHandle = {
    name,
    kind: opts.kind ?? "fake",
    pid: opts.pid,
    status: () => state,
    stop: () => { state = "exited"; for (const fn of exits) fn(); },
    waitForExit: async () => { state = "exited"; },
    interrupt: () => {},
    attach: () => session,
    ...(opts.exitInfo ? { exitInfo: opts.exitInfo } : {}),
  };
  return handle;
}

const root = mkdtempSync(join(tmpdir(), "cotal-exitcause-"));
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
writeFileSync(join(root, ".cotal", "agents", "worker.md"), "---\nname: worker\n---\nworker persona\n");

interface ManagedLike {
  id: string; name: string; lifecycleUid: string; handle: AgentHandle;
  suppressCleanup: boolean; terminalizing: boolean; startedAt: number;
}

function managerWith(handle: AgentHandle): { manager: Manager; agents: Map<string, ManagedLike> } {
  const manager = new Manager({ space: "exitcause-smoke", runtime: "pty", workspaceRoot: root });
  const agents = (manager as unknown as { agents: Map<string, ManagedLike> }).agents;
  (manager as unknown as { runtime: unknown }).runtime = { kind: "fake", spawn: () => handle };
  (manager as unknown as { ep: unknown }).ep = {
    ref: () => ({ id: "local.manager", name: "manager", role: "manager" }),
    getRoster: () => [], on: () => {}, off: () => {},
    releaseManagerLease: async () => {}, stop: async () => {},
  };
  (manager as unknown as { attach: unknown }).attach = { stop: async () => {} };
  agents.set(handle.name, {
    id: `local.${handle.name}`, name: handle.name, lifecycleUid: `uid-${handle.name}`,
    handle, suppressCleanup: false, terminalizing: false, startedAt: Date.now(),
  });
  return { manager, agents };
}

function capture(fn: () => void): string[] {
  const real = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { fn(); } finally { console.error = real; }
  return lines;
}

/** Drive the real free path for one cause and return what the operator would have seen. */
function reap(handle: AgentHandle, cause: string): { lines: string[]; seat: string | undefined } {
  const { manager } = managerWith(handle);
  const lines = capture(() =>
    (manager as unknown as { freeSlot(a: unknown, f: boolean, c: string): void })
      .freeSlot((manager as unknown as { agents: Map<string, ManagedLike> }).agents.get(handle.name), true, cause),
  );
  return { lines, seat: lines.find((l) => /seat reaped/i.test(l)) };
}

// ── Cell 0 — POSITIVE CONTROL for the capture itself ─────────────────────────────────────────
{
  const lines = capture(() => { console.error("probe line"); });
  check("CONTROL: stderr capture sees a line (instrument works)", lines.length === 1 && lines[0] === "probe line", lines);
}

// ── Cells 1-3 — WHICH PATH gave up the slot ──────────────────────────────────────────────────
{
  const { seat } = reap(fakeHandle("worker", { exitInfo: () => ({ code: 0 }) }), "process-exit");
  check("a self-driven exit is logged, naming the seat", seat !== undefined && seat.includes("worker") && seat.includes("uid-worker"), seat);
  check("…and says the manager did NOT stop it", /did not stop it/i.test(seat ?? ""), seat);
}
{
  const { seat } = reap(fakeHandle("worker", { exitInfo: () => ({ code: 0 }) }), "stopped");
  check("an operator despawn is logged as this manager stopping it", /this manager stopped it/i.test(seat ?? ""), seat);
}
{
  const { seat } = reap(fakeHandle("worker", { exitInfo: () => ({ code: 1 }) }), "pi-crash-loop");
  check("a crash-loop retirement names that cause specifically", /crash loop/i.test(seat ?? ""), seat);
}

// ── Cells 4-6 — WHAT THE RUNTIME SAW ─────────────────────────────────────────────────────────
{
  const { seat } = reap(fakeHandle("worker", { exitInfo: () => ({ code: 137, signal: 9 }) }), "process-exit");
  check("the runtime's exit code is reported", /exit code 137/.test(seat ?? ""), seat);
  check("…and the killing signal with it", /signal 9/.test(seat ?? ""), seat);
}
{
  // A runtime that does not implement the optional member at all — tmux/herdr/cmux/orca.
  const { seat } = reap(fakeHandle("worker", { kind: "tmux" }), "process-exit");
  check("a runtime that cannot see the exit says UNAVAILABLE, never a fabricated code 0", /unavailable/i.test(seat ?? "") && !/exit code 0/.test(seat ?? ""), seat);
  check("…and names the runtime that could not answer", /"tmux"/.test(seat ?? ""), seat);
}
{
  // A code of 0 is a real, clean exit and must not be confused with "no answer".
  const { seat } = reap(fakeHandle("worker", { exitInfo: () => ({ code: 0 }) }), "process-exit");
  check("a genuine clean exit reports code 0 rather than unavailable", /exit code 0/.test(seat ?? "") && !/unavailable/i.test(seat ?? ""), seat);
}
{
  // A runtime that throws when asked has still told us something; it must not take the free path down.
  const boom = fakeHandle("worker", { kind: "angry", exitInfo: () => { throw new Error("pty gone"); } });
  let threw = false;
  let seat: string | undefined;
  try { seat = reap(boom, "process-exit").seat; } catch { threw = true; }
  check("a runtime that throws while being asked does not break the free path", !threw, "freeSlot threw");
  check("…and the throw is reported rather than swallowed", /unreadable/i.test(seat ?? "") && /pty gone/.test(seat ?? ""), seat);
}

// ── Cells 7-9 — the pty runtime actually captures what node-pty reports ──────────────────────
// These start REAL children. Everything above uses fake handles, which grades the manager's line
// but never reaches the capture that feeds it — and the discarded `{ exitCode, signal }` in
// `runtime/pty.ts` is the root of the missing information, not a detail of it. The mutation harness
// reported the pty mutation UNGRADABLE against the fake-handle cells alone, which was correct and
// is why these exist: without them, the half of this change that lives in the runtime is unproven.
{
  const rt = new PtyRuntime();
  const clean = rt.spawn("exit42", { command: "/bin/sh", args: ["-c", "exit 42"], env: { PATH: "/usr/bin:/bin" } }, "/tmp");
  check("a live pty child's exitInfo is undefined while it is still running or just started", clean.status() === "running" ? clean.exitInfo?.() === undefined : true, clean.exitInfo?.());
  await clean.waitForExit!();
  check("the pty runtime reports the child's REAL exit code", clean.exitInfo?.()?.code === 42, clean.exitInfo?.());

  const killed = rt.spawn("killed", { command: "/bin/sh", args: ["-c", "sleep 30"], env: { PATH: "/usr/bin:/bin" } }, "/tmp");
  killed.stop({ graceful: false });
  await killed.waitForExit!();
  const info = killed.exitInfo?.();
  // node-pty reports the signal as a NUMBER, and a SIGKILLed child must not read as a clean exit.
  check("the pty runtime reports the killing signal, not a clean exit", info !== undefined && (info.signal === 9 || (info.code ?? 0) !== 0), info);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
