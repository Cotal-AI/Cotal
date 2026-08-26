/**
 * `CotalEndpoint.actorIsEphemeral` — does this endpoint's principal survive a restart?
 *
 * WHY THIS EXISTS AS ITS OWN SUITE. The connector layer refuses to derive an agent's event channel
 * from an ephemeral actor, and that refusal is the condition on the whole channel re-key: the
 * channel keys on (owner, actor), so a self-minted actor would produce a different channel on every
 * launch and could never match a grant minted in advance. But a self-minted actor is a perfectly
 * WELL-FORMED token — `randomUUID()` with the dashes stripped is `[a-z0-9]+` — so no validation rule
 * can catch it downstream. The only thing standing between "refuse the mode" and "silently publish
 * to a channel nobody can read" is this one boolean, and until this suite existed nothing graded it.
 * A mutation setting it to a constant `false` was invisible to every other suite in the repo.
 *
 * THE CONTROLS ARE THE POINT. A flag hard-wired to `true` refuses every session and satisfies the
 * first cell alone; a flag hard-wired to `false` satisfies all the others. Both arms are asserted,
 * and the ephemeral arm additionally proves the INSTABILITY IT NAMES — two endpoints built from the
 * identical options get different actors — rather than trusting the label. A cell that only checked
 * the boolean would pass for a flag that was set correctly by accident on a stable actor.
 *
 * No broker: this grades CONSTRUCTION. The principal is decided in the constructor, before any
 * connection, which is also why a caller can refuse the mode before launching anything.
 *
 * KILL SET, as names:
 *   M4  pin the flag to `false` — kills "an endpoint with no id, no actor and no creds reports an
 *       EPHEMERAL actor". This is the mutation the rest of the repo could not see, and the one that
 *       would ship a silently unaddressable event channel.
 *   M5  pin it to `true` — kills "a declared card.id makes the actor STABLE". The controls exist
 *       for exactly this: a flag that refuses everything satisfies M4's cell perfectly.
 *
 * Run: pnpm smoke:actor-ephemeral
 */
import { CotalEndpoint, DEV_OWNER } from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++; else { fail++; console.log("  x FAIL:", n, extra ?? ""); }
};

const ep = (card: Record<string, unknown>, rest: Record<string, unknown> = {}) =>
  new CotalEndpoint({ space: "eph", card: { name: "probe", kind: "agent", ...card }, ...rest } as never);

// ── THE EPHEMERAL ARM: no declared actor, no id, no creds ────────────────────────────────────
{
  const a = ep({});
  const b = ep({});
  c("an endpoint with no id, no actor and no creds reports an EPHEMERAL actor", a.actorIsEphemeral === true, a.actorIsEphemeral);
  c("its owner still defaults to the dev owner", a.principal.owner === DEV_OWNER, a.principal.owner);
  // The cell that proves the flag names a real instability rather than describing one. If actors
  // were in fact stable here, the refusal downstream would be costing operators a working feature
  // for nothing — and if they are unstable, no channel derived from them can ever match a grant.
  c("and the actor really IS unstable: identical options give two different actors",
    a.principal.actor !== b.principal.actor, [a.principal.actor, b.principal.actor]);
}

// ── THE STABLE ARMS, each a CONTROL for the refusal above ────────────────────────────────────
{
  const withId = ep({ id: "UABC123" });
  c("a declared card.id makes the actor STABLE", withId.actorIsEphemeral === false, withId.actorIsEphemeral);
  c("and the actor is that id", withId.principal.actor === "UABC123", withId.principal.actor);

  // A declared actor is stable even with no id and no creds — the id and the actor are different
  // slots, and treating "no id" as "no identity" would refuse a session that has one.
  const withActor = ep({ actor: "reviewer" });
  c("a declared card.actor is STABLE even with no id", withActor.actorIsEphemeral === false, withActor.actorIsEphemeral);
  c("and it wins over the self-minted connection id", withActor.principal.actor === "reviewer", withActor.principal.actor);

  const withOwner = ep({ id: "UABC123", owner: "u_alice" });
  c("a declared owner is carried through", withOwner.principal.owner === "u_alice", withOwner.principal.owner);
}

// ── USER MODE: the actor is SERVER-AUTHORED, never self-minted ───────────────────────────────
//    The connection id here IS ephemeral (a per-connect inbox nonce), which is exactly the trap:
//    reading "the connection id is random" as "the principal is random" would refuse every
//    user-mode session, the mode with the strongest identity in the system.
{
  const user = ep(
    { owner: "u_alice", actor: "reviewer" },
    { bearer: () => Promise.resolve("t"), sentinelCreds: "creds" },
  );
  c("a user-mode endpoint reports a STABLE actor", user.actorIsEphemeral === false, user.actorIsEphemeral);
  c("its principal is the declared owner+actor, not the inbox nonce",
    user.principal.owner === "u_alice" && user.principal.actor === "reviewer", user.principal);
}

console.log(`actor-ephemeral smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
