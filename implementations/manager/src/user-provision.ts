import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import {
  MANAGED_HANDOFF_KIND, assertLifecycleToken, canonicalJson, channelGrantField, parsePrincipalKey, principalKey,
  provisionAgentDurables, resolveAuthProvider, runAgentBearer, rejectionText, attemptCleanup, describeCleanupFailures,
  type CleanupFailure, type CotalEndpoint, type EpCaller, type EpErrorCode, type EpErrorDetail,
  type ManagedLifecycleHandoff, type RemoteManagedAgentEnrollmentRequest, type RemoteManagedAgentEnrollmentResult,
  type RemoteDelegatedUserIntentExecutionRequest, type RemoteDelegatedUserIntentExecutionResult,
  type SecretStore, type UserAuthLaunch,
} from "@cotal-ai/core";
import {
  agentLifecycleSecretFilePaths, agentSecretKeyForFile, loadMeshes, materializeSecretToFile, userAuthStateDir,
  type MeshEntry, type UserAuthInfo,
} from "@cotal-ai/workspace";
import { caughtEnvelope } from "./turn-relay.js";
import { pendingEnrollment } from "./pending-enrollment.js";
import type { RunHosting } from "./run-hosting.js";
import type { TeardownTarget } from "./retirement.js";
import type { Manager } from "./manager.js";
import { bearerEntryArgv } from "./preserved-resume.js";

type EnrollManagedAgent = (args: {
  requestId?: string;
  target: Omit<RemoteManagedAgentEnrollmentRequest["target"], "eventPayloads">;
  spawn?: RemoteManagedAgentEnrollmentRequest["spawn"];
}) => Promise<RemoteManagedAgentEnrollmentResult["material"]>;

/** What the host returned for one managed-agent enrollment (#1972). */
export type ManagedEnrollment = Awaited<ReturnType<EnrollManagedAgent>>;

/** A user-mode spawn's provisioning options. Both arms take this one declaration because
 *  {@link Manager.provisionUserAgent} forwards it to {@link Manager.enrollUserAgent} on the
 *  hosted arm. */
export interface ProvisionUserAgentOpts {
  eventPayloads?: boolean;
  spawner?: string;
  specOwner?: string;
  subscribe?: string[];
  allowSubscribe: string[];
  allowPublish?: string[];
  /** Channels or patterns removed from the two lists above (SPEC §9). */
  excludeSubscribe?: string[];
  excludePublish?: string[];
  role?: string;
  capabilities?: string[];
  label: string;
  /** The incarnation's lifecycle UID: recorded on the ledger row (the callout mints the agent's
   *  lifecycle-keyed grants from it) AND used for the provisioned durables/ACL row, so the
   *  credential names and the broker footprint can never diverge. On the HOSTED enrollment arm
   *  this is the participant's provisional uid only: the host picks the authoritative one (it
   *  alone reads the retirement tombstones), and the returned `lifecycleUid` is that value. */
  lifecycleUid: string;
  delegatedIntent?: { intentId: string; owner: string; parent: string };
  /** The served spawn this enrollment answers, which the hosted arm forwards. */
  spawnRequest?: { served: string; runId?: string };
  /** Authenticated caller identity, so another caller cannot adopt an unanswered enrollment. */
  enrollmentCaller?: { owner: string; actor: string };
  /** Called once the host's enrollment answer passed the owner, actor and uid checks, before any
   *  later step, so a caller that must hold the enrolled uid holds it whatever fails after. */
  onEnrolled?: (enrolled: Pick<ProvisionedUserAgent, "owner" | "lifecycleUid" | "files">) => void;
}

/** A provisioned user-mode agent, from either arm. Only the hosted arm sets `enrolled`. */
export interface ProvisionedUserAgent {
  owner: string;
  lifecycleUid: string;
  files: { actorToken: string; sentinelCreds: string; health: string };
  launch: UserAuthLaunch;
  enrolled?: { material: ManagedEnrollment; actorToken: string };
}

/** A user-mode provisioning refusal. `refused` is the host's code when the host refused the
 *  enrollment and the attempt removed every secret it had staged, so it left nothing behind, and
 *  `details` are that refusal's own, such as a host's typed held answer. */
export interface UserAgentRefusal {
  error: string;
  refused?: EpErrorCode;
  details?: EpErrorDetail[];
}

/** Reads are live at each original use, including authority assigned or replaced after construction. */
export interface UserProvisionDeps {
  space(): string;
  workspaceRoot(): string;
  secrets(): SecretStore;
  managerInstanceId(): string;
  runHosting(): Pick<RunHosting, "runAdmission"> | undefined;
  remoteAuthority(): {
    owner: string;
    lifecycleUid: string;
    agentBearerExchangeUrl: string;
    enrollManagedAgent?: EnrollManagedAgent;
    executeDelegatedUserIntent?: (
      execute: RemoteDelegatedUserIntentExecutionRequest["execute"] & { intentId: string },
    ) => Promise<RemoteDelegatedUserIntentExecutionResult>;
  } | undefined;
  deprovision(target: TeardownTarget): Promise<void>;
  withProvisioner<T>(fn: (prov: CotalEndpoint) => Promise<T>): Promise<T>;
  shredUserSecrets(failures: CleanupFailure[], family: { actorToken?: string; sentinelCreds?: string; health?: string }): Promise<void>;
  bearerEntryArgv(): string[];
}

/** Builds the {@link UserProvisionDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function userProvisionDeps(m: Manager): UserProvisionDeps {
  return {
    space: () => m["space"],
    workspaceRoot: () => m["workspaceRoot"],
    secrets: () => m["secrets"],
    managerInstanceId: () => m["managerInstanceId"],
    runHosting: () => m["runHosting"],
    remoteAuthority: () => m["remoteAuthority"],
    deprovision: (target) => m["deprovision"](target),
    withProvisioner: (fn) => m["withProvisioner"](fn),
    shredUserSecrets: (failures, family) => m["shredUserSecrets"](failures, family),
    bearerEntryArgv,
  };
}

/** User-mode local grants, hosted enrollment and delegated lifecycle handoff composition. */
export class UserProvision {
  constructor(private readonly deps: UserProvisionDeps) {}

  private get space() { return this.deps.space(); }
  private get workspaceRoot() { return this.deps.workspaceRoot(); }
  private get secrets() { return this.deps.secrets(); }
  private get managerInstanceId() { return this.deps.managerInstanceId(); }
  private get runHosting() { return this.deps.runHosting(); }
  private get remoteAuthority() { return this.deps.remoteAuthority(); }

  /** The served spawn a hosted enrollment forwards. A run's spawn also names its run, so the host
   *  bounds the helper by what the run's starter held when the run was admitted (SPEC 14.8). */
  servedSpawnRequest(served: string, caller: EpCaller | undefined): { served: string; runId?: string } {
    const run = caller !== undefined ? this.runHosting?.runAdmission(caller) : undefined;
    return { served, ...(run !== undefined ? { runId: run.runId } : {}) };
  }

  /** USER-MODE spawn provisioning (the gate-1 counterpart to the static mint block): resolve the
   *  OWNER (ctl caller's principal, or the manifest's stamped owner — never a payload field),
   *  pre-create the principal-keyed durables + ACL row on the ephemeral provisioner, author the
   *  ledger grant (the upsert ROTATES the per-agent secret on every start — a non-running agent
   *  never holds a standing mint secret), materialize the 0600 secret/sentinel files, and
   *  PREFLIGHT the bearer chain once — the spawned agent must never be the first to discover a
   *  dead auth plane. Every failure is returned as the refusal sentence, with the grant + files
   *  rolled back. */
  async provisionUserAgent(name: string, opts: ProvisionUserAgentOpts): Promise<ProvisionedUserAgent | UserAgentRefusal> {
    if (opts.delegatedIntent) {
      // startAgentActive refused a delegated launch on a manager without this callback.
      const execute = this.remoteAuthority!.executeDelegatedUserIntent!;
      const { intentId, owner } = opts.delegatedIntent;
      // The hosted arm with the intent's execution in place of the holder's own enrollment: the
      // spawning owner is the intent's, so its existing owner check refuses any other.
      return this.enrollUserAgent(name, { ...opts, specOwner: owner }, async ({ target }) => {
        const result = await execute({ intentId, operation: "launch", target: { actor: target.actor, tokenHash: target.tokenHash } });
        if (result.operation !== "launch" || result.intentId !== intentId)
          throw new Error(`the host answered delegated intent ${intentId} with another execution`);
        return result.material;
      });
    }
    if (this.remoteAuthority?.enrollManagedAgent) return this.enrollUserAgent(name, opts, this.remoteAuthority.enrollManagedAgent);
    const spawnerPr = opts.spawner ? parsePrincipalKey(opts.spawner) : null;
    const owner = opts.specOwner ?? (spawnerPr && spawnerPr.owner.startsWith("u_") ? spawnerPr.owner : undefined);
    if (!owner)
      return {
        error: `user-auth space "${this.space}": no owner for this spawn - call it from a user-mode session (\`cotal login\` then \`cotal spawn\`), or apply a manifest as a logged-in operator`,
      };
    let provider;
    try {
      provider = resolveAuthProvider();
    } catch (e) {
      return { error: rejectionText(e) };
    }
    const dir = userAuthStateDir(this.workspaceRoot, this.space);
    // The agent's capability scope rides its ledger row (act.scope in every bearer) — same
    // vocabulary as static capabilities; the broker maps them to the ctl tiers. `role:<r>` tokens
    // pass through too (a persona may hold delegable roles) — the ledger's envelope walk still
    // attenuates every one of these against the spawner chain.
    const scope = (opts.capabilities ?? []).filter((c) => c === "spawn" || c === "run" || c === "admin" || /^role:[A-Za-z0-9_-]+$/.test(c));
    // The manager's ONE store (injected for a hosted composition, workstation FS locally). A hosted
    // user-mode spawn reads the callout material from it — the same store the auth-store kinds
    // (callout/issuer/…) were migrated onto — so this is no longer a local-only path.
    const secrets = this.secrets;
    // LIFECYCLE-KEYED family (SPEC 13.1 name-disjointness on the FS): this incarnation's files
    // embed its uid, so no teardown addressed to another incarnation can ever reach them.
    const files = agentLifecycleSecretFilePaths(this.workspaceRoot, this.space, name, opts.lifecycleUid);
    const { actorToken: tokenPath, sentinelCreds: sentinelPath, health: healthPath } = files;
    try {
      // The GRANT first — it is the envelope-rule enforcement point (a delegation must sit within
      // the spawner's own grant), so a refused delegation exits here having touched nothing beyond
      // the ledger: no durables, no broker footprint, nothing for a corrected respawn to race.
      const grant = await provider.grantAgent({
        store: secrets,
        dir,
        space: this.space,
        owner,
        actor: name,
        scope,
        allowSubscribe: opts.allowSubscribe,
        allowPublish: opts.allowPublish ?? [],
        ...(opts.excludeSubscribe?.length ? { excludeSubscribe: opts.excludeSubscribe } : {}),
        ...(opts.excludePublish?.length ? { excludePublish: opts.excludePublish } : {}),
        ...(opts.eventPayloads === false ? { eventPayloads: false as const } : {}),
        role: opts.role,
        parent: spawnerPr ? opts.spawner : undefined,
        label: opts.label,
        lifecycleUid: opts.lifecycleUid,
        // This manager attests its own persisted logical instance id: the same id a static slot
        // records as its owner. Recovery binds a managed row to a manager only through this.
        custody: { kind: "local-manager", instanceId: this.managerInstanceId },
      });
      // Durables + ACL row, LIFECYCLE-keyed (SPEC 13.1) — the same onboarding as static agents minus
      // the mint (a user agent's credential is its bearer, minted by the callout per connect from the
      // ledger row's recorded lifecycleUid — the same value provisioned here).
      await this.deps.withProvisioner((prov) =>
        provisionAgentDurables(prov, { owner, actor: name, lifecycleUid: opts.lifecycleUid }, {
          subscribe: opts.subscribe,
          allowSubscribe: opts.allowSubscribe,
          ...(opts.excludeSubscribe?.length ? { excludeSubscribe: opts.excludeSubscribe } : {}),
          role: opts.role,
        }),
      );
      // The store holds the source of truth; the bearer re-exec (`--token-file`) and the launch's
      // sentinel handoff read FILES, so materialize both at the canonical paths (under the local
      // FS composition, a byte-identical rewrite of the keys' own locations).
      await secrets.put(agentSecretKeyForFile(tokenPath, this.space), grant.actorToken);
      await secrets.put(agentSecretKeyForFile(sentinelPath, this.space), grant.sentinelCreds);
      await materializeSecretToFile(secrets, agentSecretKeyForFile(tokenPath, this.space), tokenPath);
      await materializeSecretToFile(secrets, agentSecretKeyForFile(sentinelPath, this.space), sentinelPath);
      rmSync(healthPath, { force: true }); // a fresh start opens a fresh health window
      const bearerCmd = [
        // The manager's own invocation prefix (node + loader flags + the cotal entry) — the agent
        // process execs this argv for every bearer, so it must resolve from ANY cwd. Correct
        // whenever the manager runs under a real `cotal` entry (supervise/up); a test constructing
        // Manager directly never reaches this branch (user meshes boot through the CLI).
        ...this.deps.bearerEntryArgv(),
        provider.agentBearerCommand,
        "--dir", dir,
        "--space", this.space,
        "--owner", owner,
        "--actor", name,
        "--token-file", tokenPath,
        "--health-file", healthPath,
      ];
      // One bearer run before the launch is the end-to-end auth preflight (state dir, daemon, ledger
      // row, secret); its failure sentence is the spawn refusal.
      await runAgentBearer(bearerCmd);
      return { owner, lifecycleUid: opts.lifecycleUid, files, launch: { owner, actor: name, sentinelCredsPath: sentinelPath, bearerCmd } };
    } catch (e) {
      // Roll back everything this attempt materialized — a refused spawn must leave no standing
      // secret, no ledger row, no durable footprint — and AWAIT the broker teardown: the caller
      // may respawn the moment it reads the refusal, and a detached teardown would race (and
      // delete) that fresh spawn's just-provisioned durables. deprovision shreds the secret family
      // and revokes the grant, but only logs a failed revoke, so the revoke is attempted here first.
      // Each failure joins the refusal, so the caller learns what this spawn left behind.
      const failed: CleanupFailure[] = [];
      await attemptCleanup(failed, "revoke agent grant", () => provider.revokeAgent({ dir, owner, actor: name }));
      await attemptCleanup(failed, "deprovision", () =>
        this.deps.deprovision({ id: principalKey(owner, name).key, name, lifecycleUid: opts.lifecycleUid, userOwner: owner, secretPaths: files }));
      const leftover = failed.length ? `; cleanup failed: ${describeCleanupFailures(failed)}` : "";
      return { error: `agent auth preflight failed for "${name}": ${rejectionText(e)}${leftover}` };
    }
  }

  /**
   * HOSTED user-mode spawn provisioning (#1972): the participant arm of host-owned enrollment.
   *
   * A registered participant holds no ledger writer, no JetStream provisioner, and no signing seed,
   * so every step the local arm above performs itself is the HOST's here. What stays local is the
   * one thing that must: the standing `actorToken`. This method generates it, writes it at 0600
   * BEFORE the request, and sends only its SHA-256 digest — so the plaintext never crosses the
   * network and a host compromise cannot replay an agent's exchange secret.
   *
   * The HOST picks the lifecycle UID. It alone can see the retirement tombstones that make a UID
   * permanently unusable (a retired uid is refused forever by the retirement frontier), so a
   * participant-chosen uid could aim a fresh grant at a dead incarnation. The uid the host returns
   * is the one the spawn records and the one the child's durables are keyed by.
   *
   * The bearer argv selects `--exchange-url`: the local `--dir` arm reads a state directory this
   * machine does not have, and a signerless participant must never appear to hold one.
   */
  private async enrollUserAgent(
    name: string,
    opts: ProvisionUserAgentOpts,
    enroll: EnrollManagedAgent,
  ): Promise<ProvisionedUserAgent | UserAgentRefusal> {
    let provider;
    try {
      provider = resolveAuthProvider();
    } catch (e) {
      return { error: rejectionText(e) };
    }
    const secrets = this.secrets;
    const input = {
      target: {
        actor: name,
        ...(opts.role !== undefined ? { role: opts.role } : {}),
        label: opts.label,
        ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
        ...(opts.subscribe !== undefined ? { subscribe: opts.subscribe } : {}),
        // Each list travels with its exclusions as `{ allow, exclude }`, which a host that predates
        // exclusions refuses (SPEC §9).
        allowSubscribe: channelGrantField(opts.allowSubscribe, opts.excludeSubscribe),
        ...(opts.allowPublish !== undefined ? { allowPublish: channelGrantField(opts.allowPublish, opts.excludePublish) } : {}),
        ...(opts.eventPayloads === false ? { eventPayloads: false as const } : {}),
      },
      ...(opts.spawnRequest !== undefined ? { spawn: opts.spawnRequest } : {}),
    };
    // An unanswered enrollment may already hold the host's alias. Keep its request and standing
    // token together until preflight succeeds, rather than minting a conflicting successor.
    let pending: Awaited<ReturnType<typeof pendingEnrollment<typeof input>>> | undefined;
    if (!opts.delegatedIntent) {
      try {
        pending = await pendingEnrollment({ store: secrets, space: this.space,
          instanceId: this.managerInstanceId, actor: name, input,
          authority: { target: input.target, owner: this.remoteAuthority!.owner,
            managerLifecycleUid: this.remoteAuthority!.lifecycleUid, specOwner: opts.specOwner, spawner: opts.spawner,
            caller: opts.enrollmentCaller, runId: opts.spawnRequest?.runId } });
      } catch (e) {
        return { error: `agent auth preflight failed for "${name}": ${rejectionText(e)}` };
      }
    }
    const actorToken = pending?.record.actorToken ?? randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(actorToken, "utf8").digest("hex");
    // Provisional paths under the participant's OWN uid: the token has to be on disk before the
    // request (a host that granted against a digest whose plaintext was lost would leave an agent
    // that can never exchange), and the host's uid is not known until the request answers. The
    // family is re-keyed to the host's uid below.
    const staged = agentLifecycleSecretFilePaths(this.workspaceRoot, this.space, name, pending?.record.lifecycleUid ?? opts.lifecycleUid);
    let files = staged;
    let material: Awaited<ReturnType<typeof enroll>> | undefined;
    let sent = false;
    try {
      await secrets.put(agentSecretKeyForFile(staged.actorToken, this.space), actorToken);
      await materializeSecretToFile(secrets, agentSecretKeyForFile(staged.actorToken, this.space), staged.actorToken);
      const saved = pending?.record.input ?? input;
      if (canonicalJson(saved.target) !== canonicalJson(input.target))
        throw new Error(`pending enrollment for "${name}" names different target authority`);
      sent = true;
      // The original observation may have expired, or vanished on a host restart before commit.
      // Same-authority retries keep the enrollment identity but carry this freshly served spawn.
      material = await enroll({ ...input, target: { ...saved.target, tokenHash },
        ...(pending ? { requestId: pending.record.requestId } : {}) });
      if (material.actor !== name)
        throw new Error(`the host enrolled actor "${material.actor}", not the requested "${name}"`);
      const specOwner = opts.specOwner ?? (opts.spawner ? parsePrincipalKey(opts.spawner)?.owner : undefined);
      if (specOwner !== undefined && specOwner.startsWith("u_") && material.owner !== specOwner)
        throw new Error(`the host enrolled the agent under owner ${material.owner}, not the spawning owner ${specOwner}`);
      assertLifecycleToken(material.lifecycleUid, "host-enrolled managed agent lifecycleUid");
      // Re-key the family onto the HOST's uid (SPEC 13.1 name-disjointness on the FS): the child's
      // credential paths must embed the uid its broker footprint carries, never the provisional one.
      files = agentLifecycleSecretFilePaths(this.workspaceRoot, this.space, name, material.lifecycleUid);
      // From here the host holds a grant at that uid.
      opts.onEnrolled?.({ owner: material.owner, lifecycleUid: material.lifecycleUid, files });
      if (files.actorToken !== staged.actorToken) {
        await secrets.put(agentSecretKeyForFile(files.actorToken, this.space), actorToken);
        await materializeSecretToFile(secrets, agentSecretKeyForFile(files.actorToken, this.space), files.actorToken);
        await secrets.delete(agentSecretKeyForFile(staged.actorToken, this.space));
        rmSync(staged.actorToken, { force: true });
      }
      await secrets.put(agentSecretKeyForFile(files.sentinelCreds, this.space), material.sentinelCreds);
      await materializeSecretToFile(secrets, agentSecretKeyForFile(files.sentinelCreds, this.space), files.sentinelCreds);
      rmSync(files.health, { force: true }); // a fresh start opens a fresh health window
      const bearerCmd = [
        ...this.deps.bearerEntryArgv(),
        provider.agentBearerCommand,
        // The signerless arm: the pinned public exchange, never a local state dir.
        "--exchange-url", material.agentBearerExchangeUrl,
        "--space", this.space,
        "--owner", material.owner,
        "--actor", name,
        "--token-file", files.actorToken,
        "--health-file", files.health,
      ];
      await runAgentBearer(bearerCmd);
      if (pending) await secrets.delete(pending.key);
      return {
        owner: material.owner,
        lifecycleUid: material.lifecycleUid,
        files,
        launch: { owner: material.owner, actor: name, sentinelCredsPath: files.sentinelCreds, bearerCmd },
        enrolled: { material, actorToken },
      };
    } catch (e) {
      // Remove launch-file materializations, but retain the pending token and request when the
      // host may have committed. The next same-authority spawn replays that enrollment.
      // A failed removal joins the refusal instead of throwing, so every removal is attempted and
      // the refusal still reaches the caller.
      const unshredded: CleanupFailure[] = [];
      for (const family of files.actorToken === staged.actorToken ? [staged] : [staged, files])
        await this.deps.shredUserSecrets(unshredded, family);
      const rejected = material === undefined ? caughtEnvelope(e) : undefined;
      // Only a first, definitively refused request proves there was no earlier commit. A refusal
      // during replay cannot prove that an earlier unanswered attempt enrolled nothing.
      const discard = pending?.created && (!sent || rejected?.outcome === "not-executed");
      if (discard && pending) {
        const key = pending.key;
        await attemptCleanup(unshredded, "pending enrollment", () => secrets.delete(key));
      }
      const retained = pending && !discard;
      const leftover = unshredded.length ? `; cleanup failed: ${describeCleanupFailures(unshredded)}` : "";
      const remedy = retained ? `; the name "${name}" is held by this manager's earlier enrollment. Retry this persona with the same caller to replay it. Once it launches, stop it before changing its authority` : "";
      const refusal = !retained && material === undefined && !unshredded.length ? rejected : undefined;
      return {
        error: `agent auth preflight failed for "${name}": ${rejectionText(e)}${leftover}${remedy}`,
        ...(refusal?.outcome === "not-executed" ? { refused: refusal.code, ...(refusal.details ? { details: refusal.details } : {}) } : {}),
      };
    }
  }

  /** This manager's registry record for its space, which pins the broker and IdP a delegated seat's
   *  handoff carries. It must pin the exchange the host enrolls against, or the child would register
   *  a mesh whose bearers come from somewhere else. */
  delegatedMeshRecord(): MeshEntry & { userAuth: UserAuthInfo } {
    const record = loadMeshes().find((m) => m.space === this.space);
    if (!record?.userAuth)
      throw new Error(`a delegated seat needs this manager's user-mode registry record for space "${this.space}", and there is none`);
    if (record.userAuth.endpoints?.url !== this.remoteAuthority?.agentBearerExchangeUrl)
      throw new Error(`the registry record for space "${this.space}" pins a different exchange than the host's agentBearerExchangeUrl`);
    return record as MeshEntry & { userAuth: UserAuthInfo };
  }

  /** The one handoff a delegated seat receives, built from values this manager holds: the
   *  enrollment result, the token it generated, and its own registry record. No path crosses. */
  composeManagedHandoff(enrolled: ManagedEnrollment, actorToken: string): ManagedLifecycleHandoff {
    const record = this.delegatedMeshRecord();
    if (enrolled.agentBearerExchangeUrl !== record.userAuth.endpoints?.url)
      throw new Error(`the host enrolled "${enrolled.actor}" against a different exchange than this manager's registry record pins`);
    const { url, issuer, audience } = record.userAuth.idp;
    return {
      kind: MANAGED_HANDOFF_KIND,
      space: this.space,
      owner: enrolled.owner,
      actor: enrolled.actor,
      lifecycleUid: enrolled.lifecycleUid,
      server: record.server,
      tlsRequired: record.tlsRequired === true,
      authProvider: record.userAuth.provider,
      idp: { url, issuer, audience },
      exchangeUrl: enrolled.agentBearerExchangeUrl,
      sentinelCreds: enrolled.sentinelCreds,
      actorToken,
      subscribe: enrolled.subscribe,
      allowSubscribe: enrolled.allowSubscribe,
      allowPublish: enrolled.allowPublish,
      ...(record.policy ? { policy: record.policy } : {}),
    };
  }
}
