import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, type Stats } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { endpointToken, token } from "@cotal-ai/core";
import type { ControllerStackView } from "./maintenance.js";
import type { ProcessIdentityRecord } from "./pid.js";
import { schemaErrorLocation, type ServiceDefinitionInput } from "./service-definition.js";
import { CommandFailure } from "./output.js";
import { assertProtectedEntry, protectedCredentialReference, protectedLocalDirectory } from "./protected-records.js";

/** Workstation ABI only. A declaration grants no native endpoint or OS process authority. */
export interface ServiceAdapterDeclaration {
  readonly abiVersion: 1;
  readonly requiresCli?: true;
  readonly optionsSchema: Readonly<Record<string, unknown>>;
  /** Top-level string options that reference local paths, never file contents. */
  readonly paths?: Readonly<Record<string, "file" | "directory" | "private-file">>;
  readonly capabilities: { readonly multiInstance: boolean; readonly foreground: boolean; readonly logs: boolean };
  /** `listener` is a launch-bound listener report from the exact pinned child, never endpoint serving. */
  readonly readiness: "process" | "endpoint" | "listener";
  /** Native stop hooks own their reservation, impact recheck and request-bound terminal evidence.
   *  `kernel-exit` stops only the exact pinned child and records the observed kernel exit; it has no
   *  native acknowledgement, endpoint identity or cleanup proof. */
  readonly stop?: "native" | "kernel-exit";
}

export interface ServiceAdapterContext {
  readonly space: string;
  readonly definition: string;
  readonly definitionRevision: string;
  readonly instanceId: string;
  readonly launchRequestId: string;
  readonly stateDirectory: string;
  readonly cliInvocation?: readonly string[];
  readonly options: Readonly<Record<string, unknown>>;
  readonly credentialRef?: ServiceDefinitionInput["credentialRef"];
  /** The definition's environment references by name, child variable to controller variable. No
   *  value is passed; an adapter reads this to refuse a child environment it cannot check against. */
  readonly envRefs?: ServiceDefinitionInput["envRefs"];
  /** Launch-only inputs bound to one maintenance attempt. Never part of a saved definition, an
   *  instance record or a receipt; only the controller's resume passes it, and each adapter accepts
   *  only its own closed fields (see {@link serviceAdapterAttempt}). */
  readonly attempt?: ServiceAdapterAttempt;
  /** Launch-only facts of the root's controller stack journal, passed to a manager-service launch
   *  while that root holds a maintenance journal. The adapter compares them through
   *  `admittedControllerRestore`; they grant nothing by themselves and are never saved. */
  readonly stack?: ControllerStackView;
}

/** A resume attempt's per-launch inputs. `resumeCommit` names a protected handoff file by path and
 *  digest; the token bytes never travel here. */
export interface ServiceAdapterAttempt {
  readonly kind: "maintenance-resume";
  readonly attemptId: string;
  readonly serverName?: string;
  readonly resumeCommit?: { readonly path: string; readonly sha256: string };
}

/** A plan is returned only on an explicit start, before the controller launches its direct child.
 *  Providers must not launch processes, mint credentials or start dependencies while planning. */
export interface ServiceAdapterLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** A listener the exact pinned child reported for its own launch. It is not endpoint, trust or
 *  storage readiness, and a port answer alone never produces it. */
export interface ServiceAdapterListenerReport {
  readonly kind: "nats-ports-file";
  readonly nats: readonly string[];
}

export type ServiceAdapterReadiness =
  | { readonly state: "pending" }
  | { readonly state: "ready"; readonly process: ProcessIdentityRecord; readonly observedAt: string;
      readonly native?: { readonly endpoint: string; readonly instanceId: string; readonly owner: string; readonly actor: string; readonly lifecycleUid: string; readonly epoch: number };
      /** Present only with `native`: the coordinates are the pinned child's own request-bound local
       *  receipt, not an attributed endpoint response. */
      readonly evidence?: ServiceAdapterNativeEvidence;
      readonly listener?: ServiceAdapterListenerReport };
export type ServiceAdapterNativeEvidence = "local-process-receipt";

export interface ServiceAdapterStopPlan {
  readonly scopeSha256: string;
  readonly observedAt: string;
  readonly withAgents: boolean;
  readonly native: NonNullable<Extract<ServiceAdapterReadiness, { state: "ready" }>["native"]>;
  readonly evidence?: ServiceAdapterNativeEvidence;
  readonly subjects: readonly { readonly name: string; readonly id: string; readonly lifecycleUid: string; readonly action: "stop" | "release-custody" | "stop-retaining-state" }[];
  /** A preserved-exit preview only, with `withAgents: false`: the scope binds this attempt and
   *  inventory digest. */
  readonly preserved?: ServiceAdapterPreservedStop;
}
export interface ServiceAdapterPreservedStop {
  readonly attemptId: string;
  readonly inventorySha256: string;
}
export type ServiceAdapterStopContext = ServiceAdapterContext & {
  readonly process: ProcessIdentityRecord;
  readonly withAgents: boolean;
  readonly signal: AbortSignal;
  /** Present only for a preserved-exit stop. An adapter that does not declare it must refuse. */
  readonly preserved?: ServiceAdapterPreservedStop;
};
export interface ServiceAdapterStopResult {
  readonly requestId: string;
  readonly scopeSha256: string;
  readonly process: ProcessIdentityRecord;
  /** `preserved-exit-returned` only answers a preserved request; the caller checks that pairing. */
  readonly nativeStop: "returned" | "preserved-exit-returned";
  readonly cleanup: "not-checked";
  readonly observedAt: string;
}

/** The exact local broker configuration a kernel-exit stop is bound to. It names no mesh endpoint,
 *  principal or epoch, because a broker process has none. */
export interface ServiceAdapterBrokerBinding {
  readonly kind: "nats-broker";
  readonly root: string;
  readonly space: string;
  readonly server: string;
  readonly configSha256: string;
}

/** Closed kernel-exit preview. Observation data only: it reserves nothing and grants no signal. */
export interface ServiceAdapterKernelStopPlan {
  readonly kind: "kernel-exit";
  readonly scopeSha256: string;
  readonly observedAt: string;
  readonly binding: ServiceAdapterBrokerBinding;
}

/** The observed exit of the exact pinned process after this request's signal. A removed ports file
 *  is the broker's own shutdown trace for that launch, not an acknowledgement or cleanup proof. */
export interface ServiceAdapterKernelStopResult {
  readonly kind: "kernel-exit";
  readonly requestId: string;
  readonly scopeSha256: string;
  readonly process: ProcessIdentityRecord;
  readonly observation: "exact-process-exit";
  readonly brokerShutdownTrace: "ports-file-removed" | "ports-file-retained";
  readonly cleanup: "not-checked";
  readonly observedAt: string;
}

export type ServiceAdapterKernelStopContext = ServiceAdapterContext & {
  readonly process: ProcessIdentityRecord;
  readonly signal: AbortSignal;
};

export interface ServiceAdapterHooks {
  /** Kernel-exit stop scope: the exact binding and every dependant guard, rechecked at effect. */
  readonly prepareKernelStop?: (context: ServiceAdapterKernelStopContext) => Promise<ServiceAdapterKernelStopPlan>;
  /** After the exact process exit, report only the broker's own launch-bound shutdown trace. */
  readonly observeKernelStop?: (context: ServiceAdapterContext & { readonly process: ProcessIdentityRecord }) => "ports-file-removed" | "ports-file-retained";
  readonly prepareServiceStop?: (context: ServiceAdapterStopContext) => Promise<ServiceAdapterStopPlan>;
  readonly stopService?: (context: ServiceAdapterStopContext & { readonly requestId: string; readonly plan: ServiceAdapterStopPlan }) => Promise<ServiceAdapterStopResult>;
  /** A native stop request that outlived its `stopService` call. Returns the same returned result
   *  once this adapter's own `completed` receipt for `requestId` and the exact process exit are both
   *  on record, after releasing the reservation that request took. Undefined retains both. */
  readonly settleServiceStop?: (context: ServiceAdapterContext & { readonly process: ProcessIdentityRecord; readonly requestId: string }) => ServiceAdapterStopResult | undefined;
  readonly buildServiceLaunch?: (context: ServiceAdapterContext) => ServiceAdapterLaunch | Promise<ServiceAdapterLaunch>;
  readonly checkServiceReadiness?: (context: ServiceAdapterContext & { readonly process: ProcessIdentityRecord; readonly signal: AbortSignal }) => Promise<ServiceAdapterReadiness>;
}

const invalid = (message: string): never => { throw new CommandFailure("refused", "SCHEMA_INVALID", message); };
const plainObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const field = (name: string) => /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name) && !["constructor", "prototype", "__proto__"].includes(name);

/** Closed reader for a launch attempt, with the fields one adapter role may receive. Any other key
 *  refuses. Messages name fields, never values, because `resumeCommit` points at a secret file. */
export function serviceAdapterAttempt(input: unknown, allowed: readonly ("serverName" | "resumeCommit")[]): ServiceAdapterAttempt {
  if (!plainObject(input) || Object.keys(input).some((key) => !["kind", "attemptId", ...allowed].includes(key)) || input.kind !== "maintenance-resume") return invalid("the launch attempt has an unsupported shape for this adapter");
  if (typeof input.attemptId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.attemptId)) return invalid("the launch attempt id is not a safe attempt token");
  if (input.serverName !== undefined && (typeof input.serverName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.serverName))) return invalid("the launch attempt server name is invalid");
  let resumeCommit: ServiceAdapterAttempt["resumeCommit"];
  if (input.resumeCommit !== undefined) {
    const commit = input.resumeCommit;
    if (!plainObject(commit) || Object.keys(commit).length !== 2 || typeof commit.path !== "string" || !isAbsolute(commit.path) || commit.path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(commit.path) || typeof commit.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(commit.sha256)) return invalid("the launch attempt resume-commit handoff is invalid");
    resumeCommit = { path: commit.path, sha256: commit.sha256 };
  }
  return { kind: "maintenance-resume", attemptId: input.attemptId, ...(typeof input.serverName === "string" ? { serverName: input.serverName } : {}), ...(resumeCommit ? { resumeCommit } : {}) };
}

/** Finite JSON and sorted keys give cached declarations a stable fingerprint, not a signature. */
export function serviceMetadataDigest(value: unknown): string {
  let nodes = 0;
  const canonical = (input: unknown, depth: number): unknown => {
    if (++nodes > 16384 || depth > 24) return invalid("service metadata exceeds its structural bound");
    if (input === null || typeof input === "string" || typeof input === "boolean" || typeof input === "number" && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map((item) => canonical(item, depth + 1));
    if (!plainObject(input)) return invalid("service metadata must contain only finite JSON values");
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key], depth + 1)]));
  };
  const text = JSON.stringify(canonical(value, 0));
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) return invalid("service metadata exceeds 1 MiB");
  return createHash("sha256").update(text).digest("hex");
}

/** A deliberately closed, bounded JSON Schema subset. No references, regexes, formats, executable
 *  keywords, schema fetching, coercion, defaults or removal of unknown options are admitted. */
export function serviceAdapterDeclaration(input: unknown): ServiceAdapterDeclaration {
  if (!plainObject(input) || Object.keys(input).some((key) => !["abiVersion", "requiresCli", "optionsSchema", "paths", "capabilities", "readiness", "stop"].includes(key)) || input.abiVersion !== 1 || !["process", "endpoint", "listener"].includes(String(input.readiness))) return invalid("the local service adapter declaration has an unsupported ABI or readiness policy");
  if (input.stop !== undefined && input.stop !== "native" && input.stop !== "kernel-exit") return invalid("an adapter stop policy must explicitly select native request-bound control or exact kernel-exit control");
  if ((input.readiness === "listener") !== (input.stop === "kernel-exit")) return invalid("listener readiness and kernel-exit stop are one closed broker policy; neither is accepted alone");
  if (input.requiresCli !== undefined && input.requiresCli !== true) return invalid("an adapter CLI requirement must be explicit");
  const capabilities = input.capabilities;
  if (!plainObject(capabilities) || Object.keys(capabilities).length !== 3 || !["multiInstance", "foreground", "logs"].every((key) => typeof capabilities[key] === "boolean")) return invalid("the local service adapter must declare every supported lifecycle capability");
  let count = 0;
  const visit = (schema: unknown, depth: number): void => {
    if (++count > 2048 || depth > 16 || !plainObject(schema)) return invalid("the adapter option schema is not a bounded closed schema");
    const common = ["type", "title", "description", "enum", "const"];
    const type = schema.type;
    const keywords = type === "object" ? ["properties", "required", "additionalProperties", "maxProperties"]
      : type === "array" ? ["items", "minItems", "maxItems"]
      : type === "string" ? ["minLength", "maxLength"]
      : type === "number" || type === "integer" ? ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] : [];
    if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(type)) || Object.keys(schema).some((key) => !common.includes(key) && !keywords.includes(key))) return invalid("the adapter option schema uses an unsupported keyword or type");
    for (const key of ["title", "description"]) if (schema[key] !== undefined && (typeof schema[key] !== "string" || schema[key].length > 1000)) return invalid("adapter schema descriptions exceed their bounds");
    if (type === "object") {
      if (schema.additionalProperties !== false || !plainObject(schema.properties) || Object.keys(schema.properties).length > 128 || Object.keys(schema.properties).some((key) => !field(key))) return invalid("adapter option objects must enumerate and close their declared fields");
      if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length > 128 || new Set(schema.required).size !== schema.required.length || schema.required.some((key) => typeof key !== "string" || !Object.hasOwn(schema.properties as object, key)))) return invalid("adapter required options must name unique declared fields");
      for (const child of Object.values(schema.properties)) visit(child, depth + 1);
    } else if (type === "array") {
      if (!Number.isSafeInteger(schema.maxItems) || Number(schema.maxItems) < 0 || Number(schema.maxItems) > 256) return invalid("adapter option arrays require a maximum of at most 256 items");
      visit(schema.items, depth + 1);
    }
    for (const key of ["minLength", "maxLength", "minItems", "maxItems", "maxProperties"]) if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || Number(schema[key]) < 0 || Number(schema[key]) > 8192)) return invalid("an adapter schema bound is invalid");
    for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) return invalid("an adapter numeric bound is invalid");
    const scalar = (value: unknown) => value === null || typeof value === "string" && value.length <= 8192 || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
    if (Object.hasOwn(schema, "const") && !scalar(schema.const) || schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 256 || !schema.enum.every(scalar))) return invalid("adapter option alternatives must be bounded scalar values");
  };
  visit(input.optionsSchema, 0);
  if ((input.optionsSchema as Record<string, unknown>).type !== "object") return invalid("adapter options require a closed object schema");
  if (input.paths !== undefined) {
    const properties = (input.optionsSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    if (!plainObject(input.paths) || Object.keys(input.paths).length > 128 || Object.entries(input.paths).some(([key, kind]) => !Object.hasOwn(properties, key) || properties[key]?.type !== "string" || !["file", "directory", "private-file"].includes(String(kind)))) return invalid("adapter path declarations must name declared top-level string options and supported protections");
  }
  serviceMetadataDigest(input);
  try { new Ajv2020({ strict: true, ownProperties: true, validateFormats: false }).compile(input.optionsSchema as object); }
  catch { return invalid("the declared adapter option schema is invalid; schema values were not printed"); }
  return input as unknown as ServiceAdapterDeclaration;
}

export function validateServiceAdapterOptions(declaration: ServiceAdapterDeclaration, options: Readonly<Record<string, unknown>>): void {
  serviceAdapterDeclaration(declaration);
  let check: ValidateFunction, valid: boolean;
  try { check = new Ajv2020({ strict: true, ownProperties: true, validateFormats: false }).compile(declaration.optionsSchema); valid = check(options) === true; }
  catch { return invalid("the adapter options could not be validated against its closed declaration"); }
  if (!valid) return invalid(`the service options do not match the installed adapter's closed schema${schemaErrorLocation(check.errors)}; option values were not printed`);
}

/** Public readiness evidence is closed and bound to a creation-pinned process. The installed
 *  adapter must itself correlate the native instance/lifecycle using its supported authority. */
export function serviceAdapterReadiness(input: unknown): ServiceAdapterReadiness {
  if (!plainObject(input) || !["pending", "ready"].includes(String(input.state)) || Object.keys(input).some((key) => !(input.state === "pending" ? ["state"] : ["state", "process", "observedAt", "native", "evidence", "listener"]).includes(key))) return invalid("the adapter returned an invalid readiness observation");
  if (input.native !== undefined && input.listener !== undefined) return invalid("an adapter readiness names either a native endpoint or a reported listener, never both");
  if (input.evidence !== undefined && (input.evidence !== "local-process-receipt" || input.native === undefined)) return invalid("an adapter readiness evidence kind is unsupported or names no native endpoint");
  if (input.listener !== undefined) {
    const listener = input.listener;
    if (!plainObject(listener) || Object.keys(listener).length !== 2 || listener.kind !== "nats-ports-file" || !Array.isArray(listener.nats) || listener.nats.length < 1 || listener.nats.length > 16 || !listener.nats.every((url) => typeof url === "string" && url.length <= 300 && /^(nats|tls):\/\/[^\s/?#@]+$/.test(url))) return invalid("the adapter readiness has an invalid reported listener");
  }
  if (input.state === "pending") return { state: "pending" };
  const identity = input.process;
  if (!plainObject(identity) || Object.keys(identity).length !== 2 || !Number.isSafeInteger(identity.pid) || Number(identity.pid) <= 0 || typeof identity.token !== "string" || !/^[0-9]+$/.test(identity.token) || typeof input.observedAt !== "string" || input.observedAt.length > 100 || !Number.isFinite(Date.parse(input.observedAt))) return invalid("the adapter readiness has no bounded process identity and observation time");
  if (input.native !== undefined) {
    const native = input.native;
    if (!plainObject(native) || Object.keys(native).length !== 6 || typeof native.endpoint !== "string" || native.endpoint.length > 200 || !["instanceId", "owner", "actor", "lifecycleUid"].every((key) => typeof native[key] === "string" && native[key].length > 0 && native[key].length <= 200 && token(native[key]) === native[key]) || !Number.isSafeInteger(native.epoch) || Number(native.epoch) < 0) return invalid("the adapter readiness has invalid native lifecycle coordinates");
    try { endpointToken(native.endpoint); } catch { return invalid("the adapter readiness has an invalid native endpoint class"); }
  }
  return input as unknown as ServiceAdapterReadiness;
}

/** What a path's own metadata shows, for a refusal to carry: its type, owner and permission bits.
 *  It is read for the message only; the checks that call it make the decision. */
function pathFacts(path: string): string {
  let entry: Stats;
  try { entry = lstatSync(path); } catch { return `${path} is missing or cannot be read`; }
  const type = entry.isSymbolicLink() ? "a symlink" : entry.isDirectory() ? "a directory" : entry.isFile() ? "a file" : "a special file";
  const writable = (entry.mode & 0o022) !== 0 ? ", so group or others can write it" : "";
  return `${path} is ${type} owned by uid ${entry.uid} with mode ${(entry.mode & 0o7777).toString(8).padStart(4, "0")}${writable}`;
}

/** The shallowest directory on `path`'s chain that {@link protectedLocalDirectory} refuses. The rule
 *  is applied from the filesystem root down instead of restated here. */
function refusedAncestor(path: string): string {
  const chain: string[] = [];
  for (let dir = path; ; dir = dirname(dir)) {
    chain.unshift(dir);
    if (dirname(dir) === dir) break;
  }
  for (const dir of chain) {
    try { protectedLocalDirectory(dir); } catch { return dir; }
  }
  return path;
}

/** Reference protection is checked without reading file contents or importing provider code. A
 *  refusal names the option, the path that failed and what that path's metadata shows. */
export function validateServiceAdapterPaths(declaration: ServiceAdapterDeclaration, options: Readonly<Record<string, unknown>>): void {
  for (const [name, kind] of Object.entries(declaration.paths ?? {})) {
    const path = options[name];
    if (path === undefined) continue;
    if (typeof path !== "string" || !isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) return invalid(`the ${name} option must be an absolute path with no terminal controls`);
    if (kind === "private-file") { protectedCredentialReference(path); continue; }
    const unprotected = (refused: string): never => {
      throw new CommandFailure("refused", "PERMISSION_DENIED", `the declared adapter path ${name} is not protected against other local writers: ${pathFacts(refused)}`, { target: { option: name, path, refused } });
    };
    try {
      const parent = kind === "directory" ? path : dirname(path);
      try { protectedLocalDirectory(parent, "the declared adapter path"); }
      catch (error) { if (error instanceof CommandFailure && error.code === "PERMISSION_DENIED") unprotected(refusedAncestor(parent)); throw error; }
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || (kind === "directory" ? !entry.isDirectory() : !entry.isFile())) throw new Error();
      try { assertProtectedEntry("the declared adapter path", path, entry); }
      catch (error) { if (error instanceof CommandFailure && error.code === "PERMISSION_DENIED") unprotected(path); throw error; }
      accessSync(path, constants.R_OK | (kind === "directory" ? constants.X_OK : 0));
    } catch (error) {
      if (error instanceof CommandFailure) throw error;
      throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the declared adapter path ${name} is missing, unreadable or not a physical ${kind === "directory" ? "directory" : "file"}: ${pathFacts(path)}; no contents were printed`, { target: { option: name, path } });
    }
  }
}

/** Full controller-assigned IDs only. These are local operation coordinates, not wire grants. */
export function serviceOperationId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new CommandFailure("refused", "USAGE_INVALID", "use the full controller-assigned service UUID, not a prefix or ordinal");
  return value;
}

/** Closed public stop preview. It is observation data, never a reservation or native grant. */
export function serviceAdapterStopPlan(input: unknown, process: ProcessIdentityRecord): ServiceAdapterStopPlan {
  const optional = (plainObject(input) && input.evidence !== undefined ? 1 : 0) + (plainObject(input) && input.preserved !== undefined ? 1 : 0);
  if (!plainObject(input) || Object.keys(input).length !== 5 + optional || Object.keys(input).some((key) => !["scopeSha256", "observedAt", "withAgents", "native", "evidence", "subjects", "preserved"].includes(key)) || typeof input.scopeSha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.scopeSha256) || typeof input.withAgents !== "boolean" || !Array.isArray(input.subjects) || input.subjects.length > 4096) return invalid("the native stop preview has an unsupported shape or incomplete bounded scope");
  if (input.preserved !== undefined) {
    const preserved = input.preserved;
    if (input.withAgents !== false || !plainObject(preserved) || Object.keys(preserved).length !== 2 || typeof preserved.attemptId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(preserved.attemptId) || !sha256Hex(preserved.inventorySha256)) return invalid("the preserved-exit stop preview binding is invalid or combined with an agent policy");
  }
  serviceAdapterReadiness({ state: "ready", process, observedAt: input.observedAt, native: input.native, ...(input.evidence === undefined ? {} : { evidence: input.evidence }) });
  if (input.native === undefined) return invalid("the native stop preview has no attributed lifecycle");
  for (const row of input.subjects) {
    if (!plainObject(row) || Object.keys(row).length !== 4 || Object.keys(row).some((key) => !["name", "id", "lifecycleUid", "action"].includes(key)) || !["name", "id", "lifecycleUid"].every((key) => typeof row[key] === "string" && row[key].length > 0 && row[key].length <= 200 && !/[\u0000-\u001f\u007f]/u.test(row[key])) || !["stop", "release-custody", "stop-retaining-state"].includes(String(row.action))) return invalid("the native stop preview has an invalid affected subject; no row was silently omitted");
  }
  serviceMetadataDigest(input);
  return input as unknown as ServiceAdapterStopPlan;
}

const sha256Hex = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** Closed kernel-exit preview. A broker binding carries no fabricated endpoint identity. */
export function serviceAdapterKernelStopPlan(input: unknown): ServiceAdapterKernelStopPlan {
  if (!plainObject(input) || Object.keys(input).length !== 4 || input.kind !== "kernel-exit" || !sha256Hex(input.scopeSha256) || typeof input.observedAt !== "string" || input.observedAt.length > 100 || !Number.isFinite(Date.parse(input.observedAt))) return invalid("the kernel-exit stop preview has an unsupported shape");
  const binding = input.binding;
  if (!plainObject(binding) || Object.keys(binding).length !== 5 || binding.kind !== "nats-broker" || !["root", "space", "server"].every((key) => typeof binding[key] === "string" && (binding[key] as string).length > 0 && (binding[key] as string).length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(binding[key] as string)) || !isAbsolute(binding.root as string) || !sha256Hex(binding.configSha256)) return invalid("the kernel-exit stop preview has an invalid broker binding");
  serviceMetadataDigest(input);
  return input as unknown as ServiceAdapterKernelStopPlan;
}

/** Closed kernel-exit receipt: observed exact process exit, never a broker acknowledgement. */
export function serviceAdapterKernelStopResult(input: unknown): ServiceAdapterKernelStopResult {
  if (!plainObject(input) || Object.keys(input).length !== 8 || input.kind !== "kernel-exit" || !sha256Hex(input.scopeSha256) || input.observation !== "exact-process-exit" || !["ports-file-removed", "ports-file-retained"].includes(String(input.brokerShutdownTrace)) || input.cleanup !== "not-checked") return invalid("the kernel-exit stop did not return its closed exact-exit receipt");
  serviceOperationId(input.requestId);
  serviceAdapterReadiness({ state: "ready", process: input.process, observedAt: input.observedAt });
  return input as unknown as ServiceAdapterKernelStopResult;
}

export function serviceAdapterStopResult(input: unknown): ServiceAdapterStopResult {
  if (!plainObject(input) || Object.keys(input).length !== 6 || Object.keys(input).some((key) => !["requestId", "scopeSha256", "process", "nativeStop", "cleanup", "observedAt"].includes(key)) || typeof input.scopeSha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.scopeSha256) || !["returned", "preserved-exit-returned"].includes(String(input.nativeStop)) || input.cleanup !== "not-checked") return invalid("the native stop did not return its request-bound terminal receipt");
  serviceOperationId(input.requestId);
  serviceAdapterReadiness({ state: "ready", process: input.process, observedAt: input.observedAt });
  return input as unknown as ServiceAdapterStopResult;
}
