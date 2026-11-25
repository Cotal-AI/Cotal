/**
 * An agent's display name on its `agent` endpoint (SPEC 13.22): the `set-name` handler. It changes
 * `card.name` and republishes presence at once. The principal, and every subject, durable and grant
 * keyed by it, stays as it is.
 */
import {
  AGENT_CONTRACTS, AGENT_LABEL_META_KEY, AGENT_NAME_REFUSED_DETAIL, EpEnvelopeError, assertValidName,
  type AgentNameRefusal, type CotalEndpoint, type EpErrorCode, type EpPrincipalCommandDef, type SetNameIO,
} from "@cotal-ai/core";

export interface NameLane {
  readonly handler: EpPrincipalCommandDef;
  /** Refuse every later `set-name` as `unavailable`. */
  close(): void;
}

const refused = (code: EpErrorCode, message: string, reason?: AgentNameRefusal) =>
  new EpEnvelopeError(code, message, reason ? [{ kind: AGENT_NAME_REFUSED_DETAIL, reason }] : undefined, "not-executed");

/** Serve `set-name` for `ep`. Calls run one at a time, so the check that a name is free and the
 *  change it allows are one step for this agent. Two agents can still take one name at once: the
 *  check reads presence, which is advisory (SPEC §6). `onNamed` runs once a `set-name` will succeed
 *  and before the card changes, so a label the agent is about to take never covers the owner's name. */
export function createNameLane(ep: CotalEndpoint, warn: (msg: string) => void, onNamed?: () => void): NameLane {
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();

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

  async function setName(name: string): Promise<SetNameIO> {
    try {
      assertValidName(name);
    } catch (e) {
      throw refused("bad-request", (e as Error).message, "name-invalid");
    }
    if (closed) throw refused("unavailable", "this agent is stopping");
    if (ep.card.name !== name) {
      const holder = await takenBy(name);
      if (holder !== undefined) throw refused("already-exists", `the live agent ${holder} is named ${JSON.stringify(name)}`, "name-taken");
    }
    onNamed?.();
    if (ep.card.name === name && ep.card.meta?.[AGENT_LABEL_META_KEY] === undefined) return { name };
    try {
      // A label the agent took from its first message is shown in place of the name, so it goes too.
      await ep.setCardName(name, { [AGENT_LABEL_META_KEY]: undefined });
    } catch (e) {
      // The card carries the name already, so the next heartbeat publishes it.
      warn(`set-name: presence did not take "${name}" yet: ${(e as Error).message}`);
    }
    return { name: ep.card.name };
  }

  return {
    handler: {
      command: "set-name",
      contract: AGENT_CONTRACTS["set-name"],
      handler: (ctx) => {
        const run = tail.then(() => setName((ctx.request.args as unknown as SetNameIO).name));
        tail = run.catch(() => {});
        return run;
      },
    },
    close() {
      closed = true;
    },
  };
}
