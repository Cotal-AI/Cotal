import { dirname } from "node:path";
import type { CustodianIdentity } from "./custodian.js";
import { DEFAULT_COLS, DEFAULT_ROWS } from "./protocol.js";
import type { SeatRecord } from "./record.js";
import { prepareDarwinExec } from "./shared-exec-launch-darwin.js";
import { darwinSharedIdentity, type DarwinSharedIdentity } from "./shared-identity-darwin.js";
import type { SeatIsolation } from "./shared-platform.js";
import { captureDarwinPtySession } from "./shared-session-darwin.js";
import { stopDarwinPtyRoot } from "./shared-stop-darwin.js";

export function darwinCustodianIdentity(host: Readonly<DarwinSharedIdentity>): CustodianIdentity<DarwinSharedIdentity> {
  const owner = Object.freeze({ ...host });
  function child(row: Readonly<SeatRecord>): DarwinSharedIdentity | undefined {
    if (row.custodianPid !== owner.pid || row.custodianStart !== owner.start || row.bootId !== owner.bootId || !row.childStart)
      return undefined;
    return { pid: row.childPid, uid: owner.uid, start: row.childStart, bootId: owner.bootId };
  }
  return {
    capture(custodianPid, childPid) {
      const actualHost = darwinSharedIdentity.current(), root = captureDarwinPtySession(childPid);
      if (custodianPid !== owner.pid || !actualHost || !darwinSharedIdentity.same(owner, actualHost) ||
          !root || root.uid !== owner.uid || root.bootId !== owner.bootId)
        throw new Error("unverified Darwin PTY custody identity");
      return { custodianStart: owner.start, childStart: root.start, bootId: owner.bootId };
    },
    matches(identity, row) {
      const expected = child(row);
      return expected !== undefined && darwinSharedIdentity.same(identity, expected);
    },
    observe(row) {
      const expected = child(row);
      return expected ? darwinSharedIdentity.observe(expected) : "unknown";
    },
  };
}

type StopObservation = Awaited<ReturnType<typeof stopDarwinPtyRoot>>;

/** Keep terminal exit and root-stop acknowledgement separate from release of retained custody. */
export function darwinSeatIsolation(
  root: string, hostSocket: string, observeStop: (observation: StopObservation) => void,
): SeatIsolation<DarwinSharedIdentity> {
  return {
    async prepare({ spec, cwd }) {
      const gate = await prepareDarwinExec({ socketDirectory: dirname(hostSocket), bootstrapCwd: root,
        cols: DEFAULT_COLS, rows: DEFAULT_ROWS, payload: { command: spec.command, args: spec.args, cwd,
          env: { ...spec.env, PWD: cwd, TERM: spec.env?.TERM ?? "xterm-256color" } },
      });
      return { ...gate, get commitAttempted() { return gate.commitAttempted; }, async stop(mode) {
        const observation = await stopDarwinPtyRoot(gate.proc, await gate.ready, mode);
        // Reporting cannot turn a confirmed root stop into an unacknowledged stop.
        try { observeStop(observation); } catch { /* Keep the stop result independent of diagnostics. */ }
      } };
    },
    prepareFailure: () => "unknown",
    async drain() { throw new Error("Darwin PTY root exit does not establish custody release"); },
  };
}
