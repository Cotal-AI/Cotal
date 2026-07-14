import "./connector.js"; // self-registers the "pi" connector
export { piConnector } from "./connector.js";
export { default as cotalMeshExtension } from "./extension.js";
export { InboxTurn, type InboxSource } from "./inbox-turn.js"; // for SDK embedders driving their own session
export type { InboxItem, InboxScope, ExactDrainResult } from "./inbox-types.js"; // pi-owned public shapes (no connector-core leak)
