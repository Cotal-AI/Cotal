// Every entry shipped source writes directly under the Cotal home must be named in homeRecordEntries,
// because a control-directory check under a redirected COTAL_HOME covers those entries and no other
// child. A new `join(homeCotalDir(), "<entry>")` that is not in the set would let `space create` or
// `up` prepare a project inside that record's folder.
//
// Run: `pnpm smoke:home-record-entries`
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rootControlProblem } from "../src/auth-paths.js";
import { homeRecordEntries } from "../src/cotal-home.js";

const repo = resolve(import.meta.dirname, "../../..");
const files = execFileSync("git", ["-C", repo, "ls-files", "packages/*/src/**/*.ts", "implementations/*/src/**/*.ts", "extensions/*/src/**/*.ts", "bin/*.ts"], { encoding: "utf8" })
  .split("\n").filter((f) => f && !f.includes("/smoke/"));
const literal = /homeCotalDir\(\),\s*"([^"]+)"/g;
const found = new Map<string, string[]>();
for (const file of files) {
  const source = readFileSync(resolve(repo, file), "utf8");
  for (const m of source.matchAll(literal)) {
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
// Exercise the same root check space create and up call, without starting a stack or reading
// process attribution. A redirected home may contain projects beside its machine records.
const previousHome = process.env.COTAL_HOME;
const home = realpathSync(mkdtempSync(join(tmpdir(), "cotal-home-records-")));
try {
  process.env.COTAL_HOME = home;
  for (const entry of [".update-closure.lock", join(".update-closure.lock", "nested"), "daemon", join("daemon", "retained", "deep"), join("services", "retained")]) {
    const problem = rootControlProblem(join(home, entry));
    check(`${entry} is protected as a machine-home record`, problem?.controlDirectory === home && problem.project === undefined, problem);
  }
  for (const entry of ["project", "daemon-project", ".update-closure-project", join("projects", "web")]) {
    const problem = rootControlProblem(join(home, entry));
    check(`${entry} remains an ordinary project path`, problem === undefined, problem);
  }
} finally {
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
}
console.log(`\nhome-record-entries smoke: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
