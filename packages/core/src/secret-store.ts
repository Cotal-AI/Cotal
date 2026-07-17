/**
 * The abstract seam for persisting secret material.
 *
 * Core owns ONLY this tiny value-store contract. The default filesystem adapter (`FsSecretStore`)
 * lives in `@cotal-ai/workspace` because on-disk layout is a workstation concern, not the wire
 * protocol. A closed hosted composition injects its own KMS/Vault-backed implementation at its
 * composition root; nothing here knows it is being hosted.
 *
 * SCOPE — what routes through a `SecretStore`. Only DURABLE HOSTED SECRET BLOBS: the full persisted
 * space trust bundle (operator + account seeds and the account signing seed; only the system-account
 * seed is stripped before disk), the auth service's callout / issuer / owner-secret / service-key
 * material, agent standing creds, and any daemon standing credential the hosted composition persists
 * (renewable ones — delivery / membership-rw — are read via `get` on each refresh, never a one-shot
 * snapshot; rotation-renewed observer / evictor creds are read at start or per use).
 * Machine-local, transient, or non-secret artifacts are NOT `SecretStore` material and remain the
 * local filesystem owner's responsibility: the mesh registry,
 * the transient MCP config, launcher scripts, personas, auth-service discovery (pid/port), the IdP
 * pin, `membership.json`, the login cache, and the actor ledger (authorization DB state, not an
 * exportable blob). Every
 * durable secret that routes through here must be READ through `get` too, or a hosted `put` is a
 * silent no-op while a raw `readFileSync` stays authoritative.
 *
 * KEYS are OPAQUE logical strings built by the owning package. Core assigns them no taxonomy: a
 * KMS key-id / policy / HSM-slot mapping is the closed adapter's concern. Typing the key could not
 * enforce "signing-seed never leaves the HSM" anyway, because {@link SecretStore.get} necessarily
 * exports the value; non-exportable signing, if ever needed, is a separate capability seam
 * (sign / mint), not a richer key here. v1 accepts that signing material DOES enter process memory
 * (e.g. `mintCreds`).
 */
export interface SecretStore {
  /** The stored value for `key`, or `undefined` if absent. */
  get(key: string): Promise<string | undefined>;

  /** Store `value` under `key`, replacing any prior value AS A WHOLE: a concurrent `get` observes
   *  either the complete old value or the complete new one, never a partial or torn intermediate
   *  (FS adapter → atomic temp+rename; a managed backend → a conditional / whole-object put). This
   *  atomicity is part of the contract because standing daemon/agent creds are re-read live during
   *  renewal. Private perms / hardening beyond the atomicity guarantee remain the adapter's concern. */
  put(key: string, value: string): Promise<void>;

  /** Remove `key`. Idempotent. The ONLY portable contract is: after a successful `delete`,
   *  `get(key)` returns absent. This is NOT cryptographic shred, revocation, or credential kill —
   *  a backend may retain recoverable versions, and any already-issued NATS cred or signing seed
   *  stays valid until its credential lifetime ends or broker/key rotation invalidates it (those
   *  are mint / renewal / eviction concerns, not `SecretStore`). */
  delete(key: string): Promise<void>;
}
