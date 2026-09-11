/**
 * Process-bound one-shot policy handoff for `cotal down --with-agents`.
 * Hermetic: only temp files and injected start-token readers, no signals or broker.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANAGER_PIDFILE,
  MANAGER_SHUTDOWN_INTENT,
  armManagerShutdownIntent,
  canonicalLocalProcessPath,
  consumeManagerShutdownIntent,
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
const markerPath = `${pidPath}.stopping`;
const token = "start-token";
const stopperToken = "stopper-token";
const tokens = (pid: number): string | undefined => pid === process.pid ? token : pid === process.pid + 1 ? stopperToken : undefined;

try {
  writeFileSync(pidPath, String(process.pid));
  writeFileSync(`${pidPath}.identity`, `${process.pid} ${token}`);
  writeFileSync(markerPath, String(process.pid + 1));

  armManagerShutdownIntent(context, tokens);
  check("arm publishes a regular one-shot intent", existsSync(intentPath));
  const armed = consumeManagerShutdownIntent(context, process.pid, tokens);
  check("matching process identity selects with-agents", armed.withAgents === true, armed);
  check("consumption removes the intent before shutdown work begins", !existsSync(intentPath));
  const replay = consumeManagerShutdownIntent(context, process.pid, tokens);
  check("consumed intent cannot replay into a later bare shutdown", replay.withAgents === false, replay);

  armManagerShutdownIntent(context, tokens);
  const stale = consumeManagerShutdownIntent(context, process.pid + 1, tokens);
  check("intent for a different manager process is ignored", stale.withAgents === false && /different process/.test(stale.warning ?? ""), stale);
  check("stale intent is consumed and cannot affect a successor", !existsSync(intentPath));

  writeFileSync(intentPath, "{not-json");
  const malformed = consumeManagerShutdownIntent(context, process.pid, tokens);
  check("malformed intent spares agents", malformed.withAgents === false && /malformed/.test(malformed.warning ?? ""), malformed);
  check("malformed intent is consumed", !existsSync(intentPath));

  writeFileSync(`${pidPath}.identity`, `${process.pid} old-token`);
  await assert.rejects(
    Promise.resolve().then(() => armManagerShutdownIntent(context, tokens)),
    /destructive policy was not published/,
  );
  check("mismatched manager identity refuses to arm destructive policy", !existsSync(intentPath));

  rmSync(`${pidPath}.identity`, { force: true });
  await assert.rejects(
    Promise.resolve().then(() => armManagerShutdownIntent(context, tokens)),
    /has no process identity pin/,
  );
  check("omitted process binding refuses to arm destructive policy", !existsSync(intentPath));

  writeFileSync(`${pidPath}.identity`, `${process.pid} ${token}`);
  writeFileSync(markerPath, String(process.pid + 1));
  armManagerShutdownIntent(context, tokens);
  writeFileSync(markerPath, String(process.pid + 2));
  const differentAttempt = consumeManagerShutdownIntent(context, process.pid, tokens);
  check("a different stop reservation cannot inherit destructive policy",
    differentAttempt.withAgents === false && /different stop attempt/.test(differentAttempt.warning ?? ""), differentAttempt);

  writeFileSync(markerPath, String(process.pid + 1));
  armManagerShutdownIntent(context, tokens);
  const deadStopper = consumeManagerShutdownIntent(context, process.pid, (pid) => pid === process.pid ? token : undefined);
  check("a crashed stopper cannot poison a later bare shutdown",
    deadStopper.withAgents === false && /stopper identity/.test(deadStopper.warning ?? ""), deadStopper);

  console.log(`\nMANAGER SHUTDOWN INTENT OK (${pass} passed)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
