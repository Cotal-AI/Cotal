import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  CREDENTIAL_LIFETIMES, permissionsFor, epServeGrantRows, effectsBindGrants, poolOwnerBindGrants, patternCovers,
  chatStream, dmStream, dlvStream, inboxStream, taskStream,
  epcStreamName, epeStreamName, epfStreamName, epjStreamName, eprStreamName,
  eptStreamName, eptReqStreamName, epwStreamName,
  channelBucket, presenceBucket, membershipBucket, deliveryBucket, managerBucket,
  membersBucket, aclBucket, epAuthBucket, recordsBucket, sessionsBucket,
  type Profile, type MintOpts, type MintPrincipal,
} from "@cotal-ai/core";
import { calloutPermissions } from "../../src/permissions.js";
import { USER_TOKEN_VER, USER_TOKEN_VIEWS, VIEW_REQUIRED_SCOPE } from "../../src/token.js";
import { deriveOwnerToken } from "../../src/derive.js";

export interface ProfileFixture {
  profile: Profile;
  variant: string;
  permissions: Record<string, unknown>;
  producer: "permissionsFor" | "epServeGrantRows" | "calloutPermissions";
}
export function profileFixtures(space: string): ProfileFixture[] {
  const uid = "u".repeat(26), instance = "i".repeat(26), session = "s".repeat(26);
  const principal: MintPrincipal = { owner: "local", actor: "census", connId: "census0123456789abcdef", lifecycleUid: uid };
  const rows: ProfileFixture[] = [];
  const one = (profile: Profile, opts: MintOpts = {}, variant = "default", pr = principal): void => {
    rows.push({ profile, variant, permissions: permissionsFor(profile, space, pr, opts), producer: "permissionsFor" });
  };
  const run = { endpoint: "manager", runId: "census-run", takeoverId: "take0001", instanceId: instance, epoch: 1 };
  const producers: Record<Profile, () => void> = {
    agent() {
      one("agent");
      one("agent", { capabilities: ["spawn", "run"], role: "worker", allowPublish: [">"], allowSubscribe: [">"] }, "spawn-run-role");
      one("agent", { allowPublish: [], allowSubscribe: [] }, "empty-channel-scope");
    },
    observer: () => one("observer"), admin: () => one("admin"), supervisor: () => one("supervisor"),
    provisioner: () => one("provisioner"),
    deprovisioner: () => one("deprovisioner", { deprovisionTarget: { principal: "local.worker", lifecycleUid: uid } }),
    "retirement-requester": () => one("retirement-requester", { retirementRequester: { owner: "local", actor: "census", uid, target: { owner: "local", actor: "worker", lifecycleUid: uid } } }),
    "lifecycle-executor": () => one("lifecycle-executor", { lifecycleExecutor: { owner: "local", actor: "worker", lifecycleUid: uid, alias: "worker" } }),
    "endpoint-serve-executor": () => one("endpoint-serve-executor", { endpointServeExecutor: { endpoint: "manager", instanceId: instance } }),
    operator: () => one("operator"), purger: () => one("purger"),
    backup: () => one("backup", { backup: { operation: "inspect", selection: "full" } }),
    restore: () => one("restore", { restore: { operation: "initiate", stream: `CHAT_${space}` } }),
    delivery: () => one("delivery"), "membership-rw": () => one("membership-rw"),
    probe: () => one("probe"), "channel-writer": () => one("channel-writer"), "channel-purger": () => one("channel-purger"),
    teardown: () => one("teardown"),
    "control-caller-privileged": () => one("control-caller-privileged"),
    "control-caller-admin": () => one("control-caller-admin"),
    deployer() { one("deployer"); one("deployer", { controlTier: "privileged" }, "privileged-tier"); },
    "endpoint-serve"() {
      const grant = epServeGrantRows(space, { endpoint: "manager", instanceId: instance, epoch: 1, ephemeralCommands: ["ps", "run-start", "run-resume"] });
      rows.push({ profile: "endpoint-serve", variant: "raw-serve-rows", permissions: { pub: { allow: grant.pub }, sub: { allow: grant.sub } }, producer: "epServeGrantRows" });
      // What a real fenced mint composes on top of those rows: the journal-class effects bind, one
      // owned pool bind, `$JS.API.INFO`, and the connection inbox. The fence itself belongs to
      // endpoint-serve-auth.smoke.ts; this row covers the widest shape the fence can release.
      const binds = [...effectsBindGrants(space, "manager"), ...poolOwnerBindGrants(space, "manager", "work"), "$JS.API.INFO"];
      rows.push({
        profile: "endpoint-serve", variant: "serve-rows-with-binds", producer: "epServeGrantRows",
        permissions: { pub: { allow: [...grant.pub, ...binds] }, sub: { allow: [...grant.sub, `_INBOX_${instance}.>`] } },
      });
    },
    "goal-writer": () => one("goal-writer", { goalWriter: { endpoint: "manager" } }),
    "session-caller": () => one("session-caller", { sessionCaller: { endpoint: "manager", sessionId: session, epoch: 1 } }),
    "session-serving": () => one("session-serving", { sessionServing: { endpoint: "manager", sessionId: session, epoch: 1 } }),
    "session-ledger": () => one("session-ledger"),
    "run-driver": () => one("run-driver", { runDriver: run }),
    "run-mediator": () => one("run-mediator", { runMediator: run }),
    "run-operator": () => one("run-operator", { runOperator: { endpoint: "manager", takeoverId: "take0001" } }),
    "endpoint-evictor": () => one("endpoint-evictor"),
    "remote-manager"() {
      for (const actor of [`manager_${instance}`, `manager_exec_${instance}`]) {
        one("remote-manager", { remoteManager: { owner: "local", instanceId: instance, actor } }, actor.startsWith("manager_exec") ? "executor" : "server", { ...principal, actor });
      }
    },
  };
  const nonProfiles = ["membership-observer", "connection-evictor"];
  assert.deepEqual(Object.keys(producers).sort(), Object.keys(CREDENTIAL_LIFETIMES).filter((kind) => !nonProfiles.includes(kind)).sort(), "every Profile must have a producer");
  for (const produce of Object.values(producers)) produce();
  const owner = deriveOwnerToken("census-prototype-secret".repeat(2), "view-owner");
  for (const view of USER_TOKEN_VIEWS) {
    const scope = [VIEW_REQUIRED_SCOPE[view]];
    const token = { owner, space, scope, ver: USER_TOKEN_VER, exp: 2_000_000_000, act: { owner, actor: "census", scope, lifecycleUid: uid, view } };
    const produce = calloutPermissions(() => ({ scope, lifecycleUid: uid, allowPublish: ["public"], allowSubscribe: ["public"] }));
    if (view === "manager-service") {
      assert.throws(() => produce(token, principal.connId), /typed material exchange/);
      continue; // Explicit refused view, represented separately from Profile in the report.
    }
    rows.push({ profile: view, variant: `callout-view:${view}`, permissions: produce(token, principal.connId), producer: "calloutPermissions" });
  }
  assert.deepEqual(rows.filter((row) => row.producer === "calloutPermissions").map((row) => row.variant).sort(),
    USER_TOKEN_VIEWS.filter((view) => view !== "manager-service").map((view) => `callout-view:${view}`).sort(),
    "every generic callout view must have a producer");
  return rows;
}

// Conservative intersection with the whole candidate namespace, not merely one request.
// Queue qualifiers do not widen subject space; retain them in the reported original row.
export function namespaceOverlap(row: string, space: string): boolean {
  const pattern = row.split(" ")[0].split(".");
  const prefix = ["cotal", space, "ep", "v1"];
  for (let i = 0; i < prefix.length; i++) {
    if (pattern[i] === ">") return true;
    if (pattern[i] !== "*" && pattern[i] !== prefix[i]) return false;
  }
  return pattern.length > prefix.length;
}
export function namespaceGrants(permissions: Record<string, unknown>, space: string, direction: "pub" | "sub") {
  const value = permissions[direction] as { allow?: string[]; deny?: string[] } | undefined;
  const allow = value?.allow?.length ? value.allow : [">"];
  const deny = value?.deny ?? [];
  const overlaps = allow.filter((row) => namespaceOverlap(row, space));
  const wholeNamespaceDenied = deny.some((row) => !row.includes(" ") && patternCovers(row, `cotal.${space}.ep.v1.>`));
  return { overlaps, deny, potential: overlaps.length > 0 && !wholeNamespaceDenied };
}

/**
 * Which subject space each stream captures, for the write-plus-raw-read overlap check.
 * Explicit and closed: a raw read of a stream absent from this table FAILS the check rather
 * than passing it, so a new stream cannot quietly become invisible to the invariant.
 */
export function streamSubjects(space: string): Record<string, string> {
  const kv = (bucket: string) => `$KV.${bucket}.>`;
  return {
    [chatStream(space)]: `cotal.${space}.chat.>`,
    [dmStream(space)]: `cotal.${space}.dm.>`,
    [dlvStream(space)]: `cotal.${space}.dlv.>`,
    [inboxStream(space)]: `cotal.${space}.inbox.>`,
    [taskStream(space)]: `cotal.${space}.svc.>`,
    [epcStreamName(space)]: `cotal.${space}.epc.>`,
    [epeStreamName(space)]: `cotal.${space}.epe.>`,
    [epfStreamName(space)]: `cotal.${space}.epf.>`,
    [epjStreamName(space)]: `cotal.${space}.epj.>`,
    [eprStreamName(space)]: `cotal.${space}.epr.>`,
    [eptStreamName(space)]: `cotal.${space}.ept.>`,
    [eptReqStreamName(space)]: `cotal.${space}.ept.>`,
    [epwStreamName(space)]: `cotal.${space}.epw.>`,
    [`KV_${channelBucket(space)}`]: kv(channelBucket(space)),
    [`KV_${presenceBucket(space)}`]: kv(presenceBucket(space)),
    [`KV_${membershipBucket(space)}`]: kv(membershipBucket(space)),
    [`KV_${deliveryBucket(space)}`]: kv(deliveryBucket(space)),
    [`KV_${managerBucket(space)}`]: kv(managerBucket(space)),
    [`KV_${membersBucket(space)}`]: kv(membersBucket(space)),
    [`KV_${aclBucket(space)}`]: kv(aclBucket(space)),
    [`KV_${epAuthBucket(space)}`]: kv(epAuthBucket(space)),
    [`KV_${recordsBucket(space)}`]: kv(recordsBucket(space)),
    // Candidate stores the issued contract would add. No shipped profile touches them; they are
    // listed so a ceiling carrying the contract's own grants can be checked for the overlap.
    [`KV_cotal_issued_${space}`]: kv(`cotal_issued_${space}`),
    [`KV_cotal_accepted_${space}`]: kv(`cotal_accepted_${space}`),
    [`KV_${sessionsBucket(space)}`]: kv(sessionsBucket(space)),
  };
}

/**
 * Streams a credential can BOTH write into and read raw bytes out of by a caller-chosen
 * destination (`DIRECT.GET` / `STREAM.MSG.GET`). That pairing is what would let a holder place
 * bytes of its own choosing under any subject, so it is the condition the issued rail's origin
 * assumption cannot survive. THROWS on a raw read of a stream this module does not model.
 */
export function writeAndRawReadStreams(permissions: Record<string, unknown>, space: string): string[] {
  const table = streamSubjects(space);
  const pub = ((permissions.pub as { allow?: string[] } | undefined)?.allow ?? []).map((row) => row.split(" ")[0]);
  const rawRead = new Set<string>();
  // Only the two reads that deliver UNDER a caller-chosen reply subject count here. A pull
  // `CONSUMER.MSG.NEXT` also delivers to a chosen reply, but the frame keeps its original captured
  // subject, which the ingress-origin suite measures, so it cannot place bytes on the rail.
  for (const row of pub) {
    const direct = /^\$JS\.API\.DIRECT\.GET\.([^.]+)/.exec(row) ?? /^\$JS\.API\.STREAM\.MSG\.GET\.([^.]+)/.exec(row);
    if (!direct) continue;
    const stream = direct[1];
    if (stream === "*" || stream === ">")
      throw new Error(`a raw read grant covers every stream (${row}); the overlap check cannot model it`);
    if (!(stream in table)) throw new Error(`raw read of unmodelled stream "${stream}" (${row}); extend streamSubjects()`);
    rawRead.add(stream);
  }
  const writable = (stream: string): boolean =>
    pub.some((row) => !row.startsWith("$JS.API.") && subjectCoveredBy(table[stream], row));
  return [...rawRead].filter(writable).sort();
}

/** True when a publish grant row lands anywhere inside a stream's captured subject space. */
function subjectCoveredBy(streamPattern: string, grantRow: string): boolean {
  const prefix = streamPattern.replace(/\.>$/, "").split(".");
  const row = grantRow.split(".");
  for (let i = 0; i < prefix.length; i++) {
    if (row[i] === undefined) return false;
    if (row[i] === ">") return true;
    if (row[i] !== "*" && prefix[i] !== "*" && row[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * The profiles an ordinary, untrusted peer can be handed. Closed and explicit: the write-plus-raw-read
 * pairing is expected in the trusted infrastructure profiles (they ARE the trusted plane), and is the
 * condition the issued rail's origin assumption cannot survive in a peer-held credential.
 */
export const PEER_HELD_PROFILES: readonly Profile[] = Object.freeze(["agent", "observer", "session-caller", "run-driver"]);

/**
 * The rest, classified as trusted infrastructure or operator credentials. Peer-heldness is a
 * property of deployment rather than of this repo, so no cell can settle the partition. What the
 * closed union does buy is that a NEW profile lands in neither list and fails, forcing whoever
 * adds it to decide, instead of drifting into "trusted" by default.
 */
export const TRUSTED_PROFILES: readonly Profile[] = Object.freeze([
  "supervisor", "operator", "provisioner", "deprovisioner", "admin", "purger", "probe", "delivery",
  "teardown", "channel-writer", "channel-purger", "membership-rw", "deployer", "goal-writer",
  "session-ledger", "session-serving", "run-mediator", "run-operator", "remote-manager",
  "lifecycle-executor", "endpoint-serve-executor", "endpoint-serve", "control-caller-privileged",
  "control-caller-admin", "backup", "restore", "endpoint-evictor", "retirement-requester",
]);

/** Every shipped `.ts` under the source trees a credential's grants can come from. */
export function shippedSources(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "dist" && entry.name !== "node_modules" && entry.name !== "smoke") walk(full); }
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(full);
    }
  };
  for (const tier of ["packages", "implementations", "extensions"]) {
    const base = join(root, tier);
    for (const pkg of readdirSync(base, { withFileTypes: true })) {
      const src = join(base, pkg.name, "src");
      if (pkg.isDirectory() && existsSync(src)) walk(src);
    }
  }
  if (found.length === 0) throw new Error("the shipped-source scan found no files; the corpus is wrong");
  return found;
}

/** Whether a permission set lets its holder request `$SYS.REQ.USER.INFO`, the server's own view
 *  of the connection that accepted-generation discovery reads. */
export function holdsServerView(permissions: Record<string, unknown>): boolean {
  const pub = ((permissions.pub as { allow?: string[] } | undefined)?.allow ?? []).map((row) => row.split(" ")[0]);
  return pub.some((row) => row === ">" || row === "$SYS.>" || row.startsWith("$SYS.REQ.USER"));
}

/** How a JetStream grant can put bytes on a subject the requester chooses. Every `$JS.` grant a
 *  profile holds must fall in exactly one class, so a new grant forces a decision rather than
 *  silently widening the set of delivery paths the origin argument quantifies over.
 *  - `api-envelope`: the response is a JetStream API JSON envelope. It reaches the chosen reply
 *    subject, but its wrapper is not caller-shapeable, and a stored payload inside it needs a
 *    write on the same stream, which `writeAndRawReadStreams` forbids for peer-held profiles.
 *  - `stored-captured-subject`: delivers stored bytes, under the message's own captured subject.
 *  - `stored-marked`: delivers raw stored bytes under the chosen subject, carrying `Nats-` headers.
 *  - `creates-push-delivery`: the response is an API envelope, but the call also creates a consumer
 *    that can carry a caller-chosen `deliver_subject`. Its own ground is separate and measured:
 *    push delivery is interest-gated and does not reach an endpoint's wildcard queue subscription.
 *  - `no-delivery`: publishes nothing back to a caller-chosen subject.
 *
 *  A verb that configures the SERVER to publish on the holder's behalf, such as a stream create or
 *  update carrying `republish`, is deliberately absent. No peer-held profile holds one, and the
 *  table refuses an unclassified verb rather than guessing, so granting one forces a decision.
 *  Classes two and three are measured in `issued-ingress-origin.smoke.ts`, and so is the
 *  `$SYS.REQ.USER.INFO` response the issued contract's discovery rule would add. */
export type DeliveryClass = "api-envelope" | "stored-captured-subject" | "stored-marked" | "creates-push-delivery" | "no-delivery";
const DELIVERY_CLASSES: readonly (readonly [RegExp, DeliveryClass])[] = Object.freeze([
  [/^\$JS\.API\.DIRECT\.GET\./, "stored-marked"],
  [/^\$JS\.API\.CONSUMER\.MSG\.NEXT\./, "stored-captured-subject"],
  [/^\$JS\.API\.CONSUMER\.CREATE\./, "creates-push-delivery"],
  [/^\$JS\.API\.(INFO$|STREAM\.(INFO|MSG\.GET)\.|CONSUMER\.(INFO|DELETE)\.)/, "api-envelope"],
  [/^\$JS\.(ACK|FC)\./, "no-delivery"],
  // The discovery grant the issued contract adds. Its response reaches a caller-chosen reply
  // subject with no headers, measured in issued-ingress-origin.smoke.ts, so it belongs here rather
  // than outside the table. Its body is a server-authored JSON document the caller cannot shape.
  [/^\$SYS\.REQ\.USER\.INFO$/, "api-envelope"],
] as const);

export function deliveryClassOf(row: string): DeliveryClass {
  const subject = row.split(" ")[0];
  for (const [pattern, cls] of DELIVERY_CLASSES) if (pattern.test(subject)) return cls;
  throw new Error(`unclassified JetStream grant "${subject}"; decide which delivery class it is before the origin argument can quantify over it`);
}

/** Every `$JS.` or `$SYS.` publish grant in a permission set, with its delivery class. */
export function deliveryPaths(permissions: Record<string, unknown>): { row: string; cls: DeliveryClass }[] {
  return ((permissions.pub as { allow?: string[] } | undefined)?.allow ?? [])
    .map((row) => row.split(" ")[0])
    .filter((row) => row.startsWith("$JS.") || row.startsWith("$SYS."))
    .map((row) => ({ row, cls: deliveryClassOf(row) }));
}

/**
 * The claim ledger cites cells and mutations by name. A citation that no longer resolves is worse
 * than no ledger, so the names are extracted and checked rather than trusted. Only explicitly
 * quoted names are extracted; the "cell of that name" idiom refers to the claim text and is out of
 * scope, which is why the caller also asserts a floor on how many citations were found.
 */
export function ledgerCitations(markdown: string): { cells: string[]; mutations: string[] } {
  const cells = new Set<string>(), mutations = new Set<string>();
  // Only the contiguous run of quoted names directly after the keyword is a citation. A quoted
  // phrase later in the same cell is prose, and reading it as a citation makes the check fail on
  // rows that cite nothing wrong.
  for (const match of markdown.matchAll(/\b(cells?|mutations?)\b((?:\s*(?:and\s+)?"[^"]+"\s*[,;]?)+)/g)) {
    const target = match[1].startsWith("cell") ? cells : mutations;
    for (const quoted of match[2].matchAll(/"([^"]+)"/g)) target.add(quoted[1]);
  }
  return { cells: [...cells].sort(), mutations: [...mutations].sort() };
}

/** Every `check("…")` name in a suite source, awaited or not. */
export function suiteCellNames(source: string): string[] {
  const names = [...source.matchAll(/\bcheck\(\s*"([^"]+)"/g)].map((m) => m[1]);
  // A cell built from a template literal has no single literal name. Expand the one shape used
  // here, `${label} …`, against the labels the loop iterates, so the ledger can cite each real
  // cell rather than a collapsed family name a reader cannot search for.
  for (const built of source.matchAll(/\bcheck\(\s*`\$\{label\}([^`]+)`/g)) {
    for (const label of source.matchAll(/^\s*\["([a-z-]+)",/gm)) names.push(`${label[1]}${built[1]}`);
  }
  return names;
}

/**
 * Every stream, consumer and direct API verb the INSTALLED client library can call, read out of
 * its own source. The exhaustiveness claim quantifies over grants a peer could hold, and the set
 * a client can usefully hold is bounded by what its library can call. Reading the library rather
 * than typing a list means a version bump that adds a verb forces a classification decision
 * instead of silently widening the set the origin argument ranges over.
 */
export function clientApiVerbs(libDir: string): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(libDir).filter((name) => name.endsWith(".js"))) {
    for (const match of readFileSync(join(libDir, file), "utf8").matchAll(/\b(STREAM|CONSUMER|DIRECT)((?:\.[A-Z]+)+)\b/g))
      found.add(`${match[1]}${match[2]}`);
  }
  if (found.size < 15) throw new Error(`only ${found.size} API verbs found under ${libDir}; the extractor is not reading the library`);
  return [...found].sort();
}

/**
 * Verbs that configure where the SERVER delivers: a stream's `republish`, and the two subjects
 * that create a consumer carrying a `deliver_subject`. `CONSUMER.DURABLE.CREATE` is the legacy
 * spelling of `CONSUMER.CREATE` and creates the same push consumer, so a classifier that knows
 * only the modern spelling covers one of two doors. None of these may ever be an envelope class.
 */
export const DELIVERY_CONFIGURING_VERBS: readonly string[] = Object.freeze([
  "STREAM.CREATE", "STREAM.UPDATE", "CONSUMER.CREATE", "CONSUMER.DURABLE.CREATE",
]);
