import type { PresenceStatus } from "@cotal-ai/core";
import { c } from "@cotal-ai/workspace";

// The ANSI helpers moved into `@cotal-ai/workspace` (stage 4), shared with cotal-web and
// @cotal-ai/demo. Re-exported so the CLI's many importers keep resolving them from here.
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
