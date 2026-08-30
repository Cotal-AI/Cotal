/**
 * Mesh-side persona catalog read (#402), graded against the SAME helpers the manager
 * consults: {@link listPersonaCatalog} and {@link personaCatalogReadable}.
 *
 * WHAT IT ASSERTS, on a throwaway directory (no broker, no manager process):
 *
 *   1. an empty root is an empty catalog, not a throw
 *   2. every parseable `.md` is listed (so a definer can see a taken spawn name)
 *   3. `personaCatalogReadable` is owner-or-admin, fail-closed on ownerless files
 *   4. a foreign owner therefore does NOT get role/model/description (name only)
 *   5. the owner DOES get those fields, matching `cotal personas list` content
 *   6. unparseable files are listed with error, not thrown
 *
 * (3)+(4) are the mutation cell: flipping `personaCatalogReadable` to `return true`
 * leaks another peer's description; flipping it to `return admin` hides the owner's
 * own card. Both redden a named assertion below.
 *
 * Run: pnpm smoke:persona-catalog-read
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listPersonaCatalog,
  personaCatalogDescription,
  personaCatalogReadable,
  saveAgentFile,
} from "../src/agent-file.js";

let failures = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};

const root = mkdtempSync(join(tmpdir(), "cotal-persona-catalog-"));
check("an empty root is an empty catalog, not a throw", listPersonaCatalog(root).length === 0);

mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
saveAgentFile(join(root, ".cotal", "agents", "mine.md"), {
  name: "mine",
  role: "reviewer",
  model: "opus",
  owner: "alice",
  subscribe: [],
  persona: "You review PRs.\nSecond line.",
});
saveAgentFile(join(root, ".cotal", "agents", "theirs.md"), {
  name: "theirs",
  role: "worker",
  model: "sonnet",
  owner: "bob",
  subscribe: [],
  persona: "You write code. This body must not leak to alice.",
});
saveAgentFile(join(root, ".cotal", "agents", "operator.md"), {
  name: "operator",
  role: "ops",
  subscribe: [],
  persona: "Hand-written, no owner.",
});
writeFileSync(join(root, ".cotal", "agents", "broken.md"), "not a persona file\n");

const catalog = listPersonaCatalog(root);
check(
  "every parseable and unparseable .md is listed (taken-name census)",
  catalog.map((e) => e.name).join(",") === "broken,mine,operator,theirs",
  catalog.map((e) => e.name),
);
check("broken is an error row, not a throw", catalog.find((e) => e.name === "broken")?.error !== undefined);
const mine = catalog.find((e) => e.name === "mine")!.def!;
const theirs = catalog.find((e) => e.name === "theirs")!.def!;
const operator = catalog.find((e) => e.name === "operator")!.def!;
check(
  "description is the first persona line, truncated like the CLI",
  personaCatalogDescription(mine) === "You review PRs.",
  personaCatalogDescription(mine),
);

check("owner can read their own card", personaCatalogReadable(mine.owner, "alice", false) === true);
check(
  "foreign owner cannot read another peer's details",
  personaCatalogReadable(theirs.owner, "alice", false) === false,
);
check("admin can read a foreign card", personaCatalogReadable(theirs.owner, "alice", true) === true);
check(
  "ownerless (operator-written) files are admin-only",
  personaCatalogReadable(operator.owner, "alice", false) === false
    && personaCatalogReadable(operator.owner, "alice", true) === true,
);

/** The manager's list projection, inlined so this file grades the SAME ownership predicate
 *  the handler uses rather than a second copy of the catalog walk. */
const projected = catalog.flatMap((e) => {
  if (e.error) return [{ name: e.name, error: "unparseable" as const }];
  const def = e.def!;
  if (!personaCatalogReadable(def.owner, "alice", false)) return [{ name: e.name }];
  const description = personaCatalogDescription(def);
  return [{
    name: e.name,
    ...(def.role ? { role: def.role } : {}),
    ...(def.model ? { model: def.model } : {}),
    ...(description ? { description } : {}),
    ...(def.owner ? { owner: def.owner } : {}),
  }];
});
const aliceMine = projected.find((p) => p.name === "mine")!;
const aliceTheirs = projected.find((p) => p.name === "theirs")!;
const aliceOperator = projected.find((p) => p.name === "operator")!;
check(
  "alice sees her own role/model/description",
  "role" in aliceMine && aliceMine.role === "reviewer" && aliceMine.model === "opus" && aliceMine.description === "You review PRs.",
  aliceMine,
);
check(
  "alice sees a foreign name only — no role, model, or description leak",
  !("role" in aliceTheirs) && !("model" in aliceTheirs) && !("description" in aliceTheirs) && !("owner" in aliceTheirs),
  aliceTheirs,
);
check(
  "alice sees an operator-written name only",
  !("role" in aliceOperator) && !("description" in aliceOperator),
  aliceOperator,
);

console.log(`\nPERSONA CATALOG READ ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
