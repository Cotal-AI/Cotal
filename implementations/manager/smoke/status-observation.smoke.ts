// Status and ps stay observable through maintenance without admitting lifecycle work.
// Drive the real service definitions and gates with local snapshot readers, without a broker
// or child process. The constructed subject stands in for endpoint-authenticated caller context.
import { strict as assert } from "node:assert";
import { EpEnvelopeError, type EpCommandDef, type EpServeContext } from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { Manager } from "../src/manager.js";

let passed = 0;
async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  passed++;
  console.log(`  ok ${name}`);
}

type Snapshot = { owner: string | undefined };
type Receiver = {
  maintenanceState: "active" | "preserving" | "preserved";
  leaseStopping: boolean;
  resumeRequired: boolean;
  lifecycleInFlight: number;
  lifecycleDrainWaiters: Array<() => void>;
  retiredPrincipals: Set<string>;
  managerServiceDefs(): EpCommandDef[];
  psOwnerFilter(caller: { owner: string; actor: string }, admin: boolean): Promise<string | undefined>;
  managerStatusData(owner: string | undefined): Snapshot;
  list(owner: string | undefined): Snapshot[];
};

const caller = { owner: "u_owner", actor: "operator", uid: "00112233445566778899aabbccddeeff" };
const ctx = (command: string): EpServeContext => ({
  subject: { caller, command }, request: { args: {} },
} as EpServeContext);

function receiver(state: Pick<Receiver, "maintenanceState" | "leaseStopping" | "resumeRequired">) {
  const manager = new Manager({ space: "status-observation", runtime: "pty", workspaceRoot: process.cwd() });
  const self = manager as unknown as Receiver;
  Object.assign(self, state);
  // Existing accepted lifecycle work must neither grow nor drain when a snapshot is read.
  self.lifecycleInFlight = 3;
  self.psOwnerFilter = async (subject, admin) => {
    assert.deepEqual(subject, caller);
    assert.equal(admin, false);
    return subject.owner;
  };
  self.managerStatusData = (owner) => { assert.equal(self.lifecycleInFlight, 3); return { owner }; };
  self.list = (owner) => { assert.equal(self.lifecycleInFlight, 3); return [{ owner }]; };
  const defs = self.managerServiceDefs();
  const call = (command: string) => {
    const def = defs.find((entry) => entry.command === command);
    assert.ok(def, `${command} is served`);
    return def.handler(ctx(command));
  };
  return { self, call };
}

for (const maintenanceState of ["active", "preserving", "preserved"] as const) {
  for (const resumeRequired of [false, true]) {
    for (const leaseStopping of [false, true]) {
      const state = { maintenanceState, resumeRequired, leaseStopping };
      const label = `${maintenanceState}, resume=${resumeRequired}, stopping=${leaseStopping}`;
      const { self, call } = receiver(state);
      await check(`status and ps answer with owner scoping in ${label}`, async () => {
        let drained = false;
        self.lifecycleDrainWaiters.push(() => { drained = true; });
        assert.deepEqual(await call("status"), { owner: caller.owner });
        assert.deepEqual(await call("ps"), [{ owner: caller.owner }]);
        assert.equal(self.lifecycleInFlight, 3);
        assert.equal(drained, false);
        assert.equal(self.maintenanceState, maintenanceState);
        assert.equal(self.resumeRequired, resumeRequired);
        assert.equal(self.leaseStopping, leaseStopping);
      });
      await check(`retired membership still refuses both observations in ${label}`, async () => {
        self.retiredPrincipals.add(`${caller.owner}.${caller.actor}`);
        for (const command of ["status", "ps"]) {
          await assert.rejects(async () => call(command), (error: unknown) =>
            error instanceof EpEnvelopeError && error.code === "permission-denied" && error.outcome === "not-executed");
        }
        assert.equal(self.lifecycleInFlight, 3);
        self.retiredPrincipals.clear();
      });
      if (maintenanceState !== "active" || resumeRequired || leaseStopping) {
        await check(`lifecycle control remains fenced in ${label}`, async () => {
          await assert.rejects(async () => call("spawn"), (error: unknown) =>
            error instanceof EpEnvelopeError && error.code === "unavailable" && error.outcome === "not-executed");
          assert.equal(self.lifecycleInFlight, 3);
        });
      }
    }
  }
}

await check("a throwing observation leaves accepted lifecycle work untouched", async () => {
  const { self, call } = receiver({ maintenanceState: "preserving", resumeRequired: false, leaseStopping: false });
  self.managerStatusData = () => { throw new Error("status failed"); };
  self.list = () => { throw new Error("ps failed"); };
  await assert.rejects(async () => call("status"), /status failed/);
  await assert.rejects(async () => call("ps"), /ps failed/);
  assert.equal(self.lifecycleInFlight, 3);
});

console.log(`\nstatus observation smoke: ${passed} checks passed`);
emitSentinel({ passed, failed: 0 });
