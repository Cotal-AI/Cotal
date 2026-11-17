import { dirname, resolve, sep } from "node:path";
import { credsClaims, credsProblem, idFromCreds, writeSecretFileCreateOnly } from "@cotal-ai/core";
import {
  CommandFailure,
  assertExternalCredentialExport,
  checkBundleDocument,
  findMesh,
  isMeshRegistryError,
  protectedCredentialReference,
  protectedLocalDirectory,
  readLocalRecordSource,
  userAuthStateDir,
  writeResult,
  type Presentation,
} from "@cotal-ai/workspace";
import { registryFailure } from "../lib/registry-errors.js";
import { checkServer, checkSpaceName } from "./meshes-add.js";

/** Copy one remote registration's connection pins and existing sentinel to private output. */
export function spaceExport(rest: readonly string[], out: string | undefined, presentation: Presentation): void {
  if (rest.length !== 1 || !rest[0]?.trim() || !out?.trim() || /[\u0000-\u001f\u007f]/u.test(out))
    throw new CommandFailure("refused", "USAGE_INVALID", "usage: cotal space export <name> --out <private-file>");
  const name = rest[0], path = resolve(out);
  if (!checkSpaceName(name).ok) throw new CommandFailure("refused", "USAGE_INVALID", "the requested space name is invalid");
  let entry;
  try { entry = findMesh(name); }
  catch (error) { throw isMeshRegistryError(error) ? registryFailure(error) : error; }
  if (!entry) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the named space is not registered on this machine", { target: { space: name } });
  const auth = entry.mode === "user" ? entry.userAuth : undefined;
  if (!auth || auth.remote !== true)
    throw new CommandFailure("refused", "UNSUPPORTED", "space export requires a registered remote user-auth space; no signing authority is exported", { target: { space: name } });
  const custody = userAuthStateDir(entry.catalogRoot ?? entry.root, name, { readOnly: true });
  const source = auth.sentinelCredsPath;
  if (!source || !resolve(source).startsWith(resolve(custody) + sep))
    throw new CommandFailure("refused", "SCHEMA_INVALID", "the registered sentinel is not bound to this space's credential custody; nothing was exported");
  assertExternalCredentialExport(path, [entry.root, entry.catalogRoot ?? entry.root]);
  protectedLocalDirectory(dirname(path));
  protectedCredentialReference(source);
  const bytes = readLocalRecordSource(source, 64 * 1024, true);
  if (!bytes) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the registered sentinel is missing; nothing was exported");
  let sentinelCreds: string;
  try {
    sentinelCreds = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const id = idFromCreds(sentinelCreds), claims = credsClaims(sentinelCreds), nats = claims.nats;
    // Local shape checks do not attest issuer trust or current broker admission.
    if (credsProblem(sentinelCreds) || !id.startsWith("U") || claims.sub !== id ||
        !Array.isArray(nats?.pub?.deny) || !nats.pub.deny.includes(">") ||
        !Array.isArray(nats?.sub?.deny) || !nats.sub.deny.includes(">") || Object.hasOwn(nats, "resp")) throw new Error();
  } catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the registered sentinel is not a deny-all user credential; nothing was exported"); }
  const bundle = checkBundleDocument({
    space: entry.space,
    server: entry.server,
    tlsRequired: entry.tlsRequired === true,
    userAuth: { provider: auth.provider, idp: auth.idp, endpoints: auth.endpoints },
    ...(entry.policy ? { policy: entry.policy } : {}),
    sentinelCreds,
  });
  if (!bundle.ok || !sentinelCreds.trim() || !checkServer(entry.server, "the registered server").ok)
    throw new CommandFailure("refused", "SCHEMA_INVALID", "the registered connection bundle is incomplete or invalid; nothing was exported");
  const material = JSON.stringify(bundle.value, null, 2) + "\n";
  try { writeSecretFileCreateOnly(path, material); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CommandFailure("refused", "CONFLICT", "the export path already exists; nothing was overwritten", { target: { space: name, path } });
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "private bundle publication was attempted but its outcome is unconfirmed; no write was retried", { target: { space: name, path }, remedy: "inspect the private output before another export; do not paste its contents into support output" });
  }
  const result = { space: name, path, contains: "connection pins and sentinel credentials", liveAuthorityChecked: false, credentialIssued: false, secretOnStdout: false };
  writeResult(presentation, { command: "space", target: { space: name }, result }, () => ({ sections: [{ title: "Connection bundle exported", blocks: [
    { kind: "fields", rows: [["space", name], ["file", path]] },
    { kind: "lines", lines: [{ text: "Keep this file private. Sign-in and current space access are still required.", tone: "hint" }] },
  ] }] }));
}
