import { resolve } from "node:path";
import { assertRecordIdentity, brokerAddressKey, canonicalRoot, homeCotalDir, protectedLocalDirectory, readBrokerPolicy } from "@cotal-ai/workspace";
import { serviceDefinitionStore } from "./service-definitions.js";
import { observeServiceProcess, serviceInstanceStore } from "./service-instances.js";
import { readStackJournal, stackMaintenanceFence, stackRecoveryHost, stackScopeRefusals, STACK_ADAPTER, STACK_DEFINITION } from "./stack-journal.js";
import { shellWord } from "./endpoint-errors.js";

export interface RecordedStackRemedy {
  readonly root: string;
  readonly commands: readonly string[];
}

/** Read-only evidence for a manual remedy. Any missing proof keeps the unknown-host report. */
export function recordedStackRemedy(root: string | undefined, space: string, server: string, manager: { instanceId?: unknown; lifecycleUid?: unknown }): RecordedStackRemedy | undefined {
  if (!root || typeof manager.instanceId !== "string") return undefined;
  try {
    if ([root, space, server].some(value => /[\u0000-\u001f\u007f]/u.test(value))) return undefined;
    const physical = canonicalRoot(root);
    if (physical !== resolve(root)) return undefined;
    protectedLocalDirectory(physical, "the recorded stack root");
    const snapshot = readStackJournal(physical);
    if (!snapshot) return undefined;
    const journal = snapshot.journal;
    if (journal.space !== space || brokerAddressKey(journal.server) !== brokerAddressKey(server) || journal.operation.kind !== "up" || journal.operation.phase !== "completed" ||
        journal.recovery?.home !== resolve(homeCotalDir()) || journal.recovery.host !== stackRecoveryHost() || stackMaintenanceFence(physical, journal).fenced) return undefined;
    const definitions = serviceDefinitionStore(space), instances = serviceInstanceStore(space);
    const observed: { instance: string; revision: string; definition: string; definitionRevision: string }[] = [];
    let options: Readonly<Record<string, unknown>> | undefined;
    for (const member of journal.members) {
      if (member.state === "not-attempted" && member.instanceId === null) continue;
      if (!member.instanceId || !["started", "reused"].includes(member.state) || member.replacement || !member.process) return undefined;
      const instance = instances.read(member.instanceId), definition = definitions.read(member.definition);
      if (!instance || !definition) return undefined;
      const value = instance.record.value, saved = definition.record.value;
      if (value.instanceId !== member.instanceId || value.definition !== member.definition || value.space !== space || value.state !== "running" || value.foreground || value.supervisorInvocationId ||
          value.definitionRevision !== definition.record.revision || value.process?.pid !== member.process.pid || value.process.token !== member.process.token || observeServiceProcess(value) !== "running" ||
          saved.space !== space || saved.root !== undefined && saved.root !== physical || saved.launch.type !== "adapter" || saved.launch.adapter !== STACK_ADAPTER[member.role] || saved.launch.options.root !== physical ||
          saved.launch.options.server !== undefined && brokerAddressKey(String(saved.launch.options.server)) !== brokerAddressKey(journal.server)) return undefined;
      if (member.role === "manager") {
        const ready = value.adapterReadiness;
        if (member.definition !== STACK_DEFINITION.manager || ready?.evidence !== "local-process-receipt" || ready.native?.instanceId !== manager.instanceId ||
            manager.lifecycleUid !== undefined && ready.native.lifecycleUid !== manager.lifecycleUid || assertRecordIdentity(value.process).kind !== "match") return undefined;
        options = saved.launch.options;
      }
      observed.push({ instance: member.instanceId, revision: instance.record.revision, definition: member.definition, definitionRevision: definition.record.revision });
    }
    if (!options || typeof options.runtime !== "string" || !options.runtime || Object.keys(options).some(key => !["root", "runtime", "server", "max-sessions", "console-host", "ws-port"].includes(key))) return undefined;
    if (/[\u0000-\u001f\u007f]/u.test(options.runtime) || options["max-sessions"] !== undefined && (!Number.isSafeInteger(options["max-sessions"]) || Number(options["max-sessions"]) <= 0)) return undefined;
    if (options["console-host"] !== undefined && options["console-host"] !== journal.broker?.host) return undefined;
    stackScopeRefusals(journal, "the recorded stack's manual cold update");
    const words = ["cotal", "up", "--detach", "--space", space, "--server", journal.server, "--runtime", options.runtime];
    const add = (flag: string, value: unknown) => { if (value !== undefined) words.push(`--${flag}`, String(value)); };
    add("max-sessions", options["max-sessions"]);
    if (journal.mode === "open") words.push("--open");
    if (journal.mode === "user") words.push("--user-auth");
    if (journal.broker) {
      const broker = journal.broker;
      add("store-dir", broker.storeDir); add("host", broker.host); add("max-file-store", broker.maxFileStore);
      add("log-file", broker.logFile); add("logfile-size-limit", broker.logfileSizeLimit); add("logfile-max-num", broker.logfileMaxNum);
    }
    const policy = readBrokerPolicy(physical);
    add("auth-timeout", policy?.authTimeout); add("max-payload", policy?.maxPayload); add("account-resolver", policy?.accountResolver);
    if (readStackJournal(physical)?.sha256 !== snapshot.sha256 || observed.some(row => instances.read(row.instance)?.record.revision !== row.revision || definitions.read(row.definition)?.record.revision !== row.definitionRevision)) return undefined;
    for (const member of journal.members) if (member.process && assertRecordIdentity(member.process).kind !== "match") return undefined;
    const atRoot = `cd ${shellWord(physical)} && `;
    return { root: physical, commands: [
      `${atRoot}cotal down --yes --with-agents --space ${shellWord(space)}`,
      `${atRoot}cotal update --self`,
      `${atRoot}${words.map(shellWord).join(" ")}`,
    ] };
  } catch {
    // Diagnostic enrichment grants no authority. A failed proof must retain the existing refusal.
    return undefined;
  }
}
