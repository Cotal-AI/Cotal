/**
 * The artifact grant shapes, asserted row by row (artifact plane 4.0; the A1 security review's S2,
 * S9, S10 and S13). Static: it builds each profile's permissions with `permissionsFor` and needs no
 * broker. A cell that only checked "the row exists" would pass a credential widened beside it, so each
 * credential's rows are compared against an exact allowed set, and every profile in the mint table is
 * checked for the rows only the artifacts service may hold.
 *
 * Run: pnpm smoke:artifact-grant-shape
 */
import {
  permissionsFor, artifactBucket, objectStoreStream, artifactIndexBuckets, artifactIndexStreamNames,
  DEV_OWNER, type Profile,
} from "@cotal-ai/core";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra !== undefined ? JSON.stringify(extra) : ""); } };

const SPACE = "artgrant";
const pr = { owner: DEV_OWNER, actor: "artifacts", connId: "conn0123456789abcdef", lifecycleUid: "u".repeat(26) };
const OBJ_BUCKET = artifactBucket(SPACE), OBJ = objectStoreStream(OBJ_BUCKET);
const INDEX_STREAMS = artifactIndexStreamNames(SPACE), INDEX_BUCKETS = artifactIndexBuckets(SPACE);

// Literal names, written out rather than derived from the helpers, so a helper that drifts is caught.
c("the three index buckets carry their literal names",
  JSON.stringify(INDEX_BUCKETS) === JSON.stringify(["cotal_artattach_artgrant", "cotal_artpossess_artgrant", "cotal_artreserve_artgrant"]), INDEX_BUCKETS);
c("the object store's backing stream is OBJ_cotal_artifacts_artgrant", OBJ === "OBJ_cotal_artifacts_artgrant", OBJ);

const rows = (profile: Profile) => {
  const p = permissionsFor(profile, SPACE, pr, {}) as { pub: { allow: string[] }; sub: { allow: string[] } };
  return { pub: p.pub.allow, sub: p.sub.allow };
};
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

console.log("1. artifact-data holds exactly the request path's rows");
{
  const d = rows("artifact-data");
  const expected = [
    "$JS.API.INFO",
    ...INDEX_STREAMS.flatMap((s) => [`$JS.API.STREAM.INFO.${s}`, `$JS.API.STREAM.MSG.GET.${s}`]),
    ...INDEX_BUCKETS.map((b) => `$KV.${b}.>`),
    `$JS.API.STREAM.INFO.${OBJ}`,
    `$O.${OBJ_BUCKET}.C.>`,
    `$O.${OBJ_BUCKET}.M.>`,
    `$JS.API.DIRECT.GET.${OBJ}.$O.${OBJ_BUCKET}.>`,
  ];
  c("artifact-data publish rows equal the allowed set and nothing else", sameSet(d.pub, expected), { got: d.pub });
  c("artifact-data subscribes only to its own inbox", sameSet(d.sub, [`_INBOX_${pr.connId}.>`]), d.sub);
  // S2: the object rows are the two prefixes, never the whole bucket.
  c("artifact-data never holds the whole-bucket $O row", !d.pub.includes(`$O.${OBJ_BUCKET}.>`));
  // S10: no body-addressed read of the object stream.
  c("artifact-data holds no bare DIRECT.GET or MSG.GET on the object stream",
    !d.pub.includes(`$JS.API.DIRECT.GET.${OBJ}`) && !d.pub.some((r) => r.startsWith(`$JS.API.STREAM.MSG.GET.${OBJ}`)));
  c("artifact-data holds no consumer create anywhere", !d.pub.some((r) => r.includes("CONSUMER.")));
  c("artifact-data holds no purge or message delete", !d.pub.some((r) => r.includes(".PURGE.") || r.includes("MSG.DELETE")));
  c("artifact-data holds no Direct Get on an index bucket (index reads are leader-served)",
    !d.pub.some((r) => INDEX_STREAMS.some((s) => r.startsWith(`$JS.API.DIRECT.GET.${s}`))));
}

console.log("2. artifact-sweeper holds exactly the sweep's rows");
{
  const s = rows("artifact-sweeper");
  const expected = [
    "$JS.API.INFO",
    ...INDEX_STREAMS.flatMap((st) => [
      `$JS.API.STREAM.INFO.${st}`, `$JS.API.CONSUMER.CREATE.${st}`, `$JS.API.CONSUMER.CREATE.${st}.>`,
      `$JS.API.CONSUMER.INFO.${st}.>`, `$JS.API.CONSUMER.DELETE.${st}.>`,
    ]),
    ...INDEX_BUCKETS.map((b) => `$KV.${b}.>`),
    "$JS.FC.>",
    `$JS.API.STREAM.INFO.${OBJ}`,
    `$JS.API.STREAM.PURGE.${OBJ}`,
  ];
  c("artifact-sweeper publish rows equal the allowed set and nothing else", sameSet(s.pub, expected), { got: s.pub });
  c("artifact-sweeper holds no keyed get anywhere", !s.pub.some((r) => r.includes("MSG.GET") || r.includes("DIRECT.GET")));
  c("artifact-sweeper holds no $O publish", !s.pub.some((r) => r.startsWith("$O.")));
  c("artifact-sweeper holds no consumer create on the object stream", !s.pub.some((r) => r.includes(`CONSUMER.CREATE.${OBJ}`)));
}

console.log("3. the provisioner creates and inspects the index buckets, and nothing more on them");
{
  // That no OTHER profile reaches the artifact stores is section E of smoke:eps-grant-sweep, which
  // builds every profile with its required mint options.
  const prov = rows("provisioner");
  c("the provisioner holds STREAM.CREATE and STREAM.INFO on each index bucket",
    INDEX_STREAMS.every((st) => prov.pub.includes(`$JS.API.STREAM.CREATE.${st}`) && prov.pub.includes(`$JS.API.STREAM.INFO.${st}`)));
  c("the provisioner holds no value write, read, consumer or purge on an index bucket",
    !prov.pub.some((r) => INDEX_BUCKETS.some((b) => r.startsWith(`$KV.${b}`)) ||
      INDEX_STREAMS.some((st) => r.includes(`MSG.GET.${st}`) || r.includes(`DIRECT.GET.${st}`) || r.includes(`CONSUMER.CREATE.${st}`) || r.includes(`.PURGE.${st}`))));
}

console.log("4. the issuance doors refuse the artifact profiles (S13)");
{
  for (const profile of ["artifact-data", "artifact-sweeper"] as const) {
    let refused = false;
    try { permissionsFor(profile, SPACE, pr, { issued: { generation: "g".repeat(26) } } as never); } catch { refused = true; }
    c(`${profile} cannot be minted as an issued (peer-held) credential`, refused);
  }
}

console.log("5. the delivery profile reads one chat entry by sequence, and gains nothing on the artifact stores (S3, S9)");
{
  const CHAT = "CHAT_artgrant";
  const del = rows("delivery");
  const chatGets = del.pub.filter((r) => r.includes(".MSG.GET.") && r.includes("CHAT"));
  c("the delivery profile holds exactly one chat message get, the single-seq read confirm-attach uses",
    chatGets.length === 1 && chatGets[0] === `$JS.API.STREAM.MSG.GET.${CHAT}`, chatGets);
  c("the delivery profile holds no row on the object store or the index buckets",
    !del.pub.some((r) => r.startsWith("$O.") || r.includes(OBJ) || INDEX_BUCKETS.some((b) => r.includes(b))), del.pub.filter((r) => r.includes("art")));
}

console.log(`\nartifact-grant-shape: ${ok} passed, ${fail} failed`);
if (fail) process.exit(1);
