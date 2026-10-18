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

import type { NatsConnection } from "@nats-io/transport-node";
import {
  TOOL_RESULT_ENDPOINT,
  TOOL_RESULT_COMMAND,
  TOOL_RESULT_CONSENT_COMMAND,
  TOOL_RESULT_REVOKE_COMMAND,
  TOOL_RESULT_INPUT_SCHEMA,
  TOOL_RESULT_OUTPUT_SCHEMA,
  TOOL_RESULT_CONSENT_INPUT_SCHEMA,
  TOOL_RESULT_REVOKE_INPUT_SCHEMA,
  TOOL_RESULT_CONSENT_OUTPUT_SCHEMA,
  compileContract,
  EpEnvelopeError,
  serveEndpoint,
  verifyToolResultConsent,
  type AnchorResolver,
  type EpCommandDef,
  type EpServeContext,
  type EpServeGrant,
  type EpServeHandle,
} from "@cotal-ai/core";
import type { ToolResultJournal } from "./tool-result-journal.js";

export {
  TOOL_RESULT_ENDPOINT,
  TOOL_RESULT_COMMAND,
  TOOL_RESULT_CONSENT_COMMAND,
  TOOL_RESULT_REVOKE_COMMAND,
  TOOL_RESULT_INPUT_SCHEMA,
  TOOL_RESULT_OUTPUT_SCHEMA,
  TOOL_RESULT_CONSENT_INPUT_SCHEMA,
  TOOL_RESULT_REVOKE_INPUT_SCHEMA,
  TOOL_RESULT_CONSENT_OUTPUT_SCHEMA,
};

/** The agent this command answers for: the managed target's alias and the lifecycle whose journal
 *  it serves. A successor incarnation builds a new journal and a new def. */
export interface ToolResultTarget {
  owner: string;
  actor: string;
  lifecycleUid: string;
}

/** The handle-only gate every tool-result command shares; returns the caller's principal. */
function handleCaller({ subject }: EpServeContext, self: ToolResultTarget, journal: ToolResultJournal, command: string): string {
  const t = subject.target;
  if (t === null || t.mode !== "handle")
    throw new EpEnvelopeError("permission-denied", `${command} is served only to a redeemed capability handle on this agent`);
  if (t.tOwner !== self.owner || t.tActor !== self.actor)
    throw new EpEnvelopeError("target-mismatch", `${command} answers only for ${self.owner}.${self.actor}`);
  if (t.tUid !== self.lifecycleUid || journal.retired)
    throw new EpEnvelopeError("expired", `${command}: the handle names a lifecycle this journal does not serve`);
  return `${subject.caller.owner}.${subject.caller.actor}`;
}

export function toolResultCommandDef(journal: ToolResultJournal, self: ToolResultTarget): EpCommandDef {
  return {
    command: TOOL_RESULT_COMMAND,
    contract: {
      input: compileContract({ root: TOOL_RESULT_INPUT_SCHEMA }),
      output: compileContract({ root: TOOL_RESULT_OUTPUT_SCHEMA }),
    },
    handler: (ctx) => {
      const caller = handleCaller(ctx, self, journal, TOOL_RESULT_COMMAND);
      const args = ctx.request.args as { threadId: string; toolCallId: string };
      return journal.answer(args.threadId, args.toolCallId, caller);
    },
  };
}

/** Apply a consent. The artifact is verified FRESH against the anchor registry (`consents` role):
 *  only a host's human route can sign one, so an agent cannot consent for its owner. The caller
 *  must be the holder the consent names (presenter equality). */
export function toolResultConsentCommandDef(
  journal: ToolResultJournal,
  self: ToolResultTarget,
  verify: { space: string; resolveAnchor: AnchorResolver; now?: () => number },
): EpCommandDef {
  return {
    command: TOOL_RESULT_CONSENT_COMMAND,
    contract: {
      input: compileContract({ root: TOOL_RESULT_CONSENT_INPUT_SCHEMA }),
      output: compileContract({ root: TOOL_RESULT_CONSENT_OUTPUT_SCHEMA }),
    },
    handler: async (ctx) => {
      const caller = handleCaller(ctx, self, journal, TOOL_RESULT_CONSENT_COMMAND);
      const consent = await verifyToolResultConsent((ctx.request.args as { consent: unknown }).consent, {
        space: verify.space,
        expect: self,
        resolveAnchor: verify.resolveAnchor,
        ...(verify.now ? { now: verify.now() } : {}),
      });
      if (consent.holder.id !== caller)
        throw new EpEnvelopeError("permission-denied", `${TOOL_RESULT_CONSENT_COMMAND}: the consent names another holder; only its holder may present it`);
      journal.applyConsent(consent);
      return { state: "active", id: consent.id, exp: consent.exp };
    },
  };
}

export function toolResultRevokeCommandDef(journal: ToolResultJournal, self: ToolResultTarget): EpCommandDef {
  return {
    command: TOOL_RESULT_REVOKE_COMMAND,
    contract: {
      input: compileContract({ root: TOOL_RESULT_REVOKE_INPUT_SCHEMA }),
      output: compileContract({ root: TOOL_RESULT_CONSENT_OUTPUT_SCHEMA }),
    },
    handler: (ctx) => {
      const caller = handleCaller(ctx, self, journal, TOOL_RESULT_REVOKE_COMMAND);
      const { id } = ctx.request.args as { id: string };
      return journal.revokeConsent(id, caller) ? { state: "revoked", id } : { state: "unknown", id };
    },
  };
}

/** Serve the three tool-result commands on an AUTHORIZED serve grant (registry-verified, §13.9).
 *  Without a grant there is no serve exposure at all. */
export function serveToolResults(
  nc: NatsConnection,
  space: string,
  grant: EpServeGrant,
  journal: ToolResultJournal,
  self: ToolResultTarget,
  resolveAnchor: AnchorResolver,
): EpServeHandle {
  return serveEndpoint(nc, space, grant, [
    toolResultCommandDef(journal, self),
    toolResultConsentCommandDef(journal, self, { space, resolveAnchor }),
    toolResultRevokeCommandDef(journal, self),
  ], { public: true });
}
