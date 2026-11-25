/** A run's conclaves: planning the member set from presence, executing the plan against the channel,
 *  members and ACL registries, releasing it at close or discharge, and the lazily opened registry
 *  handles those steps share. The component owns the open plans and the registry handles; the mesh
 *  handler composes it and every other input is read through the handler at its use. */
import { createHash } from "node:crypto";
import {
  chatStream,
  isConcreteChannel,
  assertValidChannel,
  principalKey,
  openMembersRegistry,
  openChannelRegistry,
  openAclRegistry,
  readAcl,
  channelInAllow,
  memberKey,
  writeChannelConfig,
  readMember,
  commitMemberRevision,
  tombstoneMember,
  StaleMembershipWrite,
  type Presence,
  assertAdmittedPublish,
  assertAdmittedSubscribe,
  isStreamNotFound,
} from "@cotal-ai/core";
import type { KV } from "@nats-io/kv";
import {
  Cancelled,
  EffectError,
  type ChannelHandleValue,
  type ConclaveRequest,
  type EffectContext,
  type JournalEntry,
} from "@cotal-ai/lang";
import { parseAgentHandle } from "./mesh-handler-shared.js";
import type { MeshHandler } from "./mesh-handler.js";

/**
 * A conclave's recovery identity: everything the execute, the close and the discharge act on,
 * decided before anything was written and bound as the entry's external state. `registered` is
 * whether THIS conclave minted the channel's registry row (a program-named channel is borrowed,
 * never torn down); per member, `joined` is whether this conclave created the membership row.
 */
interface ConclavePlanMember {
  readonly agent: string;
  /** The member's owner+actor dot-form principal, resolved from its presence row. */
  readonly principal: string;
  readonly uid: string;
  readonly generation: number;
  readonly joined: boolean;
}
interface ConclavePlan {
  readonly channel: string;
  readonly registered: boolean;
  readonly members: readonly ConclavePlanMember[];
}

/** A recorded flag cannot turn a borrowed channel into a channel this step owns. */
function assertConclaveOwnership(plan: ConclavePlan, requestId: string, req?: ConclaveRequest): void {
  const derived = `conclave-${createHash("sha256").update(requestId).digest("hex").slice(0, 12)}`;
  if (plan.registered && plan.channel !== derived)
    throw new Error(`recorded conclave channel ${plan.channel} is not owned by step ${requestId}`);
  if (req !== undefined) {
    if (plan.channel !== (req.channel ?? derived) || plan.registered !== (req.channel === undefined))
      throw new Error(`recorded conclave channel does not match the requested channel for ${requestId}`);
    const members = new Set(req.members.map((member) => member.agent));
    if (plan.members.length !== members.size || plan.members.some((member) => !members.delete(member.agent)))
      throw new Error(`recorded conclave members do not match the request for ${requestId}`);
  }
  for (const member of plan.members) {
    const [owner, actor, ...extra] = member.principal.split(".");
    if (owner === undefined || actor === undefined || extra.length !== 0 || principalKey(owner, actor).key !== member.principal
      || parseAgentHandle(member.agent).uid !== member.uid || !Number.isSafeInteger(member.generation) || member.generation < 1)
      throw new Error(`recorded conclave member identity is malformed for ${requestId}`);
  }
}

/** Whether a recorded external is a conclave plan. A journal is bytes from an earlier process, so
 *  the shape is checked rather than trusted — a malformed external reads as "nothing was bound". */
function isConclavePlan(v: unknown): v is ConclavePlan {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  if (typeof p.channel !== "string" || typeof p.registered !== "boolean" || !Array.isArray(p.members)) return false;
  return p.members.every((m) => {
    if (typeof m !== "object" || m === null) return false;
    const r = m as Record<string, unknown>;
    return typeof r.agent === "string" && typeof r.principal === "string" && typeof r.uid === "string"
      && typeof r.generation === "number" && typeof r.joined === "boolean";
  });
}
/** The one presence row that carries the handle's name AND incarnation, as a principal. None is
 *  the effect's own catchable failure — the agent is down or gone (L4002) — and more than one is
 *  an ambiguity no membership row may be written under. */
function resolveMemberPrincipal(rows: readonly Presence[], agent: string, name: string, uid: string): string {
  const matches = rows.filter((p) => p.card.name === name && p.lifecycleUid === uid);
  if (matches.length === 1) return matches[0]!.card.id;
  if (matches.length === 0)
    throw new EffectError("L4002", "conclave",
      `conclave member "${agent}" is not present on the mesh: no live presence row carries that name and incarnation, so the agent is down or gone`);
  throw new Error(`conclave member "${agent}" is ambiguous: ${matches.length} presence rows claim that name and incarnation`);
}

/** A program-named conclave channel: valid channel grammar AND concrete — membership rows and a
 *  room to talk in are per-channel things a wildcard cannot name. */
function assertConclaveChannel(channel: string): string {
  assertValidChannel(channel);
  if (!isConcreteChannel(channel))
    throw new Error(`conclave channel "${channel}" is a wildcard; a conclave joins its members to one concrete channel`);
  return channel;
}

/** What {@link MeshConclave} reads from the MeshHandler. Every entry is read at use, so a field the handler
 *  assigns after construction is always current, and a handler method a suite replaces is the one that runs. */
export interface MeshConclaveDeps {
  binding: () => MeshHandler["binding"];
  jsm: () => MeshHandler["jsm"];
  nc: () => MeshHandler["nc"];
  now: (...args: Parameters<MeshHandler["now"]>) => ReturnType<MeshHandler["now"]>;
  presenceRows: (...args: Parameters<MeshHandler["presenceRows"]>) => ReturnType<MeshHandler["presenceRows"]>;
  services: () => MeshHandler["services"];
}

/** The conclave members of a mesh handler: its own conclave state, over the handler's other inputs. */
export class MeshConclave {
  constructor(private readonly deps: MeshConclaveDeps) {}

  // The MeshHandler members these bodies read, under their handler names. Each reads through its dep at
  // use, so a field the handler assigns later is current and a method a suite replaces on the handler
  // is the one that runs.
  private get binding() { return this.deps.binding(); }
  private get jsm() { return this.deps.jsm(); }
  private get nc() { return this.deps.nc(); }
  private now(...args: Parameters<MeshHandler["now"]>): ReturnType<MeshHandler["now"]> { return this.deps.now(...args); }
  private presenceRows(...args: Parameters<MeshHandler["presenceRows"]>): ReturnType<MeshHandler["presenceRows"]> { return this.deps.presenceRows(...args); }
  private get services() { return this.deps.services(); }

  private membersKvOpen: Promise<KV> | undefined;
  membersRegistry(): Promise<KV> {
    this.membersKvOpen ??= openMembersRegistry(this.nc, this.binding.space).catch((e) => {
      this.membersKvOpen = undefined;
      throw e;
    });
    return this.membersKvOpen;
  }

  private channelsKvOpen: Promise<KV> | undefined;
  private channelRegistry(): Promise<KV> {
    this.channelsKvOpen ??= openChannelRegistry(this.nc, this.binding.space).catch((e) => {
      this.channelsKvOpen = undefined;
      throw e;
    });
    return this.channelsKvOpen;
  }

  /** The lifecycle read-ACL registry a conclave's membership write is fenced on (#4995). Opened,
   *  never created. A mesh without one (open mode) records no read ACLs, so there is nothing to
   *  fence on and the write proceeds as before: opening a bucket is lazy, so its absence is found
   *  by the first read, which marks the registry absent here. Any other failure stays loud. */
  private aclKvOpen: Promise<KV | undefined> | undefined;
  private aclRegistry(): Promise<KV | undefined> {
    this.aclKvOpen ??= openAclRegistry(this.nc, this.binding.space).then((kv) => kv, (e: unknown) => {
      if (isStreamNotFound(e)) return undefined;
      this.aclKvOpen = undefined;
      throw e;
    });
    return this.aclKvOpen;
  }

  /** Whether the member lifecycle's exact read-ACL row allows `channel` now; true when the space has
   *  no ACL registry at all (open mode), which the read is the first to find out. */
  private async memberAclAllows(aclKv: KV, m: { principal: string; uid: string }, channel: string): Promise<boolean> {
    let row: Awaited<ReturnType<typeof readAcl>>;
    try {
      row = await readAcl(aclKv, m.principal, m.uid);
    } catch (e) {
      if (!isStreamNotFound(e)) throw e;
      this.aclKvOpen = Promise.resolve(undefined);
      return true;
    }
    return row !== undefined && channelInAllow(row.record.allowSubscribe, channel);
  }

  /** The post-write half of the conclave's ACL fence: keep the row just written (at `revision`) only
   *  on proof the member's ACL row still allows the channel. A row the ACL proves disallowed goes by
   *  its exact key, whoever wrote its latest revision. When the read fails nothing is proven, so only
   *  this write is taken back (a later revision belongs to another writer) and the failure is thrown. */
  private async keepMemberRowIfAclAllows(aclKv: KV, membersKv: KV, m: { principal: string; uid: string }, channel: string, revision: number): Promise<void> {
    let allowed: boolean | undefined;
    let readFailure: unknown;
    try { allowed = await this.memberAclAllows(aclKv, m, channel); } catch (e) { readFailure = e; }
    if (allowed === true) return;
    const key = memberKey(channel, m.principal, m.uid);
    if (allowed === false) { await membersKv.purge(key); return; }
    try { await membersKv.purge(key, { previousSeq: revision }); } catch { /* a later write replaced it: that write's row */ }
    throw new Error(`conclave ${channel}: the read ACL of member ${m.principal} (lifecycle ${m.uid}) could not be re-read after its row was written; the write was taken back`, { cause: readFailure });
  }

  /** The chat stream's current last sequence — a conclave join/leave cursor (SPEC §7 interval). */
  private async chatFrontier(): Promise<number> {
    return (await this.jsm.streams.info(chatStream(this.binding.space))).state.last_seq;
  }

  /** The open conclaves this process performed, keyed by the scope's request id, so the close that
   *  follows the body reads the SAME plan the open executed. A crash loses the map and loses
   *  nothing: the plan was bound as the entry's external state before a single row was written,
   *  and a re-entered open repopulates the map from `ctx.resume`. */
  private readonly conclaves = new Map<string, ConclavePlan>();

  /**
   * Release a cancelled conclave's MEMBERSHIP (spec §7.5): a cancelled body performs no new
   * effect, so it never closed its room, and the release travels this recovery path like every
   * other branch-local resource. The entry's own `closed` fact is the gate — a conclave whose
   * body failed but whose close acknowledged holds nothing. An entry with no bound plan created
   * nothing (rows are written only after the bind), so there is nothing to release and no retry
   * that could learn more. Failures are raised: an unfinished release must not be flipped to
   * `issued`, and the driver's next sweep retries idempotently.
   */
  async dischargeConclave(e: JournalEntry): Promise<void> {
    if (e.closed === true) return;
    const plan = e.external;
    if (!isConclavePlan(plan)) return;
    assertConclaveOwnership(plan, e.requestId!);
    await this.releaseConclave(plan);
    this.conclaves.delete(e.requestId as string);
  }

  /**
   * `conclave` open: mint (or take) the channel and join the members as durable membership rows.
   *
   * **The plan is the recovery identity.** Everything the close and the discharge need — the
   * channel, whether this open minted its registry row, and per member the resolved principal,
   * incarnation, generation and whether THIS conclave created the row — is computed first, bound
   * as the entry's external state, and only then executed. A crash before the bind created
   * nothing (rows are written after it); a crash after it re-enters with `ctx.resume` carrying
   * the plan, and the execute converges idempotently without re-resolving anything: the members
   * may have died since, and the recorded plan — not the world's current shape — is what a
   * release answers to.
   *
   * **The channel is handler-derived** when the program names none: `conclave-` plus a digest of
   * the step's own request id, so a resumed run re-derives the same room instead of opening a
   * second one. A program-named channel is taken as-is (validated concrete) and its registry row
   * is left alone — naming a room is not creating one, and the close must not tear down a channel
   * the run merely borrowed.
   *
   * **Members resolve through presence.** A handle carries `<name>#<lifecycleUid>`; the row that
   * maps it to the principal a membership record needs is the seat's own self-published presence —
   * the same source DM name-resolution reads, and the witness the manager's readiness gate
   * requires before a spawn reports `succeeded`. A member with no matching row is down or gone,
   * which is the effect's own catchable failure (L4002), not a handler fault.
   *
   * A member already durably in the channel (a pinned pre-existing room) is planned `joined:
   * false`: the conclave neither re-joins nor — at close — evicts a membership it did not create.
   */
  async openConclave(req: ConclaveRequest, ctx: EffectContext): Promise<ChannelHandleValue> {
    if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
    let plan: ConclavePlan;
    if (isConclavePlan(ctx.resume)) {
      plan = ctx.resume;
    } else {
      plan = await this.planConclave(req, ctx);
      await ctx.bind({ ...plan });
    }
    assertConclaveOwnership(plan, ctx.requestId, req);
    await this.executeConclavePlan(plan);
    this.conclaves.set(ctx.requestId, plan);
    return { channel: plan.channel };
  }

  /**
   * `conclave` close: release exactly what the recorded plan says the open created — tombstone
   * the memberships planned `joined: true`, delete the registry row when this conclave minted the
   * channel. A member that left and rejoined on its own since carries a newer generation, and the
   * stale-write guard makes this leave a no-op for it: the membership is theirs now.
   *
   * Idempotent by the plane (a tombstone at or below an existing leave cursor is a no-op), so the
   * re-entry that retries an unacknowledged close converges. The failure mode is the interpreter's
   * `CloseOwed`: a close that throws leaves the entry pending, which IS the durable "a close is
   * still owed".
   */
  async closeConclave(_req: ConclaveRequest, ctx: EffectContext): Promise<null> {
    const plan = this.conclaves.get(ctx.requestId) ?? (isConclavePlan(ctx.resume) ? ctx.resume : undefined);
    if (plan === undefined)
      throw new Error(`conclave close for "${ctx.requestId}" has no recorded plan: the open that owes this close bound none`);
    assertConclaveOwnership(plan, ctx.requestId);
    await this.releaseConclave(plan);
    this.conclaves.delete(ctx.requestId);
    return null;
  }

  /** Compute the conclave plan from the world: derive or validate the channel, resolve every
   *  member handle to its principal, and read each existing membership row so the join generation
   *  and the created-by-us fact are decided BEFORE anything is written. Duplicate handles collapse
   *  to one planned member — one identity is one membership row. */
  private async planConclave(req: ConclaveRequest, ctx: EffectContext): Promise<ConclavePlan> {
    const derived = req.channel === undefined;
    const channel = derived
      ? `conclave-${createHash("sha256").update(ctx.requestId).digest("hex").slice(0, 12)}`
      : assertConclaveChannel(req.channel!);
    const members: ConclavePlanMember[] = [];
    if (req.members.length > 0) {
      const presence = await this.presenceRows();
      const membersKv = await this.membersRegistry();
      const seen = new Set<string>();
      for (const m of req.members) {
        const { name, uid } = parseAgentHandle(m.agent);
        if (seen.has(`${name}#${uid}`)) continue;
        seen.add(`${name}#${uid}`);
        const principal = resolveMemberPrincipal(presence, m.agent, name, uid);
        const existing = await readMember(membersKv, channel, principal, uid);
        const open = existing !== undefined && existing.record.state === "durable-active" && existing.record.leaveCursor === undefined;
        members.push({
          agent: m.agent,
          principal,
          uid,
          generation: open ? existing.record.generation : (existing?.record.generation ?? 0) + 1,
          joined: !open,
        });
      }
    }
    return { channel, registered: derived, members };
  }

  /** Execute a conclave plan against the registries, idempotently: the registry row is a merge
   *  the re-entry rewrites byte-identical, and a member row is committed only where the plan's
   *  generation is NEWER than what is stored — a re-entry must not roll a landed row's join
   *  cursor forward (the members were mid-conversation when the host died), and a row the world
   *  moved past (an independent leave or rejoin) is theirs, not this conclave's. */
  private async executeConclavePlan(plan: ConclavePlan): Promise<void> {
    if (this.services) {
      // SPEC 14.8: registering a room and writing third-party memberships are management writes
      // the run performs as its own principal, so the admitted ceiling must cover the channel in
      // BOTH directions. A program-named room the run merely borrows is held to the same rule: a
      // conclave is a channel effect whichever way the name was chosen.
      // The publish row an agent's credential carries names the AGENT's triple, so the ceiling
      // is checked under the caller the run was admitted for, never under the run-driver principal
      // this handler runs as: that principal holds no chat row and would deny every conclave the
      // starting caller may in fact hold.
      const view = await this.services.admission();
      const reason = this.services.cancellationObserved?.();
      if (view.revoked !== undefined && reason !== undefined)
        throw new Cancelled(reason);
      assertAdmittedPublish(view, plan.channel, view.admission.caller);
      assertAdmittedSubscribe(view, plan.channel);
    }
    if (plan.registered) {
      await writeChannelConfig(await this.channelRegistry(), plan.channel, {
        description: `a workflow conclave of run ${this.binding.runId}`,
      });
    }
    const joins = plan.members.filter((m) => m.joined);
    if (joins.length === 0) return;
    const membersKv = await this.membersRegistry();
    const joinCursor = await this.chatFrontier();
    for (const m of joins) {
      const existing = await readMember(membersKv, plan.channel, m.principal, m.uid);
      if (existing !== undefined && existing.record.generation >= m.generation) continue;
      const aclKv = await this.aclRegistry();
      // The member lifecycle's exact read-ACL row is the fence a retirement relies on: it is narrowed
      // before the retirement's membership inventory is read, so a row created after that read must
      // refuse itself (#4984). This write is a creating writer outside the delivery daemon (#4995), so
      // it reads that row just before the commit and again after it, as the daemon's join does: a
      // member the row no longer covers gets no row, and a row written while it was narrowed goes.
      if (aclKv !== undefined && !(await this.memberAclAllows(aclKv, m, plan.channel))) continue;
      let written: { revision: number };
      try {
        written = await commitMemberRevision(membersKv, {
          channel: plan.channel,
          owner: m.principal,
          lifecycleUid: m.uid,
          state: "durable-active",
          joinCursor,
          generation: m.generation,
          // No activation catch-up is owed: eligibility starts at the join cursor captured here,
          // so the completeness the flag reports holds by construction — nothing before the join
          // is in this membership's interval.
          activated: true,
          writerIdentity: `${this.binding.caller.owner}.${this.binding.caller.actor}`,
          updatedAt: this.now(),
        });
      } catch (e) {
        // A concurrent newer write won between the read and the commit — same verdict as the
        // read-side skip above: the membership is the newer writer's now.
        if (!(e instanceof StaleMembershipWrite)) throw e;
        continue;
      }
      if (aclKv !== undefined) await this.keepMemberRowIfAclAllows(aclKv, membersKv, m, plan.channel, written.revision);
    }
  }

  /** The world half of ending a conclave, shared by the close and the discharge: tombstone the
   *  memberships this conclave created, then delete the registry row it minted. Idempotent, and
   *  tolerant of exactly one foreign move — a NEWER generation on a row (the member left and
   *  rejoined on its own), which the stale-write guard reports and this leave must not evict. */
  private async releaseConclave(plan: ConclavePlan): Promise<void> {
    // A release is owed cleanup of resources this run created (recorded in the plan), which a
    // revocation does not cancel: the tombstones and the registry delete undo the run's own
    // writes and grant nothing new. The admission must still be READABLE, so an unreachable store
    // refuses here too rather than proceeding on nothing.
    if (this.services) await this.services.admission();
    const joined = plan.members.filter((m) => m.joined);
    if (joined.length > 0) {
      const membersKv = await this.membersRegistry();
      const leaveCursor = await this.chatFrontier();
      const writer = `${this.binding.caller.owner}.${this.binding.caller.actor}`;
      for (const m of joined) {
        try {
          await tombstoneMember(membersKv, plan.channel, m.principal, m.uid, leaveCursor, writer, m.generation);
        } catch (e) {
          if (!(e instanceof StaleMembershipWrite)) throw e;
        }
      }
    }
    if (plan.registered) {
      await (await this.channelRegistry()).delete(plan.channel);
    }
  }
}
