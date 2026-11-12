/** Pending personal connections cross the real CLI subprocess boundary. The scripted authority
 *  outcomes here test polling and native notice routing, not hosted approval or Codex inference. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalRequired } from "@cotal-ai/connector-core";
import { createCodexPersonalHost, type ApprovalNotice } from "../src/personal-host.js";
import { approvalNotice, NOTICE } from "../src/personal.js";

const ID = "b".repeat(26);
const THREAD = "personal-approval-thread";
const WATCH = { pollMs: 20, graceMs: 40 };
const pending = { ok: false, pending: true, requestId: "request-approval-012345678901234567", proposed: null,
  approval: { id: ID, url: `https://authority.example/approve/${ID}`, expiresAt: "2099-01-01T00:00:00.000Z" } };
type Reply = Record<string, unknown>;
async function until(predicate: () => boolean): Promise<void> {
  for (const start = Date.now(); !predicate() && Date.now() - start < 3_000;) await new Promise((r) => setTimeout(r, 5));
  assert(predicate(), "the host reported a decision");
}
function scenario(plan: Reply[]) {
  const root = mkdtempSync(join(tmpdir(), "cotal-codex-approval-"));
  const cli = join(root, "identity-fixture.cjs"), log = join(root, "calls.jsonl");
  writeFileSync(join(root, "plan.json"), JSON.stringify(plan));
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
  const notices: Array<{ thread: string; notice: ApprovalNotice }> = [];
  const host = createCodexPersonalHost({
    cotal: () => [process.execPath, cli], env: {}, watch: WATCH,
    thread: async (id) => ({ id, cwd: root }),
    notify: (thread, notice) => { notices.push({ thread, notice }); },
  });
  host.account(undefined, { threadId: THREAD });
  const calls = (): string[][] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s)) : [];
  const provisions = () => calls().filter((c) => c[1] === "provision");
  const open = (name = "probe", id?: string) => host.open(THREAD, name, undefined, undefined, id);
  const close = async () => { await host.closeAll(); rmSync(root, { recursive: true, force: true }); };
  return { host, notices, calls, provisions, open, close };
}
let checks = 0;
for (const reply of [
  { ok: false, refused: "refused", error: "The per-person limit is 50. Compare plans: https://authority.example/pricing" },
  { ok: false, retryable: false, error: "conversation identity creation answered HTTP 409; its original request was retained" },
]) {
  const s = scenario([pending, reply, pending]);
  try {
    await assert.rejects(s.open(), ApprovalRequired);
    await until(() => s.notices.length === 1);
    assert.deepEqual(s.notices[0], { thread: THREAD, notice: { name: "probe", status: "refused", id: ID } });
    await new Promise((r) => setTimeout(r, WATCH.pollMs * 4));
    assert.equal(s.provisions().length, 2, "permanent failures are not silently polled");
    await assert.rejects(s.open("probe", ID), (e: unknown) => e instanceof Error && e.message === reply.error);
    await assert.rejects(s.open("probe", "c".repeat(26)), /approval_id/);
    await assert.rejects(s.open("other", ID), /approval_id/);
    assert.equal(s.provisions().length, 2, "reading or mismatching the cached refusal makes no request");
    assert(s.calls().every((c) => c[1] !== "retire"), "unissued requests have no identity to retire");
    const notice = approvalNotice(s.notices[0]!.notice);
    assert(notice.startsWith(NOTICE));
    assert(notice.includes("Read the saved refusal"));
    assert(notice.includes("do not retry the connection automatically"));
    assert(!notice.includes(reply.error), "native ingress carries no server text");
    await assert.rejects(s.open(), ApprovalRequired);
    assert.equal(s.provisions().length, 3, "an explicit fresh connect can ask again");
    checks++;
    console.log("  ✓ policy refusal stops replay, reaches only the bound thread, and has a read-only reason handle");
  } finally { await s.close(); }
}
for (const status of ["denied", "expired"] as const) {
  const s = scenario([pending, { ok: false, refused: status, error: "nothing issued" }]);
  try {
    await assert.rejects(s.open(), ApprovalRequired);
    await until(() => s.notices.length === 1);
    assert.equal(s.notices[0]!.notice.status, status);
    await new Promise((r) => setTimeout(r, WATCH.pollMs * 4));
    assert.equal(s.provisions().length, 2);
    checks++;
    console.log(`  ✓ ${status} stays distinct from a policy refusal and is not replayed`);
  } finally { await s.close(); }
}
const transient = scenario([pending, { ok: false, retryable: true, error: "temporary" }, { crash: true }, { ok: false, refused: "denied" }]);
try {
  await assert.rejects(transient.open(), ApprovalRequired);
  await until(() => transient.notices.length === 1);
  assert.equal(transient.notices[0]!.notice.status, "denied");
  assert.equal(transient.provisions().length, 4, "transient and missing CLI answers do not end polling");
  checks++;
  console.log("  ✓ transient errors preserve the bounded watcher");
} finally { await transient.close(); }
const direct = scenario([pending, { ok: false, retryable: false, error: "permanent request failure" }]);
try {
  await assert.rejects(direct.open(), ApprovalRequired);
  await assert.rejects(direct.open(), /permanent request failure/);
  await new Promise((r) => setTimeout(r, WATCH.pollMs * 4));
  assert.equal(direct.provisions().length, 2);
  assert.equal(direct.notices.length, 0, "the direct tool result already reported the error");
  checks++;
  console.log("  ✓ a direct permanent error stops an existing watcher");
} finally { await direct.close(); }
assert.equal(checks, 6);
console.log(`personal-approval-resume: ${checks} checks passed`);
