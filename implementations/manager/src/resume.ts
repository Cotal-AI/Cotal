import { z } from "zod";
import type { ManagerResumeInventory } from "./manager.js";

export const MAX_RESUME_CONTROL_BYTES = 512 * 1024;
export const MAX_RESUME_COMMIT_BYTES = 1024;
const MAX_AGENTS = 50;
const TOKEN = /^[A-Za-z0-9_]+$/;
const SHA256 = /^[a-f0-9]{64}$/;

const token = z.string().min(1).max(128).regex(TOKEN, "must be a safe identity token");
const label = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "must be a safe token");
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
  z.strictObject({ mode: z.literal("static"), id: token, lifecycleUid, credential: fileRef }),
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
    transcript: z.boolean(),
    shareTools: z.string().max(4096).optional(),
    forkSource: z.string().min(1).max(4096).optional(),
    unresolvedLaunchOptionKeys: z.array(label).max(64).optional(),
  }),
  dependencies: z.array(path).max(16),
  spawner: z.string().min(1).max(256),
  authorityParent: z.string().min(1).max(256).optional(),
  startedAt: z.string().min(1).max(64),
});

const inventory = z.strictObject({
  version: z.literal("cotal-manager-resume/v1"),
  space: label,
  createdAt: z.string().min(1).max(64),
  agents: z.array(agent).max(MAX_AGENTS),
});

const argsSchema = z.strictObject({
  attemptId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "must be a safe attempt token"),
  inventory,
});
const commitArgsSchema = z.strictObject({
  attemptId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "must be a safe attempt token"),
});
const finalizeArgsSchema = z.strictObject({
  attemptId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "must be a safe attempt token"),
  durableCommitToken: z.string().regex(SHA256, "must be a lowercase 32-byte token"),
});

export interface ResumeControlArgs {
  attemptId: string;
  inventory: ManagerResumeInventory;
}

/** Strict, bounded wire parser. Unknown fields are rejected so secrets cannot hitchhike in inventory. */
export function parseResumeControlArgs(value: unknown): ResumeControlArgs {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("resumePreserved args must be JSON-serializable");
  }
  if (encoded === undefined) throw new Error("resumePreserved args must be a JSON object");
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESUME_CONTROL_BYTES)
    throw new Error(`resumePreserved args exceed ${MAX_RESUME_CONTROL_BYTES} bytes`);
  const parsed = argsSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`resumePreserved: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`);
  return parsed.data as ResumeControlArgs;
}

export function parseResumeCommitArgs(value: unknown): { attemptId: string } {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("commitResume args must be JSON-serializable");
  }
  if (encoded === undefined) throw new Error("commitResume args must be a JSON object");
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESUME_COMMIT_BYTES)
    throw new Error(`commitResume args exceed ${MAX_RESUME_COMMIT_BYTES} bytes`);
  const parsed = commitArgsSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`commitResume: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}

export function parseResumeFinalizeArgs(value: unknown): { attemptId: string; durableCommitToken: string } {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("finalizeResume args must be JSON-serializable");
  }
  if (encoded === undefined) throw new Error("finalizeResume args must be a JSON object");
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESUME_COMMIT_BYTES)
    throw new Error(`finalizeResume args exceed ${MAX_RESUME_COMMIT_BYTES} bytes`);
  const parsed = finalizeArgsSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`finalizeResume: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`);
  return parsed.data;
}
