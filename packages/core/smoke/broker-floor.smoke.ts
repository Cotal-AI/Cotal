/** D10 broker-floor gate proofs: version parsing, floor comparison, and loud refusals. */
import { meetsBrokerFloor, parseServerVersion, requireBrokerFloor } from "../src/broker-floor.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const throws = (name: string, fn: () => unknown, needle: string) => {
  try {
    fn();
  } catch (e) {
    ok(name, String((e as Error).message).includes(needle), (e as Error).message);
    return;
  }
  throw new Error(`FAIL: ${name} — expected a loud throw`);
};

ok("parses release", JSON.stringify(parseServerVersion("2.12.3")) === '{"major":2,"minor":12,"patch":3}');
ok("parses prerelease", parseServerVersion("2.12.0-beta.1")?.minor === 12);
ok("garbage is null", parseServerVersion("devel") === null);

ok("2.12.0 meets floor", meetsBrokerFloor("2.12.0"));
ok("2.14.1 meets floor", meetsBrokerFloor("2.14.1"));
ok("3.0.0 meets floor", meetsBrokerFloor("3.0.0"));
ok("2.11.9 below floor", !meetsBrokerFloor("2.11.9"));
ok("1.99.0 below floor", !meetsBrokerFloor("1.99.0"));
ok("unparseable below floor", !meetsBrokerFloor("nightly"));

requireBrokerFloor({ info: { version: "2.12.0" } });
ok("gate passes at the floor", true);
throws("gate refuses below floor", () => requireBrokerFloor({ info: { version: "2.11.5" } }), "below the required floor");
throws("gate refuses missing version (no fallback)", () => requireBrokerFloor({}), "no server version");

console.log(`broker-floor.smoke: ${pass} checks passed`);
