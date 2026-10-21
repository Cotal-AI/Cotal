import { isAbsolute, resolve } from "node:path";
import {
  DEV_OWNER, assertCommandToken, assertLifecycleToken, assertValidChannel, canonicalJson,
  endpointToken, isUserNkey, permissionsFor, principalTags, resolveReadAcl, validateSpaceAuth, verifyStaticUserCredential,
  type EpCaller, type EpCapability,
} from "@cotal-ai/core";
import { getSpaceAuth, hasUserAuthState } from "./auth-paths.js";
import { workspaceSecretStore } from "./secret-store-fs.js";
import { CommandFailure } from "./output.js";
import { decodeLocalJson, localRecordObject, localRecordText, protectedCredentialReference, readLocalRecordSource } from "./protected-records.js";
import type { NativeServiceTarget } from "./service-target.js";

export interface StandaloneCallerIntent {
  schemaVersion: 1;
  kind: "endpoint-caller-issuance-intent";
  requestId: string;
  createdAt: string;
  space: string;
  endpoint: string;
  identity: string;
  owner: typeof DEV_OWNER;
  lifecycleUid: string;
  output: string;
  channels: string[];
  expiresInSeconds: number | null;
  scope: {
    source: "fresh-native-resolution";
    supportedMode: "untargeted-synchronous-ephemeral";
    owner: string;
    responder: { instanceId: string; epoch: number };
    instancePinned: false;
    commands: { command: string; class: "ephemeral"; capability: string; inputDigest: string; outputDigest: string }[];
  };
  phase: "local-intent-only";
  secretIncluded: false;
}

const text = (value: unknown, limit: number) => {
  const found = localRecordText(value, limit);
  if (/[\u0000-\u001f\u007f]/u.test(found)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the local caller intent contains invalid control-bearing metadata");
  return found;
};

/** A local selection/recovery record, never an authority grant or submission/completion proof. */
export function standaloneCallerIntent(input: unknown): StandaloneCallerIntent {
  const value = localRecordObject(input, ["schemaVersion", "kind", "requestId", "createdAt", "space", "endpoint", "identity", "owner", "lifecycleUid", "output", "channels", "expiresInSeconds", "scope", "phase", "secretIncluded"]);
  if (value.schemaVersion !== 1 || value.kind !== "endpoint-caller-issuance-intent" || value.owner !== DEV_OWNER || value.phase !== "local-intent-only" || value.secretIncluded !== false) throw new CommandFailure("refused", "SCHEMA_INVALID", "the caller intent has an unsupported local contract; no caller or completion was inferred");
  const requestId = text(value.requestId, 36), createdAt = text(value.createdAt, 100);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId) || !Number.isFinite(Date.parse(createdAt))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the local caller request identity or timestamp is invalid");
  const output = text(value.output, 4096), space = text(value.space, 200), endpoint = endpointToken(text(value.endpoint, 253));
  if (!isAbsolute(output) || !Array.isArray(value.channels) || value.channels.length > 8192 || !(value.expiresInSeconds === null || Number.isSafeInteger(value.expiresInSeconds) && Number(value.expiresInSeconds) > 0)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the local caller path, channels or requested expiry is invalid");
  const channels = value.channels.map((channel) => assertValidChannel(text(channel, 1024)));
  const identity = text(value.identity, 64), lifecycleUid = assertLifecycleToken(text(value.lifecycleUid, 200));
  if (!isUserNkey(identity)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the local caller intent has no native user public identity");
  const scope = localRecordObject(value.scope, ["source", "supportedMode", "owner", "responder", "instancePinned", "commands"]);
  if (scope.source !== "fresh-native-resolution" || scope.supportedMode !== "untargeted-synchronous-ephemeral" || scope.instancePinned !== false || !Array.isArray(scope.commands) || !scope.commands.length || scope.commands.length > 512) throw new CommandFailure("refused", "UNSUPPORTED", "the local caller intent has no supported bounded synchronous endpoint scope");
  const responder = localRecordObject(scope.responder, ["instanceId", "epoch"]);
  if (!Number.isSafeInteger(responder.epoch) || Number(responder.epoch) < 0) throw new CommandFailure("refused", "SCHEMA_INVALID", "the local issuer observation has an invalid epoch");
  const commands = scope.commands.map((input) => {
    const row = localRecordObject(input, ["command", "class", "capability", "inputDigest", "outputDigest"]);
    if (row.class !== "ephemeral") throw new CommandFailure("refused", "UNSUPPORTED", "the local caller intent does not declare a supported synchronous ephemeral surface");
    return { command: assertCommandToken(text(row.command, 200)), class: "ephemeral" as const, capability: text(row.capability, 200), inputDigest: text(row.inputDigest, 200), outputDigest: text(row.outputDigest, 200) };
  });
  if (new Set(commands.map((command) => command.command)).size !== commands.length) throw new CommandFailure("refused", "SCHEMA_INVALID", "the local caller intent repeats a command");
  return { schemaVersion: 1, kind: "endpoint-caller-issuance-intent", requestId, createdAt, space, endpoint, identity, owner: DEV_OWNER, lifecycleUid, output, channels, expiresInSeconds: value.expiresInSeconds as number | null,
    scope: { source: "fresh-native-resolution", supportedMode: "untargeted-synchronous-ephemeral", owner: text(scope.owner, 200), responder: { instanceId: assertLifecycleToken(text(responder.instanceId, 200)), epoch: Number(responder.epoch) }, instancePinned: false, commands }, phase: "local-intent-only", secretIncluded: false };
}

/** Select only public pins inside this scope. No signing key/seed is returned or used to mint. */
async function staticCredentialPins(target: NativeServiceTarget) {
  if (target.mode !== "auth" || hasUserAuthState(target.root, target.space, { readOnly: true })) throw new CommandFailure("refused", "UNSUPPORTED", "this credential adapter requires a registered static-auth root; no user login or raw/open connection was substituted");
  const auth = await getSpaceAuth(workspaceSecretStore(target.root), target.space);
  if (!auth) throw new CommandFailure("refused", "AUTH_REQUIRED", "this root has no validated public static-issuer pins for the selected credential; no different authority was selected");
  try { validateSpaceAuth(auth, target.space); }
  catch { throw new CommandFailure("refused", "UNSUPPORTED", "this credential adapter requires the selected root's full validated static trust chain and current issuer pins; no stripped signer or different root was substituted"); }
  return { accountPub: auth.account.pub, signingPub: auth.account.signingPub };
}

/** Protected file snapshot plus signature/current-issuer pin checks, not live broker admission.
 *  The credential text is private authentication material and must never enter a report. */
export async function readPinnedStaticCredential(target: NativeServiceTarget, input: string) {
  if (typeof input !== "string" || !input || input.length > 4096 || /[\u0000-\u001f\u007f]/u.test(input)) throw new CommandFailure("refused", "USAGE_INVALID", "use one bounded protected credential file reference");
  const path = resolve(input), pins = await staticCredentialPins(target);
  protectedCredentialReference(path);
  const bytes = readLocalRecordSource(path, 1024 * 1024, true);
  if (!bytes?.length) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the selected private credential file is absent or empty");
  let creds: string;
  try { creds = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the selected credential is not native credential text; bytes were not printed"); }
  try { return { path, creds, ...verifyStaticUserCredential(creds, pins) }; }
  catch { throw new CommandFailure("refused", "AUTH_REQUIRED", "the selected file does not bind a matching native user key and current window to this root's pinned static issuer; no credential bytes or alternative identity were used"); }
}

function permissionProjection(input: { pub?: unknown; sub?: unknown; resp?: unknown }) {
  const rows = (value: unknown) => {
    const record = value === null || value === undefined ? {} : localRecordObject(value, ["allow", "deny"]);
    const list = (value: unknown, allow: boolean): string[] | null => {
      if (value === undefined || value === null) return allow ? null : [];
      if (!Array.isArray(value) || value.length > 65536 || value.some((item) => typeof item !== "string" || !item || item.length > 4096 || /[\u0000-\u001f\u007f]/u.test(item))) throw new CommandFailure("refused", "SCHEMA_INVALID", "the native credential permission projection is invalid");
      return [...new Set(value as string[])].sort();
    };
    return { allow: list(record.allow, true), deny: list(record.deny, false) };
  };
  return canonicalJson({ pub: rows(input.pub), sub: rows(input.sub), resp: input.resp ?? null });
}

/** Bind a paired CLI issuance context to the signed native permission set. The local record only
 *  selects coordinates; it cannot confer a row absent from the credential. No issuer/seat fallback. */
export async function readStandaloneEndpointCaller(target: NativeServiceTarget, input: string, endpoint: string) {
  const credential = await readPinnedStaticCredential(target, input), intentPath = `${credential.path}.issuance.json`;
  protectedCredentialReference(intentPath);
  const bytes = readLocalRecordSource(intentPath, 1024 * 1024, true);
  if (!bytes) throw new CommandFailure("refused", "UNSUPPORTED", "the credential has no paired native CLI issuance context; a caller triple was not guessed from an arbitrary raw file");
  const intent = standaloneCallerIntent(decodeLocalJson(bytes));
  if (intent.space !== target.space || intent.endpoint !== endpoint || intent.output !== credential.path || intent.identity !== credential.identity) throw new CommandFailure("refused", "CONFLICT", "the private caller context differs from the selected file, endpoint, space or verified user key; no other context was adopted");
  const caller: EpCaller = { owner: DEV_OWNER, actor: credential.identity, uid: intent.lifecycleUid };
  const capabilities: EpCapability[] = intent.scope.commands.map((command) => ({ endpoint, command: command.command }));
  const expected = permissionsFor("agent", target.space, { owner: caller.owner, actor: caller.actor, connId: credential.identity, lifecycleUid: caller.uid }, { lifecycleUid: caller.uid, capabilities: [], endpointCapabilities: capabilities, allowSubscribe: resolveReadAcl(intent.channels, intent.channels), allowPublish: intent.channels });
  const tags = credential.principalTags;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string") || canonicalJson([...new Set(tags)].sort()) !== canonicalJson(principalTags(caller.owner, caller.actor).sort()) || permissionProjection(credential.permissionFields) !== permissionProjection({ pub: expected.pub, sub: expected.sub, resp: expected.resp })) throw new CommandFailure("refused", "UNSUPPORTED", "the signed credential is not the native standalone scope recorded for this caller; broader, issued-generation or different-profile authority was not substituted");
  return { creds: credential.creds, caller, accountPub: credential.accountPub, identity: credential.identity, commands: intent.scope.commands.map((command) => command.command),
    reference: { path: credential.path, intentPath, localRequestId: intent.requestId, endpoint, identity: credential.identity, lifecycleUid: caller.uid, callerKind: "native-static-out-of-band" as const, binding: "signature-current-issuer-and-native-permission-projection" as const, brokerAdmitted: false as const } };
}
