/**
 * Process-bound one-shot policy handoff for `cotal down --with-agents`.
 * Hermetic: only temp files and injected start-token readers, including a no-token platform
 * control; no signals or broker.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANAGER_PIDFILE,
  MANAGER_SPARE_CAPABILITY,
  MANAGER_SHUTDOWN_INTENT,
  armManagerShutdownIntent,
  assertManagerCanSpare,
  canonicalLocalProcessPath,
  consumeManagerShutdownIntent,
  publishManagerSpareCapability,
  type LocalProcessContext,
} from "../src/index.js";

let pass = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  assert.ok(condition, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const root = mkdtempSync(join(tmpdir(), "cotal-manager-shutdown-"));
const context: LocalProcessContext = { root, space: "intent-smoke" };
mkdirSync(join(root, ".cotal"), { recursive: true });
const pidPath = canonicalLocalProcessPath(MANAGER_PIDFILE, context);
const intentPath = canonicalLocalProcessPath(MANAGER_SHUTDOWN_INTENT, context);
const capabilityPath = canonicalLocalProcessPath(MANAGER_SPARE_CAPABILITY, context);
const markerPath = `${pidPath}.stopping`;
const token = "start-token";
const stopperToken = "stopper-token";
const tokens = (pid: number): string | undefined => pid === process.pid ? token : pid === process.pid + 1 ? stopperToken : undefined;
const attempt = {
  target: { pid: process.pid, token },
  stopper: { pid: process.pid + 1, marker: markerPath },
};

try {
  writeFileSync(pidPath, String(process.pid));
  writeFileSync(`${pidPath}.identity`, `${process.pid} ${token}`);
  writeFileSync(markerPath, String(process.pid + 1));

  publishManagerSpareCapability(context, true, tokens);
  assertManagerCanSpare(context, tokens, attempt.target as { pid: number; token: string });
  check("matching exact stop target accepts the manager spare capability", existsSync(capabilityPath));
  let targetRefusal: Error | undefined;
  try {
    assertManagerCanSpare(
      context,
      tokens,
      { pid: process.pid + 1, token: stopperToken },
    );
  } catch (e) { targetRefusal = e as Error; }
  assert.ok(targetRefusal, "a successor target cannot reuse the predecessor's spare capability");
  assert.match(targetRefusal.message, /stop attempt target does not match/);
  check("a successor target cannot reuse the predecessor's spare capability", true);
  writeFileSync(capabilityPath, JSON.stringify({
    version: 1,
    process: { pid: process.pid + 1, token: stopperToken },
  }));
  let capabilityRefusal: Error | undefined;
  try {
    assertManagerCanSpare(
      context,
      tokens,
      attempt.target as { pid: number; token: string },
    );
  } catch (e) { capabilityRefusal = e as Error; }
  assert.ok(capabilityRefusal, "a successor capability record cannot authorize the predecessor target");
  assert.match(capabilityRefusal.message, /malformed, stale, or belongs to a different manager process/);
  check("a successor capability record cannot authorize the predecessor target", true);
  publishManagerSpareCapability(context, true, tokens);

  armManagerShutdownIntent(context, attempt, tokens);
  check("arm publishes a regular one-shot intent", existsSync(intentPath));
  const armed = consumeManagerShutdownIntent(context, process.pid, tokens);
  check("matching process identity selects with-agents", armed.withAgents === true, armed);
  check("consumption removes the intent before shutdown work begins", !existsSync(intentPath));
  const replay = consumeManagerShutdownIntent(context, process.pid, tokens);
  check("consumed intent cannot replay into a later bare shutdown", replay.withAgents === false, replay);

  armManagerShutdownIntent(context, attempt, tokens);
  const stale = consumeManagerShutdownIntent(context, process.pid + 1, tokens);
  check("intent for a different manager process is ignored", stale.withAgents === false && /different process/.test(stale.warning ?? ""), stale);
  check("stale intent is consumed and cannot affect a successor", !existsSync(intentPath));

  writeFileSync(intentPath, "{not-json");
  const malformed = consumeManagerShutdownIntent(context, process.pid, tokens);
  check("malformed intent spares agents", malformed.withAgents === false && /malformed/.test(malformed.warning ?? ""), malformed);
  check("malformed intent is consumed", !existsSync(intentPath));

  writeFileSync(`${pidPath}.identity`, `${process.pid} old-token`);
  await assert.rejects(
    Promise.resolve().then(() => armManagerShutdownIntent(context, { ...attempt, target: { pid: process.pid, token: "old-token" } }, tokens)),
    /destructive policy was not published/,
  );
  check("mismatched manager identity refuses to arm destructive policy", !existsSync(intentPath));

  rmSync(`${pidPath}.identity`, { force: true });
  writeFileSync(markerPath, String(process.pid));
  const legacyAttempt = { target: { pid: process.pid }, stopper: { pid: process.pid, marker: markerPath } };
  armManagerShutdownIntent(context, legacyAttempt, tokens);
  check("an omitted process binding publishes the legacy destructive intent", existsSync(intentPath));
  const legacyArmed = consumeManagerShutdownIntent(context, process.pid, tokens);
  check("a live no-token reservation selects with-agents", legacyArmed.withAgents === true, legacyArmed);
  check("the legacy destructive intent is one-shot", !existsSync(intentPath));

  // A platform with no stable process-start token (Windows today, or another ps-less host) writes
  // the same honest bare-pid shape as a pre-pin manager. The CLI compatibility path must signal that
  // record rather than call this helper. Keep the helper's narrower contract explicit here: injected
  // tokenAt=>undefined cannot manufacture either a manager pin or a destructive intent.
  armManagerShutdownIntent(
    context,
    legacyAttempt,
    () => undefined,
  );
  writeFileSync(markerPath, String(process.pid + 1));
  const legacyDifferentAttempt = consumeManagerShutdownIntent(context, process.pid, () => undefined);
  check("a no-token platform cannot replay destructive policy into another stop reservation",
    legacyDifferentAttempt.withAgents === false && /different stop attempt/.test(legacyDifferentAttempt.warning ?? ""), legacyDifferentAttempt);

  writeFileSync(`${pidPath}.identity`, `${process.pid} ${token}`);
  writeFileSync(markerPath, String(process.pid + 1));
  armManagerShutdownIntent(context, attempt, tokens);
  writeFileSync(markerPath, String(process.pid + 2));
  const differentAttempt = consumeManagerShutdownIntent(context, process.pid, tokens);
  check("a different stop reservation cannot inherit destructive policy",
    differentAttempt.withAgents === false && /different stop attempt/.test(differentAttempt.warning ?? ""), differentAttempt);

  writeFileSync(markerPath, String(process.pid + 1));
  armManagerShutdownIntent(context, attempt, tokens);
  const deadStopper = consumeManagerShutdownIntent(context, process.pid, (pid) => pid === process.pid ? token : undefined);
  check("a crashed stopper cannot poison a later bare shutdown",
    deadStopper.withAgents === false && /stopper identity/.test(deadStopper.warning ?? ""), deadStopper);

  console.log(`\nMANAGER SHUTDOWN INTENT OK (${pass} passed)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
