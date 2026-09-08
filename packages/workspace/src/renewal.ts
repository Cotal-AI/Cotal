import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSessionRenewalRequest,
  credsClaims,
  credsFingerprint,
  identityFromCreds,
  materializeRenewedSessionCreds,
  mintCreds,
  writeSecretFile,
  type Profile,
  type SecretStore,
  type SessionRenewalMaterial,
  type SessionRenewalRequest,
  type SpaceAuth,
} from "@cotal-ai/core";
import { getSpaceAuth } from "./auth-paths.js";
import { workspaceSecretStore } from "./secret-store-fs.js";
import { DELIVERY_CREDS_KIND, MEMBERSHIP_RW_CREDS_KIND, segmentedKey } from "./space-segmentation.js";

/**
 * D5 slice 5 class-2 standing renewal — the RENEWAL OWNER'S half, shared by the manager (the
 * resident owner in every mesh mode) and `cotal doctor auth --fix` (the operator repair). The
 * daemon's half is the explicit `reloadCreds` adoption op on the delivery-admin rail, plus each
 * daemon's own 75% renewal timer (the delivery endpoint re-reads its source; the membership feed
 * preflight-proves each candidate). Machine-local file work lives here in the workspace layer:
 * implementations never import each other.
 */

/** The seed-less daemon creds a renewal owner re-signs. The $SYS kinds (membership-observer,
 *  connection-evictor) are deliberately ABSENT: they are rotation-renewed — no persisted seed can
 *  re-sign them, by design. Their keys are {@link membershipObserverCredsKey} /
 *  {@link connectionEvictorCredsKey} — injectable, but never re-signable from a persisted seed.
 *
 *  `key` is a `(space) => key` BUILDER, not a literal, because these kinds are now per-space (§3.1):
 *  one entry no longer names one location. `kind` stays beside it because that is what a
 *  {@link RemintResult} reports and what an operator reads — see {@link RemintResult.file}.
 *
 *  The builders are {@link segmentedKey}, NOT the migrating per-kind resolvers: see that function for
 *  why the renewal owner is one of the two owners that must not move material. */
export const REMINTABLE_DAEMON_CREDS: ReadonlyArray<{
  kind: string;
  key: (space: string) => string;
  profile: Profile;
}> = [
  { kind: DELIVERY_CREDS_KIND, key: (space) => segmentedKey(DELIVERY_CREDS_KIND, space), profile: "delivery" },
  { kind: MEMBERSHIP_RW_CREDS_KIND, key: (space) => segmentedKey(MEMBERSHIP_RW_CREDS_KIND, space), profile: "membership-rw" },
];

export interface RemintResult {
  /** THE KIND, never the segmented key. A remint result is mapped back to a daemon component by
   *  literal comparison against the kind (`manager.ts:1147` attributes a fingerprint to
   *  `expected.delivery` that way), so a `file` carrying a `space.<hex>/` prefix would match nothing
   *  and the manager would silently stop attributing renewals. It is also what `doctor auth` prints,
   *  which would otherwise start showing an operator hex. */
  file: string;
  /** true = re-signed; false = failed (see error); undefined ok with `skipped` = file absent. */
  ok: boolean;
  skipped?: "missing-file" | "no-auth";
  error?: string;
  /** EPHEMERAL SHA-256 of the JUST-RE-SIGNED cred's USER JWT — the EXPECTED-generation token the
   *  renewal owner hands the daemon so an adoption reply can prove it adopted THIS generation, not
   *  merely re-read some file. Present only on `ok`. NEVER persisted: the caller strips it before
   *  writing the renewal record (a stable secret-derived token must not land on disk). */
  fingerprint?: string;
}

/** Connector-owned independent renewal composition. It deliberately has no manager dependency:
 * the connector retains its own nkey proof, calls the auth service over its own renewal transport,
 * and replaces the mesh connection only after the renewed credential is accepted. */
export interface IndependentSessionRenewalOptions<TConnection> {
  /** Current complete creds bundle. Its seed stays local and signs every renewal request. */
  initialCreds: string;
  capabilityId: string;
  space: string;
  resourceKey: SessionRenewalRequest["resourceKey"];
  owner: string;
  actor: string;
  lifecycleUid: string;
  /** Closed auth-service renewal exchange. No generic mint/profile input crosses it. */
  renew: (request: SessionRenewalRequest) => Promise<SessionRenewalMaterial>;
  /** Dedicated mesh connection for the new credential generation. */
  connect: (creds: string) => Promise<TConnection>;
  /** Called only after the new connection is accepted. The caller atomically swaps it into use. */
  adopt: (connection: TConnection, creds: string) => Promise<void> | void;
  /** Dispose a candidate whose connect/adopt failed. */
  closeCandidate?: (connection: TConnection) => Promise<void> | void;
  /** Testable scheduling and id seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  requestId?: () => string;
  /** Stop only this renewal loop. It never stops the mesh connection or requests mesh leave. */
  signal?: AbortSignal;
}

export interface IndependentSessionRenewalController {
  readonly done: Promise<void>;
  currentCreds(): string;
}

/**
 * Keep an independently renewable released session credential alive.
 *
 * There is intentionally no retry fallback to the prior generation after a renewal point. A
 * request, signature, auth-service refusal, connect failure, or adoption failure rejects `done`
 * loudly while leaving the caller's already-adopted connection untouched. The caller decides how
 * to surface/recover; this loop never claims success or silently leaves the mesh.
 */
export function startIndependentSessionRenewal<TConnection>(
  opts: IndependentSessionRenewalOptions<TConnection>,
): IndependentSessionRenewalController {
  let current = opts.initialCreds;
  const identity = identityFromCreds(current);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => { clearTimeout(timer); reject(new Error("independent session renewal stopped")); };
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener("abort", abort, { once: true });
  }));
  let requestCounter = 0;
  const nextRequestId = opts.requestId ?? (() => {
    requestCounter++;
    return `renew${now().toString(36)}${requestCounter.toString(36).padStart(16, "0")}`;
  });

  const done = (async () => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const delay = credsRenewalDelayMsAt(current, now());
      if (delay > 0) await sleep(delay);
      if (opts.signal?.aborted) return;
      const request = createSessionRenewalRequest(identity, {
        capabilityId: opts.capabilityId,
        space: opts.space,
        resourceKey: opts.resourceKey,
        owner: opts.owner,
        actor: opts.actor,
        lifecycleUid: opts.lifecycleUid,
        requestId: nextRequestId(),
        requestedAt: now(),
      });
      const material = await opts.renew(request);
      const next = materializeRenewedSessionCreds(material, identity);
      // A malicious/buggy service returning the same or older generation must not create a hot loop
      // or be reported as renewal. exp strictly advances and the JWT generation must change.
      const before = credsClaims(current);
      const after = credsClaims(next);
      if (typeof before.exp !== "number" || typeof after.exp !== "number" || after.exp <= before.exp)
        throw new Error("independent session renewal did not advance credential expiry");
      if (credsFingerprint(next) === credsFingerprint(current))
        throw new Error("independent session renewal returned the current credential generation");
      let candidate: TConnection | undefined;
      try {
        candidate = await opts.connect(next);
        await opts.adopt(candidate, next);
      } catch (e) {
        if (candidate !== undefined) await opts.closeCandidate?.(candidate);
        throw e;
      }
      current = next;
    }
  })();
  return { done, currentCreds: () => current };
}

/** Same 75% convention as core, but clock-injected so accelerated fixture tests are instant. */
function credsRenewalDelayMsAt(creds: string, nowMs: number): number {
  const claims = credsClaims(creds);
  if (typeof claims.exp !== "number")
    throw new Error("independent session renewal requires bounded credentials");
  const iatMs = (typeof claims.iat === "number" ? claims.iat : nowMs / 1000) * 1000;
  return iatMs + 0.75 * (claims.exp * 1000 - iatMs) - nowMs;
}

/** Re-sign the daemon creds files for their EXISTING nkeys (a renewal must never swap a daemon's
 *  identity — the daemon side pins it). Reads and writes through the secret-store seam; `store` is
 *  the renewal owner's injection point, SYMMETRIC with the daemon's `runDelivery(args, store?)`.
 *  The manager — the D5 standing-renewal owner, and a hosted-path caller (manager.ts calls this
 *  unconditionally) — passes the SAME store it gives the daemon (its `ManagerOptions.secretStore`),
 *  so a hosted composition re-signs into the store the daemon renews from, never a divergent one; no
 *  store means the local workspace FS composition (keys = the paths under `.cotal/`).
 *
 *  The creds are PER-SPACE as of P7, so every store op is addressed by the entry's
 *  `key(expectedSpace)` builder (§3.1) while every RESULT still reports the entry's `kind`.
 *
 *  `expectedSpace` (the caller's known space — the manager's `this.space`, doctor's resolved space) is
 *  a REQUIRED positional and is validated against the store's signer: the daemon creds are SPACE-SCOPED,
 *  so a store whose signer is for a DIFFERENT space (a swap after start, a misconfigured hosted mount)
 *  must NOT re-sign — that would overwrite each last-good cred with one the space's broker rejects,
 *  breaking the daemon on a value that looks freshly renewed. It is required (not optional) so the
 *  unsafe no-space call cannot compile — the same claim-exceeds-enforcement trap the cross-space fix
 *  would otherwise leave for the next caller. A signer that fails validation fails EVERY file
 *  (`ok:false`), leaving the standing creds intact toward their loud expiry rather than clobbering them.
 *  The store's ATOMIC put is load-bearing here, because the daemons re-read these values LIVE (the
 *  delivery endpoint's 75% source refresh, the membership feed's 75% renewal fetch).
 *
 *  The last-good cred is NEVER overwritten with an UNPROVEN one — a bundle's JWT chain is self-bound,
 *  not broker-bound (two `createSpaceAuth(space)` calls yield same-named, DIFFERENT-account chains), so
 *  a same-label alternate signer could mint a broker-dead cred and CLOBBER the last-good (availability
 *  loss). Proof before overwrite is one of: (1) `opts.preflight` — a disposable "does the broker accept
 *  this cred" probe the caller owns (the manager passes a {@link probeConnect} over `this.servers`),
 *  which gates EVERY candidate when supplied; or (2) AUTHORITY CONTINUITY — the candidate is signed by
 *  the SAME account signing key (`iss`) as the current (last-good, already broker-accepted) cred, the
 *  same authority the broker trusts, which the OFFLINE local repair (`doctor auth --fix`) relies on. A
 *  same-label alternate account breaks continuity, so with no preflight it is refused, not clobbered.
 *
 *  Structured per-file results, never throws: a failed remint leaves the old cred running toward its
 *  loud expiry and the caller records/reports the failure. */
export async function remintDaemonCreds(
  root: string,
  expectedSpace: string,
  store?: SecretStore,
  opts?: { preflight?: (creds: string) => Promise<boolean> },
): Promise<RemintResult[]> {
  const s = store ?? workspaceSecretStore(root);
  // Read + FULLY VALIDATE the SIGNER through the SAME store the daemon creds live in (symmetric with
  // the daemon's `runDelivery(args, store)`) — reading it from the FS while writing the daemon creds
  // to an injected store would split authority (signer ← disk, cred ← KMS): the class 3b closed for
  // daemon creds, here for the signer. `getSpaceAuth(s, expectedSpace)` cross-checks the trust chain
  // against the caller's space; a wrong-space or malformed signer THROWS (never re-signs).
  let auth: SpaceAuth | undefined;
  try {
    auth = await getSpaceAuth(s, expectedSpace);
  } catch (e) {
    // Wrong-space / malformed signer: fail every file, DO NOT overwrite the last-good creds.
    return REMINTABLE_DAEMON_CREDS.map(({ kind }) => ({ file: kind, ok: false, error: (e as Error).message }));
  }
  if (!auth) return REMINTABLE_DAEMON_CREDS.map(({ kind }) => ({ file: kind, ok: false, skipped: "no-auth" as const }));
  const results: RemintResult[] = [];
  for (const { kind, key, profile } of REMINTABLE_DAEMON_CREDS) {
    // The KIND is what the result reports (see `RemintResult.file`); the per-space KEY is what the
    // store is addressed by. Read and write MUST use the same one — a get on the key and a put on
    // the kind would re-sign the live cred into a dead flat location and leave the live one to expire.
    const file = kind;
    try {
      const current = await s.get(key(expectedSpace));
      if (current === undefined) {
        results.push({ file, ok: false, skipped: "missing-file" });
        continue;
      }
      const next = await mintCreds(auth, identityFromCreds(current), profile);
      // NEVER overwrite the last-good cred with an UNPROVEN one. A bundle's JWT chain is SELF-bound,
      // not broker-bound (two `createSpaceAuth(space)` calls yield same-named, DIFFERENT-account chains),
      // so `expectedSpace` + full-chain validity is not enough. Proof is one of:
      //  (1) a broker PREFLIGHT — the manager's live "does the broker accept this cred" probe; OR
      //  (2) AUTHORITY CONTINUITY — the candidate is signed by the SAME account signing key (`iss`) as
      //      the current (last-good, already broker-accepted) cred, i.e. the same authority the broker
      //      already trusts. This is what the OFFLINE local repair (`doctor auth --fix`, no live broker)
      //      relies on. A same-label ALTERNATE account (full OR stripped) breaks continuity, so with no
      //      preflight it is REFUSED — the last-good is preserved rather than clobbered by a broker-dead cred.
      let proven: boolean;
      let why: string;
      if (opts?.preflight) {
        proven = await opts.preflight(next);
        why = "the broker refused the re-signed cred (wrong-account or unreachable signer)";
      } else {
        const iss = credsClaims(next).iss;
        proven = iss !== undefined && iss === credsClaims(current).iss;
        why = "the re-signed cred's signer is not the last-good cred's authority, and no broker preflight was supplied";
      }
      if (!proven) {
        results.push({ file, ok: false, error: `${why} - last-good cred preserved` });
        continue;
      }
      await s.put(key(expectedSpace), next);
      results.push({ file, ok: true, fingerprint: credsFingerprint(next) });
    } catch (e) {
      results.push({ file, ok: false, error: (e as Error).message });
    }
  }
  return results;
}

/** The renewal owner's audit record — what `cotal doctor auth` renders so "file re-signed" and
 *  "daemon adopted" are distinguishable states, per the D5 panel gate. One file, overwritten per
 *  pass: the CURRENT renewal state, not a log (history is the git/ops layer's job). */
export interface RenewalRecord {
  /** ISO timestamp of the renewal pass. */
  ts: string;
  /** Who ran the pass (e.g. "manager", "doctor --fix"). */
  owner: string;
  results: RemintResult[];
  /** The daemon's explicit reloadCreds adoption outcome; absent when nothing was re-signed. */
  adoption?: { ok: boolean; detail?: unknown; error?: string };
}

export function renewalRecordPath(root: string): string {
  return join(root, ".cotal", "renewal.json");
}

export function writeRenewalRecord(root: string, record: RenewalRecord): void {
  // REDACT the ephemeral generation token HERE, at the single persistence boundary, so no writer
  // (the manager, `doctor auth --fix`, or any future caller) can leak the stable secret-derived
  // fingerprint to `.cotal/renewal.json`. `JSON.stringify` then omits the `undefined` field.
  const redacted: RenewalRecord = { ...record, results: record.results.map((r) => ({ ...r, fingerprint: undefined })) };
  writeSecretFile(renewalRecordPath(root), JSON.stringify(redacted, null, 2));
}

export function readRenewalRecord(root: string): RenewalRecord | undefined {
  const p = renewalRecordPath(root);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RenewalRecord;
  } catch {
    return undefined; // a corrupt record is rendered as "no renewal record", never a crash
  }
}
