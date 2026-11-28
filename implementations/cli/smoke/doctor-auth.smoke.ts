/**
 * `cotal doctor auth` smoke (D5 slice 6) — broker-free. Two layers:
 *
 *  1. `inspectCredHealth` (core) is pinned pure: healthy / near-expiry (past 75% of iat→exp) /
 *     expired / unbounded / unreadable, with an injected clock.
 *  2. The doctor command runs against a STAGED root in the per-space layout (real crypto:
 *     createSpaceAuth + mintCreds) and is read through its JSON envelope. An expired delivery cred,
 *     an unbounded standing membership-rw cred, an unbounded agent cred and a missing connection-evictor
 *     (nothing but a system-account rotation mints it again) are findings; a healthy $SYS observer is
 *     not, and a user-auth sentinel file is not listed. `--fix` re-signs the two daemon files for their EXISTING nkeys (the identity pin) and,
 *     with no registered mesh, records an offline repair rather than the lease. It never re-signs an
 *     agent cred, so that finding stays and the run is partial. With the agent file gone the root has
 *     no findings. A daemon file the NATS client cannot parse holds no key to re-sign, so an offline
 *     `--fix` mints it again under a new identity and says so. `doctor` without `auth`, and an unknown
 *     `--space`, refuse. A `--space` registered at another root refuses too, reading no other root,
 *     and its next step names that root.
 *
 * Run: pnpm smoke:doctor-auth
 */
import { strict as nodeAssert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSpaceAuth,
  idFromCreds,
  inspectCredHealth,
  mintCreds,
  mintConnectionEvictorCreds,
  mintLifecycleUid,
  mintMembershipObserverCreds,
  newIdentity,
  revokeAccountUser,
} from "@cotal-ai/core";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { agentCredsDir, authDir, isCommandFailure, readRenewalRecord, recordMesh, saveSpaceAuth, spaceMaterialDir, type CommandFailure } from "@cotal-ai/workspace";
import { doctor } from "../src/commands/doctor.js";
import { credentialExportStore, recordCredentialExport } from "../src/lib/credential-exports.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

// ── 1. inspectCredHealth: pure-state pins with an injected clock ─────────────────────────────────
const SPACE = "doctor-smoke";
const auth = await createSpaceAuth(SPACE);
const sysObserver = await mintMembershipObserverCreds(auth, newIdentity()); // while the $SYS seed is in memory
const sysEvictor = await mintConnectionEvictorCreds(auth, newIdentity());
const now = Math.floor(Date.now() / 1000);
const bounded = await mintCreds(auth, newIdentity(), "probe", { expiresInSeconds: 100 });
// Probe against the cred's OWN iat/exp, never against `now`. The smoke's clock
// and the mint's clock are two separate reads of Date.now(); when a second
// boundary falls between them the mint stamps exp = now + 101, and a probe at
// now + 100 reads near-expiry. Reproduced 400/400 by starting the two statements
// with under a millisecond left in the second; CI hit it on a loaded runner.
const stamped = inspectCredHealth(bounded);
const iat = stamped.iat!;
const exp = stamped.exp!;
assert.ok(Number.isInteger(iat) && Number.isInteger(exp) && exp > iat, "a bounded mint carries iat and exp");
assert.equal(inspectCredHealth(bounded, iat + 60).state, "healthy", "healthy before the 75% renewal point");
assert.equal(inspectCredHealth(bounded, iat + 80).state, "near-expiry", "near-expiry past the 75% renewal point");
assert.equal(inspectCredHealth(bounded, exp).state, "expired", "expired at/after exp");
assert.ok(Math.abs(stamped.renewAt! - (iat + 75)) <= 2, "renewAt is 75% of the iat→exp lifetime");
const unbounded = await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid() });
assert.equal(inspectCredHealth(unbounded, now).state, "unbounded", "unbounded when the JWT has no exp");
assert.equal(inspectCredHealth("not a creds file", now).state, "unreadable", "unreadable on garbage (reported, not thrown)");

// ── 2. the doctor against a staged root ──────────────────────────────────────────────────────────
// realpath'd: the doctor derives its root from `process.cwd()` after this smoke `chdir`s into it,
// and the OS resolves any symlink in the path (e.g. a symlinked TMPDIR) on that walk.
const startCwd = process.cwd();
const priorHome = process.env.COTAL_HOME;
const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-doctor-")));
// A private registry: `--fix` finds no registered mesh for this space, so it repairs offline.
process.env.COTAL_HOME = join(root, "home");
mkdirSync(authDir(root), { recursive: true, mode: 0o700 });
saveSpaceAuth(authDir(root), auth);
const material = spaceMaterialDir(root, SPACE);
mkdirSync(material, { recursive: true, mode: 0o700 });
// delivery: EXPIRED (broker-dead). membership-rw: UNBOUNDED standing cred (pre-renewal mint shape).
// $SYS observer: healthy (bounded 30d at mint). connection-evictor deliberately MISSING (a finding).
const dlvId = newIdentity();
const rwId = newIdentity();
writeFileSync(join(material, "delivery.creds"), await mintCreds(auth, dlvId, "delivery", { expiresAt: now - 10 }), { mode: 0o600 });
writeFileSync(join(material, "membership-rw.creds"), await mintCreds(auth, rwId, "agent", { lifecycleUid: mintLifecycleUid() }), { mode: 0o600 });
writeFileSync(join(material, "membership-observer.creds"), sysObserver, { mode: 0o600 });
const agents = agentCredsDir(root, SPACE);
mkdirSync(agents, { recursive: true, mode: 0o700 });
// A static agent cred with no expiry and no record beside it that someone asked for one: a finding.
const alice = join(agents, "alice.creds");
writeFileSync(alice, unbounded, { mode: 0o600 });
// User-auth managed-agent sentinel: deny-all callout-account bearer plumbing, NOT a static agent cred.
writeFileSync(join(agents, "alpha.sentinel.creds"), unbounded, { mode: 0o600 });

interface Item { label: string; state: string; problem: string | null; repair: string | null }
interface Envelope {
  outcome: string;
  error?: { code: string };
  result: {
    findings: number;
    items: Item[];
    exported: { path: string; state: string; issuedAt: number | null; repair: string | null }[];
    repair: { attempted: boolean; authority: string | null; results: { file: string; ok: boolean; reminted: boolean; reason: string | null }[] };
    renewal: { authority: string | null };
  };
}

/** One `doctor auth` run in the staged root: its JSON envelope when asked for, its text and its
 *  exit code. */
async function runDoctor(values: Record<string, string | boolean>): Promise<{ envelope?: Envelope; text: string; code: number | undefined }> {
  const out: string[] = [];
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const log = console.log;
  const err = console.error;
  process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  process.exitCode = undefined;
  process.chdir(root);
  try {
    await doctor({ values: { space: SPACE, ...values }, positionals: ["auth"], raw: [] });
    const code = process.exitCode as number | undefined;
    return { ...(values.json ? { envelope: JSON.parse(out.join("")) as Envelope } : {}), text: lines.join("\n").replace(/\x1b\[[0-9;]*m/g, ""), code };
  } finally {
    process.stdout.write = write;
    console.log = log;
    console.error = err;
    process.chdir(startCwd);
    process.exitCode = 0;
  }
}

/** The refusal one `doctor` invocation in the staged root ends with. */
async function refusal(values: Record<string, string | boolean>, positionals: string[]): Promise<CommandFailure> {
  process.chdir(root);
  try {
    await doctor({ values, positionals, raw: [] });
  } catch (error) {
    if (isCommandFailure(error)) return error;
    throw error;
  } finally {
    process.chdir(startCwd);
    process.exitCode = 0;
  }
  throw new Error(`doctor ${positionals.join(" ")} did not refuse`);
}

const item = (envelope: Envelope, label: string) => envelope.result.items.find((row) => row.label === label);

try {
  if (process.getuid && process.getuid() !== 0) {
    chmodSync(agents, 0o100);
    try {
      const denied = await refusal({ space: SPACE }, ["auth"]);
      assert.equal(denied.code, "PERMISSION_DENIED");
      assert.ok(denied.remedy?.includes("chmod u+rx") && denied.remedy.includes(agents));
    } finally { chmodSync(agents, 0o700); }
    assert.equal(readFileSync(alice, "utf8"), unbounded, "restoring inventory access does not change the agent credential");
  }
  // Plain diagnosis: three findings with their repairs, two quiet rows, and no sentinel row.
  {
    const { envelope, code } = await runDoctor({ json: true });
    const report = envelope!;
    const dlv = item(report, "delivery.creds");
    assert.equal(dlv?.state, "expired", "fixture: delivery.creds is expired");
    assert.match(dlv?.problem ?? "", /^EXPIRED/, "the expired delivery cred is a finding");
    assert.match(dlv?.repair ?? "", /doctor auth --fix/, "its repair names doctor auth --fix");
    const rw = item(report, "membership-rw.creds");
    assert.match(rw?.problem ?? "", /^unbounded standing credential/, "the unbounded standing membership-rw cred is a finding");
    assert.match(rw?.repair ?? "", /doctor auth --fix/, "its repair names doctor auth --fix");
    assert.equal(item(report, "membership-observer.creds")?.state, "healthy", "the $SYS observer is healthy");
    assert.equal(item(report, "membership-observer.creds")?.problem, null, "and not a finding");
    assert.equal(item(report, "connection-evictor.creds")?.state, "missing", "the connection-evictor is missing");
    assert.equal(item(report, "connection-evictor.creds")?.problem, "missing - live connection eviction cannot run without it", "and a finding, since only a rotation mints it again");
    assert.match(item(report, "connection-evictor.creds")?.repair ?? "", /down` then `.* up --rotate-sys`/, "its repair is the system-account rotation");
    assert.equal(item(report, "alice.creds")?.state, "unbounded", "fixture: alice.creds carries no expiry claim");
    assert.match(item(report, "alice.creds")?.problem ?? "", /^unbounded credential \(no expiry claim\)/, "the unbounded static agent cred is a finding");
    assert.ok(!report.result.items.some((row) => row.label.includes("sentinel")), "the user-auth sentinel is not listed as a static agent cred");
    assert.equal(report.result.findings, 4, "four findings");
    assert.equal(report.result.repair.attempted, false, "plain diagnosis repairs nothing");
    assert.equal(report.outcome, "failed", "the diagnosis ends failed");
    assert.equal(report.error?.code, "OPERATION_FAILED", "with OPERATION_FAILED");
    assert.equal(code, 5, "exit 5");
  }

  // --fix: the daemon files are re-signed offline for their own nkeys; the agent finding stays.
  // The evictor is staged first, as the rotation the finding names would leave it.
  writeFileSync(join(material, "connection-evictor.creds"), sysEvictor, { mode: 0o600 });
  for (const file of ["membership-observer.creds", "connection-evictor.creds"]) {
    const path = join(material, file);
    const before = readFileSync(path);
    try {
      for (const malformed of [Buffer.from("-----BEGIN NATS USER JWT-----\neyJ0eXAiOi"), Buffer.from([0xff, 0xfe])]) {
        writeFileSync(path, malformed);
        const { envelope, code } = await runDoctor({ json: true });
        assert.equal(item(envelope!, file)?.state, "unreadable", `${file}: truncated JWT and invalid UTF-8 are per-file findings`);
        assert.match(item(envelope!, file)?.repair ?? "", /up --rotate-sys/, `${file}: retains system rotation guidance`);
        assert.ok(envelope!.result.items.length >= 5, "an unreadable system credential does not hide other rows");
        assert.equal(code, 5, "local findings still fail the diagnosis");
        assert.deepEqual(readFileSync(path), malformed, "read-only diagnosis leaves the file unchanged");
      }
    } finally { writeFileSync(path, before); }
  }
  {
    const { envelope, code } = await runDoctor({ json: true, fix: true });
    const report = envelope!;
    assert.equal(report.result.repair.attempted, true, "--fix re-signed");
    assert.equal(report.result.repair.authority, "offline", "with no registered mesh the repair is offline");
    assert.deepEqual(report.result.repair.results.filter((row) => row.ok).map((row) => row.file).sort(), ["delivery.creds", "membership-rw.creds"], "both daemon files were re-signed");
    assert.equal(readRenewalRecord(root, SPACE)?.authority, "offline", "the renewal record says offline, never the lease");
    assert.equal(report.result.renewal.authority, "offline", "and the report reads that record back");
    const dlvAfter = readFileSync(join(material, "delivery.creds"), "utf8");
    const rwAfter = readFileSync(join(material, "membership-rw.creds"), "utf8");
    assert.equal(idFromCreds(dlvAfter), dlvId.id, "--fix re-signed delivery for the SAME nkey (identity pin)");
    assert.equal(idFromCreds(rwAfter), rwId.id, "--fix re-signed membership-rw for the SAME nkey");
    assert.equal(inspectCredHealth(dlvAfter).state, "healthy", "the re-signed delivery cred is healthy");
    assert.equal(inspectCredHealth(rwAfter).state, "healthy", "--fix bounded the previously-unbounded membership-rw");
    assert.deepEqual(report.result.items.filter((row) => row.problem !== null).map((row) => row.label), ["alice.creds"], "only the agent finding remains: --fix never re-signs an agent cred");
    assert.equal(report.outcome, "partial", "re-signed files with a finding left is partial");
    assert.equal(report.error?.code, "OPERATION_PARTIAL", "with OPERATION_PARTIAL");
    assert.equal(code, 4, "exit 4");
  }

  // Without the unbounded agent cred the root has no findings.
  {
    rmSync(alice);
    const { envelope, code } = await runDoctor({ json: true });
    assert.equal(envelope?.result.findings, 0, "no findings once the agent cred is gone");
    assert.equal(envelope?.outcome, "ok", "the diagnosis ends ok");
    assert.equal(code, 0, "exit 0");
    assert.match((await runDoctor({})).text, /No local credential findings/, "the text report says so");
  }

  // A file other accounts can open is named by its mode, with the chmod that fixes it, and a file
  // the NATS client cannot parse is a finding although its claims are legible. A $SYS store file at
  // 0644 is one row like the others: the run still checks every other file.
  {
    const shared = join(agents, "bob.creds");
    const crlf = join(agents, "dave.creds");
    const observer = join(material, "membership-observer.creds");
    writeFileSync(shared, bounded, { mode: 0o600 });
    chmodSync(shared, 0o644);
    chmodSync(observer, 0o644);
    writeFileSync(crlf, bounded.replace(/\n/g, "\r\n"), { mode: 0o600 });
    const { envelope, code } = await runDoctor({ json: true });
    if (process.platform !== "win32") {
      assert.equal(item(envelope!, "bob.creds")?.problem, "the credential file is not private to you (mode 0644)", "a 0644 credential is named by its mode, not as a parse failure");
      assert.equal(item(envelope!, "bob.creds")?.repair, `chmod 600 ${shared}`, "its repair is the chmod that makes it private");
      assert.equal(item(envelope!, "membership-observer.creds")?.problem, "the credential file is not private to you (mode 0644)", "a 0644 $SYS store credential is named by its mode, not a refusal of the whole run");
      assert.equal(item(envelope!, "membership-observer.creds")?.repair, `chmod 600 ${observer}`, "its repair is the chmod that makes it private");
      assert.equal(item(envelope!, "delivery.creds")?.state, "healthy", "the other files are still checked");
    }
    assert.equal(item(envelope!, "dave.creds")?.problem, "the NATS client cannot parse it: it has Windows (CRLF) line endings", "a CRLF credential is a finding, as --creds refuses it");
    assert.match(item(envelope!, "dave.creds")?.repair ?? "", /^save it with LF line endings/, "its repair says how to fix the line endings");
    assert.equal(code, 5, "the findings exit 5");
    rmSync(shared);
    rmSync(crlf);
    chmodSync(observer, 0o600);
  }

  // A daemon file the NATS client cannot parse holds no key to re-sign. With no broker answering,
  // --fix mints it again under a new identity and names that in its row; a re-signed file has none.
  {
    const rwPath = join(material, "membership-rw.creds");
    writeFileSync(rwPath, readFileSync(rwPath, "utf8").slice(0, 100), { mode: 0o600 });
    const before = (await runDoctor({ json: true })).envelope!;
    assert.equal(item(before, "membership-rw.creds")?.problem, "the NATS client cannot parse it: it has no complete NATS user JWT block", "an unparsable daemon file is a finding");
    assert.match(item(before, "membership-rw.creds")?.repair ?? "", /While its broker does not answer, `.*doctor auth --fix` mints it again under a new identity/, "its guidance names the --fix that mints it again");
    const { envelope, code } = await runDoctor({ json: true, fix: true });
    const rows = envelope!.result.repair.results;
    assert.deepEqual(rows.find((row) => row.file === "membership-rw.creds"), { file: "membership-rw.creds", ok: true, skipped: false, reminted: true, reason: "it held no key to re-sign" }, "the row says it was minted again, and why");
    assert.equal(rows.find((row) => row.file === "delivery.creds")?.reason, null, "a re-signed file carries no reason");
    const rwAfter = readFileSync(rwPath, "utf8");
    assert.notEqual(idFromCreds(rwAfter), rwId.id, "the new file has a new identity");
    assert.equal(inspectCredHealth(rwAfter).state, "healthy", "and is healthy");
    assert.equal(envelope!.result.findings, 0, "no finding remains");
    assert.equal(code, 0, "exit 0");
    writeFileSync(rwPath, rwAfter.slice(0, 100), { mode: 0o600 });
    assert.match((await runDoctor({ fix: true })).text, /membership-rw\.creds: minted again under a new identity, because it held no key to re-sign/, "the text report names the new identity");
  }

  // Refusals: no `auth` word, and an unknown space that must never read as healthy or open.
  {
    const usage = await refusal({}, []);
    assert.equal(usage.code, "USAGE_INVALID", "`doctor` without `auth` is a usage refusal");
    assert.match(usage.message, /doctor auth/, "it names doctor auth");
    const unknown = await refusal({ space: "nope" }, ["auth"]);
    assert.equal(unknown.code, "AUTH_REQUIRED", "an unknown --space refuses");
    assert.equal(unknown.remedy, 'Unknown space "nope". Run `cotal space` to check the name. For a new local space, run `cotal space create nope` in its project folder, then run `cotal up` there.');
    const unusable = await refusal({ space: "not a token" }, ["auth"]);
    assert.equal(unusable.remedy, 'Unknown space "not a token". Run `cotal space` to check the name.', "a name space create refuses is not put in a command");
    // A space registered at another root keeps its trust there: this root reads none of it, and the
    // step names the folder where the same command runs.
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
    recordMesh({ space: "remote", server: "nats://127.0.0.1:9", root: elsewhere, mode: "auth", ts: new Date().toISOString(), origin: "manual" });
    const remote = await refusal({ space: "remote" }, ["auth"]);
    assert.equal(remote.code, "AUTH_REQUIRED", "a --space registered at another root refuses here");
    assert.equal(remote.remedy, `run \`cotal doctor auth --space remote\` in the folder space remote is registered at: ${elsewhere}`, "its step names that root");

    // Legacy export records have no provisioning field. New records preserve it for both
    // same-key and fresh-key repairs without adding provisioning to legacy files.
    const exported = join(root, "exported files");
    mkdirSync(exported, { mode: 0o700 });
    const exportId = newIdentity();
    const expiredExport = await mintCreds(auth, exportId, "agent", { lifecycleUid: mintLifecycleUid(), expiresAt: now - 10 });
    const exportPath = join(exported, "alice's file.creds");
    writeFileSync(exportPath, expiredExport, { mode: 0o600 });
    recordCredentialExport(SPACE, { label: "exported", profile: "agent", path: exportPath, root, identity: exportId.id, provisioned: true });
    const oldPath = join(exported, "old.creds");
    writeFileSync(oldPath, expiredExport, { mode: 0o600 });
    recordCredentialExport(SPACE, { label: "old_export", profile: "agent", path: oldPath, root, identity: exportId.id });
    assert.equal(credentialExportStore(SPACE).list().find((entry) => entry.record.value.path === oldPath)?.record.value.provisioned, undefined, "old export records remain readable without a provisioning field");
    const exportsReport = (await runDoctor({ json: true })).envelope!;
    const repair = exportsReport.result.exported.find((entry) => entry.path === exportPath)?.repair ?? "";
    assert.match(repair, /auth mint exported --provision --identity/, "expired provisioned export repair keeps --provision");
    assert.ok(repair.includes("alice'\\''s file.creds'"), "repair shell-quotes an apostrophe in the exported path");
    assert.ok(!exportsReport.result.exported.find((entry) => entry.path === oldPath)?.repair?.includes("--provision"), "legacy records do not infer provisioning");
    const foreignAuth = await createSpaceAuth("foreign-export");
    writeFileSync(exportPath, await mintCreds(foreignAuth, exportId, "agent", { lifecycleUid: mintLifecycleUid(), expiresAt: now - 10 }), { mode: 0o600 });
    const foreignReport = (await runDoctor({ json: true })).envelope!;
    const foreignRow = foreignReport.result.exported.find((entry) => entry.path === exportPath);
    assert.equal(foreignRow?.state, "other-account", "changed-account exports ask for a fresh key");
    assert.match(foreignRow?.repair ?? "", /auth mint exported --provision/, "fresh-key repair keeps --provision too");
    writeFileSync(exportPath, expiredExport, { mode: 0o600 });
    const revokedAuth = await revokeAccountUser(auth, exportId.id, Math.floor(Date.now() / 1000));
    saveSpaceAuth(authDir(root), revokedAuth);
    const revokedReport = (await runDoctor({ json: true })).envelope!;
    const revokedRow = revokedReport.result.exported.find((entry) => entry.path === exportPath);
    assert.equal(revokedRow?.state, "revoked", "revoked exports ask for a new key rather than re-signing it");
    assert.match(revokedRow?.repair ?? "", /auth mint exported --provision/, "revoked-key repair also keeps --provision");
    saveSpaceAuth(authDir(root), auth);

    writeFileSync(exportPath, "");
    const emptyExport = await runDoctor({ json: true });
    const emptyRow = emptyExport.envelope!.result.exported.find((row) => row.path === exportPath);
    assert.equal(emptyRow?.state, "unreadable", "the empty exported file stays unreadable");
    assert.equal(emptyExport.envelope!.outcome, "ok", "the unreadable export leaves the diagnostic outcome unchanged");
    assert.equal(emptyExport.envelope!.result.findings, 0, "the unreadable export is not a managed finding");
    assert.equal(emptyExport.code, 0, "the unreadable export leaves exit 0");
    assert.match(emptyRow?.repair ?? "", /original grants cannot be determined.*Restore the complete credential file.*confirm the intended grants.*`(?:pnpm )?cotal auth mint`.*mint a replacement to a new private path/);
    assert.doesNotMatch(emptyRow?.repair ?? "", /--(?:identity|allow-subscribe|allow-publish|role)|auth mint exported/);
    const plainEmptyExport = await runDoctor({ plain: true });
    assert.equal(plainEmptyExport.code, 0, "the plain report leaves exit 0");
    assert.ok(plainEmptyExport.text.includes(`exported: ${emptyRow?.repair}`), "plain output includes the same export guidance");

    if (process.platform !== "win32") {
      const movedPath = join(exported, "moved.creds");
      const movedTarget = join(exported, "moved-real.creds");
      const movedId = newIdentity();
      writeFileSync(movedPath, await mintCreds(auth, movedId, "agent", { lifecycleUid: mintLifecycleUid(), expiresInSeconds: 3600 }), { mode: 0o600 });
      recordCredentialExport(SPACE, { label: "moved", profile: "agent", path: movedPath, root, identity: movedId.id });
      renameSync(movedPath, movedTarget);
      symlinkSync("moved-real.creds", movedPath);

      const linked = await runDoctor({ json: true });
      const row = linked.envelope!.result.exported.find((entry) => entry.path === movedPath);
      assert.equal(row?.state, "unreadable", "the protected read does not follow a symlink to a healthy export");
      assert.equal(row?.issuedAt, null, "no claims are read through the link");
      assert.match(row?.repair ?? "", /symbolic link.*Restore the original private regular file at the recorded path/);
      assert.doesNotMatch(row?.repair ?? "", /auth mint/, "a symlink does not require re-minting");
      assert.equal(linked.envelope!.result.findings, 0, "the linked export is informational");
      assert.equal(linked.code, 0, "the linked export does not change the JSON exit code");
      const linkedPlain = await runDoctor({ plain: true });
      assert.equal(linkedPlain.code, 0, "the linked export does not change the plain exit code");
      assert.ok(linkedPlain.text.includes(`moved: ${row?.repair}`), "plain output includes the same guidance");

      unlinkSync(movedPath);
      renameSync(movedTarget, movedPath);
      const restored = (await runDoctor({ json: true })).envelope!.result.exported.find((entry) => entry.path === movedPath);
      assert.equal(restored?.state, "healthy", "restoring the original file resolves the diagnostic");
      assert.equal(restored?.repair, null, "a restored export needs no repair");
    }

    if (process.getuid && process.getuid() !== 0) {
      const privatePath = join(exported, "owner's unreadable file.creds");
      const privateId = newIdentity();
      const creds = await mintCreds(auth, privateId, "agent", { lifecycleUid: mintLifecycleUid(), expiresInSeconds: 3600 });
      writeFileSync(privatePath, creds, { mode: 0o600 });
      recordCredentialExport(SPACE, { label: "owner_unreadable", profile: "agent", path: privatePath, root, identity: privateId.id });
      chmodSync(privatePath, 0o000);

      const unreadable = await runDoctor({ json: true });
      const row = unreadable.envelope!.result.exported.find((entry) => entry.path === privatePath);
      const repair = `The export's owner lacks read permission. Run \`chmod 600 '${exported}/owner'\\''s unreadable file.creds'\`.`;
      assert.equal(row?.state, "unreadable", "an export without owner read permission stays unreadable");
      assert.equal(row?.issuedAt, null, "no claims are read from the export");
      assert.equal(row?.repair, repair, "the repair quotes the path and restores permission without replacing the credential");
      assert.equal(unreadable.envelope!.result.findings, 0, "the unreadable export is informational");
      assert.equal(unreadable.code, 0, "the unreadable export does not change the JSON exit code");
      const plain = await runDoctor({ plain: true });
      assert.equal(plain.code, 0, "the unreadable export does not change the plain exit code");
      assert.ok(plain.text.includes(`owner_unreadable: ${repair}`), "plain output includes the same permission guidance");

      chmodSync(privatePath, 0o600);
      const restored = (await runDoctor({ json: true })).envelope!.result.exported.find((entry) => entry.path === privatePath);
      assert.equal(restored?.state, "healthy", "restoring the mode resolves the diagnostic");
      assert.equal(restored?.repair, null, "a readable private export needs no repair");
      assert.equal(readFileSync(privatePath, "utf8"), creds, "the credential contents are unchanged");
    }

    // #7542: if a root is registered as open even while leftover .cotal/auth files exist on disk,
    // doctor auth (with or without --fix) reports the open-space no-op rather than Mode: static or CONFLICT.
    writeFileSync(join(material, "membership-rw.creds"), "", { mode: 0o600 });
    recordMesh({ space: SPACE, server: "nats://127.0.0.1:8", root, mode: "open", ts: new Date().toISOString(), origin: "up" });
    const openCases: Record<string, string | boolean>[] = [{ json: true }, { json: true, fix: true }];
    for (const values of openCases) {
      const openRun = await runDoctor(values);
      const openEnv = openRun.envelope as unknown as { outcome: string; result: { space: string | null; credentialScope?: string; mode?: string } };
      assert.equal(openEnv.outcome, "no-op", "doctor auth on a root registered as open is a no-op");
      assert.equal(openEnv.result.space, SPACE, "names the open space");
      assert.equal(openEnv.result.credentialScope, "open-space", "reports open-space scope rather than static mode");
      assert.ok(openRun.code === undefined || openRun.code === 0, "exits 0");
    }
    const openText = await runDoctor({});
    assert.match(openText.text, /Mode:\s+open, as registered/, "text report shows open, as registered");
    rmSync(elsewhere, { recursive: true });
    for (const fix of [false, true]) {
      const missing = await refusal({ space: "remote", fix }, ["auth"]);
      assert.equal(missing.code, "AUTH_REQUIRED", "a deleted registered root still refuses local credential diagnosis");
      assert.equal(missing.remedy, `the folder space remote is recorded at, ${elsewhere}, no longer exists; if it was moved or renamed, move it back and run \`cotal doctor auth --space remote${fix ? " --fix" : ""}\` there; otherwise forget the space with \`cotal space forget remote\``, "its step names the missing folder, restoring it or forgetting the space");
    }
  }
} finally {
  process.chdir(startCwd);
  if (priorHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = priorHome;
  rmSync(root, { recursive: true, force: true });
}

console.log("doctor-auth smoke: OK - credential health is pinned, the diagnosis finds the expired, unbounded standing and unbounded agent creds and the missing evictor, --fix re-signs the daemon files offline for their own nkeys, mints an unparsable one again and leaves the agent finding, and bad selections refuse");
emitSentinel({ passed: cells(), failed: 0 });
