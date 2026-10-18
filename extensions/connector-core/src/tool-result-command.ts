/**
 * The `tool-result` command: the one read path for a {@link ToolResultJournal}.
 *
 * AUTHORITY IS THE SURFACE'S, NOT THIS FILE'S. The command is served on the endpoint control
 * surface (SPEC §13) and admits only the `handle` authorization mode: the request subject carries
 * the full target triple `handle.<tOwner>.<tActor>.<tUid>`, pinned at redemption of an
 * issuer-signed, holder-bound capability handle (§13.6), so the broker confines the publish to the
 * one holder the grant names, and a principal without that grant cannot even send the request.
 * A space is a NATS account, so a neighbouring space has no subject here at all. The handler only
 * narrows: it refuses any other mode, a target that is not this agent, and a lifecycle that is not
 * the one the journal served. It never compares owners to decide who may read; that would be the
 * in-space owner filter the platform rules forbid.
 *
 * Serving needs the agent's own serve grant for this command (`serveEndpoint`, §13.9). Registering
 * the declaration and issuing that grant at spawn belong to the hosting authority and are not part
 * of this module.
 */

import { compileContract, EpEnvelopeError, type EpCommandDef } from "@cotal-ai/core";
import type { ToolResultJournal } from "./tool-result-journal.js";

export const TOOL_RESULT_COMMAND = "tool-result";

const id = { type: "string", minLength: 1, maxLength: 256 } as const;

/** Exact native ids only: the harness's session (the AG-UI thread) and its tool-call id. */
export const TOOL_RESULT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["threadId", "toolCallId"],
  properties: { threadId: id, toolCallId: id },
} as const;

/** {@link import("./tool-result-journal.js").ToolResultAnswer}, closed. `content` is inert text:
 *  a consumer renders it as text, never as HTML, markdown images or links it follows. */
export const TOOL_RESULT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["state"],
  properties: {
    state: { enum: ["available", "pending", "not-shared", "missing", "expired"] },
    threadId: id,
    toolCallId: id,
    content: { type: "string" },
    truncated: { type: "boolean" },
    bytes: { type: "integer", minimum: 0 },
    isError: { type: "boolean" },
    capturedAt: { type: "number" },
  },
} as const;

/** The agent this command answers for: the managed target's alias and the lifecycle whose journal
 *  it serves. A successor incarnation builds a new journal and a new def. */
export interface ToolResultTarget {
  owner: string;
  actor: string;
  lifecycleUid: string;
}

export function toolResultCommandDef(journal: ToolResultJournal, self: ToolResultTarget): EpCommandDef {
  return {
    command: TOOL_RESULT_COMMAND,
    contract: {
      input: compileContract({ root: TOOL_RESULT_INPUT_SCHEMA }),
      output: compileContract({ root: TOOL_RESULT_OUTPUT_SCHEMA }),
    },
    handler: ({ subject, request }) => {
      const t = subject.target;
      if (t === null || t.mode !== "handle")
        throw new EpEnvelopeError("permission-denied", `${TOOL_RESULT_COMMAND} is served only to a redeemed capability handle on this agent`);
      if (t.tOwner !== self.owner || t.tActor !== self.actor)
        throw new EpEnvelopeError("target-mismatch", `${TOOL_RESULT_COMMAND} answers only for ${self.owner}.${self.actor}`);
      if (t.tUid !== self.lifecycleUid || journal.retired)
        throw new EpEnvelopeError("expired", `${TOOL_RESULT_COMMAND}: the handle names a lifecycle this journal does not serve`);
      const args = request.args as { threadId: string; toolCallId: string };
      return journal.answer(args.threadId, args.toolCallId);
    },
  };
}
