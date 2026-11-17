import type { CSSProperties } from "react";
import { body } from "../art/index.ts";
import type { Badge } from "../lib/identity.js";
import type { Status } from "../lib/roster.js";
import { IdentityBadge } from "./IdentityBadge.tsx";
import { StatusDot } from "./Status.tsx";

/** The character each connector draws as. A connector not listed here, or none, draws the guest. */
const CHARACTER: Record<string, string> = {
  "claude-code": "claude",
  claude: "claude",
  opencode: "opencode",
  codex: "codex",
  hermes: "hermes",
  pi: "pi",
};

/** The guest: a key the art file does not know, which it draws as its teal circle. */
const GUEST = "guest";

/** How each status shows on the face, the mock helper's `MOOD` table: working looks down at its
 *  work, waiting is surprised and looks up. Idle and offline keep the neutral face. */
const MOOD: Record<string, { look?: string; mood?: string }> = {
  working: { look: "down" },
  waiting: { mood: "surprised", look: "up" },
};

/** An agent's character as the markup of its 112-unit box, for the caller's own `<svg viewBox="-2 -4 112
 *  112">`: the connector's character, with the face its status gives it. The topology graph draws
 *  the same character at its own size. `vendor` is the connector the roster card reports. */
export function characterMarkup(vendor: string | undefined, status: Status): string {
  const key = vendor !== undefined && Object.hasOwn(CHARACTER, vendor) ? CHARACTER[vendor] : GUEST;
  const mood = Object.hasOwn(MOOD, status) ? MOOD[status] : {};
  return body(key, mood);
}

/** An agent's character, drawn from the brand's art through the art seam, with its status dot in
 *  the corner unless `dot` is false (the message rows draw none). Offline is greyscale at half
 *  opacity (`ui-av-off`). `badge`, given only for a roster row, adds the initial badge bottom left,
 *  between the character and the dot. */
export function Avatar({ vendor, status, size, badge, dot = true }: { vendor?: string; status: Status; size: number; dot?: boolean; badge?: Badge }) {
  return (
    <span className={status === "offline" ? "ui-av ui-av-off" : "ui-av"} style={{ "--s": `${size}px` } as CSSProperties}>
      <svg viewBox="-2 -4 112 112" aria-hidden="true" dangerouslySetInnerHTML={{ __html: characterMarkup(vendor, status) }} />
      {badge && <IdentityBadge letter={badge.letter} slot={badge.slot} size={size} offline={status === "offline"} />}
      {dot && <StatusDot status={status} />}
    </span>
  );
}
