import type { Socket } from "node:net";
import type { SharedController } from "./shared-controller.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { darwinSharedIdentity, validDarwinBirth, validDarwinBoot, validDarwinPid, type DarwinSharedIdentity } from "./shared-identity-darwin.js";
import { isSeatId } from "./record.js";

export const darwinManagerRemovalKind = "machine-hosted-pty-remove";
const hostLabel = /^ai\.cotal\.pty\.[a-f0-9]{32}$/;
const refusal = () => new Error(`${darwinManagerRemovalKind} could not verify incumbent PTY custody`);

export interface DarwinRemovalTarget { readonly scope: string; readonly id: string; readonly host: DarwinSharedIdentity; readonly root: DarwinSharedIdentity }
interface Target extends DarwinRemovalTarget { readonly name: string; readonly token: string }
export interface DarwinRemovalFrame {
  readonly kind: typeof darwinManagerRemovalKind;
  readonly attemptId: string;
  readonly phase: "prepare" | "stop" | "abort";
  readonly targets: readonly DarwinRemovalTarget[];
}

function object(value: unknown, size: number): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === size;
}

function identity(value: unknown): value is DarwinSharedIdentity {
  return object(value, 4) && validDarwinPid(value.pid) && validDarwinBirth(value.start) && validDarwinBoot(value.bootId) &&
    typeof value.uid === "number" && value.uid > 0 && value.uid === process.getuid?.();
}

export function parseDarwinRemovalFrame(raw: unknown): DarwinRemovalFrame | undefined {
  if (!object(raw, 4) || raw.kind !== darwinManagerRemovalKind || typeof raw.attemptId !== "string" || !/^[0-9a-f]{24}$/.test(raw.attemptId) ||
      (raw.phase !== "prepare" && raw.phase !== "stop" && raw.phase !== "abort") || !Array.isArray(raw.targets) || raw.targets.length > 64) return;
  const targets: DarwinRemovalTarget[] = [], ids = new Set<string>();
  for (const row of raw.targets) {
    if (!object(row, 4) || typeof row.scope !== "string" || !hostLabel.test(row.scope) || typeof row.id !== "string" || !isSeatId(row.id) || !identity(row.host) ||
        !identity(row.root) || row.host.bootId !== row.root.bootId || row.host.pid === row.root.pid) return;
    const key = `${row.scope}/${row.id}`;
    if (ids.has(key)) return;
    ids.add(key);
    targets.push({ scope: row.scope, id: row.id, host: row.host, root: row.root });
  }
  if (raw.phase === "abort" && targets.length) return;
  return { kind: raw.kind, attemptId: raw.attemptId, phase: raw.phase, targets };
}

const keyOf = (target: DarwinRemovalTarget) => `${target.scope}/${target.id}`;
const same = (a: DarwinRemovalTarget, b: DarwinRemovalTarget) => keyOf(a) === keyOf(b) &&
  darwinSharedIdentity.same(a.host, b.host) && darwinSharedIdentity.same(a.root, b.root);

function prepareIncumbentSeat(controller: SharedController, target: Target, verify: (socket: Socket) => boolean) {
  const writer = controller.pinWriter(socket => darwinSharedIdentity.matchesPeer(socket, target.host) && verify(socket));
  const recheck = () => {
    writer.recheck();
    if (darwinSharedIdentity.observe(target.root) !== "live") throw refusal();
  };
  return { target, recheck, async prepare() {
    recheck();
    const hello = await writer.request(target.id, { op: "hello", token: target.token });
    if (!hello.ok || hello.op !== "hello" || hello.pid !== target.root.pid || hello.name !== target.name || hello.status !== "running") throw refusal();
    const health = await writer.request(target.id, { op: "health" });
    if (!health.ok || health.op !== "health" || health.pid !== target.root.pid || health.protocol !== PROTOCOL_VERSION || health.status !== "running") throw refusal();
    recheck();
  }, async stop() {
    recheck();
    const reply = await writer.request(target.id, { op: "stop", mode: "graceful" });
    if (!reply.ok || reply.op !== "stop") throw refusal();
    const ended = await writer.request(target.id, { op: "wait-exit" });
    if (!ended.ok || ended.op !== "wait-exit" || darwinSharedIdentity.observe(target.root) !== "gone") throw refusal();
    writer.recheck();
  } };
}

type IncumbentSeat = ReturnType<typeof prepareIncumbentSeat>;
const seats = new Map<string, { pin(): IncumbentSeat }>();

/** Register only an already admitted local seat. No caller of removal opens or claims a writer. */
export function registerIncumbentDarwinRemovalSeat(controller: SharedController, target: Target, verify: (socket: Socket) => boolean) {
  const fixed = Object.freeze({ ...target, host: Object.freeze({ ...target.host }), root: Object.freeze({ ...target.root }) });
  const key = keyOf(fixed);
  if (seats.has(key)) throw refusal();
  const entry = { pin: () => prepareIncumbentSeat(controller, fixed, verify) };
  seats.set(key, entry);
  return () => { if (seats.get(key) === entry) seats.delete(key); };
}

/** One per machine parent channel. Prepare proves all roots, stop consumes the exact preparation. */
export function createDarwinManagerRemoval() {
  let held: { attemptId: string; seats: readonly IncumbentSeat[] } | undefined;
  return async (frame: DarwinRemovalFrame, authorized: () => boolean): Promise<number> => {
    if (!authorized()) throw refusal();
    if (frame.phase === "abort") {
      if (held && held.attemptId !== frame.attemptId) throw refusal();
      held = undefined;
      return 0;
    }
    if (frame.phase === "prepare") {
      if (held || frame.targets.length !== seats.size) throw refusal();
      const selected = frame.targets.map(target => {
        const key = keyOf(target), entry = seats.get(key);
        const seat = entry?.pin();
        if (!seat || !same(seat.target, target)) throw refusal();
        return { ...seat, recheck() {
          if (seats.get(key) !== entry) throw refusal();
          seat.recheck();
        } };
      });
      for (const seat of selected) await seat.prepare();
      if (!authorized() || selected.length !== seats.size) throw refusal();
      for (const seat of selected) seat.recheck();
      held = { attemptId: frame.attemptId, seats: selected };
      return selected.length;
    }
    if (!held || held.attemptId !== frame.attemptId || held.seats.length !== frame.targets.length || seats.size !== held.seats.length ||
        held.seats.some((seat, index) => !same(seat.target, frame.targets[index]!))) throw refusal();
    const selected = held.seats;
    held = undefined;
    for (const seat of selected) seat.recheck();
    for (const seat of selected) {
      if (!authorized()) throw refusal();
      seat.recheck();
      await seat.stop();
    }
    return selected.length;
  };
}
