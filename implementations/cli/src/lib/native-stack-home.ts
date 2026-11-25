import { join } from "node:path";
import { writeSecretFile, writeSecretFileAtomic } from "@cotal-ai/core";
import { canonicalRoot, checkServer, homeCotalDir, readContainedRecord } from "@cotal-ai/workspace";

interface ReadyTarget { space: string; server: string }

const stackHomePath = (root: string) => join(root, ".cotal", "stack-home.json");

/** A new spawn clears the previous target. Only a registered listener records an address. */
export function writeNativeStackHome(root: string, ready?: ReadyTarget): void {
  root = canonicalRoot(root);
  const home = canonicalRoot(homeCotalDir());
  const path = stackHomePath(root);
  if (ready === undefined) writeSecretFile(path, JSON.stringify({ home }));
  // A reader sees either the spawn marker or the full ready target, never a partial update.
  else writeSecretFileAtomic(path, JSON.stringify({ home, ready: { root, ...ready } }));
}

/** Resolve the last proved dial address without trusting the bind address or scheme in the config. */
export function readNativeReadyServer(root: string, space: string, renderedServer: string): string | undefined {
  root = canonicalRoot(root);
  const record = readContainedRecord(root, stackHomePath(root));
  if (record.state !== "content") return undefined;
  try {
    const saved = JSON.parse(record.raw) as { home?: unknown; ready?: { root?: unknown; space?: unknown; server?: unknown } } | null;
    const ready = saved?.ready;
    if (saved?.home !== canonicalRoot(homeCotalDir()) || ready?.root !== root || ready.space !== space || typeof ready.server !== "string") return undefined;
    if (!checkServer(ready.server, "saved native broker").ok) return undefined;
    const address = new URL(ready.server);
    if ((address.protocol === "nats:" || address.protocol === "tls:") && address.port && address.port === new URL(renderedServer).port) return ready.server;
  } catch { /* Unusable evidence cannot name a preview target. */ }
  return undefined;
}
