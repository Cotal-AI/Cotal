import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ensureDirNoSymlink, realDirNoSymlink, writeSecretFileCreateOnly } from "@cotal-ai/core";
import { canonicalRoot, protectedLocalDirectory } from "@cotal-ai/workspace";
import { z } from "zod";

const ID = /^[a-f0-9]{16}$/;
const MAX_BYTES = 256 * 1024;
const Summary = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("fresh-team-summary"),
  deploymentId: z.string().regex(ID),
  space: z.string().min(1),
  root: z.string().refine(isAbsolute),
  server: z.string().min(1),
  /** Added after the first summaries; absence never proves which daemon policy was requested. */
  authMode: z.enum(["open", "auth", "user"]).optional(),
  /** Initial broker PID only. It is not a live process or incarnation proof. Older summaries lack it. */
  brokerPid: z.number().int().positive().optional(),
  manifestPath: z.string().refine(isAbsolute),
  requestedAgents: z.array(z.string().min(1)),
  declaredChannels: z.array(z.string().min(1)),
  recordedAt: z.iso.datetime(),
  managerRequested: z.boolean(),
  controlPlaneReturned: z.boolean(),
  authServiceReturned: z.boolean(),
  /** null means open mode needs no daemon; absent on summaries written before this observation. */
  deliveryResponderBound: z.boolean().nullable().optional(),
  agentReadiness: z.literal("not-checked"),
});

export type FreshTeamSummary = z.infer<typeof Summary>;

const BootAttempt = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("fresh-team-attempt"),
  deploymentId: z.string().regex(ID), space: z.string().min(1), root: z.string().refine(isAbsolute),
  server: z.string().min(1), authMode: z.enum(["open", "auth", "user"]).optional(), manifestPath: z.string().refine(isAbsolute), createdAt: z.iso.datetime(),
});
export type FreshTeamAttempt = z.infer<typeof BootAttempt>;

/** A returned summary settles only the same intent's target and completed startup commands;
 * an auth-mode responder that did not bind leaves it unsettled. A matched record never proves
 * current serving state or an agent join. */
export function freshTeamAttemptSettled(attempt: FreshTeamAttempt, summary: FreshTeamSummary | undefined): boolean {
  return Boolean(summary && summary.deploymentId === attempt.deploymentId && summary.space === attempt.space
    && summary.root === attempt.root && summary.server === attempt.server && summary.manifestPath === attempt.manifestPath
    && attempt.authMode !== undefined && summary.authMode === attempt.authMode
    && summary.controlPlaneReturned && summary.authServiceReturned
    && (attempt.authMode === "open" ? summary.deliveryResponderBound === null : summary.deliveryResponderBound === true));
}

const attemptFile = (dir: string, id: string) => join(dir, `team-boot-attempt-${id}.json`);

/** Publish one private intent before the launch spec or broker changes. A matching summary settles
 * the command's returned outcome; an intent without one remains a visible unknown, not authority
 * to retry or stop. The already prepared `.cotal` is fsynced before the first native effect. */
export function writeFreshTeamAttempt(root: string, attempt: FreshTeamAttempt): void {
  const valid = BootAttempt.parse(attempt);
  if (canonicalRoot(valid.root) !== canonicalRoot(root)) throw new Error("fresh boot attempt root changed before recording");
  const dir = realDirNoSymlink(root, ".cotal");
  if (!dir) throw new Error("fresh boot attempt requires a real prepared control directory");
  protectedLocalDirectory(dir);
  const body = JSON.stringify(valid, null, 2) + "\n";
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("fresh boot attempt exceeds its record limit");
  const path = attemptFile(dir, valid.deploymentId);
  writeSecretFileCreateOnly(path, body);
  const file = openSync(path, "r");
  try { fsyncSync(file); } finally { closeSync(file); }
  const directory = openSync(dir, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function readAttempt(path: string, id: string, root: string): FreshTeamAttempt {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new Error("not an owned private bounded regular attempt file");
  const bytes = readFileSync(path);
  if (bytes.length > MAX_BYTES) throw new Error("attempt file changed or exceeds its record limit");
  const parsed = BootAttempt.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (!parsed.success || parsed.data.deploymentId !== id || canonicalRoot(parsed.data.root) !== canonicalRoot(root)) throw new Error("attempt schema, root or full deployment ID differs from its file");
  return parsed.data;
}

/** All root-local boot attempts. Invalid records remain visible and block any new fresh boot. */
export function listFreshTeamAttempts(root: string): { valid: FreshTeamAttempt[]; refused: { path: string; why: string }[] } {
  const dir = realDirNoSymlink(root, ".cotal");
  if (!dir) return { valid: [], refused: [] };
  protectedLocalDirectory(dir);
  const valid: FreshTeamAttempt[] = [], refused: { path: string; why: string }[] = [];
  for (const name of readdirSync(dir).filter((file) => file.startsWith("team-boot-attempt-") && file.endsWith(".json")).sort()) {
    const path = join(dir, name), id = name.slice("team-boot-attempt-".length, -5);
    try {
      if (!ID.test(id)) throw new Error("not a full fresh deployment ID");
      valid.push(readAttempt(path, id, root));
    } catch { refused.push({ path, why: "the fresh boot attempt is unreadable or does not match this root" }); }
  }
  return { valid, refused };
}

export function findFreshTeamAttempt(root: string, id: string): FreshTeamAttempt | undefined {
  if (!ID.test(id)) throw new Error("a fresh boot attempt requires its complete recorded run ID");
  const dir = realDirNoSymlink(root, ".cotal");
  if (!dir) return undefined;
  protectedLocalDirectory(dir);
  try { return readAttempt(attemptFile(dir, id), id, root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** A creation-only report of the native fresh boot command, not an additive ownership ledger.
 *  No agent incarnation, grant, live process or current broker health is inferred from it. */
export function writeFreshTeamSummary(root: string, summary: FreshTeamSummary): void {
  const valid = Summary.parse(summary);
  if (canonicalRoot(valid.root) !== canonicalRoot(root)) throw new Error("fresh team summary root changed before recording");
  const dir = ensureDirNoSymlink(root, ".cotal", "team-summaries");
  const body = JSON.stringify(valid, null, 2) + "\n";
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("fresh team summary exceeds its record limit");
  protectedLocalDirectory(dir);
  const path = join(dir, `${valid.deploymentId}.json`);
  writeSecretFileCreateOnly(path, body);
  const file = openSync(path, "r");
  try { fsyncSync(file); } finally { closeSync(file); }
  const directory = openSync(dir, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function readSummary(path: string, name: string): FreshTeamSummary {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new Error("not an owned private bounded regular summary file");
  const bytes = readFileSync(path);
  if (bytes.length > MAX_BYTES) throw new Error("summary file changed or exceeds its record limit");
  const result = Summary.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (!result.success || result.data.deploymentId !== name) throw new Error("summary schema or full deployment ID does not match its file");
  return result.data;
}

export function findFreshTeamSummary(root: string, id: string): FreshTeamSummary | undefined {
  if (!ID.test(id)) throw new Error("a fresh deployment requires its complete recorded run ID");
  const dir = realDirNoSymlink(root, ".cotal", "team-summaries");
  if (!dir) return undefined;
  let record: FreshTeamSummary;
  try { record = readSummary(join(dir, `${id}.json`), id); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (canonicalRoot(record.root) !== canonicalRoot(root)) throw new Error("summary names a different root");
  return record;
}

/** Never read a source manifest or launch spec to infer what a fresh boot did. Invalid native
 *  summary files stay visible as refused, rather than disappearing from the inventory. A readable
 *  summary that names another root, as one does after its folder was moved or copied, is listed in
 *  `elsewhere`: it settles nothing here and reports only that root's earlier boot. */
export function listFreshTeamSummaries(root: string): { valid: FreshTeamSummary[]; refused: { path: string; why: string }[]; elsewhere: { path: string; deploymentId: string; root: string }[] } {
  const dir = realDirNoSymlink(root, ".cotal", "team-summaries");
  if (!dir) return { valid: [], refused: [], elsewhere: [] };
  const valid: FreshTeamSummary[] = [], refused: { path: string; why: string }[] = [], elsewhere: { path: string; deploymentId: string; root: string }[] = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json") && !file.startsWith(".")).sort()) {
    const path = join(dir, name), id = name.slice(0, -5);
    let record: FreshTeamSummary;
    try {
      if (!ID.test(id)) throw new Error("not a full fresh deployment ID");
      record = readSummary(path, id);
    } catch { refused.push({ path, why: "the fresh launch summary is unreadable" }); continue; }
    if (canonicalRoot(record.root) === canonicalRoot(root)) valid.push(record);
    else elsewhere.push({ path, deploymentId: id, root: record.root });
  }
  return { valid, refused, elsewhere };
}

/** The other root a readable summary for this ID names, so a refusal can say where it was recorded.
 *  Undefined when there is no such summary or the inventory cannot be read. */
export function freshTeamSummaryRecordedElsewhere(root: string, id: string): string | undefined {
  try { return listFreshTeamSummaries(root).elsewhere.find((row) => row.deploymentId === id)?.root; }
  catch { return undefined; }
}
