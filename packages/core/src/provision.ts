/**
 * The provisioner — the signer capability for a space.
 *
 * A space is one NATS *account*; every agent is a *user* in it. This module mints the
 * decentralized-JWT trust chain (operator → account → user) programmatically with
 * `@nats-io/jwt`, so there is no dependency on the external `nsc` CLI and the signing
 * key stays in one place (whoever holds {@link SpaceAuth.account.signingSeed}).
 *
 * Demo-1 stage: out-of-band mint. `cotal up` creates the space's trust material
 * once and writes a `nats-server` config (operator + system account + MEMORY resolver);
 * `cotal mint` and the manager load that material and mint per-agent creds files. There
 * is no connect-time token exchange yet (that's the later auth-callout stage).
 *
 * NOT yet provided (our job, not nsc's): credential revocation and an issuance audit
 * trail. Revocation is deferred past Demo 1; minted creds currently have no TTL.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import {
  encodeOperator,
  encodeAccount,
  encodeUser,
  fmtCreds,
} from "@nats-io/jwt";
import { createOperator, createAccount, fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  token,
  spacePrefix,
  chatSubject,
  assertValidChannel,
  channelInAllow,
  unicastSubject,
  anycastSubject,
  controlServiceSubject,
  CONTROL_PRIVILEGED,
  CONTROL_SELF_SERVICE,
  chatStream,
  dmStream,
  taskStream,
  chatDurable,
  chatHistDurable,
  dmDurable,
  taskDurable,
  presenceBucket,
  channelBucket,
} from "./subjects.js";
import type { Identity } from "./identity.js";

/** Cred profiles (per the plan's class table). Demo-1 mints all permissively; steps 5–7
 *  scope each one — at which point the manager MUST already hold its own privileged
 *  profile (broad: pre-create others' DM durables, serve ctl), not "agent", or it
 *  silently loses those powers the moment "agent" is tightened. */
export type Profile = "agent" | "observer" | "admin" | "manager";

/** A space's persisted trust material. The `signingSeed` is the sensitive provisioner
 *  secret; everything else is public (JWTs) or recoverable. */
export interface SpaceAuth {
  space: string;
  operator: { seed: string; jwt: string };
  account: { pub: string; seed: string; jwt: string; signingSeed: string; signingPub: string };
  sys: { pub: string; jwt: string };
}

// Unlimited account limits — without explicit limits a JWT account defaults to 0 conns
// (every connect denied). JetStream needs storage on the data account but MUST stay off
// the system account (the server refuses to start otherwise).
const BASE_LIMITS = {
  subs: -1, conn: -1, leaf: -1, imports: -1, exports: -1,
  data: -1, payload: -1, wildcards: true,
} as const;
const DATA_LIMITS = { ...BASE_LIMITS, mem_storage: -1, disk_storage: -1 };
const SYS_LIMITS = { ...BASE_LIMITS, mem_storage: 0, disk_storage: 0 };

/** Reduce a {@link SpaceAuth} to just the material a *minting* host needs: `space`,
 *  `account.pub`, and `account.signingSeed` (the only fields {@link mintCreds} reads).
 *  The operator root-of-trust, system account, and the account's own seed are blanked.
 *
 *  This is the file you hand a manager that should mint per-agent creds but must never
 *  hold the operator key — e.g. a containerized team. A leaked stripped file only lets
 *  someone mint *users within this one account*, which the account boundary already
 *  contains; it cannot mint new accounts or touch the system account. */
export function stripSpaceAuth(auth: SpaceAuth): SpaceAuth {
  return {
    space: auth.space,
    operator: { seed: "", jwt: "" },
    account: {
      pub: auth.account.pub,
      seed: "",
      jwt: "",
      signingSeed: auth.account.signingSeed,
      signingPub: "",
    },
    sys: { pub: "", jwt: "" },
  };
}

/** Generate a fresh operator → account(+signing key) → system-account chain for a space. */
export async function createSpaceAuth(space: string): Promise<SpaceAuth> {
  const okp = createOperator();
  const akp = createAccount();
  const askp = createAccount(); // account signing key — what mints users
  const syskp = createAccount();
  const sysPub = syskp.getPublicKey();

  const operatorJwt = await encodeOperator(`cotal-${token(space)}`, okp, { system_account: sysPub });
  const accountJwt = await encodeAccount(
    token(space),
    akp,
    { signing_keys: [askp.getPublicKey()], limits: DATA_LIMITS },
    { signer: okp },
  );
  const sysJwt = await encodeAccount("SYS", syskp, { limits: SYS_LIMITS }, { signer: okp });

  const dec = (u: Uint8Array) => new TextDecoder().decode(u);
  return {
    space,
    operator: { seed: dec(okp.getSeed()), jwt: operatorJwt },
    account: {
      pub: akp.getPublicKey(),
      seed: dec(akp.getSeed()),
      jwt: accountJwt,
      signingSeed: dec(askp.getSeed()),
      signingPub: askp.getPublicKey(),
    },
    sys: { pub: sysPub, jwt: sysJwt },
  };
}

/** Options shaping a minted user's permissions. */
export interface MintOpts {
  /** Read ACL — channels an "agent" MAY read (the agent file's `allowSubscribe`, already resolved
   *  by the caller). Minted as per-channel single-filter history-consumer create grants
   *  (`CONSUMER.CREATE.<CHAT>.<chathist_id>.<chat.*.ch>`) — the broker boundary on chat **history**
   *  reads (join-backfill / focus-recall). Each is run through the chat-subject builder so a
   *  wildcard subtree `team.>` becomes `chat.*.team.>`. Defaults to `["general"]`. The live tail's
   *  filter (the active `subscribe` set) is pinned separately by the privileged
   *  {@link DurableProvisioner.provisionChatDurable} pre-create, never here. */
  allowSubscribe?: string[];
  /** Post ACL — channels an "agent" may publish to (the agent file's `allowPublish`, already
   *  resolved by the caller). Each becomes a `chat.<id>.<ch>` publish grant. **Default-deny**:
   *  omitted/empty ⇒ no chat publish grant at all — publishing must be declared. */
  allowPublish?: string[];
  /** The agent's role — scopes its TASK-queue consumer to svc_<role>. */
  role?: string;
  /** Control service the agent may address. Defaults to `"manager"`. */
  manager?: string;
  /** Capabilities declared in the agent file (e.g. `"spawn"`). A capability gates the
   *  privileged control-subject grant in {@link permissionsFor}: `spawn` → the agent may
   *  publish to the privileged control subject (start/purge/definePersona/named stop).
   *  Default-deny when absent — nats-server rejects the publish, no handler involved. */
  capabilities?: string[];
}

/** Options for {@link provisionAgent} — {@link MintOpts} plus the active read set. */
export interface ProvisionOpts extends MintOpts {
  /** The active read set: pre-created as the live chat durable's `filter_subjects` (the channels
   *  the agent actually subscribes to at boot). Must be ⊆ `allowSubscribe`. Defaults to `["general"]`. */
  subscribe?: string[];
}

/** The privileged onboarding ops a launcher needs — implemented by a connected, permissive
 *  endpoint (the manager, or a short-lived provisioner that `cotal spawn` opens). */
export interface DurableProvisioner {
  /** Pre-create the agent's bind-only chat live-tail durable, filtered to `subscribe`. */
  provisionChatDurable(id: string, subscribe: string[]): Promise<void>;
  provisionDmInbox(id: string): Promise<void>;
  provisionTaskQueue(role: string): Promise<void>;
}

/** Onboard an agent for launch (auth mode): pre-create its bind-only chat (+ DM + role TASK)
 *  durables and mint its scoped creds. The single shared step so every launcher — the manager and
 *  `cotal spawn` alike — provisions identically (manager not special). */
export async function provisionAgent(
  provisioner: DurableProvisioner,
  auth: SpaceAuth,
  identity: Identity,
  opts: ProvisionOpts = {},
): Promise<string> {
  const subscribe = opts.subscribe?.length ? opts.subscribe : ["general"];
  const allowSubscribe = opts.allowSubscribe?.length ? opts.allowSubscribe : subscribe;
  // Reject channel names the wire layer would rewrite (the pre-created filter rides token() too).
  for (const ch of [...subscribe, ...allowSubscribe]) assertValidChannel(ch);
  // Re-assert the load-time invariant at the trust boundary (defense in depth): the pre-created
  // live filter (subscribe) must sit within the read ACL (allowSubscribe), or the provisioner
  // would hand the agent live delivery it isn't permitted to read.
  for (const ch of subscribe)
    if (!channelInAllow(allowSubscribe, ch))
      throw new Error(
        `provisionAgent: subscribe "${ch}" is not within allowSubscribe [${allowSubscribe.join(", ")}]`,
      );
  await provisioner.provisionChatDurable(identity.id, subscribe);
  await provisioner.provisionDmInbox(identity.id);
  if (opts.role) await provisioner.provisionTaskQueue(opts.role);
  return mintCreds(auth, identity, "agent", { ...opts, allowSubscribe });
}

/** Mint a user creds file for an agent {@link Identity} (its stable id+seed from
 *  {@link newIdentity}). The account signing key signs over ONLY the public key
 *  (`fromPublic`) — the agent seed is never part of the signature, it's only folded into
 *  the resulting creds file. The "agent" profile is scoped to publish only as itself and only to
 *  its declared `allowPublish` channels (post ACL, default-deny), and to read only within
 *  `allowSubscribe` (live tail bind-only + per-channel history grants); "manager" and "observer"
 *  stay permissive here and are scoped in steps 6–7. */
export async function mintCreds(
  auth: SpaceAuth,
  identity: Identity,
  profile: Profile,
  opts: MintOpts = {},
): Promise<string> {
  const signer = fromSeed(new TextEncoder().encode(auth.account.signingSeed));
  const perms = permissionsFor(profile, auth.space, identity.id, opts);
  const userJwt = await encodeUser(
    profile,
    fromPublic(identity.id),
    fromPublic(auth.account.pub),
    perms,
    { signer },
  );
  const creds = fmtCreds(userJwt, fromSeed(new TextEncoder().encode(identity.seed)));
  return new TextDecoder().decode(creds);
}

/** Build the NATS user permission object for a profile: a default-deny allow-list scoped to
 *  exactly what each profile does. "manager" stays permissive (the privileged provisioner
 *  host). Subject/stream/durable names come from the shared builders so the ACLs can't drift
 *  from the wire layout. */
function permissionsFor(
  profile: Profile,
  space: string,
  id: string,
  opts: MintOpts,
): Record<string, unknown> {
  if (profile === "manager") return {}; // privileged: allow-all defaults
  const CHAT = chatStream(space), DM = dmStream(space), TASK = taskStream(space);
  const KV = `KV_${presenceBucket(space)}`;
  const CHKV = `KV_${channelBucket(space)}`; // channel registry (read-only for everyone)
  const inbox = `_INBOX_${id}.>`;

  if (profile === "observer" || profile === "admin") {
    // Read-only: live feed via tap, history + presence via ephemeral/ordered consumers it
    // creates on CHAT + the presence KV. No chat/inst/svc/ctl publish → can't post.
    //   observer — sub chat.> only; DM_<space>/svc never named → DMs + anycast structurally
    //     invisible (step-6 inbox scoping means it can't sniff deliveries either).
    //   admin — sub widened to the whole space so the dashboard's tap also sees DMs (inst.>)
    //     and anycast (svc.>) live, PLUS DM-stream read verbs so it can backfill DM history.
    //     A deliberate god-view: DMs are plaintext + ACL-gated, so mint this only for a trusted
    //     audit dashboard. CONSUMER.CREATE on DM_<space> is the DM-confidentiality surface —
    //     granted here ONLY for this elevated read-only profile, never to agents.
    const sub =
      profile === "admin"
        ? [`${spacePrefix(space)}.>`, inbox]
        : [`${spacePrefix(space)}.chat.>`, inbox];
    const allow = [
      "$JS.API.INFO",
      `$JS.API.STREAM.INFO.${CHAT}`,
      `$JS.API.STREAM.INFO.${KV}`,
      // ephemeral backlog consumer (channelHistory): a multi-filter create can't encode its
      // filter in the subject → bare form; the .> form covers named consumers.
      `$JS.API.CONSUMER.CREATE.${CHAT}`,
      `$JS.API.CONSUMER.CREATE.${CHAT}.>`,
      `$JS.API.CONSUMER.INFO.${CHAT}.>`,
      `$JS.API.CONSUMER.MSG.NEXT.${CHAT}.>`,
      `$JS.API.CONSUMER.DELETE.${CHAT}.>`,
      `$JS.ACK.${CHAT}.>`,
      `$JS.API.CONSUMER.CREATE.${KV}.>`, // kv.watch ordered consumer (roster is public)
      `$JS.API.CONSUMER.INFO.${KV}.>`,
      // Channel registry read (watch + direct kv.get + enriched listChannels) — config is
      // world-readable. STREAM.MSG.GET is the verb kv.get() rides (the bucket has no allow_direct).
      `$JS.API.STREAM.INFO.${CHKV}`,
      `$JS.API.STREAM.MSG.GET.${CHKV}`,
      `$JS.API.CONSUMER.CREATE.${CHKV}.>`,
      `$JS.API.CONSUMER.INFO.${CHKV}.>`,
      `$JS.API.CONSUMER.DELETE.${CHKV}.>`,  // ephemeral consumer cleanup
      "$JS.FC.>", // ordered-consumer flow control
    ];
    if (profile === "admin") {
      // DM history backfill (dmHistory): same bare-form gotcha as CHAT — filter_subjects is
      // plural so the create lands on the bare subject; the .> form covers named consumers.
      allow.push(
        `$JS.API.STREAM.INFO.${DM}`,
        `$JS.API.CONSUMER.CREATE.${DM}`,
        `$JS.API.CONSUMER.CREATE.${DM}.>`,
        `$JS.API.CONSUMER.INFO.${DM}.>`,
        `$JS.API.CONSUMER.MSG.NEXT.${DM}.>`,
        `$JS.API.CONSUMER.DELETE.${DM}.>`,
        `$JS.ACK.${DM}.>`,
      );
    }
    return { sub: { allow: sub }, pub: { allow } };
  }

  // ---- agent ----
  const allowPublish = opts.allowPublish ?? []; // post ACL — DEFAULT-DENY (publish must be declared)
  const allowSubscribe = opts.allowSubscribe?.length ? opts.allowSubscribe : ["general"]; // read ACL
  // Re-assert at the mint chokepoint (covers mint/spawn paths that bypass the file loader): a policy
  // channel must equal its wire token, or the minted grant would alias the logical ACL.
  for (const ch of [...allowSubscribe, ...allowPublish]) assertValidChannel(ch);
  const manager = opts.manager ?? CONTROL_PRIVILEGED;
  const chatD = chatDurable(id), chatHistD = chatHistDurable(id), dmD = dmDurable(id);
  const svcD = opts.role ? taskDurable(opts.role) : undefined;
  const pubAllow = [
    // peer publish — identity + channel scope, built from the real builders. Default-deny: ONLY the
    // declared allowPublish channels (none by default) get a chat-publish grant.
    ...allowPublish.map((ch) => chatSubject(space, id, ch)),
    unicastSubject(space, "*", id), //  inst.*.<id>   — DM any instance, as me
    anycastSubject(space, "*", id), //  svc.*.<id>    — anycast any role, as me
    controlServiceSubject(space, CONTROL_SELF_SERVICE, id), // ctl.self.<id> — self stop/despawn + mediated join/leave, granted to all
    // JetStream control plane — scoped to this agent's own streams/durables.
    "$JS.API.INFO",
    // STREAM.INFO: CHAT (join watermark, recall drop-marker, channel-list counts — a documented
    // metadata surface, see SPEC §9) + the world-readable presence/registry KVs. NOT DM/TASK: agents
    // bind their dm_<id>/svc_<role> by name and never inspect those streams, so granting INFO there
    // would only leak DM-inbox / task subject metadata across peers for no functional gain.
    `$JS.API.STREAM.INFO.${CHAT}`, `$JS.API.STREAM.INFO.${KV}`, `$JS.API.STREAM.INFO.${CHKV}`,
    // CHAT live tail: BIND ONLY its own pre-created chat_<id> durable — info / fetch / ack, NO
    // create or update. The durable's `filter_subjects` is the read boundary; it is set only by the
    // privileged provisioner (subscribe ⊆ allowSubscribe) and moved only via the mediated
    // join/leave control op. With no create/update path the agent can never widen its own live
    // read. (The multi-filter durable rides the filter-less create subject, so it is not
    // ACL-pinnable by subject anyway — bind-only + trusted creator is the enforcement, as DM/TASK.)
    `$JS.API.CONSUMER.INFO.${CHAT}.${chatD}`,
    `$JS.API.CONSUMER.MSG.NEXT.${CHAT}.${chatD}`,
    `$JS.ACK.${CHAT}.${chatD}.>`,
    // CHAT history reads (join-backfill, focus-recall, drop-marker) — single-filter EPHEMERAL
    // consumers named chathist_<id>. The create rides the extended subject
    // CONSUMER.CREATE.<CHAT>.<chathist_id>.<filter>, whose trailing filter token nats-server pins to
    // the request body (JSConsumerCreateFilterSubjectMismatchErr, code 10131) — so one create grant
    // per allowSubscribe channel makes history reads broker-bounded to the read ACL. Replaces the
    // old unfiltered DIRECT.GET.<CHAT> (which could fetch ANY message regardless of channel). The
    // name is the agent's own, so info/fetch/delete can't reach a peer's consumer. NO broad
    // CONSUMER.CREATE.<CHAT> / .> deny here: NATS deny beats allow, which would also kill these.
    ...allowSubscribe.map((ch) => `$JS.API.CONSUMER.CREATE.${CHAT}.${chatHistD}.${chatSubject(space, "*", ch)}`),
    `$JS.API.CONSUMER.INFO.${CHAT}.${chatHistD}`,
    `$JS.API.CONSUMER.MSG.NEXT.${CHAT}.${chatHistD}`,
    `$JS.API.CONSUMER.DELETE.${CHAT}.${chatHistD}`,
    // DM consumer: BIND ONLY — info/fetch/ack its own pre-created durable, never create.
    `$JS.API.CONSUMER.INFO.${DM}.${dmD}`,
    `$JS.API.CONSUMER.MSG.NEXT.${DM}.${dmD}`,
    `$JS.ACK.${DM}.${dmD}.>`,
    // Presence: watch (read, public roster) + flow control + PUT OWN KEY ONLY.
    `$JS.API.CONSUMER.CREATE.${KV}.>`,
    `$JS.API.CONSUMER.INFO.${KV}.>`,
    "$JS.FC.>",
    `$KV.${presenceBucket(space)}.${id}`, // own presence key only — can't spoof peers
    // Channel registry: read-only (watch + direct kv.get for the join-time replay decision).
    // No `$KV.${channelBucket(space)}.*` publish — privileged-write, default-deny gives that free.
    `$JS.API.STREAM.MSG.GET.${CHKV}`,
    `$JS.API.CONSUMER.CREATE.${CHKV}.>`,
    `$JS.API.CONSUMER.INFO.${CHKV}.>`,
  ];
  if (svcD) {
    // TASK consumer: BIND ONLY its own role's pre-created durable (svc_<role>). Like DM, the
    // create-time filter_subject isn't reliably ACL-constrainable, so no create path is
    // allowed — the privileged provisioner pre-creates svc_<role> filtered to svc.<role>.*.
    pubAllow.push(
      `$JS.API.CONSUMER.INFO.${TASK}.${svcD}`,
      `$JS.API.CONSUMER.MSG.NEXT.${TASK}.${svcD}`,
      `$JS.ACK.${TASK}.${svcD}.>`,
    );
  }
  if (opts.capabilities?.includes("spawn")) {
    // Spawn capability → grant the PRIVILEGED control subject (start / purge / definePersona /
    // named stop-despawn). Default-deny otherwise: the subject is simply absent from this
    // allow-list, so nats-server rejects the publish — no handler check, no deny-entry (a
    // blanket `ctl.<mgr>.>` deny would override this grant too, since NATS deny beats allow).
    // The self-service subject above is granted to all regardless of capability.
    pubAllow.push(controlServiceSubject(space, manager, id));
  }
  // Explicit create-deny (defense-in-depth over default-deny) on the two streams whose
  // create-time filter_subject is the attack surface — DM (private content) and TASK
  // (cross-role work-stealing). Covers the bare ephemeral form (no trailing token), the
  // named/new-API form, and the old durable form. No create path on either stream.
  const pubDeny = [
    `$JS.API.CONSUMER.CREATE.${DM}`,
    `$JS.API.CONSUMER.CREATE.${DM}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${DM}.>`,
    `$JS.API.CONSUMER.CREATE.${TASK}`,
    `$JS.API.CONSUMER.CREATE.${TASK}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${TASK}.>`,
  ];
  return { pub: { allow: pubAllow, deny: pubDeny }, sub: { allow: [inbox] } };
}

/** Render the `nats-server` config that trusts this space's operator and serves its
 *  accounts via the in-config MEMORY resolver. */
export function serverConfig(auth: SpaceAuth, opts: { port?: number; host?: string; storeDir: string }): string {
  const port = opts.port ?? 4222;
  const host = opts.host ?? "127.0.0.1";
  // A minted "agent" carries its full permission allow-list inline in its user JWT, which the
  // client sends in the CONNECT protocol line. With per-channel + JetStream-API grants that JWT
  // exceeds the 4 KB default max_control_line at ~2 channels, and the server then silently drops
  // the connection (the client retries forever — a connect that "hangs"). Raise it to fit a rich
  // agent JWT — but right-sized, not generous: the CONNECT line is parsed BEFORE auth, so the cap
  // is a per-connection pre-auth allocation under connection flooding. 64 KB clears a many-channel
  // agent JWT (~4–8 KB) with wide margin while keeping the pre-auth surface ~16× tighter than 1 MB.
  return `# Generated by \`cotal up\` — do not edit by hand.
host: ${host}
port: ${port}
max_control_line: 65536
jetstream { store_dir: ${JSON.stringify(opts.storeDir)} }
operator: ${auth.operator.jwt}
system_account: ${auth.sys.pub}
resolver: MEMORY
resolver_preload: {
  ${auth.account.pub}: ${auth.account.jwt}
  ${auth.sys.pub}: ${auth.sys.jwt}
}
`;
}

// ---- persistence (.cotal/auth) ------------------------------------------------

const AUTH_FILE = "auth.json";

export function authDir(root: string): string {
  return join(root, ".cotal", "auth");
}

/** Find the project's `.cotal/` by walking up from `start` (like git finds `.git`), returning the
 *  directory that *contains* `.cotal/`. Falls back to `start` when none is found up the tree (a
 *  fresh setup creates `.cotal/` there). Lets `cotal` run from any subdirectory of a project. */
export function findCotalRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".cotal"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/** Persist the space trust material. The file holds the signing seed — treat as a secret. */
export function saveSpaceAuth(dir: string, auth: SpaceAuth): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, AUTH_FILE), JSON.stringify(auth, null, 2), { mode: 0o600 });
}

/** Load the space trust material, or undefined if auth was never set up here. */
export function loadSpaceAuth(dir: string): SpaceAuth | undefined {
  const f = join(dir, AUTH_FILE);
  if (!existsSync(f)) return undefined;
  return JSON.parse(readFileSync(f, "utf8")) as SpaceAuth;
}
