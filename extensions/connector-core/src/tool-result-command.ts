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
  dialerFor,
  standaloneConnectOpts,
  toolResultConsentAnchorFileResolver,
  consentSignerStillCurrent,
  readToolResultServingFile,
  toolResultServingFileResolver,
} from "@cotal-ai/core";
import { credsAuthenticator } from "@nats-io/transport-node";
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
  // A holder's redeemed rows name the target's lifecycle UID as the serving instance (SPEC 13.6),
  // so serving under any other instance id would answer nobody, or the wrong incarnation's holders.
  if (grant.instanceId !== self.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", "tool-results must be served with instanceId equal to the target's lifecycleUid");
  return serveEndpoint(nc, space, grant, [
    toolResultCommandDef(journal, self),
    toolResultConsentCommandDef(journal, self, { space, resolveAnchor }),
    toolResultRevokeCommandDef(journal, self),
  ], { public: true });
}

/** How often a serving session rechecks the signer of every applied consent against the current
 *  anchors: the bound on how long a withdrawn, rotated-out or unreadable anchor keeps an already
 *  applied consent capturing. */
export const TOOL_RESULT_ANCHOR_RECHECK_MS = 60_000;

/** The resolver for a launch that registered no consent anchors: nothing resolves, so every
 *  presented consent is refused as an unknown signer and the journal never turns on. */
const NO_REGISTERED_CONSENT_ANCHORS: AnchorResolver = () => undefined;

/**
 * Serve this session's journal from the launcher's serving material (SPEC 13.6): the agent's own
 * `endpoint-serve` creds, read from its 0600 launch-material file, the serve grant they were
 * minted under, and the path of the operator's registered consent-anchor file. Opens ONE dedicated
 * connection with exactly those creds and serves the three handle-only commands on it. Without
 * material nothing is served. The grant must name this space, the `tool-results` endpoint and this
 * incarnation, or nothing is opened.
 *
 * Every presented consent is verified against the anchor file read FRESH at that moment; with no
 * anchor file every consent is refused. Serving a consent command never applies a consent by
 * itself. Every {@link TOOL_RESULT_ANCHOR_RECHECK_MS} the signer of each applied consent is
 * rechecked the same way, and a withdrawn or unreadable one is withdrawn here, discarding held
 * results when none is left. When the serve connection closes for good (its credential expired or
 * was evicted, or the session ended) the journal retires: capture stops and everything is
 * discarded. `stop()` does the same deliberately.
 */
export async function serveLaunchedToolResults(args: {
  /** Static launch: creds, grant and the operator's anchor-file path. User-mode launch: the
   *  launcher-maintained serving file, re-read for creds on every (re)connect and for the host's
   *  anchors on every verification. */
  material: { creds: string; grant: EpServeGrant; consentAnchors?: string } | { file: string };
  space: string;
  servers: string;
  tls: boolean;
  journal: ToolResultJournal;
  self: ToolResultTarget;
}): Promise<{ stop(): Promise<void> }> {
  const { material, space, journal, self } = args;
  const file = "file" in material ? material.file : undefined;
  const initial = file !== undefined ? readToolResultServingFile(file) : (material as { creds: string; grant: EpServeGrant });
  const g = initial.grant;
  if (g.space !== space || g.endpoint !== TOOL_RESULT_ENDPOINT || g.instanceId !== self.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", "the launch's tool-results grant does not name this space, endpoint and incarnation");
  const resolveAnchor = file !== undefined
    ? toolResultServingFileResolver(file)
    : "consentAnchors" in material && material.consentAnchors !== undefined ? toolResultConsentAnchorFileResolver(material.consentAnchors) : NO_REGISTERED_CONSENT_ANCHORS;
  const enc = new TextEncoder();
  const nc = await dialerFor(args.servers)({
    servers: args.servers,
    ...standaloneConnectOpts({ creds: initial.creds, tls: args.tls }),
    // A user-mode serving file is renewed in place: every (re)connect presents its current creds,
    // and a removed or unreadable file fails the connect instead of reusing the old credential.
    ...(file !== undefined ? { authenticator: credsAuthenticator(() => enc.encode(readToolResultServingFile(file).creds)) } : {}),
    name: `tool-results-${self.lifecycleUid}`,
  });
  let handle: EpServeHandle;
  try {
    handle = serveToolResults(nc, space, g, journal, self, resolveAnchor);
  } catch (e) {
    await nc.close().catch(() => {});
    throw e;
  }
  const stop = async (): Promise<void> => {
    clearInterval(recheck);
    try {
      await handle.stop();
    } finally {
      journal.retire();
      await nc.drain().catch(() => nc.close());
    }
  };
  // A user-mode serving file the launcher removed (a failed or unknown renewal) or let lapse ends
  // serving and capture at the next tick; the broker already ends the connection at the JWT's expiry.
  const servingFileCurrent = (): boolean => {
    try {
      return readToolResultServingFile(file!).notAfter > Date.now();
    } catch {
      return false;
    }
  };
  const recheck = setInterval(() => {
    if (file !== undefined && !servingFileCurrent()) return void stop().catch(() => {});
    void journal.recheckSigners((c) => consentSignerStillCurrent(resolveAnchor, c));
  }, TOOL_RESULT_ANCHOR_RECHECK_MS);
  recheck.unref?.();
  void nc.closed().then(() => {
    clearInterval(recheck);
    journal.retire();
  });
  return { stop };
}
