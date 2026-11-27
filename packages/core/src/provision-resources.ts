import { assertValidChannel, resolveReadAcl, principalKey, assertLifecycleToken } from "./subjects.js";
import { type Identity } from "./identity.js";
import type { MintOpts, SpaceAuth } from "./provision-jwt.js";
import { mintCreds, principalOf } from "./provision-jwt.js";
import { taskRoles } from "./provision-permissions.js";


/** Options for {@link provisionAgent} — {@link MintOpts} plus the active read set. */
export interface ProvisionOpts extends MintOpts {
  /** The active read set: the channels the agent subscribes to (live core-sub) at boot, and whose
   *  `durable`-class ones the agent self-joins for a Plane-3 backstop at connect (via the delivery
   *  daemon). Must be ⊆ `allowSubscribe`. Omitted or empty ⇒ no boot channels at all. */
  subscribe?: string[];
  /** Record this agent's read ACL so it can participate in durable delivery (default true). A durable
   *  backstop needs the agent's read ACL in the registry — the server-side delivery daemon re-authorizes
   *  every durable entry against it — written here at provision. Set FALSE for a LIVE-ONLY launcher
   *  (e.g. a direct foreground `cotal spawn` with no durable intent): no ACL row is written, so the daemon
   *  refuses to authorize a durable backstop and the agent stays live-only. Boot durable MEMBERSHIP itself
   *  is not written here — the agent self-joins its durable channels via the daemon's `ctl.delivery` op at
   *  connect. */
  durableMembership?: boolean;
}

/** The privileged onboarding ops a launcher needs at spawn — implemented by a connected, permissive
 *  endpoint (the manager at `cotal start`/`cotal up`, or a short-lived provisioner that `cotal spawn`
 *  opens). It pre-creates the agent's own mailboxes and records its read ACL; it does NOT host Plane-3
 *  delivery (that is the server-side delivery daemon). */
export interface DurableProvisioner {
  /** Pre-create the lifecycle's bind-only DM durable (`dm_<owner>-<actor>-<uid>`). The implementation
   *  captures the DM stream's ACTIVATION FRONTIER (its `last_seq` at first creation) and starts
   *  delivery at frontier+1 (SPEC §8) — a same-alias successor inherits no predecessor DMs.
   *  Idempotent PER LIFECYCLE: a re-provision of the same uid keeps the existing durable (and so the
   *  ORIGINAL frontier — the activation moment does not move on manager restart). */
  provisionDmInbox(owner: string, actor: string, lifecycleUid: string): Promise<void>;
  /** Pre-create the lifecycle's bind-only Plane-3 DELIVER durable (`dlv_<owner>-<actor>-<uid>`,
   *  filtered to the lifecycle-scoped `dlv.<owner>.<actor>.<uid>`) so it can BIND its per-member
   *  durable handoff without holding CONSUMER.CREATE on the DLV stream. */
  provisionDlvInbox(owner: string, actor: string, lifecycleUid: string): Promise<void>;
  /** Record the lifecycle's read ACL (`allowSubscribe`) in the durable ACL registry, keyed
   *  `<owner>.<actor>.<lifecycleUid>` (SPEC §13.1) — the same act as baking it into the JWT, persisted
   *  so the **server-side delivery daemon** can re-authorize the agent's durable entries and validate
   *  its runtime durable-joins (it holds no in-memory ledger). Replaces the old manager-written boot
   *  membership: boot durable membership is now the agent SELF-JOINING its durable channels via the
   *  daemon's `ctl.delivery` op at connect. */
  commitAcl(principal: string, lifecycleUid: string, allowSubscribe: string[]): Promise<void>;
  /**
   * Raise the mint-time ceiling. Only the provisioning path that also remints the JWT.
   * Process discipline, not crypto binding — see {@link reissueAcl}.
   */
  reissueAcl(principal: string, lifecycleUid: string, allowSubscribe: string[]): Promise<void>;
  provisionTaskQueue(role: string): Promise<void>;
}

/** Onboard an agent for launch (auth mode): pre-create its bind-only DM (+ Plane-3 DELIVER + role
 *  TASK) durables, RECORD its read ACL in the durable registry (unless `durableMembership:false`), and
 *  mint its scoped creds. Live delivery is the agent's own core subscription — there is no per-instance
 *  chat durable. Boot durable MEMBERSHIP is not written here: the agent self-joins its durable channels
 *  via the server-side delivery daemon's `ctl.delivery` op at connect. A deliberately live-only
 *  launcher (`durableMembership:false`, e.g. `cotal spawn --live-only`) gets no ACL row, so the
 *  daemon never authorizes a durable backstop for it. */
export async function provisionAgent(
  provisioner: DurableProvisioner,
  auth: SpaceAuth,
  identity: Identity,
  opts: ProvisionOpts = {},
): Promise<string> {
  if (!opts.lifecycleUid)
    throw new Error("provisionAgent: a lifecycleUid is required - the agent's broker footprint is lifecycle-keyed (SPEC 13.1); mint one with mintLifecycleUid() and persist it with the agent");
  const pr = principalOf(identity, opts.principal, opts.lifecycleUid);
  const allowSubscribe = await provisionAgentDurables(
    provisioner,
    { owner: pr.owner, actor: pr.actor, lifecycleUid: opts.lifecycleUid },
    opts,
  );
  return mintCreds(auth, identity, "agent", { ...opts, allowSubscribe });
}

/** The DURABLE half of agent onboarding, principal-keyed and credential-agnostic: pre-create the
 *  bind-only DM durable and, when the read ACL is nonempty, the DELIVER durable; record the read ACL;
 *  ensure the role TASK queue. The static
 *  path ({@link provisionAgent}) follows it with a mint; the USER-MODE spawn path runs it alone —
 *  a user agent's credential is its bearer (callout-minted per connect), never a static cred.
 *  Returns the resolved read ACL so both callers scope from the same computed set. */
export async function provisionAgentDurables(
  provisioner: DurableProvisioner,
  pr: { owner: string; actor: string; lifecycleUid: string },
  opts: ProvisionOpts = {},
): Promise<string[]> {
  const uid = assertLifecycleToken(pr.lifecycleUid); // hard cut: every provisioned footprint is lifecycle-keyed (SPEC 13.1)
  // An omitted/empty read set means NO channels (it does not mean `general`): a caller that names
  // no channel gets a footprint with no channel membership and, below, a cred with no channel row.
  const subscribe = opts.subscribe ?? [];
  // Reject channel names the wire layer would rewrite (the pre-created filter rides token() too).
  for (const ch of [...subscribe, ...(opts.allowSubscribe ?? [])]) assertValidChannel(ch);
  // Re-assert the load-time invariant at the trust boundary (defense in depth): the pre-created
  // live filter (subscribe) must sit within the read ACL (allowSubscribe), or the provisioner
  // would hand the agent live delivery it isn't permitted to read.
  const allowSubscribe = resolveReadAcl(subscribe, opts.allowSubscribe);
  await provisioner.provisionDmInbox(pr.owner, pr.actor, uid);
  // The Plane-3 backstop carries channel copies only. A channel-less lifecycle has no authorized
  // DLV copy and therefore gets no consumer. Re-granting from [] to nonempty calls the unchanged
  // provisioner path, whose DeliverPolicy.All consumer reads every copy written since the re-grant.
  if (allowSubscribe.length > 0)
    await provisioner.provisionDlvInbox(pr.owner, pr.actor, uid);
  // Record the agent's read ACL in the durable registry (the same act as baking it into the JWT) so the
  // server-side delivery daemon can re-authorize this agent's durable entries + validate its runtime
  // durable-joins — it holds no in-memory ledger. The agent SELF-JOINS its durable boot channels via the
  // daemon at connect (no manager-written boot membership). `durableMembership:false` (an explicit
  // live-only launcher, e.g. `cotal spawn --live-only`) opts out of the ACL row → the daemon never
  // authorizes a durable backstop for it, so it stays live-only.
  // ACL is keyed by the lifecycle-scoped dot-form <owner>.<actor>.<uid> (per-incarnation read authority).
  // reissueAcl — rides THIS mint: allowSubscribe was just baked into the user JWT above. Separate
  // from commitAcl so an ordinary registry writer cannot raise the ceiling by passing a flag
  // (SPEC §9.6). Not crypto-bound to the JWT bytes — process discipline that this call stays next
  // to the mint.
  if (opts.durableMembership !== false) {
    await provisioner.reissueAcl(principalKey(pr.owner, pr.actor).key, uid, allowSubscribe);
  }
  for (const role of taskRoles(opts.role, opts.capabilities)) await provisioner.provisionTaskQueue(role);
  return allowSubscribe;
}
