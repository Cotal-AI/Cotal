/**
 * A cut prepared by a build that writes a different resume-document version is REFUSED, and the
 * refusal deletes nothing.
 *
 * WHAT WENT WRONG. On the `down --preserve-state` retry path, the resume document is rewritten at
 * the CURRENT version while the journal still references the version the cut was prepared at. The
 * descriptor comparison refuses, the surrounding `catch` fires — and that catch called
 * `abortMaintenanceCut` unconditionally, **deleting the journal while a commit intent may still be
 * present**, with children possibly already stopped. A state no code was written to read.
 *
 * BOTH ARMS, because a single arm proves only that an abort was disabled. The same `catch` also
 * handles a GENUINE inventory mismatch — "a restarted manager prepared a different inventory" —
 * where aborting IS correct, and both surface as the same `invalid-transition`. So the refusal is
 * narrowed to the version case specifically; anything else must still reach the abort.
 *
 * WHY NOT RE-PREPARE AT THE JOURNAL'S OWN VERSION, which reads as the least surprising behaviour:
 * the retry re-prepares by asking the RUNNING manager, so the inventory it writes is already the NEW
 * shape. Stamping it with the OLD version would produce a document whose version claims a
 * compatibility its contents lack — aimed at exactly the older binary the barrier protects.
 *
 * WHAT THIS SUITE DOES *NOT* PROVE, stated rather than implied: it drives the shipped DECISION, not
 * the call-site ordering. That the refusal is raised BEFORE the `try` — so nothing is deleted — is
 * verified by reading `down.ts`, and by the structural cell below, not by an end-to-end durable cut.
 * No harness in this repo reaches that path today; building one is named as owed rather than
 * pretended. The structural cell is the weaker instrument and is labelled as such.
 *
 * Run: pnpm smoke:resume-version-refusal
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { MAINTENANCE_RESUME_DOCUMENT_VERSION } from "@cotal-ai/workspace";
import { resumeVersionRefusal } from "../src/commands/down.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++; else { fail++; console.log("  x FAIL:", n, extra ?? ""); }
};

// ── ARM 1: a version mismatch REFUSES, and says so in terms an operator can act on ──
const older = resumeVersionRefusal(MAINTENANCE_RESUME_DOCUMENT_VERSION - 1, "attempt-abc");
c("a cut prepared at an OLDER document version is refused", older !== undefined, older);
c("the refusal names both versions", Boolean(older && older.includes(String(MAINTENANCE_RESUME_DOCUMENT_VERSION - 1)) && older.includes(String(MAINTENANCE_RESUME_DOCUMENT_VERSION))), older);
c("the refusal names the attempt, so an operator can find the cut", Boolean(older?.includes("attempt-abc")), older);
// The state of the world matters more than the error: an operator staring at a half-finished durable
// cut needs to know nothing was destroyed before they need to know what failed.
c("the refusal states plainly that NOTHING was changed or deleted", Boolean(older && /nothing has been[\s\S]*changed or deleted/i.test(older)), older);
c("and it names both remedies — finish, or discard, under the binary that started it",
  Boolean(older && /finish or discard/i.test(older)), older);

const newer = resumeVersionRefusal(MAINTENANCE_RESUME_DOCUMENT_VERSION + 1, "attempt-abc");
c("a cut prepared at a NEWER document version is refused too", newer !== undefined, newer);

// ── ARM 2: everything else PROCEEDS, so the genuine-inventory-mismatch abort is untouched ──
//    Without this arm the cells above would pass for a change that refused every retry, which is a
//    wedged-cut bug traded for a data-loss one.
c("a cut prepared at THIS build's version proceeds (the abort path is not disabled)",
  resumeVersionRefusal(MAINTENANCE_RESUME_DOCUMENT_VERSION, "attempt-abc") === undefined);
c("a journal with no recorded version proceeds (nothing to disagree with)",
  resumeVersionRefusal(undefined, "attempt-abc") === undefined);

// ── STRUCTURAL, and weaker: the refusal must be raised BEFORE anything can delete. ──
//    Labelled as structural because it reads the source rather than driving the path. It is here
//    because the ordering IS the guarantee — refusing after an abort would be no guarantee at all —
//    and no harness in this repo reaches the durable retry path to prove it by execution.
{
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const src = readFileSync(join(root, "implementations/cli/src/commands/down.ts"), "utf8");
  const refusal = src.indexOf("resumeVersionRefusal(readMaintenanceJournal");
  // The abort THIS refusal guards is the next one AFTER it, not the first in the file: `down.ts` has
  // another `abortMaintenanceCut(lock)` on an unrelated earlier path. Comparing against that one
  // failed while the ordering was correct — the wrong-object class, in the cell rather than the code.
  const abort = src.indexOf("abortMaintenanceCut(lock)", refusal);
  c("[structural] there IS an abort after the refusal (otherwise this cell proves nothing)", abort > 0, abort);
  c("[structural] the version refusal appears before the abort in the retry path",
    refusal > 0 && abort > 0 && refusal < abort, { refusal, abort });
  c("[structural] the refusal is raised outside the try that contains the abort",
    refusal > 0 && refusal < src.indexOf("writeMaintenanceResumeDocument(lock, {"), { refusal });
}

console.log(`resume-version-refusal smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
