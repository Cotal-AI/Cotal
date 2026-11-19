// The stream and inbox provisioning of CotalEndpoint, as an internal component. Moved verbatim from
// endpoint.ts; the endpoint keeps the public methods and forwards to them. Not re-exported by the index.
import { JetStreamApiCodes, type JetStreamManager } from "@nats-io/jetstream";
import { isJetStreamMissing } from "./jetstream-missing.js";
import { isPermissionDenied } from "./permission-denied.js";
import { createSpaceStreams, dmDurableConfig, dlvDurableConfig, taskDurableConfig } from "./streams.js";
import { dlvStream, dmDurable, dmStream, taskStream } from "./subjects.js";

/** What the provisioning component reads from its endpoint. State is read when it is used, never
 *  copied, and every method is looked up on the endpoint at call time. */
export interface EndpointProvisioningDeps {
  jsm: () => JetStreamManager | undefined;
  space: () => string;
  authed: () => boolean;
  notLiveMsg: () => string;
  manager: () => Promise<JetStreamManager>;
}

/** One endpoint's stream creation and its privileged durable provisioning: the space's backing
 *  streams, and the DM inbox, DELIVER and TASK durables an agent binds without creating.
 *  Internal: `CotalEndpoint` keeps the public methods and forwards to it. */
export class EndpointProvisioning {
  constructor(private readonly deps: EndpointProvisioningDeps) {}

  private get jsm() { return this.deps.jsm(); }
  private get space() { return this.deps.space(); }
  private get authed() { return this.deps.authed(); }
  private notLiveMsg() { return this.deps.notLiveMsg(); }
  private manager() { return this.deps.manager(); }

  /** Create the three backing streams for this space (idempotent). Open-mode lazy create;
   *  the same definitions are used by `cotal up` at privileged setup. */
  async ensureStreams(): Promise<void> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    await createSpaceStreams(this.jsm, this.space);
  }

  /** Create this open space's message streams if they are not there yet, as a consuming endpoint
   *  does when it starts. For a sender that consumes nothing and may be the space's first
   *  participant (#7045). An authenticated broker's streams come from its setup, and its agents may
   *  not create them, so this throws there. */
  async ensureOpenSpaceStreams(): Promise<void> {
    if (this.authed) throw new Error(`the streams of ${this.space} come from its broker's setup on an authenticated space; a sender does not create them`);
    await createSpaceStreams(await this.manager(), this.space);
  }

  // (v3) The old `provisionMembership` — manager/provisioner-written boot membership at spawn — is GONE.
  // Boot durable membership is now the AGENT self-joining its durable boot channels via the daemon's
  // `ctl.delivery` op at connect ({@link armBootDurableMemberships}), reconciled on outage. The
  // primitive it wrapped, {@link durableJoinFor}, is now driven by the daemon's `ctl.delivery` handler.

  /**
   * Privileged: pre-create an agent's DM inbox durable (auth mode), so the agent can BIND
   * it without holding CONSUMER.CREATE on DM_<space>. The creator sets the filter to
   * inst.<targetId>.* — the agent never gets to choose it, which is what stops a peer from
   * creating a durable filtered to someone else's inbox. Idempotent (byte-identical config),
   * safe to call again on manager restart. The caller must be permissive on DM_<space>.
   */
  async provisionDmInbox(owner: string, actor: string, lifecycleUid: string): Promise<void> {
    await this.ensureDmDurable(owner, actor, lifecycleUid, {});
  }

  /** Idempotent-PER-LIFECYCLE create of a `dm_<o>-<a>-<uid>` durable with its ACTIVATION FRONTIER
   *  (SPEC §8). Info-first: an existing durable (a manager-restart re-provision of the SAME uid, or
   *  the same lifecycle's own restart) is kept as-is, preserving the ORIGINAL frontier — the
   *  activation moment never moves. A fresh lifecycle captures the DM stream's current `last_seq` and
   *  starts delivery at frontier+1, so a same-alias successor inherits none of the predecessor's
   *  pending DMs (its filter is the shared alias subject `inst.>`; the FRONTIER, not the subject, is
   *  the cut).
   *
   *  HONESTY (panel-locked): the no-gap guarantee (a DM published between the capture and the create
   *  lands ABOVE the frontier and is delivered) holds ONLY under ONE provisioner per lifecycle uid —
   *  the manager provisions sequentially, which satisfies it. Under CONCURRENT same-uid provisioners
   *  (a split-brain manager), a higher-frontier winner excludes the loser's N+1..M capture window:
   *  the lost-race branch below keeps the winner's durable unconditionally. No per-uid serialization
   *  or persisted-frontier machinery is added in this slice; concurrent same-uid provisioning is
   *  out-of-contract (at-least-once best-effort). */
  async ensureDmDurable(
    owner: string,
    actor: string,
    lifecycleUid: string,
    opts: { ackWaitMs?: number; inactiveThresholdMs?: number },
  ): Promise<void> {
    const jsm = await this.manager();
    const stream = dmStream(this.space);
    const name = dmDurable(owner, actor, lifecycleUid);
    try {
      await jsm.consumers.info(stream, name);
      return; // this lifecycle's durable exists — keep its original frontier
    } catch (e) {
      if (!isJetStreamMissing(e, JetStreamApiCodes.ConsumerNotFound)) throw e;
      // Genuinely absent consumer: create it below. A denial is not absence.
    }
    const frontier = (await jsm.streams.info(stream)).state.last_seq;
    try {
      await jsm.consumers.add(stream, dmDurableConfig(this.space, owner, actor, lifecycleUid, { ...opts, activationFrontier: frontier }));
    } catch (e) {
      // A concurrent same-lifecycle provisioner may have won the create with an earlier frontier —
      // if the durable now exists it is authoritative; anything else stays a loud failure.
      try { await jsm.consumers.info(stream, name); return; }
      catch (probeError) {
        // The probe never creates a successful result: it either proves the concurrent winner above,
        // or the original create failure stays authoritative. Preserve a denial from the probe because
        // it names the missing capability more accurately than an unrelated create conflict.
        if (isPermissionDenied(probeError)) throw probeError;
      }
      throw e;
    }
  }

  /**
   * Privileged: pre-create an agent's bind-only Plane-3 DELIVER durable (`dlv_<id>`, filtered to
   * `dlv.<id>`), so the agent can BIND its per-member durable handoff without holding CONSUMER.CREATE
   * on the DLV stream. Same bind-only model as {@link provisionDmInbox}: the creator sets the filter,
   * the agent never does. The trusted reader transfers re-authorized copies onto `dlv.<id>`; the agent
   * acks them via native JetStream (SPEC §8). Idempotent. The caller must be permissive on DLV.
   */
  async provisionDlvInbox(owner: string, actor: string, lifecycleUid: string): Promise<void> {
    const jsm = await this.manager();
    await jsm.consumers.add(dlvStream(this.space), dlvDurableConfig(this.space, owner, actor, lifecycleUid));
  }

  /**
   * Privileged: pre-create a role's shared TASK work-queue durable (auth mode), so agents
   * of that role can BIND it without holding CONSUMER.CREATE on TASK_<space>. The creator
   * sets the filter to svc.<role>.> — agents never choose it, which stops cross-role drain.
   * Idempotent per role. The caller must be permissive on TASK_<space>.
   */
  async provisionTaskQueue(role: string): Promise<void> {
    const jsm = await this.manager();
    await jsm.consumers.add(taskStream(this.space), taskDurableConfig(this.space, role));
  }
}
