/**
 * The owned-seat identity guard (`_owned-seats.ts`) decides from the shipped identity rule, and
 * signals only a seat whose identity verifies. Every child here is a harmless `node` sleeper this
 * suite spawned itself. The cleanup under test gets a RECORDING kill, so no signal is ever sent
 * through it. The suite's own teardown kills only its own children by their ChildProcess handles.
 *
 * Run: pnpm smoke:owned-seats
 */
import { spawn, type ChildProcess } from "node:child_process";
import { awaitSeatsExited, killVerifiedSeats, recordOwnedSeat, seatCensus, seatVerdict, type OwnedSeat } from "./_owned-seats.js";

let pass = 0, fail = 0;
const c = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const kids: ChildProcess[] = [];
const sleeper = async (): Promise<number> => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  kids.push(child);
  await new Promise<void>((res, rej) => { child.once("spawn", () => res()); child.once("error", rej); });
  return child.pid!;
};
const recorded: Array<{ pid: number; signal: string }> = [];
const recordKill = (pid: number, signal: NodeJS.Signals) => { recorded.push({ pid, signal }); };

try {
  const pid = await sleeper();

  console.log("1. a seat recorded with its live start identity");
  const verified = recordOwnedSeat("verified", pid);
  c("the shipped reader returns a start identity for a live child on this platform", verified.token !== undefined, verified);
  c("it verifies as running", seatVerdict(verified).kind === "running", seatVerdict(verified));
  recorded.length = 0;
  const k1 = killVerifiedSeats([verified], recordKill);
  c("and is the one seat cleanup would signal", k1.signalled.join() === "verified" && recorded.length === 1 && recorded[0].pid === pid && recorded[0].signal === "SIGKILL", { k1, recorded });

  console.log("2. a seat with NO recorded identity, its pid alive");
  const missing: OwnedSeat = { name: "missing", pid, token: undefined };
  c("is unverifiable, not running and not exited", seatVerdict(missing).kind === "unverifiable", seatVerdict(missing));
  recorded.length = 0;
  const k2 = killVerifiedSeats([missing], recordKill);
  c("cleanup refuses to signal it and reports the refusal", recorded.length === 0 && k2.signalled.length === 0 && k2.refused.map((r) => r.name).join() === "missing", { k2, recorded });
  const census2 = seatCensus([missing]);
  c("the census reports it as a failure, never as exited", census2.running.length === 0 && census2.unverifiable.map((u) => u.name).join() === "missing", census2);
  const waited2 = await awaitSeatsExited([missing], 300);
  c("waiting for exit does not turn it into an exit", waited2.unverifiable.map((u) => u.name).join() === "missing", waited2);

  console.log("3. a seat whose pid now carries a DIFFERENT start identity (a reused pid)");
  const changed: OwnedSeat = { name: "changed", pid, token: `${verified.token}-not-this-process` };
  c("is exited: the recorded seat is gone and the live pid is a stranger", seatVerdict(changed).kind === "exited", seatVerdict(changed));
  recorded.length = 0;
  const k3 = killVerifiedSeats([changed], recordKill);
  c("cleanup does not signal the stranger", recorded.length === 0 && k3.signalled.length === 0 && k3.refused.length === 0, { k3, recorded });

  console.log("4. a seat whose live identity cannot be read");
  const unreadable = (): string | undefined => undefined;
  c("is unverifiable", seatVerdict(verified, unreadable).kind === "unverifiable", seatVerdict(verified, unreadable));
  recorded.length = 0;
  const k4 = killVerifiedSeats([verified], recordKill, unreadable);
  c("cleanup refuses to signal it", recorded.length === 0 && k4.refused.map((r) => r.name).join() === "verified", { k4, recorded });

  console.log("5. a recorded seat that really exited");
  const gonePid = await sleeper();
  const gone = recordOwnedSeat("gone", gonePid);
  const child = kids[kids.length - 1];
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGKILL");
  await exited;
  c("is exited", seatVerdict(gone).kind === "exited", seatVerdict(gone));
  const waited5 = await awaitSeatsExited([gone], 2_000);
  c("and the census is clean", waited5.running.length === 0 && waited5.unverifiable.length === 0, waited5);
  const noToken: OwnedSeat = { name: "gone-no-token", pid: gonePid, token: undefined };
  c("a seat with no identity whose pid is gone is exited, not unverifiable", seatVerdict(noToken).kind === "exited", seatVerdict(noToken));
} catch (e) {
  fail++;
  console.log("  ✗ FAIL: threw", (e as Error).stack ?? String(e));
}

for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* gone */ } }

const EXPECTED_CELLS = 14;
if (pass + fail !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${pass + fail} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  fail += 1;
}
console.log(`owned-seats.smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
