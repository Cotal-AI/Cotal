import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { jetstream } from "@nats-io/jetstream";
import { DiscardPolicy, RetentionPolicy, StorageType, jetstreamManager, type JetStreamManager, type MsgRequest, type NextMsgRequest, type StreamInfo } from "@nats-io/jetstream";
import { EpEnvelopeError, EP_AUTH_MARKER_TTL_MS, assertInboxConnId, canonicalJson, epAuthBucket, isCasLoss, isJetStreamMissing,
  parseToolResultConsent, parseToolResultRevocation, type ToolResultConsent, type ToolResultRevocation, type ToolResultServingMaterial, type ToolResultTarget } from "@cotal-ai/core";
import { openAuthorityClient, type AuthorityClient, type AuthorityClientOpts } from "./authority-client.js";
import { assertAuthorityStreamShape } from "./lifecycle-registry.js";

/** Host-private infrastructure, not agent descendants. Raw grants do NOT enforce CAS, schema,
 * TTL or target binding. Those are mediated below. Compromised MSG.GET can inject fetched bytes
 * onto a FOREIGN SUBJECT (SPEC13.9), even without data publish authority or a broad inbox. */
export function toolResultRevocationWriterGrants(space: string, connId: string) {
  return { publish: [`$KV.${epAuthBucket(space)}.revocation.*.*`], subscribe: [`_INBOX_${assertInboxConnId(connId)}.>`] };
}
export function toolResultSnapshotReaderGrants(space: string, connId: string) {
  const stream = `KV_${epAuthBucket(space)}`;
  return { publish: ["$JS.API.INFO", `$JS.API.STREAM.INFO.${stream}`, `$JS.API.STREAM.MSG.GET.${stream}`],
    subscribe: [`_INBOX_${assertInboxConnId(connId)}.>`] };
}

type SnapshotValue = ToolResultServingMaterial["snapshot"];
export interface ToolResultSnapshotWitness { readonly snapshot: Readonly<SnapshotValue>; }
export interface ToolResultRevocationCustody { readonly space: string; readonly accountPublicKey: string; close(): Promise<void>; }
export interface ToolResultSnapshotRequest { accountPublicKey: string; target: ToolResultTarget; deadline: number; maxEntries: number; maxBytes: number; signal?: AbortSignal; }
interface Receipt { key: string; sequence: number; digest: string; consent: ToolResultConsent; }
interface State {
  space: string; account: string; stream: string; generation: string; directory: string;
  reader: AuthorityClient; writer: AuthorityClient; jsm: JetStreamManager;
  authorizeConsent: (consent: ToolResultConsent) => Promise<void>;
  authorizeTarget: (target: ToolResultTarget) => Promise<void>;
  directoryIdentity: string;
  identity: string; broker: string; journal: Map<string, string>; receipts: Map<string, Receipt>;
  valid: boolean; tail: Promise<void>;
}
const STATES = new WeakMap<ToolResultRevocationCustody, State>();
const WITNESSES = new WeakMap<ToolResultSnapshotWitness, { state: State; target: string; used: boolean; artifact: string }>();
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fail(code: "bad-request" | "permission-denied" | "unavailable" | "conflict", message: string, outcome: "not-executed" | "executed" | "unknown" = "not-executed"): never {
  throw new EpEnvelopeError(code, message, undefined, outcome);
}
function stateOf(custody: ToolResultRevocationCustody): State {
  const state = STATES.get(custody);
  if (!state) fail("permission-denied", "unrecognized revocation custody");
  if (!state.valid || state.reader.nc.isClosed() || state.writer.nc.isClosed()) fail("unavailable", "revocation custody lost; no reopen from current INFO");
  return state;
}
function durableCreate(directory: string, name: string, value: unknown): string {
  const bytes = canonicalJson(value);
  const fd = openSync(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
  return sha(bytes);
}
function journalCheck(state: State) {
  const directory = lstatSync(state.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700 || directory.uid !== process.getuid?.() || `${directory.dev}:${directory.ino}` !== state.directoryIdentity)
    fail("unavailable", "revocation custody directory is not private");
  for (const [name, digest] of state.journal) {
    const p = join(state.directory, name);
    const st = lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o777) !== 0o600 || st.uid !== process.getuid?.() || sha(readFileSync(p)) !== digest)
      fail("unavailable", "revocation custody journal changed");
  }
}
function targetKey(target: ToolResultTarget): string {
  // Reuse the frozen target grammar without a second principal/schema definition.
  parseToolResultRevocation({ v: 1, kind: "tool-result-revocation", space: "validation", consentId: "validation", target, revokedAt: 0 });
  return sha(canonicalJson(target));
}
function identity(info: StreamInfo, state: Pick<State, "space" | "stream" | "generation">): string {
  const cfg = info.config;
  assertAuthorityStreamShape(cfg, epAuthBucket(state.space));
  if (cfg.name !== state.stream) fail("unavailable", "revocation stream name changed");
  if (cfg.allow_direct !== false || cfg.allow_msg_ttl !== true) fail("unavailable", "revocation stream direct/TTL flags unproved");
  if (cfg.metadata?.["cotal_tool_result_generation"] !== state.generation || !info.created)
    fail("unavailable", "revocation authority store generation changed");
  return canonicalJson({ created: info.created, config: cfg });
}
async function prove(state: State): Promise<StreamInfo> {
  try {
    if (!state.valid || state.reader.nc.isClosed() || state.writer.nc.isClosed() || state.reader.nc.info?.server_id !== state.broker || state.writer.nc.info?.server_id !== state.broker) fail("unavailable", "revocation custody disconnected or broker identity changed");
    journalCheck(state);
    const info = await state.jsm.streams.info(state.stream);
    if (identity(info, state) !== state.identity || !state.valid || state.reader.nc.isClosed() || state.writer.nc.isClosed())
      fail("unavailable", "revocation store continuity lost");
    return info;
  } catch {
    state.valid = false;
    fail("unavailable", "revocation store continuity unavailable; no automatic recovery");
  }
}

/** FRESH, dedicated trusted-host provisioning only. Never adopts an existing auth stream, journal
 * or running authority owner. Persist-before-create with fsync; crash recovery is deliberately
 * unavailable. The trusted host exclusively holds account/provisioning keys: this is NOT a claim
 * against a malicious administrator or an independently running privileged provisioner.
 * Any real connection/process loss, including routine broker restart or upgrade, permanently
 * disables gate 1 for this space. No retirement/reprovision recovery is provided here. */
export async function createToolResultRevocationCustody(opts: Pick<AuthorityClientOpts, "server" | "space" | "dataAccount" | "log"> & { directory: string; authorizeConsent: (consent: ToolResultConsent) => Promise<void>; authorizeTarget: (target: ToolResultTarget) => Promise<void> }): Promise<ToolResultRevocationCustody> {
  if (process.platform !== "linux") fail("unavailable", "revocation custody requires qualified local Linux filesystem semantics");
  const generation = randomUUID();
  const bucket = epAuthBucket(opts.space), stream = `KV_${bucket}`;
  const clients: AuthorityClient[] = [];
  let state: State | undefined;
  let phase = "private intent";
  const open = async (label: string, grants: (space: string, id: string) => { publish: string[]; subscribe: string[] }, custody = false) => {
    // Public callers cannot forward internal mint/connect controls or observe credentials.
    const client = await openAuthorityClient({ server: opts.server, space: opts.space,
      dataAccount: { pub: opts.dataAccount.pub, signingSeed: opts.dataAccount.signingSeed }, log: opts.log,
      label, grants: id => grants(opts.space, id), noReconnect: true,
      ...(custody ? { toolResultCustody: true } : {}) });
    clients.push(client);
    void client.nc.closed().then(() => { if (state && (state.reader === client || state.writer === client)) state.valid = false; });
    return client;
  };
  try {
    // Exclusive directory claim is also the process-lifetime owner claim. Never reclaimed.
    const parentPath = join(opts.directory, "..");
    const parentStat = lstatSync(parentPath);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== process.getuid?.() || (parentStat.mode & 0o077) !== 0 || statfsSync(parentPath).type !== 0xef53)
      fail("unavailable", "fresh custody requires an owner-private local ext4 parent");
    mkdirSync(opts.directory, { mode: 0o700 });
    const parent = openSync(parentPath, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    const journal = new Map<string, string>();
    journal.set("intent.json", durableCreate(opts.directory, "intent.json", { v: 1, generation, space: opts.space, account: opts.dataAccount.pub, stream, server: opts.server }));
    phase = "reader bind";
    const reader = await open("cotal:tool-result-snapshot", toolResultSnapshotReaderGrants, true);
    const jsm = await jetstreamManager(reader.nc);
    try { await jsm.streams.info(stream); fail("unavailable", "existing auth store has no qualified custody history"); }
    catch (error) { if (!isJetStreamMissing(error, 10059)) throw error; }
    phase = "fresh native create";
    const provisioning = await open("cotal:tool-result-create", (space, id) => ({ publish: ["$JS.API.INFO", `$JS.API.STREAM.CREATE.KV_${epAuthBucket(space)}`], subscribe: [`_INBOX_${assertInboxConnId(id)}.>`] }));
    const manager = await jetstreamManager(provisioning.nc);
    await manager.streams.add({ name: stream, subjects: [`$KV.${bucket}.>`], storage: StorageType.File, retention: RetentionPolicy.Limits,
      num_replicas: 1, max_msgs_per_subject: 1, max_msgs: -1, max_bytes: -1, max_age: 0, discard: DiscardPolicy.New,
      allow_direct: false, allow_msg_ttl: true, subject_delete_marker_ttl: EP_AUTH_MARKER_TTL_MS * 1_000_000,
      metadata: { cotal_tool_result_generation: generation } });
    await provisioning.close();
    const info = await jsm.streams.info(stream);
    if (info.state.messages !== 0 || info.state.last_seq !== 0) fail("unavailable", "fresh auth store is not empty");
    phase = "writer bind";
    const writer = await open("cotal:tool-result-revocation", toolResultRevocationWriterGrants, true);
    const dirStat = lstatSync(opts.directory);
    state = { space: opts.space, account: opts.dataAccount.pub, stream, generation, directory: opts.directory, directoryIdentity: `${dirStat.dev}:${dirStat.ino}`, reader, writer, jsm, authorizeConsent: opts.authorizeConsent, authorizeTarget: opts.authorizeTarget,
      identity: "", broker: reader.nc.info?.server_id ?? "", journal, receipts: new Map(), valid: true, tail: Promise.resolve() };
    if (!state.broker || writer.nc.info?.server_id !== state.broker || reader.nc.info?.cluster || writer.nc.info?.cluster) fail("unavailable", "unproven singleton broker identity");
    phase = "creation journal and continuity";
    state.identity = identity(info, state);
    phase = "creation journal durable write";
    journal.set("created.json", durableCreate(opts.directory, "created.json", { generation, broker: reader.nc.info?.server_id, identity: state.identity }));
    const s = state;
    const custody = Object.freeze({ space: opts.space, accountPublicKey: opts.dataAccount.pub, close: async () => {
      s.valid = false;
      await Promise.all(clients.map(client => client.close()));
    } });
    STATES.set(custody, s);
    await prove(s);
    return custody;
  } catch {
    if (state) state.valid = false;
    await Promise.all(clients.map(client => client.close().catch(() => {})));
    fail("unavailable", `fresh revocation custody unavailable at ${phase}; intent retained, no adoption or retry`);
  }
}

/** Consent must come from the host's authenticated consent path. Byte-compare its recorded native
 * consent before accepting a marker. No raw headers/TTL/delete options or caller timestamp exist. */
export async function recordToolResultRevocation(custody: ToolResultRevocationCustody, raw: unknown): Promise<ToolResultRevocation> {
  const consent = parseToolResultConsent(raw);
  const s = stateOf(custody);
  if (consent.space !== s.space) fail("permission-denied", "foreign consent space");
  const task = s.tail.then(async () => {
    await s.authorizeConsent(consent);
    await prove(s);
    const recorded = await s.jsm.streams.getMessage(s.stream, { last_by_subj: `$KV.${epAuthBucket(s.space)}.consent.${consent.id}` });
    if (!recorded || recorded.header?.get("KV-Operation") || canonicalJson(parseToolResultConsent(JSON.parse(new TextDecoder().decode(recorded.data)))) !== canonicalJson(consent))
      fail("permission-denied", "consent is not its recorded target and expiry");
    const key = `revocation.${targetKey(consent.target)}.${consent.id}`;
    if (s.receipts.has(key)) fail("conflict", "consent revocation is already recorded");
    const marker = parseToolResultRevocation({ v: 1, kind: "tool-result-revocation", space: s.space, target: consent.target, consentId: consent.id, revokedAt: Date.now() });
    const data = new TextEncoder().encode(canonicalJson(marker));
    const name = `operation-${randomUUID()}.json`;
    s.journal.set(name, durableCreate(s.directory, name, { key, digest: sha(data), consent }));
    await s.authorizeConsent(consent);
    await prove(s);
    let sequence: number;
    try { sequence = (await jetstream(s.writer.nc).publish(`$KV.${epAuthBucket(s.space)}.${key}`, data, { expect: { lastSubjectSequence: 0 } })).seq; }
    catch (error) {
      s.valid = false;
      if (isCasLoss(error)) fail("conflict", "conflicting revocation; custody invalidated");
      fail("unavailable", "revocation persistence unknown; no automatic repeat", "unknown");
    }
    if (!Number.isSafeInteger(sequence) || sequence <= 0) { s.valid = false; fail("unavailable", "invalid native revocation acknowledgement", "unknown"); }
    // A native ACK proves the effect. A later local receipt, continuity or host-authority
    // refusal cannot turn an already-committed revocation into a not-executed response.
    try {
      const receipt = { key, sequence, digest: sha(data), consent };
      const receiptName = `receipt-${sequence}.json`;
      try { s.journal.set(receiptName, durableCreate(s.directory, receiptName, receipt)); }
      catch { s.valid = false; fail("unavailable", "revocation acknowledged but custody receipt is unknown; no retry", "executed"); }
      s.receipts.set(key, receipt);
      await prove(s);
      await s.authorizeConsent(consent);
      stateOf(custody);
      return marker;
    } catch (error) {
      if (error instanceof EpEnvelopeError)
        throw new EpEnvelopeError(error.code, error.message, error.details, "executed");
      throw new EpEnvelopeError("unavailable", "revocation committed; post-commit custody or authorization failed", undefined, "executed");
    }
  });
  s.tail = task.then(() => {}, () => {});
  return task;
}

/** T0 before any IO. Finite leader-W cut, never moving-tail walkKvLatest output. Complete native
 * sequence/body evidence is compared to independently fsynced receipts. Existing/unproven stores,
 * uncertain reconnect/failover, receipt gaps, caps or cancellation cannot produce a witness. */
export async function snapshotToolResultRevocations(custody: ToolResultRevocationCustody, request: ToolResultSnapshotRequest): Promise<ToolResultSnapshotWitness> {
  const t0 = Date.now(), started = performance.now();
  const s = stateOf(custody);
  if (!request || Object.keys(request).some(key => !["accountPublicKey", "target", "deadline", "maxEntries", "maxBytes", "signal"].includes(key)) || !Number.isSafeInteger(request.deadline) || request.deadline <= t0 ||
      !Number.isSafeInteger(request.maxEntries) || request.maxEntries <= 0 || request.maxEntries > 100_000 ||
      !Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0 || request.maxBytes > 64 * 1024 * 1024)
    fail("bad-request", "invalid bounded snapshot request");
  if (request.accountPublicKey !== s.account) fail("permission-denied", "snapshot account mismatch");
  const digest = targetKey(request.target), target = canonicalJson(request.target);
  const { deadline, maxEntries, maxBytes, signal } = request;
  const check = () => {
    stateOf(custody);
    if (signal?.aborted || Date.now() < t0 || Date.now() >= deadline || performance.now() - started >= deadline - t0)
      fail("unavailable", "snapshot cancelled or deadline exceeded");
  };
  const prefix = `$KV.${epAuthBucket(s.space)}.revocation.${digest}.`;
  // Serialize with ACK-to-receipt publication. A native marker can be committed while
  // its fsynced independent receipt is still pending, never mistake that gap for success.
  const task = s.tail.then(async () => {
    check();
    await s.authorizeTarget(JSON.parse(target)); check();
    const info = await prove(s); check();
    const watermark = info.state.last_seq, watermarkTakenAt = Date.now();
    if (!Number.isSafeInteger(watermark) || watermark < 0 || watermarkTakenAt < t0) fail("unavailable", "invalid watermark or host clock discontinuity");
    const expected = [...s.receipts.values()].filter(r => r.sequence <= watermark && r.key.startsWith(`revocation.${digest}.`));
    const found = new Set<string>(), evidence: Array<{ sequence: number; subject: string; digest: string }> = [];
    let sequence = 1, bytes = 0;
    while (sequence <= watermark) {
      check();
      let msg;
      try { const req: NextMsgRequest = { seq: sequence, next_by_subj: `${prefix}*` }; msg = await s.jsm.streams.getMessage(s.stream, req as unknown as MsgRequest); }
      catch (error) { if (!isJetStreamMissing(error, 10037)) fail("unavailable", "leader snapshot read failed"); }
      check();
      if (!msg) break;
      if (!Number.isSafeInteger(msg.seq) || msg.seq < sequence || !msg.subject.startsWith(prefix)) fail("unavailable", "nonmonotonic or foreign snapshot row");
      if (msg.seq > watermark) break;
      bytes += msg.data.length;
      if (found.size >= maxEntries || bytes > maxBytes) fail("unavailable", "snapshot count or byte cap exceeded");
      let marker: ToolResultRevocation;
      try { marker = parseToolResultRevocation(JSON.parse(new TextDecoder().decode(msg.data))); }
      catch { fail("unavailable", "malformed revocation row"); }
      const key = `revocation.${digest}.${marker.consentId}`, receipt = s.receipts.get(key);
      if (msg.header?.get("KV-Operation") || marker.space !== s.space || canonicalJson(marker.target) !== target || msg.subject !== `$KV.${epAuthBucket(s.space)}.${key}` ||
          found.has(key) || !receipt || receipt.sequence !== msg.seq || receipt.digest !== sha(msg.data) || canonicalJson(receipt.consent.target) !== target)
        fail("unavailable", "revocation receipt or target continuity mismatch");
      found.add(key); evidence.push({ sequence: msg.seq, subject: msg.subject, digest: receipt.digest });
      sequence = msg.seq + 1;
    }
    if (expected.length !== found.size || expected.some(r => !found.has(r.key))) fail("unavailable", "snapshot omitted acknowledged revocation");
    await prove(s); check();
    await s.authorizeTarget(JSON.parse(target)); check();
    const snapshot = Object.freeze({ t0, watermark, watermarkTakenAt, revokedConsentIds: Object.freeze(expected.map(r => r.consent.id).sort()) as unknown as string[] });
    const witness = Object.freeze({ snapshot });
    // Committed-W artifact binds exact immutable sequence/subject/payload evidence AND custody.
    WITNESSES.set(witness, { state: s, target, used: false, artifact: sha(canonicalJson({ generation: s.generation, account: s.account, identity: s.identity, snapshot, evidence })) });
    return witness;
  });
  s.tail = task.then(() => {}, () => {});
  return task;
}

/** One-shot prerequisite consumption only. It issues no material and cannot replace gate2. */
export async function consumeToolResultSnapshot(custody: ToolResultRevocationCustody, witness: ToolResultSnapshotWitness, target: ToolResultTarget): Promise<Readonly<SnapshotValue>> {
  const s = stateOf(custody), targetIdentity = canonicalJson(target), proof = WITNESSES.get(witness);
  if (!proof || proof.used || proof.state !== s || proof.target !== targetIdentity) fail("permission-denied", "forged, reused or mismatched snapshot witness");
  proof.used = true;
  await prove(s);
  await s.authorizeTarget(JSON.parse(targetIdentity));
  stateOf(custody);
  if (Date.now() < witness.snapshot.t0 || Date.now() - witness.snapshot.t0 > 30_000 || Date.now() >= (Math.floor(witness.snapshot.t0 / 1000) + 600) * 1000)
    fail("unavailable", "snapshot prerequisite expired");
  return witness.snapshot;
}

/** No runtime in source supplies protected same-kernel clock-domain/generation/suspension proof.
 * Never invent delta, sample Date.now as evidence, or treat AgentHandle.pid as clock authority. */
export function requireToolResultClockPrerequisite(): never {
  return fail("unavailable", "trusted native runtime clock evidence unavailable; private result issuance disabled");
}
