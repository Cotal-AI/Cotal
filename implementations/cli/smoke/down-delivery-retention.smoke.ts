/** Hermetic shipped down/stopDelivery composition. Process stops are mocked before imports;
 *  credential deletion uses the real filesystem store. No process is spawned or signalled. */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LocalProcess, LocalProcessContext } from "@cotal-ai/workspace";

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-down-retention-")));
const cwd = process.cwd(), home = process.env.COTAL_HOME, exitCode = process.exitCode;
const calls: string[] = [];
let refuse: string | undefined;
let observedCredentialsAtBroker = false;
let canonical = "", legacy = "";
const stopError = new Error("fixed fixture stop refusal");
let passed = 0;
function check(name: string, value: boolean): void {
  assert.ok(value, name);
  passed++;
  console.log(JSON.stringify({ cell: name, passed: true }));
}

try {
  const noSignals = mock.method(process, "kill", () => { throw new Error("fixture forbids every process signal and liveness probe"); });
  mock.module(new URL("../src/lib/local-process-stop.ts", import.meta.url), {
    cache: true,
    namedExports: {
      // Record inventory is the process boundary, not the credential-cleanup rule under test.
      processRecorded: () => true,
      stopLocalProcess: async (component: LocalProcess, context: LocalProcessContext) => {
        assert.equal(context.root, root);
        calls.push(component.name);
        if (component.name === "nats")
          observedCredentialsAtBroker = existsSync(canonical) && existsSync(legacy);
        if (component.name === refuse) throw stopError;
        return false; // No daemon record, matching the original failed fixture's delivery branch.
      },
    },
  });
  process.env.COTAL_HOME = join(root, "home");
  mkdirSync(join(root, ".cotal"));
  process.chdir(root);
  // The CLI registers the stop-last broker descriptor. The composition root registers delivery's
  // through @cotal-ai/delivery, which this package does not import; its local-process fields are
  // the workspace's DELIVERY_PROCESS.
  await import("../src/index.js");
  const { registry } = await import("@cotal-ai/core");
  registry.register((await import("@cotal-ai/workspace")).DELIVERY_PROCESS);
  const { down } = await import("../src/commands/down.js");
  const { stopDelivery } = await import("../src/lib/delivery-proc.js");
  const { DELIVERY_CREDS_KIND, recordMesh, resolveRuntimeSpace, segmentedKey } = await import("@cotal-ai/workspace");
  const space = resolveRuntimeSpace(root);
  canonical = join(root, ".cotal", segmentedKey(DELIVERY_CREDS_KIND, space));
  legacy = join(root, ".cotal", DELIVERY_CREDS_KIND);
  function reset(failing?: string): void {
    calls.length = 0;
    refuse = failing;
    observedCredentialsAtBroker = false;
    process.exitCode = 0;
    // Bare down stops only a stack `up` recorded at its root, and a clean stop drops that record.
    recordMesh({ space, server: "nats://127.0.0.1:1", root, mode: "open", origin: "up", ts: "2026-10-22T00:00:00.000Z" });
    for (const file of [canonical, legacy]) {
      rmSync(file, { recursive: true, force: true });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "fixed fixture material");
    }
  }
  const retained = () => [canonical, legacy].every(file => existsSync(file) && readFileSync(file, "utf8") === "fixed fixture material");
  const run = (positionals: string[] = []) => down({ positionals, values: {}, raw: [] });

  reset("nats");
  await run();
  check("DR01-broker-refusal-retains-both-delivery-credentials", retained());
  check("DR02-broker-refusal-keeps-failed-verdict", process.exitCode === 1);
  check("DR03-credentials-present-before-stop-last-broker", observedCredentialsAtBroker);
  check("DR04-delivery-stops-before-broker", calls.includes("delivery") && calls.indexOf("delivery") < calls.indexOf("nats"));

  reset("auth");
  await run();
  check("DR05-later-dependent-refusal-retains-credentials", retained());
  check("DR06-dependent-refusal-never-stops-broker", !calls.includes("nats") && process.exitCode === 1);

  reset();
  await run();
  check("DR07-whole-stack-cleans-only-after-broker-stop", observedCredentialsAtBroker && !existsSync(canonical) && !existsSync(legacy));
  check("DR08-whole-stack-success-keeps-zero-exit", process.exitCode === 0);

  reset();
  await stopDelivery(space);
  check("DR10-standalone-delivery-cleans-both-keys", !existsSync(canonical) && !existsSync(legacy) && calls.join(",") === "delivery");

  reset("delivery");
  await assert.rejects(() => stopDelivery(space), error => error === stopError);
  check("DR11-standalone-stop-error-preserves-original-and-credentials", retained());

  reset();
  rmSync(canonical);
  mkdirSync(canonical);
  writeFileSync(join(canonical, "block"), "fixed blocker");
  await assert.rejects(() => run(), error => error instanceof Error);
  check("DR12-whole-stack-delete-error-remains-loud-after-stops", calls.includes("nats") && existsSync(legacy));

  reset();
  rmSync(canonical);
  mkdirSync(canonical);
  writeFileSync(join(canonical, "block"), "fixed blocker");
  await assert.rejects(() => stopDelivery(space), error => error instanceof Error);
  check("DR13-standalone-delete-error-remains-loud-after-delivery-stop", calls.join(",") === "delivery" && existsSync(legacy));
  check("DR14-no-signals-or-liveness-probes", noSignals.mock.callCount() === 0);
  console.log(`COTAL_SMOKE_SENTINEL cells=${passed} passed=${passed} failed=0`);
} finally {
  mock.restoreAll();
  process.chdir(cwd);
  process.exitCode = exitCode;
  if (home === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = home;
  rmSync(root, { recursive: true, force: true });
  console.log("COTAL_DOWN_RETENTION_TERMINAL");
}
