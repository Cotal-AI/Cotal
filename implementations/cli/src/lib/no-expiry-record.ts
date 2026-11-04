import { createHash } from "node:crypto";
import { readLocalRecordSource } from "@cotal-ai/workspace";

/** What `auth mint --no-expiry` writes beside the credential file it issued, so `doctor auth` can
 *  tell an unbounded credential someone asked for from one nobody chose. It names the file's bytes,
 *  so a record left beside a replaced or copied file covers nothing. */
interface NoExpiryRecord {
  readonly schemaVersion: 1;
  readonly kind: "credential-no-expiry";
  readonly requestedAt: string;
  readonly credsSha256: string;
}

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The record's path: `<credential file>.no-expiry.json`. */
export const noExpiryRecordPath = (credsPath: string): string => `${credsPath}.no-expiry.json`;

/** The record's text for a credential with these bytes, requested now. */
export function noExpiryRecordText(creds: string): string {
  const record: NoExpiryRecord = { schemaVersion: 1, kind: "credential-no-expiry", requestedAt: new Date().toISOString(), credsSha256: sha256(creds) };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** When `auth mint --no-expiry` asked for the credential at `credsPath`, if the private record beside
 *  it names these bytes. A missing, unreadable, malformed or mismatched record is no request. */
export function noExpiryRequestedAt(credsPath: string, bytes: Uint8Array): string | undefined {
  let value: Partial<NoExpiryRecord>;
  try {
    const raw = readLocalRecordSource(noExpiryRecordPath(credsPath), 64 * 1024, true);
    if (!raw) return undefined;
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as Partial<NoExpiryRecord>;
  } catch {
    return undefined;
  }
  const known = value && typeof value === "object" && value.schemaVersion === 1 && value.kind === "credential-no-expiry";
  return known && typeof value.requestedAt === "string" && Number.isFinite(Date.parse(value.requestedAt)) && value.credsSha256 === sha256(bytes) ? value.requestedAt : undefined;
}
