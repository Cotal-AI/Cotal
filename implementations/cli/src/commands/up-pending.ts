import { type JsonValue, type ManagerCommitEvidence, type ListenerProof } from "@cotal-ai/workspace";
import { type PreparedRestore } from "../lib/restore.js";

export const pendingRestores = new Map<string, PreparedRestore>();

export interface PendingOrdinaryResume {
  root: string;
  attemptId: string;
  space: string;
  mode: "open" | "auth" | "user";
  server: string;
  storeDir: string;
  /** The JetStream file storage cap the preserved launch recorded, re-rendered on resume. */
  maxFileStore?: number;
  runtime?: string;
  detached: boolean;
  inventory: JsonValue;
  journalState: "resume-intent" | "resume-active" | "resume-committed" | "resume-degraded";
  managerCommit?: ManagerCommitEvidence;
  serverName: string;
  serverNonce: string;
  /** Present when a live bound listener from a prior coordinator should be adopted, not respawned. */
  adoptProof?: ListenerProof;
}
export const pendingOrdinaryResumes = new Map<string, PendingOrdinaryResume>();
