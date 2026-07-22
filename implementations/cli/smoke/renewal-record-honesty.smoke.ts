/**
 * RENEWAL-RECORD HONESTY (W3 3a, freelance blockers 1 + 4) — broker-free. Two invariants the
 * adoption-proof slice must never regress:
 *
 *  1. The ephemeral generation FINGERPRINT (SHA-256 of the re-signed JWT) NEVER reaches disk. It is
 *     the expected-generation token the renewal owner hands the daemon; a stable secret-derived
 *     token on disk is a leak. `writeRenewalRecord` redacts at the single persistence boundary, so
 *     EVERY writer (manager AND `doctor auth --fix`) is covered even when the in-memory result
 *     carries a fingerprint. We assert the raw JSON has no `fingerprint` key and no 64-hex digest.
 *
 *  2. A broker-REFUSED renewal is a first-class doctor problem: `cotal doctor auth` must exit 1 and
 *     say so, never let cred-file health alone stand as `auth: healthy` / exit 0. The mirror case —
 *     a broker-ACCEPTED renewal with no cred problems — must still exit healthy, proving the exit-1
 *     is the refusal itself, not merely the presence of a renewal record.
 *
 * Run: pnpm smoke:renewal-record-honesty
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth } from "@cotal-ai/core";
import {
  authDir,
  readRenewalRecord,
  renewalRecordPath,
  saveSpaceAuth,
  writeRenewalRecord,
} from "@cotal-ai/workspace";
import { doctor } from "../src/commands/doctor.js";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const root = mkdtempSync(join(tmpdir(), "cotal-renewal-honesty-"));
mkdirSync(join(root, ".cotal", "auth"), { recursive: true });
const auth = await createSpaceAuth("renewal-honesty-smoke");
saveSpaceAuth(authDir(root), auth);

const origCwd = process.cwd();
const origLog = console.log;
const origErr = console.error;
function runDoctor(): Promise<{ out: string; code: number | undefined }> {
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  process.exitCode = undefined;
  process.chdir(root);
  return doctor({ values: {}, positionals: ["auth"], raw: [] })
    .then(() => ({ out: lines.join("\n"), code: process.exitCode as number | undefined }))
    .finally(() => {
      console.log = origLog;
      console.error = origErr;
      process.chdir(origCwd);
      process.exitCode = 0;
    });
}

try {
  // ── 1. fingerprint redaction at the persistence boundary ────────────────────────────────────────
  const FAKE_FP = "a".repeat(64); // a plausible SHA-256 hex digest
  writeRenewalRecord(root, {
    ts: "2026-01-01T00:00:00.000Z",
    owner: "manager",
    // The in-memory result DOES carry a fingerprint (as remintDaemonCreds returns it); the writer
    // must strip it. If the writer ever forgets, this raw string appears on disk.
    results: [{ file: "delivery.creds", ok: true, fingerprint: FAKE_FP }],
    adoption: { ok: true, detail: { delivery: { ok: true, brokerAccepted: { identity: "x" } } } },
  });
  const raw = readFileSync(renewalRecordPath(root), "utf8");
  check("persisted record has no `fingerprint` key", !raw.includes("fingerprint"), raw);
  check("persisted record has no 64-hex digest of any kind", !/[0-9a-f]{64}/i.test(raw), raw);
  check("the specific ephemeral fingerprint never reached disk", !raw.includes(FAKE_FP));
  const back = readRenewalRecord(root);
  check("readback drops fingerprint but keeps the real result fields", back?.results[0]?.fingerprint === undefined && back?.results[0]?.file === "delivery.creds" && back?.results[0]?.ok === true, back?.results[0]);

  // ── 2. doctor exit status reflects the broker's verdict ─────────────────────────────────────────
  // 2a. broker-ACCEPTED, no cred problems → still healthy (exit 0). Proves the exit-1 below is the
  //     refusal itself, not merely the presence of a renewal record.
  const accepted = await runDoctor();
  check("broker-accepted renewal + no cred problems exits healthy (0)", accepted.code === undefined && accepted.out.includes("auth: healthy"), `${accepted.code} ${accepted.out.slice(-300)}`);
  check("the accepted record renders as broker-accepted", accepted.out.replace(/\[[0-9;]*m/g, "").includes("broker-accepted"), accepted.out);

  // 2b. broker-REFUSED renewal (same cred files, only the record flips) → exit 1 + a loud line.
  writeRenewalRecord(root, {
    ts: "2026-01-01T00:00:00.000Z",
    owner: "manager",
    results: [{ file: "delivery.creds", ok: true }],
    adoption: { ok: false, error: "the broker did not accept the re-signed credential (Authorization Violation); nothing adopted", detail: { delivery: { ok: false } } },
  });
  const refused = await runDoctor();
  check("broker-refused renewal exits non-zero (1)", refused.code === 1, refused.code);
  check("the verdict names the refusal, not `auth: healthy`", !refused.out.includes("auth: healthy") && /not broker-accepted|refused by the broker/i.test(refused.out), refused.out);
  check("the refusal line names the next action (repair the manager)", /manager/i.test(refused.out) && refused.out.includes("next:"), refused.out);

  console.log(fail === 0 ? `\nRENEWAL-RECORD HONESTY OK ✅  (${pass} passed, ${fail} failed)` : `\nRENEWAL-RECORD HONESTY FAILED ❌  (${pass} passed, ${fail} failed)`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  console.log = origLog;
  console.error = origErr;
  process.chdir(origCwd);
  rmSync(root, { recursive: true, force: true });
}
