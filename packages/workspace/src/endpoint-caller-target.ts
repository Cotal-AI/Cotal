import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
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
import type { NatsConnection } from "@nats-io/transport-node";
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
  nc: NatsConnection;
  space: string;
  server: string;
  root: string;
  caller: IssuedCaller;
  receipt: Readonly<EndpointCallerAuthorityReceipt>;
  service: ResolvedService;
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
    assertEndpointCallerResolvedService(service, receipt);
    return { nc, space: target.space, server: target.server, root: target.root, caller, receipt, service };
  } catch (error) {
    await nc.close();
    throw error;
  }
}
