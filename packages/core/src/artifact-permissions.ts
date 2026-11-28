/**
 * The artifacts service's two data credentials (artifact plane 4.0). The serve credential for the
 * `artifacts` endpoint stays pure rails; these hold the store access, split by duty so neither one
 * holds both a body-selected read and the deletion power.
 *
 * Neither is ever issuable to a peer: the signer holder mints them for the delivery daemon alone, and
 * `cotal mint`, the auth callout and persona endpoints all refuse them. Both name only this space's
 * three index buckets and its artifact object store, and neither holds a consumer create on the object
 * stream, which would export every artifact to a caller-chosen deliver subject.
 */
import { artifactIndexStreamNames, artifactIndexBuckets } from "./artifact-index-stores.js";
import { artifactBucket, objectStoreStream } from "./subjects.js";
import type { MintPrincipal } from "./provision-jwt.js";

/** `artifact-data`: the request path. Point reads of index rows by exact key, CAS writes of them, and
 *  the object store's chunk and meta publishes plus last-by-subject reads. NAMED RESIDUAL (SPEC
 *  13.12): every index read gates an effect, so it must be leader-served, and on these
 *  `allow_direct: false` buckets that is the body-selected `STREAM.MSG.GET`, paired here with the
 *  value write. The issuer profile carries the same pairing under the same rule: never issuable to a
 *  peer, and every raw get is built from validated keys by one module. */
export function artifactDataPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const obj = artifactBucket(space), OBJ = objectStoreStream(obj);
  const index = artifactIndexStreamNames(space);
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        ...index.flatMap((stream) => [`$JS.API.STREAM.INFO.${stream}`, `$JS.API.STREAM.MSG.GET.${stream}`]),
        ...artifactIndexBuckets(space).map((bucket) => `$KV.${bucket}.>`),
        `$JS.API.STREAM.INFO.${OBJ}`,
        `$O.${obj}.C.>`,
        `$O.${obj}.M.>`,
        // Subject-scoped Direct Get only: the client appends the subject for `last_by_subj`, and any
        // body-addressed form (a `seq`) needs the bare `DIRECT.GET.<OBJ>` subject, never granted here.
        `$JS.API.DIRECT.GET.${OBJ}.$O.${obj}.>`,
      ],
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}

/** `artifact-sweeper`: the lease holder's garbage collection. Completeness-proven scans of the index
 *  buckets (an ordered consumer on the primary is a leader-served read, SPEC 13.12), deletes and
 *  tombstones on them, and filtered purges of the object stream by subject. It reads no object bytes,
 *  publishes nothing to the object store and holds no keyed get anywhere. */
export function artifactSweeperPermissions(space: string, pr: MintPrincipal): Record<string, unknown> {
  const OBJ = objectStoreStream(artifactBucket(space));
  const index = artifactIndexStreamNames(space);
  return {
    pub: {
      allow: [
        "$JS.API.INFO",
        ...index.flatMap((stream) => [
          `$JS.API.STREAM.INFO.${stream}`,
          `$JS.API.CONSUMER.CREATE.${stream}`,
          `$JS.API.CONSUMER.CREATE.${stream}.>`,
          `$JS.API.CONSUMER.INFO.${stream}.>`,
          `$JS.API.CONSUMER.DELETE.${stream}.>`,
        ]),
        ...artifactIndexBuckets(space).map((bucket) => `$KV.${bucket}.>`),
        "$JS.FC.>",
        `$JS.API.STREAM.INFO.${OBJ}`,
        `$JS.API.STREAM.PURGE.${OBJ}`,
      ],
    },
    sub: { allow: [`_INBOX_${pr.connId}.>`] },
  };
}
