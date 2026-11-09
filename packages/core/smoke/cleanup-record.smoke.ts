/**
 * One rejection text and one cleanup record, shared by the CLI and the manager (#3173).
 *
 * The two copies used to agree on an Error, a string and a poisoned value, and disagree on
 * the record a failed cleanup step left behind. Both now call these helpers. A step that
 * passes leaves no record, and a step that throws does not stop the step after it.
 *
 * Run: pnpm smoke:cleanup-record
 */
import { attemptCleanup, describeCleanupFailures, rejectionText, type CleanupFailure } from "../src/cleanup.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown): void => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const poisoned = { get message(): string { throw new Error("getter"); }, toString(): string { throw new Error("string"); } };
const cases: Array<[string, unknown, string]> = [
  ["an Error", new Error("EACCES"), "EACCES"],
  ["a plain object carrying a message", { message: "from-object" }, "from-object"],
  ["a string", "refused as text", "refused as text"],
  ["null", null, "null"],
  ["undefined", undefined, "undefined"],
  ["a number", 7, "7"],
  ["a value that cannot be read", poisoned, "an unreadable rejection"],
];
for (const [label, value, text] of cases) ok(`rejectionText reads ${label}`, rejectionText(value) === text, rejectionText(value));

const failed: CleanupFailure[] = [];
await attemptCleanup(failed, "actor token file", () => { throw new Error("EACCES"); });
await attemptCleanup(failed, "health file", () => undefined);
await attemptCleanup(failed, "sentinel creds file", () => { throw poisoned; });
ok("a passing step leaves no record and does not stop the next step", failed.length === 2 && failed[0]?.step === "actor token file" && failed[1]?.step === "sentinel creds file", failed);
ok("the record keeps the caught value", failed[0]?.err instanceof Error && (failed[0].err as Error).message === "EACCES", failed[0]);
ok("the failures render once, in order", describeCleanupFailures(failed) === "actor token file: EACCES; sentinel creds file: an unreadable rejection", describeCleanupFailures(failed));
ok("no failures render as an empty sentence", describeCleanupFailures([]) === "");

console.log(`cleanup-record smoke: ${pass} checks passed`);
