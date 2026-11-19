import { MAX_SCHEDULE_MS, parsePrincipalKey, rejectionText } from "@cotal-ai/core";
import type { ControlReply, EpCaller, InlinePersona } from "@cotal-ai/core";
import { authorizeLaunch } from "./authorize.js";
import { launchAgentToStartOpts, launchSpecForRun, materializePersona, parseLaunchSpec, persistLaunchSpec } from "./launch.js";
import type { Manager } from "./manager.js";
import type { SpawnHooks, StartAgentOpts } from "./seat-types.js";

/** A `once` spawn's task deadline when the caller names none: one hour from the spawn's accept. */
const ONCE_DEFAULT_DEADLINE_MS = 60 * 60_000;

/** What {@link StartDoors} reads from the Manager. Every entry is read at use, so a field the Manager
 *  assigns after construction is always current, and a Manager method a test replaces is the one that runs. */
export interface StartDoorsDeps {
  eventsRequired: () => Manager["eventsRequired"];
  execution: () => Manager["execution"];
  remoteAuthority: () => Manager["remoteAuthority"];
  space: () => Manager["space"];
  userMode: () => Manager["userMode"];
  workspaceRoot: () => Manager["workspaceRoot"];
  executionRefusal: (...args: Parameters<Manager["executionRefusal"]>) => ReturnType<Manager["executionRefusal"]>;
  startAgent: (...args: Parameters<Manager["startAgent"]>) => ReturnType<Manager["startAgent"]>;
}

/** The `start` and `launch` control doors: argument checks and the hand-off to `startAgent`. */
export class StartDoors {
  constructor(private readonly deps: StartDoorsDeps) {}

  // The Manager members these bodies read, under their Manager names. Each reads through its dep at
  // use, so a field the Manager assigns later is current and a method a test replaces on the Manager
  // is the one that runs.
  private get eventsRequired() { return this.deps.eventsRequired(); }
  private get execution() { return this.deps.execution(); }
  private get remoteAuthority() { return this.deps.remoteAuthority(); }
  private get space() { return this.deps.space(); }
  private get userMode() { return this.deps.userMode(); }
  private get workspaceRoot() { return this.deps.workspaceRoot(); }
  private executionRefusal(...args: Parameters<Manager["executionRefusal"]>): ReturnType<Manager["executionRefusal"]> { return this.deps.executionRefusal(...args); }
  private startAgent(...args: Parameters<Manager["startAgent"]>): ReturnType<Manager["startAgent"]> { return this.deps.startAgent(...args); }

  /** Parse a served `spawn` request into {@link StartAgentOpts}. The compiled spawn input contract
   *  is the shape check: it already refused a non-mapping `launchOptions`, a `supervise` that is not
   *  the closed `{ restarts, windowMs }` pair, and a list on `subscribe`, `allowSubscribe`,
   *  `allowPublish`, `shareTools`, `join` or `callerAcl` that is not an array of strings. This reads
   *  those fields as admitted, the way it reads the string fields. The connector still validates the
   *  launch-option keys, and `startAgent` still refuses a supervise budget the seat record would not
   *  take. `once` is shape-checked by that same contract. Its omitted `deadlineMs` takes the default
   *  here, and a deadline past the scheduler's last instant is refused here, which the schema does
   *  not express. */
  opStart(args: Record<string, unknown>, caller: string, admin: boolean, hooks?: SpawnHooks, route: "one" | "all" | "inst" = "inst", authenticatedCaller?: EpCaller, served?: string): Promise<ControlReply> {
    const supervise = args.supervise as { restarts: number; windowMs: number } | undefined;
    let once: StartAgentOpts["once"];
    if (args.once !== undefined) {
      const rec = args.once as { deadlineMs?: number };
      // The default is applied here, so every caller of the wire gets the same one.
      const d = rec.deadlineMs ?? ONCE_DEFAULT_DEADLINE_MS;
      if (d !== -1 && (typeof d !== "number" || !Number.isSafeInteger(d) || d < 1 || Date.now() + d > MAX_SCHEDULE_MS))
        return Promise.resolve({ ok: false, error: "once.deadlineMs: expected -1 (no deadline) or a positive whole number of milliseconds that ends by the deadline scheduler's last instant (the end of year 9999)" });
      once = { deadlineMs: d === -1 ? undefined : d };
    }
    const callerAcl = args.callerAcl as StartAgentOpts["callerAcl"];
    // #373: the event-plane admission gate. `startAgent` resolves `eventsRequired || opts.events
    // !== false`, so omission ARMS the plane — a gate on the explicit bit alone is bypassed by
    // omitting it. The gate is on the DECISION, and it runs before connector resolution and
    // before `startAgent` (which mints credentials), so a refusal provisions nothing.
    if (args.eventPayloads !== undefined && typeof args.eventPayloads !== "boolean")
      return Promise.resolve({ ok: false, error: "eventPayloads must be a boolean" });
    const requestedEvents = typeof args.events === "boolean" ? args.events : undefined;
    let eventsNotice: string | undefined;
    let events: boolean | undefined = requestedEvents;
    // Imperative spawns have no payload-selected owner. Local provisioning derives it from
    // the authenticated u_-owner caller; hosted enrollment fixes it to the manager's owner.
    // Match the same owner-domain boundary as authorizeNamed, without treating the spawn's
    // spawner relation as authority over a different owner's session.
    const callerOwner = parsePrincipalKey(caller)?.owner;
    const childOwner = this.remoteAuthority?.owner ?? (callerOwner?.startsWith("u_") ? callerOwner : undefined);
    const ownsChild = this.userMode && callerOwner !== undefined && callerOwner === childOwner;
    if (!admin && !ownsChild) {
      if (requestedEvents === true)
        return Promise.resolve({
          ok: false,
          error: `spawn is operator reach; the caller's current ledger grant does not carry "admin" (SPEC 13.2): events: arming the event plane needs the admin tier`,
        });
      if (this.eventsRequired)
        return Promise.resolve({
          ok: false,
          error: `spawn is operator reach; the caller's current ledger grant does not carry "admin" (SPEC 13.2): space "${this.space}" requires the event plane by registration policy, which cannot be met without the admin tier`,
        });
      // Omission arms by default in startAgent; serve it DISARMED and say so (never a silent
      // downgrade). An explicit `false` is already the opt-out — served as-is, no notice.
      if (requestedEvents === undefined) {
        events = false;
        eventsNotice = `event plane not armed: arming it on spawn needs the admin tier; the spawn was served with events: false`;
      }
    }
    return this.startAgent(
      {
        name: String(args.name ?? "").trim(),
        agent: args.agent as string | undefined,
        defaultAgent: args.defaultAgent as string | undefined,
        role: args.role as string | undefined,
        config: args.config as string | undefined,
        identity: args.identity as string | undefined,
        // Passed as sent: spawnPersona validates the record, the one place every door reads it.
        persona: args.persona as InlinePersona | undefined,
        ...(typeof args.runId === "string" ? { runId: args.runId } : {}),
        model: args.model as string | undefined,
        variant: args.variant as string | undefined,
        launchOptions: args.launchOptions as Record<string, unknown> | undefined,
        resume: args.resume as string | undefined,
        resumeClaim: args.resumeClaim as string | undefined,
        resumeAgent: args.resumeAgent as string | undefined,
        events,
        eventPayloads: args.eventPayloads as boolean | undefined,
        eventsNotice,
        cwd: args.cwd as string | undefined,
        prompt: args.prompt as string | undefined,
        subscribe: args.subscribe as string[] | undefined,
        allowSubscribe: args.allowSubscribe as string[] | undefined,
        allowPublish: args.allowPublish as string[] | undefined,
        join: args.join as string[] | undefined,
        callerAcl,
        shareTools: args.shareTools as string[] | undefined,
        ...(supervise !== undefined ? { supervise } : {}),
        ...(once !== undefined ? { once } : {}),
        ...(typeof args.runtime === "string" ? { runtime: args.runtime.trim() } : {}),
        route,
        ...(served !== undefined ? { served } : {}),
      },
      caller,
      hooks,
      authenticatedCaller,
    );
  }

  /** Boot one resolved agent from a mesh-manifest launch spec, for `cotal spawn -f` onto a RUNNING
   *  manager. The request carries `{ runId, name }` — plus, for a deploy from another checkout or
   *  host, the resolved `spec` itself inline (validated as untrusted input and persisted under THIS
   *  manager's `.cotal/run/` first) — NEVER a path: the manager derives + validates
   *  `.cotal/run/<runId>.json` itself ({@link launchSpecForRun} — token-safe id, no-follow,
   *  `loadLaunchSpec`'s untrusted-input + `validateLaunchPolicy` contract), materializes the named
   *  agent's transient persona, and spawns via the same `startAgent({ resolved })` path as
   *  `supervise --launch`. The reply is enriched for the ownership ledger: the SPAWNED
   *  (collision-numbered) name + nkey id creds are filed under, plus the manifest `requested` name,
   *  `runId`, and resolved `hash`. USER mesh: a privileged-tier launch is owner-equality-authorized
   *  (spec owner === caller owner) before any side effect; the admin tier keeps operator behavior. */
  async opLaunch(args: Record<string, unknown>, caller: string, admin: boolean, hooks?: SpawnHooks, route: "one" | "all" | "inst" = "inst"): Promise<ControlReply> {
    if (this.execution === "none") return { ok: false, error: this.executionRefusal() };
    const runId = String(args.runId ?? "").trim();
    const name = String(args.name ?? "").trim();
    if (!runId || !name) return { ok: false, error: "launch requires runId + name" };
    let spec;
    if (args.spec !== undefined) {
      // REMOTE deploy: the caller pushes the resolved spec inline over the control plane instead of
      // sharing this checkout's disk. Same untrusted-input contract as the file path (strict schema,
      // safe names, policy re-validation), then persisted under OUR `.cotal/run/<runId>.json` so
      // stale-restart and retained resume read the same on-disk source either way. Still never a
      // path: the payload is the spec itself, and where it lands is derived here.
      try {
        spec = parseLaunchSpec(args.spec, `inline launch spec (run ${runId})`);
        if (spec.runId !== runId)
          return { ok: false, error: `inline launch spec runId "${spec.runId}" does not match requested "${runId}"` };
        hooks?.onEffect?.();
        persistLaunchSpec(this.workspaceRoot, spec);
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
    } else {
      try {
        spec = launchSpecForRun(this.workspaceRoot, runId);
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
    }
    const la = spec.agents.find((a) => a.name === name);
    if (!la) return { ok: false, error: `no agent "${name}" in launch spec for run ${runId}` };
    // USER mesh: a manifest launch runs under the spec's apply-time owner, never the ctl caller —
    // fail loud on a spec without one rather than guess (core `MeshLaunchSpec.owner`).
    if (this.userMode && !spec.owner)
      return { ok: false, error: `user-auth space "${this.space}": launch spec for run ${runId} carries no owner - re-apply the manifest as a logged-in operator` };
    if (this.userMode) {
      // Privileged-tier user-mode launch: owner-equality (spec owner === caller owner), decided by
      // the pure policy BEFORE materializePersona or any other side effect, so a denied
      // cross-owner launch writes nothing. Admin tier passes through it unchanged.
      const denied = authorizeLaunch({ specOwner: spec.owner, caller, admin, runId });
      if (denied) return { ok: false, error: denied };
    }
    let configPath: string;
    try {
      hooks?.onEffect?.();
      configPath = materializePersona(this.workspaceRoot, runId, la);
    } catch (e) {
      return { ok: false, error: rejectionText(e) };
    }
    const reply = await this.startAgent({ ...launchAgentToStartOpts(la, configPath, spec.owner, runId), route }, caller, hooks);
    if (reply.ok)
      // `data.name` stays the spawned (numbered) identity — what creds are filed under and the ledger
      // keys on; `requested`/`runId`/`hash` give the CLI the manifest name + drift hash for the ledger.
      reply.data = { ...(reply.data as object), requested: la.name, runId, hash: la.hash, newlyStarted: true };
    return reply;
  }
}
