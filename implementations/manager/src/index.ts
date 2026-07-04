import "./commands.js"; // self-registers the control-plane commands on import

export { Manager, READINESS_TIMEOUT_MS, type ManagerOptions } from "./manager.js";
export { createRuntime } from "./runtime/index.js";
export type { Runtime, AgentHandle, AttachSession, RuntimeKind, RuntimeMode } from "./runtime/index.js";
