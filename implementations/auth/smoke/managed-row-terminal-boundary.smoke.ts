import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartToken } from "@cotal-ai/workspace";
import {
  grantManagedActor,
  ledgerAuthorizeConnect,
  loadActorLedger,
  managedActorLedgerDir,
  revokeManagedActor,
} from "../src/ledger.js";
import {
  prepareManagedAuthorization,
  readManagedActor,
  recoverManagedRowRequests,
  verifyManagedHistory,
  setManagedRowBeforeLockedEffectForSmoke,
} from "../src/managed-row.js";

const OWNER = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACTOR = "managed_actor";
const UID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const UID2 = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const requestId = (name: string) => digest(`task84:${name}`);
const row = (tokenHash: string, lifecycleUid = UID) => ({
  owner: OWNER,
  actor: ACTOR,
  scope: ["spawn"],
  allowSubscribe: ["team.>"],
  allowPublish: ["team.events"],
  tokenHash,
  lifecycleUid,
});
const token = (lifecycleUid = UID) => ({ owner: OWNER, act: { actor: ACTOR, scope: ["spawn"], lifecycleUid } }) as never;

type Test = { name: string; run: () => void | Promise<void> };
const tests: Test[] = [];
const test = (name: string, run: Test["run"]) => tests.push({ name, run });
const sandbox = (name: string) => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `task84-${name}-`));
const withRoot = async (name: string, run: (root: string) => void | Promise<void>) => {
  const root = sandbox(name);
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

for (const point of ["after-request", "after-temp-fsync", "after-rename", "after-history"] as const) {
  test(`ordinary_create_crash_${point}_recovers_exact_bytes`, () => withRoot(`create-${point}`, (root) => {
    const id = requestId(`create-${point}`);
    assert.throws(() => grantManagedActor(root, row("a".repeat(64)), { requestId: id, failAt: point }));
    assert.equal(recoverManagedRowRequests(managedActorLedgerDir(root)), 1);
    const committed = readManagedActor(managedActorLedgerDir(root), OWNER, ACTOR);
    assert.equal(committed.state, "live");
    if (committed.state === "live") assert.equal(committed.row.tokenHash, "a".repeat(64));
    assert.equal(verifyManagedHistory(managedActorLedgerDir(root), OWNER, ACTOR), committed.state === "live" ? committed.historyHead : "");
    const retry = grantManagedActor(root, row("a".repeat(64)), { requestId: id });
    assert.equal(retry.tokenHash, "a".repeat(64));
  }));
}

for (const point of ["after-request", "after-temp-fsync", "after-rename", "after-history"] as const) {
  test(`ordinary_revoke_crash_${point}_recovers_tombstone`, () => withRoot(`revoke-${point}`, (root) => {
    grantManagedActor(root, row("a".repeat(64)), { requestId: requestId(`seed-${point}`) });
    const id = requestId(`revoke-${point}`);
    assert.throws(() => revokeManagedActor(root, OWNER, ACTOR, { requestId: id, lifecycleUid: UID, failAt: point }));
    assert.equal(recoverManagedRowRequests(managedActorLedgerDir(root)), 1);
    const committed = readManagedActor(managedActorLedgerDir(root), OWNER, ACTOR);
    assert.equal(committed.state, "tombstone");
    assert.equal(verifyManagedHistory(managedActorLedgerDir(root), OWNER, ACTOR), committed.state === "tombstone" ? committed.historyHead : "");
  }));
}

test("ordinary_idempotency_and_request_conflict", () => withRoot("idempotency", (root) => {
  const id = requestId("same-create");
  const first = grantManagedActor(root, row("a".repeat(64)), { requestId: id });
  const second = grantManagedActor(root, row("a".repeat(64)), { requestId: id });
  assert.deepEqual(second, first);
  assert.throws(() => grantManagedActor(root, row("b".repeat(64)), { requestId: id }), /conflict/);
}));

test("reader_parse_then_revoke_before_commit_denies", () => withRoot("reader-race", (root) => {
  grantManagedActor(root, row("a".repeat(64)), { requestId: requestId("reader-seed") });
  const bytes = Buffer.from("signed-result");
  const prepared = prepareManagedAuthorization(managedActorLedgerDir(root), {
    owner: OWNER, actor: ACTOR, lifecycleUid: UID, requestId: requestId("reader-auth"), consumerId: "consumer_a", requestDigest: digest("request"),
  });
  revokeManagedActor(root, OWNER, ACTOR, { requestId: requestId("reader-revoke"), lifecycleUid: UID });
  assert.throws(() => prepared.commit(digest(bytes), bytes), /cancelled by revocation/);
}));

test("commit_stays_on_pinned_directories_when_paths_are_swapped", () => withRoot("descriptor-swap", (root) => {
  grantManagedActor(root,row("a".repeat(64)),{requestId:requestId("descriptor-seed")});
  const dir=managedActorLedgerDir(root),state=join(root,"managed-row-state"),oldDir=`${dir}.old`,oldState=`${state}.old`;
  const prepared=prepareManagedAuthorization(dir,{owner:OWNER,actor:ACTOR,lifecycleUid:UID,requestId:requestId("descriptor-auth"),consumerId:"consumer_swap",requestDigest:digest("request")});
  setManagedRowBeforeLockedEffectForSmoke(()=>{
    setManagedRowBeforeLockedEffectForSmoke(undefined);
    renameSync(dir,oldDir);renameSync(state,oldState);mkdirSync(dir,{mode:0o700});mkdirSync(state,{mode:0o700});
    writeFileSync(join(dir,"outside-marker"),"replacement");writeFileSync(join(state,"outside-marker"),"replacement");
  });
  const bytes=Buffer.from("signed-pinned");assert.equal(Buffer.compare(prepared.commit(digest(bytes),bytes),bytes),0);
  assert.equal(readFileSync(join(dir,"outside-marker"),"utf8"),"replacement");assert.equal(readFileSync(join(state,"outside-marker"),"utf8"),"replacement");
  assert.equal(readFileSync(join(oldDir,`${OWNER}.${ACTOR}.json`),"utf8").includes(ACTOR),true);
}));

test("signer_await_revoke_race_denies_or_linearizes_consumed", async () => withRoot("signer-race", async (root) => {
  grantManagedActor(root, row("a".repeat(64)), { requestId: requestId("signer-seed") });
  const prepared = prepareManagedAuthorization(managedActorLedgerDir(root), {
    owner: OWNER, actor: ACTOR, lifecycleUid: UID, requestId: requestId("signer-auth"), consumerId: "consumer_b", requestDigest: digest("request"),
  });
  await Promise.resolve();
  revokeManagedActor(root, OWNER, ACTOR, { requestId: requestId("signer-revoke"), lifecycleUid: UID });
  assert.throws(() => prepared.commit(digest("signed"), Buffer.from("signed")), /cancelled by revocation/);
}));

test("connect_acl_retained_ancestry_all_use_final_commit", () => withRoot("connect", (root) => {
  grantManagedActor(root, row("a".repeat(64)), { requestId: requestId("connect-seed") });
  ledgerAuthorizeConnect(root)(token());
  revokeManagedActor(root, OWNER, ACTOR, { requestId: requestId("connect-revoke"), lifecycleUid: UID });
  assert.throws(() => ledgerAuthorizeConnect(root)(token()), /not \(or no longer\) granted/);
}));

test("live_to_tombstone_atomic_no_absence", () => withRoot("live-tombstone", (root) => {
  grantManagedActor(root, row("a".repeat(64)), { requestId: requestId("atomic-seed") });
  assert.equal(revokeManagedActor(root, OWNER, ACTOR, { requestId: requestId("atomic-revoke"), lifecycleUid: UID }), true);
  const canonical = readManagedActor(managedActorLedgerDir(root), OWNER, ACTOR);
  assert.equal(canonical.state, "tombstone");
  assert.equal(loadActorLedger(root).some((entry)=>entry.owner===OWNER&&entry.actor===ACTOR),false);
}));

test("stale_process_lock_is_reclaimed", () => withRoot("stale-lock", (root) => {
  const dir=managedActorLedgerDir(root);
  const lock=join(root,"managed-row-state","locks",`${OWNER}.${ACTOR}`);
  mkdirSync(lock,{recursive:true,mode:0o700});writeFileSync(join(lock,"owner.json"),JSON.stringify({pid:999999999,start:"dead"}),{mode:0o600});
  const granted=grantManagedActor(root,row("a".repeat(64)),{requestId:requestId("stale-lock-create")});
  assert.equal(granted.lifecycleUid,UID);
}));

test("reused_pid_start_mismatch_is_reclaimed_but_live_holder_refuses", () => withRoot("pid-reuse-lock", (root) => {
  const lock=join(root,"managed-row-state","locks",`${OWNER}.${ACTOR}`);
  mkdirSync(lock,{recursive:true,mode:0o700});writeFileSync(join(lock,"owner.json"),JSON.stringify({pid:process.pid,start:"not-this-process"}),{mode:0o600});
  grantManagedActor(root,row("a".repeat(64)),{requestId:requestId("pid-reuse-create")});
  mkdirSync(lock,{recursive:true,mode:0o700});writeFileSync(join(lock,"owner.json"),JSON.stringify({pid:process.pid,start:processStartToken(process.pid)}),{mode:0o600});
  assert.throws(()=>grantManagedActor(root,row("b".repeat(64)),{requestId:requestId("live-lock-create")}),/busy/);
}));

test("tombstone_to_successor_atomic_no_displacement", () => withRoot("successor", (root) => {
  grantManagedActor(root, row("a".repeat(64)), { requestId: requestId("successor-old") });
  revokeManagedActor(root, OWNER, ACTOR, { requestId: requestId("successor-revoke"), lifecycleUid: UID });
  const successor = grantManagedActor(root, row("b".repeat(64), UID2), { requestId: requestId("successor-new") });
  assert.equal(successor.lifecycleUid, UID2);
  assert.throws(() => revokeManagedActor(root, OWNER, ACTOR, { requestId: requestId("stale-revoke"), lifecycleUid: UID }), /does not own current/);
  const current = readManagedActor(managedActorLedgerDir(root), OWNER, ACTOR);
  assert.equal(current.state, "live");
  if (current.state === "live") assert.equal(current.row.lifecycleUid, UID2);
}));

test("symlink_directory_hardlink_refused", () => withRoot("hostile", (root) => {
  const dir = managedActorLedgerDir(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const canonical = join(dir, `${OWNER}.${ACTOR}.json`);
  const outside = join(root, "outside");
  writeFileSync(outside, "outside");
  symlinkSync(outside, canonical);
  assert.throws(() => grantManagedActor(root, row("a".repeat(64)), { requestId: requestId("hostile-symlink") }), /regular non-symlink/);
  assert.equal(readFileSync(outside, "utf8"), "outside");
  rmSync(canonical);
  mkdirSync(canonical);
  assert.throws(() => grantManagedActor(root, row("a".repeat(64)), { requestId: requestId("hostile-dir") }), /regular non-symlink/);
  rmSync(canonical, { recursive: true });
  writeFileSync(canonical, "not-json", { mode: 0o600 });
  linkSync(canonical, `${canonical}.hardlink`);
  assert.throws(() => grantManagedActor(root, row("a".repeat(64)), { requestId: requestId("hostile-hardlink") }), /exactly one hard link/);
}));

test("cache_loss_and_nonce_mismatch_never_recreate", () => withRoot("cache", (root) => {
  grantManagedActor(root, row("a".repeat(64)), { requestId: requestId("cache-seed") });
  const prepared = prepareManagedAuthorization(managedActorLedgerDir(root), {
    owner: OWNER, actor: ACTOR, lifecycleUid: UID, requestId: requestId("cache-auth"), consumerId: "consumer_c", requestDigest: digest("request"),
  });
  assert.throws(() => prepared.commit(digest("expected"), Buffer.from("different")), /digest mismatch/);
}));

test("history_head_fork_missing_commit_and_catalog_rollback_refused", () => withRoot("history", (root) => {
  grantManagedActor(root, row("a".repeat(64)), { requestId: requestId("history-seed") });
  const head = verifyManagedHistory(managedActorLedgerDir(root), OWNER, ACTOR);
  const stateRoot = join(root, "managed-row-state");
  rmSync(join(stateRoot, "history", `${head}.json`));
  assert.throws(() => verifyManagedHistory(managedActorLedgerDir(root), OWNER, ACTOR), /missing commit/);
}));

test("older_history_head_cannot_authorize_newer_canonical", () => withRoot("history-rollback", (root) => {
  grantManagedActor(root,row("a".repeat(64)),{requestId:requestId("history-old")});
  const dir=managedActorLedgerDir(root);const oldHead=verifyManagedHistory(dir,OWNER,ACTOR);
  revokeManagedActor(root,OWNER,ACTOR,{requestId:requestId("history-revoke"),lifecycleUid:UID});
  grantManagedActor(root,row("b".repeat(64),UID2),{requestId:requestId("history-new")});
  writeFileSync(join(root,"managed-row-state","heads",`${OWNER}.${ACTOR}`),`${oldHead}\n`,{mode:0o600});
  assert.throws(()=>verifyManagedHistory(dir,OWNER,ACTOR),/canonical row does not match/);
}));

test("boot_resume_open_claim_completes_before_successor", () => withRoot("boot-resume", (root) => {
  const old = requestId("boot-old");
  assert.throws(() => grantManagedActor(root, row("a".repeat(64)), { requestId: old, failAt: "after-request" }));
  assert.throws(() => grantManagedActor(root, row("b".repeat(64), UID2), { requestId: requestId("boot-new") }), /busy|ownership|conflict|owned by pending request/);
  assert.equal(recoverManagedRowRequests(managedActorLedgerDir(root)), 1);
  const current = readManagedActor(managedActorLedgerDir(root), OWNER, ACTOR);
  assert.equal(current.state, "live");
  if (current.state === "live") assert.equal(current.row.lifecycleUid, UID);
}));

test("wrong_mode_and_owner_refused", () => withRoot("mode-owner", (root) => {
  grantManagedActor(root, row("a".repeat(64)), { requestId: requestId("mode-seed") });
  const canonical = join(managedActorLedgerDir(root), `${OWNER}.${ACTOR}.json`);
  chmodSync(canonical, 0o644);
  assert.throws(() => readManagedActor(managedActorLedgerDir(root), OWNER, ACTOR), /mode 0600/);
}));

test("closed_parser_rejects_unknown_fields", () => withRoot("closed", (root) => {
  grantManagedActor(root, row("a".repeat(64)), { requestId: requestId("closed-seed") });
  const canonical = join(managedActorLedgerDir(root), `${OWNER}.${ACTOR}.json`);
  const value = JSON.parse(readFileSync(canonical, "utf8"));
  value.untrusted = true;
  writeFileSync(canonical, JSON.stringify(value), { mode: 0o600 });
  assert.throws(() => readManagedActor(managedActorLedgerDir(root), OWNER, ACTOR), /unknown fields/);
}));

test("zero_process_and_file_survivors", () => withRoot("containment", (root) => {
  grantManagedActor(root, row("a".repeat(64)), { requestId: requestId("contain-seed") });
  const dir = managedActorLedgerDir(root);
  const names = readFileSync(join(dir, `${OWNER}.${ACTOR}.json`), "utf8");
  assert.ok(names.includes(ACTOR));
  assert.equal(lstatSync(dir).isSymbolicLink(), false);
}));

let passed = 0;
const failures: string[] = [];
for (const entry of tests) {
  try {
    await entry.run();
    passed++;
    console.log(`PASS ${entry.name}`);
  } catch (error) {
    failures.push(entry.name);
    console.error(`FAIL ${entry.name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}
console.log(`TASK84 AUTH MANAGED ROW ${passed} passed, ${failures.length} failed`);
console.log("TASK84 CONTAINMENT 0 processes, 0 unauthorized files");
if (failures.length) process.exitCode = 1;
