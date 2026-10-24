/**
 * `cotal doctor auth` reports a local credential with no expiry claim as a finding, whatever its
 * kind, since a copy of it stays valid until its signer rotates. An unbounded agent credential is
 * listed under "Credential findings" with guidance that retires it by rotating the space identity or
 * bounds it with `cotal auth mint <label> --replace`, and the run ends failed (exit 5). One `cotal
 * auth mint --no-expiry` asked for, whose record beside it names its bytes, is a warning with the same
 * ways out and the run ends ok (exit 0); a record that names other bytes covers nothing. An
 * incarnation file, which is no label's standing credential, is bounded by removing it instead. An
 * expired label's file names the same `--replace` beside the managed renewal; an expired incarnation
 * keeps the managed guidance only. A bounded agent credential beside them is no finding, and once the
 * unbounded and expired files are gone the same root reports no findings. Broker-free; the doctor
 * reads a staged static root.
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
import { displayCmd } from "../src/lib/self-exec.js";
import { noExpiryRecordPath, noExpiryRecordText } from "../src/lib/no-expiry-record.js";

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
const replaceFor = (label: string) => `\`${displayCmd()} auth mint ${label} --replace --space ${SPACE}\`, which lasts 24 hours unless --expires-in <seconds> or --expires-at <unix-seconds> sets another time`;
mkdirSync(credsDir, { recursive: true, mode: 0o700 });
// alice: an unbounded credential nobody recorded asking for. bob: the same mint with an expiry.
const unbounded = join(credsDir, "alice.creds");
writeFileSync(unbounded, await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid() }), { mode: 0o600 });
writeFileSync(join(credsDir, "bob.creds"), await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid(), expiresInSeconds: 86_400 }), { mode: 0o600 });

interface Item { label: string; state: string; problem: string | null; warning: string | null; repair: string | null }
interface Envelope { outcome: string; error?: { code: string }; warnings: { code: string; target: { path?: string }; message: string }[]; result: { findings: number; items: Item[] } }

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
    assert.match(alice?.problem ?? "", /a copy stays valid until the space identity rotates$/, "the finding says how long a copy lives");
    assert.match(alice?.repair ?? "", new RegExp(`reset space ${SPACE}\``), "its guidance retires it by rotating the space identity");
    assert.ok(alice?.repair?.includes(`Or bound it: stop what uses it, then replace it with ${replaceFor("alice")}`), "and bounds it with auth mint --replace for its label");
    assert.ok(!alice?.repair?.includes(`remove ${unbounded}`), "  rather than a hand removal inside .cotal");
    assert.equal(bob?.state, "healthy", "fixture: bob.creds is bounded and healthy");
    assert.equal(bob?.problem, null, "a bounded agent credential is no finding");
    assert.equal(envelope.result.findings, 1, "one finding");
    assert.equal(envelope.outcome, "failed", "the diagnosis ends failed");
    assert.equal(envelope.error?.code, "OPERATION_FAILED", "with OPERATION_FAILED");
    assert.equal(code, 5, "exit 5");
    assert.match(text, /Credential findings/, "the text report heads its findings");
    assert.doesNotMatch(text, /No local credential findings/, "and never calls the root finding-free");
  }

  // 2. A record beside it that names other bytes, as a record copied from another file does, covers nothing.
  {
    writeFileSync(noExpiryRecordPath(unbounded), noExpiryRecordText(await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid() })), { mode: 0o600 });
    const { envelope, code } = await diagnose();
    const alice = envelope.result.items.find((item) => item.label === "alice.creds");
    assert.match(alice?.problem ?? "", /^unbounded credential \(no expiry claim\)/, "a record that names other bytes leaves the credential a finding");
    assert.equal(alice?.warning, null, "and no warning");
    assert.equal(code, 5, "the run still fails, exit 5");
  }

  // 3. A credential `auth mint --no-expiry` asked for, with its record beside it, is a warning; the run is ok.
  {
    const requested = join(credsDir, "carol.creds");
    const creds = await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid() });
    writeFileSync(requested, creds, { mode: 0o600 });
    writeFileSync(noExpiryRecordPath(requested), noExpiryRecordText(creds), { mode: 0o600 });
    rmSync(unbounded);
    rmSync(noExpiryRecordPath(unbounded));
    const { envelope, code, text } = await diagnose();
    const carol = envelope.result.items.find((item) => item.label === "carol.creds");
    assert.equal(carol?.state, "unbounded", "fixture: carol.creds carries no expiry claim");
    assert.equal(carol?.problem, null, "a requested unbounded credential is no finding");
    assert.match(carol?.warning ?? "", /^unbounded by request \(auth mint --no-expiry, recorded [0-9T:.-]+Z\) - a copy stays valid until the space identity rotates$/, "it is a warning that says it was asked for");
    assert.ok(carol?.repair?.includes(`then replace it with ${replaceFor("carol")}`), "with the same ways out: --replace also drops its record");
    assert.deepEqual(envelope.warnings.map((w) => [w.code, w.target.path]), [["CREDENTIAL_UNBOUNDED_BY_REQUEST", requested]], "the envelope carries one warning naming the file");
    assert.equal(envelope.result.findings, 0, "no findings");
    assert.equal(envelope.outcome, "ok", "the diagnosis ends ok");
    assert.equal(code, 0, "exit 0");
    assert.match(text, /No local credential findings/, "the text report says there are no findings");
    assert.match(text, /carol\.creds: unbounded by request/, "and prints the warning");
    rmSync(requested);
    rmSync(noExpiryRecordPath(requested));
  }

  // 4. An incarnation file is no label's standing credential, so --replace cannot reach it and the
  //    guidance removes it by hand. An expired label's file names --replace beside managed renewal;
  //    an expired lone incarnation keeps the managed guidance only.
  {
    const incarnation = join(credsDir, `dave.${mintLifecycleUid()}.creds`);
    writeFileSync(incarnation, await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid() }), { mode: 0o600 });
    const now = Math.floor(Date.now() / 1000);
    const expiredLabel = join(credsDir, "erin.creds");
    const expiredIncarnation = join(credsDir, `frank.${mintLifecycleUid()}.creds`);
    for (const path of [expiredLabel, expiredIncarnation]) writeFileSync(path, await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid(), expiresAt: now - 60 }), { mode: 0o600 });
    const { envelope, code } = await diagnose();
    const item = (path: string) => envelope.result.items.find((i) => i.label === path.slice(credsDir.length + 1));
    assert.ok(item(incarnation)?.repair?.includes(`Or bound it: stop what uses it, remove ${incarnation} and mint a replacement without --no-expiry`), "an unbounded incarnation file is bounded by removing it");
    assert.ok(!item(incarnation)?.repair?.includes("--replace"), "  and its guidance names no --replace");
    assert.equal(item(expiredLabel)?.state, "expired", "fixture: erin.creds has expired");
    assert.ok(item(expiredLabel)?.repair?.includes(`If \`${displayCmd()} auth mint\` wrote it, replace it with ${replaceFor("erin")}`), "an expired label's file names --replace for that label");
    assert.match(item(expiredLabel)?.repair ?? "", /^if a manager runs this agent, inspect this original lifecycle under it; supported managed renewal can re-sign the same nkey/, "  after the managed renewal that re-signs its nkey");
    assert.equal(item(expiredIncarnation)?.state, "expired", "fixture: the incarnation file has expired");
    assert.match(item(expiredIncarnation)?.repair ?? "", /^inspect this original lifecycle under its manager/, "an expired incarnation keeps the managed guidance");
    assert.ok(!item(expiredIncarnation)?.repair?.includes("--replace"), "  and names no --replace");
    assert.equal(envelope.result.findings, 3, "the three files are findings");
    assert.equal(code, 5, "exit 5");
    for (const path of [incarnation, expiredLabel, expiredIncarnation]) rmSync(path);
  }

  // 5. Control: without the unbounded and expired files the same root has no findings.
  {
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

console.log("doctor-unbounded smoke: OK - an unbounded agent credential is a doctor finding with native guidance and a failed (exit 5) diagnosis, one auth mint --no-expiry recorded is a warning (exit 0), a bounded one is neither, and the root is finding-free once they are gone");
emitSentinel({ passed: cells(), failed: 0 });
