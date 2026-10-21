import { existsSync, lstatSync } from "node:fs";
import { dirname, parse, resolve, sep } from "node:path";
import {
  CotalEndpoint, DEV_OWNER, acquireLock, agentFilePath, credsClaims, ensureDirNoSymlink, identityFromCreds,
  loadAgentFile, mintCreds, mintLifecycleUid, newIdentity, principalKey, provisionAgentDurables,
  resolveReadAcl, writeSecretFileAtomic, writeSecretFileCreateOnly,
  type FlagValues, type Identity, type ParsedArgs, type Profile, type SpaceAuth,
} from "@cotal-ai/core";
import {
  CommandFailure, assertExternalCredentialExport, agentCredsKey, agentSecretFilePaths, credentialMintFlags,
  isCommandFailure, preflightTarget, presentationOf,
  protectedCredentialReference, protectedLocalDirectory, readLocalRecordSource,
  validateCredentialMintArguments,
  writeResult, type MeshTarget, type Report,
} from "@cotal-ai/workspace";

import { staticMintAuthority } from "../lib/credential-authority.js";
import { mintEndpointCaller } from "./mint-endpoint-caller.js";
export { resolveMintTarget } from "../lib/credential-authority.js";

const csv = (value: string | undefined): string[] | undefined => value === undefined ? undefined : value.split(",").map((item) => item.trim()).filter(Boolean);
const expiry = (seconds: number | undefined): string => {
  if (seconds === undefined) return "no expiry claim in the native result";
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : `${seconds} native Unix seconds`;
};

/** Native static profiles only. Labels, files and broker provisioning share one resolved authority. */
export async function mint(args: ParsedArgs): Promise<void> {
  validateCredentialMintArguments(args);
  if (args.values.endpoint !== undefined) return mintEndpointCaller(args);
  const values = args.values as FlagValues<typeof credentialMintFlags>;
  const name = args.positionals[0]!;
  const profile = (values.profile ?? "agent") as Profile;
  const changed: Record<string, unknown>[] = [];
  let mayHaveProvisioned = false, publicationStarted = false;
  let identity: Identity | undefined, lifecycleUid: string | undefined;
  let held: ReturnType<typeof acquireLock> | undefined;
  let target: { space?: string; name: string; profile: string; path?: string; identity?: string; lifecycleUid?: string } = { name, profile };
  try {
    const { target: resolvedTarget, currentRoot, store, auth } = await staticMintAuthority(values, target);
    const { root, space } = resolvedTarget;
    target = { ...target, space };
    if (values.identity !== undefined) {
      const path = resolve(values.identity);
      protectedCredentialReference(path);
      const bytes = readLocalRecordSource(path, 1024 * 1024, true);
      if (!bytes) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the protected identity source disappeared");
      try { identity = identityFromCreds(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the identity source has no matching native JWT subject and user nkey seed; contents were not printed"); }
    }
    const requestedIdentity = identity;
    const key = agentCredsKey(space, name, { injected: false, root });
    const out = resolve(values.out ?? agentSecretFilePaths(root, space, name).creds);
    target = { ...target, path: out };
    if (values.out !== undefined) assertExternalCredentialExport(out, [root, currentRoot]);
    const parent = dirname(out), volume = parse(parent).root;
    ensureDirNoSymlink(volume, ...parent.slice(volume.length).split(sep).filter(Boolean));
    protectedLocalDirectory(parent);
    held = acquireLock(`${out}.mint.lock`, { label: "credential output", waitMs: 0, onTimeout: () => new CommandFailure("refused", "CONFLICT", "another credential writer holds this output") });
    let previous: Buffer | undefined;
    if (values.out !== undefined) {
      const found = lstatSync(out, { throwIfNoEntry: false });
      if (found) {
        protectedCredentialReference(out); previous = readLocalRecordSource(out, 1024 * 1024, true);
        let old: Identity;
        try { old = identityFromCreds(previous!.toString("utf8")); }
        catch { throw new CommandFailure("refused", "CONFLICT", "the output is not an owned native credential; it was not overwritten"); }
        if (!requestedIdentity || old.id !== requestedIdentity.id) throw new CommandFailure("refused", "CONFLICT", "the output already holds another credential; choose a new output or explicitly re-mint its matching --identity", { target });
      }
    } else if (await store.get(key) !== undefined) throw new CommandFailure("refused", "CONFLICT", "the named standing credential already exists; it was not replaced", { target, remedy: "choose a new label or an explicit separate private --out path" });
    let allowSubscribe: string[] | undefined, allowPublish: string[] | undefined, role: string | undefined;
    if (profile === "agent") {
      const path = agentFilePath(root, name);
      const definition = existsSync(path) ? loadAgentFile(path) : undefined;
      allowSubscribe = resolveReadAcl(definition?.subscribe ?? [], csv(values["allow-subscribe"]) ?? definition?.allowSubscribe);
      allowPublish = csv(values["allow-publish"]) ?? definition?.allowPublish;
      role = values.role ?? definition?.role;
      lifecycleUid = mintLifecycleUid();
    }
    identity ??= newIdentity();
    target = { ...target, identity: identity.id, ...(lifecycleUid === undefined ? {} : { lifecycleUid }) };
    const options = { allowSubscribe, allowPublish, role, lifecycleUid, expiresInSeconds: values["expires-in"] === undefined ? undefined : Number(values["expires-in"]), expiresAt: values["expires-at"] === undefined ? undefined : Number(values["expires-at"]) };
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
    } else {
      if (!await store.create(key, creds)) throw new CommandFailure("refused", "CONFLICT", "another writer created the standing credential; its value was not overwritten", { target });
      changed.push({ kind: "credential-store", key, space, acknowledged: true });
      // The workstation filesystem store's canonical key is already this private file.
      // Do not rewrite it after create-only publication or replace another writer's result.
    }
    changed.push({ kind: "private-credential-file", path: out, acknowledged: true });
    const exported = readLocalRecordSource(out, 1024 * 1024, true);
    if (!exported?.equals(Buffer.from(creds, "utf8"))) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "credential publication was acknowledged but the current private output could not be confirmed as this result; no issuance was retried", { target, changed });
    const claims = credsClaims(creds);
    const result = { kind: "credential-minted", name, space, profile, identity: identity.id, principal: principalKey(DEV_OWNER, identity.id).key, lifecycleUid: lifecycleUid ?? null, output: out, provisioned: values.provision === true, identityReused: requestedIdentity !== undefined, lifecycleReused: false, expiresAt: claims.exp ?? null, secretOnStdout: false, changed };
    const warnings = result.identityReused && profile === "agent" ? [{ code: "NEW_OUT_OF_BAND_LIFECYCLE", target: { space, name }, message: "The native out-of-band mint reuses the nkey, not the old lifecycle UID. Old inbox/DM footprints were not claimed as reused." }] : [];
    writeResult(presentationOf(values), { command: "auth mint", target: { space, name }, result, warnings }, (data): Report => ({ sections: [
      { title: "Private credential written", blocks: [{ kind: "fields", rows: [["Label", data.name], ["Space", data.space], ["Profile", data.profile], ["Principal", data.principal], ["Lifecycle", data.lifecycleUid ?? "not an agent lifecycle"], ["Private file", data.output], ["Expiry", expiry(data.expiresAt ?? undefined)], ["Broker footprint", data.provisioned ? "native provisioning acknowledged" : "not provisioned by this command"]] }, { kind: "lines", lines: [{ text: "Credential contents were written privately, not printed. Provisioning is not presence, a joined agent or task completion. Fixed observer/admin profiles do not accept agent ACL overrides.", tone: "hint" }] }] },
    ] }));
  } catch (error) {
    if (isCommandFailure(error)) {
      const confirmed = [...changed, ...(error.changed ?? [])];
      if (error.outcome === "unknown") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", error.message, { target, changed: confirmed, remedy: error.remedy });
      if (confirmed.length) throw new CommandFailure("partial", "OPERATION_PARTIAL", error.message, { target, changed: confirmed, remedy: "inspect the named identity, lifecycle and private output before another mint" });
      throw error;
    }
    if (mayHaveProvisioned || publicationStarted) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "provisioning or private publication started, but the final credential outcome is unconfirmed; no mint was retried", { target, changed, remedy: "inspect the original identity/lifecycle and output; do not allocate another identity blindly" });
    throw new CommandFailure("refused", "SCHEMA_INVALID", "native credential preparation failed before provisioning or private publication; file values and secret material were not printed", { target });
  } finally { held?.release(); }
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
