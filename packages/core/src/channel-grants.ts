import { issuedPermitsPattern, issuedPermitsSubject, readIssuedSubjectPermissions, type IssuedSubjectPermissions } from "./issued-authority.js";
import { channelRoute, legacyPluginChannelFilters, PLUGIN_CHANNEL_ROOT, pluginChannelStream } from "./plugin-channel-route.js";
import { chatHistDurable, chatStream, chatWildcard, parseSubject, spacePrefix, type ParsedSubject } from "./subjects.js";

export interface ChannelGrantFilter {
  readonly kind: "chat" | typeof PLUGIN_CHANNEL_ROOT;
  readonly channel: string;
  readonly subject: string;
  /** Reserved physical subjects to omit. Live taps on the same JWT have broker enforcement.
   * A history consumer cannot express this complement: callers must omit these messages. */
  readonly exclude: readonly string[];
}

export interface ChannelGrantHistory extends ChannelGrantFilter {
  readonly stream: string;
  readonly consumer: string;
  readonly lifecycleUid: string;
}

export interface ChannelGrantScope {
  readonly space: string;
  /** The caller must supply trusted routing state, never infer it from a grant or channel name. */
  readonly mode: "legacy" | "isolated";
  /** Required for post and history. Omit lifecycleUid only when decoding a static credential's reader name. */
  readonly principal?: { readonly owner: string; readonly actor: string; readonly lifecycleUid?: string };
}

export interface ChannelGrantProjection {
  readonly read: readonly ChannelGrantFilter[];
  readonly post: readonly ChannelGrantFilter[];
  readonly history: readonly ChannelGrantHistory[];
}

function routedRow(scope: ChannelGrantScope, subject: string): (ChannelGrantFilter & { sender: ParsedSubject; stream: string }) | undefined {
  if (!subject.startsWith(`${spacePrefix(scope.space)}.`)) return;
  const sender = parseSubject(subject);
  if (!sender || (sender.kind !== "chat" && sender.kind !== PLUGIN_CHANNEL_ROOT)) return;
  try {
    const route = channelRoute(scope.space, sender.owner, sender.actor, sender.rest, scope.mode);
    if (route.subject !== subject || route.rail.kind !== sender.kind) return;
    return { kind: sender.kind, channel: sender.rest, subject, exclude: [], sender, stream: route.stream };
  } catch {
    return;
  }
}

const explicit = (direction: IssuedSubjectPermissions["publish"]): readonly string[] =>
  direction.allow.mode === "patterns" ? direction.allow.patterns : [];

/** Decode canonical explicit grants from verified issuance evidence or imported native permissions.
 *  This does not authenticate the credential, determine routing mode, or authorize a join.
 *  Unrestricted, generic wildcard, and unfiltered history rows do not synthesize plugin grants. */
export function projectChannelGrants(value: IssuedSubjectPermissions, scope: ChannelGrantScope): ChannelGrantProjection {
  const permissions = readIssuedSubjectPermissions(value);
  const read: ChannelGrantFilter[] = [], post: ChannelGrantFilter[] = [], history: ChannelGrantHistory[] = [];
  const { space } = scope;
  if (scope.mode !== "legacy" && scope.mode !== "isolated") throw new Error("channel grant projection requires a validated routing mode");
  const principal = scope.principal?.owner === "*" || scope.principal?.actor === "*" ? undefined : scope.principal;
  const reserved = scope.mode === "isolated" ? legacyPluginChannelFilters(space) : [];
  const chatFence = (rows: readonly string[]) => reserved.every((row) => rows.includes(row));
  for (const subject of new Set(explicit(permissions.subscribe))) {
    const row = routedRow(scope, subject);
    const chatTap = subject === chatWildcard(space);
    if (!chatTap && (!row || row.sender.owner !== "*" || row.sender.actor !== "*")) continue;
    const chat = row?.kind !== PLUGIN_CHANNEL_ROOT;
    if (chat && !chatFence(permissions.subscribe.deny)) continue;
    const exclude = chat ? reserved : [];
    if (issuedPermitsPattern(permissions.subscribe, subject, exclude))
      read.push({ kind: row?.kind ?? "chat", channel: row?.channel ?? ">", subject, exclude });
  }
  for (const subject of new Set(explicit(permissions.publish))) {
    const row = routedRow(scope, subject);
    if (!row || !principal || row.sender.owner !== principal.owner || row.sender.actor !== principal.actor) continue;
    if (row.kind === "chat" && !chatFence(permissions.publish.deny)) continue;
    const exclude = row.kind === "chat" ? reserved : [];
    if (issuedPermitsPattern(permissions.publish, subject, exclude))
      post.push({ kind: row.kind, channel: row.channel, subject, exclude });
  }
  if (principal) {
    const streams = [chatStream(space), ...(scope.mode === "isolated" ? [pluginChannelStream(space)] : [])];
    for (const row of new Set(explicit(permissions.publish))) {
      for (const stream of streams) {
        const prefix = `$JS.API.CONSUMER.CREATE.${stream}.`;
        if (!row.startsWith(prefix)) continue;
        const dot = row.indexOf(".", prefix.length);
        if (dot === -1) continue;
        const consumer = row.slice(prefix.length, dot), subject = row.slice(dot + 1);
        const lifecycleUid = consumer.slice(consumer.lastIndexOf("-") + 1);
        if (principal.lifecycleUid !== undefined && lifecycleUid !== principal.lifecycleUid) continue;
        try { if (consumer !== chatHistDurable(principal.owner, principal.actor, lifecycleUid)) continue; } catch { continue; }
        const filter = routedRow(scope, subject);
        if (!filter || filter.stream !== stream || filter.sender.owner !== "*" || filter.sender.actor !== "*") continue;
        const exclude = filter.kind === "chat" ? reserved : [];
        if (!exclude.every((s) => permissions.publish.deny.includes(`${prefix}*.${s}`))) continue;
        const readerOps = ["INFO", "MSG.NEXT", "DELETE"].map(verb => `$JS.API.CONSUMER.${verb}.${stream}.${consumer}`);
        if (issuedPermitsPattern(permissions.publish, row, exclude.map((s) => `${prefix}*.${s}`))
          && readerOps.every(op => issuedPermitsSubject(permissions.publish, op)))
          history.push({ kind: filter.kind, channel: filter.channel, subject, exclude, stream, consumer, lifecycleUid });
      }
    }
  }
  return { read, post, history };
}
