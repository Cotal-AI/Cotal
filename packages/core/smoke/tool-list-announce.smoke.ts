/**
 * Tool-list announce capability (#1004).
 *
 * The advertised `cotal_*` list is a function of the session's mesh config. A
 * connection change therefore changes the list. MCP connectors can tell the host
 * (`tools/list_changed`); native hosts that take a tool map once cannot.
 *
 * THE RULE. Consumers above the connector boundary branch on
 * `supportsToolListAnnounce`, never on the connector's name. Absent is cannot
 * (default-deny). A connection-changing op against a connector that does not
 * declare the flag MUST throw rather than leave a stale advertised surface.
 *
 * THE DISCRIMINATING ASSERTION is a connector the CLI has never heard of.
 * Enumerating today's shipped names would pass against the bug and keep passing
 * as the matrix drifts.
 *
 * Run: `pnpm smoke:tool-list-announce`
 */
import { refuseUnannouncedToolListChange, type Connector, type LaunchSpec } from "../src/connector.js";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? extra : "");
  }
};

const launch = (): LaunchSpec => ({ command: "true", args: [] });

const announcer: Connector = {
  kind: "connector",
  name: "smoke-announce-unknown",
  supportsToolListAnnounce: true,
  buildLaunch: launch,
};
const silent: Connector = {
  kind: "connector",
  name: "smoke-silent-unknown",
  buildLaunch: launch,
};
const denied: Connector = {
  kind: "connector",
  name: "smoke-denied-unknown",
  supportsToolListAnnounce: false,
  buildLaunch: launch,
};

check(
  "the announcer is a connector the CLI has never heard of",
  announcer.name === "smoke-announce-unknown" && announcer.name !== "claude",
);
check("declared-true is allowed", (() => {
  try {
    refuseUnannouncedToolListChange(announcer);
    return true;
  } catch (e) {
    console.log(`  (threw: ${(e as Error).message})`);
    return false;
  }
})());

const silentErr = (() => {
  try {
    refuseUnannouncedToolListChange(silent);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
})();
check("undeclared is refused (default-deny, not a no-op)", silentErr.length > 0);
check(
  "undeclared refusal names the missing announce",
  /cannot announce a tool-list change/.test(silentErr),
  silentErr,
);
check(
  "the refusal message contains no connector name at all",
  !/\b(claude|opencode|hermes|codex|jcode|pi|smoke-silent-unknown|smoke-announce-unknown|smoke-denied-unknown)\b/.test(silentErr),
  silentErr,
);

const deniedErr = (() => {
  try {
    refuseUnannouncedToolListChange(denied);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
})();
check("declared-false is refused, not treated as a silent no-op", deniedErr.length > 0);
check(
  "declared-false refusal is the same contract as undeclared",
  /cannot announce a tool-list change/.test(deniedErr),
  deniedErr,
);

console.log(`\nTOOL-LIST-ANNOUNCE SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
