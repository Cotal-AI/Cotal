/**
 * Owner/actor token smoke (per-user-auth prep): owner+actor serialization must be fail-loud and
 * collision-free before the subject grammar flips.
 *
 * Run: pnpm smoke:owner-token
 */
import { assertValidOwnerToken, principalNameKey, principalSubjectKey } from "../src/index.js";

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

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

check("plain alnum owner token is accepted", assertValidOwnerToken("Owner123") === "Owner123");
check("underscore owner token is accepted", assertValidOwnerToken("owner_actor") === "owner_actor");
check("dot is rejected", throws(() => assertValidOwnerToken("owner.actor")));
check("wildcard star is rejected", throws(() => assertValidOwnerToken("owner*")));
check("wildcard greater-than is rejected", throws(() => assertValidOwnerToken("owner>")));
check("hyphen is rejected because it is the JetStream-name separator", throws(() => assertValidOwnerToken("owner-actor")));
check("empty token is rejected", throws(() => assertValidOwnerToken("")));
check("non-ASCII token is rejected", throws(() => assertValidOwnerToken("café")));

check("subject/KV principal key uses dot separator", principalSubjectKey("owner_1", "actor_2") === "owner_1.actor_2");
check("JetStream principal key uses hyphen separator", principalNameKey("owner_1", "actor_2") === "owner_1-actor_2");
check("hyphen ban prevents ambiguous name-key owner side", throws(() => principalNameKey("owner-1", "actor")));
check("hyphen ban prevents ambiguous name-key actor side", throws(() => principalNameKey("owner", "actor-1")));

if (fail) {
  console.error(`\nOWNER TOKEN SMOKE FAILED (${fail} failed, ${pass} passed)`);
  process.exit(1);
}
console.log(`\nOWNER TOKEN SMOKE PASSED ✅  (${pass} checks)`);
