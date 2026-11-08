import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseShareSelection, writeSecretFileAtomic } from "@cotal-ai/core";
import { z } from "zod";
import type { ManagerResumeInventory } from "./manager.js";

export const MAX_RESUME_CONTROL_BYTES = 512 * 1024;
export const MAX_RESUME_COMMIT_BYTES = 1024;
/** Concurrency ceiling — the manager refuses to hold more than this many live + in-flight +
 *  cooling slots at once (P4a). Bounds a fork-bomb: spawn is a full agent process per call.
 *  Declared here (not in manager.ts) so the resume inventory schema and the spawn/resume
 *  capacity checks share one value; manager.ts imports it. */
export const MAX_AGENTS = 50;
const TOKEN = /^[A-Za-z0-9_]+$/;
const SHA256 = /^[a-f0-9]{64}$/;

const token = z.string().min(1).max(128).regex(TOKEN, "must be a safe identity token");
const label = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "must be a safe token");
const attemptId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "must be a safe attempt token");
const short = z.string().max(512);
const path = z.string().min(1).max(4096);
const digest = z.string().regex(SHA256, "must be a lowercase SHA-256 digest");
const stringList = z.array(z.string().min(1).max(512)).max(256);
const fileRef = z.strictObject({ kind: z.literal("file"), path, sha256: digest });

// The original incarnation UID (`[a-z0-9]{26,32}`, mirrors core assertLifecycleToken). A resumed
// agent MUST recover it: its dm/dlv durables are keyed by it, so a fresh mint would orphan them.
const lifecycleUid = z.string().regex(/^[a-z0-9]{26,32}$/, "must be a lifecycle uid token");
const identity = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("open"), id: token, lifecycleUid }),
  z.strictObject({
    mode: z.literal("static"),
    id: token,
    lifecycleUid,
    credential: fileRef,
    // The SPEC 13.15 issuance the credential was minted under; a resumed static agent renews
    // under this generation, and a pre-issuance inventory carries none (its renewal refuses).
    // `listing` records that the ceiling carries the registry's endpoints row, so the renewal
    // mints that same ceiling; an incarnation spawned before the registry has none.
    issued: z.strictObject({ generation: z.string().regex(/^[a-f0-9]{32}$/), acceptedToken: z.string().regex(/^[a-f0-9]{32}$/), listing: z.literal(true).optional() }).optional(),
  }),
  z.strictObject({
    mode: z.literal("user"),
    owner: token,
    actor: token,
    lifecycleUid,
    actorToken: fileRef,
    sentinelCredential: fileRef,
    health: z.strictObject({ kind: z.literal("file"), path }),
  }),
]);

const source = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("persona"),
    ref: label,
    configPath: path,
    configSha256: digest,
  }),
  // An inline persona's seat, launched from its lifecycle's snapshot.
  z.strictObject({
    kind: z.literal("inline"),
    ref: label,
    configPath: path,
    configSha256: digest,
  }),
  z.strictObject({
    kind: z.literal("manifest"),
    runId: label,
    requested: label,
    hash: z.string().min(1).max(256).regex(/^[A-Za-z0-9]+$/),
    configPath: path,
    configSha256: digest,
    manifestSha256: digest,
  }),
]);

const agent = z.strictObject({
  space: label,
  name: label,
  role: label.optional(),
  identity,
  launch: z.strictObject({
    connector: label,
    runtime: label,
    cwd: path,
    source,
    model: short.optional(),
    variant: short.min(1).optional(),
    subscribe: stringList.optional(),
    allowSubscribe: stringList,
    allowPublish: stringList.optional(),
    capabilities: z.array(z.string().min(1).max(256)).max(64).optional(),
    // Absent means OFF, and that is the field's meaning rather than a fallback: an inventory
    // written before the event plane existed describes a session that was not publishing one. A
    // required field here would refuse every inventory the previous version wrote, so an upgrade
    // that restarts the manager would lose the agents it was supposed to preserve.
    events: z.boolean().default(false),
    // Start takes any declared server key as written, empty or long, so a bound per name here would
    // refuse to preserve an agent that launched. The args byte cap bounds the list.
    shareTools: z.array(z.string()).optional(),
    forkSource: z.string().min(1).max(4096).optional(),
    // Optional: a seat that was not resumed, or has not recorded its fork yet, has none, and an
    // inventory written before this field existed must still resume.
    resumed: z.strictObject({ source: z.string().min(1).max(4096), title: z.string().min(1).max(1024).optional(), transcriptSha256: digest }).optional(),
    sessionId: z.string().min(1).max(4096).optional(),
    // The connector's session pointer file. Optional because a seat whose connector declares no
    // continuation has none, and because an inventory written before this field existed must still
    // resume rather than be refused by a stricter reader.
    sessionStatePath: path.optional(),
    unresolvedLaunchOptionKeys: z.array(label).max(64).optional(),
  }),
  dependencies: z.array(path).max(16),
  spawner: z.string().min(1).max(256),
  authorityParent: z.string().min(1).max(256).optional(),
  startedAt: z.string().min(1).max(64),
  // The CHAT stream frontier at the preservation cut (issue #545). Optional because an inventory
  // written before this field existed must still resume rather than be refused, exactly as
  // sessionStatePath's absence means no pointer rather than a stricter refusal.
  backfillFloor: z.number().int().nonnegative().optional(),
});

const inventory = z.discriminatedUnion("version", [
  z.strictObject({
    version: z.literal("cotal-manager-resume/v2"),
    space: label,
    createdAt: z.string().min(1).max(64),
    agents: z.array(agent).max(MAX_AGENTS),
  }),
  // v1 stored shareTools as the `--share-tools` flag string. A cut taken before the upgrade still
  // resumes: its selection is parsed here, once, into the list v2 carries.
  z.strictObject({
    version: z.literal("cotal-manager-resume/v1"),
    space: label,
    createdAt: z.string().min(1).max(64),
    agents: z.array(agent.extend({ launch: agent.shape.launch.extend({ shareTools: z.string().max(4096).optional() }) })).max(MAX_AGENTS),
  }).transform(({ agents, ...rest }) => ({
    ...rest,
    version: "cotal-manager-resume/v2" as const,
    agents: agents.map((a) => ({ ...a, launch: { ...a.launch, shareTools: parseShareSelection(a.launch.shareTools) } })),
  })),
]);

const argsSchema = z.strictObject({
  attemptId,
  inventory,
});
const commitArgsSchema = z.strictObject({
  attemptId,
});
const finalizeArgsSchema = z.strictObject({
  attemptId,
  durableCommitToken: z.string().regex(SHA256, "must be a lowercase 32-byte token"),
});

export interface ResumeControlArgs {
  attemptId: string;
  inventory: ManagerResumeInventory;
}

function parseBounded<T>(op: string, capBytes: number, schema: z.ZodType<T>, value: unknown): T {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${op} args must be JSON-serializable`);
  }
  if (encoded === undefined) throw new Error(`${op} args must be a JSON object`);
  if (Buffer.byteLength(encoded, "utf8") > capBytes) throw new Error(`${op} args exceed ${capBytes} bytes`);
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error(`${op}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}

/** Strict, bounded wire parser. Unknown fields are rejected so secrets cannot hitchhike in inventory. */
export function parseResumeControlArgs(value: unknown): ResumeControlArgs {
  return parseBounded("resumePreserved", MAX_RESUME_CONTROL_BYTES, argsSchema, value) as ResumeControlArgs;
}

export function parseResumeCommitArgs(value: unknown): { attemptId: string } {
  return parseBounded("commitResume", MAX_RESUME_COMMIT_BYTES, commitArgsSchema, value);
}

export function parseResumeFinalizeArgs(value: unknown): { attemptId: string; durableCommitToken: string } {
  return parseBounded("finalizeResume", MAX_RESUME_COMMIT_BYTES, finalizeArgsSchema, value);
}

/** A spawn's `supervise` restart budget. Admission and the seat record read this one rule, so a
 *  policy the record would refuse is never admitted and launched first. */
export const supervisePolicy = z.strictObject({ restarts: z.number().int().min(1), windowMs: z.number().int().min(1) });

/** What a successor manager needs to take back one seat this manager runs, should this manager's
 *  process end without stopping it: the seat's resume entry, and for a supervised seat the restart
 *  policy its spawn carried and the deaths already counted against it (#4094). One file per seat,
 *  written by the manager that runs it. The entry carries file references and digests only, never a
 *  secret value. */
const seatRecord = z.strictObject({
  version: z.literal("cotal-seat-record/v1"),
  instanceId: z.string().min(1).max(256),
  supervise: supervisePolicy.optional(),
  crashes: z.array(z.number().int().nonnegative()).max(1024),
  agent,
});

export type SeatRecord = Omit<z.infer<typeof seatRecord>, "agent"> & { agent: ManagerResumeInventory["agents"][number] };

export function seatRecordPath(root: string, space: string, name: string): string {
  return join(root, ".cotal", "seat-records", space, `${name}.json`);
}

/** Replace the record atomically, so a crash mid-write leaves the previous one. */
export function writeSeatRecord(root: string, record: SeatRecord): void {
  const path = seatRecordPath(root, record.agent.space, record.agent.name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeSecretFileAtomic(path, `${JSON.stringify(seatRecord.parse(record))}\n`);
}

/** Undefined when no record exists. A record that does not parse throws: it was written by this
 *  code, so a malformed one is damage to report, never a seat to skip silently. */
export function readSeatRecord(root: string, space: string, name: string): SeatRecord | undefined {
  const path = seatRecordPath(root, space, name);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const parsed = seatRecord.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new Error(`seat record ${path}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`);
  return parsed.data as SeatRecord;
}

/** Remove the record of one incarnation. A record of another incarnation under the same name is left. */
export function removeSeatRecord(root: string, space: string, name: string, lifecycleUid: string): void {
  const path = seatRecordPath(root, space, name);
  let current: SeatRecord | undefined;
  try {
    current = readSeatRecord(root, space, name);
  } catch {
    // An unreadable record names no incarnation, so it cannot be another one's: remove it.
    rmSync(path, { force: true });
    return;
  }
  if (current?.agent.identity.lifecycleUid === lifecycleUid) rmSync(path, { force: true });
}

/** One user-mode lifecycle this manager provisioned. A static seat is found again through its slot
 *  row. A user-mode seat has no such row, so this file is what a later start of the same instance
 *  reads to retire a lifecycle it neither resumed nor still holds (#4005). It names the lifecycle
 *  and its secret paths, never a secret value. */
const userCustodyRecord = z.strictObject({
  version: z.literal("cotal-user-custody/v1"),
  space: z.string().min(1).max(128),
  instanceId: z.string().min(1).max(256),
  name: token,
  id: z.string().min(1).max(256),
  lifecycleUid,
  userOwner: z.string().min(1).max(128),
  delegated: z.boolean(),
  /** Set when a preservation cut stopped the seat and kept its inventory. A later start leaves it
   *  until a resume adopts it or an ordinary stop retires it. */
  preserved: z.boolean().optional(),
  secretPaths: z.strictObject({
    creds: path.optional(),
    actorToken: path.optional(),
    sentinelCreds: path.optional(),
    health: path.optional(),
  }).optional(),
  allowSubscribe: z.array(z.string().min(1).max(512)).max(256).optional(),
  runtime: z.strictObject({ kind: z.string().min(1).max(64), id: z.string().min(1).max(256) }).optional(),
});

export type UserCustodyRecord = z.infer<typeof userCustodyRecord>;

function userCustodyDir(root: string, space: string, instanceId: string): string {
  return join(root, ".cotal", "user-custody", space, instanceId);
}

function userCustodyPath(root: string, space: string, instanceId: string, lifecycleUid: string): string {
  return join(userCustodyDir(root, space, instanceId), `${lifecycleUid}.json`);
}

/** Replace one lifecycle's record atomically. A crash mid-write leaves the previous record. */
export function writeUserCustody(root: string, record: UserCustodyRecord): void {
  const path = userCustodyPath(root, record.space, record.instanceId, record.lifecycleUid);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeSecretFileAtomic(path, `${JSON.stringify(userCustodyRecord.parse(record))}\n`);
}

/** Every record this instance wrote. A record that does not parse throws: this code wrote it, so a
 *  malformed one is damage to report, never a lifecycle to skip. An absent directory is none. */
export function readUserCustody(root: string, space: string, instanceId: string): UserCustodyRecord[] {
  const dir = userCustodyDir(root, space, instanceId);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: UserCustodyRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    const parsed = userCustodyRecord.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success)
      throw new Error(`user custody ${path}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`);
    if (parsed.data.space !== space || parsed.data.instanceId !== instanceId)
      throw new Error(`user custody ${path} names space ${parsed.data.space} instance ${parsed.data.instanceId}, not ${space} ${instanceId}`);
    out.push(parsed.data);
  }
  return out;
}

/** Remove one lifecycle's record. A record of another lifecycle under the same name is left. */
export function removeUserCustody(root: string, space: string, instanceId: string, lifecycleUid: string): void {
  const path = userCustodyPath(root, space, instanceId, lifecycleUid);
  rmSync(path, { force: true });
}
