import type { PresenceStatus } from "@cotal-ai/core";
import { c } from "@cotal-ai/workspace";

// The ANSI helpers moved into `@cotal-ai/workspace` (stage 4), shared with @cotal-ai/web.
// Re-exported so the CLI's many importers keep resolving them from here.
export { c, color256 } from "@cotal-ai/workspace";

export function statusBadge(status: PresenceStatus): string {
  switch (status) {
    case "working":
      return c.green("● working");
    case "waiting":
      return c.yellow("◐ waiting");
    case "idle":
      return c.gray("○ idle");
    case "offline":
      return c.dim("⨯ offline");
  }
}

/** A follow-up hint for failures whose signature is stale on-disk broker state: streams/durable
 *  consumers minted by an older, incompatible Cotal generation survive every down/up cycle, and
 *  JetStream rejects a same-name re-create with a different config. Rendered dim under the red
 *  line by the error surfaces - the error itself stays the broker's own sentence. */
export function staleStoreHint(msg: string): string | undefined {
  return /consumer already exists|stream already exists/i.test(msg)
    ? "likely stale on-disk mesh state from an older Cotal version - reset: cotal down && cotal clean store --force && cotal up"
    : undefined;
}
