import { chatSubjectPrefix, importNativeSubjectPermissions, projectChannelGrants, taskStream, type ChannelGrantScope } from "@cotal-ai/core";
import { shellPath } from "./protected-records.js";

/** The channel ACLs and role an agent credential carries. */
export interface AgentGrants { read: string[]; post: string[]; role: string | null }

/** An agent credential's grants, read back from the rows the agent profile mints: the
 *  `chat.*.*.<channel>` subscribe rows are its read ACL, its own `chat.<owner>.<actor>.<channel>`
 *  publish rows its post ACL, and the `svc_<role>` TASK bind row its role. */
export function agentGrants(
  nats: { pub?: { allow?: string[]; deny?: string[] }; sub?: { allow?: string[]; deny?: string[] } },
  space: string,
  scope?: Pick<ChannelGrantScope, "mode" | "principal">,
): AgentGrants {
  const chat = chatSubjectPrefix(space);
  const allowed = (rows: unknown): string[] => Array.isArray(rows) ? rows.filter((row): row is string => typeof row === "string") : [];
  const channels = (rows: readonly string[], own: boolean) => [...new Set(rows.filter((row) => row.startsWith(chat))
    .map((row) => row.slice(chat.length).split("."))
    .filter(([owner, actor]) => own ? owner !== "*" && actor !== "*" : owner === "*" && actor === "*")
    .map((parts) => parts.slice(2).join(".")).filter(Boolean))];
  const task = `$JS.API.CONSUMER.INFO.${taskStream(space)}.svc_`;
  const post = allowed(nats.pub?.allow);
  const role = post.find((row) => row.startsWith(task))?.slice(task.length);
  const roleName = role && /^[A-Za-z0-9_-]+$/.test(role) ? role : null;
  if (scope?.mode === "isolated") {
    const permissions = importNativeSubjectPermissions({ ...(nats.pub ? { pub: nats.pub } : {}), ...(nats.sub ? { sub: nats.sub } : {}) });
    const grants = projectChannelGrants(permissions, { space, ...scope });
    return { read: grants.read.map(({ channel }) => channel), post: grants.post.map(({ channel }) => channel), role: roleName };
  }
  return { read: channels(allowed(nats.sub?.allow), false), post: channels(post, true), role: roleName };
}

/** The `auth mint` flags that give a new key these grants, each led by a space. A new key holds only
 *  the grants its mint names, so both ACL flags are named even when empty and persona defaults
 *  are disabled, including a role the original credential did not hold. */
export function grantMintFlags(grants: AgentGrants): string {
  const read = grants.read.join(",");
  return ` --allow-subscribe${read.startsWith("-") ? "=" : " "}${shellPath(read)} --allow-publish ${shellPath(grants.post.join(","))}${grants.role ? ` --role ${grants.role}` : ""} --no-persona`;
}
