import * as prompts from "../lib/prompts.js";
import { Kvm } from "@nats-io/kv";
import { JetStreamApiCodes, jetstreamManager } from "@nats-io/jetstream";
import { PermissionViolationError, type NatsConnection } from "@nats-io/transport-node";
import { canPrompt } from "./meshes-wizard.js";
import {
  dialerFor, isJetStreamMissing, isTransferStream, liveKvEntries, mintCreds,
  mintLifecycleUid, newIdentity, observeBrokerConnectionIdentity, presenceBucket,
  spaceDeletionStreams, standaloneConnectOpts, token, validateSpaceAuth,
  type ParsedArgs, type Presence, type SpaceAuth,
} from "@cotal-ai/core";
import {
  brokerAddressForDisplay, CommandFailure, findMesh, findPreparedSpace, getSpaceAuth, localProcessPath, oneLine, presentationOf,
  renderReport, resolveNativeServiceTarget, terminalWidth, workspaceSecretStore, writeResult, type MeshEntry, type Report,
} from "@cotal-ai/workspace";
import { pidfileState } from "./down.js";
import { localProcessSurface } from "../ext-loader.js";
import { observeServiceProcess, serviceInstances } from "../lib/service-instances.js";
import { processGone, readStackJournal, STACK_ADAPTER } from "../lib/stack-journal.js";

interface DeletionStream { name: string; kind: "stream" | "bucket" | "object-store"; state: "present" | "absent"; messages: number | null }
interface PresenceImpact { id: string; name: string | null; status: string | null; lastHeartbeat: number | null }

/** A space this machine started whose own services still read and write its streams. Deleting the
 *  streams under them leaves a stack that can neither start nor stop. On a controller root every
 *  service instance of the space other than its broker counts, and on a legacy root every recorded
 *  daemon other than the broker, unless its process is proven gone. The delete needs the broker
 *  itself, so it is not counted. A space registered for another machine's broker is not checked. */
function liveStackRefusal(entry: MeshEntry, space: string, preview = false): CommandFailure | undefined {
  if (entry.origin !== "up") return undefined;
  let controller: boolean, users: string[];
  try {
    controller = readStackJournal(entry.root)?.journal.space === space;
    users = controller
      ? serviceInstances(space).filter((row) => row.record.value.adapter?.name !== STACK_ADAPTER.broker && !processGone(observeServiceProcess(row.record.value))).map((row) => row.record.value.definition)
      : localProcessSurface().filter((component) => !component.stopLast && pidfileState(localProcessPath(component.pidFile, { root: entry.root, space })).liveness !== "dead").map((component) => component.label);
  } catch { return new CommandFailure("refused", "TARGET_UNAVAILABLE", "this space's local service and process records could not be read, so a running stack was not ruled out; no broker was contacted", { target: { space, root: entry.root } }); }
  if (!users.length) return undefined;
  // A preview reads the broker before it reports this, so only the apply says no broker was contacted.
  return new CommandFailure("refused", "LIFECYCLE_BLOCKED", `this space's stack still runs here (${[...new Set(users)].join(", ")}) and uses these streams${preview ? "" : "; no broker was contacted and nothing was deleted"}`, { target: { space, root: entry.root, running: [...new Set(users)] }, remedy: controller
    ? `stop it with cotal down --yes from ${entry.root}, then remove its stored streams with cotal reset store ${space} --yes`
    : `stop it with cotal down from ${entry.root}, then remove its stored streams with cotal clean store --force there` });
}

/** A finite native observation. It does not authorize deletion or form an atomic impact plan. */
async function readSpaceDeletion(name: string) {
  let entry: ReturnType<typeof findMesh>;
  try { entry = findMesh(name); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the local registry could not be read; no live space deletion target was inferred", { target: { space: name } }); }
  if (!entry) {
    // A prepared space has a name and a root but no running broker whose streams could be deleted.
    let prepared: ReturnType<typeof findPreparedSpace>;
    try { prepared = findPreparedSpace(name); }
    catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the local prepared-space records could not be read; no live space deletion target was inferred", { target: { space: name } }); }
    if (prepared) {
      // Starting a stopped stack to delete its streams meets the running-stack refusal, so name the
      // command that removes them while it is stopped. One that never ran has no streams to remove.
      let stopped: boolean;
      try { stopped = readStackJournal(prepared.root)?.journal.space === name; } catch { stopped = true; }
      throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `"${oneLine(name)}" is prepared and not running, so it has no live broker to delete from; no broker was contacted`, { target: { space: name, root: prepared.root }, remedy: stopped
        ? `remove its stored streams with cotal reset store ${oneLine(name)} --yes, or remove only the local record with cotal space forget ${oneLine(name)}`
        : `no stack has run for it in ${oneLine(prepared.root)}, so it has no stored streams; remove its local record with cotal space forget ${oneLine(name)}` });
    }
    throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no registered space has this exact name; no broker was contacted", { target: { space: name }, remedy: "see the registered spaces with cotal space" });
  }
  if (entry.mode === "user") throw new CommandFailure("refused", "UNSUPPORTED", "this native deletion inventory has no supported user-auth view; no open or static identity was substituted", { target: { space: name } });
  try {
    const selected = resolveNativeServiceTarget(entry.root, name, entry.server);
    if (selected.mode !== entry.mode || selected.tlsRequired !== (entry.tlsRequired === true)) throw new Error("registered target changed");
  } catch { throw new CommandFailure("refused", "CONFLICT", "the registered root, space, broker URL or TLS requirement did not resolve as one supported native deletion target; no credential was prepared", { target: { space: name } }); }

  let credential: { creds: string; id: string; account: string } | undefined;
  let auth: SpaceAuth | undefined;
  if (entry.mode === "auth") {
    try {
      auth = validateSpaceAuth(await getSpaceAuth(workspaceSecretStore(entry.root), name), name);
      const identity = newIdentity();
      credential = { creds: await mintCreds(auth, identity, "teardown", { lifecycleUid: mintLifecycleUid(), transferStreams: [] }), id: identity.id, account: auth.account.pub };
    } catch { throw new CommandFailure("refused", "AUTH_REQUIRED", "the registered root did not supply current validated space trust; no credential or alternate root was substituted", { target: { space: name } }); }
  }
  const target = { space: name };
  let nc: NatsConnection;
  try {
    nc = await dialerFor(entry.server)({ servers: entry.server, ...standaloneConnectOpts({ ...(credential ? { creds: credential.creds } : {}), tls: entry.tlsRequired === true }), ...(credential ? { inboxPrefix: `_INBOX_${credential.id}` } : {}), timeout: 2_000, reconnect: false, maxReconnectAttempts: 0 });
  } catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the registered broker connection could not be established; no alternate address or identity was tried", { target }); }

  let snapshot: { streams: DeletionStream[]; presences: PresenceImpact[]; serverId: string; identity: "matched" | "explicit-open"; observedAt: string } | undefined;
  let failure: CommandFailure | undefined;
  let transferConnection: NatsConnection | undefined;
  let closed = false, transferClosed = true;
  try {
    const info = nc.info;
    if (!info || (info.auth_required !== undefined && typeof info.auth_required !== "boolean") || (info.auth_required === true) !== (entry.mode === "auth") || typeof info.server_id !== "string" || !info.server_id || /[\u0000-\u001f\u007f]/u.test(info.server_id))
      throw new CommandFailure("refused", "CONFLICT", "the connected broker did not confirm the registered mode and a usable server identity; no impact was inferred", { target });
    if (credential) {
      const identity = await observeBrokerConnectionIdentity(nc, { user: credential.id, account: credential.account });
      if (identity.state !== "matched") throw new CommandFailure("refused", identity.state === "permission-denied" ? "PERMISSION_DENIED" : identity.state === "target-mismatch" ? "CONFLICT" : "TARGET_UNAVAILABLE", "the native current-connection account and user were not confirmed; no deletion impact was accepted", { target });
    }
    const jsm = await jetstreamManager(nc);
    const transfers: string[] = [];
    for await (const stream of jsm.streams.names()) if (isTransferStream(name, stream)) transfers.push(stream);
    let transferManager: Awaited<ReturnType<typeof jetstreamManager>> | undefined;
    if (transfers.length && auth) {
      // The first credential can enumerate names but cannot inspect a transfer bucket it did
      // not name at mint. Mint a second, exact-name grant; do not widen the first connection.
      const identity = newIdentity();
      const creds = await mintCreds(auth, identity, "teardown", { lifecycleUid: mintLifecycleUid(), transferStreams: transfers });
      transferConnection = await dialerFor(entry.server)({ servers: entry.server, ...standaloneConnectOpts({ creds, tls: entry.tlsRequired === true }), inboxPrefix: `_INBOX_${identity.id}`, timeout: 2_000, reconnect: false, maxReconnectAttempts: 0 });
      if (transferConnection.info?.server_id !== info.server_id || transferConnection.info?.auth_required !== true)
        throw new CommandFailure("refused", "CONFLICT", "the exact-transfer reader did not reach the same authenticated broker; no combined impact was inferred", { target });
      const transferIdentity = await observeBrokerConnectionIdentity(transferConnection, { user: identity.id, account: auth.account.pub });
      if (transferIdentity.state !== "matched")
        throw new CommandFailure("refused", "CONFLICT", "the exact-transfer reader's native account and user were not confirmed; no combined impact was inferred", { target });
      transferManager = await jetstreamManager(transferConnection);
    }
    const streams: DeletionStream[] = [];
    for (const stream of spaceDeletionStreams(name, transfers)) {
      const kind = stream.startsWith("KV_") ? "bucket" : stream.startsWith("OBJ_") ? "object-store" : "stream";
      try {
        const observed = await (isTransferStream(name, stream) && transferManager ? transferManager : jsm).streams.info(stream);
        streams.push({ name: stream, kind, state: "present", messages: observed.state.messages });
      } catch (error) {
        if (!isJetStreamMissing(error, JetStreamApiCodes.StreamNotFound)) throw error;
        streams.push({ name: stream, kind, state: "absent", messages: null });
      }
    }
    const presences: PresenceImpact[] = [];
    if (streams.some((stream) => stream.name === `KV_${presenceBucket(name)}` && stream.state === "present")) {
      const kv = await new Kvm(nc).open(presenceBucket(name));
      for (const row of await liveKvEntries(kv)) {
        let peer: Presence;
        try { peer = row.json<Presence>(); }
        catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "a native presence entry could not be decoded; no complete impact snapshot was returned", { target }); }
        if (peer.card?.id !== row.key || typeof peer.card.name !== "string" || typeof peer.status !== "string" || !Number.isFinite(peer.ts))
          throw new CommandFailure("refused", "SCHEMA_INVALID", "a native presence entry failed its identity or timestamp check; no complete impact snapshot was returned", { target });
        presences.push({ id: row.key, name: peer.card.name, status: peer.status, lastHeartbeat: peer.ts });
      }
    }
    snapshot = { streams, presences, serverId: info.server_id, identity: credential ? "matched" : "explicit-open", observedAt: new Date().toISOString() };
  } catch (error) {
    failure = error instanceof CommandFailure ? error : new CommandFailure("failed", "OPERATION_FAILED", "the native stream or presence inventory did not finish; absence and impact were not inferred", { target });
  } finally {
    if (transferConnection) {
      try { await transferConnection.close(); transferClosed = transferConnection.isClosed(); } catch { transferClosed = false; }
    }
    try { await nc.close(); closed = nc.isClosed(); } catch { closed = false; }
  }
  if (failure) throw failure;
  if (!snapshot) throw new CommandFailure("failed", "OPERATION_FAILED", "the native deletion inventory produced no usable snapshot", { target });
  if (!closed || !transferClosed) throw new CommandFailure("failed", "OPERATION_FAILED", "an inspection connection did not confirm closure; no deletion was attempted", { target });
  const result = { kind: "live-space-delete-impact", dryRun: true, space: name, recordedBroker: brokerAddressForDisplay(entry.server) ?? null, recordedMode: entry.mode,
    recordedTlsRequired: entry.tlsRequired === true, ...snapshot, atomic: false, applyPermitted: false, effectAttempted: false, registrationRemoved: false, localFilesRemoved: false };
  return { result, entry, auth };
}

function previewView(data: Awaited<ReturnType<typeof readSpaceDeletion>>["result"]): Report {
  return { sections: [
    { title: "Live space impact", blocks: [{ kind: "fields", rows: [["Space", data.space], ["Recorded broker", data.recordedBroker ?? "not displayable"], ["Mode", data.recordedMode], ["TLS", data.recordedTlsRequired ? "required" : "not required"], ["Broker server ID", data.serverId], ["Identity", data.identity], ["Observed at", data.observedAt], ["Presence entries", String(data.presences.length)]] }, { kind: "lines", lines: ["Native reads were not atomic. Presence records are observations, not liveness or membership authority."] }] },
    { title: "First-party streams and buckets", blocks: [{ kind: "table", columns: [{ key: "name", label: "Name" }, { key: "kind", label: "Kind" }, { key: "state", label: "State" }, { key: "messages", label: "Messages" }], rows: data.streams.slice(0, 100).map((stream) => ({ name: stream.name, kind: stream.kind, state: stream.state, messages: stream.messages === null ? "-" : String(stream.messages) })) }, ...(data.streams.length > 100 ? [{ kind: "lines" as const, lines: [`Showing 100 of ${data.streams.length} targets; --json retains every row.`] }] : [])] },
    { title: "Presence entries", blocks: [{ kind: "table", columns: [{ key: "id", label: "Principal" }, { key: "name", label: "Name" }, { key: "status", label: "Reported status" }, { key: "ts", label: "Heartbeat (epoch ms)" }], rows: data.presences.slice(0, 100).map((peer) => ({ id: peer.id, name: peer.name ?? "-", status: peer.status ?? "-", ts: peer.lastHeartbeat === null ? "-" : String(peer.lastHeartbeat) })) }, ...(data.presences.length > 100 ? [{ kind: "lines" as const, lines: [`Showing 100 of ${data.presences.length} entries; --json retains every row.`] }] : []), { kind: "lines", lines: ["This preview deleted nothing. A separate apply rechecks the native target and requires confirmation."] }] },
  ] };
}

type DeletionObservation = Awaited<ReturnType<typeof readSpaceDeletion>>;

/** Every effect is on an exact stream name admitted by the fresh native observation. */
async function applySpaceDeletion(observed: DeletionObservation): Promise<{ acknowledged: string[]; alreadyAbsent: string[]; postReadRemaining: []; registrationRemoved: false; localFilesRemoved: false }> {
  const { entry, auth, result } = observed;
  const target = { space: result.space };
  let latest: ReturnType<typeof findMesh>;
  try { latest = findMesh(result.space); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the selected registration could not be reread before deletion; no request was submitted", { target }); }
  if (!latest || latest.ts !== entry.ts || latest.server !== entry.server || latest.root !== entry.root || latest.mode !== entry.mode || latest.tlsRequired !== entry.tlsRequired)
    throw new CommandFailure("refused", "CONFLICT", "the selected registration changed since the impact read; no delete request was submitted", { target });
  if (auth) {
    try {
      const current = validateSpaceAuth(await getSpaceAuth(workspaceSecretStore(entry.root), result.space), result.space);
      if (current.operator.jwt !== auth.operator.jwt || current.operator.seed !== auth.operator.seed || current.sys.pub !== auth.sys.pub || current.sys.jwt !== auth.sys.jwt || current.account.pub !== auth.account.pub || current.account.jwt !== auth.account.jwt || current.account.signingPub !== auth.account.signingPub || current.account.signingSeed !== auth.account.signingSeed) throw new Error("trust changed");
    } catch { throw new CommandFailure("refused", "CONFLICT", "the local static trust changed since the impact read; no delete request was submitted", { target }); }
  }
  const transfers = result.streams.filter((stream) => isTransferStream(result.space, stream.name)).map((stream) => stream.name);
  let credential: { creds: string; id: string; account: string } | undefined;
  if (auth) {
    try {
      const identity = newIdentity();
      credential = { creds: await mintCreds(auth, identity, "teardown", { lifecycleUid: mintLifecycleUid(), transferStreams: transfers }), id: identity.id, account: auth.account.pub };
    } catch { throw new CommandFailure("refused", "AUTH_REQUIRED", "the exact-scope teardown credential could not be minted; no delete request was submitted", { target }); }
  }
  let nc: NatsConnection;
  try {
    nc = await dialerFor(entry.server)({ servers: entry.server, ...standaloneConnectOpts({ ...(credential ? { creds: credential.creds } : {}), tls: entry.tlsRequired === true }), ...(credential ? { inboxPrefix: `_INBOX_${credential.id}` } : {}), timeout: 2_000, reconnect: false, maxReconnectAttempts: 0 });
  } catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the exact-scope deletion connection could not be established; no delete request was submitted", { target }); }
  const acknowledged: string[] = [], alreadyAbsent: string[] = [];
  let submitted: string | null = null;
  let postReadStarted = false;
  let closed = false;
  try {
    const info = nc.info;
    if (!info || info.server_id !== result.serverId || (info.auth_required === true) !== (entry.mode === "auth"))
      throw new CommandFailure("refused", "CONFLICT", "the deletion connection reached a different broker or access mode; no delete request was submitted", { target });
    if (credential) {
      const identity = await observeBrokerConnectionIdentity(nc, { user: credential.id, account: credential.account });
      if (identity.state !== "matched") throw new CommandFailure("refused", "CONFLICT", "the deletion connection's account or user was not confirmed; no delete request was submitted", { target });
    }
    const jsm = await jetstreamManager(nc);
    const nowTransfers: string[] = [];
    for await (const stream of jsm.streams.names()) if (isTransferStream(result.space, stream)) nowTransfers.push(stream);
    if (nowTransfers.length !== transfers.length || nowTransfers.some((stream) => !transfers.includes(stream)))
      throw new CommandFailure("refused", "CONFLICT", "the native transfer-stream target set changed; no delete request was submitted", { target });
    const names = spaceDeletionStreams(result.space, transfers);
    if (names.length !== result.streams.length || names.some((name, index) => name !== result.streams[index]?.name))
      throw new CommandFailure("refused", "CONFLICT", "the deletion credential and impact read name different resources; no delete request was submitted", { target });
    for (const stream of result.streams) {
      let state: "present" | "absent";
      try { await jsm.streams.info(stream.name); state = "present"; }
      catch (error) { if (!isJetStreamMissing(error, JetStreamApiCodes.StreamNotFound)) throw error; state = "absent"; }
      if (state !== stream.state) throw new CommandFailure("refused", "CONFLICT", "a stream changed since the fresh impact read; no delete request was submitted", { target });
    }
    alreadyAbsent.push(...result.streams.filter((stream) => stream.state === "absent").map((stream) => stream.name));
    for (const stream of result.streams) {
      if (stream.state === "absent") continue;
      submitted = stream.name;
      const reply = await jsm.streams.delete(stream.name);
      if (reply !== true) throw new Error("stream deletion was not acknowledged");
      acknowledged.push(stream.name);
      submitted = null;
    }
    postReadStarted = true;
    const remaining: string[] = [];
    for (const stream of result.streams) {
      try { await jsm.streams.info(stream.name); remaining.push(stream.name); }
      catch (error) { if (!isJetStreamMissing(error, JetStreamApiCodes.StreamNotFound)) throw error; }
    }
    for await (const stream of jsm.streams.names())
      if (isTransferStream(result.space, stream) && !remaining.includes(stream) && !transfers.includes(stream)) remaining.push(stream);
    if (remaining.length) throw new CommandFailure(acknowledged.length ? "partial" : "refused", acknowledged.length ? "OPERATION_PARTIAL" : "CONFLICT", "native post-delete inspection still sees space resources; no additional deletion was submitted", { target, changed: acknowledged, native: { outcome: "unknown", detail: { acknowledged, alreadyAbsent, remaining } }, remedy: "inspect these exact resources on the original broker before another deletion attempt" });
  } catch (error) {
    if (error instanceof CommandFailure && submitted === null && (!acknowledged.length || error.outcome === "partial")) throw error;
    const remaining = result.streams.map((stream) => stream.name).filter((name) => !acknowledged.includes(name) && !alreadyAbsent.includes(name));
    if (!submitted && !acknowledged.length)
      throw new CommandFailure("refused", "TARGET_UNAVAILABLE", postReadStarted ? "post-delete inspection did not finish, but no native delete was submitted" : "native deletion preflight did not finish; no delete request was submitted", { target, native: { outcome: "not-executed", detail: { remaining, postRead: postReadStarted ? "unconfirmed" : "not-started" } } });
    const api = error && typeof error === "object" && "api_error" in error ? (error as { api_error?: { code?: unknown } }).api_error : undefined;
    const denied = error instanceof PermissionViolationError || api?.code === 403;
    const absent = isJetStreamMissing(error, JetStreamApiCodes.StreamNotFound);
    const knownRefusal = submitted !== null && (denied || absent);
    if (knownRefusal && !acknowledged.length)
      throw new CommandFailure("refused", denied ? "PERMISSION_DENIED" : "TARGET_NOT_FOUND", "the broker refused the first exact stream delete; nothing was acknowledged or retried", { target, native: { outcome: "not-executed", detail: { acknowledged, alreadyAbsent, refused: submitted, remaining } } });
    throw new CommandFailure(knownRefusal ? "partial" : "unknown", knownRefusal ? "OPERATION_PARTIAL" : "OPERATION_UNKNOWN", "space deletion stopped after a native refusal or unconfirmed reply; no delete was retried", { target, changed: acknowledged, native: { outcome: knownRefusal ? "not-executed" : "unknown", detail: { acknowledged, alreadyAbsent, unconfirmed: knownRefusal ? null : submitted, refused: knownRefusal ? submitted : null, remaining, postRead: postReadStarted ? "unconfirmed" : "not-started" } }, remedy: "inspect the original broker and each remaining stream before deciding whether to retry" });
  } finally {
    try { await nc.close(); closed = nc.isClosed(); } catch { closed = false; }
  }
  if (!closed) throw new CommandFailure(acknowledged.length ? "partial" : "failed", acknowledged.length ? "OPERATION_PARTIAL" : "OPERATION_FAILED", acknowledged.length ? "native stream deletes were acknowledged, but the deletion connection did not confirm closure" : "the no-delete inspection connection did not confirm closure", { target, changed: acknowledged, native: { outcome: "unknown", detail: { acknowledged, alreadyAbsent } } });
  return { acknowledged, alreadyAbsent, postReadRemaining: [], registrationRemoved: false, localFilesRemoved: false };
}

export async function spaceDelete(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values);
  const [mode, name, ...extra] = args.positionals;
  if (mode !== "delete" || !name || token(name) !== name || extra.length)
    throw new CommandFailure("refused", "USAGE_INVALID", "use space delete <exact-space-name> [--dry-run] [-y|--yes]");
  if (args.values["dry-run"] === true && args.values.yes === true)
    throw new CommandFailure("refused", "USAGE_INVALID", "--yes belongs to a guarded live deletion, not to a dry-run");
  if (args.values["dry-run"] === true) {
    // The preview reads its whole scope, so it is complete; its limits are a note, not a partial read.
    const { result, entry } = await readSpaceDeletion(name);
    const blocked = liveStackRefusal(entry, name, true);
    writeResult(presentation, { command: "space delete", target: { space: name }, result: { ...result, applyBlockedBy: blocked?.detail() ?? null },
      ...(blocked ? { warnings: [{ code: blocked.code, target: blocked.target, message: `the apply would refuse: ${blocked.message}; ${blocked.remedy}` }] } : {}) },
      (data) => ({ sections: [...previewView(data).sections, { blocks: [{ kind: "lines", lines: ["This is a non-atomic native read of first-party stream targets and presence entries, not a guarded deletion plan. A fresh exact-scope check and confirmation are still required before any apply."] }] }] }));
    return;
  }
  const yes = args.values.yes === true;
  // A running local stack refuses before any broker connection or prompt.
  let registered: ReturnType<typeof findMesh>;
  try { registered = findMesh(name); } catch { registered = undefined; }
  const blocked = registered && liveStackRefusal(registered, name);
  if (blocked) throw blocked;
  if (!yes && (!canPrompt() || presentation === "json"))
    throw new CommandFailure("refused", "USAGE_INVALID", "live space deletion requires a terminal to type the exact space name, or --yes with an exact positional name in a script", { target: { space: name }, remedy: `inspect cotal space delete ${name} --dry-run first` });
  const initial = await readSpaceDeletion(name);
  if (!yes) {
    process.stderr.write(`${renderReport({ ...previewView(initial.result), space: name }, presentation === "plain" ? "plain" : "rich", terminalWidth(process.stderr))}\n`);
    const answer = await prompts.text({ message: `Permanently delete ${oneLine(name)} on ${oneLine(initial.result.recordedBroker ?? "the registered broker")}? Type the exact space name`, validate: (value) => value === name ? undefined : `Type ${oneLine(name)} to confirm, or cancel.` });
    if (prompts.isCancel(answer)) {
      writeResult(presentation, { command: "space delete", target: { space: name }, result: { kind: "live-space-delete", confirmed: false, deleted: false }, noOp: true }, () => ({ sections: [{ title: "Space kept", blocks: [{ kind: "lines", lines: ["No native delete was submitted. The registration and local files were kept."] }] }] }));
      return;
    }
  }
  const refreshed = await readSpaceDeletion(name);
  const fingerprint = (observation: DeletionObservation) => JSON.stringify({
    serverId: observation.result.serverId, broker: observation.entry.server, root: observation.entry.root,
    mode: observation.entry.mode, tlsRequired: observation.entry.tlsRequired, recordedAt: observation.entry.ts,
    operatorJwt: observation.auth?.operator.jwt, accountJwt: observation.auth?.account.jwt,
    account: observation.auth?.account.pub, signingKey: observation.auth?.account.signingPub,
    streams: observation.result.streams.map((stream) => `${stream.name}:${stream.state}`).sort(),
    presences: observation.result.presences.map((peer) => peer.id).sort(),
  });
  if (fingerprint(initial) !== fingerprint(refreshed))
    throw new CommandFailure("refused", "CONFLICT", "the native streams or presence identities changed since the reviewed impact; no delete request was submitted", { target: { space: name }, remedy: "inspect the new impact with space delete <name> --dry-run before confirming again" });
  // A stack started while the impact was reviewed refuses here too.
  const started = liveStackRefusal(refreshed.entry, name);
  if (started) throw started;
  const receipt = await applySpaceDeletion(refreshed);
  writeResult(presentation, { command: "space delete", target: { space: name, broker: refreshed.result.recordedBroker },
    result: { kind: "live-space-delete", space: name, brokerServerId: refreshed.result.serverId, open: refreshed.entry.mode === "open", ...receipt },
    ...(receipt.acknowledged.length === 0 ? { noOp: true } : {}) }, (data): Report => ({ sections: [{ title: data.acknowledged.length ? "Space streams deleted" : "Space streams already absent", blocks: [
      { kind: "fields", rows: [["Space", data.space], ["Broker server ID", data.brokerServerId], ["Mode", data.open ? "open: any broker client can delete" : "static auth"], ["Deletion acknowledgements", String(data.acknowledged.length)], ["Already absent", String(data.alreadyAbsent.length)], ["Post-read remaining", String(data.postReadRemaining.length)]] },
      ...(data.acknowledged.length ? [{ kind: "table" as const, columns: [{ key: "name", label: "Deleted stream or bucket" }], rows: data.acknowledged.slice(0, 100).map((name) => ({ name })) }] : []),
      ...(data.alreadyAbsent.length ? [{ kind: "table" as const, columns: [{ key: "name", label: "Already absent" }], rows: data.alreadyAbsent.slice(0, 100).map((name) => ({ name })) }] : []),
      { kind: "lines", lines: ["Native delete acknowledgements are not a guarantee that another writer has not recreated a stream. No registration, trust or local file was removed.", ...(data.acknowledged.length > 100 || data.alreadyAbsent.length > 100 ? ["Each table shows at most 100 rows; --json retains every row."] : [])] },
    ] }] }));
}
