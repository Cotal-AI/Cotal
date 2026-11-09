import { assertLifecycleToken, mintLifecycleUid, newIdentity, type Identity, type SecretStore } from "@cotal-ai/core";
import { identityOf, spaceSegment } from "@cotal-ai/workspace";

interface RegistryIdentity {
  instanceId: string;
  serveIdentity: Identity;
}

/** Registry identity is separate from auth's own identity and pinned to the tenant account.
 * Registration operation and repair progress stay in the native epgate/eprepair records. */
export async function claimRegistryIdentity(store: SecretStore, space: string, accountPublicKey: string): Promise<RegistryIdentity> {
  const key = `auth/${spaceSegment(space)}/registry-instance.json`;
  const parse = (raw: string): RegistryIdentity => {
    let value: Record<string, unknown>;
    try { value = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error("the registry identity is not valid JSON; restore the original identity"); }
    if (!value || value.v !== 1 || value.space !== space || value.accountPublicKey !== accountPublicKey
      || Object.keys(value).sort().join(",") !== "accountPublicKey,instanceId,serveIdentity,space,v")
      throw new Error("the registry identity is malformed or belongs to another account; it was not replaced");
    const serveIdentity = identityOf(value.serveIdentity);
    if (!serveIdentity) throw new Error("the registry serving identity is malformed; restore the original identity");
    return { instanceId: assertLifecycleToken(value.instanceId as string, "registry instanceId"), serveIdentity };
  };
  const prior = await store.get(key);
  if (prior !== undefined) return parse(prior);
  const value = { v: 1, space, accountPublicKey, instanceId: mintLifecycleUid(), serveIdentity: newIdentity() };
  if (await store.create(key, JSON.stringify(value))) return { instanceId: value.instanceId, serveIdentity: value.serveIdentity };
  const winner = await store.get(key);
  if (winner === undefined) throw new Error("the registry identity create was not confirmed; no replacement was minted");
  return parse(winner);
}
