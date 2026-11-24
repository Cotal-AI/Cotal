/**
 * An agent's display name (SPEC 13.22): the `set-name` handler on its `agent` endpoint, and the one
 * queue that both it and the agent's naming from its first message change the name through. A change
 * sets `card.name` and republishes presence at once. The principal, and every subject, durable and
 * grant keyed by it, stays as it is.
 */
import {
  AGENT_CONTRACTS, AGENT_NAME_REFUSED_DETAIL, EpEnvelopeError, assertValidName,
  type AgentNameRefusal, type CotalEndpoint, type EpErrorCode, type EpPrincipalCommandDef, type SetNameIO,
} from "@cotal-ai/core";

export interface NameLane {
  readonly handler: EpPrincipalCommandDef;
  /** Give the agent `name` as `set-name` would, after every call already queued, unless an owner's
   *  `set-name` succeeded first or `signal` aborted by its turn. Resolves whether the agent took it,
   *  and rejects as `set-name` refuses. The agent's naming from its first message calls it, so an
   *  owner's name is never overwritten. */
  nameSelf(name: string, signal?: AbortSignal): Promise<boolean>;
  /** Refuse every later `set-name` as `unavailable`. */
  close(): void;
}

const refused = (code: EpErrorCode, message: string, reason?: AgentNameRefusal) =>
  new EpEnvelopeError(code, message, reason ? [{ kind: AGENT_NAME_REFUSED_DETAIL, reason }] : undefined, "not-executed");

/** Serve `set-name` for `ep`. Calls run one at a time, so the check that a name is free and the
 *  change it allows are one step for this agent. Two agents can still take one name at once: the
 *  check reads presence, which is advisory (SPEC §6). `onOwnerNamed` runs after each `set-name` that
 *  succeeds. */
export function createNameLane(ep: CotalEndpoint, warn: (msg: string) => void, onOwnerNamed?: () => void): NameLane {
  let closed = false;
  let ownerNamed = false;
  let tail: Promise<unknown> = Promise.resolve();
  const queue = <T>(step: () => Promise<T>): Promise<T> => {
    const run = tail.then(step);
    tail = run.catch(() => {});
    return run;
  };

  async function takenBy(name: string): Promise<string | undefined> {
    let roster;
    try {
      roster = await ep.readPresence();
    } catch (e) {
      throw refused("unavailable", `the agent could not read who is present, so it cannot tell whether the name is free: ${(e as Error).message}`);
    }
    // The comparison @mentions resolve by (SPEC §5), so no rename makes a mention ambiguous.
    const want = name.toLowerCase();
    return roster.find((p) => p.status !== "offline" && p.card.id !== ep.card.id && p.card.name.toLowerCase() === want)?.card.id;
  }

  function assertName(name: string): void {
    try {
      assertValidName(name);
    } catch (e) {
      throw refused("bad-request", (e as Error).message, "name-invalid");
    }
  }

  async function setName(name: string): Promise<SetNameIO> {
    assertName(name);
    if (closed) throw refused("unavailable", "this agent is stopping");
    await apply(name);
    ownerNamed = true;
    onOwnerNamed?.();
    return { name: ep.card.name };
  }

  async function apply(name: string): Promise<void> {
    if (ep.card.name === name) return;
    const holder = await takenBy(name);
    if (holder !== undefined) throw refused("already-exists", `the live agent ${holder} is named ${JSON.stringify(name)}`, "name-taken");
    try {
      await ep.setCardName(name);
    } catch (e) {
      // The card carries the name already, so the next heartbeat publishes it.
      warn(`set-name: presence did not take "${name}" yet: ${(e as Error).message}`);
    }
  }

  return {
    handler: {
      command: "set-name",
      contract: AGENT_CONTRACTS["set-name"],
      handler: (ctx) => queue(() => setName((ctx.request.args as unknown as SetNameIO).name)),
    },
    nameSelf: (name, signal) => queue(async () => {
      if (ownerNamed || signal?.aborted) return false;
      assertName(name);
      await apply(name);
      return true;
    }),
    close() {
      closed = true;
    },
  };
}
