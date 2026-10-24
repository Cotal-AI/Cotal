import { isAbsolute } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { token } from "@cotal-ai/core";
import schema from "./service-definition.schema.json" with { type: "json" };

/** The imported local definition, before files, references and an adapter are resolved. Parsing
 *  authorizes no launch and opens no referenced path. The controller must check those separately. */
export interface ServiceDefinitionInput {
  readonly schemaVersion: 1;
  readonly space: string;
  readonly launch:
    | { readonly type: "process"; readonly executable: string; readonly args: readonly string[]; readonly cwd: string }
    | { readonly type: "adapter"; readonly adapter: string; readonly options: Readonly<Record<string, unknown>> };
  readonly readiness:
    | { readonly type: "process"; readonly timeoutMs: number }
    | { readonly type: "http"; readonly url: string; readonly expectedStatus: number; readonly timeoutMs: number }
    | { readonly type: "adapter"; readonly timeoutMs: number };
  readonly envRefs?: Readonly<Record<string, string>>;
  readonly credentialRef?: { readonly kind: "file"; readonly path: string };
}

/** Byte cap applied to JSON content. A file reader must impose the same cap while reading, before
 *  handing this parser a string, and independently verify the opened file's identity and access. */
export const MAX_SERVICE_DEFINITION_BYTES = 256 * 1024;

// This workstation input is not a wire contract. Its fixed local schema uses conditionals and
// protected-name expressions; do not broaden the core wire profile to compile it.
let validate: ValidateFunction<ServiceDefinitionInput> | undefined;
function definitionValidator(): ValidateFunction<ServiceDefinitionInput> {
  return validate ??= new Ajv2020({
    strict: false, allErrors: false, ownProperties: true, validateFormats: false,
  }).compile<ServiceDefinitionInput>(schema);
}

const refuse = (message: string): never => { throw new Error(`service definition: ${message}`); };
const nativeString = (value: string): boolean => !/[\u0000-\u001f\u007f]/u.test(value);

/** Where a closed-schema validator stopped, from its last error, as ` at <field path>` and what is
 *  wrong there. Each segment is printed only when it is a plain identifier or an index, so an
 *  arbitrary user-controlled property name never reaches a message. Empty when it cannot say. */
export function schemaErrorLocation(errors: readonly { keyword: string; instancePath: string; params: Record<string, unknown> }[] | null | undefined): string {
  const last = errors?.at(-1);
  if (!last) return "";
  const field = last.keyword === "additionalProperties" ? last.params.additionalProperty : last.keyword === "required" ? last.params.missingProperty : undefined;
  const parts = [...last.instancePath.split("/").filter(Boolean), ...(field === undefined ? [] : [String(field)])];
  if (!parts.length || parts.some((part) => !/^(?:[A-Za-z_][A-Za-z0-9_-]{0,63}|[0-9]{1,4})$/.test(part))) return "";
  const at = parts.join(".");
  return last.keyword === "additionalProperties" ? ` at ${at}, which the schema does not declare` : last.keyword === "required" ? ` at ${at}, which is required` : ` at ${at}`;
}

const READINESS_FIELDS: Readonly<Record<string, readonly string[]>> = { process: ["type", "timeoutMs"], http: ["type", "url", "expectedStatus", "timeoutMs"], adapter: ["type", "timeoutMs"] };

/** The rule a `readiness` value breaks, for a schema that stopped there. The schema offers three
 *  shapes at once, so its own error names only the field. A field name is printed only when it is a
 *  plain identifier, and no value is echoed. Undefined when no rule here is broken. */
function readinessProblem(readiness: unknown): string | undefined {
  if (typeof readiness !== "object" || readiness === null || Array.isArray(readiness)) return "readiness must be an object with a type of process, http or adapter and a timeoutMs";
  const value = readiness as Record<string, unknown>;
  if (value.type === undefined) return "readiness.type is required: process, http or adapter";
  const fields = typeof value.type === "string" && Object.hasOwn(READINESS_FIELDS, value.type) ? READINESS_FIELDS[value.type]! : undefined;
  if (!fields) return "readiness.type must be process, http or adapter";
  const extra = Object.keys(value).find((key) => !fields.includes(key));
  if (extra !== undefined) return `${/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(extra) ? `readiness.${extra} is` : "readiness has a field that is"} not a field of ${value.type} readiness, which takes ${fields.join(", ")}`;
  const missing = fields.find((field) => value[field] === undefined);
  if (missing !== undefined) return `readiness.${missing} is required for ${value.type} readiness, which takes ${fields.join(", ")}`;
  const whole = (n: unknown, min: number, max: number): boolean => typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
  if (!whole(value.timeoutMs, 1, 120000)) return "readiness.timeoutMs must be a whole number of milliseconds from 1 to 120000";
  if (value.type === "http") {
    if (typeof value.url !== "string" || !/^http:\/\/(127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?\//.test(value.url)) return "readiness.url must be an http:// URL on 127.0.0.1 or [::1] with a path, such as http://127.0.0.1:8080/health";
    if (!whole(value.expectedStatus, 100, 599)) return "readiness.expectedStatus must be a whole number from 100 to 599";
  }
  return undefined;
}

/** Check a case-sensitive definition name before deriving its case-safe storage key. */
export function serviceDefinitionName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value))
    return refuse("the name must be 1 to 64 letters, digits, underscores or hyphens, starting with a letter or digit");
  return value;
}

/** Parse capped version-1 JSON and check local syntax against the explicitly selected space.
 *  This does not validate reference ownership, path existence, installed adapter support/options
 *  or readiness identity. The service controller must resolve them before writing or importing
 *  provider code. No schema is fetched and no host environment value is read here. */
export function parseServiceDefinitionInput(raw: string, selectedSpace: string): ServiceDefinitionInput {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_SERVICE_DEFINITION_BYTES)
    return refuse("JSON content exceeds 256 KiB");
  if (typeof selectedSpace !== "string" || !selectedSpace || selectedSpace.length > 200 || token(selectedSpace) !== selectedSpace)
    return refuse("select a space whose name is a native routing token");
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return refuse("input is not JSON"); }
  // Validator details can contain user-controlled property names. Never publish the raw input or
  // the validator's mutable error array as a diagnostic; only an identifier-shaped location.
  const validator = definitionValidator();
  if (!validator(input)) {
    const stopped = validator.errors?.at(-1)?.instancePath ?? "";
    const readiness = stopped === "/readiness" || stopped.startsWith("/readiness/") ? readinessProblem((input as { readiness?: unknown }).readiness) : undefined;
    return refuse(readiness ?? `input does not match the version-1 definition schema${schemaErrorLocation(validator.errors)}`);
  }
  if (input.space !== selectedSpace) return refuse(`the definition names ${token(input.space) === input.space ? `space "${input.space}"` : "another space"}, and the selected space is "${selectedSpace}"`);
  if (input.launch.type === "process") {
    if (!nativeString(input.launch.executable) || !nativeString(input.launch.cwd) || input.launch.args.some((arg) => arg.includes("\0")))
      return refuse("process arguments or paths contain unsupported control characters");
    if (!isAbsolute(input.launch.cwd)) return refuse("the process working directory must be absolute");
  } else if (!nativeString(input.launch.adapter)) {
    return refuse("the adapter name contains unsupported control characters");
  }
  if (input.credentialRef && (!isAbsolute(input.credentialRef.path) || !nativeString(input.credentialRef.path)))
    return refuse("the credential reference must name an absolute local path");
  if (input.readiness.type === "http") {
    let url: URL;
    try { url = new URL(input.readiness.url); } catch { return refuse("the HTTP readiness URL is invalid"); }
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.port === "0")
      return refuse("HTTP readiness requires a literal loopback HTTP URL and a valid nonzero port");
  }
  return input;
}
