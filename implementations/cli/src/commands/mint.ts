import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  CotalEndpoint,
  agentFilePath,
  identityFromCreds,
  loadAgentFile,
  mintCreds,
  mintLifecycleUid,
  mkSecretDir,
  newIdentity,
  principalKey,
  provisionAgent,
  stripSpaceAuth,
  writeSecretFile,
  DEV_OWNER,
  type Identity,
  type ParsedArgs,
  type Profile,
  type SpaceAuth,
} from "@cotal-ai/core";
import { agentCredsKey, agentSecretFilePaths, authDir, canonicalRoot, getSpaceAuth, getSoleSpaceAuth, hasUserAuthState, isWorkspaceTargetError, materializeSecretToFile, preflightOrExit, renderWorkspaceError, resolveMeshTarget, resolveTargetOrExit, workspaceSecretStore, type MeshTarget } from "@cotal-ai/workspace";
import { cotalRoot } from "../lib/paths.js";
import { c } from "../ui.js";

/** Out-of-band cred minting: generate an identity, sign a profile-scoped user JWT with the
 *  space's account signing key, and write a creds file the agent/observer loads to join.
 *  `--signer` instead emits a stripped signer file — only the account signing material
 *  (`space` + `account.pub` + `account.signingSeed`), no operator root-of-trust — to mount into a
 *  containerized manager so it can mint per-agent creds without holding the account-minting key. */
export async function mint(args: ParsedArgs): Promise<void> {
  const positionals = args.positionals;
  const values = args.values as {
    profile?: string;
    out?: string;
    signer?: boolean;
    force?: boolean;
    "allow-subscribe"?: string;
    "allow-publish"?: string;
    provision?: boolean;
    role?: string;
    space?: string;
    server?: string;
    "expires-in"?: string;
    "expires-at"?: string;
    identity?: string;
  };
  const cwdRoot = cotalRoot();
  const cwdStore = workspaceSecretStore(cwdRoot);
  const cwdAuthDir = authDir(cwdRoot);

  // `--role` and `--provision` describe an AGENT identity's broker footprint. Nothing else this
  // command emits has one: a signer file is account material, an observer or admin binds no
  // per-identity durables and pulls no task queue. Everywhere else they are refused rather than
  // ignored, so a typo does not read as done. Checked before the `--signer` branch: that branch
  // returns early, and a refusal that lives after it would let `--signer --provision` write
  // signing material where the operator asked for a provisioned identity.
  const offAgent = values.signer ? "--signer" : (values.profile ?? "agent") !== "agent" ? `--profile ${values.profile}` : undefined;
  if ((values.role !== undefined || values.provision) && offAgent) {
    console.error(c.red(`--role and --provision apply to the agent profile only (got ${offAgent})`));
    process.exit(1);
  }
  // AND SO DO THE TWO ACL FLAGS, WHICH USED TO BE IGNORED HERE RATHER THAN REFUSED. They are read
  // below only inside the `profile === "agent"` branch, while `permissionsFor`'s observer/admin arm
  // emits a FIXED read set over the whole chat plane. So `--profile observer --allow-subscribe
  // <one channel>` exited 0, printed a success line, and handed out a credential that reads every
  // channel in the space: an operator asking to narrow got the opposite, and nothing said so. The
  // paragraph above already states the principle this violated, one flag pair over.
  if ((values["allow-subscribe"] !== undefined || values["allow-publish"] !== undefined) && offAgent) {
    console.error(
      c.red(
        `--allow-subscribe and --allow-publish apply to the agent profile only (got ${offAgent}). ` +
          (values.signer
            ? `A signer file is account material and carries no per-identity ACL for these to narrow. `
            : `The observer and admin profiles carry a FIXED read set, the chat plane for observer and ` +
              `the whole messaging plane for admin, and it is not per-identity. `) +
          `They are refused here rather than narrowing anything: mint a scoped reader with --profile agent.`,
      ),
    );
    process.exit(1);
  }

  // A credential's LIFETIME and its IDENTITY, validated before anything is minted or written. The
  // seam (`mintCreds` → `userValidDates`) already takes exactly one of `expiresInSeconds` /
  // `expiresAt` and refuses the pair, a non-integer, and a non-positive value — the CLI holds the
  // same line so a bad flag is one red sentence at the command surface, not a stack from the seam
  // after the operator thought the mint was underway. Bare seconds, the seam's own unit (and the
  // form the issue typed: `--expires-in 3600`); no second duration parser is added for it.
  if (values.signer && (values["expires-in"] !== undefined || values["expires-at"] !== undefined || values.identity !== undefined)) {
    console.error(c.red("--expires-in, --expires-at and --identity mint a credential - --signer writes account-signing material instead; pass one or the other"));
    process.exit(1);
  }
  if (values["expires-in"] !== undefined && values["expires-at"] !== undefined) {
    console.error(c.red("--expires-in and --expires-at are mutually exclusive - pass only one (the mint seam takes a single lifetime)"));
    process.exit(1);
  }
  let expiresInSeconds: number | undefined;
  if (values["expires-in"] !== undefined) {
    const n = Number(values["expires-in"]);
    if (!Number.isInteger(n) || n <= 0) {
      console.error(c.red(`--expires-in must be a positive integer number of seconds (got "${values["expires-in"]}")`));
      process.exit(1);
    }
    expiresInSeconds = n;
  }
  let expiresAt: number | undefined;
  if (values["expires-at"] !== undefined) {
    const n = Number(values["expires-at"]);
    if (!Number.isInteger(n) || n < 0) {
      console.error(c.red(`--expires-at must be a non-negative integer unix timestamp in seconds (got "${values["expires-at"]}")`));
      process.exit(1);
    }
    expiresAt = n;
  }
  // `--identity` re-mints for an EXISTING nkey so the credential's principal is unchanged and every
  // durable keyed to it survives — the act the renewal seam's own error names ("mint with a
  // lifetime"), which had no CLI form. The seed is read the way the endpoint loads a creds file
  // (`identityFromCreds`: the USER NKEY SEED block, cross-checked against the JWT subject), never
  // by a second parser; a file that carries no seed is refused BY NAME.
  let existingIdentity: Identity | undefined;
  if (values.identity !== undefined) {
    const path = resolve(values.identity);
    if (!existsSync(path)) {
      console.error(c.red(`--identity file not found: ${path}`));
      process.exit(1);
    }
    try {
      existingIdentity = identityFromCreds(readFileSync(path, "utf8"));
    } catch {
      console.error(c.red(`--identity file carries no user nkey seed: ${path} - pass a creds file (JWT + USER NKEY SEED) minted by cotal`));
      process.exit(1);
    }
  }

  // `--signer`: no identity, no name — strip this space's auth.json to its account signing material.
  if (values.signer) {
    const auth = await getSoleSpaceAuth(cwdStore, cwdAuthDir);
    if (!auth) {
      console.error(c.red("no space auth found here - run `cotal up` first"));
      process.exit(1);
    }
    const out = resolve(values.out ?? "signer.json");
    if (existsSync(out) && !values.force) {
      console.error(c.red(`${out} already exists - pass --force to overwrite`));
      process.exit(1);
    }
    writeSecretFile(out, JSON.stringify(stripSpaceAuth(auth), null, 2));
    console.log(c.green(`✓ wrote signer for space "${auth.space}"`));
    console.log(c.dim(`  ${out}`));
    console.log(c.dim("  mount read-only at /workspace/.cotal/auth/auth.json in the container"));
    return;
  }

  const name = positionals[0];
  if (!name) {
    console.error(c.red("usage: cotal mint <name> [--profile <agent|observer|admin>] [--out <path>] [--expires-in <s>|--expires-at <unix-s>] [--identity <creds>]  (agent profile also: [--allow-subscribe a,b] [--allow-publish a,b] [--role <role>] [--provision])"));
    process.exit(1);
  }
  const splitList = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  const profile = (values.profile ?? "agent") as Profile;
  if (profile !== "agent" && profile !== "observer" && profile !== "admin") {
    console.error(c.red(`unknown profile "${profile}" - expected agent, observer, or admin`));
    process.exit(1);
  }
  const resolvedTarget = resolveMintTarget(values);
  const root = resolvedTarget.root;
  const store = workspaceSecretStore(root);
  const dir = authDir(root);
  const auth = await getSpaceAuth(store, resolvedTarget.space);
  const cwdAuth = canonicalRoot(root) === canonicalRoot(cwdRoot)
    ? auth
    : await getSoleSpaceAuth(cwdStore, cwdAuthDir);
  if (cwdAuth && (!auth || cwdAuth.space !== resolvedTarget.space || cwdAuth.account.pub !== auth.account.pub)) {
    const targetAuthority = auth ? `${resolvedTarget.space}/${auth.account.pub}` : `${resolvedTarget.space}/no-account`;
    const cwdAuthority = `${cwdAuth.space}/${cwdAuth.account.pub}`;
    console.error(
      c.red(
        `mint resolved mesh root ${resolvedTarget.root}, but this folder's trust root is ${cwdRoot}. ` +
          `Their authorities disagree (${targetAuthority} vs ${cwdAuthority}), so mint refuses to choose one; run \`cotal mint\` from ${resolvedTarget.root}.`,
      ),
    );
    process.exit(1);
  }
  // `--provision` additionally needs an authed target and a live broker. The target was already
  // resolved and held to this root above, so ACLs, trust, storage and the broker all share one root.
  const target = values.provision ? await provisionTarget(auth, values, resolvedTarget) : undefined;
  if (!auth) {
    console.error(c.red("no space auth found here - run `cotal up` first"));
    process.exit(1);
  }
  // THE FLIP (per-user-auth): static agent/observer/admin creds are RETIRED on user-auth spaces.
  // A static mint here would be a fully-working `local.<nkey>` identity that user-mode readers
  // trust — exactly the "no compatibility window may allow old credentials to publish data new
  // owner+actor readers can trust or misattribute" invariant. Fail-closed on the on-disk marker
  // alone (refusing is the safe direction; the manager's stricter marker×registry check guards the
  // PERMISSIVE branch, not this one). `--signer` stays available above: infrastructure creds
  // (supervisor/delivery/…) are pre-flip trust material, not agent identities.
  if (hasUserAuthState(root, auth.space)) {
    console.error(
      c.red(
        `✗ space "${auth.space}" is a per-user-auth mesh - static ${profile} creds are retired here. Use user-mode commands (\`cotal login\`; agents: \`cotal spawn\`); static dashboard/audit creds are not supported on user-auth meshes. Static minting remains available on static-auth meshes.`,
      ),
    );
    process.exit(1);
  }
  // For agents, derive the read/post ACLs AND role from the agent file if one exists (flags
  // override): allowSubscribe (read; defaults to subscribe) and allowPublish (post; default-deny);
  // role scopes the TASK-queue consumer to svc_<role>. Only the agent profile takes the
  // `profile === "agent"` branch below: the three flags are REFUSED above off that profile, so
  // there is no arm here that reads them and discards them.
  // NOTE: this mints CREDS only — the bind-only chat/DM/TASK durables are pre-created separately by
  // a privileged provisioner (`cotal up` / manager / `cotal spawn`), as for DM/TASK already.
  let allowSubscribe: string[] | undefined;
  let allowPublish: string[] | undefined;
  let role: string | undefined;
  // The agent profile's dm/dlv/chathist grants are lifecycle-keyed exact names (SPEC 13.1), so
  // `permissionsFor("agent")` REQUIRES a lifecycleUid and throws without one. This command never
  // supplied it, which made `cotal mint <name> --profile agent` — the default profile, and the one
  // its own usage line advertises first — fail on every space with:
  //   permissionsFor(agent): a lifecycleUid is required
  // Minting one HERE is the correct owner: a lifecycle uid identifies an incarnation, and an
  // out-of-band mint IS the first incarnation of that identity. The alternative (accept one as a
  // flag) would let a caller collide with a live agent's broker footprint by passing its uid.
  let lifecycleUid: string | undefined;
  if (profile === "agent") {
    const f = agentFilePath(root, name);
    const def = existsSync(f) ? loadAgentFile(f) : undefined;
    allowSubscribe = splitList(values["allow-subscribe"]) ?? def?.allowSubscribe ?? def?.subscribe;
    allowPublish = splitList(values["allow-publish"]) ?? def?.allowPublish;
    role = values.role ?? def?.role;
    lifecycleUid = mintLifecycleUid();
  }
  const identity = existingIdentity ?? newIdentity();
  const lifetime = { expiresInSeconds, expiresAt };
  const creds = target
    ? await provisionForMint(auth, identity, { allowSubscribe, allowPublish, role, lifecycleUid: lifecycleUid!, ...lifetime }, target)
    : await mintCreds(auth, identity, profile, { allowSubscribe, allowPublish, role, lifecycleUid, ...lifetime });
  let out: string;
  if (values.out) {
    // An operator-directed EXPORT to an explicit path — outside the canonical kind location,
    // deliberately a plain file write, not a store entry.
    out = resolve(values.out);
    mkSecretDir(dirname(out));
    writeSecretFile(out, creds);
  } else {
    // The default path IS the per-agent standing-cred kind's canonical location — a migrated
    // kind: store first (the source of truth), then materialize the file consumers read.
    const secrets = workspaceSecretStore(root);
    const composition = { injected: false as const, root };
    out = agentSecretFilePaths(root, auth.space, name).creds;
    await secrets.put(agentCredsKey(auth.space, name, composition), creds);
    await materializeSecretToFile(secrets, agentCredsKey(auth.space, name, composition), out);
  }
  console.log(c.green(`✓ minted ${profile} creds for "${name}"${values.provision ? " and provisioned its durables" : ""}`));
  console.log(c.dim(`  id:    ${identity.id}`));
  if (profile === "agent") {
    // The two facts a client needs beyond the file, both stamped into the credential and neither
    // guessable: the wire id it will present (`from.id`, the `to` of every reply), and the
    // lifecycle uid its DM/deliver durables are named for (SPEC 13.1). Without the uid a
    // consuming client cannot bind its inbox; it is recoverable from the grants, but nothing
    // should have to parse a JWT to learn what this command chose a moment ago.
    console.log(c.dim(`  principal: ${principalKey(DEV_OWNER, identity.id).key}`));
    console.log(c.dim(`  lifecycle uid: ${lifecycleUid}`));
    if (!values.provision)
      console.log(c.dim("  (creds only: it can publish within its post ACL now; to CONSUME its DMs on this mesh, mint with --provision)"));
  }
  console.log(c.dim(`  creds: ${out}`));
}

/**
 * Where `--provision` connects, and whose trust it may mint under. The mesh is resolved the way
 * every other command resolves it (registry, `--space`, `--server`), then held to THIS folder's
 * auth: same space, and the same account key. Without that last check two roots that each ran
 * `cotal up` for a space of the same name would let `--provision` mint under whichever one the
 * registry resolved, and the flag would silently change the minting authority `cotal mint` has
 * always taken from the folder it runs in (measured: a mint from root A signed by root B's key).
 * Every refusal here fires before anything is minted or connected.
 */
/**
 * The root whose `.cotal/agents` holds the persona card this mint reads its ACLs from: the
 * RESOLVED MESH's, honouring `--space`/`--server`, the same root `cotal spawn` and `cotal personas`
 * resolve.
 *
 * It used to be `cotalRoot()`, the cwd walk-up. That was survivable only while every persona
 * surface made the same mistake: before the catalog readers were fixed, `cotal personas` WROTE to
 * the cwd root and `cotal mint` READ from it, so the two agreed and an operator editing a card saw
 * mint honour the edit. Once `personas` began writing to the mesh's root, this line kept reading
 * the cwd's - so the card the operator edits and the card mint reads became DIFFERENT FILES, and
 * the divergence is silent.
 *
 * Both directions are wrong and only one is loud. With no card at the cwd root the ACL fields fall
 * through to `permissionsFor`'s default-deny (`opts.allowSubscribe ?? []`), minting a credential
 * with no channel grants. With a STALE card there, `loadAgentFile` returns it and mint issues that
 * card's grants - so narrowing a persona's ACLs through `cotal personas` leaves the wider,
 * superseded grants in force. That is a present-but-wrong input rather than a missing default,
 * which is why the fix is the ROOT and not a guard on the defaults.
 *
 * Resolution is offline and pure (registry + `current` + the cwd project, no broker), so `mint`
 * stays usable without a live mesh. It fails LOUD rather than falling back: silently choosing a
 * different directory to read a security-relevant card from is the defect itself.
 *
 * Exported as the seam the persona-root smoke drives. Reverting the body to `cotalRoot()` reddened
 * no committed suite in the repo before that cell existed - mint appears in none of them - so a
 * regression on this credential surface would have shipped silently.
 */
export function resolveMintTarget(values: { space?: string; server?: string }): MeshTarget {
  try {
    return resolveMeshTarget(process.cwd(), { space: values.space, server: values.server });
  } catch (e) {
    if (isWorkspaceTargetError(e)) {
      console.error(c.red(renderWorkspaceError({ kind: "target", error: e })));
      process.exit(1);
    }
    throw e;
  }
}

async function provisionTarget(auth: SpaceAuth | undefined, flags: { space?: string; server?: string }, resolved?: MeshTarget): Promise<MeshTarget> {
  const target = resolved ?? await resolveTargetOrExit({ space: flags.space ?? auth?.space, server: flags.server });
  if (auth && target.space !== auth.space) {
    console.error(c.red(`--provision resolved mesh "${target.space}" but this root's auth is for space "${auth.space}"; name the space with --space`));
    process.exit(1);
  }
  if (target.mode !== "auth" || !target.auth) {
    console.error(
      c.red(
        target.mode === "open"
          ? `"${target.space}" is an open mesh: peers create their own durables there, so there is nothing to provision (and nothing to mint - connect bare)`
          : `"${target.space}" is a ${target.mode}-mode mesh; --provision pre-creates static-auth durables only`,
      ),
    );
    process.exit(1);
  }
  if (!auth) {
    console.error(c.red(`"${target.space}" is an authed mesh, but this folder holds no trust material for it - run \`cotal mint\` from ${target.root}`));
    process.exit(1);
  }
  if (target.auth.account.pub !== auth.account.pub) {
    console.error(
      c.red(
        `mesh "${target.space}" at ${target.server} runs on a different trust root than this folder's auth (its account is ${target.auth.account.pub}, this folder's is ${auth.account.pub}) - run \`cotal mint\` from ${target.root}, the root that started it`,
      ),
    );
    process.exit(1);
  }
  return target;
}

/**
 * `--provision`: mint AND pre-create the identity's bind-only broker footprint, so the credential
 * can consume rather than only publish.
 *
 * On an authed mesh an agent is denied CONSUMER.CREATE on the DM and TASK streams (the create-time
 * filter is the cross-identity read surface, SPEC section 9), so its `dm_<owner>-<actor>-<uid>`
 * inbox, its Plane-3 `dlv_` durable and its role's `svc_<role>` queue must exist BEFORE it connects
 * with `consume` on. `cotal spawn` does that for the seats it launches; a client minted here had no
 * one to do it, and its first consuming connect died on a raw "consumer not found". This is the same
 * act `cotal spawn` and an interactive `join` perform, in the same containment: a provisioner cred
 * is minted from the space's own trust material, connected, used for the pre-create, and dropped.
 * The mint rides `provisionAgent` so the durables and the grants name the SAME lifecycle uid.
 * `auth` is this folder's trust material; {@link provisionTarget} has already held the target to it.
 */
async function provisionForMint(
  auth: SpaceAuth,
  identity: Identity,
  opts: { allowSubscribe?: string[]; allowPublish?: string[]; role?: string; lifecycleUid: string; expiresInSeconds?: number; expiresAt?: number },
  target: MeshTarget,
): Promise<string> {
  await preflightOrExit(target); // one sentence if the mesh is down or refuses, never a raw NATS trace
  // The provisioner never outlives this call: minted from the space's signing material, connected
  // for the pre-create, stopped. Nothing here holds CONSUMER.CREATE as a standing capability.
  const prov = new CotalEndpoint({
    space: target.space,
    servers: target.server,
    tls: target.tlsRequired,
    creds: await mintCreds(auth, newIdentity(), "provisioner"),
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
    card: { name: "mint-provisioner", role: "provisioner", kind: "endpoint" },
  });
  prov.on("error", () => {}); // a failure surfaces as the throw from start/provision, not as a side channel
  try {
    await prov.start();
    // `subscribe` is a launcher's BOOT channel set; an out-of-band client declares its channels at
    // connect, so here it is the read ACL itself (provisionAgent refuses a boot channel outside the
    // ACL - passing the ACL keeps the footprint exactly as wide as the mint, and no wider). With no
    // --allow-subscribe both are empty: the cred carries no channel row at all, DMs still work.
    return await provisionAgent(prov, auth, identity, { ...opts, subscribe: opts.allowSubscribe });
  } finally {
    await prov.stop().catch(() => {});
  }
}
