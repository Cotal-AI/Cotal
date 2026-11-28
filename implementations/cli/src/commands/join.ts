import { userInfo } from "node:os";
import * as readline from "node:readline";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  CotalEndpoint,
  PLUGIN_CHANNEL_ROOT,
  assertValidChannel,
  parseJoinLink,
  resolvePeer,
  AmbiguousPeerError,
  mintLifecycleUid,
  assertLifecycleToken,
  newIdentity,
  mintCreds,
  provisionAgent,
  deleteAcl,
  deleteMember,
  isChannelFamily,
  isConcreteChannel,
  openAclRegistry,
  openMembersRegistry,
  principalKey,
  partsToText,
  peerLabel,
  isConsumerNotFound,
  DmDurableMissingError,
  isPublishPermissionDenied,
  isStreamNotFound,
  readPluginChannelSpaceAuthority,
  credsClaims,
  idFromCreds,
  DEV_OWNER,
  dmStream,
  dmDurable,
  channelRoute,
  chatHistDurable,
  importNativeSubjectPermissions,
  issuedPermitsPattern,
  issuedPermitsSubject,
  projectChannelGrants,
  subjectPatternCovers,
  type Delivery,
  type EndpointKind,
  type PresenceStatus,
  type CotalMessage,
  type ParsedArgs,
  type SpaceAuth,
} from "@cotal-ai/core";
import { CommandFailure, activateTerminalSeat, issueTerminalSeat, retireTerminalSeat, seatExpiryAt, credsSpace, findMesh, inputDisabledByFlag, isConnectRefusal, preflightOrThrow, reachableOrThrow, readCredsFile, refreshRegistrationPolicy, refuseStaticCredsForKnownUserAuth, resolveTargetOrThrow, connectUserControlOrThrow, endpointAuth, type Connection, type MeshEntry, type TerminalSeat, type TerminalSeatTarget, offlineRecipientNotice } from "@cotal-ai/workspace";
import { withControlConnection } from "@cotal-ai/workspace/control";
import { credentialEnded } from "../lib/connect.js";
import { grantOption, shellWord } from "../lib/endpoint-errors.js";
import { FlagValueRefusal } from "../lib/flag-value-refusal.js";
import { withProvisioner } from "../lib/provisioner.js";
import { resolveSpace } from "../lib/status.js";
import { hasPluginChannelRoot, namedChannelMode } from "../lib/transient.js";
import { activityDetail, c, presenceDetail, statusBadge, stderrLine } from "../ui.js";

/** The name a join line shows for another participant. A blank name is not one, so the line uses the id. */
export function joinPeerLabel(card: { name: string; id?: string; role?: string }): string {
  const name = card.name.trim() ? card.name : card.id ?? card.name;
  return peerLabel({ name, ...(card.role ? { role: card.role } : {}) });
}

// The plan's stale-cred fail-fast gate: an unprovisioned / auth-rejected join is ONE classified
// refusal instead of a raw NATS stack. Shared by the self-mint provisioning step (which runs
// BEFORE ep.start) and ep.start itself. Known TLS negotiation refusal is classified here too.
// Unexpected failures still propagate unchanged.
function joinAuthFailure(e: unknown, space: string, credential?: { lifecycleUid: string; channel: string }): CommandFailure | undefined {
  const msg = (e as Error)?.message ?? String(e);
  const missingInbox = e instanceof DmDurableMissingError || /consumer not found|no responders|not provisioned/i.test(msg);
  if (msg === "server does not support 'tls'")
    return new CommandFailure("refused", "UNSUPPORTED", `TLS is required to join ${space}, but this server does not support TLS`, { remedy: "ask the mesh operator for its TLS-enabled broker address" });
  // A --creds join binds the inbox its lifecycle was provisioned with. A credential minted without
  // --provision has none, and neither `cotal up` nor another --creds can make one from here.
  if (credential !== undefined && missingInbox)
    return new CommandFailure("refused", "TARGET_NOT_FOUND", `${space} has no inbox provisioned for this credential's lifecycle ${credential.lifecycleUid}, so it cannot join with it`, {
      remedy: credentialInboxRemedy(space, credential.channel),
    });
  if (missingInbox)
    return new CommandFailure("refused", "TARGET_NOT_FOUND", `${space} isn't provisioned for a console session yet`, { remedy: "run `cotal up` first, or join with --creds/--token" });
  if (/authoriz|permission|not authorized/i.test(msg)) {
    // #1576. THIS USED TO NAME CREDENTIALS AND NOTHING ELSE, and an operator holding valid,
    // unexpired creds spent days pursuing that hypothesis. A durable join is authorized by the
    // delivery daemon off the ACL row, so when its responder is not bound the broker denies the
    // consumer the join needs and the failure surfaces here as a permission error — indistinguishable
    // from a genuinely bad credential unless this sentence says so. Credentials remain the first
    // cause because they usually are; the daemon is now named as the second rather than left out.
    return new CommandFailure("refused", "PERMISSION_DENIED", `not authorized to join ${space}'s channels`, {
      remedy:
        "if your credentials are wrong or missing, pass --creds/--token, or ask the mesh operator for a join link. " +
        "If they are valid, the space's DELIVERY DAEMON may not have its responder bound, which denies durable joins with this same message: ask the operator to check `cotal status --components` (delivery row), since a join needs it bound",
    });
  }
  return undefined;
}

function credentialInboxRemedy(space: string, channel: string): string {
  const read = grantOption("--allow-subscribe", channel);
  return `ask the space's owner to mint the credential with \`cotal auth mint <name> --provision ${read} --space ${shellWord(space)} --no-persona --out <file>\`, then join with the lifecycle UID that mint reports. To keep the original grants, replace \`${read}\` with \`--identity <original-file>\``;
}

/** Diagnose the lifecycle-keyed grants of a static agent credential. The broker still
 * authenticates it first and enforces admission, provisioning and the current ACL. */
async function checkCredentialJoin(creds: string, space: string, uid: string, channel: string, modeForPlugin: () => Promise<ReturnType<CotalEndpoint["channelRoutingMode"]>>): Promise<void> {
  const { pub, sub } = credsClaims(creds).nats ?? {};
  const actor = idFromCreds(creds);
  const inboxPrefix = `$JS.API.CONSUMER.INFO.${dmStream(space)}.dm_${DEV_OWNER}-${actor}-`;
  // Other profiles do not carry an agent's lifecycle-keyed inbox. Leave their refusal
  // to the broker rather than interpreting their unrelated grants as a wrong UID.
  if (!pub?.allow?.some((subject) => subject.startsWith(inboxPrefix))) return;
  const permissions = importNativeSubjectPermissions({ pub, ...(sub ? { sub } : {}) });
  const inbox = `$JS.API.CONSUMER.INFO.${dmStream(space)}.${dmDurable(DEV_OWNER, actor, uid)}`;
  if (!issuedPermitsPattern(permissions.publish, inbox))
    throw new CommandFailure("refused", "PERMISSION_DENIED", `this credential does not grant inbox access for lifecycle ${uid} in ${space}`, {
      remedy: "pass --lifecycle-uid with the lifecycle UID that `cotal auth mint <name> --provision` reported for this credential; a different UID cannot bind its inbox",
    });
  const mode = hasPluginChannelRoot(channel) ? namedChannelMode(await modeForPlugin(), channel, space) : "legacy";
  const route = channelRoute(space, "*", "*", channel, mode);
  const history = `$JS.API.CONSUMER.CREATE.${route.stream}.${chatHistDurable(DEV_OWNER, actor, uid)}.${route.subject}`;
  const canRead = route.rail.kind === PLUGIN_CHANNEL_ROOT
    ? projectChannelGrants(permissions, { space, mode: "isolated", principal: { owner: DEV_OWNER, actor, lifecycleUid: uid } })
      .history.some((row) => row.kind === route.rail.kind && subjectPatternCovers(row.subject, route.subject)) && issuedPermitsPattern(permissions.subscribe, route.subject)
    : issuedPermitsPattern(permissions.publish, history);
  if (!canRead)
    throw new CommandFailure("refused", "PERMISSION_DENIED", `this credential does not grant read access to #${channel} in ${space}`, {
      ...(route.rail.kind === "chat" ? { remedy: `ask the space's owner to mint it with \`cotal auth mint <name> --provision ${grantOption("--allow-subscribe", channel)} --space ${shellWord(space)} --no-persona --out <file>\`, then join with the lifecycle UID that mint reports; add ${grantOption("--allow-publish", channel)} if you also need to post` } : {}),
    });
}

async function preflightChannelMode(space: string, servers: string, creds: string, tls: boolean | undefined): Promise<ReturnType<CotalEndpoint["channelRoutingMode"]>> {
  const ep = new CotalEndpoint({
    space, servers, creds, tls, consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
    readChannelRoutingProjection: true, card: { name: "join-preflight", kind: "endpoint" },
  });
  ep.on("error", () => {});
  try {
    await ep.start();
    return ep.channelRoutingMode();
  } finally {
    await ep.stop().catch(() => {});
  }
}

/** The signer reads authority before issuing the seat. Its provisioner credential never reaches the join. */
async function staticJoinChannelMode(target: TerminalSeatTarget, channel: string): Promise<boolean> {
  if (!hasPluginChannelRoot(channel)) return false;
  const { space, server, auth, tlsRequired } = target;
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  const mode = await withControlConnection(server, { creds, tls: tlsRequired }, async (nc) => {
    const jsm = await jetstreamManager(nc, { checkAPI: false });
    const snapshot = await readPluginChannelSpaceAuthority(jsm, space);
    return snapshot.state.enabled ? "isolated" as const : "legacy" as const;
  }).catch((error: unknown) => isStreamNotFound(error) ? "legacy" as const : undefined);
  return namedChannelMode(mode, channel, space) === "isolated";
}

async function retireJoinSeat(target: TerminalSeatTarget, seat: TerminalSeat, channel: string): Promise<void> {
  await retireTerminalSeat(target, seat);
  if (!isConcreteChannel(channel) && !isChannelFamily(channel)) return;
  const principal = principalKey(DEV_OWNER, seat.actor).key;
  try {
    const creds = await mintCreds(target.auth, newIdentity(), "deprovisioner", {
      deprovisionTarget: { principal, lifecycleUid: seat.lifecycleUid, memberChannels: [channel] },
    });
    await withControlConnection(target.server, { creds, tls: target.tlsRequired }, async (nc) => {
      // An in-flight boot join must not recreate the row after retirement.
      await deleteAcl(await openAclRegistry(nc, target.space), principal, seat.lifecycleUid);
      await deleteMember(await openMembersRegistry(nc, target.space), channel, principal, seat.lifecycleUid);
    });
  } catch (e) {
    stderrLine("! ", `this session's durable channel membership was not retired: ${(e as Error).message}`, c.yellow);
  }
}

/** Refresh a manual user-auth registration's policy before anything is dialed. A refresh that fails
 *  refuses the join, because the entry cannot say whether the space requires events. */
async function registrationPolicy(target: { space: string; policy?: MeshEntry["policy"] }): Promise<void> {
  try {
    await refreshRegistrationPolicy(target);
  } catch (e) {
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `${(e as Error).message}; nothing was joined`, { cause: e });
  }
}

/** `cotal join`. A refusal from the connect path ends it under the refusal's own code, as join's
 *  own refusals do. */
export async function join(args: ParsedArgs): Promise<void> {
  try {
    await joinSpace(args);
  } catch (e) {
    throw isConnectRefusal(e) ? e.failure() : e;
  }
}

function resolveJoinChannel(flag: string | undefined, linked: string | undefined): string {
  const input = flag ?? linked ?? "general";
  const displayed = input.startsWith("#");
  const channel = displayed ? input.slice(1) : input;
  try {
    assertValidChannel(channel);
  } catch (e) {
    throw new CommandFailure("refused", "USAGE_INVALID", (e as Error).message, {
      remedy: displayed ? "pass a valid channel, for example `--channel team.chat`" : undefined,
      cause: e,
      selfContained: true,
    });
  }
  if (displayed && flag === undefined) {
    throw new CommandFailure("refused", "USAGE_INVALID", "the join link channel cannot start with #", {
      remedy: `override the link channel with \`--channel=${shellWord(channel)}\``,
      selfContained: true,
    });
  }
  return channel;
}

function readJoinCreds(path: string, channel: string, space: string | undefined): string {
  const read = grantOption("--allow-subscribe", channel);
  const replacement = "If you need a replacement, ask the space's owner to mint it with " +
    `\`cotal auth mint <name> --provision ${read}${space === undefined ? "" : ` --space ${shellWord(space)}`} --no-persona --out <file>\`, then join with --lifecycle-uid set to the new UID that mint reports`;
  try {
    return readCredsFile(path, { malformedRemedy: `pass the complete credential file as it was issued. ${replacement}` });
  } catch (e) {
    if (isConnectRefusal(e) && e.code === "TARGET_NOT_FOUND") throw e.failure(() => `check the path. ${replacement}`);
    throw e;
  }
}

async function joinSpace(args: ParsedArgs): Promise<void> {
  const values = args.values as { space?: string; name?: string; role?: string; channel?: string; server?: string; kind?: string; link?: string; token?: string; creds?: string; "lifecycle-uid"?: string; tls?: boolean; "expires-in"?: string; "expires-at"?: string };
  const expiresAt = seatExpiryAt(values);
  const expiryRefusal = (why: string) => new FlagValueRefusal(`--expires-in and --expires-at set the expiry of the credential a bare join mints on a static mesh; ${why}`, "drop the flag");

  // A join link carries server + auth + space; explicit flags still override it.
  let link: ReturnType<typeof parseJoinLink> | undefined;
  try {
    link = values.link ? parseJoinLink(values.link) : undefined;
  } catch (e) {
    throw new CommandFailure("refused", "USAGE_INVALID", (e as Error).message, { remedy: "pass the cotal:// or cotals:// link the space's operator gave you", cause: e, selfContained: true });
  }
  const name = values.name ?? userInfo().username;
  // A HUMAN joining from a terminal, not a persona-driven agent: they typed `cotal join` to land
  // somewhere and talk, so a landing channel is the point of the command. `general` stays the
  // default HERE only - an agent's read set comes from its persona and defaults to no channel.
  const channel = resolveJoinChannel(values.channel, link?.channels?.[0]);
  const auth = {
    token: values.token ?? link?.token,
    user: link?.user,
    pass: link?.pass,
    creds: values.creds ? readJoinCreds(values.creds, channel, values.space ?? link?.space) : undefined,
    tls: values.tls ?? link?.tls ?? false,
  };
  // The join session's lifecycle UID (SPEC 13.1). The pairing input (--lifecycle-uid /
  // COTAL_LIFECYCLE_UID) is scoped STRICTLY to an explicit --creds join: that credential's durable
  // grants name exact lifecycle-keyed resources, so the uid minted alongside it is the only one the
  // broker will bind, and it is REQUIRED (never invented). Every OTHER path leaves it undefined so
  // the endpoint self-mints a fresh per-session identity at construction: an open/token/link/bare
  // join must NOT inherit an ambient shell's COTAL_LIFECYCLE_UID (that would reuse another
  // incarnation's uid). Auth-mode self-provision (below) mints its own.
  const flagUid = values["lifecycle-uid"];
  const envUid = process.env.COTAL_LIFECYCLE_UID?.trim() || undefined;
  // An EXPLICIT --lifecycle-uid without --creds is a misuse (refuse loudly). An AMBIENT
  // COTAL_LIFECYCLE_UID without --creds is just a shell leaking a spawned agent's env - silently
  // IGNORE it (an open/token/link/bare join never inherits another incarnation's uid; it
  // self-mints). Only WITH --creds is either read, as the launcher's pairing.
  if (flagUid !== undefined && !values.creds)
    throw new CommandFailure("refused", "USAGE_INVALID", "--lifecycle-uid applies only to an explicit --creds join - an open/token/link/bare join self-mints a fresh per-session lifecycle", { remedy: "drop the flag, or pass --creds", selfContained: true });
  if (auth.creds !== undefined) {
    let profile: string | undefined;
    try { profile = credsClaims(auth.creds).name; } catch { /* leave undecodable credentials to preflight */ }
    if (profile === "observer" || profile === "admin") {
      throw new CommandFailure(
        "refused",
        "PERMISSION_DENIED",
        `an ${profile}-profile credential cannot join as a mesh participant: \`cotal join\` requires a provisioned agent credential`,
        {
          remedy: `mint an agent credential with \`cotal auth mint <name> --provision ${grantOption("--allow-subscribe", channel)} --out <file>\`, then join with the --lifecycle-uid that mint reports; add ${grantOption("--allow-publish", channel)} if you also need to post`,
        },
      );
    }
  }
  let lifecycleUid: string | undefined = values.creds ? (flagUid ?? envUid) : undefined;
  if (lifecycleUid !== undefined) {
    try {
      assertLifecycleToken(lifecycleUid);
    } catch (e) {
      throw new CommandFailure("refused", "USAGE_INVALID", (e as Error).message, { remedy: "pass the lifecycle UID minted alongside this credential", cause: e, selfContained: true });
    }
  }
  if (values.creds && lifecycleUid === undefined)
    throw new CommandFailure(
      "refused",
      "USAGE_INVALID",
      "--creds is lifecycle-paired (SPEC 13.1): the credential's durable grants name exact lifecycle-keyed resources, so a made-up uid would name durables it cannot bind",
      { remedy: "pass --lifecycle-uid <uid> (or set COTAL_LIFECYCLE_UID) with the UID that `cotal auth mint <name> --provision` reported for this credential", selfContained: true },
    );

  let space: string;
  let server: string;
  let userConnection: Connection | undefined;
  let mintedFrom: SpaceAuth | undefined;
  // A self-minted session's issuance: the token its endpoint reads its generation with, and the
  // retirement of its lifecycle's gate, which runs once when the session leaves.
  let acceptedToken: string | undefined;
  let retireSeat: (() => Promise<void>) | undefined;
  const leaveSeat = async (): Promise<void> => {
    const retire = retireSeat;
    retireSeat = undefined;
    if (retire) await retire().catch((e) => stderrLine("! ", `this session's issued credential was not retired: ${(e as Error).message}`, c.yellow));
  };
  // An explicit connection (a join link, --token, or --creds) is taken at face value — that's the
  // escape hatch. Otherwise resolve the running mesh from any directory (server + trust material)
  // and self-mint, so a bare `cotal join` works outside the project instead of crashing credless.
  if (link || values.token || values.creds) {
    if (expiresAt !== undefined) throw expiryRefusal("this join connects with a credential it was given");
    // With no space or broker named, the credential goes to the selected space or this folder's.
    const resolved = values.space === undefined && link?.space === undefined && values.server === undefined ? credsSpace(process.cwd()) : undefined;
    space = values.space ?? link?.space ?? resolved?.space ?? resolveSpace(process.cwd());
    // The credential goes only to a broker the caller paired it with: `--server`, the link's own
    // address, or the address the space is registered at. The default address is never assumed for it.
    const recorded = (values.server ?? link?.servers) === undefined ? findMesh(space) : undefined;
    const paired = values.server ?? link?.servers ?? recorded?.server;
    if (paired === undefined)
      throw new CommandFailure("refused", "TARGET_NOT_FOUND", `${values.creds ? "--creds" : "--token"} needs --server <url> or a registered --space: space "${space}" is not registered here, so nothing was dialed`, {
        remedy: "pass the broker this credential belongs to with --server <url>, or join with its link",
        target: { space },
      });
    server = paired;
    if (recorded?.tlsRequired) auth.tls = true;
    await registrationPolicy({ space, policy: findMesh(space)?.policy });
    // An omitted server must still match a recorded user mesh on a non-default port, so the check
    // gets the caller's own server and not the one resolved from the record.
    refuseStaticCredsForKnownUserAuth(space, values.server ?? link?.servers, "interactive join");
    // Preflight with the ACTUAL auth (probeConnect, not isReachable — which returns true on an auth
    // REJECT, so a bad --creds/token/link would skip the check and crash raw at ep.start()). One
    // sentence on unreachable vs credentials-rejected, then we connect with the same auth.
    const addressFlags = values.server !== undefined ? (link ? "--server and --link" : "--server") : link ? "--link" : undefined;
    await reachableOrThrow(server, auth, values.creds ? {
      space, path: values.creds, named: values.space !== undefined || link !== undefined || resolved !== undefined,
      addressFlags, landingChannel: channel,
    } : undefined);
    if (values.creds) await checkCredentialJoin(auth.creds!, space, lifecycleUid!, channel, () => preflightChannelMode(space, server, auth.creds!, auth.tls));
  } else {
    // Self-mint: a bare `cotal join` becomes a console on the running mesh. In auth mode it self-provisions
    // exactly like the manager does at spawn — open a short-lived `provisioner`, pre-create THIS console's
    // own bind-only dm_<id>/dlv_<id> durables + record its read ACL, then connect as a plain `agent`. The
    // console never HOLDS provisioner authority as a session cred (mint → provision own inbox → drop →
    // connect as agent), so the DM CONSUMER.CREATE surface exists only for the provisioning window — the
    // same containment as the manager's `withProvisioner`. This fixes the unprovisioned-console
    // ConsumerNotFound (a self-minted console had no manager to pre-create its dm_<id> durable) AND drops
    // the last broad `manager` mint off the console. Open mode (no auth) is unchanged — connect bare.
    const target = await resolveTargetOrThrow({ server: values.server, space: values.space });
    if (expiresAt !== undefined && target.mode === "user")
      throw expiryRefusal(`mesh "${target.space}" is a user-auth mesh, where the session's bearer comes from your login`);
    await registrationPolicy(target);
    space = target.space;
    server = target.server;
    // Join never launches or attaches a harness, even headless. Required events apply to native
    // harness turns, not this endpoint's messages. Do not invent AG-UI runs for terminal sends.
    if (target.mode === "user") {
      userConnection = await connectUserControlOrThrow({ space, server });
      if (!userConnection.bearer || !userConnection.sentinelCreds || !userConnection.epCaller)
        throw new Error("interactive join requires a complete user bearer, sentinel and lifecycle");
      lifecycleUid = userConnection.epCaller.uid;
    } else {
      await preflightOrThrow(target); // one refusal if the mesh is down / won't auth, + stale-prune
    }
    if (expiresAt !== undefined && !target.auth)
      throw expiryRefusal(`mesh "${space}" is open and mints no credential`);
    if (target.mode !== "user" && target.auth) {
      const spaceAuth = target.auth;
      const identity = newIdentity();
      // One lifecycle per join session (SPEC 13.1): the provisioned dm/dlv footprint, the minted
      // grants, and the endpoint's binds all carry this uid.
      // A launcher-supplied uid (flag/env, resolved above) wins; the session mints only when bare.
      lifecycleUid ??= mintLifecycleUid();
      // The session's credential is an issuance (SPEC 13.15) whose evidence names this lifecycle's
      // gate, which leaving retires. The provisioner's own errors stay inside withProvisioner: a
      // failed stop never becomes this join's provisioning failure.
      const seatTarget = { server, space, tlsRequired: target.tlsRequired, auth: spaceAuth };
      const thisSeat = { actor: identity.id, alias: identity.id, lifecycleUid };
      try {
        const pluginChannelsEnabled = await staticJoinChannelMode(seatTarget, channel);
        await withProvisioner({ space, servers: server, tls: seatTarget.tlsRequired, auth: spaceAuth }, "join-provisioner", async (prov) => {
          await activateTerminalSeat(seatTarget, thisSeat);
          retireSeat = () => retireJoinSeat(seatTarget, thisSeat, channel);
          // Record the read ACL so the endpoint can self-join its channel's durable backstop.
          auth.creds = await issueTerminalSeat(seatTarget, thisSeat, expiresAt, (issue) => {
            acceptedToken = issue.issued.acceptedToken;
            return provisionAgent(prov, spaceAuth, identity, {
              subscribe: [channel],
              allowSubscribe: [channel],
              allowPublish: [channel],
              pluginChannelsEnabled,
              role: values.role,
              lifecycleUid,
              expiresAt: issue.expiresAt,
              issued: issue.issued,
              issuance: issue.issuance,
            });
          });
          mintedFrom = spaceAuth;
        });
      } catch (e) {
        await leaveSeat();
        // The self-mint step runs BEFORE ep.start(), so its auth/provisioning failure must render
        // legibly too — same fail-fast gate, not a raw NATS error leaked through the on-error channel.
        throw joinAuthFailure(e, space) ?? e;
      }
    }
  }

  // The native endpoint owns fetch-ahead, reconnects and retry warnings. Resolve fresh login
  // material for each renewal, but never adopt a successor lifecycle or changed trust position.
  const pinnedRegistration = userConnection ? findMesh(space) : undefined;
  let firstBearer = userConnection?.bearer;
  const bearer = userConnection ? async () => {
    if (firstBearer !== undefined) {
      const initial = firstBearer;
      firstBearer = undefined;
      return initial;
    }
    const registration = findMesh(space);
    if (!registration || registration.mode !== "user" || registration.server !== pinnedRegistration?.server ||
        registration.tlsRequired !== pinnedRegistration?.tlsRequired || registration.root !== pinnedRegistration?.root ||
        JSON.stringify(registration.userAuth) !== JSON.stringify(pinnedRegistration?.userAuth))
      throw new Error("join registration trust changed; leave and join again");
    const fresh = await connectUserControlOrThrow({ space, server });
    const pinned = userConnection!;
    if (fresh.epCaller?.owner !== pinned.epCaller!.owner || fresh.epCaller?.actor !== pinned.epCaller!.actor ||
        fresh.epCaller?.uid !== lifecycleUid || fresh.server !== pinned.server || fresh.tls !== pinned.tls ||
        fresh.sentinelCreds !== pinned.sentinelCreds || fresh.root !== pinned.root ||
        JSON.stringify(fresh.userAuth) !== JSON.stringify(pinned.userAuth))
      throw new Error("join bearer renewal changed the session's principal, lifecycle or connection trust; leave and join again");
    if (!fresh.bearer) throw new Error("join bearer renewal returned no user bearer");
    return fresh.bearer;
  } : undefined;

  const ep = new CotalEndpoint({
    space,
    servers: server,
    ...(userConnection ? { ...endpointAuth(userConnection), bearer } : auth),
    // Absent for a bare open/token join: the endpoint self-mints its per-session lifecycle at
    // construction. Set for auth joins: self-provisioned above, or --creds-paired (never invented).
    lifecycleUid,
    ...(acceptedToken !== undefined ? { acceptedToken } : {}),
    channels: [channel],
    card: {
      ...(userConnection ? { owner: userConnection.epCaller!.owner, actor: userConnection.epCaller!.actor } : {}),
      name,
      role: values.role,
      kind: (values.kind as EndpointKind) ?? "agent",
    },
  });
  const me = ep.card.id;
  const publishClaims = auth.creds === undefined ? undefined : credsClaims(auth.creds).nats?.pub;
  const publishPermission = auth.creds === undefined ? undefined
    : importNativeSubjectPermissions(publishClaims === undefined ? {} : { pub: publishClaims }).publish;
  const concreteChannel = isConcreteChannel(channel);
  const canBroadcast = () => {
    if (!concreteChannel) return false;
    const mode = ep.channelRoutingMode();
    if (mode === undefined && hasPluginChannelRoot(channel)) return false;
    return publishPermission === undefined || issuedPermitsSubject(publishPermission,
      channelRoute(space, ep.principal.owner, ep.principal.actor, channel, mode ?? "legacy").subject);
  };
  const patternBroadcastNotice = "Broadcasts need a concrete channel, not a subscription pattern.";
  const broadcastDenied = () => `this session is read-only on #${channel}: it lacks publish permission; nothing was sent.` +
    (hasPluginChannelRoot(channel) && ep.channelRoutingMode() !== "legacy" ? "" : userConnection
      ? ` ask the space's owner to grant this identity permission to post to #${channel}`
      : ` ask the space's owner to mint a credential with \`cotal auth mint <name> --provision ${grantOption("--allow-subscribe", channel)} ${grantOption("--allow-publish", channel)} --out <file>\`, then join with the lifecycle UID that mint reports`);

  // A headless join holds presence and logs mesh events without reading stdin.
  const terminal = process.stdout.isTTY ? process.stdout : process.stderr.isTTY ? process.stderr : undefined;
  let rlClosed = false;
  let promptReady = false;
  const rl = terminal && process.stdin.isTTY && !inputDisabledByFlag()
    ? readline.createInterface({
        input: process.stdin,
        output: terminal,
        prompt: c.dim(`${name}> `),
      })
    : undefined;

  const print = (line: string) => {
    if (terminal && rl && promptReady && !rlClosed) {
      readline.cursorTo(terminal, 0);
      readline.clearLine(terminal, 0);
    }
    console.log(line);
    if (rl && promptReady && !rlClosed) rl.prompt(true);
  };

  const who = (card: { name: string; id?: string; role?: string }) => c.bold(joinPeerLabel(card));

  // A post on a durable channel reaches this session twice under one id: once on the live channel
  // subscription and once from the Plane-3 backstop. SPEC §4 makes the receiver deduplicate by id,
  // so each id prints once. An empty id asserts no identity and is never a key. Two rotating
  // windows bound the memory, the same shape the connector's ingest uses.
  let printedIds = new Set<string>();
  let printedIdsPrev = new Set<string>();
  const alreadyPrinted = (id: string): boolean => {
    if (id === "") return false;
    if (printedIds.has(id) || printedIdsPrev.has(id)) return true;
    printedIds.add(id);
    if (printedIds.size >= 4096) {
      printedIdsPrev = printedIds;
      printedIds = new Set();
    }
    return false;
  };

  ep.on("message", (m: CotalMessage, d: Delivery) => {
    if (alreadyPrinted(m.id)) {
      d.ack(); // the other path's copy of a message already printed
      return;
    }
    const text = partsToText(m.parts);
    if (m.to === me)
      print(`${c.magenta("(DM)")} ${who(m.from)} ${c.dim("→ you:")} ${text}`);
    else if (m.toService)
      print(`${c.yellow("(@" + m.toService + ")")} ${who(m.from)}: ${text}`);
    else print(`${c.cyan("#" + (m.channel ?? "?"))} ${who(m.from)}: ${text}`);
    d.ack(); // printed = surfaced
  });

  ep.on("presence", (ev) => {
    if (ev.presence.card.id === me) return; // ignore self
    if (ev.type === "join")
      print(c.green(`→ ${who(ev.presence.card)} joined `) + statusBadge(ev.presence.status) + presenceDetail(ev.presence));
    else if (ev.type === "offline")
      print(c.dim(`← ${who(ev.presence.card)} went offline`));
    else
      print(
        `${c.dim("•")} ${who(ev.presence.card)} ${statusBadge(ev.presence.status)}${presenceDetail(ev.presence)}${activityDetail(ev.presence)}`,
      );
  });

  // A session that cannot come back ends with the reason and what to run, rather than retrying for
  // good. A reconnect that finds its inbox gone from the broker cannot bind it again. A credential
  // the broker now refuses for good ends it with the refusal a one-shot command with that credential
  // gets, as `history --follow` ends. A user-auth join's inbox is the operator's to provision and its
  // bearer renewal reports a changed trust, so it keeps re-establishing.
  const credential: Connection | undefined = auth.creds === undefined ? undefined
    : { server, space, tls: auth.tls, creds: auth.creds, ...(mintedFrom ? { auth: mintedFrom } : {}) };
  let started = false, connected = false, checking = false, leaving = false;
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  let finishSession!: () => void;
  const sessionFinished = new Promise<void>((resolve) => { finishSession = resolve; });
  let lose!: (failure: Error) => void;
  const lost = new Promise<Error>((resolve) => { lose = resolve; });
  const shutdown = async (code = 0) => {
    if (leaving) return;
    leaving = true;
    if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer);
    rl?.close();
    print(c.dim("leaving…"));
    try { await ep.stop(); } catch { /* closing */ }
    await leaveSeat();
    if (code === 0) {
      finishSession();
      return;
    }
    process.exit(code);
  };
  rl?.once("close", () => {
    rlClosed = true;
    if (started) void shutdown();
  });
  const checkCredential = () => {
    if (!started || leaving || checking || credential === undefined) return;
    checking = true;
    void credentialEnded(credential).catch(() => undefined).then((refusal) => {
      checking = false;
      if (leaving || !refusal) return;
      if (mintedFrom !== undefined && expiresAt !== undefined && Date.now() >= expiresAt * 1000 && refusal.code === "AUTH_REQUIRED") {
        void shutdown(0);
        return;
      }
      lose(refusal);
    });
  };
  ep.on("connection", ({ connected: up }: { connected: boolean }) => {
    connected = up;
    if (!up && !leaving) {
      if (mintedFrom !== undefined && expiresAt !== undefined && Date.now() >= expiresAt * 1000) void shutdown(0);
      else checkCredential();
    }
  });
  ep.on("error", (e: Error) => {
    if (leaving) return;
    if (mintedFrom !== undefined && expiresAt !== undefined && Date.now() >= expiresAt * 1000 && /authentication expired|credential expired/i.test(e.message)) {
      void shutdown(0);
      return;
    }
    print(c.red(`! ${e.message}`));
    checkCredential();
  });
  ep.on("warning", (e: Error) => {
    if (leaving) return;
    if (started && !connected && !userConnection && (isConsumerNotFound(e) || e instanceof DmDurableMissingError))
      return lose(new CommandFailure("refused", "TARGET_NOT_FOUND", "this join can no longer reconnect: its inbox is gone from the broker", {
        target: { space },
        remedy: values.creds
          ? credentialInboxRemedy(space, channel)
          : "run the same `cotal join` again to start a new session",
      }));
    print(c.yellow(`! ${e.message}`));
  });
  /** Leave once the session is lost: stop the endpoint and end with its refusal. */
  const whenLost = async (): Promise<never> => {
    const failure = await lost;
    leaving = true;
    if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer);
    rl?.close();
    try { await ep.stop(); } catch { /* it ends either way */ }
    await leaveSeat();
    throw failure;
  };

  try {
    await ep.start();
  } catch (e) {
    await leaveSeat();
    // A bare `cotal join` binds a durable DM inbox nobody pre-created on an unprovisioned space;
    // surface that (and an auth reject) as ONE classified refusal, not a raw NATS stack.
    throw joinAuthFailure(e, space, values.creds ? { lifecycleUid: lifecycleUid!, channel } : undefined) ?? e;
  }
  started = true;
  if (rlClosed) return shutdown();
  if (mintedFrom !== undefined && expiresAt !== undefined) {
    const endAtLifetime = () => {
      if (leaving) return;
      const remaining = expiresAt * 1000 - Date.now();
      if (remaining <= 0) return void shutdown(0);
      lifetimeTimer = setTimeout(endAtLifetime, Math.min(remaining, 2_147_483_647));
      lifetimeTimer.unref();
    };
    endAtLifetime();
  }

  // `/quit`, terminal EOF and a requested session lifetime leave with 0. A signal leaves the same way with its code.
  process.on("SIGINT", () => void shutdown(130));
  process.on("SIGTERM", () => void shutdown(143));

  if (!terminal || !rl) {
    console.log(
      c.dim(`${peerLabel({ name, role: values.role })} holding presence in ${space} - headless, stdin is not read`),
    );
    return Promise.race([whenLost(), sessionFinished]); // park; event handlers do the work
  }

  terminal.write(
    `${c.dim(`Joined ${c.bold(space)} as ${who({ name, role: values.role })} on #${channel}.`)}\n`,
  );
  terminal.write(
    c.dim(
      `${!concreteChannel ? patternBroadcastNotice : canBroadcast() ? "Type to broadcast." : `Read-only on #${channel}; this credential has no publish permission.`} Commands: /who  /dm <name> <msg>  /anycast <role> <msg>  /working [x]  /waiting [x]  /idle  /me <activity>  /quit\n\n`,
    ),
  );
  setTimeout(() => {
    const others = ep.getRoster().filter((p) => p.card.id !== me);
    if (others.length)
      print(
        c.dim("Present: ") +
          others.map((p) => who(p.card) + " " + statusBadge(p.status) + presenceDetail(p)).join(c.dim(", ")),
      );
  }, 400);
  const setStatus = async (status: PresenceStatus, activity?: string) => {
    if (activity) await ep.setActivity(activity);
    await ep.setStatus(status);
    const acknowledgedStatus = status === "working" ? "working · progress unknown" : status;
    print(c.dim(`(you are now ${acknowledgedStatus}${activity ? ": " + activity : ""})`));
  };

  rl.on("line", async (raw) => {
    if (leaving || rlClosed) return;
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      return;
    }
    try {
      if (line === "/quit" || line === "/exit") return void (await shutdown());
      else if (line === "/who") {
        print(c.dim("Roster:"));
        for (const p of ep.getRoster())
          print(
            "  " +
              who(p.card) +
              " " +
              statusBadge(p.status) +
              presenceDetail(p) +
              activityDetail(p) +
              (p.card.id === me ? c.dim(" (you)") : ""),
          );
      } else if (line === "/idle") await setStatus("idle");
      else if (/^\/working(?:\s|$)/.test(line))
        await setStatus("working", line.slice(8).trim() || undefined);
      else if (/^\/waiting(?:\s|$)/.test(line))
        await setStatus("waiting", line.slice(8).trim() || undefined);
      else if (/^\/me(?:\s|$)/.test(line)) {
        const activity = line.slice(3).trim();
        if (!activity) print(c.red("usage: /me <activity>"));
        else await ep.setActivity(activity).then(() => print(c.dim("(activity updated)")));
      } else if (/^\/dm(?:\s|$)/.test(line)) {
        const rest = line.slice(3).trim();
        const sp = rest.search(/\s/);
        if (sp < 1) print(c.red("usage: /dm <name> <message>"));
        else {
          const target = rest.slice(0, sp);
          const text = rest.slice(sp + 1);
          try {
            const peer = resolvePeer(ep.getRoster(), target, { selfId: me });
            if (!peer) print(c.red(`no peer named "${target}" present`));
            else {
              await ep.unicast(peer.card.id, text);
              const label = joinPeerLabel({ name: peer.card.name, id: peer.card.id });
              print(`${c.magenta("(DM)")} ${c.dim("you →")} ${c.bold(label)}: ${text}`);
              if (peer.status === "offline") print(c.yellow(offlineRecipientNotice(label)));
            }
          } catch (e) {
            if (!(e instanceof AmbiguousPeerError)) throw e;
            print(c.red(`"${target}" is ambiguous - DM by instance id:`));
            for (const cand of e.candidates) print(c.dim(`  ${joinPeerLabel({ name: cand.name, id: cand.id })} (${cand.status})  ${cand.id}`));
          }
        }
      } else if (/^\/anycast(?:\s|$)/.test(line)) {
        const rest = line.slice(8).trim();
        const sp = rest.search(/\s/);
        if (sp < 1) print(c.red("usage: /anycast <role> <message>"));
        else {
          const service = rest.slice(0, sp);
          const text = rest.slice(sp + 1);
          await ep.anycast(service, text);
          print(`${c.yellow("(@" + service + ")")} ${c.dim("you →")} ${text}`);
        }
      } else {
        if (!concreteChannel) print(c.red(`! ${patternBroadcastNotice} Nothing was sent.`));
        else if (!canBroadcast()) print(c.red(`! ${broadcastDenied()}`));
        else {
          try {
            await ep.multicast(line, { channel });
            print(`${c.cyan("#" + channel)} ${c.dim("you:")} ${line}`);
          } catch (e) {
            if (!isPublishPermissionDenied(e)) throw e;
            print(c.red(`! ${broadcastDenied()}`));
          }
        }
      }
    } catch (e) {
      if (!leaving) print(c.red(`! ${(e as Error).message}`));
    }
    if (!leaving && !rlClosed) rl.prompt();
  });
  promptReady = true;
  if (!leaving && !rlClosed) rl.prompt();
  await Promise.race([whenLost(), sessionFinished]);
}
