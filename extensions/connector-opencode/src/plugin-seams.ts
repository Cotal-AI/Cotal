// The OpenCode plugin's shared seams, moved verbatim from plugin.ts. plugin.ts re-exports the public
// names so importers keep their paths.
import { formatInjection, type MeshAgent } from "@cotal-ai/connector-core";

export function log(msg: string): void {
  process.stderr.write(`[cotal-connector] ${msg}\n`);
}

/** The machine-stable half of the retirement line. The suite asserts on THIS, never on the sentence
 *  around it: a guard keyed on human prose dies the first time someone rewords a log message, and it
 *  dies silently, which is the failure mode a guard exists to prevent. Reword the sentence freely;
 *  do not change this token without updating the cells that import it. */
export const SESSION_RETIRED = "opencode-session-retired";
/** A bounded wait gave up. Exported so a cell keys on the token rather than on the sentence. */
export const SETTLE_ABANDONED = "opencode-settle-abandoned";
/** A retired session's write-ahead log was removed. Exported for the same reason as the two above:
 *  a cell keys on the token, never on the sentence around it. */
export const WAL_REAPED = "opencode-wal-reaped";
/** A retired session's write-ahead log was KEPT, and the line says which of the reasons applied.
 *  This is the token the reaping cell grades, because the lifetime is the claim and the deletion is
 *  only the easy half of it. */
export const WAL_KEPT = "opencode-wal-kept";
/** The shared shape of a pre-join model refusal: `"<model>: <detail>. Refusing before join"`.
 *  Exported so the 2.x adapter's own check (a different route, `/api/model`) produces the same
 *  sentence shape as `verifyServerModel` below without duplicating it. */
export function modelRefusalSentence(selectedModel: string, detail: string): string {
  return `${selectedModel}: ${detail}. Refusing before join`;
}
export async function verifyServerModel(serverUrl: string, serverAuth: string, selectedModel: string): Promise<void> {
  const response = await fetch(`${serverUrl}/provider`, {
    headers: { authorization: serverAuth },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`opencode connector: server /provider returned HTTP ${response.status} while checking model ${selectedModel}`);
  const listing = await response.json() as { all?: Array<{ id?: string; models?: Record<string, unknown> }> };
  const slash = selectedModel.indexOf("/");
  const provider = selectedModel.slice(0, slash);
  const model = selectedModel.slice(slash + 1);
  if (slash < 1 || !model || !listing.all?.some((entry) => entry.id === provider && Object.hasOwn(entry.models ?? {}, model)))
    throw new Error(modelRefusalSentence(selectedModel, "CLI opencode models --pure --verbose may list it; server /provider does not"));
}
/**
 * How long one swap step may hold the chain, or a teardown may hold the process, before it is
 * abandoned out loud rather than waited on forever.
 *
 * A GENUINE-HANG BACKSTOP, deliberately far above normal settle latency. The distance is the point:
 * a bound near normal latency would fire on steps that were merely slow, and releasing those early
 * is the cost the distance buys down. It does NOT drop them, because nothing here cancels: a
 * released step keeps running and can publish late and out of order. The
 * measure comes from a cell rather than a guess: `reset:the /new drain puts the old session's tail
 * and its close ON THE WIRE` asserts that a whole drain, flush plus run close plus settle plus the
 * broker round trip, AND a read-back of the subject both complete inside the 2s the suite waits.
 * So a healthy settle in that fixture is comfortably under two seconds and this is five times that.
 * Reaching it is treated as a hang; it is NOT proof the step will never return. A broker or network
 * pause can outlast the bound and then recover, which is exactly why the abandoned step is left
 * uncancelled and may still publish afterwards.
 */
export const SWAP_SETTLE_MS = 10_000;
/**
 * How long teardown waits for interactive work it ALREADY ADMITTED before it attempts departure.
 *
 * DERIVED, NOT PICKED. It has to be under the shortest runtime grace window, which is 1.5s for tmux
 * and cmux against 3s for the built-in pty, because a stop that spends longer than that waiting is a
 * stop whose offline publish is killed before it lands. That is the failure the publish-before-join
 * ordering exists to prevent, so a bound above the grace window would reintroduce it here. 1s leaves
 * room for the publish itself, and what it waits on is one presence round trip or one tool call, not
 * an event drain: those are excluded and joined afterwards.
 */
export const INTAKE_SETTLE_MS = 1_000;

/**
 * Races `work` against a `ms` timeout so a stuck settle is abandoned out loud rather than waited on
 * forever (see the note at its call sites in `quiesce`). Exported: the 2.x adapter's own teardown
 * uses the same bounded-settle shape rather than a second copy of it.
 */
async function settleWithin(work: Promise<unknown> | undefined, ms: number, what: string): Promise<boolean> {
  if (work === undefined) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    const settled = await Promise.race([work.then(() => true, () => true), expired]);
    if (!settled)
      log(
        `${SETTLE_ABANDONED} ${what} did not settle within ${ms}ms, so it is abandoned: the WAIT ` +
          `stopped, the work did not, and nothing here can cancel it. It may still publish, ` +
          `possibly after frames from whatever replaced it, and a run it had open may stay open. ` +
          `Ordering is guaranteed for a step that settles inside the bound, not for this one. The ` +
          `plane continues rather than wedging every later step behind it.`,
      );
    return settled;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
export { settleWithin };

/**
 * The buffered-inbox + pending-run-turn composition that goes out ahead of a native prompt, read by
 * {@link SurfacedBatch.inject}. Returns `undefined` when there is nothing to prepend.
 */
function computeInjection(agent: MeshAgent): {
  prefix: string;
  surfacedIds: string[];
  turnIds: string[];
} | undefined {
  const items = agent.peekInbox("automatic");
  const turnPeek = agent.peekPendingTurns();
  if (items.length === 0 && !turnPeek) return undefined;
  const inj = items.length > 0 ? formatInjection(items) : undefined;
  if (!inj && !turnPeek) return undefined;
  const prefix = [inj, turnPeek?.text].filter(Boolean).join("\n\n");
  return { prefix, surfacedIds: inj ? items.map((i) => i.recvKey) : [], turnIds: turnPeek?.goalIds ?? [] };
}

/**
 * The inbox batch a turn carries, by receive key: THE SEAT'S ACK BOUNDARY, defined here once and
 * driven by both adapters (the 1.x hooks below and `plugin2.ts`), so they cannot drift on what is
 * acked when a turn ends and what is left to redeliver. A batch is surfaced into a turn and held in
 * flight while it runs; the turn's end acks it when the turn finished or was stopped, and releases
 * it when the turn failed. It is OPEN from the surface until that end, and a native prompt carries
 * nothing while it is: its deliveries are still in the inbox, so a second batch would carry them
 * again and settle them with a turn that never ran them.
 */
export class SurfacedBatch {
  private carried: string[] = [];
  private inTurn = false;

  constructor(private readonly agent: MeshAgent) {}

  /** A surfaced batch's turn has not ended yet. */
  get open(): boolean {
    return this.inTurn;
  }

  /** The receive keys the batch carries. */
  get keys(): readonly string[] {
    return this.carried;
  }

  /** Make `keys` the batch, HELD IN FLIGHT for as long as its turn runs. A turn outlasting the
   *  consumer's ack wait is ordinary, and while the batch is held the agent restarts that wait, so
   *  the broker does not hand a role request this seat is still working on to another reader of its
   *  role. Refused at the hold ceiling, and then nothing may be surfaced. */
  surface(keys: string[]): boolean {
    if (!this.agent.holdInFlight(keys)) return false;
    this.agent.releaseInFlight(this.carried);
    this.carried = keys;
    this.inTurn = true;
    return true;
  }

  /** Carry the buffered inbox and pending run turns into a native prompt, returning the prefix that
   *  goes ahead of its text, or `undefined` when there is nothing to carry or a batch is open. The
   *  inbox keys it carries become the open batch; run turns alone open none, having nothing to ack.
   *  The prompt running with the prefix in place IS the delivery, so the run turns commit here. */
  inject(): string | undefined {
    if (this.inTurn) return undefined;
    const computed = computeInjection(this.agent);
    if (!computed) return undefined;
    if (computed.surfacedIds.length > 0 && !this.surface(computed.surfacedIds)) return undefined;
    if (computed.turnIds.length) this.agent.commitSurfacedTurns(computed.turnIds);
    return computed.prefix;
  }

  /** Ack exactly the surfaced deliveries by their receive keys (#624: an id-less item's wire id
   *  would be "", unaddressable). Overflow may already have removed some; MeshAgent marks every
   *  confirmed delivery handled while only acking entries still present. */
  ack(): void {
    if (this.carried.length > 0) this.agent.drainInboxDeliveries(this.carried);
    this.abandon();
  }

  /** Stop holding the batch: its deliveries are no longer renewed, so whatever is still unacked
   *  redelivers once its ack wait runs out. */
  abandon(): void {
    this.agent.releaseInFlight(this.carried);
    this.carried = [];
    this.inTurn = false;
  }
}
