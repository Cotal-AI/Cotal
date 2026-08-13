/**
 * The two properties `confirmAttach` rests on, neither of which a successful attach can show.
 *
 * A happy-path suite cannot see either. An alias-scan lookup attaches correctly for the principal
 * that put the bytes, and a possession row reaped at retirement is invisible until a message is
 * delayed across a respawn. So both get ADVERSARIAL cells: the state a correct implementation
 * refuses, constructed on purpose.
 *
 * Run: pnpm smoke:artifact-index
 */
import {
  possessionKey, parsePossessionKey, attachmentKey, digestKeyToken,
  possessionBucket, attachmentBucket, readPossession,
} from "../src/artifact-index.js";
import { aclKey } from "../src/subjects.js";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

const D = "sha256:" + "ab".repeat(32);
const D2 = "sha256:" + "cd".repeat(32);
const ALICE = "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.agent";
// Lifecycle tokens are `[a-z0-9]{26,32}` — the shipped validator rejected an uppercase fixture on
// this suite's first run, which is the validator doing its job on my test rather than the reverse.
const LC_A = "01h" + "z".repeat(22) + "a";   // the incarnation that put the bytes
const LC_B = "01h" + "z".repeat(22) + "b";   // a SUCCESSOR under the same alias

// A KV double that records every key it is asked for — so a cell can assert HOW the store was
// queried, not merely what came back. An alias scan and an exact read return the same answer on the
// happy path; they differ only in what they ask for.
const makeKv = () => {
  const data = new Map<string, Uint8Array>();
  const tombstones = new Set<string>();
  const gets: string[] = [];
  return {
    data, gets,
    // FAITHFUL TO THE REAL KV, and this matters more than it looks. A real `get()` on a DELETED key
    // returns an entry with `operation: "DEL"`, NOT null — measured. A double that returns null for
    // deleted keys is MORE FORGIVING than the thing it doubles, and a presence check written against
    // it passes while being wrong against a broker. That is exactly what happened here.
    async get(key: string) {
      gets.push(key);
      if (tombstones.has(key)) return { operation: "DEL", value: new Uint8Array() };
      const v = data.get(key);
      return v ? { operation: "PUT", value: v } : null;
    },
    put(key: string) { data.set(key, new Uint8Array([1])); tombstones.delete(key); },
    del(key: string) { data.delete(key); tombstones.add(key); },
    // A real NATS KV can enumerate. The double carries it so an ALIAS-SCAN mutation can be written
    // against the READ PATH ALONE — without planting extra rows, which would move the fixture as
    // well as the code and make the kill set answer a two-variable question.
    async keys(prefix: string) { return [...data.keys()].filter((k) => k.startsWith(prefix)); },
  };
};

console.log("artifact index: possession + attachment keys\n");

// ---- P1 — THE FENCE: a successor's exact-key read MISSES its predecessor's row -----------------
// This is the single property standing between a same-alias successor and its predecessor's attach.
{
  const kv = makeKv();
  kv.put(possessionKey(D, ALICE, LC_A));
  const asA = await readPossession(kv, D, ALICE, LC_A);
  const asB = await readPossession(kv, D, ALICE, LC_B);
  check("P1a the lifecycle that put the bytes reads its own row", asA === true);
  check("P1b a SUCCESSOR under the same alias does NOT — the fence holds", asB === false,
    { key: possessionKey(D, ALICE, LC_B) });
}

// ---- P2 — the lookup is EXACT-KEY, not a scan --------------------------------------------------
// An alias-scan implementation passes P1a and would pass P1b only by accident. This asserts the
// SHAPE of the query: exactly one get, for exactly the lifecycle-qualified key.
{
  const kv = makeKv();
  kv.put(possessionKey(D, ALICE, LC_A));
  kv.gets.length = 0;
  await readPossession(kv, D, ALICE, LC_B);
  check("P2a exactly one store read — not an enumeration", kv.gets.length === 1, kv.gets);
  check("P2b and it names the LIFECYCLE-qualified key",
    kv.gets[0] === possessionKey(D, ALICE, LC_B), kv.gets[0]);
  check("P2c which is not the predecessor's key",
    kv.gets[0] !== possessionKey(D, ALICE, LC_A), kv.gets[0]);
}

// ---- P3 — POSSESSION OUTLIVES RETIREMENT -------------------------------------------------------
// Retirement tears down the ACL row. Possession lives in its OWN bucket, so that teardown cannot
// reach it — which is what lets a delayed message still attach after its publisher is gone. If
// these ever shared a bucket, a lifecycle-scoped sweep would reap possession as collateral and
// re-fire the branch this design exists to close.
{
  check("P3a possession and ACL are DIFFERENT buckets", possessionBucket("main") !== "cotal_acl_main",
    possessionBucket("main"));
  check("P3b possession and attachment are different buckets too",
    possessionBucket("main") !== attachmentBucket("main"));
  // A lifecycle-scoped ACL delete names the ACL key. Assert it cannot name a possession key —
  // the two grammars must not collide, or an exact-key delete grant would span both.
  const acl = aclKey(ALICE, LC_A);
  const poss = possessionKey(D, ALICE, LC_A);
  check("P3c an exact-key ACL delete cannot name a possession row", acl !== poss, { acl, poss });
  // And the possession key is not even a suffix/prefix of the ACL key, so a prefix-scoped grant
  // over ACL keys cannot sweep it either.
  check("P3d nor can a prefix-scoped ACL grant reach it",
    !poss.startsWith(acl) && !acl.startsWith(poss), { acl, poss });
}

// ---- P5 — A DELETED ROW IS ABSENT, not "an object came back" ------------------------------------
// The defect this cell exists for: `get()` returns a DEL entry rather than null, so `e !== null`
// reads a tombstone as presence. A revoked or reaped possession would then authorize attaches
// forever. Found against a real broker, after the original double hid it by returning null.
{
  const kv = makeKv();
  kv.put(possessionKey(D, ALICE, LC_A));
  check("P5a a PUT row reads as present", await readPossession(kv, D, ALICE, LC_A) === true);
  kv.del(possessionKey(D, ALICE, LC_A));
  check("P5b a DELETED row reads as ABSENT — a tombstone is not presence",
    await readPossession(kv, D, ALICE, LC_A) === false);
}

// ---- P4 — key grammar round-trips and does not alias distinct principals ------------------------
{
  const k = possessionKey(D, ALICE, LC_A);
  const p = parsePossessionKey(k);
  check("P4a a possession key round-trips", p?.principal === ALICE && p?.lifecycleUid === LC_A, p);
  check("P4b a different digest is a different key", possessionKey(D2, ALICE, LC_A) !== k);
  check("P4c a different lifecycle is a different key", possessionKey(D, ALICE, LC_B) !== k);
  check("P4d a malformed digest is refused rather than tokenised into something else",
    (() => { try { digestKeyToken("not-a-digest"); return false; } catch { return true; } })());
  check("P4e attachment keys are per-channel", attachmentKey(D, "general") !== attachmentKey(D, "other"));
}

console.log(`\nartifact-index: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
