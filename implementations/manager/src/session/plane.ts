/**
 * The manager's SESSION PLANE (P2 item 6, 6b): offer mint + redeem ENFORCEMENT + PTY-bridge
 * standup. Each live session serves on its OWN short-lived connection under its OWN per-session
 * credential (SPEC 13.6); the standing connection this plane's ledger rides carries no session rail. The manager holds a single {@link ManagerSessionPlane} field; this module
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
 * loses the finalize re-check) — plus the SERVING credential's own §13.1 gate-checked stage, which
 * is real: the per-session serving credential is minted, staged revision-pinned, released only on
 * the finalize CAS, and revoked by name at the terminal.
 */
import { Kvm } from "@nats-io/kv";
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  assertSessionStateTransition,
  EpEnvelopeError,
  principalKey,
  sessionLedgerKey,
  type AnchorResolver,
  type AttachSession,
  type SessionCredential,
  type SessionGrant,
  type SessionLedger,
  type SessionLedgerRow,
  type SessionTerminalState,
} from "@cotal-ai/core";
import { mintAttachOffer, staticRedemptionSeam, ManagerSessionRegistry, type SessionServing, type SessionTarget } from "./establish.js";
import { serveSessionBridge, type SessionBridge } from "./bridge.js";
import type { AttachEndReason } from "./bridge.js";

const TERMINAL = new Set(["closed", "expired", "superseded", "retired"]);

/** A manager-local {@link SessionLedger} over `session.<id>` rows in the DEDICATED sessions bucket
 *  KV (never the auth bucket — §13.9 subject-blindness confinement). Drives the SAME core row/key
 *  types as implementations/auth's ledger with the manager's own KV CAS: the
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

/** The default global live-session ceiling. Configurable per manager
 *  ({@link ManagerSessionPlaneDeps.maxSessions}) because the right number is deployment-shaped: the
 *  browser console opens a session PER PANE, so a dashboard over a large mesh legitimately holds
 *  many at once, and a ceiling low enough to feel like a bound would break it. */
export const MAX_LIVE_SESSIONS_DEFAULT = 64;

export interface ManagerSessionPlaneDeps {
  space: string;
  /** The serving manager incarnation — instanceId = the managerLifecycleUid, epoch = the serve grant epoch. */
  serving: { instanceId: string; epoch: number };
  /** The manager's `sessions`-role signer + the resolver that returns its matching anchor (the
   *  manager self-signs and self-verifies its own offers). */
  signer: { keyId: string; keyPair: { sign(input: Uint8Array): Uint8Array } };
  resolveAnchor: AnchorResolver;
  /** The DEDICATED sessions-bucket KV holding the `session.<id>` ledger rows (never the auth bucket). */
  ledgerKv: KV;
  /** The per-session SERVING credential seam: mint, gate-checked stage, connection open, revoke.
   *  Injected because minting needs the space auth + the §13.1 gate, which live on the Manager. */
  servingCredential: SessionServing;
  /** Session lifetime (§13.6 live-class) + the bounded flow window. */
  ttlMs: number;
  window?: number;
  /**
   * Global ceiling on concurrently live sessions; defaults to {@link MAX_LIVE_SESSIONS_DEFAULT}.
   *
   * Redemption is caller-triggered and each session now mints a credential and opens a connection,
   * so without a ceiling an authorized caller could drive both without bound. This is deliberately
   * the plane's OWN bound rather than an inherited one: whatever route authz sits in front of
   * establishment, the process-level resource limit is a number here that can be executed against.
   *
   * RESIDUAL, NAMED: the ceiling is GLOBAL, not per caller. It protects the process, which is what
   * it is for, but it does not stop one authorized operator from exhausting it and denying sessions
   * to another. That was accepted on the grounds that only authorized operators reach redemption at
   * all — the attach face's console-token gate refuses before the establisher runs. If that gate is
   * ever relaxed, weakened, or made optional, this scoping assumption goes with it and the ceiling
   * needs a per-caller dimension.
   */
  maxSessions?: number;
  now?(): number;
}

/** One live session's serving side: its bridge, its own connection, and the credential id the
 *  terminal must revoke by name. */
interface LiveSession {
  bridge: SessionBridge;
  nc: NatsConnection;
  credentialId: string;
}

export class ManagerSessionPlane {
  readonly #deps: ManagerSessionPlaneDeps;
  readonly #registry = new ManagerSessionRegistry();
  readonly #live = new Map<string, LiveSession>();
  readonly #ledger: SessionLedger;
  readonly #maxSessions: number;

  constructor(deps: ManagerSessionPlaneDeps) {
    this.#deps = deps;
    this.#ledger = kvManagerSessionLedger(deps.ledgerKv);
    this.#maxSessions = deps.maxSessions ?? MAX_LIVE_SESSIONS_DEFAULT;
    if (!Number.isSafeInteger(this.#maxSessions) || this.#maxSessions < 1)
      throw new Error(`maxSessions must be a positive integer; got ${JSON.stringify(deps.maxSessions)}`);
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
    // The ceiling is checked BEFORE the mint and therefore before any credential exists or any
    // connection is opened: a refused establishment costs a signature verification, never a
    // credential or a socket. Loud, and it names the ceiling and its value so an operator who hits
    // it knows what to raise (see ManagerSessionPlaneDeps.maxSessions for the per-caller residual).
    this.assertCapacity();
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
    const serving = this.#deps.serving;
    const seam = staticRedemptionSeam({
      space: this.#deps.space,
      resolveAnchor: this.#deps.resolveAnchor,
      ledger: this.#ledger,
      serving: this.#deps.servingCredential,
      holderProcessEpoch: () => holder.processEpoch,
      servingEpoch: () => serving.epoch,
      // The HOLDER gate is a placeholder in the static path: the holder is an operator CLI, which
      // has no §13.1 lifecycle gate to observe. It fences nothing, and is not described as if it
      // does — user mode (#29) supplies the real lifecycle-registry read.
      observeHolderGate: (h) => ({ key: `holder.${h.lifecycleUid}`, revision: 1 }),
      // The SERVING gate is REAL: the credential seam observes this instance's own
      // `epgate.manager.<instanceId>` leader-served, and the stage below is revision-pinned to it.
      observeServingGate: (endpoint, instanceId) => this.#deps.servingCredential.observeGate(endpoint, instanceId),
      ...(this.#deps.now ? { now: this.#deps.now } : {}),
    });
    let cred: SessionCredential;
    let nc: NatsConnection;
    try {
      // One-use CAS + presenter-equality + the gate-pinned serving-credential stage + finalize.
      await seam.redeem(offer.grant, { id: holder.id, lifecycleUid: holder.lifecycleUid });
      // Only now is the row `active`, so only now is the credential authority (§13.6). Retrieved
      // through the serving party's own authenticated path, never out of the redemption answer.
      cred = await seam.serving(sessionId, { endpoint: offer.grant.endpoint, instanceId: serving.instanceId, epoch: serving.epoch });
      nc = await this.#deps.servingCredential.open(cred); // fails loud; there is no shared connection to fall back to
    } catch (e) {
      this.#registry.remove(sessionId);
      // A failure anywhere after the one-use was burned leaves a row that must not stay live: mark
      // it terminal and revoke whatever was staged. Best-effort — the §13.6 expiry sweep is the
      // durable backstop, and the original refusal is what the caller must see.
      await this.#collect(sessionId, "closed").catch(() => {});
      throw e;
    }
    const bridge = serveSessionBridge({
      nc,
      grant: offer.grant,
      session,
      onEnd: () => { void this.#teardown(sessionId); },
      ...(this.#deps.now ? { now: this.#deps.now } : {}),
    });
    this.#live.set(sessionId, { bridge, nc, credentialId: cred.id });
    return { grant: offer.grant };
  }

  /**
   * Retire one session's serving side. ORDER IS LOAD-BEARING: the connection closes FIRST and
   * unconditionally, because closing it is the immediate kill and must not be contingent on a
   * durable write succeeding. The ledger transition and the credential revoke follow; if either
   * fails the rail is already dead, the row keeps its unmarked credential id, and §13.6's sweep
   * retries exactly that id on every later pass. Idempotent.
   */
  async #teardown(sessionId: string, state: SessionTerminalState = "closed"): Promise<void> {
    const live = this.#live.get(sessionId);
    this.#live.delete(sessionId);
    this.#registry.remove(sessionId);
    if (live) {
      try { await live.nc.drain(); } catch { try { live.nc.close(); } catch { /* already gone */ } }
    }
    await this.#collect(sessionId, state);
  }

  /** Move the ledger row terminal and revoke the serving credential by name, marking the revoke
   *  only when it SUCCEEDED (§13.6: an unmarked id is what makes the sweep's retry real). */
  async #collect(sessionId: string, state: SessionTerminalState): Promise<void> {
    let row: SessionLedgerRow | undefined;
    try { row = await this.#ledger.read(sessionId); } catch { /* unreadable: the sweep still collects it */ }
    try { await this.#ledger.transitionTerminal(sessionId, state); } catch { /* sweep backstop */ }
    if (!row) return;
    try {
      await this.#deps.servingCredential.revoke(row.credServing);
      await this.#ledger.markRevoked(sessionId, row.credServing);
    } catch {
      /* the mark stays unset — the §13.6 sweep retries exactly this id */
    }
  }

  /** End every session bound to a target incarnation, with a distinct reason — the despawn/restart
   *  hook (the successor incarnation's differing epoch already refuses old-epoch redemptions; this
   *  proactively tears the live bridges down and surfaces the reason to each client). The bridge's
   *  own `onEnd` drives {@link #teardown}, so the connection and credential go with it. */
  endForTarget(name: string, lifecycleUid: string, reason: AttachEndReason): void {
    for (const id of this.#registry.forTarget(name, lifecycleUid)) this.#live.get(id)?.bridge.end(reason);
  }

  /** End all live sessions (manager stop / drain). */
  endAll(reason: AttachEndReason): void {
    for (const live of [...this.#live.values()]) live.bridge.end(reason);
  }

  /** Await every in-flight teardown (manager stop): the bridges' `onEnd` teardown is async, so a
   *  synchronous `endAll` alone would let the process exit with connections still draining. */
  async drain(reason: AttachEndReason): Promise<void> {
    this.endAll(reason);
    await Promise.all([...this.#live.keys()].map((id) => this.#teardown(id, "closed").catch(() => {})));
  }

  get liveSessions(): number {
    return this.#live.size;
  }

  /** The configured global ceiling (surfaced so an operator-facing status can report it). */
  get maxSessions(): number {
    return this.#maxSessions;
  }

  /**
   * Refuse loudly if the ceiling is already reached. ONE implementation, called by
   * {@link establishAttach} and by every establisher in front of it, so the two cannot drift into
   * disagreeing about capacity. It must run before ANY of: minting the offer, redeeming it, minting
   * a per-session credential on either side, opening a connection, or attaching the target's PTY.
   *
   * The message names the ceiling and its current value: an operator who hits it should not have to
   * read source to learn which knob to raise.
   */
  assertCapacity(): void {
    if (this.#live.size >= this.#maxSessions)
      throw new EpEnvelopeError(
        "resource-exhausted",
        `the manager is already serving its maximum of ${this.#maxSessions} concurrent sessions (raise ManagerOptions.maxSessions); no session was established and no credential was minted (SPEC 13.6)`,
      );
  }
}

/** Open the DEDICATED sessions-bucket KV a plane's ledger needs (the `session.<id>` rows live in
 *  the §13.6 session store — {@link sessionsBucket}, NOT the auth bucket). Split out so the manager
 *  can build the plane from its own bucket handle. */
export async function openSessionLedgerKv(nc: NatsConnection, bucket: string): Promise<KV> {
  return new Kvm(nc).open(bucket);
}
