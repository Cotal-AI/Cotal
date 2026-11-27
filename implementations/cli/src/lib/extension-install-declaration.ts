import { randomUUID } from "node:crypto";
import { registry } from "@cotal-ai/core";
import {
  RESERVED_CONNECTOR_NAMES, cacheDeclaredServiceMetadata, extensionProvides, providedWords, readPluginDeclaration,
  seededCommandsMismatch, type InstalledExtension, type InstalledExtensionPackage,
} from "@cotal-ai/workspace";

/** Verify claims and construct the installed entry from package metadata alone. */
export function declaredExtensionEntry(pkg: string, spec: string, metadata: InstalledExtensionPackage, recorded: readonly InstalledExtension[], seeded: boolean): InstalledExtension {
  const declaration = readPluginDeclaration(metadata.cotal);
  for (const provided of declaration.provides) {
    for (const word of providedWords(provided)) {
      if (provided.kind === "connector" && RESERVED_CONNECTOR_NAMES.includes(word))
        throw new Error(`contributes connector "${word}", which is a reserved name`);
      if (registry.has(provided.kind, word) || registry.provides(provided.kind, word))
        throw new Error(`contributes ${provided.kind} "${word}", already provided by this CLI`);
      const other = recorded.find((entry) => entry.pkg !== pkg && extensionProvides(entry).some((ref) => ref.kind === provided.kind && providedWords(ref).includes(word)));
      if (other) throw new Error(`contributes ${provided.kind} "${word}", already provided by installed extension ${other.pkg}@${other.version}; run \`cotal ext remove ${other.pkg}\` first if you want this one`);
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
