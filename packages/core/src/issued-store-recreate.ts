import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { JetStreamApiCodes, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { nuid, type NatsConnection } from "@nats-io/transport-node";
import { downloadStreamSnapshot } from "./backup.js";
import { issuedStoreStreamNames } from "./issued-authority.js";
import { isJetStreamMissing } from "./jetstream-missing.js";

/** One issued-authority stream {@link removeIssuedStoresBeforeRetention} backed up and deleted. */
export interface RemovedIssuedStore {
  stream: string;
  messages: number;
  lastSeq: number;
  /** The stream's backup directory: `backup.json` and `stream.tar.s2`, as `nats stream backup` writes them. */
  backup: string;
}

/** A refusal of {@link removeIssuedStoresBeforeRetention} before it wrote or deleted anything:
 *  neither store predates bounded retention, or the backup directory cannot be created. */
export class IssuedStoreRecreateRefusal extends Error {
  constructor(readonly reason: "nothing-to-recreate" | "backup-directory", message: string) {
    super(message);
    this.name = "IssuedStoreRecreateRefusal";
  }
}

/** The issued-authority streams of `space` created before bounded retention: present, with a config
 *  that does not set `allow_msg_ttl`, and their message count and last sequence as read now. */
export async function issuedStoresBeforeRetention(jsm: JetStreamManager, space: string): Promise<Array<{ stream: string; messages: number; lastSeq: number }>> {
  const found = [];
  for (const stream of issuedStoreStreamNames(space)) {
    let info;
    try { info = await jsm.streams.info(stream); }
    catch (error) {
      if (isJetStreamMissing(error, JetStreamApiCodes.StreamNotFound)) continue;
      throw error;
    }
    if (info.config.allow_msg_ttl !== true) found.push({ stream, messages: info.state.messages, lastSeq: info.state.last_seq });
  }
  return found;
}

function writePrivate(path: string, write: (fd: number) => void): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    write(fd);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function fsyncDir(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeAll(fd: number, data: Uint8Array): void {
  for (let offset = 0; offset < data.length;) offset += writeSync(fd, data, offset);
}

/**
 * Back up, then delete, the issued-authority stores of one space that were created before bounded
 * retention (`KV_cotal_issued_<space>` and `KV_cotal_accepted_<space>` without `allow_msg_ttl`, SPEC
 * 13.15), so the next {@link ensureIssuedStores} creates them in the current shape. It touches no
 * other stream. Every issuer and resolver of the space must be stopped first.
 *
 * `nc` holds the `issued-store-recreate` credential of the space (or is a bare connection to an open
 * broker), and `inboxPrefix` is its private inbox prefix, `_INBOX_<nkey>`; each snapshot is delivered
 * there. `backupDir` must not exist and its parent must. It is created 0700 with one 0700 directory
 * per stream holding `backup.json` and `stream.tar.s2`, each 0600 and fsynced, which
 * `nats stream restore` reads. Every backup is checked against the stream's message count and last
 * sequence, as read before its snapshot and again just before the first delete, so a store a
 * writer changed while it was backed up is left in place.
 * Throws {@link IssuedStoreRecreateRefusal}, with nothing written or deleted, when neither store
 * predates bounded retention or the backup directory cannot be created.
 */
export async function removeIssuedStoresBeforeRetention(
  nc: NatsConnection,
  opts: { space: string; backupDir: string; inboxPrefix: string; timeoutMs?: number },
): Promise<RemovedIssuedStore[]> {
  const jsm = await jetstreamManager(nc);
  const selected = await issuedStoresBeforeRetention(jsm, opts.space);
  if (!selected.length)
    throw new IssuedStoreRecreateRefusal("nothing-to-recreate", `neither issued-authority store of space ${opts.space} predates bounded retention, so nothing was backed up or deleted`);
  const dir = resolve(opts.backupDir);
  try { mkdirSync(dir, { mode: 0o700 }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT")
      throw new IssuedStoreRecreateRefusal("backup-directory", `the backup directory ${dir} ${code === "EEXIST" ? "already exists" : "has no parent directory"}, so nothing was backed up or deleted`);
    throw error;
  }
  chmodSync(dir, 0o700);
  const backedUp: RemovedIssuedStore[] = [];
  for (const s of selected) {
    const backup = join(dir, s.stream);
    mkdirSync(backup, { mode: 0o700 });
    chmodSync(backup, 0o700);
    let bytes = 0;
    let metadata;
    const data = openSync(join(backup, "stream.tar.s2"), "wx", 0o600);
    try {
      metadata = await downloadStreamSnapshot(nc, s.stream, {
        deliverSubject: `${opts.inboxPrefix}.issued-store-backup.${nuid.next()}`,
        checkMessages: true,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        onChunk: (chunk) => { writeAll(data, chunk); bytes += chunk.length; },
      });
      fsyncSync(data);
    } finally { closeSync(data); }
    if (bytes === 0) throw new Error(`the backup of ${s.stream} received no data, so no stream was deleted; the backup directory is ${dir}`);
    if (metadata.state.messages !== s.messages || metadata.state.last_seq !== s.lastSeq)
      throw new Error(`the backup of ${s.stream} holds ${metadata.state.messages} messages to sequence ${metadata.state.last_seq}, but the stream held ${s.messages} to sequence ${s.lastSeq} when it was read; a writer is still active, so no stream was deleted - stop every issuer and resolver of space ${opts.space} and run this again with a new backup directory`);
    const json = new TextEncoder().encode(`${JSON.stringify({ config: metadata.config, state: metadata.state }, null, 2)}\n`);
    writePrivate(join(backup, "backup.json"), (fd) => writeAll(fd, json));
    fsyncDir(backup);
    backedUp.push({ ...s, backup });
  }
  fsyncDir(dir);
  fsyncDir(dirname(dir));
  for (const s of backedUp) {
    const now = (await jsm.streams.info(s.stream)).state;
    if (now.messages !== s.messages || now.last_seq !== s.lastSeq)
      throw new Error(`${s.stream} changed after its backup (${s.messages} messages to sequence ${s.lastSeq}, now ${now.messages} to sequence ${now.last_seq}); a writer is still active, so no stream was deleted - stop every issuer and resolver of space ${opts.space} and run this again with a new backup directory`);
  }
  const removed: string[] = [];
  for (const s of backedUp) {
    try {
      await jsm.streams.delete(s.stream);
      await jsm.streams.info(s.stream).then(
        () => { throw new Error("it still answers after its delete"); },
        (error: unknown) => { if (!isJetStreamMissing(error, JetStreamApiCodes.StreamNotFound)) throw error; },
      );
    } catch (error) {
      throw new Error(`${s.stream} was not deleted (${(error as Error).message}); ${removed.length ? `${removed.join(" and ")} was deleted` : "no stream was deleted"}, and every backup is in ${dir}`);
    }
    removed.push(s.stream);
  }
  return backedUp;
}
