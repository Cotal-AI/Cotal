/** Controller-custody restore. A
 *  same-path restore keeps the broker definition and its configuration. An alternate restore rewrites
 *  only the definition's `options.config` to an attempt-owned copy whose JetStream store names the
 *  target, journaling each step before the definition write it names, so a crash is attributed from
 *  the journal and never guessed. Rollback reverses that rewrite before the store rollback, and the
 *  cut's retired broker record is removed only once the attempt's new broker is active. */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { brokerJetStreamBlock, writeSecretFileCreateOnly } from "@cotal-ai/core";
import {
  CommandFailure, assertRestoreClaimRollbackable, cutController, decodeLocalJson, readLocalRecordSource,
  readMaintenanceJournal, recordRestoreReconfiguration, rollbackRestore, serviceMetadataDigest,
  type ControllerCutBinding, type ControllerReconfiguration, type ControllerStop, type JsonValue, type MaintenanceLock,
  type MaintenanceReadyRecord, type RestoreReadyRecord, type RollbackRestoreOptions,
} from "@cotal-ai/workspace";
import { assertControllerCoupling, assertControllerResumeEligible } from "./controller-resume.js";
import { serviceDefinitionStore, type ServiceDefinitionSnapshot } from "./service-definitions.js";
import { observeServiceProcess, serviceInstanceStore } from "./service-instances.js";
import { assertNoServiceUnitAttempts } from "./service-process.js";

const CONFIG_LIMIT = 1024 * 1024;

function refuse(code: ConstructorParameters<typeof CommandFailure>[1], message: string, target: unknown, remedy?: string): never {
  throw new CommandFailure("refused", code, message, { target, ...(remedy ? { remedy } : {}) });
}

function hold(message: string, target: unknown, remedy?: string): never {
  throw new CommandFailure("unknown", "OPERATION_UNKNOWN", message, { target, ...(remedy ? { remedy } : {}) });
}

function fileSha256(path: string): string | undefined {
  const bytes = readLocalRecordSource(path, CONFIG_LIMIT);
  return bytes ? createHash("sha256").update(bytes).digest("hex") : undefined;
}

type BrokerOptions = { readonly config: string; readonly [key: string]: JsonValue };

function brokerOptions(definition: ServiceDefinitionSnapshot): BrokerOptions {
  const launch = definition.record.value.launch;
  if (launch.type !== "adapter" || launch.adapter !== "nats-broker" || typeof launch.options.config !== "string")
    return refuse("CONFLICT", "the cut's broker definition is not a nats-broker adapter launch with a configuration path; nothing was restored", { definition: definition.name });
  return launch.options as BrokerOptions;
}

function brokerMember(cut: ControllerCutBinding) {
  return cut.members.find((member) => member.role === "broker")!;
}

/** The configuration digest the cut's broker launch recorded in its create-only launch receipt. */
function launchConfigSha256(space: string, cut: ControllerCutBinding): string {
  const member = brokerMember(cut);
  const directory = serviceInstanceStore(space).directory();
  const bytes = directory ? readLocalRecordSource(join(directory, `.broker-launch-${member.launchRequestId}.json`), 4096, true) : undefined;
  const receipt = bytes ? decodeLocalJson(bytes) as Record<string, unknown> : undefined;
  if (!receipt || typeof receipt !== "object" || Object.keys(receipt).length !== 5 || receipt.instanceId !== member.instanceId ||
      receipt.launchRequestId !== member.launchRequestId || typeof receipt.configSha256 !== "string" || !/^[0-9a-f]{64}$/.test(receipt.configSha256))
    return hold("the cut broker's launch receipt is missing or does not name its cut launch; its configuration identity is unknown", { space, instanceId: member.instanceId });
  return receipt.configSha256;
}

/** Broker coupling for backup and restore: the live broker definition is the revision
 *  the cut expects, and the configuration it names hashes to the cut launch's recorded digest. */
export function assertControllerBrokerConfig(space: string, cut: ControllerCutBinding): { definition: ServiceDefinitionSnapshot; options: BrokerOptions; configSha256: string } {
  const member = brokerMember(cut);
  const definition = serviceDefinitionStore(space).read(member.definition);
  if (!definition || definition.record.revision !== cut.brokerDefinitionRevision)
    refuse("CONFLICT", "the broker definition is not at the revision the cut expects; nothing was changed", { space, definition: member.definition });
  const options = brokerOptions(definition!);
  const configSha256 = launchConfigSha256(space, cut);
  if (fileSha256(options.config) !== configSha256)
    refuse("CONFLICT", "the broker configuration no longer hashes to the cut launch's recorded configuration; nothing was changed", { space, config: options.config });
  return { definition: definition!, options, configSha256 };
}

/** Preflight for `backup restore` and `up --restore` on a controller cut, before
 *  staging, a claim or any store move: the cut is coupled and eligible, its broker configuration is
 *  the cut launch's, and an alternate target needs one exact JetStream block to rewrite. */
export function assertControllerRestorable(root: string, journal: MaintenanceReadyRecord, cut: ControllerCutBinding, storeDir: string | undefined): void {
  const stack = assertControllerCoupling(root, cut, journal.cut.launch.server, journal.source.path);
  assertControllerResumeEligible(journal.space, cut, journal.cutCompletion.controllerStops ?? [], cut.brokerDefinitionRevision);
  const { options } = assertControllerBrokerConfig(journal.space, cut);
  if (storeDir !== undefined && resolve(storeDir) !== journal.source.path) jetStreamRewrite(options.config, journal.source.path, stack.broker?.maxFileStore);
}

/** Core's own JetStream block for the source store must occur once in the configuration. */
function jetStreamRewrite(config: string, sourcePath: string, maxFileStore: number | undefined): { text: string; block: string } {
  const bytes = readLocalRecordSource(config, CONFIG_LIMIT);
  if (!bytes) return refuse("TARGET_UNAVAILABLE", "the broker configuration is missing; nothing was restored", { config });
  const text = bytes.toString("utf8");
  const block = brokerJetStreamBlock(sourcePath, maxFileStore);
  const count = text.split(block).length - 1;
  if (count !== 1)
    refuse("CONFLICT", `the broker configuration holds ${count} copies of the JetStream block for the preserved store, not one; an alternate-target restore cannot rewrite it`, { config });
  return { text, block };
}

/** Rewrite the broker definition before commit intent and under the maintenance lock. The rendered
 *  configuration is written create-only and journaled with its inode as `rendered` before the
 *  definition write; `definition-committed` follows the write. A crash between the file and its
 *  record leaves an unreferenced file named for the attempt. */
export function reconfigureControllerBroker(lock: MaintenanceLock): void {
  const record = readMaintenanceJournal(lock.root);
  const cut = record ? cutController(record.cut) : undefined;
  if (!record || record.state !== "restore-ready" || !cut || record.restore.method !== "alternate" || !record.restore.target || record.restore.controllerReconfiguration)
    return hold("the alternate controller restore is not at a bound target with no recorded reconfiguration; the broker definition was not changed", { root: lock.root });
  const stack = assertControllerCoupling(lock.root, cut, record.cut.launch.server, record.source.path);
  assertControllerResumeEligible(record.space, cut, record.cutCompletion.controllerStops ?? [], cut.brokerDefinitionRevision);
  const { definition, options, configSha256 } = assertControllerBrokerConfig(record.space, cut);
  const { text, block } = jetStreamRewrite(options.config, record.source.path, stack.broker?.maxFileStore);
  if (createHash("sha256").update(text, "utf8").digest("hex") !== configSha256)
    refuse("CONFLICT", "the broker configuration changed while it was read; the broker definition was not changed", { config: options.config });
  const rendered = text.split(block).join(brokerJetStreamBlock(record.restore.targetPath, stack.broker?.maxFileStore));
  const toConfigPath = join(dirname(options.config), `server.restore-${record.restore.attemptId}.conf`);
  writeSecretFileCreateOnly(toConfigPath, rendered);
  const stat = lstatSync(toConfigPath, { bigint: true });
  const reconfiguration: ControllerReconfiguration = {
    fromRevision: definition.record.revision, fromOptionsSha256: serviceMetadataDigest(options), fromConfigPath: options.config,
    fromConfigSha256: configSha256, toConfigPath, toConfigSha256: createHash("sha256").update(rendered, "utf8").digest("hex"),
    toStoreIdentity: record.restore.target, phase: "rendered",
  };
  recordRestoreReconfiguration(lock, reconfiguration, { label: "config", path: toConfigPath, dev: stat.dev.toString(), ino: stat.ino.toString() });
  const saved = serviceDefinitionStore(record.space).commit(definition.name, definition, {
    ...definition.record.value, launch: { ...definition.record.value.launch, options: { ...options, config: toConfigPath } } as typeof definition.record.value.launch,
  })!;
  recordRestoreReconfiguration(lock, { ...reconfiguration, toRevision: saved.revision, phase: "definition-committed" });
}

/** A live definition revision is attributed to a journaled write only when its options name that
 *  exact configuration path, the file still hashes to the journaled digest, and every other option
 *  is the one the rewrite started from. */
function attributable(definition: ServiceDefinitionSnapshot, reconfiguration: ControllerReconfiguration, config: "to" | "from"): boolean {
  const options = brokerOptions(definition);
  const [path, sha] = config === "to" ? [reconfiguration.toConfigPath, reconfiguration.toConfigSha256] : [reconfiguration.fromConfigPath, reconfiguration.fromConfigSha256];
  return options.config === path && fileSha256(path) === sha &&
    serviceMetadataDigest({ ...options, config: reconfiguration.fromConfigPath }) === reconfiguration.fromOptionsSha256;
}

/** Pre-commit rollback for every restore. A controller alternate restore first returns its broker
 *  definition to the source configuration, as a new revision that the cut then expects, and only
 *  then rolls the store back. The live claim is checked before any definition write. Any revision
 *  the journal cannot attribute holds and nothing is overwritten.
 *
 *  The rebound revision is never written into the cut's retired broker record. The next resume or
 *  restore starts a new broker instance at that revision, journaled first, and removes the retired
 *  record once the attempt is active. */
export function rollbackRestoreWithBroker(lock: MaintenanceLock, options: RollbackRestoreOptions = {}): MaintenanceReadyRecord {
  const initial = readMaintenanceJournal(lock.root);
  if (initial?.state !== "restore-ready" || !initial.restore.controllerReconfiguration) return rollbackRestore(lock, options);
  assertRestoreClaimRollbackable(lock, initial, options);
  let record: RestoreReadyRecord = initial;
  const cut = cutController(record.cut)!;
  const space = record.space;
  const name = brokerMember(cut).definition;
  const read = () => serviceDefinitionStore(space).read(name) ?? hold("the broker definition disappeared during a restore rollback; nothing was overwritten", { space, definition: name });
  const target = { root: lock.root, attemptId: record.restore.attemptId };
  for (;;) {
    const reconfiguration: ControllerReconfiguration = record.restore.controllerReconfiguration!;
    const live = read();
    if (reconfiguration.phase === "rendered") {
      if (live.record.revision === reconfiguration.fromRevision) break;
      if (!attributable(live, reconfiguration, "to"))
        hold("the broker definition changed to a revision this restore did not journal; nothing was overwritten", { ...target, liveRevision: live.record.revision });
      record = recordRestoreReconfiguration(lock, { ...reconfiguration, toRevision: live.record.revision, phase: "definition-committed" });
    } else if (reconfiguration.phase === "definition-committed") {
      if (live.record.revision !== reconfiguration.toRevision)
        hold("the broker definition is not the revision this restore wrote; nothing was overwritten", { ...target, liveRevision: live.record.revision });
      if (fileSha256(reconfiguration.fromConfigPath) !== reconfiguration.fromConfigSha256)
        hold("the source broker configuration no longer hashes to its recorded digest; the definition was not rolled back to it", { ...target, config: reconfiguration.fromConfigPath });
      record = recordRestoreReconfiguration(lock, { ...reconfiguration, phase: "rolling-back" });
    } else if (reconfiguration.phase === "rolling-back") {
      if (live.record.revision === reconfiguration.toRevision) {
        const next = { ...brokerOptions(live), config: reconfiguration.fromConfigPath };
        if (serviceMetadataDigest(next) !== reconfiguration.fromOptionsSha256)
          hold("the rewritten broker definition differs from its source in more than its configuration; nothing was overwritten", target);
        serviceDefinitionStore(space).commit(name, live, { ...live.record.value, launch: { ...live.record.value.launch, options: next } as typeof live.record.value.launch });
        continue;
      }
      if (!attributable(live, reconfiguration, "from"))
        hold("the broker definition changed to a revision this rollback did not journal; nothing was overwritten", { ...target, liveRevision: live.record.revision });
      record = recordRestoreReconfiguration(lock, { ...reconfiguration, rollbackRevision: live.record.revision, phase: "rolled-back" });
    } else {
      if (live.record.revision !== reconfiguration.rollbackRevision)
        hold("the broker definition changed after its rollback was recorded; the store was not rolled back", { ...target, liveRevision: live.record.revision });
      break;
    }
  }
  return rollbackRestore(lock, { ...options, controllerDefinition: { liveRevision: read().record.revision } });
}

/** Once the attempt's new broker runs, remove only the
 *  cut's retired broker record, under the definition writer lock and by a CAS on the snapshot read
 *  there. It must still be the stopped cut launch with its own kernel-exit receipt equal to the
 *  journal row, gone, with no supervisor or native unit attempt. Absence is a completed removal. */
export function removeRetiredBrokerInstance(space: string, cut: ControllerCutBinding, stops: readonly ControllerStop[]): void {
  const member = brokerMember(cut);
  const stop = stops.find((row) => row.role === "broker");
  const definition = serviceDefinitionStore(space).read(member.definition);
  const target = { space, instanceId: member.instanceId };
  if (!definition || !stop) return hold("the retired broker record's definition or cut stop is missing; nothing was removed", target);
  const pinned = serviceDefinitionStore(space).pin(definition);
  try {
    const row = serviceInstanceStore(space).read(member.instanceId);
    if (!row) return;
    const value = row.record.value;
    if (value.launchRequestId !== member.launchRequestId || value.state !== "stopped" || value.kernelStop?.requestId !== stop.receipt.requestId ||
        !["gone", "previous-boot"].includes(observeServiceProcess(value)) || value.supervisorInvocationId !== undefined)
      refuse("LIFECYCLE_BLOCKED", "the retired broker record is no longer the stopped cut launch with its own kernel-exit receipt; nothing was removed", target,
        `cotal service status ${member.definition} --instance ${member.instanceId} --space ${space}`);
    assertNoServiceUnitAttempts(space, member.definition);
    pinned.check();
    serviceInstanceStore(space).commit(member.instanceId, row, undefined);
  } finally {
    pinned.release();
  }
}
