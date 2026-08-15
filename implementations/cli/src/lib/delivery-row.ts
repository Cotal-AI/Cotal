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
 * `.lane/credclass-predictions.md`, and this module cannot be wired into the card until that
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

/** What the row needs from the world.
 *
 *  `mintCaller` returns the seams for one health assessment, or `undefined` when no caller could be
 *  built at all — which is a fact about OUR credentials and is rendered as such, never as a fact
 *  about the daemon. That distinction is the same one `mintHealthCaller` already draws for the
 *  manager row, and it is the reason this is a nullable return rather than a throw. */
export interface DeliveryRowDeps {
  /** ⚠️ UNRESOLVED: which credential profile this mints is an OPEN QUESTION, pending the measurement
   *  in `.lane/credclass-predictions.md`. Read from `provision.ts:1440`, `control-caller-privileged`
   *  (what the manager row uses) carries NO delivery-lease read row and NO `ctl.delivery` publish, so
   *  reusing it is predicted to yield a refusal. The live suite drives an `agent`-profile caller
   *  green. **Do not resolve this by picking the convenient one — the arms decide it.** */
  mintCaller: () => Promise<Pick<GuardSeams, "check"> | undefined>;
  now: () => number;
}

/** The row's verdict, kept separate from its rendering so the decision is testable without strings. */
export type DeliveryRow =
  /** No caller could be built. A statement about our credentials, NOT about the daemon. */
  | { marker: "?"; kind: "no-auth"; detail: string }
  /** An assessment completed. `health` carries its own verdict, affirmative or a named refusal. */
  | { marker: "✓" | "?"; kind: "assessed"; health: DeliveryHealth; text: string };

/** Build the delivery row.
 *
 *  ORDER IS THE POINT: the caller is minted FIRST, and a mint failure short-circuits to `no-auth`
 *  before any probe runs. Probing with a caller we know is broken would produce a timeout that reads
 *  as the daemon's fault. */
export async function deliveryRow(deps: DeliveryRowDeps): Promise<DeliveryRow> {
  const caller = await deps.mintCaller();
  if (!caller)
    return {
      marker: "?",
      kind: "no-auth",
      detail:
        "cannot establish delivery health — no caller credential could be built. This says nothing about the daemon: it means this surface was never able to ask.",
    };

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

/** The one-line operator rendering for the card. */
export function renderDeliveryRow(row: DeliveryRow): string {
  return row.kind === "no-auth" ? `${row.marker} ${row.detail}` : `${row.marker} ${row.text}`;
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
