import { userInfo } from "node:os";
import * as readline from "node:readline";
import {
  CotalEndpoint,
  parseJoinLink,
  resolvePeer,
  AmbiguousPeerError,
  mintCreds,
  mintLifecycleUid,
  assertLifecycleToken,
  newIdentity,
  provisionAgent,
  partsToText,
  peerLabel,
  presenceText,
  isConsumerNotFound,
  type Delivery,
  type EndpointKind,
  type PresenceStatus,
  type CotalMessage,
  type ParsedArgs,
  type SpaceAuth,
} from "@cotal-ai/core";
import { CommandFailure, credsSpace, findMesh, inputDisabledByFlag, isConnectRefusal, preflightOrThrow, reachableOrThrow, readCredsFile, refreshRegistrationPolicy, refuseStaticCredsForKnownUserAuth, resolveTargetOrThrow, connectUserControlOrThrow, endpointAuth, type Connection, type MeshEntry } from "@cotal-ai/workspace";
import { credentialEnded } from "../lib/connect.js";
import { resolveSpace } from "../lib/status.js";
import { offlineRecipientNotice } from "../lib/offline-recipient.js";
import { activityAge, c, presenceDetail, statusBadge, stderrLine } from "../ui.js";

// The plan's stale-cred fail-fast gate: an unprovisioned / auth-rejected join is ONE classified
// refusal instead of a raw NATS stack. Shared by the self-mint provisioning step (which runs
// BEFORE ep.start) and ep.start itself. Known TLS negotiation refusal is classified here too.
// Unexpected failures still propagate unchanged.
function joinAuthFailure(e: unknown, space: string, credsLifecycle?: string): CommandFailure | undefined {
  const msg = (e as Error)?.message ?? String(e);
  if (msg === "server does not support 'tls'")
    return new CommandFailure("refused", "UNSUPPORTED", `TLS is required to join ${space}, but this server does not support TLS`, { remedy: "ask the mesh operator for its TLS-enabled broker address" });
  // A --creds join binds the inbox its lifecycle was provisioned with. A credential minted without
  // --provision has none, and neither `cotal up` nor another --creds can make one from here.
  if (credsLifecycle !== undefined && /consumer not found|no responders|not provisioned/i.test(msg))
    return new CommandFailure("refused", "TARGET_NOT_FOUND", `${space} has no inbox provisioned for this credential's lifecycle ${credsLifecycle}, so it cannot join with it`, {
      remedy: "ask the space's owner to mint the credential with `cotal auth mint <name> --provision`, then join with the lifecycle UID that mint reports",
    });
  if (/consumer not found|no responders|not provisioned/i.test(msg))
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

async function joinSpace(args: ParsedArgs): Promise<void> {
  const values = args.values as { space?: string; name?: string; role?: string; channel?: string; server?: string; kind?: string; link?: string; token?: string; creds?: string; "lifecycle-uid"?: string; tls?: boolean };

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
  const channel = values.channel ?? link?.channels?.[0] ?? "general";
  const auth = {
    token: values.token ?? link?.token,
    user: link?.user,
    pass: link?.pass,
    creds: values.creds ? readCredsFile(values.creds) : undefined,
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
      { remedy: "pass --lifecycle-uid <uid> (or set COTAL_LIFECYCLE_UID) with the uid minted alongside this credential at provision time", selfContained: true },
    );

  let space: string;
  let server: string;
  let userConnection: Connection | undefined;
  let mintedFrom: SpaceAuth | undefined;
  // An explicit connection (a join link, --token, or --creds) is taken at face value — that's the
  // escape hatch. Otherwise resolve the running mesh from any directory (server + trust material)
  // and self-mint, so a bare `cotal join` works outside the project instead of crashing credless.
  if (link || values.token || values.creds) {
    // With no space or broker named, the credential goes to the selected space or this folder's.
    space = values.space ?? link?.space ?? ((values.server ?? link?.servers) === undefined ? credsSpace(process.cwd())?.space : undefined) ?? resolveSpace(process.cwd());
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
    await reachableOrThrow(server, auth);
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
    if (target.mode !== "user" && target.auth) {
      const identity = newIdentity();
      // One lifecycle per join session (SPEC 13.1): the provisioned dm/dlv footprint, the minted
      // grants, and the endpoint's binds all carry this uid; the session's exit orphans only its own
      // lifecycle-keyed names (self-retired by the open-mode inactive threshold on the broker side).
      // A launcher-supplied uid (flag/env, resolved above) wins; the session mints only when bare.
      lifecycleUid ??= mintLifecycleUid();
      const prov = new CotalEndpoint({
        space,
        servers: server,
        creds: await mintCreds(target.auth, newIdentity(), "provisioner"),
        channels: [],
        consume: false,
        registerPresence: false,
        watchPresence: false,
        watchChannels: false,
        card: { name: "join-provisioner", role: "provisioner", kind: "endpoint" },
      });
      // Swallow provisioner errors: this ephemeral endpoint's failures surface through the try/catch
      // below as one legible sentence, not a raw `! provisioner: …` side channel.
      prov.on("error", () => {});
      const ignoreProvisionerWarning = () => {};
      prov.on("warning", ignoreProvisionerWarning); // same deliberate one-shot policy; the awaited operation owns the verdict
      try {
        await prov.start();
        // Live-only: a bare join isn't under a manager, so no durable Plane-3 backstop
        // (durableMembership:false) — the console reads live via its core-sub + receives DMs on its dm_<id>.
        auth.creds = await provisionAgent(prov, target.auth, identity, {
          subscribe: [channel],
          allowSubscribe: [channel],
          allowPublish: [channel],
          role: values.role,
          durableMembership: false,
          lifecycleUid,
        });
        mintedFrom = target.auth;
        await prov.stop();
      } catch (e) {
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
    channels: [channel],
    card: {
      ...(userConnection ? { owner: userConnection.epCaller!.owner, actor: userConnection.epCaller!.actor } : {}),
      name,
      role: values.role,
      kind: (values.kind as EndpointKind) ?? "agent",
    },
  });
  const me = ep.card.id;

  // Interactive only when attached to a real terminal; headless when spawned
  // detached (manager) — then we just hold presence and log mesh events.
  const interactive = process.stdin.isTTY === true && !inputDisabledByFlag();
  let rlClosed = false;
  const rl = interactive
    ? readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: c.dim(`${name}> `),
      })
    : undefined;
  rl?.on("close", () => {
    rlClosed = true;
  });

  const print = (line: string) => {
    if (rl && !rlClosed) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      console.log(line);
      rl.prompt(true);
    } else {
      console.log(line);
    }
  };

  const who = (card: { name: string; role?: string }) => c.bold(peerLabel(card));

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
        `${c.dim("•")} ${who(ev.presence.card)} ${statusBadge(ev.presence.status)}${presenceDetail(ev.presence)}${ev.presence.activity ? c.dim(" - " + presenceText(ev.presence.activity) + activityAge(ev.presence)) : ""}`,
      );
  });

  // A session that cannot come back ends with the reason and what to run, rather than retrying for
  // good. A reconnect that finds its inbox gone from the broker cannot bind it again. A credential
  // the broker now refuses for good ends it with the refusal a one-shot command with that credential
  // gets, as `history --follow` ends. A user-auth join's inbox is the operator's to provision and its
  // bearer renewal reports a changed trust, so it keeps re-establishing.
  const credential: Connection | undefined = auth.creds === undefined ? undefined
    : { server, space, tls: auth.tls, creds: auth.creds, ...(mintedFrom ? { auth: mintedFrom } : {}) };
  let started = false, connected = false, checking = false;
  let lose!: (failure: Error) => void;
  const lost = new Promise<Error>((resolve) => { lose = resolve; });
  const checkCredential = () => {
    if (!started || checking || credential === undefined) return;
    checking = true;
    void credentialEnded(credential).catch(() => undefined).then((refusal) => {
      checking = false;
      if (refusal) lose(refusal);
    });
  };
  ep.on("connection", ({ connected: up }: { connected: boolean }) => {
    connected = up;
    if (!up) checkCredential();
  });
  ep.on("error", (e: Error) => {
    print(c.red(`! ${e.message}`));
    checkCredential();
  });
  ep.on("warning", (e: Error) => {
    if (started && !connected && !userConnection && isConsumerNotFound(e))
      return lose(new CommandFailure("refused", "TARGET_NOT_FOUND", "this join can no longer reconnect: its inbox is gone from the broker", {
        target: { space },
        remedy: values.creds
          ? "ask the space's owner to mint the credential again with `cotal auth mint <name> --provision`, then join with the lifecycle UID that mint reports"
          : "run the same cotal join again to start a new session",
      }));
    print(c.yellow(`! ${e.message}`));
  });
  /** Leave once the session is lost: stop the endpoint and end with its refusal. */
  const whenLost = async (): Promise<never> => {
    const failure = await lost;
    rl?.close();
    try { await ep.stop(); } catch { /* it ends either way */ }
    throw failure;
  };

  try {
    await ep.start();
  } catch (e) {
    // A bare `cotal join` binds a durable DM inbox nobody pre-created on an unprovisioned space;
    // surface that (and an auth reject) as ONE classified refusal, not a raw NATS stack.
    throw joinAuthFailure(e, space, values.creds ? lifecycleUid : undefined) ?? e;
  }
  started = true;

  // `/quit` leaves with 0; a signal leaves the same way and exits with its code.
  const shutdown = async (code = 0) => {
    print(c.dim("leaving…"));
    rl?.close();
    await ep.stop();
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown(130));
  process.on("SIGTERM", () => void shutdown(143));

  if (!interactive || !rl) {
    console.log(
      c.dim(`${peerLabel({ name, role: values.role })} holding presence in ${space} - headless`),
    );
    return whenLost(); // park; event handlers do the work
  }

  console.log(
    c.dim(`Joined ${c.bold(space)} as ${who({ name, role: values.role })} on #${channel}.`),
  );
  console.log(
    c.dim(
      "Type to broadcast. Commands: /who  /dm <name> <msg>  /anycast <role> <msg>  /working [x]  /waiting [x]  /idle  /me <x>  /quit\n",
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
  rl.prompt();

  const setStatus = async (status: PresenceStatus, activity?: string) => {
    if (activity) await ep.setActivity(activity);
    await ep.setStatus(status);
    const acknowledgedStatus = status === "working" ? "working · progress unknown" : status;
    print(c.dim(`(you are now ${acknowledgedStatus}${activity ? ": " + activity : ""})`));
  };

  rl.on("line", async (raw) => {
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
              (p.activity ? c.dim(" - " + presenceText(p.activity) + activityAge(p)) : "") +
              (p.card.id === me ? c.dim(" (you)") : ""),
          );
      } else if (line === "/idle") await setStatus("idle");
      else if (line.startsWith("/working"))
        await setStatus("working", line.slice(8).trim() || undefined);
      else if (line.startsWith("/waiting"))
        await setStatus("waiting", line.slice(8).trim() || undefined);
      else if (line.startsWith("/me "))
        await ep.setActivity(line.slice(4).trim()).then(() => print(c.dim("(activity updated)")));
      else if (line.startsWith("/dm ")) {
        const rest = line.slice(4).trim();
        const sp = rest.indexOf(" ");
        if (sp < 1) print(c.red("usage: /dm <name> <message>"));
        else {
          const target = rest.slice(0, sp);
          const text = rest.slice(sp + 1);
          try {
            const peer = resolvePeer(ep.getRoster(), target, { selfId: me });
            if (!peer) print(c.red(`no peer named "${target}" present`));
            else {
              await ep.unicast(peer.card.id, text);
              print(`${c.magenta("(DM)")} ${c.dim("you →")} ${c.bold(peer.card.name)}: ${text}`);
              if (peer.status === "offline") print(c.yellow(offlineRecipientNotice(peer.card.name)));
            }
          } catch (e) {
            if (!(e instanceof AmbiguousPeerError)) throw e;
            print(c.red(`"${target}" is ambiguous - DM by instance id:`));
            for (const cand of e.candidates) print(c.dim(`  ${cand.name} (${cand.status})  ${cand.id}`));
          }
        }
      } else if (line.startsWith("/anycast ")) {
        const rest = line.slice(9).trim();
        const sp = rest.indexOf(" ");
        if (sp < 1) print(c.red("usage: /anycast <role> <message>"));
        else {
          const service = rest.slice(0, sp);
          const text = rest.slice(sp + 1);
          await ep.anycast(service, text);
          print(`${c.yellow("(@" + service + ")")} ${c.dim("you →")} ${text}`);
        }
      } else {
        await ep.multicast(line, { channel });
        print(`${c.cyan("#" + channel)} ${c.dim("you:")} ${line}`);
      }
    } catch (e) {
      print(c.red(`! ${(e as Error).message}`));
    }
    rl.prompt();
  });
  await whenLost();
}
