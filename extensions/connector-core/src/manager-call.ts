import { drainAndClose } from "@cotal-ai/core";
import {
  BASELINE_LIFECYCLE_ENDPOINT,
  EpEnvelopeError,
  EP_UNANSWERED,
  controlReplyFrom,
  controlReplyFromThrown,
  runAgentBearer,
  unansweredRequest,
  undeclaredArg,
  undeclaredArgInstance,
  type CotalEndpoint,
  type ControlReply,
  type GoalResultFact,
  type RegistryEndpointsInput,
  type RegistryEndpointsOutput,
  dialerFor,
  goalFollowRefusal,
  invokeCommand,
  isPermissionDenied,
  issuedUserCaller,
  managerCallerBinding,
  registryListingCaller,
  replyRefusedBeforeEffect,
  resolveService,
  standaloneConnectOpts,
  type EpAttributedReply,
  type EpCaller,
  type EpVerbTarget,
  type IssuedCaller,
  type ResolvedService,
} from "@cotal-ai/core";
import type { NatsConnection } from "@nats-io/transport-node";
import type { AgentConfig } from "./config.js";
import { CONNECTOR_VERSION } from "./version.generated.js";

type ManagerConfig = Pick<AgentConfig, "space" | "servers" | "tls" | "lifecycleUid" | "userAuth" | "managerInstanceId">;

/** A manager-call bearer is reused only while more than this remains before its `exp`, so a
 *  control connection opened with it outlives the longest call it carries (the spawn deadline). */
const MANAGER_BEARER_MARGIN_MS = 120_000;

/** Order two `x.y.z` releases by their numbers, ignoring a prerelease or build suffix. */
function compareRelease(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split(/[-+]/)[0]!.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return (x![i] ?? 0) - (y![i] ?? 0);
  return 0;
}

/** A bearer JWT's `exp` in milliseconds, or undefined when it names none. */
function bearerExpiryMs(token: string): number | undefined {
  try {
    const exp = (JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** `p`, or the signal's reason as soon as it aborts. A shared exchange keeps running for the
 *  other callers when one of them gives up. */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

/** Session manager calls and their shared bearer exchanges. Collaborators stay live per read. */
export class AgentManagerCalls {
  constructor(
    private readonly getConfig: () => AgentConfig,
    private readonly getEndpoint: () => CotalEndpoint,
    private readonly getLaunchEnv: () => NodeJS.ProcessEnv | undefined,
    private readonly invokeEndpoint: (
      endpoint: string,
      command: string,
      args?: Record<string, unknown>,
      opts?: Parameters<CotalEndpoint["invokeService"]>[3],
    ) => Promise<EpAttributedReply>,
  ) {}

  private get config(): AgentConfig { return this.getConfig(); }
  private get ep(): CotalEndpoint { return this.getEndpoint(); }
  private get launchEnv(): NodeJS.ProcessEnv | undefined { return this.getLaunchEnv(); }

  clear(): void {
    this.managerBearers.clear();
  }

  dropBearer(argv: string[]): void {
    this.managerBearers.delete(JSON.stringify(argv));
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
    const user = this.config.userAuth;
    if (!user) return { none: "manager calls ride this session's own credential on this mesh, so the session view covers them" };
    if (!user.bearerCmd) return { none: "this session's bearer comes from its host, which issues no manager-call bearer, so the manager view has no credential" };
    const managerInstanceId = instance ?? this.config.managerInstanceId;
    const token = await this.managerCallBearer([...user.bearerCmd, "--manager-call", ...(managerInstanceId ? ["--manager-instance", managerInstanceId] : [])]).catch((e: unknown) => {
      throw e instanceof Error ? new Error(e.message.replace("--manager-instance <instanceId>", "the instance argument")) : e;
    });
    const exp = bearerExpiryMs(token);
    return withUserManagerListing({ ...this.config, managerInstanceId }, token, exp === undefined ? undefined : exp / 1000, async (nc, listing) =>
      listing === undefined ? { unbound: true as const } : this.ep.listEndpointsOver(nc, listing, input));
  }

  /** Manager-call bearers this session holds, by the exact bearer argv (so by selected manager;
   *  the space, owner, actor and lifecycle are this session's own). One exchange serves every call
   *  until {@link MANAGER_BEARER_MARGIN_MS} before the bearer expires, and concurrent calls share it.
   *  Each call still presents the bearer to the broker and checks its binding, so this keeps no
   *  authorization decision; any failed call drops the entry, so the next one exchanges afresh. */
  private managerBearers = new Map<string, { flight: Promise<string>; refreshAt?: number }>();

  managerCallBearer(argv: string[], signal?: AbortSignal): Promise<string> {
    const key = JSON.stringify(argv);
    const held = this.managerBearers.get(key);
    if (held && (held.refreshAt === undefined || Date.now() < held.refreshAt)) return abortable(held.flight, signal);
    const entry: { flight: Promise<string>; refreshAt?: number } = { flight: this.execBearerCmd(argv) };
    this.managerBearers.set(key, entry);
    entry.flight.then((token) => {
      const exp = bearerExpiryMs(token);
      if (exp === undefined || exp - MANAGER_BEARER_MARGIN_MS <= Date.now()) { if (this.managerBearers.get(key) === entry) this.managerBearers.delete(key); }
      else entry.refreshAt = exp - MANAGER_BEARER_MARGIN_MS;
    }, () => { if (this.managerBearers.get(key) === entry) this.managerBearers.delete(key); });
    return abortable(entry.flight, signal);
  }

  /** Run the spawner's bearer command with this session's environment on every credential path. */
  async execBearerCmd(argv: string[], signal?: AbortSignal, timeoutMs?: number): Promise<string> {
    const bearer = await runAgentBearer(argv, { env: this.launchEnv, signal, timeoutMs });
    if (!bearer) throw new Error(`bearer command printed nothing (${argv[0]})`);
    return bearer;
  }

  /** One v0.4 manager-endpoint invoke (P2 item 1, 1c.2b): the generic {@link CotalEndpoint.invokeService}
   *  path (describe → §13.7 store fetch → digest-verified recompile → typed command), adapted back to
   *  the {@link ControlReply} shape every tool above consumes, with the instance that answered it. `undefined` args are stripped BEFORE the
   *  compiled input contract validates (closed schemas reject present-but-undefined keys; the ctl path
   *  shed them in JSON serialization). A broker-denied publish (a capability the caller's credential
   *  does not hold, e.g. a capability-less purge) has NO responder and surfaces as the deadline —
   *  named here so the refusal reads as the tier boundary it is. */
  async managerInvoke(
    command: string,
    args: Record<string, unknown> | undefined,
    opts: { target?: EpVerbTarget; deadlineMs?: number; follow?: boolean; instanceId?: string } = {},
  ): Promise<ControlReply & { instanceId?: string; outcome?: "executed" | "not-executed" | "unknown" }> {
    const clean = args === undefined ? undefined : Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
    let r: EpAttributedReply;
    let dropBearer: (() => void) | undefined;
    try {
      const input = clean && Object.keys(clean).length ? clean : undefined;
      if (this.config.userAuth) {
        const bearerCmd = this.config.userAuth.bearerCmd;
        if (!bearerCmd)
          return { ok: false, error: `${command}: this agent's bearer comes from its host, which issues no manager-call bearer, so manager operations are unavailable` };
        const managerInstanceId = opts.instanceId ?? this.config.managerInstanceId;
        const { instanceId: _instanceId, follow, ...invokeOpts } = opts;
        // An ambiguity refusal names the bearer command's own selector. This caller passes it from
        // the tool's `instance` argument, so the tool's caller is told that argument instead.
        const bearerArgv = [...bearerCmd, "--manager-call", ...(managerInstanceId ? ["--manager-instance", managerInstanceId] : [])];
        const bearer = (signal?: AbortSignal) => this.managerCallBearer(bearerArgv, signal).catch((e: unknown) => {
          throw e instanceof Error ? new Error(e.message.replace("--manager-instance <instanceId>", "the instance argument")) : e;
        });
        dropBearer = () => { this.managerBearers.delete(JSON.stringify(bearerArgv)); };
        // Subscribe before submission on the renewing main connection. A long accepted launch
        // must not inherit the short-lived control credential's expiry.
        r = await invokeUserManager({ ...this.config, managerInstanceId }, bearer, command, input, {
          ...invokeOpts,
          follow: follow ? (submit, prepare) => this.ep.followServiceGoal(BASELINE_LIFECYCLE_ENDPOINT, submit, opts.deadlineMs, {
            prepare,
            reconcile: async (goalId, attributed, context) => {
              const instanceId = attributed.responder?.instanceId;
              if (!instanceId) throw new Error("accepted goal has no broker-attributed manager instance");
              const bearer = (signal?: AbortSignal) => this.execBearerCmd([
                ...bearerCmd,
                "--manager-call", "--manager-instance", instanceId,
              ], signal, Math.min(30_000, context.deadlineMs));
              // Validate the renewed bearer against the accepting identity, not mutable session state.
              const config = {
                ...this.config, managerInstanceId: instanceId, lifecycleUid: context.caller.uid,
                userAuth: { ...this.config.userAuth!, owner: context.caller.owner, actor: context.caller.actor },
              };
              const queryRes = await invokeUserManager(config, bearer, "goal-result", { goalId }, {
                signal: context.signal, deadlineMs: Math.min(invokeOpts.deadlineMs ?? 10_000, context.deadlineMs),
              });
              if (queryRes.reply.ok !== true) throw new Error(queryRes.reply.error?.message ?? "goal-result query refused");
              return queryRes.reply.data as { goalId: string; result?: GoalResultFact } | undefined;
            },
          }) : undefined,
        });
      } else {
        // Static launches keep their class-only grants. Resolve the launching manager's
        // attributed describe, then use the existing bind fence to refuse sibling deliveries
        // before effects. An explicit instance retains its existing route and grant rules.
        const launchLocal = command === "stop" || command === "spawn" || command === "define-persona";
        const classInstanceId = this.config.creds && launchLocal && opts.instanceId === undefined
          ? this.config.managerInstanceId : undefined;
        r = await this.invokeEndpoint(BASELINE_LIFECYCLE_ENDPOINT, command, input, {
          ...opts, ...(classInstanceId !== undefined ? { classInstanceId } : {}),
        });
      }
    } catch (e) {
      // The verdict "nobody answered" comes from core's answer-provenance marker, NEVER from the
      // catalog code. `deadline-exceeded` has two producers that call for opposite responses: the
      // describe drew no reply at all (nothing ran, and the likely causes are a manager down or a
      // capability this credential does not hold), or a goal was ACCEPTED and its terminal did not
      // arrive in time - where a responder took the request and the effect may already have landed.
      // Keying on the code told every caller the first story for both, which is the peer-side twin
      // of the blanket "no manager reachable" the CLI used to print, and it is the more dangerous
      // half: this surface is read by agents, and "no responder answered" invites the retry that
      // duplicates a spawn. Only the marker distinguishes them, and core sets it exactly where it
      // observed silence.
      dropBearer?.();
      if (e instanceof EpEnvelopeError) {
        const submitted = command === "spawn" && e.outcome === "unknown"
          ? e.details?.find(d => d.kind === EP_UNANSWERED && d.endpoint === BASELINE_LIFECYCLE_ENDPOINT && d.command === command && typeof d.requestId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(d.requestId))
          : undefined;
        if (submitted) return {
          ...controlReplyFromThrown(e, `${e.code}: ${e.message}`),
          outcome: "unknown",
          data: { goalId: submitted.requestId, submissionUnknown: true },
        };
        const undeclared = undeclaredArg(e);
        if (undeclared !== undefined && command !== "status")
          return { ...controlReplyFromThrown(e, await this.undeclaredArgMessage(command, e, undeclared)), ...(e.outcome ? { outcome: e.outcome } : {}) };
        const unknownDefinition = command === "define-persona" && e.outcome !== "not-executed" &&
          e.code === "deadline-exceeded" && e.details?.some(d => d.kind === EP_UNANSWERED && d.command === command);
        const unknownYield = command === "turn-yield" && e.code === "deadline-exceeded" && e.outcome === "unknown" &&
          e.details?.some(d => d.kind === EP_UNANSWERED && d.endpoint === BASELINE_LIFECYCLE_ENDPOINT && d.command === command);
        const message = unknownYield
          ? `${e.code}: ${e.message}. The yield may already have been recorded. After reconnecting, retry cotal_yield with the same turn id and intended status. An already-settled reply confirms the turn is terminal, not which attempt settled it. A successful reply records the yield if it is still active. This retry is not a read-only check.`
          : unknownDefinition
          ? `${e.code}: ${e.message}`
          : unansweredRequest(e)
          ? `${e.message} (no responder answered - a manager may be down, or this credential holds no "${command}" capability and the broker denied the request)`
          : `${e.code}: ${e.message}`;
        return { ...controlReplyFromThrown(e, message), ...(e.outcome ? { outcome: e.outcome } : {}) };
      }
      return { ok: false, error: (e as Error).message };
    }
    if (r.reply.ok !== true) dropBearer?.();
    return {
      ...controlReplyFrom(r.reply),
      instanceId: r.responder?.instanceId,
      ...(r.reply.error?.outcome ? { outcome: r.reply.error.outcome } : {}),
    };
  }

  /** The refusal of an argument the manager's contract does not declare. This connector built the
   *  args from its own release's schema, so the manager runs a different release. The version the
   *  bound manager reports says which side to update; an unbound request names no manager to ask. */
  private async undeclaredArgMessage(command: string, e: EpEnvelopeError, key: string): Promise<string> {
    const head = `${e.code}: ${e.message}. The manager's ${command} does not take "${key}", which this connector at Cotal ${CONNECTOR_VERSION} sends`;
    const instanceId = undeclaredArgInstance(e);
    const answer = instanceId === undefined ? undefined : await this.managerInvoke("status", undefined, { instanceId }).catch(() => undefined);
    const reported = answer?.ok === true && answer.instanceId === instanceId ? (answer.data as { version?: unknown } | undefined)?.version : undefined;
    const manager = typeof reported === "string" && /^\d+\.\d+\.\d+/.test(reported) ? reported : undefined;
    const updateManager = `on the manager's host run \`cotal update --self\`, then \`cotal manager restart\`, or, if you set "${key}", call again without it`;
    if (manager === undefined) return `${head}, so the manager most likely runs an older Cotal: ${updateManager}`;
    const order = compareRelease(CONNECTOR_VERSION, manager);
    if (order > 0) return `${head}. The manager runs Cotal ${manager}, the older side: ${updateManager}`;
    if (order < 0) return `${head}. The manager runs Cotal ${manager}, so this connector is the older side: run \`cotal update --self\` here and start a new session`;
    return `${head}. The manager also reports Cotal ${manager}, so one side is another build of that version: reinstall that side`;
  }
}

/** Credentials whose manager-call view the broker refused an accepted row for. Successful legacy
 *  calls skip that read until {@link LEGACY_RAIL_RECHECK_MS}; a permission-failed resolve rechecks
 *  its own connection, whose issued view may have changed with the direct parent's grant.
 *  Keyed by the credential the bearer was minted from (its renewals keep it), else by the bearer. */
const legacyRail = new Map<string, number>();
const LEGACY_RAIL_RECHECK_MS = 60 * 60_000;
const LEGACY_RAIL_MAX = 32;
function onLegacyRail(key: string): boolean {
  const until = legacyRail.get(key);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  legacyRail.delete(key);
  return false;
}
function rememberLegacyRail(key: string): void {
  legacyRail.set(key, Date.now() + LEGACY_RAIL_RECHECK_MS);
  if (legacyRail.size > LEGACY_RAIL_MAX) legacyRail.delete(legacyRail.keys().next().value!);
}

/** Runs a call's submission under a goal follow. `prepare` runs the bearer command, opens the
 *  control connection and resolves the manager by the follow's deadline. It publishes nothing, so
 *  its failures surface as their own: a describe that draws no reply reports itself as unanswered,
 *  and a stop, or the deadline before the describe, reports the call as not run. */
type UserManagerFollow = (
  submit: (signal?: AbortSignal) => Promise<EpAttributedReply>,
  prepare: (signal: AbortSignal, deadline: number) => Promise<void>,
) => Promise<EpAttributedReply>;

/** Open a manager-call connection on `token` as a manager call opens it, find the caller a registry
 *  listing rides on it (SPEC 13.15), run `ask` over it, and close it. `exp` is the bearer's expiry,
 *  the listing's horizon at the callout. The issued read shares the manager calls' legacy-rail
 *  memory, so a legacy credential is refused that read once, not once per listing. */
export async function withUserManagerListing<T>(
  config: ManagerConfig,
  token: string,
  exp: number | undefined,
  ask: (nc: NatsConnection, listing: IssuedCaller | undefined) => Promise<T>,
): Promise<T> {
  const user = config.userAuth!;
  const binding = managerCallerBinding(token, {
    space: config.space, owner: user.owner, actor: user.actor, lifecycleUid: config.lifecycleUid!, instanceId: config.managerInstanceId,
  });
  const railKey = binding.credentialId ?? token;
  const connectOpts = standaloneConnectOpts({ bearer: token, sentinelCreds: user.sentinelCreds, tls: config.tls });
  const connId = String(connectOpts.name);
  const nc = await dialerFor(config.servers)({ servers: config.servers, ...connectOpts, maxReconnectAttempts: 0, timeout: 10_000 });
  // An issued view lists as itself; any other under the listing generation its credential carries.
  const issued = async (): Promise<IssuedCaller | undefined> => {
    try {
      const caller = await issuedUserCaller(nc, config.space, connId, binding.caller);
      legacyRail.delete(railKey);
      return caller;
    } catch (e) {
      if (!isPermissionDenied(e)) throw e;
      rememberLegacyRail(railKey);
      return undefined;
    }
  };
  try {
    const skipped = onLegacyRail(railKey);
    const caller = skipped ? undefined : await issued();
    const listing = caller ?? await registryListingCaller(nc, config.space, binding.caller, { connId, ...(exp !== undefined ? { exp } : {}) });
    // A remembered legacy verdict may be stale: with no listing binding, check the issued read once.
    return await ask(nc, listing ?? (skipped ? await issued() : undefined));
  } finally {
    await drainAndClose(nc);
  }
}

/** A control connection never replaces the seat's presence, messages or standing bearer source. */
export async function invokeUserManager(
  config: ManagerConfig,
  bearer: (signal?: AbortSignal) => Promise<string>,
  command: string,
  args: Record<string, unknown> | undefined,
  opts: { target?: EpVerbTarget; deadlineMs?: number; follow?: UserManagerFollow; signal?: AbortSignal } = {},
): Promise<EpAttributedReply> {
  opts.signal?.throwIfAborted();
  const user = config.userAuth!;
  const endpoint = BASELINE_LIFECYCLE_ENDPOINT;
  let nc: NatsConnection | undefined;
  let caller: EpCaller;
  let instanceId: string;
  let service: ResolvedService;
  let skippedAcceptedRead: { key: string; connId: string } | undefined;
  const onAbort = () => { void nc?.close(); };
  const resolve = (signal = opts.signal, deadlineMs = opts.deadlineMs ?? 10_000) => resolveService(nc!, config.space, endpoint, caller, {
    instanceId, deadlineMs, signal, commands: opts.follow ? [command, "goal-result"] : [command],
    ...(opts.follow && command !== "goal-result" ? { optionalCommands: ["goal-result"] } : {}),
  });
  const resolvePrepared = async (signal = opts.signal, deadline = Date.now() + (opts.deadlineMs ?? 10_000)) => {
    const remaining = () => {
      signal?.throwIfAborted();
      const left = deadline - Date.now();
      if (left <= 0) throw new EpEnvelopeError("deadline-exceeded",
        "the deadline passed before the manager was resolved; the manager request WAS NOT RUN", undefined, "not-executed");
      return left;
    };
    try {
      return await resolve(signal, remaining());
    } catch (error) {
      if (!skippedAcceptedRead || !isPermissionDenied(error)) throw error;
      const { key, connId } = skippedAcceptedRead;
      skippedAcceptedRead = undefined;
      remaining();
      // Only discovery failed: no command has been submitted. A fresh accepted row binds this
      // connection to the issuer's current view without replaying a write or changing the pin.
      caller = await issuedUserCaller(nc!, config.space, connId, caller);
      legacyRail.delete(key);
      return resolve(signal, remaining());
    }
  };
  const connect = async (signal = opts.signal, deadline = Date.now() + (opts.deadlineMs ?? 10_000)) => {
    const token = await bearer(signal);
    let credentialId: string | undefined;
    ({ caller, instanceId, credentialId } = managerCallerBinding(token, {
      space: config.space, owner: user.owner, actor: user.actor, lifecycleUid: config.lifecycleUid!, instanceId: config.managerInstanceId,
    }));
    const connectOpts = standaloneConnectOpts({ bearer: token, sentinelCreds: user.sentinelCreds, tls: config.tls });
    signal?.throwIfAborted();
    const left = deadline - Date.now();
    if (left <= 0) throw new EpEnvelopeError("deadline-exceeded",
      "the deadline passed before the manager was connected; the manager request WAS NOT RUN", undefined, "not-executed");
    nc = await dialerFor(config.servers)({
      servers: config.servers,
      ...connectOpts,
      maxReconnectAttempts: 0,
      timeout: left,
    });
    // An in-flight dial has no connection handle to close yet. A late result never publishes, and
    // it is closed here because a follow that stopped or reached its deadline has already returned.
    if (signal?.aborted) onAbort();
    signal?.throwIfAborted();
    // Issued interactive views and eligible managed run views carry their own accepted-row read
    // (SPEC 13.15). Memoize genuine legacy refusals to avoid one denied read per polling turn
    // (#5040), but recheck a skipped read if this connection cannot resolve on the legacy rail.
    const railKey = credentialId ?? token;
    if (onLegacyRail(railKey)) {
      skippedAcceptedRead = { key: railKey, connId: String(connectOpts.name) };
    } else {
      try {
        caller = await issuedUserCaller(nc, config.space, String(connectOpts.name), caller);
      } catch (e) {
        if (!isPermissionDenied(e)) throw e;
        rememberLegacyRail(railKey);
      }
    }
  };
  // The describe spends what is left of the follow's deadline, so a silent manager reports itself.
  // With nothing left it would report a silence it had no time to observe.
  const prepare = async (signal: AbortSignal, deadline: number) => {
    await connect(signal, deadline);
    service = await resolvePrepared(signal, deadline);
  };
  const invoke = async (signal = opts.signal) => {
    const unfollowable = opts.follow ? goalFollowRefusal(service) : undefined;
    if (unfollowable) return unfollowable;
    const invokeOpts = { target: opts.target, deadlineMs: opts.deadlineMs, signal };
    const result = await invokeCommand(nc!, config.space, service, command, args, invokeOpts);
    if (result.reply.ok === false && replyRefusedBeforeEffect(result.reply.error)) {
      try {
        service = await resolve(signal);
        const unfollowable = opts.follow ? goalFollowRefusal(service) : undefined;
        if (unfollowable) throw new Error(unfollowable.reply.error.message);
      } catch (error) {
        return { ...result, reply: { ...result.reply, error: {
          ...result.reply.error,
          message: `${command} WAS NOT RUN; manager instance ${instanceId} refused before effects, and re-resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        } } };
      }
      // Keep the second invoke outside the catch: it may execute and must never inherit the
      // first attempt's not-executed verdict if its response is lost.
      return invokeCommand(nc!, config.space, service, command, args, invokeOpts);
    }
    return result;
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (opts.follow) return await opts.follow(invoke, prepare);
    await connect();
    service = await resolvePrepared();
    return await invoke();
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    const control = nc;
    if (control) await drainAndClose(control, 2_000);
  }
}
