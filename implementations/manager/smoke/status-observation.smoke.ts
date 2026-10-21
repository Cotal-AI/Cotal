// The `status` observation gate. A preserved manager, and an active
// one launched for a resume that has not committed, still answer `status` through the F5(a)
// membership gate, as a read counted in `lifecycleInFlight` and released when it returns or
// throws. Preserving, stopping and every other state go through the shared fence unchanged. The
// gate runs on a minimal receiver: no broker, endpoint or child process is started.
import { strict as assert } from "node:assert";
import { EpEnvelopeError } from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { Manager } from "../src/manager.js";

let passed = 0;
async function check(name: string, run: () => Promise<boolean> | boolean): Promise<void> {
  assert.ok(await run(), name);
  passed++;
  console.log(`  ok ${name}`);
}

type Ctx = { subject: { caller: { owner: string; actor: string } } };
type Receiver = {
  maintenanceState: "active" | "preserving" | "preserved";
  leaseStopping: boolean;
  resumeRequired: boolean;
  lifecycleInFlight: number;
  lifecycleDrainWaiters: Array<() => void>;
  fenced: number;
  refused?: string;
  lifecycleMembershipRefusal(caller: string): string | undefined;
  releaseLifecycle(): void;
  serveGated<T>(ctx: Ctx, fn: () => T | Promise<T>): Promise<T>;
};

const prototype = Manager.prototype as unknown as {
  serveObservation<T>(this: Receiver, ctx: Ctx, fn: () => T | Promise<T>): Promise<T>;
  releaseLifecycle(this: Receiver): void;
};
const ctx: Ctx = { subject: { caller: { owner: "u_owner", actor: "operator" } } };

function receiver(state: Pick<Receiver, "maintenanceState"> & Partial<Pick<Receiver, "leaseStopping" | "resumeRequired" | "refused">>): Receiver {
  return {
    leaseStopping: false, resumeRequired: false, lifecycleInFlight: 0, lifecycleDrainWaiters: [], fenced: 0, ...state,
    lifecycleMembershipRefusal(caller) { return caller === "u_owner.operator" ? this.refused : "unexpected caller key"; },
    releaseLifecycle() { prototype.releaseLifecycle.call(this); },
    async serveGated() { this.fenced++; throw new EpEnvelopeError("unavailable", "fenced"); },
  };
}

const serve = <T>(self: Receiver, fn: () => T | Promise<T>) => prototype.serveObservation.call(self, ctx, fn);

await check("a preserved manager answers status as a counted read", async () => {
  const self = receiver({ maintenanceState: "preserved" });
  let during = -1;
  const answer = await serve(self, () => { during = self.lifecycleInFlight; return "status"; });
  return answer === "status" && during === 1 && self.lifecycleInFlight === 0 && self.fenced === 0;
});

await check("an active manager with a pending resume answers status", async () => {
  const self = receiver({ maintenanceState: "active", resumeRequired: true });
  return await serve(self, () => "status") === "status" && self.lifecycleInFlight === 0 && self.fenced === 0;
});

await check("a throwing status read still releases its count", async () => {
  const self = receiver({ maintenanceState: "preserved" });
  await assert.rejects(serve(self, () => { throw new Error("read failed"); }), /read failed/);
  return self.lifecycleInFlight === 0;
});

await check("a released read wakes a waiting drain", async () => {
  const self = receiver({ maintenanceState: "preserved" });
  let woke = false;
  await serve(self, () => { self.lifecycleDrainWaiters.push(() => { woke = true; }); return "status"; });
  return woke && self.lifecycleInFlight === 0;
});

await check("the membership gate still refuses a retired caller", async () => {
  const self = receiver({ maintenanceState: "preserved", refused: "the caller's lifecycle is retired" });
  await assert.rejects(serve(self, () => "status"), (error: unknown) => error instanceof EpEnvelopeError && error.code === "permission-denied");
  return self.lifecycleInFlight === 0 && self.fenced === 0;
});

for (const [name, state] of [
  ["preserving", { maintenanceState: "preserving" }],
  ["a stopping preserved manager", { maintenanceState: "preserved", leaseStopping: true }],
  ["a stopping manager with a pending resume", { maintenanceState: "active", resumeRequired: true, leaseStopping: true }],
  ["a preserved manager whose resume is pending", { maintenanceState: "preserved", resumeRequired: true }],
  ["an ordinary active manager", { maintenanceState: "active" }],
] as const) {
  await check(`${name} goes through the shared fence`, async () => {
    const self = receiver(state);
    await assert.rejects(serve(self, () => "status"));
    return self.fenced === 1 && self.lifecycleInFlight === 0;
  });
}

console.log(`\nstatus observation smoke: ${passed} checks passed`);
emitSentinel({ passed, failed: 0 });
