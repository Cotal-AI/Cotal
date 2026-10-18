/**
 * Keep a hosted Cotal connection with the Claude Code session that opened it.
 *
 * A hosted conversation names its connection with the `connection_id` that `cotal_connect`
 * returned. A forked or copied Claude Code session inherits that id in its transcript and would act
 * under the first session's name. The hook records which session opened each connection, in the
 * plugin's own data directory, and refuses the id in any other session. A resumed session keeps its
 * session id and its connections, and a subagent shares its session's. An id the hook never saw
 * opened is left to the hosted connector, which checks that the account owns it.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LocalHookAnswer } from "@cotal-ai/connector-core/relay";
import { hostedCotalTool } from "./one-path.js";

/** The line `cotal_connect` answers with (`registerCotalGatewayTools` in connector-core). */
const CONNECTED = /^connection_id: (\S+)$/m;
/** An id this hook will use as a file name. Anything else is never recorded or checked. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const FORKED_REASON =
  "This connection_id was opened by another Claude Code session. This session is a fork or a copy " +
  "of that one, so it needs its own connection: call cotal_connect, then use the connection_id it " +
  "returns.";

interface ToolEvent {
  hook_event_name?: unknown;
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: { connection_id?: unknown } | null;
  tool_response?: unknown;
}

/** The connection id `cotal_connect` returned, from its MCP content blocks. */
function connectedId(response: unknown): string | undefined {
  const blocks = Array.isArray(response) ? response : [];
  for (const b of blocks) {
    const text = (b as { text?: unknown } | null)?.text;
    const id = typeof text === "string" ? CONNECTED.exec(text)?.[1] : undefined;
    if (id !== undefined) return SAFE_ID.test(id) ? id : undefined;
  }
  return undefined;
}

/** The hook answer over `dataDir`, the plugin's data directory. Without one it records nothing. */
export function connectionOwner(dataDir: string | undefined): LocalHookAnswer {
  const dir = dataDir ? join(dataDir, "hosted-connections") : undefined;
  return (event, session) => {
    if (session.managed || !dir) return undefined;
    const ev = event as ToolEvent | null;
    const tool = hostedCotalTool(ev?.tool_name);
    const sessionId = ev?.session_id;
    if (tool === undefined || typeof sessionId !== "string" || !sessionId) return undefined;
    const given = ev?.tool_input?.connection_id;
    const id = typeof given === "string" && SAFE_ID.test(given) ? given : undefined;
    const owner = (): string | undefined => {
      try {
        return readFileSync(join(dir, id!), "utf8");
      } catch {
        return undefined;
      }
    };
    if (ev?.hook_event_name === "PostToolUse" && tool === "cotal_connect") {
      const opened = connectedId(ev.tool_response);
      if (opened === undefined) return undefined;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, opened), sessionId, { mode: 0o600 });
      return undefined;
    }
    if (id === undefined) return undefined;
    if (ev?.hook_event_name === "PostToolUse" && tool === "cotal_disconnect") {
      if (owner() === sessionId) rmSync(join(dir, id), { force: true });
      return undefined;
    }
    if (ev?.hook_event_name !== "PreToolUse") return undefined;
    const recorded = owner();
    if (recorded === undefined || recorded === sessionId) return undefined;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: FORKED_REASON,
      },
    };
  };
}
