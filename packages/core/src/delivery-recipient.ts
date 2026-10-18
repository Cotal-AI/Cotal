/**
 * A consented background recipient's delivery (SPEC 8): its OWN durable consumers on the space's
 * existing DM and DLV streams, filtered exactly like one lifecycle's bind-only `dm_`/`dlv_` durables
 * but starting at the consent frontier.
 *
 * - Nothing delivered before consent is captured: delivery starts at the stream sequence the
 *   consenting provisioner captured, plus one. There is no "from the start" default.
 * - No other reader's ACK consumes the recipient's copy. Both streams keep limits retention, so each
 *   consumer has its own cursor; the lifecycle's own UI durable is never bound or shared.
 * - The recipient binds and ACKs only these durables (`recipientBindGrants`). It never creates,
 *   deletes or reads a stream, and holds no mailbox writer or admin row. The provisioner that holds
 *   the human's consent pre-creates the durables (`provisionerConsumerGrants` rows) and deletes them
 *   on revocation, expiry or member loss.
 *
 * `commitThenAck` is the only ACK path. A delivery is ACKed after the host's persist resolves and
 * the broker confirms the ACK; it is NAKed when persist throws, so a failed or unknown persistence
 * never consumes the only durable copy. An unconfirmed ACK reports `unknown`: JetStream may
 * redeliver, so the host's persist must be idempotent on `sourceId`.
 *
 * Categories are what the source plane proves, never guessed from text or rosters: a DM-stream
 * delivery is a `dm` (the unicast plane), and a DLV delivery stays `unknown` until a trusted
 * delivery reason is carried on the wire.
 */
import { AckPolicy, DeliverPolicy, type ConsumerConfig, type JetStreamClient, type JetStreamManager, type JsMsg } from "@nats-io/jetstream";
import { nanos } from "@nats-io/transport-node";
import { consumeBindRows, type PreCreatedDurable } from "./endpoint-binding.js";
import { isConsumerNotFound } from "./jetstream-missing.js";
import { assertLifecycleToken, dlvStream, dlvSubject, dmStream, lifecycleNameKey, unicastRecvFilter } from "./subjects.js";

/** The recipient's in-flight bound: a recipient that stops persisting stops receiving, not losing. */
export const RECIPIENT_MAX_ACK_PENDING = 64;

/** One consented recipient grant over one lifecycle's DM and DLV delivery. */
export interface RecipientGrantScope {
  space: string;
  owner: string;
  actor: string;
  lifecycleUid: string;
  /** The grant's own id (a lifecycle-shaped token), carried in both durable names. */
  grantId: string;
}

/** The DM and DLV stream sequences the consenting provisioner captured at consent. */
export interface RecipientConsentFrontier {
  dm: number;
  dlv: number;
}

/** `rdm_<owner>-<actor>-<lifecycleUid>-<grantId>`: never the lifecycle's own `dm_` durable. */
export function recipientDmDurable(owner: string, actor: string, lifecycleUid: string, grantId: string): string {
  return `rdm_${lifecycleNameKey(owner, actor, lifecycleUid)}-${assertLifecycleToken(grantId, "recipient grantId")}`;
}

/** `rdlv_<owner>-<actor>-<lifecycleUid>-<grantId>`: never the lifecycle's own `dlv_` durable. */
export function recipientDlvDurable(owner: string, actor: string, lifecycleUid: string, grantId: string): string {
  return `rdlv_${lifecycleNameKey(owner, actor, lifecycleUid)}-${assertLifecycleToken(grantId, "recipient grantId")}`;
}

function frontierStart(frontier: number, which: string): Partial<ConsumerConfig> {
  if (!Number.isSafeInteger(frontier) || frontier < 0)
    throw new Error(`recipient ${which} consent frontier must be a non-negative integer, got ${String(frontier)}`);
  return { deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: frontier + 1 };
}

/**
 * The recipient's two pre-created durables, for the provisioner that holds the consent. Same filters
 * as the lifecycle's `dm_`/`dlv_` durables, explicit ACK, a bounded in-flight set, no
 * `inactive_threshold` (the grant's own expiry and revocation delete them), and no `max_deliver`
 * (a delivery the host could not persist is redelivered, never dropped).
 */
export function recipientDurableConfigs(scope: RecipientGrantScope, frontier: RecipientConsentFrontier, opts: { ackWaitMs?: number } = {}): PreCreatedDurable[] {
  const { space, owner, actor, lifecycleUid, grantId } = scope;
  const common: Partial<ConsumerConfig> = { ack_policy: AckPolicy.Explicit, ack_wait: nanos(opts.ackWaitMs ?? 60_000), max_ack_pending: RECIPIENT_MAX_ACK_PENDING };
  return [
    { stream: dmStream(space), config: { durable_name: recipientDmDurable(owner, actor, lifecycleUid, grantId), filter_subject: unicastRecvFilter(space, owner, actor), ...common, ...frontierStart(frontier.dm, "DM") } },
    { stream: dlvStream(space), config: { durable_name: recipientDlvDurable(owner, actor, lifecycleUid, grantId), filter_subject: dlvSubject(space, owner, actor, lifecycleUid), ...common, ...frontierStart(frontier.dlv, "DLV") } },
  ];
}

/** The consent frontier: each stream's last sequence at the moment the provisioner records consent. */
export async function captureRecipientFrontier(jsm: JetStreamManager, space: string): Promise<RecipientConsentFrontier> {
  const [dm, dlv] = await Promise.all([jsm.streams.info(dmStream(space)), jsm.streams.info(dlvStream(space))]);
  return { dm: dm.state.last_seq, dlv: dlv.state.last_seq };
}

/** Pre-create the recipient's durables (the provisioner, after consent). Idempotent for the same
 *  configs; a durable that already exists with another config refuses rather than being rebound. */
export async function provisionRecipientDurables(jsm: JetStreamManager, durables: readonly PreCreatedDurable[]): Promise<void> {
  for (const d of durables) await jsm.consumers.add(d.stream, d.config);
}

/** Delete the recipient's durables by exact name (revocation, expiry, member or account loss). An
 *  absent durable is already gone. This stops further delivery; it does not recall what the
 *  recipient already fetched, so the host still runs its own current checks before persisting. */
export async function deprovisionRecipientDurables(jsm: JetStreamManager, durables: readonly PreCreatedDurable[]): Promise<{ deleted: number; absent: number }> {
  let deleted = 0, absent = 0;
  for (const d of durables) {
    try { if (await jsm.consumers.delete(d.stream, d.config.durable_name!)) deleted++; }
    catch (e) { if (isConsumerNotFound(e)) absent++; else throw e; }
  }
  return { deleted, absent };
}

/** The recipient credential's whole JetStream surface: info, fetch and ACK of its own durables. */
export function recipientBindGrants(durables: readonly PreCreatedDurable[]): string[] {
  return durables.flatMap((d) => {
    if (!d.config.durable_name) throw new Error("a recipient bind grant needs a durable_name");
    return consumeBindRows(d.stream, d.config.durable_name);
  });
}

/** What the source plane proves about a delivery. */
export type RecipientCategory = "dm" | "unknown";

/** One delivery, addressed by its stable stream position. */
export interface RecipientDelivery {
  /** `<stream>:<streamSequence>`: stable across redelivery and replay, the host's dedup key. */
  readonly sourceId: string;
  readonly stream: string;
  readonly streamSequence: number;
  /** 1 on first delivery; more means a redelivery the host may already have persisted. */
  readonly deliveryCount: number;
  readonly subject: string;
  readonly category: RecipientCategory;
  readonly data: Uint8Array;
  /** The broker's receive time, ms since the epoch. */
  readonly timestampMs: number;
}

/** A delivery and the message it must be settled on. Settle only through {@link commitThenAck}. */
export interface PendingRecipientDelivery {
  readonly delivery: RecipientDelivery;
  readonly msg: JsMsg;
}

/** Bind one pre-created recipient durable (CONSUMER.INFO) and fetch its next delivery, or null when
 *  none arrived within `expiresMs`. Binding never creates: a missing durable is the provisioner's
 *  refusal, surfaced unchanged. */
export async function nextRecipientDelivery(js: JetStreamClient, durable: PreCreatedDurable, opts: { expiresMs?: number } = {}): Promise<PendingRecipientDelivery | null> {
  if (!durable.config.durable_name) throw new Error("a recipient durable needs a durable_name");
  const consumer = await js.consumers.get(durable.stream, durable.config.durable_name);
  const msg = await consumer.next({ expires: opts.expiresMs ?? 30_000 });
  if (!msg) return null;
  return {
    msg,
    delivery: Object.freeze({
      sourceId: `${durable.stream}:${msg.info.streamSequence}`,
      stream: durable.stream,
      streamSequence: msg.info.streamSequence,
      deliveryCount: msg.info.deliveryCount,
      subject: msg.subject,
      category: durable.stream.startsWith("DM_") ? "dm" as const : "unknown" as const,
      data: msg.data,
      timestampMs: Math.floor(msg.info.timestampNanos / 1_000_000),
    }),
  };
}

/** How a commit settled: `committed` (persisted and ACK confirmed), `retry` (persist failed; NAKed,
 *  the broker redelivers), or `unknown` (persisted, ACK unconfirmed; it may be redelivered). */
export type RecipientCommit = "committed" | "retry" | "unknown";

/** Persist first, ACK second. `persist` must be idempotent on `delivery.sourceId`. */
export async function commitThenAck(pending: PendingRecipientDelivery, persist: (delivery: RecipientDelivery) => Promise<void>, opts: { retryDelayMs?: number } = {}): Promise<RecipientCommit> {
  try {
    await persist(pending.delivery);
  } catch {
    pending.msg.nak(opts.retryDelayMs ?? 5_000);
    return "retry";
  }
  try {
    return (await pending.msg.ackAck()) ? "committed" : "unknown";
  } catch {
    return "unknown";
  }
}
