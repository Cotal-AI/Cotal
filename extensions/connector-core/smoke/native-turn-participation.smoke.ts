import assert from "node:assert/strict";
import { MeshAgent, type NativeTurnParticipationLease } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";

const now = Date.now();
const config: AgentConfig = {
  space: "native", name: "personal", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
  lifecycleUid: "l".repeat(26), turnRelay: false, subscribe: [], allowSubscribe: [], allowPublish: [],
  userAuth: { owner: "owner", actor: "actor", sentinelCreds: "fixture", bearerCmd: ["false"] },
};
const agent = new MeshAgent(config);
(agent as unknown as { ep: unknown }).ep = {
  principal: { owner: "owner", actor: "actor" },
  serviceRailCaller: () => ({ owner: "owner", actor: "actor", uid: config.lifecycleUid }),
  tap: () => {},
};
const valid = (overrides: Partial<NativeTurnParticipationLease> = {}): NativeTurnParticipationLease => ({
  owner: "owner", actor: "actor", lifecycleUid: config.lifecycleUid!, name: config.name,
  managerInstanceId: "m".repeat(26), expiresAt: now + 60_000, ...overrides,
});

assert.equal(agent.peekPendingTurns(), undefined);
assert.match((await agent.yieldTurn("done")).error ?? "", /no valid workflow turn participation lease/);
for (const mismatch of [
  { owner: "other" }, { actor: "other" }, { lifecycleUid: "x".repeat(26) }, { name: "other" },
]) assert.throws(() => agent.authorizeNativeTurnParticipation(valid(mismatch)), /does not bind/);
assert.throws(() => agent.authorizeNativeTurnParticipation(valid({ expiresAt: now - 1 })), /expired/);
agent.authorizeNativeTurnParticipation(valid());
assert(agent.nativeTurnParticipationExpiresAt()! > now);
assert.throws(() => agent.authorizeNativeTurnParticipation(valid({ managerInstanceId: "n".repeat(26) })), /cannot change/);

const active = (agent as unknown as { activeTurns: Map<string, unknown> }).activeTurns;
active.set("goal-native", { goalId: "goal-native", payload: JSON.stringify({ context: "native work" }), acceptedAt: now, deadlineAt: now + 30_000, surfaced: false });
const peek = agent.peekPendingTurns();
assert(peek?.text.includes("native work"));
assert.deepEqual(peek?.goalIds, ["goal-native"]);

(agent as unknown as { nativeTurnLease: NativeTurnParticipationLease }).nativeTurnLease = valid({ expiresAt: now - 1 });
assert.equal(agent.peekPendingTurns(), undefined);
assert.match((await agent.yieldTurn("done", { turn: "goal-native" })).error ?? "", /no valid workflow turn participation lease/);

console.log("NATIVE TURN PARTICIPATION TESTS PASSED");
