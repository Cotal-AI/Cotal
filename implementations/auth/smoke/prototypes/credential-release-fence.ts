import type { KV } from "@nats-io/kv";
import { credRowKey, isCasLoss, parseLedgerRow } from "@cotal-ai/core";

// Test-only adapter over the already shape-verified auth store. Existing token/actor
// authorization must still run; this adds serialization with individual row revocation.
export async function prepareCredentialReleaseFence(kv: KV, uid: string, credentialId: string) {
  const key = credRowKey(uid, credentialId);
  const entry = await kv.get(key);
  if (!entry || entry.operation !== "PUT") throw new Error("credential source fence requires an existing row");
  const row = parseLedgerRow(entry.value, key);
  if (row.state !== "active") throw new Error("credential source fence requires an active row");
  const value = entry.value.slice();
  const revision = entry.revision;
  let consumed = false;
  return Object.freeze({
    key,
    async finalize(finalizeExisting: () => Promise<void>): Promise<void> {
      if (consumed) throw new Error("credential source fence is already consumed");
      consumed = true;
      await finalizeExisting();
      try {
        await kv.update(key, value, revision);
      } catch (error) {
        if (isCasLoss(error)) throw new Error("credential source fence lost its revision; no release", { cause: error });
        throw error;
      }
    },
  });
}
