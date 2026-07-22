/**
 * The manager's SESSION PLANE (P2 item 6, 6b): offer mint + redeem ENFORCEMENT + PTY-bridge
 * standup, driven off ONE session-writer connection scoped to `eps.manager.>` (an auth mesh) or
 * bare (an open mesh). The manager holds a single {@link ManagerSessionPlane} field; this module
 * keeps manager.ts surgical — the wiring is a boot line, an attach-handler call, and a stop line.
 *
 * STATIC design (item-6, coordinator-ruled): the mint and the redeem COLLAPSE into
 * {@link ManagerSessionPlane.establishAttach}, with the presenter fixed to the AUTHENTICATED attach
 * caller (`ctx.subject.caller`). This is deliberate and buys three things: (1) no un-redeemed-offer
 * window (the offer is born redeemed — a leaked grant releases nothing, and there is no dangling
 * bearer-ish artifact); (2) no new ep command and no `manager-service-contract` churn (item-2 is
 * live-editing that file); (3) redeem enforcement is still core's `redeemSession` — the one-use
 * `issuing` create-CAS plus presenter-equality on the signed grant, unchanged. The WIRE
 * offer/redeem SEPARATION (a second CLI presentation that mints the caller's per-session
 * credential) is the USER-MODE #29 shape; that path stays out of item 6 and refuses loud here.
 *
 * The manager cannot import implementations/auth (implementations never import each other), so the
 * durable ledger is a manager-local {@link kvManagerSessionLedger} over the SAME core row/key
 * types. The full §13.1 lifecycle-gate fence (revision-pinned credential-row staging) belongs to
 * the auth registry and is user-mode's; the static collapsed path fences on the one thing the
 * manager authoritatively knows — its own serving epoch (a successor incarnation's differing epoch
 * loses the finalize re-check) — and needs no gate stage because it mints no per-session
 * credential row.
 */
import { Kvm } from "@nats-io/kv";
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  assertSessionStateTransition,
  principalKey,
  sessionLedgerKey,
  type AnchorResolver,
  type AttachSession,
  type SessionGrant,
  type SessionLedger,
  type SessionLedgerRow,
} from "@cotal-ai/core";
import { mintAttachOffer, staticRedemptionSeam, ManagerSessionRegistry, type SessionTarget } from "./establish.js";
import { serveSessionBridge, type SessionBridge } from "./bridge.js";
import type { AttachEndReason } from "./frame.js";

const TERMINAL = new Set(["closed", "expired", "superseded", "retired"]);

/** A manager-local {@link SessionLedger} over `session.<id>` rows in the auth bucket KV. Drives the
 *  SAME core row/key types as implementations/auth's ledger with the manager's own KV CAS: the
 *  one-use is `createIssuing`'s create-only CAS; finalize/terminal/revoke are revision-pinned
 *  updates (a lost CAS returns false / retries on the next sweep, never a silent overwrite). */
export function kvManagerSessionLedger(kv: KV): SessionLedger {
  const dec = (v: Uint8Array): SessionLedgerRow => JSON.parse(new TextDecoder().decode(v)) as SessionLedgerRow;
  const enc = (r: SessionLedgerRow): Uint8Array => new TextEncoder().encode(JSON.stringify(r));
  return {
    async read(id) {
      const e = await kv.get(sessionLedgerKey(id));
      return e && e.operation === "PUT" ? dec(e.value) : undefined;
    },
    async createIssuing(row) {
      try {
        await kv.create(sessionLedgerKey(row.sessionId), enc(row));
        return "created";
      } catch {
        return "exists"; // the one-use is burned (create-only CAS lost)
      }
    },
    async finalizeActive(id) {
      const e = await kv.get(sessionLedgerKey(id));
      if (!e || e.operation !== "PUT") return false;
      const row = dec(e.value);
      if (row.state !== "issuing") return false;
      assertSessionStateTransition(row.state, "active");
      row.state = "active";
      try { await kv.update(sessionLedgerKey(id), enc(row), e.revision); return true; } catch { return false; }
    },
    async transitionTerminal(id, to) {
      const e = await kv.get(sessionLedgerKey(id));
      if (!e || e.operation !== "PUT") return false;
      const row = dec(e.value);
      if (TERMINAL.has(row.state)) return false;
      assertSessionStateTransition(row.state, to);
      row.state = to;
      try { await kv.update(sessionLedgerKey(id), enc(row), e.revision); return true; } catch { return false; }
    },
    async markRevoked(id, credId) {
      const e = await kv.get(sessionLedgerKey(id));
      if (!e || e.operation !== "PUT") return;
      const row = dec(e.value);
      if (credId === row.credCaller) row.revoked.caller = true;
      else if (credId === row.credServing) row.revoked.serving = true;
      else return;
      try { await kv.update(sessionLedgerKey(id), enc(row), e.revision); } catch { /* the next sweep retries */ }
    },
  };
}

export interface ManagerSessionPlaneDeps {
  /** The session-writer connection: an auth mesh scopes it to `eps.manager.>`; an open mesh is bare. */
  nc: NatsConnection;
  space: string;
  /** The serving manager incarnation — instanceId = the managerLifecycleUid, epoch = the serve grant epoch. */
  serving: { instanceId: string; epoch: number };
  /** The manager's `sessions`-role signer + the resolver that returns its matching anchor (the
   *  manager self-signs and self-verifies its own offers). */
  signer: { keyId: string; keyPair: { sign(input: Uint8Array): Uint8Array } };
  resolveAnchor: AnchorResolver;
  /** The auth-bucket KV holding the `session.<id>` ledger rows. */
  ledgerKv: KV;
  /** Session lifetime (§13.6 live-class) + the bounded flow window. */
  ttlMs: number;
  window?: number;
  now?(): number;
}

export class ManagerSessionPlane {
  readonly #deps: ManagerSessionPlaneDeps;
  readonly #registry = new ManagerSessionRegistry();
  readonly #bridges = new Map<string, SessionBridge>();
  readonly #ledger: SessionLedger;

  constructor(deps: ManagerSessionPlaneDeps) {
    this.#deps = deps;
    this.#ledger = kvManagerSessionLedger(deps.ledgerKv);
  }

  /** Mint an offer for the authenticated attach caller, enforce its one-use redemption, and stand
   *  up the PTY bridge — all atomically. Returns the HOLDER-BOUND grant (the attach reply): no URL,
   *  and it must never be logged. Throws on a redeem refusal (a foreign presenter, an already-live
   *  session, a stale serving epoch). */
  async establishAttach(
    caller: { owner: string; actor: string; uid: string },
    target: SessionTarget,
    session: AttachSession,
  ): Promise<{ grant: SessionGrant }> {
    const holderId = principalKey(caller.owner, caller.actor).key;
    // Collapsed static path: the offer is redeemed at mint, so there is no un-redeemed window for a
    // caller restart to invalidate — the holder process-epoch fence is a no-op here (user-mode #29
    // wires the real lifecycle-registry read). serving epoch IS enforced (a successor loses).
    const holder = { id: holderId, lifecycleUid: caller.uid, processEpoch: 0 };
    const offer = mintAttachOffer({
      space: this.#deps.space,
      serving: this.#deps.serving,
      holder,
      target,
      signer: this.#deps.signer,
      ttlMs: this.#deps.ttlMs,
      ...(this.#deps.window !== undefined ? { window: this.#deps.window } : {}),
      ...(this.#deps.now ? { now: this.#deps.now() } : {}),
    });
    this.#registry.record(offer);
    const sessionId = offer.grant.sessionId;
    try {
      const seam = staticRedemptionSeam({
        space: this.#deps.space,
        resolveAnchor: this.#deps.resolveAnchor,
        ledger: this.#ledger,
        holderProcessEpoch: () => holder.processEpoch,
        servingEpoch: () => this.#deps.serving.epoch,
        observeHolderGate: (h) => ({ key: `holder.${h.lifecycleUid}`, revision: 1 }),
        observeServingGate: (_endpoint, instanceId) => ({ key: `epgate.manager.${instanceId}`, revision: 1 }),
        ...(this.#deps.now ? { now: this.#deps.now } : {}),
      });
      await seam.redeem(offer.grant, { id: holder.id, lifecycleUid: holder.lifecycleUid });
    } catch (e) {
      this.#registry.remove(sessionId); // a refused redeem leaves no session
      throw e;
    }
    const bridge = serveSessionBridge({
      nc: this.#deps.nc,
      grant: offer.grant,
      session,
      onEnd: () => { this.#bridges.delete(sessionId); this.#registry.remove(sessionId); },
      ...(this.#deps.now ? { now: this.#deps.now } : {}),
    });
    this.#bridges.set(sessionId, bridge);
    return { grant: offer.grant };
  }

  /** End every session bound to a target incarnation, with a distinct reason — the despawn/restart
   *  hook (the successor incarnation's differing epoch already refuses old-epoch redemptions; this
   *  proactively tears the live bridges down and surfaces the reason to each client). */
  endForTarget(name: string, lifecycleUid: string, reason: AttachEndReason): void {
    for (const id of this.#registry.forTarget(name, lifecycleUid)) this.#bridges.get(id)?.end(reason);
  }

  /** End all live sessions (manager stop / drain). */
  endAll(reason: AttachEndReason): void {
    for (const bridge of [...this.#bridges.values()]) bridge.end(reason);
  }

  get liveSessions(): number {
    return this.#bridges.size;
  }
}

/** Open the auth-bucket KV a plane's ledger needs (the `session.<id>` rows live in the §13.12 auth
 *  store). Split out so the manager can build the plane from its own bucket handle. */
export async function openSessionLedgerKv(nc: NatsConnection, authBucket: string): Promise<KV> {
  return new Kvm(nc).open(authBucket);
}
