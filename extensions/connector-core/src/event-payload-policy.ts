import { cotalToolSpecs } from "./tool-specs.js";

// Enumerate the actual registered tools, including capability-gated ones. No payload text is scanned.
const ownTools = new Set(cotalToolSpecs({
  space: "catalog", name: "catalog", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
  subscribe: [], allowSubscribe: [], allowPublish: [], capabilities: ["spawn", "run"],
}).flatMap(spec => [spec.name, `mcp__cotal__${spec.name}`]));

/** Cotal tool payloads are excluded by registered identity, not by secret-shaped text. */
export function isCotalPayloadExcludedTool(name: string): boolean {
  return ownTools.has(name);
}
