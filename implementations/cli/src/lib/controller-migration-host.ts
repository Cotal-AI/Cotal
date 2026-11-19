import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { canonicalJson } from "@cotal-ai/core";
import {
  assertMaintenanceLock, CommandFailure, decodeLocalJson, homeCotalDir, localRecordObject,
  readLocalRecordSource, readMaintenanceJournal, type MaintenanceLock, type ProcessIdentityRecord,
} from "@cotal-ai/workspace";
import { readLocalServiceCensus } from "./service-census.js";
import { serviceDefinitionStore } from "./service-definitions.js";
import { observeServiceProcess, processServiceHost, serviceInstances, serviceInstanceStore } from "./service-instances.js";
import { retainedStopRequest } from "./service-process.js";
import { readStackJournal, STACK_ADAPTER, STACK_DEFINITION, stackRecoveryHost, stackScopeRefusals, type StackRole } from "./stack-journal.js";
import { readStoreIdentity, type StoreIdentity } from "./store-identity.js";

export interface ControllerMigrationHost {
  format: "cotal-controller-migration-host/v1";
  root: string;
  space: string;
  server: string;
  mode: "auth" | "user";
  home: string;
  host: string;
  stack: { operationId: string; sha256: string };
  store: StoreIdentity;
  brokerConfig: { path: string; bytes: number; sha256: string; launchReceiptSha256: string };
  members: Array<{
    role: StackRole; definition: string; definitionRevision: string; definitionSha256: string;
    instanceId: string; instanceRevision: string; instanceSha256: string; launchRequestId: string;
    process: ProcessIdentityRecord;
  }>;
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function refuse(message: string): never { throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", message); }

/** Observe the running direct controller identities before a migration's first effect. The root
 * lock and each definition lock bracket the read; records, process pins, store and configuration
 * are read again before return. This is not writer exclusion, a software/secret capture, a native
 * account census or stop authority. The coordinator must journal it and recheck before effects. */
export function observeControllerMigrationHost(lock: MaintenanceLock): ControllerMigrationHost {
  assertMaintenanceLock(lock);
  if (process.platform !== "linux") throw new CommandFailure("refused", "UNSUPPORTED", "controller migration host custody currently requires Linux");
  if (readMaintenanceJournal(lock.root)) refuse("another maintenance attempt already holds this root; no new host binding was inferred");
  const initial = readStackJournal(lock.root);
  if (!initial) refuse("controller migration needs a controller-owned root");
  const journal = initial.journal;
  if (journal.mode === "open") throw new CommandFailure("refused", "UNSUPPORTED", "controller migration requires an authenticated account fence");
  if (journal.operation.kind !== "up" || journal.operation.phase !== "completed" || journal.operation.withAgents)
    refuse("controller migration needs a settled running stack before its first effect");
  if (journal.recovery?.home !== resolve(homeCotalDir()) || journal.recovery.host !== stackRecoveryHost())
    refuse("controller migration requires the original controller home and execution host");
  if (!journal.broker?.storeIdentity) refuse("controller migration requires the store identity recorded by the broker launch");
  const expectedRoles = journal.mode === "user" ? ["broker", "auth", "delivery", "manager"] : ["broker", "delivery", "manager"];
  const active = journal.members.filter(member => member.instanceId !== null);
  if (active.map(member => member.role).join(",") !== expectedRoles.join(",") ||
      active.some(member => member.replacement || !["started", "reused"].includes(member.state)))
    refuse("controller migration requires every applicable member at its settled original instance");
  stackScopeRefusals(journal, "`cotal down --preserve-state`");
  const census = readLocalServiceCensus(journal.space);
  if (census.supervisors.length || census.nativeAttempts.length)
    throw new CommandFailure("refused", "UNSUPPORTED", "controller migration has no custody for recorded supervisors or native unit attempts");
  if (census.serviceDefinitions.length !== active.length || census.serviceRecords.length !== active.length ||
      census.serviceDefinitions.some(row => !active.some(member => member.definition === row.name)))
    throw new CommandFailure("refused", "UNSUPPORTED", "controller migration cannot omit additional service definitions or instance records");
  const definitions = serviceDefinitionStore(journal.space), instances = serviceInstanceStore(journal.space);
  const pins: Array<{ check(): void; release(): void }> = [];
  try {
    const members = active.map(member => {
      const definition = definitions.read(member.definition), instance = instances.read(member.instanceId!);
      if (!definition || !instance) refuse("a controller member disappeared during host observation");
      pins.push(definitions.pin(definition));
      const value = instance.record.value, launch = definition.record.value.launch;
      if (definition.name !== STACK_DEFINITION[member.role] || launch.type !== "adapter" || launch.adapter !== STACK_ADAPTER[member.role] ||
          launch.options.root !== journal.root || definition.record.value.root !== undefined && definition.record.value.root !== journal.root || value.definition !== definition.name ||
          value.definitionRevision !== definition.record.revision || value.state !== "running" || !value.process ||
          canonicalJson(value.host) !== canonicalJson(processServiceHost()) || observeServiceProcess(value) !== "running" ||
          value.supervisorInvocationId || value.custody || retainedStopRequest(value))
        refuse("a controller member is not the current directly owned running launch of its definition");
      if (member.process && canonicalJson(member.process) !== canonicalJson(value.process))
        refuse("the controller journal and member record disagree on process identity");
      return {
        role: member.role, definition: definition.name, definitionRevision: definition.record.revision, definitionSha256: definition.hash,
        instanceId: value.instanceId, instanceRevision: instance.record.revision, instanceSha256: instance.hash,
        launchRequestId: value.launchRequestId, process: { ...value.process },
      };
    });
    const broker = members.find(member => member.role === "broker")!;
    const definition = definitions.read(broker.definition)!;
    const launch = definition.record.value.launch;
    if (launch.type !== "adapter" || typeof launch.options.config !== "string") refuse("the controller broker has no declared configuration file");
    const path = launch.options.config;
    const receiptPath = join(instances.directory()!, `.broker-launch-${broker.launchRequestId}.json`);
    const receiptBytes = readLocalRecordSource(receiptPath, 4096, true);
    if (!receiptBytes) refuse("the controller broker's launch receipt is missing");
    const receipt = localRecordObject(decodeLocalJson(receiptBytes), ["instanceId", "launchRequestId", "root", "server", "configSha256"]);
    if (Object.keys(receipt).length !== 5 || receipt.instanceId !== broker.instanceId || receipt.launchRequestId !== broker.launchRequestId ||
        receipt.root !== journal.root || receipt.server !== journal.server || typeof receipt.configSha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.configSha256))
      refuse("the controller broker launch receipt does not bind this root, address and incarnation");
    const config = readLocalRecordSource(path, 1024 * 1024, true);
    if (!config || hash(config) !== receipt.configSha256) refuse("the controller broker configuration differs from its recorded launch bytes");
    const store = readStoreIdentity(journal.broker.storeDir);
    if (canonicalJson(store) !== canonicalJson(journal.broker.storeIdentity)) refuse("the controller broker store differs from its recorded directory identity");
    for (const pin of pins) pin.check();
    for (const member of members) {
      const current = instances.read(member.instanceId);
      if (!current || current.hash !== member.instanceSha256 || current.record.revision !== member.instanceRevision || observeServiceProcess(current.record.value) !== "running")
        refuse("a controller member changed during host observation");
    }
    const configAgain = readLocalRecordSource(path, 1024 * 1024, true), receiptAgain = readLocalRecordSource(receiptPath, 4096, true);
    if (!configAgain || !config.equals(configAgain) || !receiptAgain || !receiptBytes.equals(receiptAgain) ||
        canonicalJson(readStoreIdentity(journal.broker.storeDir)) !== canonicalJson(store) || readStackJournal(lock.root)?.sha256 !== initial.sha256 ||
        canonicalJson(readLocalServiceCensus(journal.space)) !== canonicalJson(census) || serviceInstances(journal.space).length !== members.length)
      refuse("controller host inputs changed during observation");
    stackScopeRefusals(journal, "`cotal down --preserve-state`");
    assertMaintenanceLock(lock);
    return {
      format: "cotal-controller-migration-host/v1", root: journal.root, space: journal.space, server: journal.server, mode: journal.mode,
      home: journal.recovery.home, host: journal.recovery.host, stack: { operationId: journal.operation.id, sha256: initial.sha256 },
      store, brokerConfig: { path, bytes: config.length, sha256: hash(config), launchReceiptSha256: hash(receiptBytes) }, members,
    };
  } finally { for (const pin of pins.reverse()) pin.release(); }
}
