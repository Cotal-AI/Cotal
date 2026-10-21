/** The local NATS broker as a controller-owned service: an explicitly prepared configuration, one
 *  creation-pinned direct `nats-server` child, launch-bound listener readiness and an exact
 *  kernel-exit stop. Planning prepares no trust, writes no broker config and starts nothing else. */
import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { isReachable, registry, writeSecretFileCreateOnly } from "@cotal-ai/core";
import {
  CommandFailure, assertRecordIdentity, assertSingleSpaceBroker, authDir, canonicalRoot, decodeLocalJson,
  findMesh, findPreparedSpace, listSpaceAccounts, loadMeshes, localMeshesForRoot, localProcessPath,
  parsePid, probeLiveness, readBrokerPolicy, readLocalRecordSource, readMaintenanceJournal, readPidfile,
  controllerAttemptBroker, cutController, maintenanceAdmitsStackWork, serviceAdapterAttempt,
  serviceMetadataDigest, type LocalProcess, type ProcessIdentityRecord, type ServiceAdapterContext,
  type ServiceAdapterKernelStopPlan, type ServicePreset,
} from "@cotal-ai/workspace";
import { localProcessSurface } from "../ext-loader.js";
import { observeServiceProcess, serviceInstances } from "./service-instances.js";
import { maintenanceStackView } from "./stack-journal.js";

export const brokerPreset: ServicePreset = {
  kind: "service-preset", name: "broker", adapter: "nats-broker", timeoutMs: 30000,
  summary: "local nats-server child for an explicitly prepared root and configuration",
};

const CONFIG_LIMIT = 1024 * 1024;
const LEGACY_BROKER_PIDFILE = "nats.pid";

interface BrokerTarget { root: string; space: string; server: string; host: string; port: number; scheme: "nats" | "tls"; config: string; binary: string }

const refuse = (code: "CONFLICT" | "LIFECYCLE_BLOCKED" | "UNSUPPORTED" | "TARGET_UNAVAILABLE", message: string, target?: unknown): never => {
  throw new CommandFailure("refused", code, message, target === undefined ? {} : { target });
};

const portsDirectory = (context: ServiceAdapterContext) => join(context.stateDirectory, `.broker-ports-${context.launchRequestId}`);
const launchReceipt = (context: ServiceAdapterContext) => join(context.stateDirectory, `.broker-launch-${context.launchRequestId}.json`);

function physical(path: string): string {
  try { return realpathSync.native(path); }
  catch { return refuse("TARGET_UNAVAILABLE", "a declared broker path is missing or unreadable; no broker was launched"); }
}

/** What one broker target is resolved for; a controller maintenance journal admits each separately. */
type BrokerPurpose = "launch" | "readiness" | "kernel-stop";

/** A controller-custody maintenance journal admits only the broker work its own attempt needs:
 *  the cut's kernel stop of its recorded broker member, and a resume or restore launch carrying
 *  that attempt and its server name, then the readiness of that same instance. When the cut's
 *  broker record is retired, only the new instance the journal names, at its journaled launch
 *  request, is admitted. Anything else, including every legacy-custody journal, still refuses. */
function controllerMaintenanceAdmits(root: string, context: ServiceAdapterContext, purpose: BrokerPurpose): boolean {
  const journal = readMaintenanceJournal(root);
  const cut = journal ? cutController(journal.cut) : undefined;
  if (!journal || !cut) return false;
  const member = cut.members.find((row) => row.role === "broker");
  if (!member) return false;
  if (purpose === "kernel-stop") return journal.state === "cut-committed" && context.instanceId === member.instanceId && context.launchRequestId === member.launchRequestId;
  const replacement = controllerAttemptBroker(journal);
  if (replacement.required && (!replacement.instance || context.launchRequestId !== replacement.instance.launchRequestId)) return false;
  const instance = replacement.instance?.instanceId ?? member.instanceId;
  if (context.instanceId !== instance) return false;
  const attemptId = "ordinaryResume" in journal ? journal.ordinaryResume.attemptId : journal.state === "commit-intent" ? journal.restore.attemptId : undefined;
  if (purpose === "readiness") return attemptId !== undefined;
  if (journal.state !== "resume-intent" && journal.state !== "commit-intent") return false;
  const attempt = context.attempt === undefined ? undefined : serviceAdapterAttempt(context.attempt, ["serverName"]);
  const serverName = "ordinaryResume" in journal ? journal.ordinaryResume.launch.serverName : journal.launch.serverName;
  return Boolean(attempt && attempt.attemptId === attemptId && typeof serverName === "string" && attempt.serverName === serverName);
}

/** A settled active controller restore of this root's own stack, at this space and address, does
 *  not fence that stack's broker, as legacy bare down admits it. */
function restoreAdmits(root: string, space: string, server: string): boolean {
  const canonical = canonicalRoot(root);
  return maintenanceAdmitsStackWork(canonical, space, server, maintenanceStackView(canonical, space));
}

/** The declared root, space, broker address, configuration and binary, checked against the local
 *  registrations. Registry absence never proves that a broker is exclusive, so every known
 *  sharing, maintenance and legacy-custody record refuses instead of being reconciled here. */
function brokerTarget(context: ServiceAdapterContext, purpose: BrokerPurpose = "launch"): BrokerTarget {
  const options = context.options;
  const root = physical(String(options.root)), config = physical(String(options.config)), binary = physical(String(options.binary));
  const server = String(options.server);
  if (canonicalRoot(root) === canonicalRoot(homedir())) refuse("CONFLICT", "the machine home is not an isolated broker root; no broker was launched", { root });
  const control = join(root, ".cotal");
  const controlStat = lstatSync(control, { throwIfNoEntry: false });
  if (!controlStat?.isDirectory() || controlStat.isSymbolicLink()) refuse("TARGET_UNAVAILABLE", "the broker root has no physical .cotal control directory; prepare it first", { root });
  const inside = relative(control, config);
  if (!inside || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) refuse("CONFLICT", "the broker configuration is not inside the selected root's .cotal directory; another root's configuration was not used", { root, config });
  let url: URL;
  try { url = new URL(server); } catch { return refuse("UNSUPPORTED", "the broker address must be one nats:// or tls:// URL"); }
  if (!["nats:", "tls:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/") || server.includes(",")) refuse("UNSUPPORTED", "the broker address must be one nats:// or tls:// URL without credentials, path, query or fragment");
  const port = url.port ? Number(url.port) : 4222;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) refuse("UNSUPPORTED", "the broker address needs one concrete TCP port");
  // nats-server writes its ports report from the bound listener's own address: one entry for a
  // concrete bind, one per interface address for a wildcard bind, and never a DNS name. The
  // declared target must therefore be one concrete IP literal that readiness can find in that
  // report; a declared name or wildcard has no single attributable address and refuses here.
  const host = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  const family = isIP(host);
  if (family === 0) refuse("UNSUPPORTED", "the broker address must name a concrete IP literal; a DNS name cannot be matched to the broker's own listener report, so no listener readiness would be attributable", { server });
  if (family === 4 ? host === "0.0.0.0" : /^[0:]+$/.test(host)) refuse("UNSUPPORTED", "the broker address is a wildcard bind; its listener report names every interface, so no single declared address could be attributed to this broker", { server });
  if (family === 6 && /^(0{0,4}:){0,5}:?ffff:/i.test(host)) refuse("UNSUPPORTED", "the broker address is an IPv4-mapped IPv6 literal, which nats-server reports in IPv4 form; declare the IPv4 address itself", { server });
  let policy;
  try { policy = readBrokerPolicy(root); }
  catch { return refuse("CONFLICT", "the root's recorded broker transport policy is unreadable; no plaintext or TLS mode was inferred"); }
  const scheme = policy?.transport.kind === "tls-required" ? "tls" : "nats";
  if (scheme === "tls" && url.protocol !== "tls:" && url.protocol !== "nats:") refuse("UNSUPPORTED", "the TLS-required broker needs a nats:// or tls:// address");
  const registered = findMesh(context.space), prepared = findPreparedSpace(context.space);
  if (registered) {
    if (registered.origin !== "up" || canonicalRoot(registered.root) !== canonicalRoot(root) || registered.server !== server) refuse("CONFLICT", "the space is registered to another root, broker address or external origin; no broker was launched", { space: context.space });
    if ((registered.tlsRequired === true) !== (scheme === "tls")) refuse("CONFLICT", "the registered transport requirement disagrees with the root's broker policy; neither was weakened");
  } else if (!prepared || canonicalRoot(prepared.root) !== canonicalRoot(root)) refuse("TARGET_UNAVAILABLE", "the space has no prepared or locally started registration at this root", { space: context.space, root });
  try { assertSingleSpaceBroker(authDir(root), "broker service"); }
  catch { return refuse("CONFLICT", "this broker root hosts several spaces or an unreadable tenant record; a single-space broker stop or launch cannot be scoped"); }
  if (listSpaceAccounts(authDir(root)).some((space) => space !== context.space)) refuse("CONFLICT", "the broker root holds another space's account; no broker was launched for this space");
  if (localMeshesForRoot(root).some((mesh) => mesh.space !== context.space)) refuse("CONFLICT", "another locally started space uses this root; its broker custody was not shared");
  if (loadMeshes().some((mesh) => mesh.space !== context.space && mesh.server === server)) refuse("CONFLICT", "another registration names this exact broker address; no shared broker was launched or stopped");
  if (readMaintenanceJournal(root) && !controllerMaintenanceAdmits(root, context, purpose) && !restoreAdmits(root, context.space, server)) refuse("LIFECYCLE_BLOCKED", "this root retains a maintenance or recovery attempt; the broker service did not substitute an ordinary lifecycle");
  return { root, space: context.space, server, host: new URL(`nats://${family === 6 ? `[${host}]` : host}:${port}`).hostname, port, scheme, config, binary };
}

function configDigest(path: string): string {
  const bytes = readLocalRecordSource(path, CONFIG_LIMIT);
  if (!bytes) return refuse("TARGET_UNAVAILABLE", "the prepared broker configuration is missing; no configuration was generated");
  return createHash("sha256").update(bytes).digest("hex");
}

/** A legacy root-scoped broker record is a different custody. It is never adopted or removed. */
function refuseLegacyBroker(target: BrokerTarget): void {
  const raw = readPidfile(localProcessPath(LEGACY_BROKER_PIDFILE, { root: target.root, space: target.space }));
  if (raw !== undefined) refuse("LIFECYCLE_BLOCKED", "a legacy nats.pid record exists under this root; the broker service neither adopts nor clears it", { root: target.root, remedy: "inspect and stop the legacy broker with its original route before using the broker service" });
}

/** Every non-broker legacy record that might still front a process depends on this broker. */
function liveLegacyDependants(target: BrokerTarget): string[] {
  const live: string[] = [];
  for (const component of localProcessSurface()) {
    if (component.name === "nats") continue;
    const raw = readPidfile(localProcessPath(component.pidFile, { root: target.root, space: target.space }));
    if (!raw) continue;
    const pid = parsePid(raw);
    if (pid === undefined || probeLiveness(pid) !== "dead") live.push(component.name);
  }
  return live;
}

function readinessFile(context: ServiceAdapterContext & { process: ProcessIdentityRecord }): string {
  return join(portsDirectory(context), `${basename(String(context.options.binary))}_${context.process.pid}.ports`);
}

/**
 * Set the broker's ports report to `0600`. nats-server writes it under the umask it inherited, so a
 * group-writable umask leaves it `0664`. The change goes through a descriptor that follows no
 * symlink and only to a regular file this user owns, as other private files are tightened.
 */
export function narrowPortsReport(path: string): void {
  const refused = () => new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker ports report could not be made owner-private; no listener was attributed");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw refused(); }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || process.getuid === undefined || info.uid !== process.getuid()) throw refused();
    fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
}

/** The broker's own native ports file for this launch. Its directory is created fresh per launch
 *  and owner-private; its name carries the pinned child's PID. A port answer alone never counts. */
function reportedListener(context: ServiceAdapterContext & { process: ProcessIdentityRecord }, target: BrokerTarget): string[] | undefined {
  const dir = portsDirectory(context);
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink() || process.getuid === undefined || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the launch-bound broker readiness directory is missing or not owner-private; no listener was attributed");
  const expected = basename(readinessFile(context));
  const entries = readdirSync(dir);
  if (entries.some((name) => name !== expected)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the launch-bound broker readiness directory holds another process's report; no listener was attributed");
  if (!entries.length) return undefined;
  const file = lstatSync(join(dir, expected), { throwIfNoEntry: false });
  if (!file?.isFile() || file.isSymbolicLink() || file.uid !== process.getuid()) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker ports report is not a regular file owned by this user; no listener was attributed");
  narrowPortsReport(join(dir, expected));
  const bytes = readLocalRecordSource(join(dir, expected), 64 * 1024);
  if (!bytes) return undefined;
  let value: unknown;
  try { value = decodeLocalJson(bytes); } catch { return undefined; } // nats-server writes it with a plain write; a torn read retries
  const nats = (value as { nats?: unknown }).nats;
  if (!Array.isArray(nats) || !nats.length) return undefined;
  if (nats.length > 256) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker ports report lists more client listeners than this check bounds; none was adopted");
  // A concrete bind reports one listener; a wildcard bind reports one per interface address, all
  // from this same PID-bound launch report. Every entry must carry the declared transport and port,
  // and the declared concrete IP must be one of them. Another address, including one that happens
  // to answer, is never this broker's listener.
  const urls = nats.map((entry) => {
    try { return new URL(String(entry)); }
    catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker reported an unparseable client listener; none was adopted"); }
  });
  if (urls.some((url) => url.protocol !== `${target.scheme}:` || Number(url.port) !== target.port || url.username || url.password || (url.pathname && url.pathname !== "/") || url.search || url.hash))
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker reported a client listener on another port or transport than its declaration; it was not adopted", { target: { declared: target.server, reported: nats.slice(0, 16).map(String) } });
  const matched = urls.find((url) => url.hostname === target.host);
  if (!matched) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker's own listener report does not include the declared address; it was not adopted", { target: { declared: target.server, reported: nats.slice(0, 16).map(String) } });
  // The attributed evidence is the declared listener the pinned child itself reported.
  return [`${target.scheme}://${matched.host}`];
}

function brokerScope(context: ServiceAdapterContext & { process: ProcessIdentityRecord }, target: BrokerTarget): ServiceAdapterKernelStopPlan["binding"] {
  const bytes = readLocalRecordSource(launchReceipt(context), 4096, true);
  if (!bytes) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker launch receipt is missing; its exact configuration identity was not inferred");
  const receipt = decodeLocalJson(bytes) as Record<string, unknown>;
  if (!receipt || Object.keys(receipt).length !== 5 || receipt.instanceId !== context.instanceId || receipt.launchRequestId !== context.launchRequestId || receipt.root !== target.root || receipt.server !== target.server || typeof receipt.configSha256 !== "string" || !/^[0-9a-f]{64}$/.test(receipt.configSha256)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker launch receipt does not match this exact launch, root or address");
  return { kind: "nats-broker", root: target.root, space: target.space, server: target.server, configSha256: receipt.configSha256 };
}

export const brokerService: LocalProcess = {
  kind: "local-process", name: "nats-broker", label: "broker service", controllerOnly: true,
  pidFile: "broker-service.{space}.pid",
  service: {
    abiVersion: 1, readiness: "listener", stop: "kernel-exit",
    capabilities: { multiInstance: false, foreground: false, logs: true },
    paths: { root: "directory", config: "file", binary: "file" },
    optionsSchema: { type: "object", additionalProperties: false, required: ["root", "config", "binary", "server"], properties: {
      root: { type: "string", minLength: 1, maxLength: 4096, description: "prepared local root whose .cotal holds this space's broker configuration" },
      config: { type: "string", minLength: 1, maxLength: 4096, description: "explicitly prepared nats-server configuration inside that root's .cotal directory; it is never generated here" },
      binary: { type: "string", minLength: 1, maxLength: 4096, description: "absolute nats-server executable; no PATH lookup is made" },
      server: { type: "string", minLength: 1, maxLength: 4096, description: "the one broker URL this configuration serves" },
    } },
  },
  async buildServiceLaunch(context) {
    if (context.credentialRef) refuse("UNSUPPORTED", "the broker loads its prepared configuration; a credential reference was not forwarded");
    const target = brokerTarget(context, "launch");
    refuseLegacyBroker(target);
    if (await isReachable(target.server, { timeoutMs: 1500 })) refuse("CONFLICT", "something already answers at the declared broker address; no second listener was launched and none was adopted", { server: target.server });
    // Only a controller resume carries an attempt; its server name lets the listener proof bind.
    const attempt = context.attempt === undefined ? undefined : serviceAdapterAttempt(context.attempt, ["serverName"]);
    const configSha256 = configDigest(target.config);
    // Launch-bound private state: a fresh directory for the child's own ports report and a
    // create-only receipt of the exact configuration identity. Neither is ever adopted later.
    try { mkdirSync(portsDirectory(context), { mode: 0o700 }); }
    catch { refuse("CONFLICT", "the launch-bound broker readiness directory already exists; it was not reused"); }
    writeSecretFileCreateOnly(launchReceipt(context), JSON.stringify({ instanceId: context.instanceId, launchRequestId: context.launchRequestId, root: target.root, server: target.server, configSha256 }) + "\n");
    return { executable: target.binary, cwd: target.root, args: ["-c", target.config, "--ports_file_dir", portsDirectory(context), ...(attempt?.serverName ? ["--name", attempt.serverName] : [])] };
  },
  async checkServiceReadiness(context) {
    context.signal.throwIfAborted();
    const target = brokerTarget(context, "readiness");
    const nats = reportedListener(context, target);
    if (!nats) return { state: "pending" };
    if (assertRecordIdentity(context.process).kind !== "match") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the broker process changed while its listener report was read");
    return { state: "ready", process: { ...context.process }, observedAt: new Date().toISOString(), listener: { kind: "nats-ports-file", nats } };
  },
  async prepareKernelStop(context) {
    context.signal.throwIfAborted();
    const target = brokerTarget(context, "kernel-stop");
    const binding = brokerScope(context, target);
    refuseLegacyBroker(target);
    const legacy = liveLegacyDependants(target);
    if (legacy.length) refuse("LIFECYCLE_BLOCKED", "legacy local daemons on this root may still depend on the broker; it was not stopped under them", { dependants: legacy });
    const others = serviceInstances(context.space).filter((row) => row.name !== context.instanceId)
      .filter((row) => !["gone", "previous-boot", "foreign-pid"].includes(observeServiceProcess(row.record.value)) || ["starting", "stopping", "unknown"].includes(row.record.value.state));
    if (others.length) refuse("LIFECYCLE_BLOCKED", "other service instances in this space are live or unresolved; the broker was not stopped under them", { dependants: others.map((row) => ({ definition: row.record.value.definition, instanceId: row.name })) });
    return { kind: "kernel-exit", scopeSha256: serviceMetadataDigest({ binding, instanceId: context.instanceId, launchRequestId: context.launchRequestId, process: context.process, dependants: [] }), observedAt: new Date().toISOString(), binding };
  },
  observeKernelStop(context) {
    return lstatSync(readinessFile(context), { throwIfNoEntry: false }) === undefined ? "ports-file-removed" : "ports-file-retained";
  },
};

registry.register(brokerService, brokerPreset);
