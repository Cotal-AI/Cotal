import {
  drainAndClose,
  dialerFor,
  mintCreds,
  newIdentity,
  setupSpaceStreams,
  removeIssuedStoresBeforeRetention,
  IssuedStoreBeforeRetentionError,
  IssuedStoreRecreateRefusal,
  recreateMembershipStore,
  membershipStoreDefinition,
  LEGACY_MEMBERSHIP_MAX_BYTES,
  MEMBERSHIP_MAX_VALUE_SIZE,
  ttlBuckets,
  standaloneConnectOpts,
  requireBrokerFloor,
  spaceDeletionStreams,
  isJetStreamMissing,
  seedChannelRegistry,
  ensureDefaultDeliveryClass,
  UndecodableRegistryEntry,
  type ChannelRegistryFile,
} from "@cotal-ai/core";
import { JetStreamApiCodes, jetstreamManager, StorageType } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { CommandFailure, authDir, getSpaceAuth, brokerAddressKey, canonicalRoot, codeSpan, loadMeshes, shellPath, workspaceSecretStore } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { cotalRoot } from "../lib/paths.js";
import { loadChannelsFile } from "../lib/channel-seed.js";
import { STACK_DEFINITION } from "../lib/stack-journal.js";
import { observeServiceProcess, serviceInstances } from "../lib/service-instances.js";

export function registeredAddressHolder(server: string, space: string) {
  const key = brokerAddressKey(server);
  if (key === undefined) return undefined;
  const root = canonicalRoot(cotalRoot());
  return loadMeshes().find((m) => m.space !== space && canonicalRoot(m.root) !== root && brokerAddressKey(m.server) === key);
}

/** Another folder's registration reserves its broker address whether or not a listener answers.
 *  Starting there would leave two registrations naming one broker:
 *  whichever stack runs answers for both, and the other one's `down` and reads reach it. Every
 *  start that names its own address asks this, a manifest's `broker.servers` included, and
 *  `elsewhere` names the way to move the one being started. A space this start takes the name of is
 *  left to the name rules. */
export function refuseRegisteredAddress(server: string, space: string, elsewhere: string): void {
  const held = registeredAddressHolder(server, space);
  if (!held) return;
  throw new CommandFailure("refused", "CONFLICT", `${server} is the broker address of "${held.space}", registered for ${held.root}; nothing was started`, {
    target: { root: cotalRoot(), server, space, heldSpace: held.space, heldBy: held.root },
    remedy: `${elsewhere}; check the other space with ${codeSpan(`cotal status --space ${shellPath(held.space)}`)}`,
  });
}

export function membershipConversionRefusal(space: string, remedy = "stop the stack with `cotal down --yes`, then run `cotal up --recreate-membership-store`"): CommandFailure {
  return new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the selected space has a legacy File-backed membership store; it was not changed while its broker or membership services may be in use", {
    target: { space }, remedy,
  });
}

export async function fileMembershipStore(server: string, space: string, creds?: string, stockOnly = false): Promise<boolean> {
  const nc = await dialerFor(server)({ servers: server, ...standaloneConnectOpts({ creds, tls: false }) });
  try {
    requireBrokerFloor(nc);
    const { config } = await (await jetstreamManager(nc)).streams.info(`KV_${membershipStoreDefinition(space).bucket}`);
    if (config.storage !== StorageType.File) return false;
    if (stockOnly && (![-1, LEGACY_MEMBERSHIP_MAX_BYTES].includes(config.max_bytes) || config.max_msgs_per_subject !== 1 || ![-1, MEMBERSHIP_MAX_VALUE_SIZE].includes(config.max_msg_size)))
      throw membershipConversionRefusal(space);
    return true;
  } catch (error) {
    if (isJetStreamMissing(error, JetStreamApiCodes.StreamNotFound)) return false;
    throw error;
  } finally { await drainAndClose(nc); }
}

/** Create or verify space infrastructure before any services start on this broker.
 * Only a fresh owned local boot may automatically replace its derived legacy membership feed. */
export async function postStart(
  server: string,
  space: string,
  setup?: { creds: string },
  seedFile?: ChannelRegistryFile,
  recreateIssuedStores?: string,
  recreateMembershipStore?: boolean,
  freshOwnedLocalBroker = false,
): Promise<void> {
  if (recreateIssuedStores !== undefined) await recreateIssuedStoresBeforeSetup(server, space, setup !== undefined, recreateIssuedStores);
  const legacyMembership = await fileMembershipStore(server, space, setup?.creds, recreateMembershipStore !== true);
  if (legacyMembership) {
    const running = serviceInstances(space).filter((row) => row.record.value.definition !== STACK_DEFINITION.broker).some((row) => !["gone", "previous-boot", "foreign-pid"].includes(observeServiceProcess(row.record.value)));
    if ((!freshOwnedLocalBroker && !recreateMembershipStore) || running) throw membershipConversionRefusal(space);
  }
  const convertMembership = legacyMembership && (freshOwnedLocalBroker || recreateMembershipStore === true);
  let recreateCreds: string | undefined;
  if (convertMembership && setup !== undefined) {
    const auth = await getSpaceAuth(workspaceSecretStore(cotalRoot()), space);
    if (!auth) throw new Error(`space "${space}" has no trust material under ${authDir(cotalRoot())}; its membership store was not touched`);
    recreateCreds = await mintCreds(auth, newIdentity(), "membership-store-recreate");
  }
  try {
    await setupSpaceStreams({
      servers: server,
      space,
      creds: setup?.creds,
      ...(convertMembership ? { recreateFileMembership: { creds: recreateCreds } } : {}),
    });
  } catch (error) {
    // Nothing of the stack runs yet, and the caller stops this broker again, so this is a refusal.
    if (error instanceof IssuedStoreBeforeRetentionError)
      throw new CommandFailure("refused", "CONFLICT", error.message, { target: { space, store: error.bucket }, remedy: `stop every other issuer and resolver of space ${space}, then add --recreate-issued-stores <backup-dir> to the \`cotal up\` that starts it` });
    throw error;
  }
  if (convertMembership) console.error(`Converted ${membershipStoreDefinition(space).bucket} from File to Memory; broker-sourced membership rebuilds on startup.`);
  try {
    if (seedFile) {
      await seedChannelRegistry({ servers: server, space, creds: setup?.creds, file: seedFile });
    }
    // SPEC §4: `defaults.deliveryClass` MUST be written at space creation so the effective default is
    // discoverable on the wire, never inferred from the `?? "durable"` resolution fallback. Auth mode
    // (`setup` present ⇒ the delivery daemon is up) is local/self-hosted ⇒ `durable`; open mode has no
    // daemon and is live-only ⇒ `live`. Runs after the seed so an explicit `channels.json` default wins.
    // A key that does not decode is not replaced by either write.
    await ensureDefaultDeliveryClass({
      servers: server,
      space,
      creds: setup?.creds,
      deliveryClass: setup ? "durable" : "live",
    });
  } catch (error) {
    if (!(error instanceof UndecodableRegistryEntry)) throw error;
    throw new CommandFailure("refused", "CONFLICT", error.message, { target: { space }, remedy: "read the key and replace the value; the bytes were left as they are" });
  }
}

/** `--recreate-issued-stores`: on the broker this boot just started, before any issuer or resolver
 *  of the space runs, back up and delete the space's issued-authority stores created before bounded
 *  retention, so the stream setup that follows creates them in the current shape. It runs the core
 *  step an embedder runs, on a one-shot `issued-store-recreate` credential minted from the root's
 *  trust; an open space uses its bare connection, as stream setup does. */
async function recreateIssuedStoresBeforeSetup(server: string, space: string, authenticated: boolean, backupDir: string): Promise<void> {
  let creds: string | undefined;
  let inboxPrefix = "_INBOX";
  if (authenticated) {
    const auth = await getSpaceAuth(workspaceSecretStore(cotalRoot()), space);
    if (!auth) throw new Error(`space "${space}" has no trust material under ${authDir(cotalRoot())}; its issued-authority stores were not touched`);
    const identity = newIdentity();
    creds = await mintCreds(auth, identity, "issued-store-recreate");
    inboxPrefix = `_INBOX_${identity.id}`;
  }
  const nc = await dialerFor(server)({ servers: server, ...standaloneConnectOpts({ creds, tls: false }), inboxPrefix });
  let removed;
  try {
    removed = await removeIssuedStoresBeforeRetention(nc, { space, backupDir, inboxPrefix });
  } catch (error) {
    if (error instanceof IssuedStoreRecreateRefusal)
      throw new CommandFailure("refused", error.reason === "nothing-to-recreate" ? "CONFLICT" : "USAGE_INVALID", error.message, { target: { space, backupDir }, remedy: error.reason === "nothing-to-recreate" ? "start the space without --recreate-issued-stores" : "name a directory that does not exist yet, inside one that does" });
    throw error;
  } finally {
    await drainAndClose(nc);
  }
  for (const store of removed) console.log(`→ backed up ${store.stream} (${store.messages} messages) to ${store.backup}, then deleted it`);
  console.log(c.dim("• the issued-authority stores are created again in the current shape; every generation issued before the upgrade is refused from now on"));
}

/** A resume or restore skips `postStart` because the preserved store already holds every canonical
 *  stream. A memory-backed bucket is the exception: the broker stop that preserved the store emptied
 *  it, stream and all (#1356 made presence memory-backed). Recreate those, and only those, from the
 *  same `ttlBuckets` list `setupSpaceStreams` creates them from, before any daemon opens them.
 *  Only an ordinary resume that just started this listener may opt into replacing a File feed.
 *  An explicit seed on an ordinary resume patches the preserved channel registry. */
export async function recreateMemoryBuckets(server: string, space: string, setup?: { creds: string }, ownedResume?: { convertMembership: boolean }, seed?: ChannelRegistryFile): Promise<void> {
  const legacy = await fileMembershipStore(server, space, setup?.creds);
  if (legacy) {
    if (!ownedResume?.convertMembership) throw membershipConversionRefusal(space, ownedResume && "retry this preserved resume with `cotal up --recreate-membership-store`");
    const running = serviceInstances(space).filter((row) => row.record.value.definition !== STACK_DEFINITION.broker).some((row) => !["gone", "previous-boot", "foreign-pid"].includes(observeServiceProcess(row.record.value)));
    if (running) throw membershipConversionRefusal(space, "stop the remaining membership services, then retry the preserved resume with `cotal up --recreate-membership-store`");
    try {
      const auth = setup && await getSpaceAuth(workspaceSecretStore(cotalRoot()), space);
      if (setup && !auth) throw new Error(`space "${space}" has no trust material under ${authDir(cotalRoot())}`);
      await recreateMembershipStore({
        servers: server, space, provisionerCreds: setup?.creds,
        recreateCreds: auth ? await mintCreds(auth, newIdentity(), "membership-store-recreate") : undefined,
      });
    } catch (error) {
      throw new CommandFailure("failed", "OPERATION_FAILED", `could not convert the preserved membership store: ${(error as Error).message}`, {
        target: { space }, remedy: "fix the reported cause, then retry this preserved resume with `cotal up --recreate-membership-store`",
      });
    }
    console.error(`Converted ${membershipStoreDefinition(space).bucket} from File to Memory; broker-sourced membership rebuilds on startup.`);
  }
  const nc = await dialerFor(server)({ servers: server, ...standaloneConnectOpts({ creds: setup?.creds, tls: false }) });
  try {
    requireBrokerFloor(nc);
    const kvm = new Kvm(nc);
    for (const [bucket, ttl, storage] of ttlBuckets(space))
      if (storage === StorageType.Memory) await kvm.create(bucket, { ttl, storage });
    if (!legacy) {
      const membership = membershipStoreDefinition(space);
      await kvm.create(membership.bucket, membership.createOptions);
    }
  } finally {
    await drainAndClose(nc);
  }
  if (seed) await seedChannelRegistry({ servers: server, space, creds: setup?.creds, file: seed });
}

/** An adopted listener may have been bound by an `up` that stopped before {@link recreateMemoryBuckets},
 *  so the memory buckets the daemons open can be missing on it. An existing bucket is left as it is. */
export async function recreateAdoptedMemoryBuckets(root: string, space: string, server: string, mode: "open" | "auth" | "user", channels?: string): Promise<void> {
  const seed = channels ? loadChannelsFile(root, channels, false) : undefined;
  if (mode === "open") return recreateMemoryBuckets(server, space, undefined, undefined, seed);
  const auth = await getSpaceAuth(workspaceSecretStore(root), space);
  if (!auth) throw new Error(`space "${space}" has no trust material under ${authDir(root)}; cannot recreate its memory buckets on the adopted listener`);
  await recreateMemoryBuckets(server, space, { creds: await mintCreds(auth, newIdentity(), "provisioner") }, undefined, seed);
}

/** `cotal space delete` removes a space's streams from a broker that keeps running. When a stack
 *  reuses that broker and every canonical stream of the space is gone, create them again, empty, as
 *  a broker start does, and return true. A broker that still holds any of them is left as it is. */
export async function recreateDeletedStreams(opts: { root: string; space: string; server: string; mode: "open" | "auth" | "user"; readSeed: () => ChannelRegistryFile | undefined }): Promise<boolean> {
  let setup: { creds: string } | undefined;
  if (opts.mode !== "open") {
    const auth = await getSpaceAuth(workspaceSecretStore(opts.root), opts.space);
    if (!auth) throw new Error(`space "${opts.space}" has no trust material under ${authDir(opts.root)}; cannot read its streams on the running broker`);
    setup = { creds: await mintCreds(auth, newIdentity(), "provisioner") };
  }
  if (await fileMembershipStore(opts.server, opts.space, setup?.creds)) throw membershipConversionRefusal(opts.space);
  if (opts.mode === "user") return false; // User-auth running stacks retain their existing stream lifecycle.
  const nc = await dialerFor(opts.server)({ servers: opts.server, ...standaloneConnectOpts({ creds: setup?.creds, tls: false }) });
  let held = false;
  try {
    requireBrokerFloor(nc);
    const jsm = await jetstreamManager(nc);
    for (const name of spaceDeletionStreams(opts.space)) {
      try {
        await jsm.streams.info(name);
        held = true;
        break;
      } catch (error) {
        if (!isJetStreamMissing(error, JetStreamApiCodes.StreamNotFound)) throw error;
      }
    }
  } finally {
    await drainAndClose(nc);
  }
  if (held) return false;
  await postStart(opts.server, opts.space, setup, opts.readSeed());
  return true;
}
