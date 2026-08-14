/**
 * The gate reconciler's AFFIRMATIVE freeze-holder check (Cotal #391), over the delivery daemon's
 * `ctl.delivery-admin` rail — the READ twin of {@link makeManagerEndpointEvictor}, and deliberately
 * shaped like it so the two guards of the same repair read the same way.
 *
 * The `$SYS` CONNZ capability lives with the DELIVERY DAEMON (co-located with the broker), never in
 * a seed-holding process — the same D5 rail-split the evictor obeys. This reaches it with a
 * per-call SCOPED `endpoint-evictor` credential: pub the delivery-admin subject + reply +
 * `$JS.API.INFO`, nothing else. That credential names eviction because it is the rail's existing
 * scope; the VERB it calls here is read-only, and the daemon-side executor opens only the CONNZ
 * observer cred — the kick-capable evictor cred is never read on that path.
 *
 * EVERY FAILURE IS A REFUSAL, NEVER A PASS. Unlike the evictor — whose no-oracle case throws so the
 * barrier fails closed — this returns a STRUCTURED verdict, because the reconciler must tell the
 * operator WHICH condition refused. The mapping is total and there is no branch that infers death:
 *   - a reachable daemon's `live` / `gone` / `unknown` verdict passes through as-is;
 *   - a daemon refusal, an unreachable rail, or a REQUEST TIMEOUT is `unestablishable` — a timeout
 *     is the canonical "absence of evidence", and reading it as death is the exact defect this
 *     command exists to avoid;
 *   - a garbled reply, or one that does not ECHO the principal asked about, is `unestablishable` —
 *     a result that does not verifiably describe THIS principal never authorizes.
 */
import { CotalEndpoint, mintCreds, newIdentity, parsePrincipalLivenessResult, type SpaceAuth } from "@cotal-ai/core";
import type { HolderLiveness } from "./reconcile-gate.js";

/**
 * Map a delivery-admin reply to the reconciler's verdict — the whole trust-boundary decision, as
 * ONE pure function so the rail probe and the tests exercise the SAME mapping rather than two
 * copies that can drift. Every non-verdict is `unestablishable`; nothing here can yield `gone`
 * except an oracle that affirmatively said so under a complete sweep.
 */
export function holderLivenessFromReply(data: unknown, principal: string): HolderLiveness {
  // Closed + ECHO-BOUND parse: the reply crosses a trust boundary, and one that describes a
  // different principal (or no principal) tells us nothing about ours.
  const parsed = parsePrincipalLivenessResult(data, principal);
  if (parsed === undefined)
    return {
      state: "unestablishable",
      detail: `garbled or foreign liveness result (${JSON.stringify(data ?? null)}); a result that does not verifiably describe "${principal}" never authorizes`,
    };
  // An internally CONTRADICTORY success never authorizes: `gone` is (sweep complete, none remain),
  // so `gone` under an incomplete sweep is a broken oracle, not a verdict.
  if (parsed.state === "gone" && parsed.sweepComplete !== true)
    return {
      state: "unestablishable",
      detail: "the oracle reported gone with sweepComplete=false; a contradictory result never authorizes",
    };
  return {
    state: parsed.state,
    detail: `delivery-daemon CONNZ sweep, sweepComplete=${String(parsed.sweepComplete)}${parsed.note ? `: ${parsed.note}` : ""}`,
  };
}

/** Build the reconciler's `probeHolder(principal) → verdict`. Per-call connection, exactly as the
 *  evictor does: a standing privileged connection would be a wider surface holding nothing. */
export function makeManagerHolderLivenessProbe(opts: {
  space: string;
  servers: string;
  auth: SpaceAuth;
  log: (line: string) => void;
}): (principal: string) => Promise<HolderLiveness> {
  return async (principal: string): Promise<HolderLiveness> => {
    const id = newIdentity();
    let ep: CotalEndpoint | undefined;
    try {
      const creds = await mintCreds(opts.auth, id, "endpoint-evictor", { expiresInSeconds: 60 });
      ep = new CotalEndpoint({
        space: opts.space,
        servers: opts.servers,
        creds,
        card: { id: id.id, name: "manager-holder-liveness", kind: "endpoint" },
        channels: [],
        consume: false,
        watchChannels: false,
        watchPresence: false,
        registerPresence: false,
      });
      ep.on("error", () => {});
      await ep.start();
      const r = await ep.requestDeliveryAdmin("principalLiveness", { principal }, 15_000);
      if (!r.ok)
        return {
          state: "unestablishable",
          detail: `the delivery daemon refused the liveness query: ${r.error ?? "(no error copy)"}`,
        };
      const verdict = holderLivenessFromReply(r.data, principal);
      opts.log(`manager-holder-liveness: ${principal}: ${verdict.state} (${verdict.detail})`);
      return verdict;
    } catch (e) {
      // The rail is unreachable, or the request TIMED OUT. Both are UNKNOWABILITY, and neither is
      // death: this is the branch a mutation would have to corrupt to turn verify-dead into
      // assume-dead-on-timeout, and it is the reason the reconciler refuses instead of proceeding.
      return {
        state: "unestablishable",
        detail:
          `the delivery daemon is not reachable on the ctl.delivery-admin rail (${e instanceof Error ? e.message : String(e)}); ` +
          `without the liveness oracle the freeze-holder "${principal}" cannot be proven gone. ` +
          "Start the delivery daemon (`cotal up` runs it) and re-run — this repair never infers death from silence",
      };
    } finally {
      await ep?.stop().catch(() => {});
    }
  };
}
