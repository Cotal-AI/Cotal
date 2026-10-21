/**
 * With no space to act on, `cotal auth mint` and `cotal doctor auth` name the next step. `auth mint`
 * refuses with TARGET_NOT_FOUND (exit 2) and the remedy the workspace gives for a missing mesh.
 * `doctor auth` in a folder whose root holds no space reports a partial result (exit 4) whose
 * remedy says to run it in a space's root, in JSON and in the text report. Nothing is written.
 * Broker-free; the mesh registry is private to this run.
 *
 * Run: pnpm smoke:no-space-next
 */
import { strict as nodeAssert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { exitCode, findCotalRoot, isCommandFailure, type CommandFailure } from "@cotal-ai/workspace";
import { doctor } from "../src/commands/doctor.js";
import { mint } from "../src/commands/mint.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const DOCTOR_NEXT = "run `cotal doctor auth` in a space's root folder; `cotal space` lists each space's root";

const startCwd = process.cwd();
const priorHome = process.env.COTAL_HOME;
const base = realpathSync(mkdtempSync(join(tmpdir(), "cotal-no-space-next-")));
process.env.COTAL_HOME = join(base, "home");
const bare = join(base, "bare");
mkdirSync(bare);

/** One doctor run in `bare`: what it wrote to stdout and stderr, and its exit code. */
async function diagnose(values: Record<string, string | boolean | undefined>): Promise<{ out: string; err: string; code: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const log = console.log;
  const error = console.error;
  process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  console.log = (...a: unknown[]) => { out.push(`${a.join(" ")}\n`); };
  console.error = (...a: unknown[]) => { err.push(`${a.join(" ")}\n`); };
  process.chdir(bare);
  try {
    process.exitCode = undefined;
    await doctor({ values, positionals: ["auth"], raw: [] });
    return { out: out.join(""), err: err.join("").replace(/\x1b\[[0-9;]*m/g, ""), code: process.exitCode as number | undefined };
  } finally {
    process.stdout.write = write;
    console.log = log;
    console.error = error;
    process.chdir(startCwd);
    process.exitCode = 0;
  }
}

try {
  assert.equal(findCotalRoot(bare), bare, "fixture: no .cotal directory above the temp dir");

  // 1. auth mint with no mesh: a target refusal that names the next step, and no file written.
  {
    process.chdir(bare);
    let failure: CommandFailure | undefined;
    try { await mint({ values: {}, positionals: ["alice"], raw: [] }); }
    catch (error) { if (!isCommandFailure(error)) throw error; failure = error; }
    finally { process.chdir(startCwd); }
    assert.ok(failure, "auth mint with no mesh refuses");
    assert.equal(failure!.code, "TARGET_NOT_FOUND", `auth mint with no mesh: code (${failure!.message})`);
    assert.equal(exitCode(failure!.outcome, failure!.code), 2, "auth mint with no mesh: exit 2");
    assert.equal(failure!.remedy, "run `cotal up` in a project, or pass `--server`", "auth mint with no mesh: the remedy names the next step");
    assert.deepEqual(readdirSync(bare), [], "auth mint with no mesh writes nothing");
  }

  // 2. doctor auth in a folder whose root holds no space: partial with a next step in JSON.
  {
    const { out, code } = await diagnose({ json: true });
    const envelope = JSON.parse(out) as { outcome: string; error?: { code: string; remedy?: string }; result: { space: string | null } };
    assert.equal(envelope.outcome, "partial", "doctor with no space: partial");
    assert.equal(envelope.error?.code, "OPERATION_PARTIAL", "doctor with no space: OPERATION_PARTIAL");
    assert.equal(envelope.error?.remedy, DOCTOR_NEXT, "doctor with no space: the JSON remedy names the next step");
    assert.equal(envelope.result.space, null, "doctor with no space: no space is assumed");
    assert.equal(code, 4, "doctor with no space: exit 4");
  }

  // 3. The same run as text: the remedy follows the partial line on stderr.
  {
    const { err, code } = await diagnose({});
    // A terminal may wrap the line, so compare with whitespace collapsed.
    assert.ok(err.replace(/\s+/g, " ").includes(`↳ ${DOCTOR_NEXT}`), `doctor with no space: the text report names the next step: ${err}`);
    assert.equal(code, 4, "doctor text with no space: exit 4");
    assert.deepEqual(readdirSync(bare), [], "doctor with no space writes nothing");
  }
} finally {
  process.chdir(startCwd);
  if (priorHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = priorHome;
  rmSync(base, { recursive: true, force: true });
}

console.log("no-space-next smoke: OK - auth mint with no mesh refuses TARGET_NOT_FOUND with its next step, and doctor auth with no space is partial (exit 4) with a remedy in JSON and text; nothing is written");
emitSentinel({ passed: cells(), failed: 0 });
