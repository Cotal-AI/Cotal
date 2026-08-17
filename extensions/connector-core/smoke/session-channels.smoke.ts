/**
 * A SESSION JOINS ONLY WHAT ITS LAUNCHER NAMED.
 *
 * `configFromEnv` is the last place a spawned session's read set is decided: the launcher's
 * `COTAL_SUBSCRIBE`, else the persona file, else the join link. That chain used to end in
 * `["general"]`, so a session whose launcher, persona and link all named no channel was put on
 * `general` by the connector — including every DM-only reviewer and probe seat, whose scoped
 * credential then denied the very subscribe the connector had just decided to make.
 *
 * The chain and its ORDER are what this grades, not just the tail: each rung must still win over
 * the one below it (a fix that emptied the default by breaking the persona rung would be worse than
 * the bug). The tail is now empty, and empty means DM-only, not `general`.
 *
 * The core-side consequences of a channel-less agent (no channel row in its cred, DMs intact, the
 * send refusal) are graded in `packages/core/smoke/no-implicit-general.smoke.ts`. This suite is only
 * the connector's resolution, which lives here and is imported by relative specifier, so the bytes
 * graded are this package's source.
 *
 * Run: pnpm smoke:session-channels   (pure config resolution; no broker, no network)
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFromEnv } from "../src/config.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const dir = mkdtempSync(join(tmpdir(), "session-channels-"));
const persona = (name: string, frontmatter: string): string => {
  const path = join(dir, `${name}.md`);
  writeFileSync(path, `---\nname: ${name}\n${frontmatter}---\n\nbody\n`);
  return path;
};

// The bare launch: a name and nothing else. This is the shape a DM-only seat arrives in.
const bare = configFromEnv({ COTAL_NAME: "probe" });
check("a session launched with only a name joins NO channel", eq(bare.subscribe, []), bare.subscribe);
check("and its read ACL is empty too, so it cannot join one by surprise", eq(bare.allowSubscribe, []), bare.allowSubscribe);
check("post stays default-deny, as it always was", eq(bare.allowPublish, []), bare.allowPublish);

// A persona that names no channel: same answer, from the rung below.
const quiet = configFromEnv({ COTAL_NAME: "probe", COTAL_AGENT_FILE: persona("dm-only", "role: reviewer\n") });
check("a persona that names no channel joins none", eq(quiet.subscribe, []), quiet.subscribe);

// Every rung above the tail still wins, in order.
const fromFile = configFromEnv({ COTAL_NAME: "p", COTAL_AGENT_FILE: persona("listy", "subscribe: [general, ops]\n") });
check("a persona that LISTS channels still gets exactly those", eq(fromFile.subscribe, ["general", "ops"]), fromFile.subscribe);

const fromEnv = configFromEnv({ COTAL_NAME: "p", COTAL_SUBSCRIBE: "ops", COTAL_AGENT_FILE: persona("listy2", "subscribe: [general]\n") });
check("the launcher's COTAL_SUBSCRIBE beats the persona file", eq(fromEnv.subscribe, ["ops"]), fromEnv.subscribe);

const fromLink = configFromEnv({ COTAL_NAME: "p", COTAL_LINK: "cotal://tok@127.0.0.1:4222/demo?channel=lobby" });
check("a join link still supplies the channel it carries", eq(fromLink.subscribe, ["lobby"]), fromLink.subscribe);

console.log(`\nsession-channels: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
