import { createHash } from "node:crypto";
import { join } from "node:path";
import { unlinkFileNoFollow, writeSecretFileAtomic } from "@cotal-ai/core";
import { canonicalRoot, checkServer, homeCotalDir, readContainedRecord } from "@cotal-ai/workspace";

const receiptPath = (root: string) => join(root, ".cotal", "native-ready-target.json");

function scopeOf(root: string): string {
  return createHash("sha256").update(JSON.stringify([root, canonicalRoot(homeCotalDir())])).digest("hex");
}

/** A rendered configuration is launch intent, not evidence that its listener served. */
export function clearNativeReadyTarget(root: string): void {
  unlinkFileNoFollow(receiptPath(root));
}

/** Keep preview evidence separate from stack-home.json, which native teardown must be able to read. */
export function recordNativeReadyTarget(root: string, space: string, server: string): void {
  root = canonicalRoot(root);
  writeSecretFileAtomic(receiptPath(root), JSON.stringify({ scope: scopeOf(root), space, server }));
}

/** Resolve the last proved dial address without trusting the bind address or scheme in the config. */
export function readNativeReadyServer(root: string, space: string, renderedServer: string): string | undefined {
  root = canonicalRoot(root);
  const record = readContainedRecord(root, receiptPath(root));
  if (record.state !== "content") return undefined;
  try {
    const ready = JSON.parse(record.raw) as { scope?: unknown; space?: unknown; server?: unknown } | null;
    if (ready?.scope !== scopeOf(root) || ready.space !== space || typeof ready.server !== "string") return undefined;
    if (!checkServer(ready.server, "saved native broker").ok) return undefined;
    const address = new URL(ready.server);
    if ((address.protocol === "nats:" || address.protocol === "tls:") && address.port && address.port === new URL(renderedServer).port) return ready.server;
  } catch { /* Unusable evidence cannot name a preview target. */ }
  return undefined;
}
