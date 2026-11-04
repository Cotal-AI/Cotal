/**
 * A HOST CALLBACK THAT REJECTS WITH A NON-ERROR DOES NOT THROW THE HANDLER THAT CAUGHT IT (#3194).
 *
 * `RunHosting.renewRemote` records a failed renewal as `renewalDebt.reason` and logs it from the
 * same text. It used to read `(e as Error).message`: a host whose `renewRun` rejected with `null`
 * or `undefined` made the catch handler itself throw, so `renew()` rejected with the handler's
 * own `TypeError`, the debt was never recorded, and the renewal timer's chain carried the throw.
 * The text now comes from the shared `rejectionText`, which coerces inside its own guard.
 *
 * Brokerless: the slot holds unreadable credentials, so the health check routes to the host
 * callback before anything is dialled, and the callback rejects at once.
 *
 * Run: pnpm smoke:renewal-rejection-text
 */
import { mintLifecycleUid, newIdentity } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { RunHosting } from "../src/run-hosting.js";

const { check, finish } = createSuite();
const unused = async (): Promise<never> => { throw new Error("not exercised by this suite"); };

const renewWith = async (rejection: unknown): Promise<{ outcome: "resolved" | unknown; debt?: { reason: string } }> => {
  const logged: string[] = [];
  const hosting = new RunHosting({
    space: "renewtext", servers: undefined, endpoint: "manager", instanceId: mintLifecycleUid(),
    holder: { id: "manager", lifecycleUid: mintLifecycleUid() }, auth: undefined, log: (l: string) => { logged.push(l); },
    admitRun: unused, issueAttempt: unused, issueOperator: unused,
    renewRun: async () => { throw rejection; },
  });
  const slot = {
    runId: "run-renewtext", takeoverId: "t1", epoch: 1, fencingToken: 1, placements: [],
    identity: newIdentity(), mediatorIdentity: newIdentity(), creds: "not-a-credential", mediatorCreds: "not-a-credential",
  } as Record<string, unknown>;
  (hosting as unknown as { runs: Map<string, unknown> }).runs.set("run-renewtext", slot);
  const outcome = await hosting.renew().then(() => "resolved" as const, (e: unknown) => e);
  return { outcome, debt: slot.renewalDebt as { reason: string } | undefined };
};

for (const [label, rejection, text] of [["a null", null, "null"], ["an undefined", undefined, "undefined"], ["a string", "refused as text", "refused as text"]] as const) {
  const r = await renewWith(rejection);
  check(`renew() resolves when the host rejects with ${label}`, r.outcome === "resolved", r.outcome instanceof Error ? `${r.outcome.name}: ${r.outcome.message}` : r.outcome);
  check(`and the debt is recorded with the value's text for ${label}`, r.debt?.reason === text, r.debt);
}
const plain = await renewWith(new Error("host says no"));
check("CONTROL: an Error rejection records its message as before", plain.outcome === "resolved" && plain.debt?.reason === "host says no", plain);
const hostile = await renewWith({ get message(): string { throw new Error("getter throws"); } });
check("a rejection whose message getter throws still records debt, named as unreadable", hostile.outcome === "resolved" && hostile.debt?.reason === "an unreadable rejection", hostile);

finish();
