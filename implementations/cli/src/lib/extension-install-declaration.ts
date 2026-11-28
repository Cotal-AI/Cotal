import { randomUUID } from "node:crypto";
import { registry } from "@cotal-ai/core";
import {
  BUILT_IN_PACKAGES, RESERVED_CONNECTOR_NAMES, cacheDeclaredServiceMetadata, extensionProvides, providedWords, readPluginDeclaration,
  seededCommandsMismatch, type InstalledExtension, type InstalledExtensionPackage,
} from "@cotal-ai/workspace";

/** Name the package when its declaration cannot be read. */
export function readExtensionDeclaration(pkg: string, raw: unknown) {
  try { return readPluginDeclaration(raw); }
  catch (error) {
    throw new Error(`${pkg}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Verify claims and construct the installed entry from package metadata alone. */
export function declaredExtensionEntry(pkg: string, spec: string, metadata: InstalledExtensionPackage, recorded: readonly InstalledExtension[], seeded: boolean): InstalledExtension {
  if (metadata.cotal === undefined) {
    const reinstall = pkg.startsWith("@cotal-ai/") ? pkg : `${pkg}@latest`;
    throw new Error(`${pkg} was built for the old contract; run \`cotal ext add ${reinstall}\` to install a compatible version`);
  }
  if (Object.hasOwn(BUILT_IN_PACKAGES, pkg)) throw new Error(`${pkg} is built into this CLI.`);
  for (const name of [...Object.keys(metadata.dependencies ?? {}), ...Object.keys(metadata.peerDependencies ?? {})]) {
    if (name === "@cotal-ai/workspace" || Object.hasOwn(BUILT_IN_PACKAGES, name))
      throw new Error(`${pkg} declares ${name}; that package shares process state with the CLI and cannot be a plugin dependency or peer`);
  }
  const declaration = readExtensionDeclaration(pkg, metadata.cotal);
  for (const provided of declaration.provides) {
    for (const word of providedWords(provided)) {
      if (provided.kind === "connector" && RESERVED_CONNECTOR_NAMES.includes(word))
        throw new Error(`${pkg} contributes connector "${word}", which is a reserved name`);
      if (registry.has(provided.kind, word) || registry.provides(provided.kind, word))
        throw new Error(`${pkg} contributes ${provided.kind} "${word}", already provided by this CLI`);
      const other = recorded.find((entry) => entry.pkg !== pkg && !Object.hasOwn(BUILT_IN_PACKAGES, entry.pkg) && extensionProvides(entry).some((ref) => ref.kind === provided.kind && providedWords(ref).includes(word)));
      if (other) throw new Error(`${pkg} contributes ${provided.kind} "${word}", already provided by installed extension ${other.pkg}@${other.version}; run \`cotal ext remove ${other.pkg}\` first if you want this one`);
    }
  }
  const mismatch = seeded ? seededCommandsMismatch(pkg, declaration.commands) : undefined;
  if (mismatch) throw new Error(mismatch);
  return {
    pkg, spec, version: metadata.version, installId: randomUUID(), ...(seeded ? { source: "seeded" } : {}),
    provides: declaration.provides, commands: declaration.commands, connectors: declaration.connectors,
    localProcesses: declaration.localProcesses, servicePresets: declaration.servicePresets,
    serviceMetadata: cacheDeclaredServiceMetadata(pkg, metadata.version, declaration.localProcesses ?? [], declaration.servicePresets ?? []),
  };
}
