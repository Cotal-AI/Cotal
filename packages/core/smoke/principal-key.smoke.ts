/**
 * Identity-foundation smoke: `assertValidOwnerToken` + the two-form `principalKey` serializer
 * (per-user-auth cutover prep — see .internal/plans/per-user-auth.md, §Identity model).
 *
 * Guards the two-form contract the owner+actor flip keys everything off:
 *   - the token alphabet is `[A-Za-z0-9_]+` — dots/wildcards are lane breakout, and `-` is
 *     RESERVED as the JetStream-name separator, so it must be rejected *inside* a token;
 *   - `principalKey` emits the subject/KV dot-form `<owner>.<actor>` and the JetStream-name
 *     form `<owner>-<actor>`, and both must be collision-free (bijective with the pair).
 * Broker-free; runs in the smoke:ci gate.
 * Run: pnpm smoke:principal-key
 */
import { assertValidOwnerToken, principalKey } from "../src/subjects.js";

let failures = 0;
function check(label: string, ok: boolean) {
  if (!ok) {
    failures++;
    console.error(`✗ ${label}`);
  } else {
    console.log(`✓ ${label}`);
  }
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ---- assertValidOwnerToken: accepts exactly [A-Za-z0-9_]+ ----
const valid = ["alice", "A", "user_42", "0", "___", "UDOE2PE4P2EC4MBDNHSUYHIXF3FUWZMHLD6O7IA727W5UWW7RA7HIUB5"];
for (const t of valid) check(`accepts "${t}"`, !throws(() => assertValidOwnerToken(t)) && assertValidOwnerToken(t) === t);
// NOTE the last case: a raw nkey still PASSES the validator — base32 is [A-Z0-9]. Owner-token
// nkey-DISJOINTNESS is a property of the derivation format (plan: flip acceptance criterion 2),
// not of this alphabet check. This case pins that boundary so nobody assumes the validator does it.

const invalid = [
  "", // empty
  "a.b", // dot = token boundary → lane breakout
  "*", ">", "a*", "a>", // wildcards → aliasing
  "a-b", "-", "a-", "-a", // '-' reserved as the principal name-form separator (the alphabet change)
  "a b", " ", "a/b", "a\\b", "a\nb", "a\tb", // whitespace / illegal separators
  ".", "a.", ".a", // degenerate dots
  "caf\u00e9", "cafe\u0301", // non-ASCII: NFC and NFD forms of café
  "_INBOX.x", "$JS", "a=b", // plumbing-ish shapes
];
for (const t of invalid) check(`rejects ${JSON.stringify(t)}`, throws(() => assertValidOwnerToken(t)));

// ---- principalKey: the two forms ----
const p = principalKey("alice", "agent_1");
check(`dot-form is "alice.agent_1"`, p.key === "alice.agent_1");
check(`name-form is "alice-agent_1"`, p.name === "alice-agent_1");
check("throws on invalid owner", throws(() => principalKey("a.b", "actor")));
check("throws on invalid actor", throws(() => principalKey("owner", "a.b")));
// The motivating collision: with '-' legal inside tokens, ("a-b","c") and ("a","b-c") would BOTH
// name "a-b-c". With '-' reserved, both inputs are rejected outright.
check("rejects '-' in owner (would collide name-forms)", throws(() => principalKey("a-b", "c")));
check("rejects '-' in actor (would collide name-forms)", throws(() => principalKey("a", "b-c")));

// ---- collision-freedom: distinct pairs never serialize to the same string, in either form ----
const pairs: Array<[string, string]> = [
  ["a_b", "c"],
  ["a", "b_c"], // the '_'-vs-separator case: names a_b-c vs a-b_c must stay distinct
  ["a", "b"],
  ["ab", "c"],
  ["a", "bc"],
  ["a_", "b"],
  ["a", "_b"],
  ["u1", "a1"],
  ["u1", "a2"],
  ["u2", "a1"],
];
const keys = new Set(pairs.map(([o, a]) => principalKey(o, a).key));
const names = new Set(pairs.map(([o, a]) => principalKey(o, a).name));
check(`dot-forms are pairwise distinct (${pairs.length} pairs)`, keys.size === pairs.length);
check(`name-forms are pairwise distinct (${pairs.length} pairs)`, names.size === pairs.length);

// ---- both forms split back to exactly the input pair (the separator appears exactly once) ----
for (const [o, a] of pairs) {
  const { key, name } = principalKey(o, a);
  const kParts = key.split(".");
  const nParts = name.split("-");
  check(
    `round-trips ("${o}","${a}")`,
    kParts.length === 2 && kParts[0] === o && kParts[1] === a && nParts.length === 2 && nParts[0] === o && nParts[1] === a,
  );
}

if (failures) {
  console.error(`principal-key smoke: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("principal-key smoke: all checks passed");
process.exit(0);
