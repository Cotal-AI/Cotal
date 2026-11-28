import { rmSync } from "node:fs";
import {
  AgentGrantConflictError,
  deprovisionAgent,
  firstFreeName,
  mintCreds,
  newIdentity,
  principalKey,
  provisionAgentDurables,
  resolveAuthProvider,
  runAgentBearer,
  acquireLock,
  inspectLock,
  localConsumerClaimPath,
  type LaunchOpts,
  type SpaceAuth,
  attemptCleanup,
  describeCleanupFailures,
  rejectionText,
  type CleanupFailure,
} from "@cotal-ai/core";
import {
  CommandFailure,
  agentActorTokenKey,
  agentSecretFilePaths,
  agentSentinelCredsKey,
  authDir,
  getSpaceAuth,
  materializeSecretToFile,
  provenance,
  spaceAccountPath,
  userAuthStateDir,
  workspaceSecretStore,
  type MeshTarget,
} from "@cotal-ai/workspace";
import { c, stderrLine } from "../ui.js";
import { liveMeshNames } from "../lib/live-names.js";
import { withProvisioner } from "../lib/provisioner.js";
import { entryScript } from "../seed/paths.js";
import { AgentAlreadyRunning, heldAnswer, settleHeldName } from "../lib/held-name.js";
import { scrubEnrollmentEnv, HANDOFF_REFUSALS, type RemoteAgentMaterial, checkRemoteAgentMaterial, shredAgentMaterial, noExchangeEndpoint } from "./spawn-enrollment.js";
import { meshRelease } from "./spawn-managed-launch.js";

/**
 * Auto-number `requested` past any peer already present on the mesh (foo → foo_2 → foo_3) — the same
 * series the manager's spawn funnel uses (firstFreeName). Foreground `cotal spawn` doesn't go through
 * the manager, so it has no name reservation: this is a best-effort, advisory check. It connects a
 * transient presence-watching endpoint, lets the roster settle, and snapshots the live names; two
 * simultaneous `cotal spawn`s can still race onto the same number. If the mesh is unreachable the
 * agent couldn't join it anyway, so dedup is skipped and the requested name stands.
 */
export async function uniqueMeshName(
  requested: string,
  target: { space: string; server: string; auth?: SpaceAuth },
): Promise<string> {
  const taken = await liveMeshNames(target);
  return taken ? firstFreeName(requested, (n) => taken.has(n)) : requested;
}

/** Only an occupied actor is retryable; authorization and provisioning failures stay failures.
 *  Thrown only where the collision is found before anything is launched, issued or redeemed, so
 *  it is a refusal. */
class ForegroundActorCollision extends CommandFailure {
  constructor(message: string) {
    super("refused", "CONFLICT", message);
  }
}

export async function provisionFreshForeground<T>(
  requested: string,
  autoName: boolean,
  userMode: boolean,
  provision: (name: string) => Promise<T>,
): Promise<{ name: string; provisioned: T }> {
  const occupied = new Set<string>();
  for (;;) {
    let name: string;
    try {
      // The cap belongs to user mode alone, where the numbered name is the actor. Static and open
      // mode key the actor on the minted nkey, so a numbered name there has no length to fit.
      name = firstFreeName(requested, (candidate) => occupied.has(candidate), userMode ? { actorBound: true } : undefined);
    } catch (e) {
      // The series stops at the actor bound, so a base whose every fitting candidate is taken is a
      // refusal, not a crash: nothing has been launched, issued or redeemed yet.
      throw new CommandFailure("refused", "CONFLICT", e instanceof Error ? e.message : String(e));
    }
    try {
      return { name, provisioned: await provision(name) };
    } catch (e) {
      if (!autoName || !(e instanceof ForegroundActorCollision || e instanceof AgentGrantConflictError || e instanceof AgentAlreadyRunning)) throw e;
      occupied.add(name);
    }
  }
}

/** Foreground REMOTE-USER onboarding — the participant path for a mesh registered with
 *  `meshes add --from` that advertises an agent-provisioning endpoint (U6 §2).
 *
 *  The local twin below ({@link provisionUserForeground}) cannot run here and must not try: it
 *  needs the space's owner secret and account signer to grant a row and pre-create durables, and
 *  those never leave the machine the mesh runs on. Instead the mesh's own endpoint does that work
 *  inside the owner's delegation envelope and hands back ready material; this function's job is to
 *  present the login bearer, validate what comes back, land it 0600, and prove the bearer chain
 *  before launch — the same preflight discipline, with the grant performed remotely.
 *
 *  Deliberately NOT reusing the local path's cleanup: nothing here created broker state locally, so
 *  teardown is the mesh's business (its lifecycle owns the row and the durables). The spawned
 *  agent's material is shredded on exit; the row is not revoked from here, because this machine
 *  holds no authority to revoke it. For a managed handoff, `refusals` replaces the sentences of the
 *  local-state, material and bearer steps, which quote the space, the actor or the exchange URL. */
export async function provisionRemoteUserForeground(
  target: MeshTarget,
  name: string,
  source: { provisioningUrl: string } | { body: unknown; exchangeUrl: string },
  refusals?: typeof HANDOFF_REFUSALS,
): Promise<{ userAuth: NonNullable<LaunchOpts["userAuth"]>; cleanup: () => Promise<void>; material: RemoteAgentMaterial }> {
  const { space } = target;
  const store = workspaceSecretStore(target.root);
  const composition = { injected: false as const, root: target.root };
  const fail = (msg: string): never => {
    stderrLine("✗ ", `${msg}`, c.red);
    process.exit(1);
  };
  // Resolved first, as by every consumer of the space's local state: each resolution migrates a
  // pre-hex or root-scoped layout, or refuses an ambiguous one, before any request or material.
  let paths: ReturnType<typeof agentSecretFilePaths>;
  try {
    userAuthStateDir(target.root, space);
    paths = agentSecretFilePaths(target.root, space, name);
  } catch (e) {
    return fail(refusals?.registration ?? (e as Error).message);
  }
  let provider: ReturnType<typeof resolveAuthProvider>;
  try {
    provider = resolveAuthProvider();
  } catch (e) {
    return fail((e as Error).message);
  }
  // Checked before the grant is requested, because `fail` exits without running the shred in the
  // catch below and would leave the granted material on disk.
  const exchangeUrl = "body" in source ? source.exchangeUrl : target.userAuth?.endpoints?.url;
  if (!exchangeUrl) return fail(noExchangeEndpoint(space));
  let body: unknown;
  const held = `foreground actor material for "${name}" is already held; preserve its session and choose a distinct actor for a new launch`;
  const materialClaim = acquireLock(`${paths.actorToken}.launch.lock`, {
    waitMs: 0,
    // A supplied body comes from an enrollment that was already redeemed, so its collision is not
    // a refusal: the one-time enrollment is spent.
    onTimeout: () => "body" in source ? new Error(held) : new ForegroundActorCollision(held),
  });
  if ("body" in source) {
    body = source.body;
  } else {
    const idpUrl = target.userAuth?.idp.url;
    if (!idpUrl) return fail(`mesh "${space}" records no IdP to sign in against - re-register it with \`cotal meshes add ${space} --from <url> --mode user\``);
    // The login proof rides the provisioning request, so the POST is the PROVIDER's (this package
    // never touches the session cache); its thrown sentences are already operator-exact — the
    // no-login gate names the `cotal login --idp …` line, a refusal carries the mesh's own reason.
    if (!provider.postAgentProvisioning)
      return fail(`the registered auth provider "${provider.name}" cannot provision agents on a remote mesh - run the agent where the mesh runs`);
    // A name held by a lifecycle that is not running is released and asked for again.
    try {
      body = await settleHeldName({ space }, () => provider.postAgentProvisioning!({ url: source.provisioningUrl, idpUrl, actor: name }), (o) => "error" in o
        ? heldAnswer({ code: (o.error as { code?: unknown } | null)?.code, details: (o.error as { details?: unknown } | null)?.details, message: rejectionText(o.error) }, name) : undefined, meshRelease(target));
    } catch (e) {
      materialClaim.release();
      // No sign-in refuses before any request. Any failure after the request, an endpoint refusal
      // included, may have provisioned the actor.
      if ((e as { code?: unknown }).code === "signed-out") throw new CommandFailure("refused", "AUTH_REQUIRED", (e as Error).message);
      throw e;
    }
  }
  const checked = checkRemoteAgentMaterial(body, name);
  if (!checked.ok) {
    materialClaim.release();
    if (checked.exists && "provisioningUrl" in source) throw new ForegroundActorCollision(checked.message);
    return fail(refusals?.bundle ?? checked.message);
  }
  const material = checked.material;
  const { actorToken: tokenPath, sentinelCreds: sentinelPath, health: healthPath } = paths;
  if (inspectLock(localConsumerClaimPath(target.server, space, material.owner, name, material.lifecycleUid)).state === "active") {
    materialClaim.release();
    return fail(`local inbox already has a consuming session for ${material.owner}.${name}; no local material was replaced`);
  }
  try {
    // Land both secrets 0600 through the store, exactly as the local path does — the bearer
    // re-exec and the launch handoff read FILES.
    await store.put(agentActorTokenKey(space, name, composition), material.actorToken);
    await store.put(agentSentinelCredsKey(space, name, composition), material.sentinelCreds);
    await materializeSecretToFile(store, agentActorTokenKey(space, name, composition), tokenPath);
    await materializeSecretToFile(store, agentSentinelCredsKey(space, name, composition), sentinelPath);
    rmSync(healthPath, { force: true });
    provenance.wrote(`remote actor material ${material.owner}.${name} (user mode)`, tokenPath);
    // The bearer preflight — the same one-shot proof the local path runs, pointed at the pinned
    // exchange instead of a local service. A dead auth chain stops the spawn here. The agent runs
    // this command for every renewal, so it names the resolved entry: an install can replace the
    // bin link meanwhile (get.cotal.ai writes a shell launcher over `~/.local/bin/cotal`).
    const bearerCmd = [
      process.execPath,
      ...process.execArgv,
      entryScript(),
      provider.agentBearerCommand,
      "--exchange-url", exchangeUrl,
      "--space", space,
      "--owner", material.owner,
      "--actor", name,
      "--token-file", tokenPath,
      "--health-file", healthPath,
    ];
    await runBearerPreflight(bearerCmd);
    return {
      userAuth: { owner: material.owner, actor: name, sentinelCredsPath: sentinelPath, bearerCmd },
      material,
      // Local shred only. The remote row and its durables belong to the mesh's lifecycle; this
      // machine has no authority to retire them and must not pretend otherwise.
      cleanup: async () => {
        const failed: CleanupFailure[] = [];
        if (await store.get(agentActorTokenKey(space, name, composition)) === material.actorToken)
          await shredAgentMaterial(failed, store, space, name, composition, paths);
        materialClaim.release();
        if (failed.length) throw new Error(describeCleanupFailures(failed));
      },
    };
  } catch (e) {
    // What the shred left behind joins the refusal after its cause. A handoff refusal keeps its
    // fixed sentence and names only the failed steps, because their errors quote paths named for
    // the handoff's actor.
    const failed: CleanupFailure[] = [];
    if (await store.get(agentActorTokenKey(space, name, composition)) === material.actorToken)
      await shredAgentMaterial(failed, store, space, name, composition, paths);
    materialClaim.release();
    const steps = refusals ? failed.map((f) => f.step).join("; ") : describeCleanupFailures(failed);
    const leftover = failed.length ? `; cleanup failed: ${steps}` : "";
    return fail(`${refusals?.bearer ?? `agent auth preflight failed for "${name}": ${rejectionText(e)}`}${leftover}`);
  }
}

/** Foreground USER-MODE onboarding — the CLI-side twin of the manager's user spawn provisioning:
 *  owner = the logged-in operator (offline, from the login cache + local user-auth material);
 *  principal-keyed durables on an ephemeral provisioner (LIVE-ONLY, like static foreground);
 *  fresh ledger grant that refuses an occupied actor; 0600 secret/sentinel files; and a
 *  one-shot bearer preflight whose operator-exact sentence is the refusal. Exits on any failure —
 *  the agent process is never launched into a broken auth chain. */
export async function provisionUserForeground(
  target: MeshTarget,
  name: string,
  ref: string,
  opts: { eventPayloads?: boolean; subscribe?: string[]; allowSubscribe: string[]; allowPublish?: string[]; role?: string; capabilities?: string[]; lifecycleUid: string; liveOnly?: boolean; eventChannel?: (p: { owner: string; actor: string }) => string },
): Promise<{ userAuth: NonNullable<LaunchOpts["userAuth"]>; cleanup: () => Promise<void>; eventChannel?: string }> {
  const { space, server } = target;
  const dir = userAuthStateDir(target.root, space);
  const store = workspaceSecretStore(target.root);
  const composition = { injected: false as const, root: target.root };
  const fail = (msg: string): never => {
    stderrLine("✗ ", `${msg}`, c.red);
    process.exit(1);
  };
  let provider: ReturnType<typeof resolveAuthProvider>;
  let owner: string;
  try {
    provider = resolveAuthProvider();
    owner = await provider.ownerForLogin({ store, dir, space });
  } catch (e) {
    return fail((e as Error).message);
  }
  // The provisioner cred is INFRA (pre-flip static coexistence, like the manager's own creds) —
  // loaded explicitly here for durable pre-creation only, never for the agent's identity.
  // The event grant, derived HERE because this is the first point at which the owner exists: in
  // user mode the principal is (resolved owner, actor name), and neither half is known to the
  // caller before `ownerForLogin` answers.
  const eventGrant = opts.eventChannel?.({ owner, actor: name });
  const publish = eventGrant ? [...(opts.allowPublish ?? []), eventGrant] : (opts.allowPublish ?? []);
  const infra = await getSpaceAuth(store, space); // cross-check the bundle names the space we resolved this root for
  if (!infra) return fail(`space "${space}" has user-auth state but no trust record under ${authDir(target.root)} (expected ${spaceAccountPath(authDir(target.root), space)} or the legacy auth.json) - re-run \`cotal up --user-auth\` here`);
  const paths = agentSecretFilePaths(target.root, space, name);
  const { actorToken: tokenPath, sentinelCreds: sentinelPath, health: healthPath } = paths;
  const materialClaim = acquireLock(`${tokenPath}.launch.lock`, {
    waitMs: 0,
    onTimeout: () => new ForegroundActorCollision(`foreground actor material for "${name}" is already held; preserve its session and choose a distinct actor for a new launch`),
  });
  // An existing row is not this new launch's property. In particular, a dead launcher may
  // leave its consuming child alive. Never overwrite the row to discover occupancy later.
  if (await provider.actorScope({ dir, owner, actor: name }) !== undefined) {
    materialClaim.release();
    throw new ForegroundActorCollision(`actor "${name}" already has a grant; preserve its session and choose a distinct actor for a new launch`);
  }
  let ownedToken: string | undefined;
  // Revoke the row, shred the secret material, and retire the broker footprint the durable
  // provisioning below creates (DM/DLV durables + ACL row). Every step is attempted, so a failed
  // removal cannot strand the durables on the broker, and the failures go back to the caller.
  const teardown = async (): Promise<CleanupFailure[]> => {
    const failed: CleanupFailure[] = [];
    if (ownedToken === undefined) return failed;
    let revoked = false;
    await attemptCleanup(failed, "revoke agent grant", async () => {
      revoked = await provider.revokeAgent({ dir, owner, actor: name, lifecycleUid: opts.lifecycleUid, actorToken: ownedToken });
    });
    if (await store.get(agentActorTokenKey(space, name, composition)) === ownedToken)
      await shredAgentMaterial(failed, store, space, name, composition, paths);
    if (!revoked) return failed;
    const targetId = principalKey(owner, name).key;
    await attemptCleanup(failed, "deprovision", () =>
      mintCreds(infra, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: targetId, lifecycleUid: opts.lifecycleUid } })
        .then((creds) => deprovisionAgent({ servers: server, space, targetId, lifecycleUid: opts.lifecycleUid, creds })));
    return failed;
  };
  try {
    // The GRANT first — it is the envelope-rule enforcement point (a delegation must sit within
    // the spawner's own grant), so a refused delegation exits here with zero broker footprint —
    // the same ordering as Manager.provisionUserAgent, for the same reason.
    const grant = await provider.grantAgent({
      store,
      dir,
      space,
      broker: { server, ...(target.tlsRequired ? { tlsRequired: true } : {}) },
      owner,
      actor: name,
      scope: (opts.capabilities ?? []).filter((s) => s === "spawn" || s === "run" || s === "admin" || /^role:[A-Za-z0-9_-]+$/.test(s)),
      allowSubscribe: opts.allowSubscribe,
      allowPublish: publish,
      ...(opts.eventPayloads === false ? { eventPayloads: false as const } : {}),
      role: opts.role,
      parent: `${owner}.cli`,
      label: ref,
      lifecycleUid: opts.lifecycleUid,
      fresh: true,
      // A foreground launch has no manager; its row says so.
      custody: { kind: "foreground" },
    });
    ownedToken = grant.actorToken;
    await withProvisioner({ space, servers: server, auth: infra }, "spawn-provisioner", (prov) =>
      // Full durable footprint, same as the static foreground path: the ACL row is what lets the
      // delivery daemon authorize this agent's durable joins. `--live-only` opts out.
      provisionAgentDurables(prov, { owner, actor: name, lifecycleUid: opts.lifecycleUid }, {
        subscribe: opts.subscribe,
        allowSubscribe: opts.allowSubscribe,
        role: opts.role,
        ...(opts.liveOnly ? { durableMembership: false } : {}),
      }));
    // The store holds the source of truth; the bearer re-exec (`--token-file`) and the launch's
    // sentinel handoff read FILES — materialize both at the canonical paths (byte-identical
    // rewrites under this, the local FS, composition).
    await store.put(agentActorTokenKey(space, name, composition), grant.actorToken);
    await store.put(agentSentinelCredsKey(space, name, composition), grant.sentinelCreds);
    await materializeSecretToFile(store, agentActorTokenKey(space, name, composition), tokenPath);
    await materializeSecretToFile(store, agentSentinelCredsKey(space, name, composition), sentinelPath);
    rmSync(healthPath, { force: true });
    provenance.wrote(`actor grant ${owner}.${name} (user mode)`, tokenPath);
    // The resolved entry, for the same reason as the remote arm above.
    const bearerCmd = [
      process.execPath,
      ...process.execArgv,
      entryScript(),
      provider.agentBearerCommand,
      "--dir", dir,
      "--space", space,
      "--owner", owner,
      "--actor", name,
      "--token-file", tokenPath,
      "--health-file", healthPath,
    ];
    await runBearerPreflight(bearerCmd);
    return {
      userAuth: { owner, actor: name, sentinelCredsPath: sentinelPath, bearerCmd },
      ...(eventGrant ? { eventChannel: eventGrant } : {}),
      // The foreground departure's half of the runtime-grant invariant: the caller runs this when
      // the agent process exits, the same teardown the rollback below runs on a failed preflight.
      cleanup: async () => {
        const failed = await teardown();
        if (failed.length) throw new Error(describeCleanupFailures(failed));
        materialClaim.release();
      },
    };
  } catch (e) {
    // Roll back EVERYTHING this attempt materialized: a refused spawn leaves no row, no secret, no
    // orphaned durables. What the teardown could not remove joins the refusal after its cause.
    const failed = await teardown();
    materialClaim.release();
    if (e instanceof AgentGrantConflictError && ownedToken === undefined && failed.length === 0) throw e;
    const leftover = failed.length ? `; cleanup failed: ${describeCleanupFailures(failed)}` : "";
    return fail(`agent auth preflight failed for "${name}": ${rejectionText(e)}${leftover}`);
  }
}

/** Run the one-shot bearer proof with an explicit credential-scrubbed environment. The enrollment
 * path removes the variables from the parent before any child, and this boundary independently
 * refuses to inherit them if another caller reaches it with ambient enrollment input. */
export async function runBearerPreflight(bearerCmd: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const childEnv = { ...env };
  scrubEnrollmentEnv(childEnv);
  await runAgentBearer(bearerCmd, { env: childEnv });
}
