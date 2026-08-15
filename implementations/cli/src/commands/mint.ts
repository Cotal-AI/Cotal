import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  CotalEndpoint,
  agentFilePath,
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
import { agentCredsKey, agentSecretFilePaths, authDir, getSoleSpaceAuth, hasUserAuthState, materializeSecretToFile, preflightOrExit, resolveTargetOrExit, workspaceSecretStore } from "@cotal-ai/workspace";
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
  };
  const store = workspaceSecretStore(cotalRoot());
  const dir = authDir(cotalRoot());

  // `--signer`: no identity, no name — strip this space's auth.json to its account signing material.
  if (values.signer) {
    const auth = await getSoleSpaceAuth(store, dir);
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
    console.error(c.red("usage: cotal mint <name> --profile <agent|observer|admin> [--allow-subscribe a,b] [--allow-publish a,b] [--role <role>] [--provision] [--out <path>]"));
    process.exit(1);
  }
  const splitList = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  const profile = (values.profile ?? "agent") as Profile;
  if (profile !== "agent" && profile !== "observer" && profile !== "admin") {
    console.error(c.red(`unknown profile "${profile}" - expected agent, observer, or admin`));
    process.exit(1);
  }
  const auth = await getSoleSpaceAuth(store, dir);
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
  if (hasUserAuthState(cotalRoot(), auth.space)) {
    console.error(
      c.red(
        `✗ space "${auth.space}" is a per-user-auth mesh - static ${profile} creds are retired here. Use user-mode commands (\`cotal login\`; agents: \`cotal spawn\`); static dashboard/audit creds are not supported on user-auth meshes. Static minting remains available on static-auth meshes.`,
      ),
    );
    process.exit(1);
  }
  // For agents, derive the read/post ACLs AND role from the agent file if one exists (flags
  // override): allowSubscribe (read; defaults to subscribe) and allowPublish (post; default-deny);
  // role scopes the TASK-queue consumer to svc_<role>. observers/managers ignore all three.
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
    const f = agentFilePath(cotalRoot(), name);
    const def = existsSync(f) ? loadAgentFile(f) : undefined;
    allowSubscribe = splitList(values["allow-subscribe"]) ?? def?.allowSubscribe ?? def?.subscribe;
    allowPublish = splitList(values["allow-publish"]) ?? def?.allowPublish;
    role = values.role ?? def?.role;
    lifecycleUid = mintLifecycleUid();
  } else if (values.role !== undefined || values.provision) {
    // Neither means anything off the agent profile: an observer or admin binds no per-identity
    // durables and pulls no task queue. Refused rather than ignored, so a typo does not read as done.
    console.error(c.red(`--role and --provision apply to the agent profile only (got --profile ${profile})`));
    process.exit(1);
  }
  const identity = newIdentity();
  const creds = values.provision
    ? await provisionForMint(auth, identity, { allowSubscribe, allowPublish, role, lifecycleUid: lifecycleUid! }, values)
    : await mintCreds(auth, identity, profile, { allowSubscribe, allowPublish, role, lifecycleUid });
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
    const root = cotalRoot();
    const secrets = workspaceSecretStore(root);
    out = agentSecretFilePaths(root, name).creds;
    await secrets.put(agentCredsKey(name), creds);
    await materializeSecretToFile(secrets, agentCredsKey(name), out);
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
 */
async function provisionForMint(
  auth: SpaceAuth,
  identity: Identity,
  opts: { allowSubscribe?: string[]; allowPublish?: string[]; role?: string; lifecycleUid: string },
  flags: { space?: string; server?: string },
): Promise<string> {
  const target = await resolveTargetOrExit({ space: flags.space ?? auth.space, server: flags.server });
  if (target.space !== auth.space) {
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
  await preflightOrExit(target); // one sentence if the mesh is down or refuses, never a raw NATS trace
  // The provisioner never outlives this call: minted from the space's signing material, connected
  // for the pre-create, stopped. Nothing here holds CONSUMER.CREATE as a standing capability.
  const prov = new CotalEndpoint({
    space: target.space,
    servers: target.server,
    tls: target.tlsRequired,
    creds: await mintCreds(target.auth, newIdentity(), "provisioner"),
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
    // connect, so here it is the read ACL itself (provisionAgent defaults it to `general` and refuses
    // one outside the ACL - passing the ACL keeps a scoped mint scoped, never widened to `general`).
    return await provisionAgent(prov, target.auth, identity, { ...opts, subscribe: opts.allowSubscribe });
  } finally {
    await prov.stop().catch(() => {});
  }
}
