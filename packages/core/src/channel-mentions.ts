import { PeerAddressError, parsePeerAddress, resolvePeerAddress, type PeerAddressAuthority } from "./peer-address.js";
import { AmbiguousPeerError, assertValidName, resolvePeer } from "./resolve.js";
import { mentionsIn, normalizeMentions, parsePrincipalKey } from "./subjects.js";
import type { CotalMessage, Presence } from "./types.js";

export interface ChannelPostOptions {
  channel?: string;
  replyTo?: string;
  contextId?: string;
  /** Declared mentions. When supplied, they must agree with the tokens in the body. */
  mentions?: readonly string[];
  /** In legacy spaces, check all names, or check only a supplied list and accept full IDs in it. */
  legacyValidation?: "names" | "declared-addresses";
}

export type ChannelMentionFields = { mentions?: string[]; mentionIds?: string[] };

function invalid(target: string, message: string): never {
  throw new PeerAddressError(target, "USAGE_INVALID", message);
}

function tokenFor(value: string, userMode: boolean): string {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value))
    return invalid(String(value), "Invalid mention: use an agent name or user/agent.");
  if (value.includes("/")) {
    parsePeerAddress(value);
    if (!userMode) return invalid(value, "A user/agent mention requires a signed-in space.");
  } else if (userMode && !/^[A-Za-z0-9_]+$/.test(value)) {
    return invalid(value, `Invalid mention ${JSON.stringify(value)}: use an agent name or user/agent.`);
  } else {
    try { assertValidName(value); }
    catch { return invalid(value, `Invalid mention ${JSON.stringify(value)}: use an agent name.`); }
  }
  return normalizeMentions([value], !userMode && !parsePrincipalKey(value))![0]!;
}

function declaredTokens(text: string, declared: readonly string[] | undefined, userMode: boolean): string[] {
  const tokens = [...new Set(mentionsIn(text).map((mention) => tokenFor(mention, userMode)))];
  if (declared === undefined) return tokens;
  if (!Array.isArray(declared)) return invalid("", "Invalid mentions: supply a list of agent addresses.");
  const list = Array.from(declared, (mention) => tokenFor(mention, userMode));
  if (new Set(list.map((name) => userMode ? name : name.toLowerCase())).size !== list.length)
    return invalid("", "Duplicate mentions are not allowed.");
  if (!userMode && tokens.length === 0) return list;
  const comparable = (name: string) => userMode ? name : name.toLowerCase();
  const stated = new Set(list.map(comparable));
  if (list.length !== tokens.length || tokens.some((token) => !stated.has(comparable(token))))
    return invalid("", "The declared mentions must match the @mentions in the message text.");
  return tokens;
}

interface ActingContext {
  authority: PeerAddressAuthority;
  space: string;
  selfId: string;
  readRoster: () => Promise<{ roster: Presence[]; failure?: unknown }>;
  requireDelivery: () => Promise<void>;
}

export async function prepareChannelMentions(text: string, options: ChannelPostOptions, acting: ActingContext): Promise<ChannelMentionFields> {
  const { authority, space, selfId } = acting;
  const userMode = authority.mode === "user";
  const mentions = declaredTokens(text, options.mentions, userMode);
  if (!mentions.length) return {};
  const explicitLegacy = options.legacyValidation === "declared-addresses" && options.mentions !== undefined;
  if (!userMode && options.legacyValidation !== "names" && !explicitLegacy) return { mentions: normalizeMentions(mentions, true) };
  const { roster, failure } = mentions.every((token) => token.includes("/")) ? { roster: [] } : await acting.readRoster();
  const missing = (name: string): never => {
    if (failure !== undefined) {
      const why = failure instanceof Error ? failure.message : String(failure);
      throw new PeerAddressError(name, "TARGET_UNAVAILABLE", `Cannot verify mention @${name} in space ${JSON.stringify(space)}: presence read failed (${why}). The send was not published.`);
    }
    throw new PeerAddressError(name, "TARGET_NOT_FOUND", `unknown mention @${name}: no ${userMode ? "own agent" : "such peer"} observed in space ${JSON.stringify(space)}.`);
  };
  if (authority.mode !== "user") {
    const names = new Set(roster.map((peer) => peer.card.name.toLowerCase()));
    const legacy = mentions.map((name) => {
      if (!explicitLegacy) return names.has(name.toLowerCase()) ? name : missing(name);
      const peer = resolvePeer(roster, name) ?? missing(name);
      const display = peer.card.name.toLowerCase();
      if (resolvePeer(roster, display)?.card.id !== peer.card.id)
        throw new AmbiguousPeerError(name, [{ ...peer.card, status: peer.status, ts: peer.ts }]);
      return display;
    });
    return { mentions: normalizeMentions(legacy, true) };
  }
  const own = roster.filter((peer) => parsePrincipalKey(peer.card.id)?.owner === authority.owner);
  const mentionIds: string[] = [];
  for (const name of mentions) {
    const parsed = parsePeerAddress(name);
    const peer = await resolvePeerAddress(parsed.kind === "qualified" ? [] : own, name, { authority, selfId });
    if (!peer) {
      if (failure === undefined) await resolvePeerAddress(roster, name, { authority, selfId });
      return missing(name);
    }
    mentionIds.push(peer.card.id);
  }
  if (new Set(mentionIds).size !== mentionIds.length) return invalid("", "Duplicate mention targets are not allowed.");
  await acting.requireDelivery();
  return { mentions, mentionIds };
}

/** Decode a sender's claimed priority targets. An invalid principal list cannot activate the
 *  legacy name path. Authorization and lifecycle selection are separate delivery checks. */
export function claimedMentionTargets(msg: CotalMessage, legacy: (name: string) => string | undefined): Array<{ name: string; principal: string }> {
  if (msg.mentionIds !== undefined) {
    const ids = msg.mentionIds;
    if (!Array.isArray(ids) || !ids.every((id) => parsePrincipalKey(id)) || new Set(ids).size !== ids.length) return [];
    const names = Array.isArray(msg.mentions) ? msg.mentions : [];
    return ids.map((principal, i) => ({ name: typeof names[i] === "string" ? names[i]! : principal, principal }));
  }
  if (!Array.isArray(msg.mentions) || !msg.mentions.every((name) => typeof name === "string")) return [];
  return msg.mentions.flatMap((name) => {
    const principal = legacy(name);
    return principal === undefined ? [] : [{ name, principal }];
  });
}
