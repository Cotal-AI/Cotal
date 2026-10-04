import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import { assertLifecycleToken } from "./subjects.js";

/** The env var naming the handoff file inside the child. It carries a path, never a secret. */
export const MANAGED_HANDOFF_FILE_ENV = "COTAL_MANAGED_HANDOFF_FILE";

/** The discriminator a handoff document carries. A redeem body is not a handoff and is refused. */
export const MANAGED_HANDOFF_KIND = "cotal-managed-handoff/v1";

/** The coordinate one enrollment issued. */
export interface ManagedLifecycleTarget {
  readonly space: string;
  readonly owner: string;
  readonly actor: string;
  readonly lifecycleUid: string;
}

/** One already-enrolled lifecycle's issued material, by value. Closed: an unknown field refuses. */
export interface ManagedLifecycleHandoff extends ManagedLifecycleTarget {
  readonly kind: typeof MANAGED_HANDOFF_KIND;
  readonly server: string;
  readonly tlsRequired: boolean;
  readonly authProvider: string;
  readonly idp: { readonly url: string; readonly issuer: string; readonly audience: string };
  /** The enrollment's `agentBearerExchangeUrl`. HTTPS, or plain HTTP to a loopback IP literal. */
  readonly exchangeUrl: string;
  readonly sentinelCreds: string;
  readonly actorToken: string;
  readonly subscribe: readonly string[];
  readonly allowSubscribe: readonly string[];
  readonly allowPublish: readonly string[];
  readonly policy?: { readonly events: "required" };
}

const TARGET_FIELDS = ["space", "owner", "actor", "lifecycleUid"] as const;
const STRING_FIELDS = [...TARGET_FIELDS, "kind", "server", "authProvider", "exchangeUrl", "sentinelCreds", "actorToken"] as const;
const LIST_FIELDS = ["subscribe", "allowSubscribe", "allowPublish"] as const;
const FIELDS = new Set<string>([...STRING_FIELDS, ...LIST_FIELDS, "tlsRequired", "idp", "policy"]);
const IDP_FIELDS = ["url", "issuer", "audience"] as const;

/** Validate the handoff text against the coordinate the runtime passed beside it. Throws a
 *  sentence naming the first malformed or mismatched field, never a value. Opens nothing. */
export function parseManagedLifecycleHandoff(text: string, expected: ManagedLifecycleTarget): ManagedLifecycleHandoff {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("the managed handoff is not JSON");
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc) || doc.kind !== MANAGED_HANDOFF_KIND)
    throw new Error(`the managed handoff is not a ${MANAGED_HANDOFF_KIND} document`);
  const extra = Object.keys(doc).find((k) => !FIELDS.has(k));
  if (extra !== undefined) throw new Error(`the managed handoff carries an unknown field "${extra}"`);
  for (const k of STRING_FIELDS)
    if (typeof doc[k] !== "string" || !doc[k]) throw new Error(`the managed handoff's ${k} is not a non-empty string`);
  const idp = doc.idp as Record<string, unknown> | null;
  if (idp === null || typeof idp !== "object" || Array.isArray(idp) || Object.keys(idp).length !== IDP_FIELDS.length ||
      IDP_FIELDS.some((k) => typeof idp[k] !== "string" || !idp[k]))
    throw new Error("the managed handoff's idp is not exactly { url, issuer, audience } with non-empty strings");
  if (typeof doc.tlsRequired !== "boolean") throw new Error("the managed handoff's tlsRequired is not a boolean");
  for (const k of TARGET_FIELDS)
    if (doc[k] !== expected[k]) throw new Error(`the managed handoff's ${k} does not match the expected ${k}`);
  checkField("lifecycleUid", () => assertLifecycleToken(doc.lifecycleUid as string));
  let exchange: URL;
  try {
    exchange = new URL(doc.exchangeUrl as string);
  } catch {
    throw new Error("the managed handoff's exchangeUrl is not a URL");
  }
  if (exchange.protocol !== "https:" && !(exchange.protocol === "http:" && isLoopbackLiteral(exchange.hostname)))
    throw new Error("the managed handoff's exchangeUrl must be https://, except for a loopback HTTP literal");
  for (const k of LIST_FIELDS)
    if (!Array.isArray(doc[k]) || !(doc[k] as unknown[]).every((s) => typeof s === "string"))
      throw new Error(`the managed handoff's ${k} is not an array of strings`);
  const policy = doc.policy as Record<string, unknown> | undefined | null;
  if (policy !== undefined &&
      (policy === null || typeof policy !== "object" || Array.isArray(policy) || Object.keys(policy).length !== 1 || policy.events !== "required"))
    throw new Error('the managed handoff\'s policy is not exactly { events: "required" }');
  return doc as unknown as ManagedLifecycleHandoff;
}

/** Run a shared validator over one handoff field. Its diagnostic may quote the value, and a
 *  handoff refusal never echoes one, so any failure becomes a sentence naming only the field. */
function checkField(field: string, validate: () => unknown): void {
  try {
    validate();
  } catch {
    throw new Error(`the managed handoff's ${field} is malformed`);
  }
}

/** The `agent-bearer --exchange-url` transport rule, so the child refuses at parse what its bearer
 *  preflight would refuse later: the actor token never crosses plaintext off the child's machine,
 *  and a name such as localhost gets no exception because resolution picks where the token goes. */
function isLoopbackLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIPv4(host)) return host.startsWith("127.");
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) return parseInt(mappedHex[1], 16) >> 8 === 127;
  if (!isIPv6(host)) return false;
  if (host === "::1") return true;
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped !== null && mapped[1].startsWith("127.");
}

/** Take the handoff file into memory and remove it: open the path without following a link,
 *  unlink it, then read it. Refuses a missing path, a non-regular file, a mode other than 0600 on
 *  POSIX, or an empty file, after unlinking whatever is not a directory. A refusal names the
 *  check, never the contents. Its one caller is the CLI's custody, which runs before anything else
 *  the CLI does, so no outcome can leave the file behind. */
export function takeManagedHandoffFile(path: string): string {
  let fd: number;
  try {
    // NONBLOCK so a FIFO planted at the path cannot hang the open.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error("the managed handoff file does not exist");
    let isDir = false;
    try {
      isDir = lstatSync(path).isDirectory();
    } catch {}
    if (!isDir) unlinkSync(path);
    throw new Error(`the managed handoff file cannot be opened as a regular file (${code})`);
  }
  try {
    const st = fstatSync(fd);
    if (st.isDirectory()) throw new Error("the managed handoff path is a directory");
    unlinkSync(path);
    if (!st.isFile()) throw new Error("the managed handoff path is not a regular file");
    if (process.platform !== "win32" && (st.mode & 0o777) !== 0o600) throw new Error("the managed handoff file must have mode 0600");
    const text = readFileSync(fd, "utf8");
    if (!text) throw new Error("the managed handoff file is empty");
    return text;
  } finally {
    closeSync(fd);
  }
}

/** The provider key a delegated seat's runtime resource is created under. A pure function of the
 *  full target, so any party with provider authority closes the resource by lifecycle, never by
 *  name: `cotal-` and the first 32 lowercase hex characters of the SHA-256 of the UTF-8 bytes of
 *  `JSON.stringify([space, owner, actor, lifecycleUid])`. */
export function managedRuntimeKey(target: ManagedLifecycleTarget): string {
  const text = JSON.stringify([target.space, target.owner, target.actor, target.lifecycleUid]);
  return `cotal-${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32)}`;
}
