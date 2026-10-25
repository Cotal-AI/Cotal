import { existsSync, lstatSync, readlinkSync, realpathSync, unlinkSync, type Stats } from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import {
  CotalEndpoint, DEV_OWNER, accountRevocations, acquireLock, agentFilePath, credsClaims, ensureDirNoSymlink, identityFromCreds,
  loadAgentFile, mintCreds, mintLifecycleUid, newIdentity, principalKey, provisionAgentDurables,
  resolveReadAcl, writeSecretFileAtomic, writeSecretFileCreateOnly,
  type FlagValues, type Identity, type ParsedArgs, type Profile, type SpaceAuth,
} from "@cotal-ai/core";
import {
  CommandFailure, assertExternalCredentialExport, agentCredsKey, agentSecretFilePaths, canonicalRoot, credentialMintFlags,
  isCommandFailure, preflightTarget, presentationOf,
  protectedCredentialReference, protectedLocalDirectory, readLocalRecordSource,
  validateCredentialMintArguments,
  writeResult, type MeshTarget, type OutputWarning, type Report,
  recordOperationSpace, agentGrants, type AgentGrants,
} from "@cotal-ai/workspace";

import { staticMintAuthority } from "../lib/credential-authority.js";
import { credentialExportStore, recordCredentialExport } from "../lib/credential-exports.js";
import { noExpiryRecordPath, noExpiryRecordText } from "../lib/no-expiry-record.js";
import { mintEndpointCaller } from "./mint-endpoint-caller.js";
export { resolveMintTarget } from "../lib/credential-authority.js";

const csv = (value: string | undefined): string[] | undefined => value === undefined ? undefined : value.split(",").map((item) => item.trim()).filter(Boolean);
/** A fixed-profile credential's lifetime when no lifetime flag names one: 24 hours. */
const DEFAULT_LIFETIME_SECONDS = 86_400;
const expiry = (seconds: number | undefined): string => {
  if (seconds === undefined) return "no expiry claim in the native result";
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : `${seconds} native Unix seconds`;
};

/** What `--replace` found at the label: a standing credential that has expired, one with no expiry
 *  claim, or one whose key the space's account revoked, with the profile it was minted with. Any
 *  other standing credential stays, because something may still use it. */
interface Replaced { state: "expired" | "unbounded" | "revoked"; expiresAt: number | null; publicKey: string; revokedAt: number | null; profile: string | null }

function replaceable(standing: string, name: string, target: object, revocations: Readonly<Record<string, number>>): Replaced {
  let claims: ReturnType<typeof credsClaims> | undefined;
  try { claims = credsClaims(standing); } catch { claims = undefined; }
  if (!claims?.sub) throw new CommandFailure("refused", "CONFLICT", `the standing credential "${name}" is not a native credential this command can read; it was not replaced`, { target });
  const exp = claims.exp, publicKey = claims.sub, profile = claims.name ?? null;
  // The broker refuses a revoked key whatever the expiry, and the replacement takes a new key.
  const revokedAt = revocations[publicKey];
  if (revokedAt !== undefined && (claims.iat === undefined || claims.iat <= revokedAt)) return { state: "revoked", expiresAt: exp ?? null, publicKey, revokedAt, profile };
  if (exp === undefined) return { state: "unbounded", expiresAt: null, publicKey, revokedAt: null, profile };
  if (exp * 1000 > Date.now()) throw new CommandFailure("refused", "CONFLICT", `the standing credential "${name}" is valid until ${expiry(exp)}, so --replace left it in place`, { target, remedy: "choose a new label, or run it again with --replace once that credential has expired" });
  return { state: "expired", expiresAt: exp, publicKey, revokedAt: null, profile };
}

/** What `--replace` did that its receipt does not show: a replacement minted with another profile
 *  than the credential it replaced, as `--profile` defaults to agent, or a label with no standing
 *  credential, where it replaced nothing. Such a label's `--out` file is not its standing credential,
 *  so the warning names the mint that signs that file's key again. */
function replaceNotes(replaced: Replaced | undefined, standing: boolean, profile: string, space: string, name: string, root: string): OutputWarning[] {
  if (replaced?.profile && replaced.profile !== profile)
    return [{ code: "REPLACED_PROFILE_CHANGED", target: { space, name, profile, replacedProfile: replaced.profile }, message: `the credential this replaced was minted with --profile ${replaced.profile}, and this one with --profile ${profile}, so it holds that profile's grants instead` }];
  if (standing) return [];
  let exports: { path: string; profile: string }[];
  try { exports = credentialExportStore(space).list().map(({ record: { value } }) => value).filter((entry) => entry.label === name && canonicalRoot(entry.root) === canonicalRoot(root) && existsSync(entry.path)); }
  catch { exports = []; }
  const files = exports.map((entry) => `; the file auth mint --out wrote for this label at ${entry.path} is unchanged, and cotal auth mint ${name}${entry.profile === "agent" ? "" : ` --profile ${entry.profile}`} --identity ${entry.path} --out ${entry.path} signs its key again`).join("");
  return [{ code: "NOTHING_REPLACED", target: { space, name }, message: `--replace found no standing credential named "${name}", so this is a new standing credential and it replaced nothing${files}` }];
}

/** A replaced credential with no expiry claim is not revoked by its replacement, so any copy of it
 *  still connects: the warning names its key and the revocation that stops it. */
function replacedStillValid(replaced: Replaced | undefined, identity: string, space: string, name: string): OutputWarning[] {
  if (replaced?.state !== "unbounded") return [];
  const key = replaced.publicKey;
  const message = key === identity
    ? `the credential this replaced has no expiry claim and this credential's key ${key}, so a copy of it stays valid until that key is revoked, which stops this credential too`
    : `the credential this replaced has no expiry claim, so a copy of it stays valid until its key ${key} is revoked; to stop it, run cotal down --yes, then cotal auth revoke-credential ${key} --yes, then cotal up`;
  return [{ code: "REPLACED_CREDENTIAL_VALID", target: { space, name, publicKey: key }, message }];
}

/** Why the `--out` folders could not be made, naming the folder: the first one on the path that is a
 *  symbolic link, which a credential is never written through, or that is not a folder, or the
 *  folder this account may not create in. Undefined for any other failure. */
function outFolderRefusal(target: object, out: string, error: unknown): CommandFailure | undefined {
  const parent = dirname(out), volume = parse(parent).root;
  let dir = volume;
  for (const segment of parent.slice(volume.length).split(sep).filter(Boolean)) {
    dir = join(dir, segment);
    let found: Stats | undefined;
    try { found = lstatSync(dir, { throwIfNoEntry: false }); } catch { break; }
    if (found === undefined) break;
    if (found.isSymbolicLink()) {
      let real: string | undefined;
      try { real = realpathSync(dir); } catch { /* a link that names no folder */ }
      return new CommandFailure("refused", "PERMISSION_DENIED", `the --out path goes through ${dir}, a symbolic link to ${readlinkSync(dir)}, and a private credential is never written through a link; no credential was written`, {
        target: { ...target, folder: dir },
        remedy: `name the --out file by a path with no symbolic link in it${real === undefined ? "" : `, such as ${join(real, relative(dir, out))} if that folder is yours`}`,
      });
    }
    if (!found.isDirectory())
      return new CommandFailure("refused", "USAGE_INVALID", `the --out path goes through ${dir}, which is not a folder; no credential was written`, { target: { ...target, folder: dir }, remedy: "name an --out file in a folder", selfContained: true });
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "EACCES" && code !== "EPERM") return undefined;
  return new CommandFailure("refused", "PERMISSION_DENIED", `the --out folder ${parent} could not be reached or made by this account (${code}); no credential was written`, { target: { ...target, folder: parent }, remedy: "name an --out file in a folder you own, or make that folder first" });
}

/** Native static profiles only. Labels, files and broker provisioning share one resolved authority. */
export async function mint(args: ParsedArgs): Promise<void> {
  validateCredentialMintArguments(args);
  if (args.values.endpoint !== undefined) return mintEndpointCaller(args);
  const values = args.values as FlagValues<typeof credentialMintFlags>;
  const name = args.positionals[0]!;
  const profile = (values.profile ?? "agent") as Profile;
  const changed: Record<string, unknown>[] = [];
  let mayHaveProvisioned = false, publicationStarted = false;
  let identity: Identity | undefined, lifecycleUid: string | undefined, carried: AgentGrants | undefined;
  let held: ReturnType<typeof acquireLock> | undefined;
  let target: { space?: string; name: string; profile: string; path?: string; identity?: string; lifecycleUid?: string } = { name, profile };
  try {
    const { target: resolvedTarget, currentRoot, store, auth } = await staticMintAuthority(values, target);
    const { root, space } = resolvedTarget;
    target = { ...target, space };
    recordOperationSpace(space);
    if (values.identity !== undefined) {
      const path = resolve(values.identity);
      protectedCredentialReference(path);
      const bytes = readLocalRecordSource(path, 1024 * 1024, true);
      if (!bytes) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the protected identity source disappeared");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); identity = identityFromCreds(text); }
      catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the identity source has no matching native JWT subject and user nkey seed; contents were not printed"); }
      // An agent credential this space issued keeps its grants when it is minted again.
      const claims = credsClaims(text);
      if (profile === "agent" && claims.name === "agent" && (claims.nats?.issuer_account ?? claims.iss) === auth.account.pub) carried = agentGrants(claims.nats ?? {}, space);
      // A credential signed now would postdate the revocation, so the broker would accept the key again.
      const revokedAt = accountRevocations(auth.account.jwt)[identity.id];
      if (revokedAt !== undefined)
        throw new CommandFailure("refused", "CONFLICT", `the --identity key ${identity.id} was revoked at ${new Date(revokedAt * 1000).toISOString()} with auth revoke-credential, and a revoked key is not signed again; nothing was minted`, { target: { ...target, identity: identity.id }, remedy: "mint a fresh key: run auth mint without --identity" });
    }
    const requestedIdentity = identity;
    const key = agentCredsKey(space, name, { injected: false, root });
    const out = resolve(values.out ?? agentSecretFilePaths(root, space, name).creds);
    target = { ...target, path: out };
    if (values.out !== undefined) assertExternalCredentialExport(out, [root, currentRoot]);
    const parent = dirname(out), volume = parse(parent).root;
    try { ensureDirNoSymlink(volume, ...parent.slice(volume.length).split(sep).filter(Boolean)); }
    catch (error) { throw outFolderRefusal(target, out, error) ?? error; }
    protectedLocalDirectory(parent);
    held = acquireLock(`${out}.mint.lock`, { label: "credential output", waitMs: 0, onTimeout: () => new CommandFailure("refused", "CONFLICT", "another credential writer holds this output") });
    let previous: Buffer | undefined, standing: string | undefined, replaced: Replaced | undefined;
    if (values.out !== undefined) {
      const found = lstatSync(out, { throwIfNoEntry: false });
      if (found) {
        protectedCredentialReference(out); previous = readLocalRecordSource(out, 1024 * 1024, true);
        let old: Identity;
        try { old = identityFromCreds(previous!.toString("utf8")); }
        catch { throw new CommandFailure("refused", "CONFLICT", "the output is not an owned native credential; it was not overwritten"); }
        if (!requestedIdentity || old.id !== requestedIdentity.id) throw new CommandFailure("refused", "CONFLICT", "the output already holds another credential; choose a new output or explicitly re-mint its matching --identity", { target });
      }
    } else {
      standing = await store.get(key);
      if (standing !== undefined && !values.replace) throw new CommandFailure("refused", "CONFLICT", "the named standing credential already exists; it was not replaced", { target, remedy: "choose a new label or an explicit separate private --out path, or replace it with --replace once it has expired, if it has no expiry or if its key was revoked" });
      if (standing !== undefined) replaced = replaceable(standing, name, target, accountRevocations(auth.account.jwt));
    }
    let allowSubscribe: string[] | undefined, allowPublish: string[] | undefined, role: string | undefined;
    if (profile === "agent") {
      const path = agentFilePath(root, name);
      const definition = existsSync(path) ? loadAgentFile(path) : undefined;
      // A flag wins, then the grants of the --identity credential, then the persona.
      const readFlag = csv(values["allow-subscribe"]);
      allowSubscribe = readFlag === undefined && carried ? carried.read : resolveReadAcl(definition?.subscribe ?? [], readFlag ?? definition?.allowSubscribe);
      allowPublish = csv(values["allow-publish"]) ?? carried?.post ?? definition?.allowPublish;
      role = values.role ?? (carried ? carried.role ?? undefined : definition?.role);
      lifecycleUid = mintLifecycleUid();
    }
    identity ??= newIdentity();
    target = { ...target, identity: identity.id, ...(lifecycleUid === undefined ? {} : { lifecycleUid }) };
    // With no lifetime flag the credential gets the default lifetime; only --no-expiry leaves it unbounded.
    const defaultLifetime = values["expires-in"] === undefined && values["expires-at"] === undefined && !values["no-expiry"];
    const options = { allowSubscribe, allowPublish, role, lifecycleUid, expiresInSeconds: values["expires-in"] !== undefined ? Number(values["expires-in"]) : defaultLifetime ? DEFAULT_LIFETIME_SECONDS : undefined, expiresAt: values["expires-at"] === undefined ? undefined : Number(values["expires-at"]) };
    const creds = await mintCreds(auth, identity, profile, options);
    if (values.provision) {
      if (!resolvedTarget.auth || resolvedTarget.auth.account.pub !== auth.account.pub) throw new CommandFailure("refused", "CONFLICT", "the broker target and credential signer do not share one account authority", { target });
      const preflight = await preflightTarget(resolvedTarget);
      if (!preflight.ok) throw new CommandFailure("refused", preflight.kind.includes("creds") || preflight.kind === "stale-auth" ? "AUTH_REQUIRED" : "TARGET_UNAVAILABLE", "the selected broker did not pass the native authenticated provisioning preflight; no stale registration was pruned", { target });
      mayHaveProvisioned = true;
      const provisionedIdentity = identity;
      await provisionForMint(auth, identity, { ...options, lifecycleUid: lifecycleUid! }, resolvedTarget, () => {
        changed.push({ kind: "native-agent-footprint", identity: provisionedIdentity.id, lifecycleUid, space, acknowledged: true });
      });
    }
    publicationStarted = true;
    if (values.out !== undefined) {
      protectedLocalDirectory(dirname(out));
      if (previous) {
        protectedCredentialReference(out);
        const current = readLocalRecordSource(out, 1024 * 1024, true);
        if (!current?.equals(previous)) throw new CommandFailure("refused", "CONFLICT", "the inspected credential output changed; no replacement was made", { target });
        writeSecretFileAtomic(out, creds);
      } else writeSecretFileCreateOnly(out, creds);
    } else if (standing !== undefined) {
      // The replacement lands only over the bytes --replace inspected.
      if (await store.get(key) !== standing) throw new CommandFailure("refused", "CONFLICT", "the standing credential changed after it was inspected; no replacement was made", { target });
      await store.put(key, creds);
      changed.push({ kind: "credential-store", key, space, replaced: true, acknowledged: true });
    } else {
      if (!await store.create(key, creds)) throw new CommandFailure("refused", "CONFLICT", "another writer created the standing credential; its value was not overwritten", { target });
      changed.push({ kind: "credential-store", key, space, acknowledged: true });
      // The workstation filesystem store's canonical key is already this private file.
      // Do not rewrite it after create-only publication or replace another writer's result.
    }
    changed.push({ kind: "private-credential-file", path: out, acknowledged: true });
    const exported = readLocalRecordSource(out, 1024 * 1024, true);
    if (!exported?.equals(Buffer.from(creds, "utf8"))) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "credential publication was acknowledged but the current private output could not be confirmed as this result; no issuance was retried", { target, changed });
    // The request sits beside the file, so doctor auth reports this unbounded credential as one asked for.
    let noExpiryRecord: string | null = null;
    // A replaced credential's no-expiry record names bytes that are gone.
    if (replaced && !values["no-expiry"]) {
      const record = noExpiryRecordPath(out);
      try { unlinkSync(record); changed.push({ kind: "no-expiry-record-removed", path: record, acknowledged: true }); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          throw new CommandFailure("partial", "OPERATION_PARTIAL", `the credential was replaced, but the no-expiry record ${record} of the one it replaced was not removed`, { target, remedy: `remove ${record}; it names a credential that is gone` });
      }
    }
    if (values["no-expiry"]) {
      noExpiryRecord = noExpiryRecordPath(out);
      try { writeSecretFileAtomic(noExpiryRecord, noExpiryRecordText(creds)); }
      catch { throw new CommandFailure("partial", "OPERATION_PARTIAL", `the credential was written, but its no-expiry record ${noExpiryRecord} was not, so doctor auth reports it as an unbounded finding`, { target, remedy: `once nothing uses ${out}, remove it and mint it again with --no-expiry` }); }
      changed.push({ kind: "no-expiry-record", path: noExpiryRecord, acknowledged: true });
    }
    // The record lets doctor auth find this file again; it holds no credential.
    if (values.out !== undefined) {
      try { recordCredentialExport(space, { label: name, profile, path: out, root, identity: identity.id }); }
      catch { throw new CommandFailure("partial", "OPERATION_PARTIAL", `the credential was written to ${out}, but its export record was not, so doctor auth does not list it`, { target, remedy: `mint it again with the same --identity ${out} --out ${out} to record it` }); }
      changed.push({ kind: "credential-export-record", path: out, acknowledged: true });
    }
    const claims = credsClaims(creds);
    const fromIdentity = carried ? ([["read", values["allow-subscribe"]], ["post", values["allow-publish"]], ["role", values.role]] as const).filter(([, flag]) => flag === undefined).map(([grant]) => grant) : [];
    const grants = profile === "agent" ? { read: allowSubscribe ?? [], post: allowPublish ?? [], role: role ?? null, fromIdentity } : null;
    const result = { kind: "credential-minted", name, space, profile, identity: identity.id, principal: principalKey(DEV_OWNER, identity.id).key, lifecycleUid: lifecycleUid ?? null, output: out, provisioned: values.provision === true, identityReused: requestedIdentity !== undefined, grants, lifecycleReused: false, expiresAt: claims.exp ?? null, defaultLifetime, noExpiryRecord, replaced: replaced ?? null, secretOnStdout: false, changed };
    const warnings = [
      ...(result.identityReused && profile === "agent" ? [{ code: "NEW_OUT_OF_BAND_LIFECYCLE", target: { space, name }, message: "The native out-of-band mint reuses the nkey, not the old lifecycle UID. Old inbox/DM footprints were not claimed as reused." }] : []),
      ...replacedStillValid(replaced, identity.id, space, name),
      ...(values.replace ? replaceNotes(replaced, standing !== undefined, profile, space, name, root) : []),
    ];
    writeResult(presentationOf(values), { command: "auth mint", target: { space, name }, result, warnings }, (data): Report => ({ sections: [
      { title: "Private credential written", blocks: [{ kind: "fields", rows: [["Label", data.name], ["Space", data.space], ["Profile", data.profile], ["Principal", data.principal], ["Lifecycle", data.lifecycleUid ?? "not an agent lifecycle"], ...(data.grants ? grantRows(data.grants) : []), ["Private file", data.output], ...(data.replaced ? [["Replaced", `${data.replaced.state === "expired" ? `a credential that expired at ${expiry(data.replaced.expiresAt ?? undefined)}` : data.replaced.state === "revoked" ? `a credential whose key was revoked at ${expiry(data.replaced.revokedAt ?? undefined)}` : "a credential with no expiry claim"}, key ${data.replaced.publicKey}`]] as [string, string][] : []), ["Expiry", data.noExpiryRecord ? `no expiry claim, as --no-expiry asked; recorded in ${data.noExpiryRecord}` : `${expiry(data.expiresAt ?? undefined)}${data.defaultLifetime ? " (the 24-hour default)" : ""}`], ["Broker footprint", data.provisioned ? "native provisioning acknowledged" : "not provisioned by this command"]] }, { kind: "lines", lines: [{ text: "Credential contents were written privately, not printed. Provisioning is not presence, a joined agent or task completion. Fixed observer/admin profiles do not accept agent ACL overrides.", tone: "hint" }] }] },
    ] }));
  } catch (error) {
    if (isCommandFailure(error)) {
      const confirmed = [...changed, ...(error.changed ?? [])];
      if (error.outcome === "unknown") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", error.message, { target, changed: confirmed, remedy: error.remedy });
      if (confirmed.length) throw new CommandFailure("partial", "OPERATION_PARTIAL", error.message, { target, changed: confirmed, remedy: error.outcome === "partial" && error.remedy ? error.remedy : "inspect the named identity, lifecycle and private output before another mint" });
      throw error;
    }
    if (mayHaveProvisioned || publicationStarted) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "provisioning or private publication started, but the final credential outcome is unconfirmed; no mint was retried", { target, changed, remedy: "inspect the original identity/lifecycle and output; do not allocate another identity blindly" });
    throw new CommandFailure("refused", "SCHEMA_INVALID", "native credential preparation failed before provisioning or private publication; file values and secret material were not printed", { target });
  } finally { held?.release(); }
}

const channelList = (channels: readonly string[]) => channels.length ? channels.join(", ") : "no channel";

/** The receipt rows for an agent credential's grants, naming those carried from `--identity`. */
function grantRows(grants: AgentGrants & { fromIdentity: readonly string[] }): [string, string][] {
  const carried = (grant: string) => grants.fromIdentity.includes(grant) ? " (carried from --identity)" : "";
  return [["May read", `${channelList(grants.read)}${carried("read")}`], ["May post", `${channelList(grants.post)}${carried("post")}`], ["Role", `${grants.role ?? "none"}${carried("role")}`]];
}

async function provisionForMint(auth: SpaceAuth, identity: Identity, options: { allowSubscribe?: string[]; allowPublish?: string[]; role?: string; lifecycleUid: string; expiresInSeconds?: number; expiresAt?: number }, target: MeshTarget, onProvisioned: () => void): Promise<void> {
  const provisioner = new CotalEndpoint({ space: target.space, servers: target.server, tls: target.tlsRequired, creds: await mintCreds(auth, newIdentity(), "provisioner"), channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card: { name: "mint-provisioner", role: "provisioner", kind: "endpoint" } });
  provisioner.on("error", () => {});
  try {
    await provisioner.start();
    await provisionAgentDurables(provisioner, { owner: DEV_OWNER, actor: identity.id, lifecycleUid: options.lifecycleUid }, { ...options, subscribe: options.allowSubscribe });
    onProvisioned();
  } finally { await provisioner.stop(); }
}
