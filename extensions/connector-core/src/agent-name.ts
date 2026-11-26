/**
 * An agent's display name and label on its `agent` endpoint (SPEC 13.22): the `set-name` and
 * `set-label` handlers. `set-name` changes `card.name`, `set-label` the `ai.cotal.label` shown in its
 * place, and each republishes presence at once. The principal, and every subject, durable and grant
 * keyed by it, stays as it is.
 */
import {
  AGENT_CONTRACTS, AGENT_LABEL_META_KEY, AGENT_NAME_REFUSED_DETAIL, EpEnvelopeError, assertValidLabel, assertValidName,
  type AgentNameRefusal, type CotalEndpoint, type EpErrorCode, type EpPrincipalCommandDef, type SetLabelIO, type SetNameIO,
} from "@cotal-ai/core";

export interface NameLane {
  readonly handlers: readonly EpPrincipalCommandDef[];
  /** Refuse every later `set-name` and `set-label` as `unavailable`. */
  close(): void;
}

const refused = (code: EpErrorCode, message: string, reason?: AgentNameRefusal) =>
  new EpEnvelopeError(code, message, reason ? [{ kind: AGENT_NAME_REFUSED_DETAIL, reason }] : undefined, "not-executed");

/** Serve `set-name` and `set-label` for `ep`. Calls run one at a time, so the check that a name is
 *  free and the change it allows are one step for this agent. Two agents can still take one name at
 *  once: the check reads presence, which is advisory (SPEC §6). `onNamed` runs once a `set-name` or
 *  `set-label` will succeed and before the card changes, so a label the agent is about to take from
 *  its first message never covers the owner's choice. */
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

  async function setLabel(label: string): Promise<SetLabelIO> {
    try {
      assertValidLabel(label);
    } catch (e) {
      throw refused("bad-request", (e as Error).message);
    }
    if (closed) throw refused("unavailable", "this agent is stopping");
    onNamed?.();
    try {
      await ep.setCardMeta({ [AGENT_LABEL_META_KEY]: label });
    } catch (e) {
      // The card carries the label already, so the next heartbeat publishes it.
      warn(`set-label: presence did not take "${label}" yet: ${(e as Error).message}`);
    }
    return { label };
  }

  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run);
    tail = next.catch(() => {});
    return next;
  };
  return {
    handlers: [
      { command: "set-name", contract: AGENT_CONTRACTS["set-name"], handler: (ctx) => inTurn(() => setName((ctx.request.args as unknown as SetNameIO).name)) },
      { command: "set-label", contract: AGENT_CONTRACTS["set-label"], handler: (ctx) => inTurn(() => setLabel((ctx.request.args as unknown as SetLabelIO).label)) },
    ],
    close() {
      closed = true;
    },
  };
}
