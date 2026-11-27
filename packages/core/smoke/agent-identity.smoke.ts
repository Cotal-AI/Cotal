import assert from "node:assert/strict";
import {
  agentIdentityKey, assertLifecycleToken, decideAgentLink, EpEnvelopeError, mintAgentUid,
  mintedAgentIdentity, mintLifecycleUid, parseAgentIdentityRecord,
  type AgentLinkRequest, type EpErrorCode,
} from "../src/index.js";

let cases = 0;
const failed: string[] = [];
const check = (name: string, fn: () => void): void => {
  try { fn(); cases++; } catch (e) { failed.push(name); console.error(`FAIL ${name}`, e); }
};
const refuses = (fn: () => unknown, code: EpErrorCode, reason?: RegExp): void => {
  assert.throws(fn, (e: unknown) => e instanceof EpEnvelopeError && e.code === code && (!reason || reason.test(e.message)));
};
const OWNER = `u_${"a".repeat(26)}`;
const OTHER_OWNER = `u_${"b".repeat(26)}`;
const T0 = 1_800_000_000_000;
const T = T0 + 3_600_000;
const agentUid = mintAgentUid();
const firstRun = { lifecycleUid: mintLifecycleUid(), actor: "builder" };
const mintArgs = { agentUid, owner: OWNER, ...firstRun, now: T0 };
const minted = mintedAgentIdentity(mintArgs);
const relaunch = { lifecycleUid: mintLifecycleUid(), actor: "builder_2" };
const request = (over: Partial<AgentLinkRequest> = {}): AgentLinkRequest =>
  ({ agentUid, owner: OWNER, authority: "owner", ...relaunch, predecessor: "settled", now: T, ...over });

check("agentUid grammar is disjoint from lifecycle UIDs", () => {
  const drawn = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const uid = mintAgentUid();
    assert.match(uid, /^ag_[a-z2-7]{26}$/);
    assert.throws(() => assertLifecycleToken(uid));
    drawn.add(uid);
  }
  assert.equal(drawn.size, 1000);
  assert.equal(agentIdentityKey(agentUid), `agentid.${agentUid}`);
  for (const bad of [mintLifecycleUid(), agentUid.toUpperCase(), `${agentUid}x`, "ag_", `ag_${"1".repeat(26)}`, OWNER])
    assert.throws(() => agentIdentityKey(bad));
});

check("a minted identity starts linked to the first run", () => {
  assert.deepEqual(minted, {
    v: 1, agentUid, owner: OWNER, state: "active", linkSeq: 1,
    current: { ...firstRun, linkedAt: T0, via: "mint" }, createdAt: T0,
  });
  assert.deepEqual(parseAgentIdentityRecord(`agentid.${agentUid}`, JSON.parse(JSON.stringify(minted))), minted);
});

check("mint refuses malformed inputs and static owners", () => {
  for (const over of [{ owner: "cli" }, { lifecycleUid: agentUid }, { actor: "a.b" }, { now: 0 }])
    assert.throws(() => mintedAgentIdentity({ ...mintArgs, ...over }));
});

check("the owner and an authorized launcher can link a fresh lifecycle", () => {
  for (const authority of ["owner", "launcher"] as const) {
    const result = decideAgentLink(minted, request({ authority }));
    assert.deepEqual(result, {
      changed: true,
      record: { ...minted, linkSeq: 2, current: { ...relaunch, linkedAt: T, via: authority } },
    });
    assert.equal(minted.linkSeq, 1);
    assert.deepEqual(minted.current, { ...firstRun, linkedAt: T0, via: "mint" });
  }
});

check("the ID and an exact run name do not grant link authority", () => {
  refuses(() => decideAgentLink(minted, request({ authority: "none", ...firstRun, predecessor: "live" })), "permission-denied", /not authorized/);
});

check("a run cannot link itself, including when renewing its own lifecycle", () => {
  refuses(() => decideAgentLink(minted, request({ authority: "agent" })), "permission-denied", /cannot link itself/);
  refuses(() => decideAgentLink(minted, request({ authority: "agent", ...firstRun, predecessor: "live" })), "permission-denied", /cannot link itself/);
});

check("link authorization is for the exact owner and identity", () => {
  for (const authority of ["owner", "launcher"] as const) {
    refuses(() => decideAgentLink(minted, request({ authority, owner: OTHER_OWNER, predecessor: "live" })), "permission-denied");
    refuses(() => decideAgentLink(minted, request({ authority, agentUid: mintAgentUid() })), "permission-denied");
  }
});

check("an authorized retry of the exact live enrollment changes nothing", () => {
  for (const authority of ["owner", "launcher"] as const) {
    const linked = decideAgentLink(minted, request({ authority })).record;
    assert.deepEqual(decideAgentLink(linked, request({ authority, now: T + 1000, predecessor: "live" })), { record: linked, changed: false });
  }
});

check("one live run per identity, even when a second launch uses its name", () => {
  refuses(() => decideAgentLink(minted, request({ predecessor: "live" })), "conflict");
  refuses(() => decideAgentLink(minted, request({ actor: firstRun.actor, predecessor: "live" })), "conflict");
  refuses(() => decideAgentLink(minted, request({ lifecycleUid: firstRun.lifecycleUid, predecessor: "live" })), "conflict");
});

check("an unknown predecessor blocks a new run and a retry", () => {
  refuses(() => decideAgentLink(minted, request({ predecessor: "unknown" })), "unavailable");
  refuses(() => decideAgentLink(minted, request({ ...firstRun, predecessor: "unknown" })), "unavailable");
});

check("a settled lifecycle cannot be reused", () => {
  refuses(() => decideAgentLink(minted, request({ ...firstRun })), "conflict");
});

check("a revoked identity does not link", () => {
  const revoked = parseAgentIdentityRecord(agentIdentityKey(agentUid), { ...minted, state: "revoked", revokedAt: T });
  refuses(() => decideAgentLink(revoked, request()), "failed-precondition", /revoked/);
  refuses(() => decideAgentLink(revoked, request({ ...firstRun, predecessor: "live" })), "failed-precondition", /revoked/);
  refuses(() => decideAgentLink(revoked, request({ authority: "none" })), "permission-denied");
});

check("a malformed launch is a bad request", () => {
  for (const over of [{ lifecycleUid: agentUid }, { actor: "a.b" }, { agentUid: "builder" }, { owner: "cli" }, { now: NaN }])
    refuses(() => decideAgentLink(minted, request(over)), "bad-request");
});

check("a stored record outside the closed shape never authorizes", () => {
  const key = agentIdentityKey(agentUid);
  const { current, ...noCurrent } = minted;
  const bad: unknown[] = [
    { ...minted, extra: 1 }, { ...minted, v: 2 }, { ...minted, state: "paused" }, { ...minted, revokedAt: T },
    { ...minted, state: "revoked" }, { ...minted, linkSeq: 0 }, { ...minted, owner: "cli" },
    { ...minted, key: {} }, { ...minted, keyEpoch: 0 }, { ...minted, current: { ...current, via: "key" } },
    { ...minted, current: { ...current, tokenHash: "0".repeat(64) } }, { ...minted, current: { ...current, lifecycleUid: [firstRun.lifecycleUid] } },
    { ...minted, agentUid: mintAgentUid() }, noCurrent, Object.create(minted), null, [],
  ];
  for (const raw of bad) refuses(() => parseAgentIdentityRecord(key, raw), "failed-precondition");
  refuses(() => decideAgentLink({ ...minted, linkSeq: 0 }, request()), "failed-precondition");
});

console.log(`agent identity: ${cases} cases passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
