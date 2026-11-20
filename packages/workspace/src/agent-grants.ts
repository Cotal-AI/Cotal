import { spacePrefix, taskStream } from "@cotal-ai/core";
import { shellPath } from "./protected-records.js";

/** The channel ACLs and role an agent credential carries. `excludeRead` and `excludePost` are the
 *  channels or patterns each list removes (SPEC §9), empty when it removes none. */
export interface AgentGrants { read: string[]; post: string[]; excludeRead: string[]; excludePost: string[]; role: string | null }

/** An agent credential's grants, read back from the rows the agent profile mints: the
 *  `chat.*.*.<channel>` subscribe rows are its read ACL, its own `chat.<owner>.<actor>.<channel>`
 *  publish rows its post ACL, the same rows on the deny side its read and post exclusions, and the
 *  `svc_<role>` TASK bind row its role. */
export function agentGrants(nats: { pub?: { allow?: string[]; deny?: string[] }; sub?: { allow?: string[]; deny?: string[] } }, space: string): AgentGrants {
  const chat = `${spacePrefix(space)}.chat.`;
  const rowsOf = (rows: unknown): string[] => Array.isArray(rows) ? rows.filter((row): row is string => typeof row === "string") : [];
  const channels = (rows: readonly string[], own: boolean) => [...new Set(rows.filter((row) => row.startsWith(chat))
    .map((row) => row.slice(chat.length).split("."))
    .filter(([owner, actor]) => own ? owner !== "*" && actor !== "*" : owner === "*" && actor === "*")
    .map((parts) => parts.slice(2).join(".")).filter(Boolean))];
  const task = `$JS.API.CONSUMER.INFO.${taskStream(space)}.svc_`;
  const post = rowsOf(nats.pub?.allow);
  const role = post.find((row) => row.startsWith(task))?.slice(task.length);
  return {
    read: channels(rowsOf(nats.sub?.allow), false),
    post: channels(post, true),
    excludeRead: channels(rowsOf(nats.sub?.deny), false),
    excludePost: channels(rowsOf(nats.pub?.deny), true),
    role: role && /^[A-Za-z0-9_-]+$/.test(role) ? role : null,
  };
}

/** The `auth mint` flags that give a new key these grants, each led by a space. A new key holds only
 *  the grants its mint names, so both ACL flags are named even when empty and persona defaults
 *  are disabled, including a role the original credential did not hold. An exclusion flag is named
 *  only when its list removes something. */
export function grantMintFlags(grants: AgentGrants): string {
  const exclude = (flag: string, list: readonly string[]) => list.length ? ` --${flag} ${shellPath(list.join(","))}` : "";
  return ` --allow-subscribe ${shellPath(grants.read.join(","))}${exclude("exclude-subscribe", grants.excludeRead)} --allow-publish ${shellPath(grants.post.join(","))}${exclude("exclude-publish", grants.excludePost)}${grants.role ? ` --role ${grants.role}` : ""} --no-persona`;
}
