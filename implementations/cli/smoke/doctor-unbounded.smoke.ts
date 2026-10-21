/**
 * `cotal doctor auth` reports a local credential with no expiry claim as a finding, whatever its
 * kind. `cotal auth mint` writes one by default, and a copy of it stays valid until its signer
 * rotates, so an unbounded agent credential is listed under "Credential findings" with the native
 * replacement guidance, and the run ends failed (exit 5). A bounded agent credential beside it is
 * no finding, and once the unbounded file is gone the same root reports no findings. Broker-free;
 * the doctor reads a staged static root.
 *
 * Run: pnpm smoke:doctor-unbounded
 */
import { strict as nodeAssert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, mintCreds, mintLifecycleUid, newIdentity } from "@cotal-ai/core";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { agentCredsDir, authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { doctor } from "../src/commands/doctor.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const SPACE = "doctor-unbounded";
const auth = await createSpaceAuth(SPACE);
const startCwd = process.cwd();
const priorHome = process.env.COTAL_HOME;
const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-doctor-unbounded-")));
process.env.COTAL_HOME = join(root, "home");
mkdirSync(authDir(root), { recursive: true, mode: 0o700 });
saveSpaceAuth(authDir(root), auth);
const credsDir = agentCredsDir(root, SPACE);
mkdirSync(credsDir, { recursive: true, mode: 0o700 });
// alice: what `auth mint alice` writes with no expiry flag. bob: the same mint with an expiry.
const unbounded = join(credsDir, "alice.creds");
writeFileSync(unbounded, await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid() }), { mode: 0o600 });
writeFileSync(join(credsDir, "bob.creds"), await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid(), expiresInSeconds: 86_400 }), { mode: 0o600 });

interface Item { label: string; state: string; problem: string | null; repair: string | null }
interface Envelope { outcome: string; error?: { code: string }; result: { findings: number; items: Item[] } }

/** One diagnosis of the staged root: its JSON envelope, its exit code and its text report. */
async function diagnose(): Promise<{ envelope: Envelope; code: number | undefined; text: string }> {
  const out: string[] = [];
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const log = console.log;
  const err = console.error;
  process.chdir(root);
  try {
    process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
    process.exitCode = undefined;
    await doctor({ values: { space: SPACE, json: true }, positionals: ["auth"], raw: [] });
    const code = process.exitCode as number | undefined;
    process.stdout.write = write;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
    await doctor({ values: { space: SPACE }, positionals: ["auth"], raw: [] });
    return { envelope: JSON.parse(out.join("")) as Envelope, code, text: lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "") };
  } finally {
    process.stdout.write = write;
    console.log = log;
    console.error = err;
    process.chdir(startCwd);
    process.exitCode = 0;
  }
}

try {
  // 1. The unbounded agent credential is a finding with the native guidance; the run fails.
  {
    const { envelope, code, text } = await diagnose();
    const alice = envelope.result.items.find((item) => item.label === "alice.creds");
    const bob = envelope.result.items.find((item) => item.label === "bob.creds");
    assert.equal(alice?.state, "unbounded", "fixture: alice.creds carries no expiry claim");
    assert.match(alice?.problem ?? "", /^unbounded credential \(no expiry claim\)/, "the unbounded agent credential is a finding");
    assert.match(alice?.repair ?? "", /native renewal skips unbounded/, "its guidance is the native replacement path, not a respawn");
    assert.equal(bob?.state, "healthy", "fixture: bob.creds is bounded and healthy");
    assert.equal(bob?.problem, null, "a bounded agent credential is no finding");
    assert.equal(envelope.result.findings, 1, "one finding");
    assert.equal(envelope.outcome, "failed", "the diagnosis ends failed");
    assert.equal(envelope.error?.code, "OPERATION_FAILED", "with OPERATION_FAILED");
    assert.equal(code, 5, "exit 5");
    assert.match(text, /Credential findings/, "the text report heads its findings");
    assert.doesNotMatch(text, /No local credential findings/, "and never calls the root finding-free");
  }

  // 2. Control: without the unbounded file the same root has no findings.
  {
    rmSync(unbounded);
    const { envelope, code, text } = await diagnose();
    assert.equal(envelope.result.findings, 0, "no findings once the unbounded credential is gone");
    assert.equal(envelope.outcome, "ok", "the diagnosis ends ok");
    assert.equal(code, 0, "exit 0");
    assert.match(text, /No local credential findings/, "the text report says so");
  }
} finally {
  process.chdir(startCwd);
  if (priorHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = priorHome;
  rmSync(root, { recursive: true, force: true });
}

console.log("doctor-unbounded smoke: OK - an unbounded agent credential is a doctor finding with native guidance and a failed (exit 5) diagnosis, a bounded one is not, and the root is finding-free once it is gone");
emitSentinel({ passed: cells(), failed: 0 });
