/**
 * `cotal join` refusal remedies print mint commands the operator is meant to paste. For a channel
 * whose name starts with a dash (`-general`), a space-separated `--allow-subscribe <channel>` reads
 * the value as another option: `cotal auth mint` exits 1 on the suggestion exactly as printed
 * ("the value of --allow-subscribe starts with \"-\", so it reads as an option"). A remedy that
 * cannot be pasted is no remedy, so grant options in join's refusals attach a dash-prefixed value
 * to its flag: `--allow-subscribe=-general`.
 *
 * Hermetic (no broker): the profile refusal fires before any dial. Run:
 *   tsx implementations/cli/smoke/join-grant-remedy.smoke.ts
 */
import nodeAssert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const scratch = realpathSync(mkdtempSync(joinPath(tmpdir(), "cotal-join-grants-")));
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

const { isCommandFailure } = await import("@cotal-ai/workspace");
const { createSpaceAuth, mintCreds, newIdentity } = await import("@cotal-ai/core");
const { join } = await import("../src/commands/join.js");

// An observer/admin-profile credential is refused as a join credential before anything dials; the
// refusal's remedy mints an agent credential for the channel the caller asked for.
async function profileRemedy(channel: string): Promise<import("@cotal-ai/workspace").CommandFailure> {
  const credsPath = joinPath(scratch, "observer.creds");
  writeFileSync(credsPath, await mintCreds(await createSpaceAuth("auditroom"), newIdentity(), "observer"), { mode: 0o600 });
  let caught: unknown;
  try {
    await join({
      values: {
        creds: credsPath,
        channel,
        name: "joinprobe",
        space: "auditroom",
        server: "nats://127.0.0.1:47737",
      },
      positionals: [],
      raw: [],
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(isCommandFailure(caught), `join with an observer credential must refuse with CommandFailure`);
  assert.equal(caught.outcome, "refused");
  assert.equal(caught.code, "PERMISSION_DENIED");
  assert.ok(caught.remedy !== undefined, "the profile refusal carries a mint remedy");
  return caught;
}

try {
  // The reported harm: every grant option in the printed mint command must paste as issued.
  const dashed = await profileRemedy("-general");
  assert.ok(
    dashed.remedy!.includes("--allow-subscribe=-general"),
    `expected attached --allow-subscribe=-general in: ${dashed.remedy}`,
  );
  assert.ok(
    dashed.remedy!.includes("--allow-publish=-general"),
    `expected attached --allow-publish=-general in: ${dashed.remedy}`,
  );
  assert.ok(
    !dashed.remedy!.includes("--allow-subscribe -general") && !dashed.remedy!.includes("--allow-publish -general"),
    `a space-separated grant option still reads -general as an option: ${dashed.remedy}`,
  );

  // Control: a plain channel keeps the ordinary space-separated spelling.
  const plain = await profileRemedy("general");
  assert.ok(
    plain.remedy!.includes("--allow-subscribe general") && plain.remedy!.includes("--allow-publish general"),
    `expected spaced grant options for a plain channel in: ${plain.remedy}`,
  );

  emitSentinel({ passed: cells(), failed: 0 });
} finally {
  process.chdir(prevCwd);
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(scratch, { recursive: true, force: true });
}
