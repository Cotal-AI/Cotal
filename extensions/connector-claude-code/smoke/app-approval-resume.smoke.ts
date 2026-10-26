/** A pending native approval is finished by the host, not by the person reminding the model. The
 * host replays the saved request through the real CLI subprocess boundary while the person decides,
 * then tells only the bound native session what they decided. These cells drive the shipped host
 * with a scripted CLI; the authority transport itself is proven in the CLI's own suites. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalRequired } from "@cotal-ai/connector-core";
import { createAppHost, type ApprovalNotice } from "../src/app-host.js";

type Reply = Record<string, unknown>;
const ID = "b".repeat(26);
const approval = (expiresAt = "2099-01-01T00:00:00.000Z") => ({ id: ID, url: `https://authority.example/approve/${ID}`, expiresAt });
const pending = (expiresAt?: string): Reply => ({ ok: false, pending: true, requestId: "request-approval-012345678901234567", approval: approval(expiresAt), proposed: null });
const issued: Reply = { ok: true, env: { COTAL_NAME: "approval_probe" }, retire: { dir: "/identities/approval_probe" } };
const denied: Reply = { ok: false, refused: "denied", error: "the person denied this connection; no identity was issued" };
const expired: Reply = { ok: false, refused: "expired", error: "the approval expired before this connection was issued; no identity was issued. Connect again to ask again" };
const crash: Reply = { crash: true };

const SESSION = "native-approval-session";
const PROVISION = ["app-identity", "provision", "--require-approval", "--name", "approval_probe", "--session", SESSION, "--events"];
const WATCH = { pollMs: 20, graceMs: 40 };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(what: string, predicate: () => boolean, ms = 3_000): Promise<void> {
  for (const started = Date.now(); !predicate() && Date.now() - started < ms;) await tick();
  assert.ok(predicate(), what);
}

/** A CLI that answers each provision from `plan` in order, repeating its last entry, and confirms
 *  every retirement. `crash` prints no result at all, which is what a CLI that failed looks like. */
function scenario(plan: Reply[]) {
  const root = mkdtempSync(join(tmpdir(), "cotal-app-approval-resume-"));
  const log = join(root, "calls.jsonl");
  writeFileSync(join(root, "plan.json"), JSON.stringify(plan));
  const cli = join(root, "identity-fixture.cjs");
  writeFileSync(cli, `
const fs = require('node:fs');
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
fs.appendFileSync(root + '/calls.jsonl', JSON.stringify(args) + '\\n');
if (args[1] === 'retire') { console.log(JSON.stringify({ ok: true })); return; }
const plan = JSON.parse(fs.readFileSync(root + '/plan.json', 'utf8'));
const n = fs.existsSync(root + '/count') ? Number(fs.readFileSync(root + '/count', 'utf8')) : 0;
fs.writeFileSync(root + '/count', String(n + 1));
const reply = plan[Math.min(n, plan.length - 1)];
if (reply.crash) { process.exitCode = 1; return; }
console.log(JSON.stringify(reply));
if (!reply.ok) process.exitCode = 1;
`);
  const notices: Array<{ session: string; notice: ApprovalNotice }> = [];
  const host = createAppHost({
    cotal: () => [process.execPath, cli], cwd: root, env: {}, watch: WATCH,
    notify: (session, notice) => { notices.push({ session, notice }); return true; },
  });
  const calls = (): string[][] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : [];
  const provisions = () => calls().filter((c) => c[1] === "provision");
  const retirements = () => calls().filter((c) => c[1] === "retire");
  const bind = () => host.nativeEvent({ session_id: SESSION, hook_event_name: "SessionStart", transcript_path: join(root, `${SESSION}.jsonl`) });
  const end = () => host.nativeEvent({ session_id: SESSION, hook_event_name: "SessionEnd" });
  const expectPending = () => assert.rejects(host.open("local", "approval_probe", SESSION), (error: unknown) => error instanceof ApprovalRequired);
  const close = async () => { await host.closeAll().catch(() => {}); rmSync(root, { recursive: true, force: true }); };
  return { host, notices, calls, provisions, retirements, bind, end, expectPending, close };
}

const failures: string[] = [];
const cell = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures.push(`${name}: ${(e as Error).message}`); console.log(`  ✗ ${name}: ${(e as Error).message}`); }
};

await cell("an approved request is finished by the host and only the bound session is told, once", async () => {
  const s = scenario([pending(), pending(), issued]);
  try {
    await s.bind();
    await s.expectPending();
    assert.equal(s.notices.length, 0, "a pending answer is not a decision");
    await until("the host told the session its request was approved", () => s.notices.length === 1);
    assert.deepEqual(s.notices[0], { session: SESSION, notice: { name: "approval_probe", status: "approved", id: ID } });
    const replayed = s.provisions();
    assert.equal(replayed.length, 3, "the host replayed the saved request until the authority decided");
    for (const call of replayed) assert.deepEqual(call, PROVISION, "every replay is the same request: same name, session and proposal");
    await new Promise((resolve) => setTimeout(resolve, WATCH.pollMs * 4));
    assert.equal(s.provisions().length, 3, "an issued identity is not replayed again");
    assert.equal(s.notices.length, 1, "the decision is told once");
    assert.equal(await s.host.find("local", "not-a-connection"), undefined, "the host opened no connection on the model's behalf");
    assert.equal(s.retirements().length, 0, "the issued identity is kept for the conversation's own cotal_connect");
  } finally { await s.close(); }
});

await cell("a resume with another conversation's approval_id is refused before any CLI call", async () => {
  const s = scenario([pending(), issued]);
  try {
    await s.bind();
    await s.expectPending();
    await until("approved", () => s.notices.length === 1);
    const before = s.calls().length;
    await assert.rejects(s.host.open("local", "approval_probe", SESSION, undefined, "c".repeat(26)), /approval_id/);
    assert.equal(s.calls().length, before, "a mismatched approval_id reaches no CLI");
  } finally { await s.close(); }
});

await cell("an issued identity nobody claimed is retired when its native session ends", async () => {
  const s = scenario([pending(), issued]);
  try {
    await s.bind();
    await s.expectPending();
    await until("approved", () => s.notices.length === 1);
    await s.end();
    assert.deepEqual(s.retirements(), [["app-identity", "retire", "--dir", "/identities/approval_probe"]], "the exact issued identity was retired");
    await s.host.closeAll();
  } finally { await s.close(); }
});

await cell("a denial tells the session and stops the replay", async () => {
  const s = scenario([pending(), denied]);
  try {
    await s.bind();
    await s.expectPending();
    await until("denied", () => s.notices.length === 1);
    assert.equal(s.notices[0]!.notice.status, "denied");
    await new Promise((resolve) => setTimeout(resolve, WATCH.pollMs * 4));
    assert.equal(s.provisions().length, 2, "a decided request is not replayed");
    assert.equal(s.retirements().length, 0, "nothing was issued, so nothing is retired");
  } finally { await s.close(); }
});

await cell("an expiry tells the session and stops the replay", async () => {
  const s = scenario([pending(), expired]);
  try {
    await s.bind();
    await s.expectPending();
    await until("expired", () => s.notices.length === 1);
    assert.equal(s.notices[0]!.notice.status, "expired");
    await new Promise((resolve) => setTimeout(resolve, WATCH.pollMs * 4));
    assert.equal(s.provisions().length, 2);
  } finally { await s.close(); }
});

await cell("a CLI that gave no result is replayed again, and a second cotal_connect keeps one watcher", async () => {
  const s = scenario([pending(), crash, pending(), pending(), issued]);
  try {
    await s.bind();
    await s.expectPending();
    await until("the host kept replaying past a failed CLI run", () => s.provisions().length >= 3);
    await s.expectPending();
    await until("approved", () => s.notices.length === 1);
    const settled = s.provisions().length;
    assert.ok(settled >= 5, `the second cotal_connect replayed once and the single watcher went on (${settled} provisions)`);
    await new Promise((resolve) => setTimeout(resolve, WATCH.pollMs * 4));
    assert.equal(s.notices.length, 1, "one request, one decision, one notice");
    assert.equal(s.provisions().length, settled, "no second watcher keeps replaying a decided request");
  } finally { await s.close(); }
});

await cell("the session ending while pending stops the replay without a notice", async () => {
  const s = scenario([pending()]);
  try {
    await s.bind();
    await s.expectPending();
    await until("at least one replay", () => s.provisions().length >= 2);
    await s.end();
    const after = s.provisions().length;
    await new Promise((resolve) => setTimeout(resolve, WATCH.pollMs * 4));
    assert.equal(s.provisions().length, after, "no replay after SessionEnd");
    assert.equal(s.notices.length, 0, "a closed session hears nothing");
    assert.equal(s.retirements().length, 0, "a pending request has nothing to retire here; the CLI retires it on the next provision");
    await s.host.closeAll();
  } finally { await s.close(); }
});

await cell("a request still pending after its expiry and grace stops being replayed", async () => {
  const s = scenario([pending(new Date(Date.now() + 30).toISOString())]);
  try {
    await s.bind();
    await s.expectPending();
    await until("at least one replay before expiry", () => s.provisions().length >= 2);
    await new Promise((resolve) => setTimeout(resolve, WATCH.pollMs * 8));
    const settled = s.provisions().length;
    await new Promise((resolve) => setTimeout(resolve, WATCH.pollMs * 4));
    assert.equal(s.provisions().length, settled, "no replay past expiry plus grace");
    assert.equal(s.notices.length, 0, "no decision was reported that the authority did not make");
  } finally { await s.close(); }
});

await cell("a session that never bound its lifecycle gets no watcher", async () => {
  const s = scenario([pending(), issued]);
  try {
    await assert.rejects(s.host.open("local", "approval_probe"), (error: unknown) => error instanceof ApprovalRequired);
    await new Promise((resolve) => setTimeout(resolve, WATCH.pollMs * 4));
    assert.equal(s.provisions().length, 1, "without a native session there is nobody to wake, so nothing is replayed");
    assert.equal(s.notices.length, 0);
  } finally { await s.close(); }
});

await cell("changing a pending name stops the old watcher instead of replaying the old request", async () => {
  const s = scenario([pending()]);
  try {
    await s.bind();
    await s.expectPending();
    await assert.rejects(s.host.open("local", "replacement", SESSION), (error: unknown) => error instanceof ApprovalRequired);
    const after = s.provisions().length;
    await until("replacement replayed", () => s.provisions().length > after);
    for (const call of s.provisions().slice(after)) assert.equal(call[call.indexOf("--name") + 1], "replacement");
    assert.equal(s.notices.length, 0);
  } finally { await s.close(); }
});

await cell("an approval handle cannot be used to change the saved request", async () => {
  const s = scenario([pending()]);
  try {
    await s.bind();
    await s.expectPending();
    const before = s.provisions().length;
    await assert.rejects(s.host.open("local", "replacement", SESSION, undefined, ID), /unchanged request/);
    assert.equal(s.provisions().length, before);
  } finally { await s.close(); }
});

await cell("an approved but unclaimed request is retired before asking for a different name", async () => {
  const replacement = { ...pending(), approval: { ...approval(), id: "c".repeat(26), url: `https://authority.example/approve/${"c".repeat(26)}` } };
  const s = scenario([pending(), issued, replacement]);
  try {
    await s.bind();
    await s.expectPending();
    await until("old approval observed", () => s.notices.length === 1);
    await assert.rejects(s.host.open("local", "replacement", SESSION), (error: unknown) => error instanceof ApprovalRequired);
    const calls = s.calls();
    const retired = calls.findIndex((call) => call[1] === "retire");
    const asked = calls.findIndex((call) => call.includes("replacement"));
    assert.ok(retired >= 0 && retired < asked, "retirement must precede the new request");
    assert.deepEqual(s.retirements(), [["app-identity", "retire", "--dir", "/identities/approval_probe"]]);
  } finally { await s.close(); }
});

assert.deepEqual(failures, [], `AGENT-305 approval resume cells red=${failures.length}/12:\n${failures.join("\n")}`);
console.log("APP APPROVAL RESUME TESTS PASSED (12/12)");
