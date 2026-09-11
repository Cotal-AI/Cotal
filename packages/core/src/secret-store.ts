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
  /** Stable, non-secret identity of the authority this adapter reads and writes. A first-party
   *  filesystem adapter declares this intrinsically. A hosted adapter may declare its Vault/KMS
   *  coordinate here, so callers do not have to reconstruct the adapter's authority from cwd or
   *  another local root. Optional for compatibility; a composition that needs identity proof must
   *  otherwise supply an explicit coordinate at its boundary. */
  readonly identity?: SecretStoreIdentity;

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

/**
 * How a process names the SecretStore it uses as the standing-daemon credential authority.
 *
 * Fingerprint-only `reloadCreds` is safe only when the renewal owner and the delivery daemon
 * genuinely read one store. This identity is that proof: it names the store, never a secret.
 * Two workstation filesystem stores agree only when they resolve the same directory. An
 * injected (hosted) store is identified by an operator-supplied coordinate, never guessed from
 * a local root. A store may declare this identity itself; otherwise the composition root must
 * provide it explicitly. There is no fallback between the two shapes.
 */
export type SecretStoreIdentity =
  | { kind: "fs"; root: string }
  | { kind: "injected"; coordinate: string };

/** Compare two store identities. Filesystem roots are compared after POSIX-style trailing-slash trim. */
export function sameSecretStoreIdentity(a: SecretStoreIdentity, b: SecretStoreIdentity): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "fs" && b.kind === "fs") return trimStorePath(a.root) === trimStorePath(b.root);
  if (a.kind === "injected" && b.kind === "injected") return a.coordinate === b.coordinate;
  return false;
}

function trimStorePath(p: string): string {
  return p.replace(/[/\\]+$/, "") || p;
}

/** Operator-facing label used in the construction-time refusal that names both stores. */
export function formatSecretStoreIdentity(id: SecretStoreIdentity): string {
  return id.kind === "fs" ? id.root : `injected:${id.coordinate}`;
}

/**
 * Parse a store identity off the delivery-admin rail. Unknown fields, extra keys, blank
 * values, and mixed fs/injected shapes are refused rather than guessed.
 */
export function parseSecretStoreIdentity(raw: unknown): SecretStoreIdentity {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("secret-store identity must be an object");
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  if (o.kind === "fs") {
    if (keys.some((k) => k !== "kind" && k !== "root"))
      throw new Error("secret-store identity of kind fs admits only {kind, root}");
    if (typeof o.root !== "string" || !o.root.trim())
      throw new Error("secret-store identity of kind fs requires a non-blank root");
    return { kind: "fs", root: o.root };
  }
  if (o.kind === "injected") {
    if (keys.some((k) => k !== "kind" && k !== "coordinate"))
      throw new Error("secret-store identity of kind injected admits only {kind, coordinate}");
    if (typeof o.coordinate !== "string" || !o.coordinate.trim())
      throw new Error("secret-store identity of kind injected requires a non-blank coordinate");
    return { kind: "injected", coordinate: o.coordinate };
  }
  throw new Error('secret-store identity kind must be "fs" or "injected"');
}

/**
 * The construction-time refusal when the manager's remint store and the daemon's reload
 * source are not one authority. Both identities appear in the message; a refusal that
 * declines to start without naming them is the same defect wearing a different error.
 */
export function divergentSecretStoreRefusal(owner: SecretStoreIdentity, daemon: SecretStoreIdentity): string {
  return (
    `daemon credential renewal cannot be constructed across two SecretStores: ` +
    `the manager remints through ${formatSecretStoreIdentity(owner)} while the delivery daemon ` +
    `reloads from ${formatSecretStoreIdentity(daemon)}. Pass both processes the same store ` +
    `(one explicit SecretStore coordinate, or one shared filesystem root).`
  );
}
