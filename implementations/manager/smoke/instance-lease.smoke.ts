/**
 * The per-instance liveness lease: acquire, release and the stop fence, driven through the
 * manager's own lease methods against a stub endpoint.
 * Run: pnpm smoke:instance-lease   (no broker)
 *
 * WHAT THIS SUITE GRADES. The acquire decision for each row a failed create can find: a free key, a
 * dead predecessor on this root (waited out, then created), this process's own earlier row, a row
 * rewritten during that wait, a live holder on this root, a holder on another root, an unreadable row,
 * and a stop that lands during the wait. The release reads the broker's revision and deletes only this
 * process's row, retrying a read that got no answer. A stopping manager never renews and never puts a
 * gone key back. The instance id, space and endpoint are read when a call runs, not when the manager
 * was built, because `start()` assigns the first two and smokes replace the third.
 *
 * NOT GRADED: the wire. `smoke:lease-renew`, `smoke:lease-release-reconnect` and
 * `smoke:manager-fresh-root-identity` run the same paths against a real broker. The renew verdicts
 * (`unknown`, `gone`, `taken`) are `smoke:lease-loss-keeps-serving`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ManagerLeaseInfo } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { Manager, ManagerInstanceLeaseHeld } from "../src/manager.js";

const { check, finish } = createSuite();

const SPACE = "instance-lease-smoke";
const root = mkdtempSync(join(tmpdir(), "cotal-instance-lease-"));
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
const otherRoot = mkdtempSync(join(tmpdir(), "cotal-instance-lease-other-"));

/** A pid that has exited and been reaped, so `kill(pid, 0)` reports it gone. */
const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
/** A pid that is certainly running and is not this process. */
const livePid = process.ppid;

type Row = { info: ManagerLeaseInfo; revision: number; created: number };
type Info = Omit<ManagerLeaseInfo, "since">;

interface Wire {
  acquire: Array<(info: Info) => Promise<number>>;
  read: Array<(iid: string) => Promise<Row | undefined>>;
  renew?: (info: Info, revision: number) => Promise<number>;
}

interface Calls {
  acquire: Info[];
  read: string[];
  renew: number[];
  release: Array<{ iid: string; revision: number }>;
}

interface Priv {
  ep: unknown;
  managerInstanceId: string;
  leaseStopping: boolean;
  leaseInfo?: Info;
  leaseRevision?: number;
  acquireInstanceLease(info: Info): Promise<number>;
  releaseOwnManagerLease(): Promise<void>;
  renewLease(): Promise<void>;
}

function row(pid: number, at: string, revision: number): Row {
  return { info: { holder: "local.manager", instanceId: "inst-1", runtime: "pty", root: resolve(at), pid, since: Date.now() }, revision, created: Date.now() };
}

/** A manager whose endpoint is a stub that answers each call from the next entry of its queue. The
 *  instance id is assigned after construction, as `start()` does. */
function managerWith(wire: Wire): { m: Priv; calls: Calls } {
  const manager = new Manager({ space: SPACE, runtime: "pty", workspaceRoot: root });
  const m = manager as unknown as Priv;
  const calls: Calls = { acquire: [], read: [], renew: [], release: [] };
  m.managerInstanceId = "inst-1";
  m.ep = {
    acquireManagerLease: async (info: Info) => {
      calls.acquire.push(info);
      const next = wire.acquire.shift();
      if (!next) throw new Error("unexpected acquire");
      return next(info);
    },
    readOwnManagerLease: async (iid: string) => {
      calls.read.push(iid);
      const next = wire.read.shift();
      if (!next) throw new Error("unexpected read");
      return next(iid);
    },
    renewManagerLease: async (info: Info, revision: number) => {
      calls.renew.push(revision);
      if (!wire.renew) throw new Error("unexpected renew");
      return wire.renew(info, revision);
    },
    releaseManagerLease: async (iid: string, revision: number) => { calls.release.push({ iid, revision }); },
  };
  return { m, calls };
}

function info(): Info {
  return { holder: "local.manager", instanceId: "inst-1", runtime: "pty", root: resolve(root), pid: process.pid };
}

const conflict = (): Promise<number> => Promise.reject(new Error("wrong last sequence: 3"));

/** Run `fn` with console.error captured, returning what it printed and how it settled. */
async function captured<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; lines: string[] }> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    return { value: await fn(), lines };
  } catch (error) {
    return { error, lines };
  } finally {
    console.error = real;
  }
}

console.log("\n-- acquire --");
{
  const { m, calls } = managerWith({ acquire: [async () => 4], read: [] });
  const r = await captured(() => m.acquireInstanceLease(info()));
  check("acquire: a free key is created on the first try and its revision returned", r.value === 4 && calls.acquire.length === 1 && calls.read.length === 0, { r, calls });
}
{
  const { m, calls } = managerWith({
    acquire: [conflict, async () => 7],
    read: [async () => row(deadPid, root, 5), async () => undefined],
  });
  const r = await captured(() => m.acquireInstanceLease(info()));
  check("acquire: a dead predecessor on this root is waited out, then the key is created", r.value === 7 && calls.acquire.length === 2, { r, calls });
  check("acquire: the wait names the dead pid once", r.lines.length === 1 && r.lines[0]!.includes(`pid ${deadPid}`) && /not running on this host/.test(r.lines[0]!), r.lines);
}
{
  const { m, calls } = managerWith({
    acquire: [conflict, async () => 8],
    read: [async () => row(process.pid, root, 5), async () => undefined],
  });
  const r = await captured(() => m.acquireInstanceLease(info()));
  check("acquire: this process's own earlier row on this root is waited out like a dead one", r.value === 8 && calls.acquire.length === 2, { r, calls });
}
{
  const { m, calls } = managerWith({
    acquire: [conflict],
    read: [async () => row(deadPid, root, 5), async () => row(deadPid, root, 6)],
  });
  const r = await captured(() => m.acquireInstanceLease(info()));
  check("acquire: a row rewritten during the wait refuses, naming a live writer, and creates nothing", r.error instanceof Error && !(r.error instanceof ManagerInstanceLeaseHeld) && /written again while waiting/.test(r.error.message) && calls.acquire.length === 1, { r, calls });
}
{
  const { m, calls } = managerWith({ acquire: [conflict], read: [async () => row(livePid, root, 5)] });
  const r = await captured(() => m.acquireInstanceLease(info()));
  const e = r.error as ManagerInstanceLeaseHeld;
  check("acquire: a live holder on this root refuses at once with ManagerInstanceLeaseHeld (sameRoot)", e instanceof ManagerInstanceLeaseHeld && e.sameRoot && e.held.pid === livePid && e.instanceId === "inst-1" && e.space === SPACE && calls.read.length === 1, { r, calls });
}
{
  const { m, calls } = managerWith({ acquire: [conflict], read: [async () => row(deadPid, otherRoot, 5)] });
  const r = await captured(() => m.acquireInstanceLease(info()));
  const e = r.error as ManagerInstanceLeaseHeld;
  check("acquire: a holder on another root refuses even when its pid is gone here, and is not waited on", e instanceof ManagerInstanceLeaseHeld && !e.sameRoot && /another workspace root/.test(e.message) && calls.read.length === 1, { r, calls });
}
{
  const { m } = managerWith({ acquire: [conflict], read: [async () => { throw new Error("kv read timed out"); }] });
  const r = await captured(() => m.acquireInstanceLease(info()));
  check("acquire: an unreadable row is a plain error carrying the create's cause, not a held lease", r.error instanceof Error && !(r.error instanceof ManagerInstanceLeaseHeld) && /could not acquire the manager lease/.test(r.error.message) && /wrong last sequence/.test(r.error.message), r);
}
{
  const wire: Wire = { acquire: [conflict], read: [] };
  const { m, calls } = managerWith(wire);
  wire.read.push(
    async () => row(deadPid, root, 5),
    async () => { m.leaseStopping = true; return row(deadPid, root, 5); },
  );
  const r = await captured(() => m.acquireInstanceLease(info()));
  check("acquire: a stop during the wait ends it with the held refusal and no second create", r.error instanceof ManagerInstanceLeaseHeld && calls.acquire.length === 1, { r, calls });
}

console.log("\n-- release --");
{
  const { m, calls } = managerWith({ acquire: [], read: [async () => row(process.pid, root, 11)] });
  m.leaseRevision = 3;
  await captured(() => m.releaseOwnManagerLease());
  check("release: this process's row is deleted at the broker's revision, not the cached one", calls.release.length === 1 && calls.release[0]!.revision === 11 && calls.release[0]!.iid === "inst-1", calls);
}
{
  const { m, calls } = managerWith({ acquire: [], read: [async () => row(livePid, root, 11)] });
  await captured(() => m.releaseOwnManagerLease());
  check("release: a row another pid holds is left alone", calls.release.length === 0, calls);
}
{
  const { m, calls } = managerWith({ acquire: [], read: [async () => undefined] });
  await captured(() => m.releaseOwnManagerLease());
  check("release: an absent row deletes nothing", calls.release.length === 0, calls);
}
{
  const { m, calls } = managerWith({ acquire: [], read: [async () => { throw new Error("no answer"); }, async () => row(process.pid, root, 12)] });
  const r = await captured(() => m.releaseOwnManagerLease());
  check("release: a read that got no answer is tried again and the row is then deleted", calls.read.length === 2 && calls.release.length === 1 && calls.release[0]!.revision === 12 && r.error === undefined, { calls, r });
}

console.log("\n-- the stop fence and late binding --");
{
  const { m, calls } = managerWith({ acquire: [], read: [], renew: async () => 2 });
  m.leaseInfo = info();
  m.leaseRevision = 1;
  m.leaseStopping = true;
  await captured(() => m.renewLease());
  check("renew: a stopping manager does not renew", calls.renew.length === 0 && m.leaseRevision === 1, { calls, revision: m.leaseRevision });
}
{
  let finish = (_: number) => {};
  const { m, calls } = managerWith({ acquire: [], read: [], renew: () => new Promise<number>((r) => { finish = r; }) });
  m.leaseInfo = info();
  m.leaseRevision = 1;
  const first = m.renewLease();
  await captured(() => m.renewLease());
  finish(2);
  await captured(() => first);
  check("renew: a tick while a renew is in flight starts no second renew", calls.renew.length === 1 && m.leaseRevision === 2, { calls, revision: m.leaseRevision });
}
{
  const wire: Wire = { acquire: [async () => 9], read: [], renew: () => Promise.reject(new Error("timeout")) };
  const { m, calls } = managerWith(wire);
  m.leaseInfo = info();
  m.leaseRevision = 1;
  wire.read.push(async () => { m.leaseStopping = true; return undefined; });
  await captured(() => m.renewLease());
  check("renew: a key found gone after a stop began is not put back", calls.acquire.length === 0 && m.leaseRevision === 1, { calls, revision: m.leaseRevision });
}
{
  const { m, calls } = managerWith({ acquire: [], read: [async () => undefined] });
  m.managerInstanceId = "inst-late";
  const replaced: string[] = [];
  m.ep = { ...(m.ep as object), readOwnManagerLease: async (iid: string) => { replaced.push(iid); return undefined; } };
  await captured(() => m.releaseOwnManagerLease());
  check("binding: the instance id and endpoint are the ones current at the call, not at construction", replaced.length === 1 && replaced[0] === "inst-late" && calls.read.length === 0, { replaced, calls });
}
{
  const { m } = managerWith({ acquire: [conflict], read: [async () => row(livePid, root, 5)] });
  const r = await captured(() => m.acquireInstanceLease(info()));
  check("binding: the refusal names this manager's space", r.error instanceof ManagerInstanceLeaseHeld && r.error.message.includes(`space "${SPACE}"`), r);
}

finish();
