import type { CSSProperties } from "react";
import { body } from "../art/index.ts";
import type { Status } from "../lib/roster.js";
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

/** An agent's character, drawn from the brand's art through the art seam, with its status dot in
 *  the corner unless `dot` is false (the message rows draw none). Offline is greyscale at half
 *  opacity (`ui-av-off`). `vendor` is the connector the roster card reports. */
export function Avatar({ vendor, status, size, dot = true }: { vendor?: string; status: Status; size: number; dot?: boolean }) {
  const key = vendor !== undefined && Object.hasOwn(CHARACTER, vendor) ? CHARACTER[vendor] : GUEST;
  const mood = Object.hasOwn(MOOD, status) ? MOOD[status] : {};
  return (
    <span className={status === "offline" ? "ui-av ui-av-off" : "ui-av"} style={{ "--s": `${size}px` } as CSSProperties}>
      <svg viewBox="-2 -4 112 112" aria-hidden="true" dangerouslySetInnerHTML={{ __html: body(key, mood) }} />
      {dot && <StatusDot status={status} />}
    </span>
  );
}
