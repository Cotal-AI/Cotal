import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { cacheLocalProcess, extensionPackageDir, type InstalledExtension } from "./extensions.js";
import type { LocalProcess } from "./local-process.js";
import { CommandFailure } from "./output.js";
import { assertProtectedFileAccess, decodeLocalJson, protectedFileAccessAvailable, protectedLocalDirectory, readLocalRecordSource } from "./protected-records.js";
import { cacheServicePreset, type ServicePreset } from "./service-preset.js";
import { serviceAdapterDeclaration, serviceMetadataDigest } from "./service-adapter.js";

function packageMetadata(pkg: string, version: string): string {
  // Resolve the operator-installed package directory once. Check the physical ancestry and pin
  // this bounded descriptor read; this is not an atomic fence against arbitrary same-UID edits.
  let directory: string;
  try { directory = realpathSync(extensionPackageDir(pkg)); }
  catch { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the service adapter package is missing; re-add its extension explicitly"); }
  protectedLocalDirectory(directory);
  const bytes = readLocalRecordSource(join(directory, "package.json"), 1024 * 1024);
  if (!bytes) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the service adapter package metadata is missing; re-add its extension explicitly");
  const meta = decodeLocalJson(bytes) as { name?: unknown; version?: unknown } | null;
  if (!meta || meta.name !== pkg || meta.version !== version) throw new CommandFailure("refused", "CONFLICT", "the installed service adapter package does not match its cached name and version; update or re-add it before use");
  return createHash("sha256").update(bytes).digest("hex");
}

function declarations(processes: readonly LocalProcess[], presets: readonly ServicePreset[]) {
  const order = (a: { name: string }, b: { name: string }) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  return { adapters: processes.filter((component) => component.service !== undefined).map((component) => ({ name: component.name, controllerOnly: component.controllerOnly === true, service: serviceAdapterDeclaration(component.service) })).sort(order), presets: presets.map(cacheServicePreset).sort(order) };
}

/** Run by ext add after its ordinary transactional import. Hashes detect cached declaration or
 *  package-metadata changes; they are neither publisher signatures nor executable-code proofs. */
export function cacheExtensionServiceMetadata(pkg: string, version: string, processes: readonly LocalProcess[], presets: readonly ServicePreset[] = []): InstalledExtension["serviceMetadata"] {
  if (!processes.some((component) => component.service !== undefined) && !presets.length) return undefined;
  for (const component of processes) if (component.service !== undefined && (typeof component.buildServiceLaunch !== "function" || typeof component.checkServiceReadiness !== "function")) throw new CommandFailure("refused", "SCHEMA_INVALID", "a service adapter must provide both declared launch and readiness hooks");
  for (const component of processes) if (component.service?.stop === "native" && (typeof component.prepareServiceStop !== "function" || typeof component.stopService !== "function")) throw new CommandFailure("refused", "SCHEMA_INVALID", "a native stop adapter must provide both impact and terminal hooks; no generic signal fallback was cached");
  // Without protected file access no service adapter can be verified or run here, so the extension
  // installs with no receipt and every service use refuses UNSUPPORTED before reading one.
  if (!protectedFileAccessAvailable()) return undefined;
  return { schemaVersion: 1, packageJsonSha256: packageMetadata(pkg, version), declarationsSha256: serviceMetadataDigest(declarations(processes.map(cacheLocalProcess), presets)) };
}

/** Metadata-only validation. Never imports executable provider code or fetches a schema. */
export function verifiedExtensionServiceProcesses(extension: InstalledExtension): readonly LocalProcess[] {
  assertProtectedFileAccess();
  const receipt = extension.serviceMetadata;
  if (!receipt || receipt.schemaVersion !== 1 || Object.keys(receipt).some((key) => !["schemaVersion", "packageJsonSha256", "declarationsSha256"].includes(key)) || !/^[0-9a-f]{64}$/.test(receipt.packageJsonSha256) || !/^[0-9a-f]{64}$/.test(receipt.declarationsSha256)) throw new CommandFailure("refused", "CONFLICT", "the installed service adapter has no supported declaration-integrity receipt; update or re-add the extension before saving a definition");
  const processes = extension.localProcesses ?? [];
  const presets = extension.servicePresets ?? [];
  if (!Array.isArray(processes) || !Array.isArray(presets) || packageMetadata(extension.pkg, extension.version) !== receipt.packageJsonSha256 || serviceMetadataDigest(declarations(processes, presets)) !== receipt.declarationsSha256) throw new CommandFailure("refused", "CONFLICT", "the cached service declaration or installed package metadata changed; no provider was imported and no service definition was saved");
  return processes.filter((component) => component.service !== undefined);
}

/** Declarative preset inventory with the same package/version/cache checks as its adapters. */
export function verifiedExtensionServicePresets(extension: InstalledExtension): readonly ServicePreset[] {
  verifiedExtensionServiceProcesses(extension);
  return (extension.servicePresets ?? []).map(cacheServicePreset);
}
