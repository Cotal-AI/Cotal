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
 * The same seam refuses a COTAL_SERVERS with a user name or password: the client keeps only the
 * host and port, so the session would fail authorization or print them in a not-connected line.
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

const refusal = (env: Record<string, string>): string => {
  try {
    configFromEnv({ COTAL_NAME: "p", ...env });
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};
const named = /^COTAL config: COTAL_SERVERS must not embed credentials; name the broker URL without user:password@, and pass the credential in COTAL_CREDS, COTAL_TOKEN or a COTAL_LINK$/;
for (const [label, servers] of [["a nats:// URL", "nats://u:pw0rdX@127.0.0.1:4222"], ["a URL with no scheme", "u:pw0rdX@127.0.0.1:4222"], ["one URL of a list", "nats://127.0.0.1:1,tls://u:pw0rdX@127.0.0.1:4222"]]) {
  const message = refusal({ COTAL_SERVERS: servers });
  check(`COTAL_SERVERS with a user and password in ${label} is refused, naming the variable and not its value`, named.test(message) && !message.includes("pw0rdX"), message);
}
check("a COTAL_SERVERS with no user or password still resolves", configFromEnv({ COTAL_NAME: "p", COTAL_SERVERS: "nats://127.0.0.1:4222" }).servers === "nats://127.0.0.1:4222");
const linked = configFromEnv({ COTAL_NAME: "p", COTAL_LINK: "cotal://u:pw0rdX@127.0.0.1:4222/demo" });
check("a join link still carries a user and password to the endpoint", linked.user === "u" && linked.pass === "pw0rdX" && linked.servers === "nats://127.0.0.1:4222", linked);

// #3243: COTAL_KIND is validated against the closed "agent" | "endpoint" set rather than cast.
check("an unset COTAL_KIND defaults to agent", bare.kind === "agent", bare.kind);
check("COTAL_KIND=endpoint resolves to endpoint", configFromEnv({ COTAL_NAME: "p", COTAL_KIND: "endpoint" }).kind === "endpoint");
check("COTAL_KIND=agent resolves to agent", configFromEnv({ COTAL_NAME: "p", COTAL_KIND: "agent" }).kind === "agent");
check(
  "a persona file's kind: endpoint is used when COTAL_KIND is unset",
  configFromEnv({ COTAL_NAME: "p", COTAL_AGENT_FILE: persona("ep-persona", "kind: endpoint\n") }).kind === "endpoint",
);
for (const bad of ["agnet", "Agent"]) {
  const msg = refusal({ COTAL_KIND: bad });
  check(`COTAL_KIND=${bad} is refused naming the valid kinds`, msg === 'COTAL config: "kind" must be "agent" or "endpoint"', msg);
}

console.log(`\nsession-channels: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
