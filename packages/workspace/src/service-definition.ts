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
  // the validator's mutable error array as a diagnostic.
  const validator = definitionValidator();
  if (!validator(input)) return refuse("input does not match the version-1 definition schema");
  if (input.space !== selectedSpace) return refuse("the definition names a different selected space");
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
