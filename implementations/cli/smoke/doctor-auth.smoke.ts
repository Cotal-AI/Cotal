/**
 * `cotal doctor auth` smoke (D5 slice 6) — broker-free. Two layers:
 *
 *  1. `inspectCredHealth` (core) is pinned pure: healthy / near-expiry (past 75% of iat→exp) /
 *     expired / unbounded / unreadable, with an injected clock.
 *  2. The doctor command runs against a STAGED root in the per-space layout (real crypto:
 *     createSpaceAuth + mintCreds) and is read through its JSON envelope. An expired delivery cred,
 *     an unbounded standing membership-rw cred and an unbounded agent cred are findings; a healthy
 *     $SYS observer and a missing connection-evictor are not, and a user-auth sentinel file is not
 *     listed. `--fix` re-signs the two daemon files for their EXISTING nkeys (the identity pin) and,
 *     with no registered mesh, records an offline repair rather than the lease. It never re-signs an
 *     agent cred, so that finding stays and the run is partial. With the agent file gone the root has
 *     no findings. `doctor` without `auth`, and an unknown `--space`, refuse.
 *
 * Run: pnpm smoke:doctor-auth
 */
import { strict as nodeAssert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSpaceAuth,
  idFromCreds,
  inspectCredHealth,
  mintCreds,
  mintLifecycleUid,
  mintMembershipObserverCreds,
  newIdentity,
} from "@cotal-ai/core";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { agentCredsDir, authDir, isCommandFailure, readRenewalRecord, saveSpaceAuth, spaceMaterialDir, type CommandFailure } from "@cotal-ai/workspace";
import { doctor } from "../src/commands/doctor.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

// ── 1. inspectCredHealth: pure-state pins with an injected clock ─────────────────────────────────
const SPACE = "doctor-smoke";
const auth = await createSpaceAuth(SPACE);
const sysObserver = await mintMembershipObserverCreds(auth, newIdentity()); // while the $SYS seed is in memory
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
// $SYS observer: healthy (bounded 30d at mint). connection-evictor deliberately MISSING (a note).
const dlvId = newIdentity();
const rwId = newIdentity();
writeFileSync(join(material, "delivery.creds"), await mintCreds(auth, dlvId, "delivery", { expiresAt: now - 10 }), { mode: 0o600 });
writeFileSync(join(material, "membership-rw.creds"), await mintCreds(auth, rwId, "agent", { lifecycleUid: mintLifecycleUid() }), { mode: 0o600 });
writeFileSync(join(material, "membership-observer.creds"), sysObserver, { mode: 0o600 });
const agents = agentCredsDir(root, SPACE);
mkdirSync(agents, { recursive: true, mode: 0o700 });
// A static agent cred with no expiry, what `auth mint` writes without an expiry flag: a finding.
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
    repair: { attempted: boolean; authority: string | null; results: { file: string; ok: boolean }[] };
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
    assert.equal(item(report, "connection-evictor.creds")?.state, "not-provisioned-here", "the missing connection-evictor is a note");
    assert.equal(item(report, "connection-evictor.creds")?.problem, null, "and not a finding");
    assert.equal(item(report, "alice.creds")?.state, "unbounded", "fixture: alice.creds carries no expiry claim");
    assert.match(item(report, "alice.creds")?.problem ?? "", /^unbounded credential \(no expiry claim\)/, "the unbounded static agent cred is a finding");
    assert.ok(!report.result.items.some((row) => row.label.includes("sentinel")), "the user-auth sentinel is not listed as a static agent cred");
    assert.equal(report.result.findings, 3, "three findings");
    assert.equal(report.result.repair.attempted, false, "plain diagnosis repairs nothing");
    assert.equal(report.outcome, "failed", "the diagnosis ends failed");
    assert.equal(report.error?.code, "OPERATION_FAILED", "with OPERATION_FAILED");
    assert.equal(code, 5, "exit 5");
  }

  // --fix: the daemon files are re-signed offline for their own nkeys; the agent finding stays.
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
  // the NATS client cannot parse is a finding although its claims are legible.
  {
    const shared = join(agents, "bob.creds");
    const crlf = join(agents, "dave.creds");
    writeFileSync(shared, bounded, { mode: 0o600 });
    chmodSync(shared, 0o644);
    writeFileSync(crlf, bounded.replace(/\n/g, "\r\n"), { mode: 0o600 });
    const { envelope, code } = await runDoctor({ json: true });
    if (process.platform !== "win32") {
      assert.equal(item(envelope!, "bob.creds")?.problem, "the credential file is not private to you (mode 0644)", "a 0644 credential is named by its mode, not as a parse failure");
      assert.equal(item(envelope!, "bob.creds")?.repair, `chmod 600 ${shared}`, "its repair is the chmod that makes it private");
    }
    assert.equal(item(envelope!, "dave.creds")?.problem, "the NATS client cannot parse it: it has Windows (CRLF) line endings", "a CRLF credential is a finding, as --creds refuses it");
    assert.match(item(envelope!, "dave.creds")?.repair ?? "", /^save it with LF line endings/, "its repair says how to fix the line endings");
    assert.equal(code, 5, "the findings exit 5");
    rmSync(shared);
    rmSync(crlf);
  }

  // Refusals: no `auth` word, and an unknown space that must never read as healthy or open.
  {
    const usage = await refusal({}, []);
    assert.equal(usage.code, "USAGE_INVALID", "`doctor` without `auth` is a usage refusal");
    assert.match(usage.message, /doctor auth/, "it names doctor auth");
    const unknown = await refusal({ space: "nope" }, ["auth"]);
    assert.equal(unknown.code, "AUTH_REQUIRED", "an unknown --space refuses");
  }
} finally {
  process.chdir(startCwd);
  if (priorHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = priorHome;
  rmSync(root, { recursive: true, force: true });
}

console.log("doctor-auth smoke: OK - credential health is pinned, the diagnosis finds the expired, unbounded standing and unbounded agent creds, --fix re-signs the daemon files offline for their own nkeys and leaves the agent finding, and bad selections refuse");
emitSentinel({ passed: cells(), failed: 0 });
