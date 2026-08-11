/**
 * Delivery-daemon single-flight lease — a CAS-guarded key in the per-space `cotal_delivery_<space>` KV
 * bucket. One key per shard ({@link leaseKey}); the holder is the live delivery daemon for that shard.
 * Acquire is an ATOMIC `kv.create` (fails if a live lease exists) — a loud refusal-to-bind, so two
 * daemons never split a durable's delivery. The bucket has a bucket-level TTL ({@link LEASE_TTL_MS}),
 * so a CRASHED holder's lease key auto-expires and a fresh daemon can re-acquire; the holder renews
 * (CAS `kv.update`) at ~half the TTL to stay alive. The same key is the daemon-readiness signal and
 * the non-gating `cotal_channels` delivery-health signal (READ-ONLY for an agent — Component 6).
 *
 * The acquire/renew/release/read operations live as methods on {@link CotalEndpoint} (they reuse its
 * connection + cred); this module is just the bucket-open helper + the record shape, mirroring
 * `openMembersRegistry` / `openAclRegistry`.
 */
import { Kvm, type KV } from "@nats-io/kv";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { deliveryBucket, leaseKey } from "./subjects.js";

/** A delivery lease record: who holds the shard and since when (epoch ms; diagnostics + health surface),
 *  plus `ready` — set true only AFTER the daemon has bound `ctl.delivery` + the fan-out/reader loops, so
 *  "lease live" proves the RESPONDER is up, not merely that the single-flight slot was claimed. The lease
 *  is CAS-created (`ready:false`) BEFORE binding (single-flight gate, prevents double-bind), then updated
 *  to `ready:true` after `startPlane3` — and renews keep it true. */
export interface DeliveryLeaseInfo {
  holder: string;
  since: number;
  ready: boolean;
}

/** A manager per-instance LIVENESS-lease record: which logical instance is live + how it was launched.
 *  `runtime`/`root` let `spawn -f` fail LOUD on a mismatch instead of silently reusing a wrong-runtime /
 *  foreign-checkout manager (no fallbacks); `pid` is a diagnostics + targeted-stop hint. Keyed per
 *  {@link ManagerLeaseInfo.instanceId} ({@link import("./subjects.js").managerLeaseKey}) — P2 item 3
 *  demoted the per-space singleton to per-instance liveness, so a second manager's create no longer
 *  THROWS (distinct instance id ⇒ distinct key ⇒ both acquire). Losing the key stops THAT instance only. */
export interface ManagerLeaseInfo {
  /** The manager endpoint id — `principalKey(owner, actor).key` dot-form (the endpoint card's
   *  id), so it is DIRECTLY comparable to a control subject's `<owner>.<actor>` attribution:
   *  the auth service's retirement rail (#29 piece 3) leader-reads this row and requires
   *  holder == the subject-attributed requester principal, fresh per request. On an auth mesh every
   *  instance of one space shares this holder (same owner+actor principal); {@link instanceId} is what
   *  distinguishes them. */
  holder: string;
  /** The live LOGICAL manager instance id (persisted per workspace root, advanced-epoch on restart).
   *  The KEY discriminator: two managers in one space share `holder` but have distinct `instanceId`. */
  instanceId: string;
  runtime: string;  // pty | tmux | cmux
  root: string;     // resolved workspaceRoot (same-checkout check)
  pid: number;      // OS pid
  since: number;    // epoch ms
}

/** Open the delivery lease/readiness bucket (pre-created with a bucket-level TTL at `cotal up`; the
 *  daemon binds, never creates). Read-only for an agent (Component 6 health), write-lease for the daemon. */
export async function openDeliveryRegistry(
  nc: import("@nats-io/transport-node").NatsConnection,
  space: string,
): Promise<KV> {
  return new Kvm(nc).open(deliveryBucket(space));
}

/** Poll until the delivery daemon has acquired its shard-0 lease (i.e. is ready to serve `ctl.delivery`),
 *  or the timeout elapses. Used by the CLI's `ensureDelivery` to wait for readiness before the manager
 *  spawns agents (so their boot self-join finds the responder). Connects with the daemon's own scoped
 *  creds (`id` sets the `_INBOX_<id>` prefix the cred's `sub.allow` permits for the kv.get reply).
 *  Returns false on timeout / unreachable — the caller treats it as non-fatal (boot self-join reconciles). */
export async function waitForDeliveryLease(opts: {
  servers: string;
  space: string;
  creds: string;
  id: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 8000);
  let nc: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    nc = await connect({
      servers: opts.servers,
      authenticator: credsAuthenticator(new TextEncoder().encode(opts.creds)),
      inboxPrefix: `_INBOX_${opts.id}`,
      maxReconnectAttempts: 5,
    });
    const kv = await openDeliveryRegistry(nc, opts.space);
    while (Date.now() < deadline) {
      const e = await kv.get(leaseKey(0));
      if (e && e.operation !== "DEL" && e.operation !== "PURGE") {
        // Wait for READY (responder bound), not just lease existence (single-flight slot claimed).
        try { if (e.json<DeliveryLeaseInfo>().ready === true) return true; } catch { /* re-poll */ }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch {
    /* daemon not up yet / bucket race — treat as not-ready */
  } finally {
    try {
      await nc?.drain();
    } catch {
      /* ignore */
    }
  }
  return false;
}
