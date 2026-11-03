// Every entry shipped source writes directly under the Cotal home must be named in homeRecordEntries,
// because a control-directory check under a redirected COTAL_HOME covers those entries and no other
// child. A new `join(homeCotalDir(), "<entry>")` that is not in the set would let `space create` or
// `up` prepare a project inside that record's folder.
//
// Run: `pnpm smoke:home-record-entries`
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homeRecordEntries } from "../src/cotal-home.js";

const repo = resolve(import.meta.dirname, "../../..");
const files = execFileSync("git", ["-C", repo, "ls-files", "packages/*/src/**/*.ts", "implementations/*/src/**/*.ts", "extensions/*/src/**/*.ts", "bin/*.ts"], { encoding: "utf8" })
  .split("\n").filter((f) => f && !f.includes("/smoke/"));
const literal = /homeCotalDir\(\),\s*"([^"]+)"/g;
const found = new Map<string, string[]>();
for (const file of files) {
  const text = readFileSync(resolve(repo, file), "utf8");
  for (const m of text.matchAll(literal)) {
    const entry = m[1]!.split("/")[0]!;
    found.set(entry, [...(found.get(entry) ?? []), file]);
  }
}
const missing = [...found].filter(([entry]) => !homeRecordEntries.has(entry));
let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++; else { fail++; console.error(`  ✗ FAIL: ${label}`, detail ?? ""); }
  if (ok) console.log(`  ✓ ${label}`);
};
check("shipped source writes at least one entry under the Cotal home", found.size > 0, [...found.keys()]);
check("every entry shipped source writes under the Cotal home is in homeRecordEntries", missing.length === 0, Object.fromEntries(missing));
console.log(`\nhome-record-entries smoke: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
