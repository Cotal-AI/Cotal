import strictAssert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
import { EndpointRefusal } from "../daemon/endpoint.js";
import { waitForInstalledDaemonGeneration } from "../daemon/update-generation.js";

const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
const root = realpathSync(mkdtempSync(join(tmpdir(), "update-generation-")));
process.env.XDG_RUNTIME_DIR = join(root, "run");
process.env.COTAL_HOME = join(root, "home");

type Reply = Awaited<ReturnType<NonNullable<Parameters<typeof waitForInstalledDaemonGeneration>[1]>["query"] & {}>>;
const status = (version: string, state?: string): Reply => ({ ok: true, result: { state: "ready", protocol: 1, version, pid: 1,
  managers: state ? [{ space: "alpha", state, pid: 2 }] : [] } } as unknown as Reply);
const refused = (code: string, message: string): Reply => ({ ok: false, error: { code, message } } as unknown as Reply);

/** Answer the wait from a script; a thrown entry stands for an endpoint gap. */
function scripted(steps: (Reply | Error)[]) {
  let calls = 0;
  return { calls: () => calls, query: (async () => {
    const step = steps[Math.min(calls++, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    return step;
  }) as NonNullable<Parameters<typeof waitForInstalledDaemonGeneration>[1]>["query"] };
}

// A daemon that refuses status while its hosted Managers stop and start is still restarting.
{
  const run = scripted([
    refused("MANAGER_UNAVAILABLE", "the daemon could not complete status: hosted Manager parent channel is unavailable"),
    new EndpointRefusal("NOT_RUNNING", "no daemon answers"),
    refused("MANAGER_UNAVAILABLE", "the daemon could not complete status: hosted Manager did not confirm the generation request; retrying without stopping it"),
    status("1.0.0", "answering"),
    status("2.0.0", "starting"),
    status("2.0.0", "answering"),
  ]);
  await waitForInstalledDaemonGeneration("2.0.0", { installed: () => true, query: run.query, timeoutMs: 20_000 });
  assert.equal(run.calls(), 6, "the wait continued through two status refusals, an endpoint gap, the old generation and a starting Manager");
}

// A refusal that never clears ends at the bound and names the daemon's own reason.
{
  const run = scripted([refused("MANAGER_UNAVAILABLE", "the daemon could not complete status: hosted Manager parent channel is unavailable")]);
  await assert.rejects(waitForInstalledDaemonGeneration("2.0.0", { installed: () => true, query: run.query, timeoutMs: 800 }), (error: Error) => {
    assert.match(error.message, /did not become ready within 1s/);
    assert.match(error.message, /MANAGER_UNAVAILABLE the daemon could not complete status: hosted Manager parent channel is unavailable/);
    return true;
  });
  assert.ok(run.calls() >= 2, "the refusal was retried until the bound");
}

// Ownership and authentication refusals still stop the wait at once.
{
  const run = scripted([new EndpointRefusal("PEER_UID_MISMATCH", "another user answers")]);
  await assert.rejects(waitForInstalledDaemonGeneration("2.0.0", { installed: () => true, query: run.query, timeoutMs: 5_000 }), /another user answers/);
  assert.equal(run.calls(), 1);
}

// No recorded service: nothing to wait for and nothing is asked.
{
  const run = scripted([status("1.0.0")]);
  await waitForInstalledDaemonGeneration("2.0.0", { installed: () => false, query: run.query });
  assert.equal(run.calls(), 0);
}

emitSentinel({ passed: counted.cells(), failed: 0 });
