/**
 * WHAT STOPPING, EXITING AND RETIRING A SEAT MUST DO. A characterisation of the manager's
 * retirement and seat-stop paths, written against the unmoved code so that a move of those paths
 * into their own component has a behavioural floor to pass unchanged.
 * Run: pnpm smoke:seat-stop-guarantees   (no broker; in-process manager over fake handles)
 *
 * Every cell drives a real door or a real manager member (opStop, the exit handler, the recursive
 * reap, the retirement pool, the admission chokepoint, the membership inventory, the mesh watch,
 * the delegated-retire door) and asserts something observable: the reply, the slot map, a stderr
 * line, or a call the fake recorded. Waits are on promises and recorded calls, never on a clock.
 *
 * The seams are the ones the manager has today: `runtime` and `ep` replaced on the instance, the
 * `agents` map, and stderr. Nothing in src gains a hook for this file. Guarantees that would need
 * one are listed in LEFT OUT at the bottom rather than half-tested.
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
  console.log(`${condition ? "ok" : "not ok"} - ${label}${condition ? "" : `: ${JSON.stringify(extra ?? "")}`}`);
  if (!condition) failures++;
}

/** A settable promise, so a cell decides when a fake's wait resolves instead of sleeping. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Let every queued microtask and the promise chains they start run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

interface FakeOpts {
  kind?: string;
  /** "none" omits the member (a runtime that cannot prove exit); a function is a controlled wait. */
  wait?: "none" | (() => Promise<void>);
  stopThrows?: string;
  exitInfo?: "none" | "throws" | (() => { code?: number; signal?: number });
}

interface Fake { handle: AgentHandle; stops: Array<{ graceful?: boolean }> }

function fakeHandle(name: string, opts: FakeOpts = {}): Fake {
  let state: "running" | "exited" = "running";
  const stops: Array<{ graceful?: boolean }> = [];
  const session: AttachSession = {
    cols: 80, rows: 24,
    backlog: () => Buffer.alloc(0),
    onData: () => () => {},
    onExit: () => () => {},
    write: () => {}, resize: () => {},
  };
  const handle: AgentHandle = {
    name,
    kind: opts.kind ?? "fake",
    status: () => state,
    stop: (o?: { graceful?: boolean }) => {
      stops.push({ graceful: o?.graceful });
      if (opts.stopThrows) throw new Error(opts.stopThrows);
    },
    interrupt: () => {},
    attach: () => session,
  };
  if (opts.wait !== "none") {
    const w = opts.wait;
    (handle as { waitForExit?: () => Promise<void> }).waitForExit = async () => { if (w) await w(); state = "exited"; };
  }
  if (opts.exitInfo === "throws") (handle as { exitInfo?: () => never }).exitInfo = () => { throw new Error("runtime asked mid-teardown"); };
  else if (typeof opts.exitInfo === "function") (handle as { exitInfo?: unknown }).exitInfo = opts.exitInfo;
  else if (opts.exitInfo === undefined) (handle as { exitInfo?: unknown }).exitInfo = () => ({ code: 0 });
  return { handle, stops };
}

interface Row {
  id: string; name: string; lifecycleUid: string; handle: AgentHandle;
  suppressCleanup: boolean; terminalizing: boolean; startedAt: number; spawner?: string; userOwner?: string;
  stopCause?: unknown;
  restart?: { armed?: boolean; recovering?: boolean; policy?: { restarts: number; windowMs: number } };
  launch: { allowSubscribe: string[]; source: { kind: "persona" } };
}

interface Internals {
  agents: Map<string, Row>;
  maintenanceState: string;
  unverifiedStops: Array<{ name: string; authoritative?: boolean; error?: string }>;
  ep: Record<string, unknown>;
  opStop(args: Record<string, unknown>, caller: string, admin: boolean): Promise<{ ok: boolean; error?: string; data?: unknown }>;
  onAgentExit(a: Row): void;
  withRetirementSlot<T>(run: () => Promise<T>): Promise<T>;
  admitControl(caller: string): { refusal?: string; fence?: string; release?: () => void };
  lifecycleMembershipInventory(a: { id: string; lifecycleUid: string }): Promise<{ complete: boolean; channels: string[]; reason?: string }>;
  logSeatMeshTransitions(): void;
  retireDelegatedAgent(name: string, intentId: string): Promise<{ ok: boolean; error?: string }>;
  sessionRecovery: { recoverManagedSession(a: Row): void };
}

const root = mkdtempSync(join(tmpdir(), "cotal-seatstop-"));
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
writeFileSync(join(root, ".cotal", "agents", "worker.md"), "---\nname: worker\n---\nworker persona\n");

function managerWith(fakes: Fake[], ep: Record<string, unknown> = {}): { m: Internals; rows: Map<string, Row> } {
  const manager = new Manager({ space: "seatstop-smoke", runtime: "pty", workspaceRoot: root });
  const m = manager as unknown as Internals;
  (manager as unknown as { runtime: unknown }).runtime = { kind: "fake", spawn: () => fakes[0]?.handle };
  m.ep = {
    ref: () => ({ id: "local.manager", name: "manager", role: "manager" }),
    getRoster: () => [], on: () => {}, off: () => {},
    releaseManagerLease: async () => {}, releaseDaemonRenewalLease: async () => {}, stop: async () => {},
    ...ep,
  };
  (manager as unknown as { attach: unknown }).attach = { stop: async () => {} };
  for (const f of fakes) m.agents.set(f.handle.name, {
    id: `${f.handle.name}nkey`, name: f.handle.name, lifecycleUid: uidOf(f.handle.name), handle: f.handle,
    suppressCleanup: false, terminalizing: false, startedAt: Date.now(), launch: { allowSubscribe: [], source: { kind: "persona" } },
  });
  return { m, rows: m.agents };
}

/** A valid lifecycle token ([a-z0-9]{26,32}) per seat name, so each row's uid reads back by name. */
function uidOf(name: string): string {
  return (name.replace(/[^a-z0-9]/g, "") + "0".repeat(26)).slice(0, 26);
}

/** The wire principal the manager derives for a static row: `local.<nkey>`. */
const wire = (id: string) => `local.${id}`;

async function captureAsync<T>(fn: () => Promise<T> | T): Promise<{ lines: string[]; ret: T }> {
  const real = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  let ret!: T;
  try { ret = await fn(); await settle(); } finally { console.error = real; }
  return { lines, ret };
}
const reapLine = (lines: string[], name: string) => lines.find((l) => l.startsWith(`seat reaped: ${name} (`));

// ── STOP ───────────────────────────────────────────────────────────────────────────────────────
{
  const w = fakeHandle("worker", { wait: () => new Promise(() => {}) });
  const { m, rows } = managerWith([w]);
  const row = rows.get("worker")!;
  row.spawner = "local.alice";
  // The latch is read inside the runtime's own stop call: whatever else the door does, the row must
  // already refuse later renewals by the time the runtime is asked to stop the child.
  let latchedAtStop: boolean | undefined;
  const stop = w.handle.stop;
  w.handle.stop = (o) => { latchedAtStop = rows.get("worker")?.terminalizing; return stop(o); };
  await captureAsync(() => m.opStop({ name: "worker" }, "local.alice", false));
  check("G1 a stop latches terminalizing on the row before it asks the runtime to stop the child", latchedAtStop === true && w.stops.length === 1, { latchedAtStop, stops: w.stops.length });
}
{
  const w = fakeHandle("worker", { wait: () => new Promise(() => {}) });
  const { m, rows } = managerWith([w]);
  const row = rows.get("worker")!;
  row.stopCause = { kind: "stopped-self" };
  row.spawner = "local.alice";
  const { lines } = await captureAsync(() => m.opStop({ name: "worker" }, "local.alice", false));
  check("G2 a later stop does not overwrite the cause an earlier stop recorded on the row",
    (row.stopCause as { kind?: string })?.kind === "stopped-self" && /stopped it at local\.alice's request/.test(reapLine(lines, "worker") ?? ""), { cause: row.stopCause });
}
{
  const w = fakeHandle("worker", { stopThrows: "tmux window already gone" });
  const { m, rows } = managerWith([w]);
  rows.get("worker")!.spawner = "local.alice";
  let threw = false;
  const { lines, ret } = await captureAsync(() => m.opStop({ name: "worker" }, "local.alice", false).catch((e: unknown) => { threw = true; return { ok: false, error: String(e) }; }));
  check("G3 a runtime stop that throws is logged with its reason and does not throw out of opStop",
    !threw && ret.ok === true && lines.some((l) => l.startsWith("stop worker (") && l.includes("tmux window already gone")), { threw, ret, lines });
}
{
  const w = fakeHandle("worker");
  const { m, rows } = managerWith([w]);
  rows.get("worker")!.spawner = "local.alice";
  const { ret } = await captureAsync(() => m.opStop({ name: "worker" }, "local.mallory", false));
  check("G4 a named stop by a caller that is not the spawner (static mesh, not admin) is refused",
    ret.ok === false && /not authorized: worker was not spawned by local\.mallory/.test(ret.error ?? ""), ret);
  check("G4 …and the seat keeps running and keeps its slot", w.stops.length === 0 && rows.has("worker") && rows.get("worker")!.terminalizing === false,
    { stops: w.stops.length, has: rows.has("worker") });
}
{
  const gate = deferred();
  const w = fakeHandle("worker", { wait: () => gate.promise });
  const { m, rows } = managerWith([w]);
  rows.get("worker")!.spawner = "local.alice";
  const { ret, lines } = await captureAsync(() => m.opStop({ name: "worker", graceful: true }, "local.alice", false));
  check("G5 an accepted named stop replies ok with the name, stopped and graceful",
    ret.ok === true && JSON.stringify(ret.data) === JSON.stringify({ name: "worker", stopped: true, graceful: true }), ret);
  check("G5 …frees the slot before the child is proven gone", !rows.has("worker") && reapLine(lines, "worker") !== undefined, { has: rows.has("worker") });
  check("G5 …and asks the runtime for a graceful stop", w.stops.length === 1 && w.stops[0].graceful === true, w.stops);
  gate.resolve();
  await settle();
}
{
  const w = fakeHandle("worker", { wait: "none" });
  const { m, rows } = managerWith([w]);
  rows.get("worker")!.spawner = "local.alice";
  const { ret } = await captureAsync(() => m.opStop({ name: "worker" }, "local.alice", false));
  const u = m.unverifiedStops.find((s) => s.name === "worker");
  check("G6 a runtime that cannot prove exit records a non-authoritative unverified stop and still frees the slot",
    ret.ok === true && !rows.has("worker") && u !== undefined && u.authoritative === false, { u, has: rows.has("worker") });
}
{
  const gate = deferred();
  const w = fakeHandle("worker", { wait: () => gate.promise });
  const { m, rows } = managerWith([w]);
  rows.get("worker")!.spawner = "local.alice";
  await captureAsync(() => m.opStop({ name: "worker" }, "local.alice", false));
  check("G7 control: no unverified stop is recorded while the exit wait is still open", m.unverifiedStops.length === 0, m.unverifiedStops);
  gate.reject(new Error("runtime lost the child"));
  await settle();
  const u = m.unverifiedStops.find((s) => s.name === "worker");
  check("G7 an exit wait that fails records an authoritative unverified stop naming the failure",
    u !== undefined && u.authoritative === true && /accepted stop could not prove exit: .*runtime lost the child/.test(u.error ?? ""), u);
}

// ── EXIT CAUSE ─────────────────────────────────────────────────────────────────────────────────
{
  const w = fakeHandle("worker", { exitInfo: () => ({ code: 3 }) });
  const { m, rows } = managerWith([w]);
  const { lines } = await captureAsync(() => m.onAgentExit(rows.get("worker")!));
  const line = reapLine(lines, "worker");
  check("G8 an exit nobody asked for frees the slot as process-exit and says the manager did not stop it",
    !rows.has("worker") && line !== undefined && /did not stop it/.test(line) && /exit code 3/.test(line), line);
}
{
  const gate = deferred();
  const w = fakeHandle("worker", { wait: () => gate.promise });
  const { m, rows } = managerWith([w]);
  rows.get("worker")!.spawner = "local.alice";
  const { lines } = await captureAsync(() => m.opStop({ name: "worker" }, "local.alice", false));
  const line = reapLine(lines, "worker");
  check("G9 the reap line of a requested stop names the requesting principal, not process-exit",
    line !== undefined && /stopped it at local\.alice's request/.test(line) && !/did not stop it/.test(line), line);
  gate.resolve();
  await settle();
}
{
  const a = fakeHandle("absent", { exitInfo: "none", kind: "tmux" });
  const t = fakeHandle("throwing", { exitInfo: "throws", kind: "cmux" });
  const { m, rows } = managerWith([a, t]);
  const { lines } = await captureAsync(() => { m.onAgentExit(rows.get("absent")!); m.onAgentExit(rows.get("throwing")!); });
  check("G10 a runtime that cannot report the exit prints it as unavailable, naming the runtime",
    /exit detail unavailable from runtime "tmux"/.test(reapLine(lines, "absent") ?? ""), reapLine(lines, "absent"));
  check("G10 …and one that throws while asked prints it as unreadable and still frees the slot",
    /exit detail unreadable from runtime "cmux": runtime asked mid-teardown/.test(reapLine(lines, "throwing") ?? "") && !rows.has("throwing"), reapLine(lines, "throwing"));
}
{
  const w = fakeHandle("worker");
  const { m, rows } = managerWith([w]);
  m.maintenanceState = "preserving";
  const { lines } = await captureAsync(() => m.onAgentExit(rows.get("worker")!));
  check("G11 while a preservation cut is forming, an exit frees nothing and logs no reap",
    rows.has("worker") && reapLine(lines, "worker") === undefined, { has: rows.has("worker"), lines });
}

// ── RECURSIVE REAP ─────────────────────────────────────────────────────────────────────────────
{
  const gates = { child: deferred(), grand: deferred() };
  const parent = fakeHandle("parent");
  const child = fakeHandle("child", { wait: () => gates.child.promise });
  const grand = fakeHandle("grand", { wait: () => gates.grand.promise });
  const other = fakeHandle("other");
  const { m, rows } = managerWith([parent, child, grand, other]);
  rows.get("child")!.spawner = wire("parentnkey");
  rows.get("grand")!.spawner = wire("childnkey");
  rows.get("other")!.spawner = "local.someone-else";
  const order: string[] = [];
  for (const f of [child, grand]) { const s = f.handle.stop; f.handle.stop = (o) => { order.push(f.handle.name); return s(o); }; }
  await captureAsync(() => m.onAgentExit(rows.get("parent")!));
  check("G12 a parent's exit stops every descendant, deepest first, hard",
    JSON.stringify(order) === JSON.stringify(["grand", "child"]) && child.stops[0]?.graceful === false && grand.stops[0]?.graceful === false, { order, c: child.stops, g: grand.stops });
  check("G13 a reaped child keeps its slot until the runtime proves it exited", rows.has("child") && rows.has("grand"), { child: rows.has("child"), grand: rows.has("grand") });
  check("G14 a seat spawned by someone else is untouched", other.stops.length === 0 && rows.has("other"), other.stops);
  const freed = await captureAsync(async () => { gates.grand.resolve(); gates.child.resolve(); await settle(); });
  check("G13 …and is freed once it has, its reap line naming the parent that left",
    !rows.has("child") && !rows.has("grand") && /because its parent local\.parentnkey left \(recursive reap\)/.test(reapLine(freed.lines, "child") ?? ""),
    { line: reapLine(freed.lines, "child") });
}

// ── RESTART ────────────────────────────────────────────────────────────────────────────────────
{
  const w = fakeHandle("worker");
  const { m, rows } = managerWith([w]);
  const row = rows.get("worker")!;
  row.restart = { armed: true, policy: { restarts: 3, windowMs: 60_000 } };
  const recovered: string[] = [];
  m.sessionRecovery.recoverManagedSession = (a) => { recovered.push(a.name); };
  const { lines } = await captureAsync(() => m.onAgentExit(row));
  check("G15 an armed supervised seat that exits is recovered in place, not freed",
    JSON.stringify(recovered) === JSON.stringify(["worker"]) && rows.has("worker") && reapLine(lines, "worker") === undefined, { recovered, has: rows.has("worker") });
}
{
  const w = fakeHandle("worker");
  const { m, rows } = managerWith([w]);
  const row = rows.get("worker")!;
  row.restart = { armed: true, recovering: true, policy: { restarts: 3, windowMs: 60_000 } };
  const recovered: string[] = [];
  m.sessionRecovery.recoverManagedSession = (a) => { recovered.push(a.name); };
  const { lines } = await captureAsync(() => m.onAgentExit(row));
  check("G16 a replacement that exits while it is proving readiness neither frees the slot nor starts another recovery",
    rows.has("worker") && recovered.length === 0 && reapLine(lines, "worker") === undefined, { has: rows.has("worker"), recovered });
}
{
  const w = fakeHandle("worker");
  const { m, rows } = managerWith([w]);
  const row = rows.get("worker")!;
  row.restart = { armed: true, policy: { restarts: 3, windowMs: 60_000 } };
  row.terminalizing = true;
  row.stopCause = { kind: "stopped-requested", requester: "local.alice" };
  const recovered: string[] = [];
  m.sessionRecovery.recoverManagedSession = (a) => { recovered.push(a.name); };
  const { lines } = await captureAsync(() => m.onAgentExit(row));
  check("G17 a seat that is being stopped is freed on exit, not restarted, under its stop cause",
    !rows.has("worker") && recovered.length === 0 && /stopped it at local\.alice's request/.test(reapLine(lines, "worker") ?? ""), { recovered, line: reapLine(lines, "worker") });
}

// ── RETIREMENT POOL ────────────────────────────────────────────────────────────────────────────
{
  // Mirrors the manager's RETIREMENT_CONCURRENCY, which is not exported.
  const bound = 8;
  const { m } = managerWith([]);
  const gates = Array.from({ length: bound + 2 }, () => deferred());
  const started: number[] = [];
  let running = 0, peak = 0;
  const runs = gates.map((g, i) => m.withRetirementSlot(async () => {
    started.push(i); running++; peak = Math.max(peak, running);
    try { await g.promise; } finally { running--; }
  }).catch(() => {}));
  await settle();
  check("G18 at most RETIREMENT_CONCURRENCY retirements run at once", started.length === bound && peak === bound, { started: started.length, peak, bound });
  gates[0].reject(new Error("retirement failed"));
  await settle();
  check("G18 …a failing retirement still hands its slot on, and the oldest waiter takes it", started.length === bound + 1 && started[bound] === bound, started);
  gates[1].resolve();
  await settle();
  check("G18 …and waiters start in arrival order", JSON.stringify(started) === JSON.stringify(gates.map((_, i) => i)), started);
  for (const g of gates) g.resolve();
  await Promise.all(runs);
  let fresh = false;
  await m.withRetirementSlot(async () => { fresh = running === 0; });
  check("G18 …and once every run settles a new retirement runs with nothing else holding a slot", fresh, running);
}

// ── MEMBERSHIP GATE ────────────────────────────────────────────────────────────────────────────
{
  const live = fakeHandle("live");
  const ending = fakeHandle("ending");
  const { m, rows } = managerWith([live, ending]);
  rows.get("ending")!.terminalizing = true;
  const pass = m.admitControl(wire("livenkey"));
  pass.release?.();
  const refuse = m.admitControl(wire("endingnkey"));
  check("G19 a live managed caller passes admission", pass.refusal === undefined && typeof pass.release === "function", pass);
  check("G19 …and a terminalizing one is refused at the membership fence, naming why",
    refuse.fence === "membership" && new RegExp(`lifecycle ${uidOf("ending")} is terminalizing; control is refused`).test(refuse.refusal ?? ""), refuse);
}

// ── CHANNEL-FAMILY RETIRE ──────────────────────────────────────────────────────────────────────
{
  const asked: Array<{ verb: string; body: unknown }> = [];
  let reply: unknown = { ok: true, data: { complete: true, channels: ["review.>", "ops"] } };
  const { m } = managerWith([], {
    requestDeliveryAdmin: async (verb: string, body: unknown) => { asked.push({ verb, body }); if (reply instanceof Error) throw reply; return reply; },
  });
  const target = { id: "workernkey", lifecycleUid: uidOf("worker") };
  const full = await m.lifecycleMembershipInventory(target);
  check("G20 a membership inventory naming a channel family is complete and carries the family",
    full.complete === true && JSON.stringify(full.channels) === JSON.stringify(["review.>", "ops"]) && asked[0]?.verb === "lifecycleMemberships"
      && (asked[0].body as { lifecycleUid?: string }).lifecycleUid === uidOf("worker"), { full, asked });
  reply = { ok: true, data: { complete: true, channels: ["review.>", 7] } };
  const malformed = await m.lifecycleMembershipInventory(target);
  reply = { ok: false, error: "delivery is draining" };
  const refused = await m.lifecycleMembershipInventory(target);
  reply = new Error("no responders");
  const thrown = await m.lifecycleMembershipInventory(target);
  check("G20 …a malformed reply is incomplete with a reason, never complete with an empty list",
    malformed.complete === false && malformed.reason === "malformed inventory reply" && malformed.channels.length === 0, malformed);
  check("G20 …a refused or failed request is incomplete and carries the refusal",
    refused.complete === false && refused.reason === "delivery is draining" && thrown.complete === false && /no responders/.test(thrown.reason ?? ""), { refused, thrown });
}

// ── DELEGATED RETIRE (refusal arm) ─────────────────────────────────────────────────────────────
{
  const w = fakeHandle("worker");
  const { m, rows } = managerWith([w]);
  const ret = await m.retireDelegatedAgent("worker", "intent-1");
  check("G22 without host execution a delegated retirement refuses and leaves the seat as it was",
    ret.ok === false && /has no host execution for a delegated user intent; "worker" was not retired/.test(ret.error ?? "") && rows.has("worker") && w.stops.length === 0,
    { ret, stops: w.stops.length });
}

// ── MESH OFFLINE / BACK ────────────────────────────────────────────────────────────────────────
{
  const w = fakeHandle("worker");
  let roster: unknown[] = [];
  let view = "current";
  const { m, rows } = managerWith([w], { getRoster: () => roster, presenceView: () => ({ state: view }) });
  const row = rows.get("worker")!;
  const card = (status: string, uid = row.lifecycleUid) => ({ card: { id: wire(row.id) }, lifecycleUid: uid, status, ts: Date.parse("2026-11-19T08:00:00Z") });
  roster = [card("offline")];
  const off = await captureAsync(() => m.logSeatMeshTransitions());
  const again = await captureAsync(() => m.logSeatMeshTransitions());
  roster = [card("online")];
  const back = await captureAsync(() => m.logSeatMeshTransitions());
  check("G23 a held seat that drops off the mesh gets one line naming its last heartbeat and process state",
    off.lines.length === 1 && off.lines[0].startsWith("seat offline on the mesh: worker (") && off.lines[0].includes("last heartbeat 2026-11-19T08:00:00.000Z; process running"), off.lines);
  check("G23 …the same offline record does not repeat the line", again.lines.length === 0, again.lines);
  check("G23 …and its return gets one line", back.lines.length === 1 && back.lines[0].startsWith("seat back on the mesh: worker ("), back.lines);
  roster = [card("offline", uidOf("older"))];
  const foreign = await captureAsync(() => m.logSeatMeshTransitions());
  view = "stale";
  roster = [card("offline")];
  const stale = await captureAsync(() => m.logSeatMeshTransitions());
  check("G23 …an older incarnation's record speaks for nothing, and a stale view logs nothing",
    foreign.lines.length === 0 && stale.lines.length === 0, { foreign: foreign.lines, stale: stale.lines });
}

/* LEFT OUT, each needing a seam the manager does not take today:
 * - The Windows PTY stop (stopWindowsSeat) is chosen by `process.platform`, which nothing injects.
 * - fenceRetiringAcl needs a broker: `fenceLifecycleAcl` is a module import with no hook.
 * - retireDelegatedAgent past its refusal needs a remote authority's `executeDelegatedUserIntent`.
 * - opPurge needs a broker (`clearSpaceHistory`).
 * - A despawn mid-goal driving the goal's cancel terminal (cancelAgentGoal) needs a goal-writer
 *   context over a real KV: `transitionGoal` and `commitGoalResult` are not reachable through a
 *   plain fake object.
 */

if (failures) {
  console.error(`SEAT-STOP GUARANTEES FAILED ❌  (${checks - failures} passed, ${failures} failed)`);
  process.exit(1);
}
console.log(`SEAT-STOP GUARANTEES OK ✅  (${checks} passed, 0 failed)`);
process.exit(0);
