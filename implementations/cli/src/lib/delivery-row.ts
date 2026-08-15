/**
 * The ready card's DELIVERY row — the operator's answer to "is delivery actually working right now".
 *
 * WHY IT EXISTS: measured on this tree, no operator surface answers that question. `cotal status`
 * prints no delivery health row at all (its only mention is `managerHasDeliveryMarker()`, a BUILD
 * marker); `cotal doctor` checks `delivery.creds` as a FILE; `up.ts:2060` renders
 * `delivery: useAuth && deliveryUp()`, a pid boolean a SIGSTOPped daemon satisfies. Verified against
 * the SHIPPED artifact too (`cotal-ai@0.17.0`), not just the checkout, since the checkout is not
 * what runs on this box.
 *
 * SHAPE SETTLED, GRANT NOT. The row's structure below is final and mirrors `managerHealthRow`. What
 * is NOT settled is which credential profile can perform the read and the round-trip, and that is
 * deliberately a REQUIRED PARAMETER rather than a default — see {@link DeliveryRowDeps.mintCaller}.
 * Defaulting it would be the dangerous move, for a reason specific to this surface:
 *
 *   An UNDER-GRANTED caller does not fail loudly here. The lease read is denied, or the responder is
 *   unreachable, and the surface renders `no-responder` — "the daemon did not answer" — when the
 *   truth is "I was never permitted to ask." `connect.ts:301-312` documents exactly this: an
 *   instrument without instance-pinned rows is refused AT THE BROKER and the client sees a describe
 *   timeout. A wrong default would make this row state the precise falsehood the guard exists to
 *   prevent, and it would do it quietly.
 *
 * So the caller mint is injected, the measurement that picks it is registered in
 * a measurement kept outside this repo, and this module cannot be wired into the card until that
 * measurement names a profile. The unknown is held in one place instead of being spread as a guess.
 */
import { assessDeliveryHealth, type DeliveryHealth } from "@cotal-ai/core";
import { guardReport, observeOnce, renderGuard, type GuardSeams } from "./delivery-guard.js";

/** How fresh an observation must be to speak for "right now" on a card rendered once.
 *
 *  A one-shot render takes its observation microseconds before reporting it, so this bound is not
 *  doing real work TODAY — it is here so the row cannot later be fed a cached observation without
 *  the staleness rule applying to it. The card is the most likely future home of a cache. */
const CARD_FRESHNESS_MS = 5_000;

/** What the row needs from the world. `mintCaller` returns the seams for one health assessment, or a
 *  {@link CallerUnavailable} naming why it could not build one — never a bare `undefined`, because a
 *  bare absence is what let two different failures share one message. */
/** Why no caller could be built — the row's THIRD state, and it must name which failure occurred.
 *
 *  These are different facts about different subsystems and they were briefly collapsed into one:
 *  an unreachable broker rendered as "no caller credential could be built", which is a claim about
 *  our credentials for a failure that was about reachability. Measured against a dead port, so this
 *  is a repair to a reproduced defect and not a speculative distinction.
 *
 *  `no-credential` — we could not MINT. A fact about our own credentials.
 *  `unreachable`   — we minted fine and could not REACH the broker. A fact about the network or the
 *                    broker, and specifically NOT about the delivery daemon, which we never got
 *                    close enough to ask. */
export interface CallerUnavailable {
  condition: "no-credential" | "unreachable";
  detail: string;
}

/** Narrow the mint result. A caller is the thing that has a `check`; anything else is a refusal. */
function isCaller(r: Pick<GuardSeams, "check"> | CallerUnavailable): r is Pick<GuardSeams, "check"> {
  return typeof (r as Pick<GuardSeams, "check">).check === "function";
}

export interface DeliveryRowDeps {
  /** RESOLVED BY MEASUREMENT, and it stays injected. The arms (recorded outside this repo)
   *  drove each candidate against a real daemon on an ephemeral broker: `agent` → SERVING, `probe` →
   *  `refused`, **`control-caller-privileged` → `refused`** (the manager row's class, denied at the
   *  broker on the lease KV read), and `agent` against a SIGKILLed daemon → `no-responder`.
   *
   *  So the convenient reuse was the wrong one, and reusing it would have made this row report an
   *  unreachable daemon on a healthy mesh. `mintDeliveryCaller` (`delivery-caller.ts`) mints the
   *  agent-class caller the measurement selected. This stays a parameter rather than becoming a
   *  hardcoded default so the cells can drive the row's DECISION without a broker, and so the next
   *  change to the cred layer breaks a named seam instead of silently re-introducing the refusal. */
  mintCaller: () => Promise<Pick<GuardSeams, "check"> | CallerUnavailable>;
  now: () => number;
}

/** The row's verdict, kept separate from its rendering so the decision is testable without strings. */
export type DeliveryRow =
  /** No caller could be built. A statement about US — our credentials or our reach — and NEVER about
   *  the daemon, which was not asked. `condition` names WHICH of the two failed. */
  | { marker: "?"; kind: "no-caller"; condition: CallerUnavailable["condition"]; detail: string }
  /** An assessment completed. `health` carries its own verdict, affirmative or a named refusal. */
  | { marker: "✓" | "?"; kind: "assessed"; health: DeliveryHealth; text: string };

/** Build the delivery row.
 *
 *  ORDER IS THE POINT: the caller is minted FIRST, and a mint failure short-circuits to `no-caller`
 *  before any probe runs. Probing with a caller we know is broken would produce a timeout that reads
 *  as the daemon's fault. */
export async function deliveryRow(deps: DeliveryRowDeps): Promise<DeliveryRow> {
  const minted = await deps.mintCaller();
  if (!isCaller(minted))
    return {
      marker: "?",
      kind: "no-caller",
      condition: minted.condition,
      // The detail comes from the mint, which is the only layer that knows WHICH failure happened.
      // Composing it here from a fixed string is how the unreachable case came to describe itself as
      // a credential problem.
      detail: `cannot establish delivery health — ${minted.detail}. This says nothing about the daemon: it means this surface was never able to ask.`,
    };
  const caller = minted;

  const obs = await observeOnce({ check: caller.check, now: deps.now });
  const report = guardReport(obs, deps.now(), CARD_FRESHNESS_MS);
  return {
    // `✓` is reachable ONLY from an affirmative round-trip inside a current observation. Every other
    // path — any named refusal, any staleness — renders `?`, which is deliberately NOT dim: "cannot
    // establish" must not read as quietly fine.
    marker: report.reporting && report.health.serving ? "✓" : "?",
    kind: "assessed",
    health: obs.health,
    text: renderGuard(report),
  };
}

/** The row's text WITHOUT its marker.
 *
 *  Exists because the card renders the marker in its own column and needs the text alone. The
 *  obvious alternative — rendering the full line and slicing the marker back off — encodes the
 *  render format in a second place and silently truncates the message the moment a marker is not
 *  one character wide. On a surface whose entire purpose is to state a refusal precisely, quietly
 *  losing the first characters of that refusal is the worst available failure. */
export function deliveryRowText(row: DeliveryRow): string {
  return row.kind === "no-caller" ? row.detail : row.text;
}

/** The one-line operator rendering for the card. Composed from {@link deliveryRowText} so the marker
 *  and the text have exactly one definition between them. */
export function renderDeliveryRow(row: DeliveryRow): string {
  return `${row.marker} ${deliveryRowText(row)}`;
}

/** Assemble the seams for one assessment from an endpoint-like reader and prober.
 *
 *  Split out so the cred-class arms can drive the REAL assessment against each candidate profile
 *  without going through the card, and so the row's own cells never need a broker. */
export function deliverySeams(
  ep: { readDeliveryLease: (shard: number) => Promise<{ holder: string; since: number; ready: boolean } | undefined>; requestDeliveryHealthProbe: (deadlineMs: number) => Promise<unknown> },
  o: { shard: number; ttlMs: number; deadlineMs: number; now: () => number },
): Pick<GuardSeams, "check"> {
  return {
    check: (): Promise<DeliveryHealth> =>
      assessDeliveryHealth(o.shard, o.ttlMs, o.deadlineMs, {
        readLease: () => ep.readDeliveryLease(o.shard),
        probe: async (deadlineMs: number) => { await ep.requestDeliveryHealthProbe(deadlineMs); },
        now: o.now,
      }),
  };
}
