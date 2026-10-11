import { constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, readSync, writeSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import {
  BASELINE_LIFECYCLE_ENDPOINT,
  EpEnvelopeError,
  assertEndpointCallerResolvedService,
  canonicalJson,
  dialerFor,
  endpointExchangeOrigin,
  issuedUserCaller,
  parseEndpointCallerSelection,
  parseEndpointDeploymentTrustRecord,
  resolveAuthProvider,
  resolveService,
  standaloneConnectOpts,
  type EndpointCallerAuthorityReceipt,
  type EndpointCallerSelection,
  type EndpointDeploymentTrustRecord,
  type IssuedCaller,
  type ResolvedService,
} from "@cotal-ai/core";
import { authDir, spaceSegment, userAuthStateDir } from "./auth-paths.js";
import { CLI_USER_ACTOR, type ConnectFlags } from "./connect.js";
import { resolveMeshTarget } from "./mesh-target.js";
import { findMesh } from "./mesh-registry.js";
import { workspaceSecretStore } from "./secret-store-fs.js";

const TRUST_BYTES = 32768;
function refused(message: string): never {
  throw new EpEnvelopeError("permission-denied", message, undefined, "not-executed");
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
}
function protectedShape(info: Stats, directory: boolean, path: string): void {
  if (info.uid !== process.getuid!() || (info.mode & 0o7777) !== (directory ? 0o700 : 0o600)
      || (directory ? !info.isDirectory() : !info.isFile()))
    refused(`endpoint deployment trust requires an owned ${directory ? "0700 directory" : "0600 regular file"}: ${path}`);
}

/** Read only the deployment-installed public record. No catalog, HTTP response or alternate path
 * can provide trust. The returned check must run immediately before using the acquired credential. */
export function loadEndpointDeploymentTrust(
  root: string, space: string, exchangeOrigin: string,
): { record: Readonly<EndpointDeploymentTrustRecord>; assertCurrent(): void } {
  if (typeof process.getuid !== "function" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY)
    throw new Error("protected endpoint deployment trust is unsupported on this platform");
  const resolvedRoot = resolve(root);
  // Use the canonical state path without invoking the legacy migration on untrusted directories.
  const state = join(authDir(resolvedRoot), spaceSegment(space));
  const path = join(state, "endpoint-deployment-trust.json");
  const directories = [join(resolvedRoot, ".cotal"), authDir(resolvedRoot), state];
  const read = (): { bytes: Buffer; identities: Stats[]; file: Stats } => {
    const handles: number[] = [];
    try {
      const rootInfo = lstatSync(resolvedRoot);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) refused("endpoint deployment root must be a real directory");
      const identities = directories.map(directory => {
        const before = lstatSync(directory);
        protectedShape(before, true, directory);
        const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
        handles.push(fd);
        const opened = fstatSync(fd);
        protectedShape(opened, true, directory);
        if (!sameFile(before, opened)) refused("endpoint deployment trust directory changed while opening");
        return opened;
      });
      const before = lstatSync(path);
      protectedShape(before, false, path);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      handles.push(fd);
      const opened = fstatSync(fd);
      protectedShape(opened, false, path);
      if (!sameFile(before, opened) || opened.size > TRUST_BYTES) refused("endpoint deployment trust file changed or exceeds its byte bound");
      const buffer = Buffer.alloc(TRUST_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      const after = fstatSync(fd);
      if (length > TRUST_BYTES || length !== opened.size || !sameFile(opened, after)
          || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs
          || !sameFile(after, lstatSync(path))) refused("endpoint deployment trust changed while reading");
      directories.forEach((directory, index) => {
        if (!sameFile(identities[index], lstatSync(directory))) refused("endpoint deployment trust directory was replaced");
      });
      if (!sameFile(rootInfo, lstatSync(resolvedRoot))) refused("endpoint deployment root was replaced");
      return { bytes: buffer.subarray(0, length), identities: [rootInfo, ...identities], file: after };
    } finally {
      for (const fd of handles.reverse()) closeSync(fd);
    }
  };
  const original = read();
  const decode = (bytes: Buffer): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const record = parseEndpointDeploymentTrustRecord(decode(original.bytes), { space, exchangeOrigin });
  const canonical = canonicalJson(record);
  return {
    record,
    assertCurrent() {
      const current = read();
      const parsed = parseEndpointDeploymentTrustRecord(decode(current.bytes), { space, exchangeOrigin });
      if (!original.bytes.equals(current.bytes) || canonicalJson(parsed) !== canonical
          || !sameFile(original.file, current.file)
          || original.identities.some((identity, index) => !sameFile(identity, current.identities[index])))
        refused("endpoint deployment trust was replaced; acquire a new caller before connecting");
    },
  };
}

export interface EndpointCallerTarget {
  nc: Awaited<ReturnType<ReturnType<typeof dialerFor>>>;
  space: string;
  server: string;
  root: string;
  caller: IssuedCaller;
  receipt: Readonly<EndpointCallerAuthorityReceipt>;
  service: ResolvedService;
}

// Temporary hosted-fixture observation, not a policy decision or exported capability.
function writeBindingDiagnostic(root: string, space: string, service: ResolvedService, receipt: EndpointCallerAuthorityReceipt): void {
  const descriptor = service.descriptor;
  const allowed = receipt.selection.commands.filter(command => command !== "describe").sort();
  const descriptorClosureCount = descriptor?.clusters.length ?? 0;
  const receiptClosureCount = receipt.clusterDigests.length;
  const selectedNonDescribeCommandCount = allowed.length;
  const resolvedCommandCount = service.commands.size;
  for (const [count, max] of [[descriptorClosureCount, 64], [receiptClosureCount, 64], [selectedNonDescribeCommandCount, 31], [resolvedCommandCount, 32]] as const) {
    if (!Number.isSafeInteger(count) || count < 0 || count > max) throw new Error("diagnostic count unavailable");
  }
  const record = {
    v: 1,
    kind: "cotal.endpoint-caller-binding-diagnostic",
    boundary: "local-before-strict-resolved-binding",
    receiptKindMatches: receipt.kind === "cotal.endpoint-caller",
    receiptUnexpiredAtComparison: receipt.exp > Math.floor(Date.now() / 1000),
    descriptorPresent: !!descriptor,
    descriptorProtocol3: !!descriptor && descriptor.protocol.v === 3,
    endpointMatches: service.endpoint === receipt.selection.endpoint,
    pinnedInstanceMatches: service.pinnedInstanceId === receipt.selection.instanceId,
    responderInstanceMatches: service.responder.instanceId === receipt.selection.instanceId,
    processEpochMatches: service.responder.epoch === receipt.processEpoch,
    registrationRevisionMatches: !!descriptor && descriptor.registrationRevision === receipt.registrationRevision,
    servingAuthorityMatches: !!descriptor && canonicalJson(descriptor.servingAuthority) === canonicalJson(receipt.servingAuthority),
    instanceRoutesMatch: descriptor?.serveRoutes?.kind === "instance",
    ephemeralResourcesMatch: descriptor?.resources?.kind === "ephemeral-only",
    closureSetMatches: !!descriptor && canonicalJson(descriptor.clusters.map(cluster => cluster.digest).sort()) === canonicalJson([...receipt.clusterDigests].sort()),
    callerOwnerMatches: service.caller.owner === receipt.principal.owner,
    callerActorMatches: service.caller.actor === receipt.principal.actor,
    callerLifecycleMatches: service.caller.uid === receipt.principal.uid,
    issuedGenerationPresent: "generation" in service.caller,
    selectedCommandSetMatches: canonicalJson([...service.commands.keys()].sort()) === canonicalJson(allowed),
    allCommandsUntargetedEphemeral: ![...service.commands.values()].some(command => command.class !== "ephemeral" || command.targeted),
    descriptorClosureCount,
    receiptClosureCount,
    selectedNonDescribeCommandCount,
    resolvedCommandCount,
    comparisonCompleted: true,
    diagnosticOnlyNoPolicyChange: true,
  };
  const bytes = Buffer.from(canonicalJson(record) + "\n");
  if (bytes.length > 4096) throw new Error("diagnostic record unavailable");
  if (process.platform !== "linux" || typeof process.getuid !== "function" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY)
    throw new Error("diagnostic path unsupported");
  const uid = process.getuid();
  const resolvedRoot = resolve(root);
  const handles: number[] = [];
  const directories: { path: string; fd: number; identity: Stats }[] = [];
  try {
    let path = "/";
    let fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    handles.push(fd);
    directories.push({ path, fd, identity: fstatSync(fd) });
    const rootParts = resolvedRoot.split("/").filter(Boolean);
    const parts = [...rootParts, ".cotal", "auth", spaceSegment(space)];
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]!;
      const anchored = `/proc/self/fd/${fd}/${name}`;
      const before = lstatSync(anchored);
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("diagnostic directory unavailable");
      if (index >= rootParts.length) protectedShape(before, true, anchored);
      else if (index === rootParts.length - 1 && (before.uid !== uid || (before.mode & 0o7777) !== 0o700)) throw new Error("diagnostic root unavailable");
      fd = openSync(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      handles.push(fd);
      const opened = fstatSync(fd);
      if (!sameFile(before, opened)) throw new Error("diagnostic directory changed");
      path = join(path, name);
      directories.push({ path, fd, identity: opened });
    }
    const assertDirectoriesCurrent = () => {
      for (const directory of directories) {
        if (!sameFile(directory.identity, fstatSync(directory.fd)) || !sameFile(directory.identity, lstatSync(directory.path)))
          throw new Error("diagnostic directory changed");
      }
    };
    assertDirectoriesCurrent();
    const anchored = `/proc/self/fd/${fd}/endpoint-caller-binding-diagnostic.json`;
    const file = openSync(anchored, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    handles.push(file);
    const opened = fstatSync(file);
    protectedShape(opened, false, anchored);
    if (opened.nlink !== 1 || opened.size !== 0 || !sameFile(opened, lstatSync(anchored))) throw new Error("diagnostic file unavailable");
    assertDirectoriesCurrent();
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(file, bytes, offset, bytes.length - offset, null);
      if (written <= 0) throw new Error("diagnostic write unavailable");
      offset += written;
    }
    fsyncSync(file);
    const after = fstatSync(file);
    protectedShape(after, false, anchored);
    if (!sameFile(opened, after) || after.nlink !== 1 || after.size !== bytes.length || !sameFile(after, lstatSync(anchored)))
      throw new Error("diagnostic file changed");
    assertDirectoriesCurrent();
  } finally {
    for (const fd of handles.reverse()) closeSync(fd);
  }
}

/** Acquire a dedicated generic caller from the registered account authority, then bind its actual
 * accepted connection and resolved descriptor. Manager, raw/static and targeted authority are not
 * compatibility paths for this helper. The caller owns the returned connection's cleanup. */
export async function resolveEndpointCallerTarget(
  flags: ConnectFlags,
  requested: EndpointCallerSelection,
  opts: { deadlineMs?: number } = {},
): Promise<EndpointCallerTarget> {
  if (flags.creds !== undefined) refused("generic endpoint callers do not accept raw --creds");
  const selection = parseEndpointCallerSelection(requested);
  if (selection.endpoint === BASELINE_LIFECYCLE_ENDPOINT) refused("manager calls use the existing manager authority path");
  const deadlineMs = opts.deadlineMs ?? 10000;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error("endpoint reply deadline must be positive");
  const target = resolveMeshTarget(process.cwd(), { space: flags.space, server: flags.server });
  if (target.mode !== "user" || !target.userAuth) refused("generic endpoint callers require a registered user-auth mesh");
  const registered = findMesh(target.space);
  if (!registered || registered.mode !== "user" || resolve(registered.root) !== resolve(target.root)
      || registered.server !== target.server)
    refused("generic endpoint callers require the selected registry broker and root without a raw server override");
  const url = target.userAuth.endpoints?.url;
  if (!url) refused("generic endpoint callers require a configured account exchange URL");
  const exchangeOrigin = endpointExchangeOrigin(url);
  const protectedTrust = loadEndpointDeploymentTrust(target.root, target.space, exchangeOrigin);
  const provider = resolveAuthProvider();
  if (provider.name !== target.userAuth.provider) refused("registered endpoint auth provider differs from the selected mesh");
  if (!provider.endpointCallerAuthority) throw new Error("the registered auth provider does not support dedicated endpoint caller acquisition");
  const material = await provider.endpointCallerAuthority({
    store: workspaceSecretStore(target.root), dir: userAuthStateDir(target.root, target.space),
    space: target.space, actor: CLI_USER_ACTOR, trust: protectedTrust.record.trust, selection,
  });
  const receipt = material.receipt;
  if (receipt.kind !== "cotal.endpoint-caller" || receipt.exp <= Math.floor(Date.now() / 1000)
      || canonicalJson(receipt.selection) !== canonicalJson(selection)
      || canonicalJson(receipt.account) !== canonicalJson(protectedTrust.record.trust.account)
      || receipt.assignmentLifecycleUid !== protectedTrust.record.trust.assignmentLifecycleUid
      || canonicalJson(receipt.authority) !== canonicalJson(protectedTrust.record.trust.authority))
    refused("dedicated endpoint caller receipt differs from the deployment and requested selection");
  const connectOpts = standaloneConnectOpts({ bearer: material.bearer, sentinelCreds: material.sentinelCreds, tls: target.tlsRequired });
  if (typeof connectOpts.name !== "string") refused("dedicated endpoint caller connection has no issued nonce");
  const nonce = connectOpts.name;
  protectedTrust.assertCurrent();
  const nc = await dialerFor(target.server)({ servers: target.server, ...connectOpts, maxReconnectAttempts: 0 });
  try {
    const caller = await issuedUserCaller(nc, target.space, nonce, receipt.principal);
    const service = await resolveService(nc, target.space, selection.endpoint, caller, { instanceId: selection.instanceId, deadlineMs });
    if (process.env.COTAL_ENDPOINT_CALLER_BINDING_DIAGNOSTIC === "1") {
      try {
        writeBindingDiagnostic(target.root, target.space, service, receipt);
      } catch {
        // Missing or malformed optional evidence is UNKNOWN. Never replace the strict assertion.
      }
    }
    assertEndpointCallerResolvedService(service, receipt);
    return { nc, space: target.space, server: target.server, root: target.root, caller, receipt, service };
  } catch (error) {
    await nc.close();
    throw error;
  }
}
