/** A mesh agent's manager-facing commands: spawning and despawning teammates, starting a run,
 *  defining, listing and showing personas, and purging history, each sent to the pinned manager
 *  instance through the agent's manager calls. The mesh agent keeps one forwarder per command. */
import {
  RUN_LAUNCH_DEADLINE_MS,
  isConcreteChannel,
  assertValidChannel,
  channelInAllow,
  assertLifecycleToken,
  isPublishPermissionDenied,
  EP_UNANSWERED,
  type EpAttributedReply,
  type RegistryEndpointsInput,
  type RegistryEndpointsOutput,
  type EpVerbTarget,
  type ControlReply,
  canonicalJson,
  type InlinePersona,
  type PersonaEndpoint,
} from "@cotal-ai/core";
import { CHANNEL_ROUTING_NOT_READY, hasPluginChannelRoot } from "./agent-channels.js";
import type { MeshAgent } from "./agent.js";
import { isAuthed } from "./config.js";

/** Client-side floor for a spawn action's submit + follow. The manager acceptance carries the exact
 *  connector-selected readiness budget, and core extends the follow through that budget plus
 *  delivery margin. This floor still outlives the manager's generic 30s default and protects
 *  older responders whose acceptance predates that field. */
export const SPAWN_TIMEOUT_MS = 40_000;

/** What {@link AgentSupervision} reads from the MeshAgent. Every entry is read at use, so a field the handler
 *  assigns after construction is always current, and a handler method a suite replaces is the one that runs. */
export interface AgentSupervisionDeps {
  config: () => MeshAgent["config"];
  ep: () => MeshAgent["ep"];
  managerCalls: () => MeshAgent["managerCalls"];
  managerInvoke: (...args: Parameters<MeshAgent["managerInvoke"]>) => ReturnType<MeshAgent["managerInvoke"]>;
  requireConnected: (...args: Parameters<MeshAgent["requireConnected"]>) => ReturnType<MeshAgent["requireConnected"]>;
  send: (...args: Parameters<MeshAgent["send"]>) => ReturnType<MeshAgent["send"]>;
}

/** The supervision members of a mesh agent, over the agent's own inputs. */
export class AgentSupervision {
  constructor(private readonly deps: AgentSupervisionDeps) {}

  // The MeshAgent members these bodies read, under their agent names. Each reads through its dep at
  // use, so a field the agent assigns later is current and a method a suite replaces on the agent
  // is the one that runs.
  private get config() { return this.deps.config(); }
  private get ep() { return this.deps.ep(); }
  private get managerCalls() { return this.deps.managerCalls(); }
  private managerInvoke(...args: Parameters<MeshAgent["managerInvoke"]>): ReturnType<MeshAgent["managerInvoke"]> { return this.deps.managerInvoke(...args); }
  private requireConnected(...args: Parameters<MeshAgent["requireConnected"]>): ReturnType<MeshAgent["requireConnected"]> { return this.deps.requireConnected(...args); }
  private send(...args: Parameters<MeshAgent["send"]>): ReturnType<MeshAgent["send"]> { return this.deps.send(...args); }

  // ---- supervision ---------------------------------------------------------

  private readonly pendingSpawns = new Map<string, Promise<ControlReply & { instanceId?: string }>>();

  /** Ask the manager to spawn a new teammate into this space (its `spawn` action).
   *  The request uses {@link SPAWN_TIMEOUT_MS} as its floor; after acceptance, core follows through
   *  the exact connector-selected readiness budget carried by the acceptance.
   *  How it lands — a detached PTY, a tmux window, a cmux tab — is the manager's
   *  runtime; from here it just joins the mesh as a lateral peer. `opts.agent` picks
   *  the harness (absent it, the persona's `agent:` pin, else the manager's default), `opts.model` /
   *  `opts.variant` override the persona file's model selectors, `opts.prompt` submits the new
   *  peer's first turn (or, with `opts.once`, is its one task, after which the manager stops it), `opts.runtime` chooses the terminal runtime of this one seat, and `opts.cwd` roots it at a different folder/repo
   *  than the manager's workspace — the same knobs the operator's `cotal spawn --detach` carries, so
   *  the agent and operator spawn doors share one control-op contract. (Session `resume` is
   *  intentionally NOT forwarded here: forking a host-local `~/.claude` transcript is an
   *  operator-local intent, kept off the peer-facing spawn door — see #159.)
   *
   *  Channels: `opts.join` names concrete channels the new peer joins on top of its persona's read
   *  set, each checked here against THIS agent's read ACL before anything is sent (a spawn never
   *  widens). The request also carries this agent's own read/post ACL as `callerAcl`; the manager
   *  consults it only for a persona that names no channel field, so such a helper is scoped to its
   *  spawner. The joined set is never copied: without `join`, a channel-less persona starts on none.
   *
   *  `opts.persona` defines the helper inline, with `name` as its name: the manager validates and
   *  bounds it as it does a catalog file. Its `model` is audited like the `opts.model` override. */
  async spawn(name: string, role?: string, opts?: { agent?: string; model?: string; variant?: string; launchOptions?: Record<string, unknown>; cwd?: string; prompt?: string; events?: boolean; runtime?: string; instance?: string; join?: string[]; persona?: InlinePersona; once?: { deadlineMs?: number } }): Promise<ControlReply & { instanceId?: string }> {
    await this.requireConnected();
    const raw = opts?.model;
    if (raw !== undefined && !raw.trim())
      return { ok: false, error: "model: must not be empty" };
    const requested = raw?.trim();
    const mode = this.ep.channelRoutingMode?.();
    for (const ch of opts?.join ?? []) {
      try {
        assertValidChannel(ch);
      } catch (e) {
        return { ok: false, error: `join: ${(e as Error).message}` };
      }
      if (!isConcreteChannel(ch)) return { ok: false, error: `join: "${ch}" must be a concrete channel (no wildcard)` };
      if (mode === undefined && isAuthed(this.config) && hasPluginChannelRoot(ch))
        return { ok: false, error: `join: ${CHANNEL_ROUTING_NOT_READY}` };
      if (!channelInAllow(this.config.allowSubscribe, ch, mode === "isolated"))
        return { ok: false, error: `join: "${ch}" is not within your read ACL (allowSubscribe) [${this.config.allowSubscribe.join(", ")}]; a spawn can only hand on channels you may read yourself` };
    }
    let instance: string | undefined;
    try {
      const selected = opts?.instance ?? this.openManagerInstance();
      instance = selected === undefined ? undefined : assertLifecycleToken(selected, "instance");
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (this.config.userAuth && instance !== undefined && this.config.managerInstanceId !== undefined && instance !== this.config.managerInstanceId)
      return { ok: false, error: "the requested manager instance differs from this credential's instance authority" };
    const args = { name, role, agent: opts?.agent, model: requested || undefined, variant: opts?.variant, launchOptions: opts?.launchOptions, cwd: opts?.cwd, prompt: opts?.prompt, events: opts?.events, runtime: opts?.runtime, join: opts?.join, persona: opts?.persona, callerAcl: { allowSubscribe: this.config.allowSubscribe, allowPublish: this.config.allowPublish }, once: opts?.once };
    // P2 item 2 (2b): spawn is an ACTION — follow the acceptance to the terminal so cotal_spawn
    // stays synchronous (the MCP reply carries the live outcome, not the pre-launch acceptance).
    const key = canonicalJson(JSON.parse(JSON.stringify({ ...args, instance, caller: this.ep.principal, lifecycleUid: this.config.lifecycleUid })));
    const previous = this.pendingSpawns.get(key);
    if (previous) {
      const pending = await previous;
      const allocation = pending.data as { name?: string; uid?: string } | undefined;
      // Only an exact-incarnation join or confirmed absence releases this retry claim. A failed
      // read is not evidence that the previous launch vanished.
      if (allocation?.name && allocation.uid) {
        const inspected = await this.managerInvoke("ps", undefined, pending.instanceId ? { instanceId: pending.instanceId } : {});
        const rows = Array.isArray(inspected.data) ? inspected.data as Array<{ name?: string; lifecycleUid?: string; presenceIdentityVerified?: boolean; status?: string }> : undefined;
        const row = rows?.find(r => r.name === allocation.name);
        if (inspected.ok && rows && (!row || typeof row.lifecycleUid === "string" && row.lifecycleUid !== allocation.uid || row.lifecycleUid === allocation.uid && (row.presenceIdentityVerified === true || row.status === "exited"))) {
          if (this.pendingSpawns.get(key) === previous) this.pendingSpawns.delete(key);
        } else return pending;
      } else return pending;
    }
    const invoking = this.managerInvoke("spawn", args, { deadlineMs: SPAWN_TIMEOUT_MS, follow: true, ...(instance !== undefined ? { instanceId: instance } : {}) });
    this.pendingSpawns.set(key, invoking);
    const reply = await invoking;
    if (reply.ok || reply.code !== "uncertain" && reply.outcome !== "unknown") {
      if (this.pendingSpawns.get(key) === invoking) this.pendingSpawns.delete(key);
    }
    // There is no allocated name to inspect before acceptance. Preserve the submission's goal
    // rather than auditing the requested persona alias and discarding the unknown result.
    if ((reply.data as { submissionUnknown?: boolean } | undefined)?.submissionUnknown || !reply.ok && reply.outcome === "unknown") return reply;
    // The record is forwarded as written and the manager records its model as written, so the
    // inline model is audited as sent.
    const pinned = requested || opts?.persona?.model;
    if (!pinned) return reply;
    // A requested pin that the manager did not record is the silent-drop failure (#972): the spawn
    // looks successful, the seat comes up on the harness default, and nothing in the spawn result
    // names the mismatch. Inspect is the manager's recorded pin (persona file, inline persona, or this override).
    // A wait-timeout is still a timeout, not evidence the pin landed — annotate it, never upgrade it.
    const actual = reply.data as { name?: string } | undefined;
    const seat = actual?.name ?? name;
    const recorded = await this.inspectModel(seat, instance);
    const recordedLabel = !recorded.ok
      ? `could not inspect the recorded pin: ${recorded.error}`
      : recorded.model === undefined
        ? "the manager recorded no model pin"
        : `the manager recorded ${JSON.stringify(recorded.model)}`;
    if (recorded.ok && recorded.model !== pinned) {
      return {
        ok: false,
        error:
          `requested model ${JSON.stringify(pinned)} but ${recordedLabel} for "${seat}" — refusing a spawn whose pin did not land. The seat may already be live; inspect it before retrying, because a retry duplicates the spawn`,
      };
    }
    // An uncertain launch stays managed with its pin recorded, so it carries the pin like a started one.
    if (!reply.ok && reply.code !== "uncertain") {
      return {
        ok: false,
        error: `${reply.error ?? "manager refused"} (requested model ${JSON.stringify(pinned)}; ${recordedLabel} for "${seat}")`,
      };
    }
    // The launch stands and only its audit failed. A refusal here reads as "nothing was spawned",
    // and the caller's retry starts a second seat on the same work, so the seat is reported with
    // the failed audit beside it. Nothing stands in for the pin that could not be read.
    if (!recorded.ok) {
      return {
        ...reply,
        data: {
          ...(reply.data as Record<string, unknown> | undefined),
          pinAudit: { requested: pinned, error: recorded.error, ...(recorded.unreported ? { unreported: true } : {}) },
        },
      };
    }
    return {
      ...reply,
      data: { ...(reply.data as Record<string, unknown> | undefined), model: recorded.model },
    };
  }

  /** The manager's recorded model pin for a managed seat (`inspect.model`). Absence is a real
   *  state: a launch may pin none. Distinct from a failed inspect, which cannot attest.
   *  `unreported` marks a failure the manager side settled at once: it answered without the seat's
   *  row, its surface has no `inspect` for this caller, or no responder took the request. */
  async inspectModel(name: string, instance?: string): Promise<{ ok: true; model?: string } | { ok: false; error: string; unreported?: true }> {
    const info = await this.managerInvoke("inspect", { name }, instance === undefined ? undefined : { instanceId: instance });
    if (!info.ok) {
      const unreported = info.code === "not-found" || (info.code === "unavailable" && info.details?.some((d) => d.kind === EP_UNANSWERED) === true);
      return { ok: false, error: info.error ?? "inspect refused", ...(unreported ? { unreported: true as const } : {}) };
    }
    const model = (info.data as { model?: unknown } | undefined)?.model;
    if (model === undefined) return { ok: true };
    if (typeof model !== "string") return { ok: false, error: `inspect returned a non-string model for "${name}"` };
    return { ok: true, model };
  }

  /** The registry listing as this session's manager-call credential sees it (SPEC 13.20), asked
   *  over a connection opened on that credential and described on this session's own. On a static
   *  mesh manager calls ride this session's credential, and a host-issued bearer has no manager-call
   *  credential: `none` says which. `unbound`: that credential carries no listing binding. */
  async listManagerEndpoints(input: RegistryEndpointsInput, instance?: string): Promise<
    | { none: string }
    | { unbound: true }
    | { unbound?: false; reply: EpAttributedReply; page?: RegistryEndpointsOutput }
  > {
    return this.managerCalls.listManagerEndpoints(input, instance);
  }

  /** Resolve a managed agent's CURRENT principal triple (owner-mode targets are (owner, actor,
   *  lifecycleUid), never an alias — §13.2) through the manager's `inspect` read. A STATIC row's
   *  `id` is the bare actor (nkey) under the caller's own owner; a USER-mode row's `id` is the
   *  composite `owner.actor` principal key — split it, or the embedded dot breaks the target
   *  block's subject arity. The owner-mode standing mint pins the caller's OWN owner, so a
   *  foreign-owner target is broker-denied at publish (the same own-domain boundary as ctl).
   *  `instanceId` reads the row from that manager alone. */
  private async managerTargetFor(name: string, instanceId?: string): Promise<{ target: EpVerbTarget } | { error: ControlReply }> {
    const info = await this.managerInvoke("inspect", { name }, instanceId === undefined ? {} : { instanceId });
    if (!info.ok) return { error: info };
    const row = info.data as { id: string; lifecycleUid: string };
    const dot = row.id.indexOf(".");
    const [owner, actor] = dot > 0 ? [row.id.slice(0, dot), row.id.slice(dot + 1)] : [this.ep.principal.owner, row.id];
    return { target: { mode: "owner", owner, actor, lifecycleUid: row.lifecycleUid } };
  }

  /** Ask the manager to tear a teammate down (its `stop` op). Graceful by default —
   *  the session is told to exit cleanly (so it leaves the mesh) before the
   *  process/tab is closed; `graceful:false` is a hard, immediate kill.
   *
   *  No `name` ⇒ self-despawn: rides the self-service control subject and the manager
   *  resolves the target as the managed agent whose id == this caller — so it can only
   *  ever stop itself, never a peer. A `name` ⇒ rides the privileged control subject
   *  (transport-gated to spawn-capable/admin); the manager refines own-child vs admin.
   *  `instance` addresses the manager that runs the named peer, under `spawn`'s pin rules. */
  async despawn(name?: string, opts?: { graceful?: boolean; instance?: string }): Promise<ControlReply> {
    await this.requireConnected();
    const graceful = opts?.graceful ?? true;
    if (!name) {
      if (opts?.instance !== undefined)
        return { ok: false, error: "instance selects the manager of a named peer; omit it to stop yourself" };
      // A conversation's host is the person's own app. No manager holds it, and nothing may stop it.
      if (this.config.turnRelay === false)
        return { ok: false, error: "this connection belongs to a conversation, not a managed seat, so it has no self to stop; disconnecting retires only this connection" };
      // self-halt: the baseline `stop` command, authz-mode self (the caller triple IS the target)
      // Open seats can address their launching manager directly. Static credentials retain their
      // class-only baseline grants; user-auth calls already select their manager through the issuer.
      const instanceId = !this.config.creds ? this.config.managerInstanceId : undefined;
      return this.managerInvoke("stop", { graceful }, {
        target: { mode: "self" },
        ...(instanceId !== undefined ? { instanceId } : {}),
      });
    }
    const pin = this.managerPin(opts?.instance);
    if ("error" in pin) return pin.error;
    const resolved = await this.managerTargetFor(name, pin.instanceId);
    if ("error" in resolved) return resolved.error;
    return this.managerInvoke("despawn", { graceful }, { target: resolved.target, ...pin });
  }

  // ---- workflow runs (SPEC 14.3) -------------------------------------------------------------

  /** One `run-*` command to the hosting manager. The five verbs are untargeted and ride the `run`
   *  capability's rows (open mode: anyone). `start` and `resume` return the run id as soon as the
   *  manager has the drive; the run continues there. Their deadline outlives the manager's own
   *  activation wait, so a slow launch reads as the manager's "still launching" refusal and never
   *  as a manager that did not answer. */
  async run(verb: "start" | "resume" | "answer" | "status" | "ps", args: Record<string, unknown>, instance?: string): Promise<ControlReply> {
    await this.requireConnected();
    const pin = this.managerPin(instance);
    if ("error" in pin) return pin.error;
    return this.managerInvoke(`run-${verb}`, args, {
      deadlineMs: RUN_LAUNCH_DEADLINE_MS,
      ...(verb === "answer" ? { target: { mode: "self" as const } } : {}),
      ...pin,
    });
  }

  /** Open managed seats use their launch address without changing credentialed routing. */
  private openManagerInstance(): string | undefined {
    return !this.config.creds && !this.config.userAuth ? this.config.managerInstanceId : undefined;
  }

  /** An explicit manager instance for a manager call, under `spawn`'s rules: a lifecycle token,
   *  and in user-auth mode no other instance than the one this session is bound to. */
  private managerPin(instance: string | undefined): { instanceId?: string } | { error: ControlReply } {
    if (instance === undefined) return {};
    let instanceId: string;
    try {
      instanceId = assertLifecycleToken(instance, "instance");
    } catch (e) {
      return { error: { ok: false, error: (e as Error).message } };
    }
    if (this.config.userAuth && this.config.managerInstanceId !== undefined && instanceId !== this.config.managerInstanceId)
      return { error: { ok: false, error: "the requested manager instance differs from this credential's instance authority" } };
    return { instanceId };
  }

  /** Ask the manager to purge the space's retained chat backlog (its `purge` op). Cleanup only —
   *  it doesn't touch live agents or the anycast work queue. `includeDms` also clears DM history. */
  async purgeHistory(opts?: { includeDms?: boolean }): Promise<ControlReply> {
    await this.requireConnected();
    const args = { includeDms: opts?.includeDms ?? false };
    return this.managerInvoke("purge", args);
  }

  /** Define a persona and persist it as config (the manager's `definePersona` op writes
   *  .cotal/agents/<name>.md). `spawn(name)` then launches an agent wearing it.
   *
   *  Writing is the whole job: announcing is OPT-IN via `announce`, and silence is the default.
   *  This used to end in a bare `this.send(...)`, which has no channel argument, so
   *  {@link Endpoint.multicast} resolved the destination as the caller's FIRST CONCRETE CHANNEL —
   *  `general` for most personas, purely by list order. Nobody ever chose that: defining a review
   *  panel sprayed one broadcast per seat into every peer's inbox on the mesh. `reply.ok` was the
   *  send's ONLY gate, so a failed manager reply announced nothing — but a host-level tool retry
   *  hit an idempotent overwrite, succeeded again, and announced the same persona twice. The text
   *  was worse than the volume: "spawn it to bring it online" is an imperative addressed to
   *  strangers, indistinguishable from an attempt to get unrelated agents to run someone else's
   *  code, and it tripped a real provenance investigation.
   *
   *  So: no `announce` ⇒ no mesh traffic at all, and the definer already knows what it defined (the
   *  reply says so, and `spawn` on a missing persona fails loud). With `announce` ⇒ that channel and
   *  only that channel, never one inferred from ordering; post rights stay broker-enforced, so a
   *  definer without them fails there loudly rather than falling back to `general`. The wording is a
   *  statement of what the sender did, not an instruction to the reader — the sender's identity is
   *  already on the envelope, so an attributed fact is what a peer can actually evaluate. */
  async definePersona(def: {
    name: string;
    prompt: string;
    instance?: string;
    model?: string;
    role?: string;
    agent?: string;
    subscribe?: string[];
    allowSubscribe?: string[];
    allowPublish?: string[];
    capabilities?: string[];
    endpoints?: PersonaEndpoint[];
    announce?: string;
  }): Promise<ControlReply & { definitionOutcome?: "unknown"; announceError?: string; announceOutcome?: "denied" | "unknown" }> {
    await this.requireConnected();
    const pin = this.managerPin(def.instance ?? this.openManagerInstance());
    if ("error" in pin) return pin.error;
    // Validate the destination BEFORE the write, and here rather than only in the tool's schema —
    // this is the API every host's tool surface funnels through, so a caller that reaches
    // definePersona directly gets the same guarantee. `announce` present must mean EXACTLY that
    // channel: `""` would otherwise be falsy and silently mean "absent" (a supplied destination
    // that quietly publishes nowhere), and a wildcard or a name the subject layer rewrites
    // (`lane/x` → `lane_x`) would publish somewhere the caller did not name. Failing before the
    // write also means a bad destination costs nothing — the alternative is a persona on disk plus
    // an error, which reads as "nothing happened" and invites a retry.
    if (def.announce !== undefined) {
      if (def.announce.trim() === "")
        throw new Error("announce: empty channel — omit it to define silently, or name a concrete channel");
      // `assertValidChannel` returns its input unchanged or THROWS — it never rewrites. An earlier
      // version of this guard compared its return value against the input, which could not fire, and
      // worse: the throw escaped carrying core's own wording, which the tool layer does not
      // recognise as an argument error, so a bad channel was reported as "no manager reachable".
      // Re-throw under the `announce:` prefix so the failure is attributed to the argument that
      // actually caused it.
      try {
        assertValidChannel(def.announce);
      } catch (e) {
        throw new Error(`announce: ${(e as Error)?.message ?? String(e)}`);
      }
      if (!isConcreteChannel(def.announce))
        throw new Error(`announce: "${def.announce}" is a wildcard — announce to one concrete channel`);
    }
    // Explicit role / agent / grants ride with the prompt. A leading frontmatter block in `prompt`
    // is merged by the manager (this layer forwards the fields; it does not wrap).
    const args = {
      name: def.name,
      model: def.model,
      persona: def.prompt,
      role: def.role,
      agent: def.agent,
      subscribe: def.subscribe,
      allowSubscribe: def.allowSubscribe,
      allowPublish: def.allowPublish,
      capabilities: def.capabilities,
      endpoints: def.endpoints,
    };
    const reply = await this.managerInvoke("define-persona", args, pin);
    // A command deadline observes no reply, not a refused write. A paused manager can still
    // write the persona after this caller stops waiting. A describe deadline precedes the write,
    // while broker no-responders and explicit pre-effect refusals prove it did not run.
    if (!reply.ok && reply.outcome !== "not-executed" && (reply.outcome === "unknown" ||
      reply.code === "deadline-exceeded" && reply.details?.some(d => d.kind === EP_UNANSWERED && d.command === "define-persona")))
      return { ...reply, definitionOutcome: "unknown" };
    if (!reply.ok || !def.announce) return reply;
    // The persona IS saved by this point (the manager only replies ok after it writes the file), so
    // a failed announcement must NOT be reported as a failed definition. Reporting it as one names
    // the wrong remediation and invites a retry — and a retry that succeeds is the duplicate
    // announcement this change exists to remove. Report the write as done and the post as failed.
    try {
      await this.send(
        `defined persona \`${def.name}\` — in this workspace's persona catalog, spawnable with cotal_spawn`,
        def.announce,
      );
    } catch (e) {
      // WHY the outcome is classified rather than flattened to a string: only a denial ON THE
      // PUBLISH proves the message did not go out. A chat publish rides JetStream request/PubAck,
      // so a timeout, a reconnect — or a permission denial on the PubAck INBOX SUBSCRIPTION — all
      // leave the stream possibly holding the message while we never saw the ack. Reporting any of
      // those as "it did not go out, post it yourself" is how a caller posts the announcement a
      // second time, which is the exact duplicate this change exists to remove.
      //
      // This used to ask `isPermissionDenied`, which is operation-agnostic by design (it separates
      // denied from service-down, where the operation is irrelevant). Review proved against a live
      // broker that a subscription denial rejects `js.publish()` with the message ALREADY STORED —
      // so that question could not distinguish the one case that proves non-delivery from a case
      // that proves nothing. Ask the narrower question instead, and fail toward "unknown".
      return {
        ...reply,
        announceError: (e as Error)?.message ?? String(e),
        announceOutcome: isPublishPermissionDenied(e) ? "denied" : "unknown",
      };
    }
    return reply;
  }

  /** Mesh-side persona catalog list: name, role, model, description, scoped by the same
   *  ownership rule as `definePersona`. */
  async listPersonas(instance?: string): Promise<ControlReply> {
    await this.requireConnected();
    const pin = this.managerPin(instance ?? this.openManagerInstance());
    if ("error" in pin) return pin.error;
    return this.managerInvoke("list-personas", undefined, pin);
  }

  /** Mesh-side persona catalog show of one card. Unauthorized / missing names are not-found. */
  async showPersona(name: string, instance?: string): Promise<ControlReply> {
    await this.requireConnected();
    const pin = this.managerPin(instance ?? this.openManagerInstance());
    if ("error" in pin) return pin.error;
    return this.managerInvoke("show-persona", { name }, pin);
  }
}
