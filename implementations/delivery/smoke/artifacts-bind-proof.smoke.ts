/**
 * The daemon-served endpoint's bind proof and serve fence, without a broker (A1, plan section 2, E4/S15).
 *
 *  - Claims equality: `assertServeCandidateClaims` takes a candidate only when its JWT names the
 *    persisted serve nkey and carries exactly the rows the derived grant implies plus its own inbox.
 *    Each way to be wrong is its own cell: another nkey, a missing command row (a partial subscribe
 *    set), a reply row pinned to another epoch, an extra row, a deny row, and a credential with no rows.
 *  - The serve fence: a handler that captured its generation refuses before an effect once a quiesce
 *    ends that generation, with `outcome: not-executed`; a held handler released after the quiesce
 *    does nothing; a regained lease does not revive an old generation.
 *  - The key builders: the one module that spells artifact index keys accepts only a digest, a
 *    concrete channel and caller tokens, and a census scan finds no other source file building those
 *    key families (security S13).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  artifactsClusterArtifacts, authorizeTrustedServeSnapshot, credsFromJwt, epServeGrantRows,
  EpEnvelopeError, newIdentity, ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, type EpServeGrant, type Identity,
} from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { assertServeCandidateClaims, DaemonEndpointBinder } from "../src/endpoint-bind.js";
import type { JetStreamManager } from "@nats-io/jetstream";
import { attachmentIndexKey, attachmentKey, attachmentKeyDigest, channelAttachmentsFilter, digestToken, principalDigestKey } from "../src/artifact-keys.js";

/** A manager no cell reaches: an adoption refused before the bind starts never reads the gate. */
const unreachedJsm = new Proxy({}, { get: () => { throw new Error("no broker in this cell"); } }) as JetStreamManager;

const EXPECTED_CELLS = 19;
const { check, finish, passed, failed } = createSuite();

const space = "bindproof";
const instanceId = "bindproofinstance0000000000000a";
const cluster = artifactsClusterArtifacts();
const grantAt = (epoch: number): EpServeGrant => authorizeTrustedServeSnapshot({
  space, endpoint: ARTIFACTS_ENDPOINT, instanceId, epoch, owner: "local", registrationRevision: 3, nameAuthorityRevision: 0,
  commands: [ARTIFACTS_LIST_COMMAND],
  surface: { [ARTIFACTS_LIST_COMMAND]: { clusterDigest: cluster.closureDigest, class: "ephemeral", targeted: false, modes: [], traits: [],
    capability: "artifacts.list", inputDigest: "sha256:" + "0".repeat(64), outputDigest: "sha256:" + "1".repeat(64) } as never },
  descriptor: { endpoint: ARTIFACTS_ENDPOINT, owner: "local", protocol: { v: 1 }, clusters: [] } as never,
});

/** A credential for `id` carrying exactly `pub`/`sub` (and any deny). The claims check reads the
 *  decoded claims and never the signature (the broker verifies that at connect), so the token is
 *  built unsigned here: what is graded is the rows, which is all this check decides on. */
async function credsWith(id: Identity, pub: string[], sub: string[], deny?: { pub?: string[]; sub?: string[] }): Promise<string> {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const claims = { sub: id.id, iss: "ABINDPROOF", nats: {
    pub: { allow: pub, ...(deny?.pub ? { deny: deny.pub } : {}) }, sub: { allow: sub, ...(deny?.sub ? { deny: deny.sub } : {}) }, type: "user", version: 2,
  } };
  return credsFromJwt(`${b64({ typ: "JWT", alg: "ed25519-nkey" })}.${b64(claims)}.unsigned`, id);
}
const refusal = (fn: () => void): string | undefined => {
  try { fn(); return undefined; } catch (e) { return e instanceof EpEnvelopeError ? `${e.code}: ${e.message}` : `!${(e as Error).message}`; }
};

const serve = newIdentity();
const grant = grantAt(4);
const rows = epServeGrantRows(space, { endpoint: ARTIFACTS_ENDPOINT, instanceId, epoch: 4, ephemeralCommands: [ARTIFACTS_LIST_COMMAND] });
const inbox = `_INBOX_${serve.id}.>`;

// ---- claims equality ----
const credsWith0: string = await credsWith(serve, rows.pub, [...rows.sub, inbox]);
const accepted = refusal(() => assertServeCandidateClaims(credsWith0, grant, serve.id));
check("a candidate carrying exactly the derived rows plus its inbox is accepted", accepted === undefined, accepted);

const otherKey = newIdentity();
const wrongKey = refusal(() => assertServeCandidateClaims(credsWith0, grant, otherKey.id));
check("a candidate that does not name the persisted serve nkey is refused", wrongKey?.startsWith("permission-denied") === true && /serve nkey/.test(wrongKey), wrongKey);

const listRows = rows.sub.filter((r) => r.includes(`.${ARTIFACTS_LIST_COMMAND}.`));
const partial = await credsWith(serve, rows.pub, [...rows.sub.filter((r) => !listRows.includes(r)), inbox]);
const partialRefused = refusal(() => assertServeCandidateClaims(partial, grant, serve.id));
check("a candidate missing one command's subscribe rows (a partial set) is refused, naming the missing rows",
  listRows.length > 0 && partialRefused?.startsWith("permission-denied") === true && /missing \[/.test(partialRefused) && partialRefused.includes(listRows[0]!), partialRefused);

const otherEpoch = epServeGrantRows(space, { endpoint: ARTIFACTS_ENDPOINT, instanceId, epoch: 3, ephemeralCommands: [ARTIFACTS_LIST_COMMAND] });
const staleEpoch = await credsWith(serve, otherEpoch.pub, [...otherEpoch.sub, inbox]);
const staleRefused = refusal(() => assertServeCandidateClaims(staleEpoch, grant, serve.id));
check("a candidate whose reply rows name another epoch is refused", staleRefused?.startsWith("permission-denied") === true && /\.3\./.test(staleRefused), staleRefused);

const extra = await credsWith(serve, [...rows.pub, `${rows.pub[0]!.split(".")[0]}.chat.>`], [...rows.sub, inbox]);
const extraRefused = refusal(() => assertServeCandidateClaims(extra, grant, serve.id));
check("a candidate carrying an extra row is refused, naming it", extraRefused?.startsWith("permission-denied") === true && /extra \[[^\]]+\]/.test(extraRefused), extraRefused);

const denied = await credsWith(serve, rows.pub, [...rows.sub, inbox], { sub: [listRows[0]!] });
const deniedRefused = refusal(() => assertServeCandidateClaims(denied, grant, serve.id));
check("a candidate carrying a deny row is refused (a serve credential is allow-only)", deniedRefused?.startsWith("permission-denied") === true && /deny/.test(deniedRefused), deniedRefused);

const empty = await credsWith(serve, [], []);
const emptyRefused = refusal(() => assertServeCandidateClaims(empty, grant, serve.id));
check("a candidate that authenticates with no rows is refused", emptyRefused?.startsWith("permission-denied") === true, emptyRefused);

// ---- the serve fence: generations end on quiesce ----
const binder = new DaemonEndpointBinder({
  space, servers: "nats://127.0.0.1:1", tls: false,
  endpoint: { endpoint: ARTIFACTS_ENDPOINT, cluster, defs: () => [] },
  log: () => {},
});
const live = (binder as unknown as { live: Set<number> }).live;
const gen = 7;
live.add(gen);
check("a live generation passes the fence", refusal(() => binder.fence.check(gen, "a write")) === undefined);
check("a generation that was never live is refused", refusal(() => binder.fence.check(gen + 1, "a write"))?.startsWith("unavailable") === true);

// A handler holds across the quiesce: it captured `gen`, awaits, and checks before its effect.
let release!: () => void;
const held = new Promise<void>((r) => { release = r; });
let effect = false;
const handler = (async () => {
  await held;
  binder.fence.check(gen, "the held write");
  effect = true;
})();
await binder.quiesce("the lease is being re-checked");
release();
let heldError: unknown;
try { await handler; } catch (e) { heldError = e; }
check("a handler held across a quiesce does nothing when released", effect === false);
check("its refusal is unavailable with outcome not-executed",
  heldError instanceof EpEnvelopeError && heldError.code === "unavailable" && heldError.outcome === "not-executed", heldError);
check("after the quiesce nothing is bound, and serveState says why",
  (() => { const s = binder.serveState(); return s.bound === false && /re-checked/.test(s.cause); })());
binder.leaseRegained();
check("a regained lease does not revive a generation the quiesce ended", refusal(() => binder.fence.check(gen, "a write"))?.startsWith("unavailable") === true);
const adoptWhileQuiesced = new DaemonEndpointBinder({ space, servers: "nats://127.0.0.1:1", tls: false, endpoint: { endpoint: ARTIFACTS_ENDPOINT, cluster, defs: () => [] }, log: () => {} });
await adoptWhileQuiesced.quiesce("lost the lease");
let quiescedAdopt: string | undefined;
try { await adoptWhileQuiesced.adopt({ creds: credsWith0, instanceId, serveId: serve.id, adoptionOpId: "op", jsm: unreachedJsm }); } catch (e) { quiescedAdopt = (e as Error).message; }
check("an adoption while the lease is not held binds nothing and says so", quiescedAdopt !== undefined && /stopped serving its shard before the bind started; nothing was bound/.test(quiescedAdopt), quiescedAdopt);

// ---- the key builders (S13) ----
const digest = `sha256:${"a".repeat(64)}`;
check("key builders compose only from validated parts",
  attachmentKey("team.alpha", digest) === `team.alpha.${"a".repeat(64)}` && attachmentIndexKey(digest, "team.alpha") === `=d.${"a".repeat(64)}.team.alpha`
    && channelAttachmentsFilter("team.alpha") === "team.alpha.*" && principalDigestKey(digest, { owner: "local", actor: "bob", uid: "abcdefghijklmnopqrstuvwxyz01234" }).startsWith(`${"a".repeat(64)}.local.bob.`));
const rejected = [
  () => digestToken("sha256:" + "A".repeat(64)), () => digestToken(">"), () => attachmentKey("team.*", digest), () => attachmentKey("team.>", digest),
  () => attachmentKey("", digest), () => channelAttachmentsFilter("a..b"), () => attachmentKeyDigest("team", "team.x.y"),
  () => principalDigestKey(digest, { owner: "local", actor: "bob", uid: "*" }),
].map((fn) => refusal(fn));
check("a wildcard, a malformed digest, an empty or double-dot channel, a foreign key and a wildcard uid are all refused",
  rejected.every((r) => r !== undefined), rejected);

// Census: no other source file spells an index-bucket key. The families are `=d.` keys, and gets or
// puts on the three bucket handles; artifact-keys.ts is the only module allowed to build them.
const root = join(import.meta.dirname, "..", "..", "..");
const sources: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "smoke" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) sources.push(p);
  }
};
for (const top of ["packages", "implementations", "extensions"]) walk(join(root, top));
const allowed = new Set(["implementations/delivery/src/artifact-keys.ts"]);
/** The source with comments removed: a doc comment may name the key family, only code may build it. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const offenders = sources.map((p) => relative(root, p)).filter((rel) => {
  if (allowed.has(rel)) return false;
  const text = code(readFileSync(join(root, rel), "utf8"));
  return /`=d\./.test(text) || /"=d\./.test(text) || /'=d\./.test(text);
});
check("only artifact-keys.ts spells the attachment digest-index key family in code", offenders.length === 0, offenders);
const rawGets = sources.map((p) => relative(root, p)).filter((rel) => {
  if (rel.startsWith("packages/core/src/artifact-")) return false;
  const text = readFileSync(join(root, rel), "utf8");
  return /artifact(Attach|Possess|Reserve)Bucket\(/.test(text) && /\.(get|put|create|update|delete)\(/.test(text) && !allowedReader(rel);
});
function allowedReader(rel: string): boolean {
  // The artifacts endpoint (a filtered scan), the index layer (point reads and writes) and the sweep
  // (scans, deletes and tombstones) open the index buckets, and each takes every key from
  // artifact-keys.ts. Any other file that opens an index bucket and reads or writes it by key is a
  // second key builder.
  const readers = new Set(["implementations/delivery/src/artifacts-endpoint.ts", "implementations/delivery/src/artifact-index.ts", "implementations/delivery/src/artifact-sweep.ts"]);
  return readers.has(rel) && readFileSync(join(root, rel), "utf8").includes("./artifact-keys.js");
}
check("no source file but the artifacts endpoint and the index layer opens an index bucket and reads or writes it by key", rawGets.length === 0, rawGets);
// S3: on the delivery credential the chat stream's message get is read in exactly one place, the sealed
// confirm-attach read, and it is called from exactly one place, the artifacts endpoint. (Other
// processes hold their own chat reads on their own credentials; this row is the delivery daemon's.)
const deliverySources = sources.map((p) => relative(root, p)).filter((rel) => rel.startsWith("implementations/delivery/"));
const chatGetters = deliverySources.filter((rel) => /getMessage\(\s*chatStream\(/.test(code(readFileSync(join(root, rel), "utf8"))));
const chatReadCallers = deliverySources.filter((rel) => rel !== "implementations/delivery/src/artifact-chat-read.ts"
  && /readChatEntryForConfirm\(/.test(code(readFileSync(join(root, rel), "utf8"))));
check("the chat stream is read by sequence in one sealed helper, called from one site (S3)",
  JSON.stringify(chatGetters) === JSON.stringify(["implementations/delivery/src/artifact-chat-read.ts"])
    && JSON.stringify(chatReadCallers) === JSON.stringify(["implementations/delivery/src/artifacts-endpoint.ts"]), { chatGetters, chatReadCallers });

finish();
if (passed() + failed() !== EXPECTED_CELLS) {
  console.error(`expected ${EXPECTED_CELLS} cells, ran ${passed() + failed()}`);
  process.exitCode = 1;
}
