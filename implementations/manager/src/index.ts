import "./commands.js"; // self-registers the control-plane commands on import

export {
  Manager,
  READINESS_TIMEOUT_MS,
  type ManagerOptions,
  type ManagerMaintenanceState,
  type ManagerResumeIdentity,
  type ManagerResumeAgent,
  type ManagerResumeInventory,
  type ManagerResumeResult,
  type ManagerPreserveFailure,
  type ManagerPreservationPlan,
  type ManagerPreserveOptions,
  type ManagerPreserveResult,
} from "./manager.js";
export {
  parseResumeControlArgs,
  parseResumeCommitArgs,
  parseResumeFinalizeArgs,
  MAX_RESUME_CONTROL_BYTES,
  MAX_RESUME_COMMIT_BYTES,
  type ResumeControlArgs,
} from "./resume.js";
export { createRuntime } from "./runtime/index.js";
export type { Runtime, AgentHandle, AttachSession, RuntimeKind, RuntimeMode } from "./runtime/index.js";
