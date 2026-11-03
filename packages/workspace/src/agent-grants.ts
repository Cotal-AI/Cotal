import { spacePrefix, taskStream } from "@cotal-ai/core";
import { shellPath } from "./protected-records.js";

/** The channel ACLs and role an agent credential carries. */
export interface AgentGrants { read: string[]; post: string[]; role: string | null }

/** An agent credential's grants, read back from the rows the agent profile mints: the
 *  `chat.*.*.<channel>` subscribe rows are its read ACL, its own `chat.<owner>.<actor>.<channel>`
 *  publish rows its post ACL, and the `svc_<role>` TASK bind row its role. */
export function agentGrants(nats: { pub?: { allow?: string[] }; sub?: { allow?: string[] } }, space: string): AgentGrants {
  const chat = `${spacePrefix(space)}.chat.`;
  const channels = (rows: readonly string[], own: boolean) => [...new Set(rows.filter((row) => row.startsWith(chat))
    .map((row) => row.slice(chat.length).split("."))
    .filter(([owner, actor]) => own ? owner !== "*" && actor !== "*" : owner === "*" && actor === "*")
    .map((parts) => parts.slice(2).join(".")).filter(Boolean))];
  const task = `$JS.API.CONSUMER.INFO.${taskStream(space)}.svc_`;
  const role = (nats.pub?.allow ?? []).find((row) => row.startsWith(task))?.slice(task.length);
  return { read: channels(nats.sub?.allow ?? [], false), post: channels(nats.pub?.allow ?? [], true), role: role || null };
}

/** The `auth mint` flags that give a new key these grants, each led by a space. A new key holds only
 *  the grants its mint names, so both ACL flags are named even when empty. */
export function grantMintFlags(grants: AgentGrants): string {
  return ` --allow-subscribe ${shellPath(grants.read.join(","))} --allow-publish ${shellPath(grants.post.join(","))}${grants.role ? ` --role ${grants.role}` : ""}`;
}
