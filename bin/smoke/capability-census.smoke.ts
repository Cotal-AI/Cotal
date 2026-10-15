/**
 * Capability census, offline half: every capability Cotal's machine-readable sources expose has an
 * owner row naming the CLI command that performs it, and every row names a live item.
 *
 * The items come from the real sources (endpoint contracts at field and mode level, the agent tool
 * specs, the registered CLI commands and flags, the persona, manifest, config, roster and presence
 * models, environment variables and auth HTTP routes), so a field added under an existing command
 * fails here until it is mapped. The self-tests feed the same checker an added field and wrong
 * owners and require each to fail. The live half (`capability-census-live.smoke.ts`) runs a mapped
 * command against a real broker and compares the request it issues with its owner rows.
 *
 * Run: pnpm smoke:capability-census
 */
import { censusItems } from "./census/sources.js";
import { ownerMapProblems, readOwnerMap, type OwnerMap } from "./census/owners.js";
import { createSuite } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const items = await censusItems();
const map = readOwnerMap();
const ids = new Set(items.map((i) => i.id));

check("the sources yield items of every kind", ["ep", "tool", "cli", "agent-file", "manifest", "config", "presence", "roster", "env", "auth-http"]
  .every((kind) => items.some((i) => i.id.startsWith(`${kind}:`))));
check("endpoint items reach nested input fields and target modes",
  ids.has("ep:manager:spawn.supervise.restarts") && ids.has("ep:manager:despawn@owner") && ids.has("ep:manager:spawn#ephemeral/manager.spawn"),
  [...ids].filter((id) => id.startsWith("ep:manager:spawn")));

const problems = ownerMapProblems(items, map);
check(`every one of ${items.length} items has a well-formed owner and every row is live`, problems.length === 0, problems);

const withRow = (owners: Record<string, string>): OwnerMap => ({ owners, checklist: map.checklist });
const added = [...items, { id: "ep:manager:spawn.addedField", source: "self-test" }];
check("a field added under an existing command fails as unowned",
  ownerMapProblems(added, map).includes("ep:manager:spawn.addedField: no owner row"));
check("a row whose item is gone fails as stale",
  ownerMapProblems(items, withRow({ ...map.owners, "ep:manager:gone": "current:ps" })).includes("ep:manager:gone: owner row names no census item"));
check("an owner naming no registered command fails",
  ownerMapProblems(items, withRow({ ...map.owners, "ep:manager:ps": "current:no-such-command" }))
    .includes('ep:manager:ps: owner names "no-such-command", which is not a registered command'));
check("an owner naming a flag its command does not declare fails",
  ownerMapProblems(items, withRow({ ...map.owners, "ep:manager:ps": "current:ps --no-such-flag" }))
    .includes('ep:manager:ps: "ps" declares no --no-such-flag flag'));
check("an endpoint item cannot be marked internal",
  ownerMapProblems(items, withRow({ ...map.owners, "ep:manager:ps": "internal:not a capability" }))
    .includes("ep:manager:ps: a ep item is a user capability and cannot be internal"));

finish();
