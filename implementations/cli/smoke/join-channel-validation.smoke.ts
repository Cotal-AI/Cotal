/**
 * `cotal join --channel` validates the channel grammar before touching any broker or credential.
 * An invalid channel (e.g. an empty segment `bad..channel`) refuses immediately with `USAGE_INVALID`
 * rather than dialing and attributing the failure to missing provisioning or credentials.
 *
 * Hermetic (no broker, no network). Run:
 *   tsx implementations/cli/smoke/join-channel-validation.smoke.ts
 */
import nodeAssert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const scratch = realpathSync(mkdtempSync(joinPath(tmpdir(), "cotal-join-channel-")));
const home = joinPath(scratch, "home");
const project = joinPath(scratch, "auditroom");
mkdirSync(home, { recursive: true });
mkdirSync(joinPath(project, ".cotal"), { recursive: true });

const envKeys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "COTAL_HOME", "NO_COLOR", "DO_NOT_TRACK"] as const;
const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
const prevCwd = process.cwd();

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = joinPath(home, "xdg");
process.env.COTAL_HOME = joinPath(home, ".cotal");
process.env.NO_COLOR = "1";
process.env.DO_NOT_TRACK = "1";

const { isCommandFailure, recordMesh } = await import("@cotal-ai/workspace");
const { join } = await import("../src/commands/join.js");

async function expectUsageInvalid(channel: string): Promise<import("@cotal-ai/workspace").CommandFailure> {
  let caught: unknown;
  try {
    await join({
      values: {
        channel,
        name: "joininvalid",
        space: "auditroom",
        server: "nats://127.0.0.1:47737",
      },
      positionals: [],
      raw: [],
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(isCommandFailure(caught), `join --channel ${JSON.stringify(channel)} must refuse with CommandFailure`);
  assert.equal(caught.outcome, "refused");
  assert.equal(caught.code, "USAGE_INVALID");
  return caught;
}

try {
  recordMesh({ space: "auditroom", server: "nats://127.0.0.1:47737", root: project, mode: "open", ts: new Date().toISOString(), origin: "manual" });
  process.chdir(project);

  // 1. Empty segments (`bad..channel`, `.leading`, `trailing.`, `""`) refuse as USAGE_INVALID
  // mentioning empty segment and never recommending `cotal up` or `--creds`/`--token`.
  for (const bad of ["bad..channel", ".leading", "trailing.", ""]) {
    const failure = await expectUsageInvalid(bad);
    assert.ok(failure.message.includes("empty segment"), `expected empty segment message for ${JSON.stringify(bad)}, got: ${failure.message}`);
    assert.ok(!(failure.remedy ?? "").includes("cotal up"), `unexpected provisioning remedy: ${failure.remedy}`);
    assert.ok(!(failure.remedy ?? "").includes("--creds"), `unexpected credential remedy: ${failure.remedy}`);
  }

  // 2. Leading `#` points out dropping `#`, and non-NATS-safe characters also fail USAGE_INVALID.
  const hashErr = await expectUsageInvalid("#general");
  assert.ok((hashErr.remedy ?? "").includes('"general"'), `expected remedy without '#', got: ${hashErr.remedy}`);

  const slashErr = await expectUsageInvalid("foo/bar");
  assert.ok(slashErr.message.includes("NATS-safe token"), `expected NATS-safe message, got: ${slashErr.message}`);

  // 3. Control: valid concrete channels and channel families pass validation cleanly.
  for (const valid of ["team.chat", "team.>"]) {
    let caught: unknown;
    try {
      await join({
        values: {
          channel: valid,
          name: "joinvalid",
          space: "auditroom",
          server: "nats://127.0.0.1:47737",
        },
        positionals: [],
        raw: [],
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(isCommandFailure(caught), `expected offline dial refusal for valid channel ${valid}`);
    assert.equal(caught.code, "TARGET_UNAVAILABLE");
  }

  emitSentinel({ passed: cells(), failed: 0 });
} finally {
  process.chdir(prevCwd);
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(scratch, { recursive: true, force: true });
}
