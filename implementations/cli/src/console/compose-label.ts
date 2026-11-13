import { peerLabel } from "@cotal-ai/core/peer-label";

/** A name the compose line can print. A blank name is not one, so the line uses the id. */
export function composeName(name: string, id: string): string {
  return peerLabel({ name: name.trim() ? name : id });
}

/** The prompt under the compose box. A channel reply names its channel; a direct message does not. */
export function composePrompt(target:
  | { kind: "channel"; channel: string }
  | { kind: "dm"; toId: string; toName: string }
  | { kind: "reply"; fromName: string; fromId: string; delivery?: string; channel?: string },
): string {
  if (target.kind === "channel") return "→ #" + target.channel;
  if (target.kind === "dm") return "→ @" + composeName(target.toName, target.toId);
  return "↩ " + composeName(target.fromName, target.fromId) + (target.delivery === "multicast" && target.channel ? " #" + target.channel : "");
}
