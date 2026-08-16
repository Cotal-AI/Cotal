/**
 * Dependency ranges that a PUBLISHED install re-resolves, and the ones that may not move.
 *
 * The repo is protected by a lockfile. A published package is not: npm re-resolves every range
 * at install time, so a range CI has never exercised is a range a user installs. On 2026-08-16
 * that difference took the CLI down in the field - `json-canonicalize@2.0.1` was published with
 * its `bundles/` directory missing from the tarball while its own `main` still pointed at
 * `./bundles/index.umd.js`, so `^2.0.0` resolved to a package that cannot be imported at all.
 * The lockfile pinned 2.0.0, CI stayed green, and `cotal --version` on a fresh install crashed
 * with ERR_MODULE_NOT_FOUND before printing anything.
 *
 * This is NOT a general "pin everything" rule. It is a named quarantine list: a dependency whose
 * publisher has shipped a broken tarball once is a dependency whose ranges we do not float, and
 * the reason each one is on the list is recorded beside it so a later reader can retire an entry
 * on evidence rather than on tidiness.
 *
 * What this cell can and cannot do, stated so nobody reads more into a green than it carries: it
 * proves the RANGE is exact. It does not prove the pinned version is installable - only an
 * install of the packed tarball against the live registry proves that, which is
 * `smoke:seed-tarball:live`, and that suite is outside `smoke:ci`. The instrument that would have
 * caught this incident exists and does not run.
 *
 * Run: pnpm smoke:dep-pins
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..");
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

/** Each entry names the incident that put it here. Retire one only with evidence, never for tidiness. */
const QUARANTINE: { dep: string; why: string }[] = [
  {
    dep: "json-canonicalize",
    why: "2.0.1 published without the bundles/ directory its own main points at (2026-08-16)",
  },
];

/** Every workspace package that is published, so every package whose ranges a user re-resolves. */
const PUBLISHED = ["packages/core", "packages/lang", "packages/workspace", "implementations/cli"];

const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;

console.log("dep-pins: published ranges that must not float");

let seen = 0;
for (const pkgDir of PUBLISHED) {
  let raw: string;
  try {
    raw = readFileSync(join(REPO, pkgDir, "package.json"), "utf8");
  } catch {
    // A package that has moved is not a silent pass: the list above is part of the assertion.
    check(`${pkgDir}/package.json is readable - the published set in this cell is current`, false);
    continue;
  }
  const pkg = JSON.parse(raw) as Record<string, Record<string, string> | undefined>;
  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const { dep, why } of QUARANTINE) {
      const range = deps[dep];
      if (range === undefined) continue;
      seen++;
      check(
        `${pkgDir} ${field}.${dep} is pinned exactly, not a floating range - ${why}`,
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(range),
        `found ${JSON.stringify(range)}; a published install re-resolves this against the registry`,
      );
    }
  }
}

// A quarantine list nothing matches is a rule that has quietly stopped applying. If every entry
// were removed from every manifest this suite would print zero checks and exit 0, which reads as
// "the pins hold" when it means "there are no pins". The count is the cell.
check(
  "the quarantine list still matches at least one declared dependency - an unmatched list grades nothing",
  seen > 0,
  `${seen} matches across ${PUBLISHED.length} published packages`,
);

console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
